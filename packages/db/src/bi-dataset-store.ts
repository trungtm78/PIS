import { randomUUID } from 'node:crypto';
import { CONTRACT_ADAPTER, DISBURSEMENT_ADAPTER, DomainError, datasetAdapterOf, isSameBuild, qualityOfVersion, versionChecksum } from '@machvon/kernel';
import type { DatasetSourceKind, DatasetVersionStatus, QualityBadge, QualityRunFacts, VersionContent } from '@machvon/kernel';
import { BiLineageStore } from './bi-lineage-store.ts';
import { hasQuerySource } from './bi-query-source.ts';
import type { TenantTx } from './tenant-database.ts';
import { vietnameseData } from './vietnamese-data.ts';

/** The dataset of the disbursement figures, built from the frozen close snapshots of DIS (BI 3 F2). */
export const DISBURSEMENT_DATASET_CODE = DISBURSEMENT_ADAPTER.code;
/** The dataset of the contract portfolio, built from the frozen snapshots of the contract fact (CA-1, part 2 makes the source). */
export const CONTRACT_DATASET_CODE = CONTRACT_ADAPTER.code;
/** The dimensions its metrics may be cut by, and the joins that were approved for it: nothing else is reachable through it. */
export const DISBURSEMENT_JOIN_PATHS = {
  dimensions: ['project', 'unit', 'fund_source', 'budget_level', 'bucket'],
  joins: [
    { from: 'period_snapshot_line.project_id', to: 'project.id' },
    { from: 'period_snapshot_line.unit_id', to: 'organization_unit.id' },
    { from: 'period_snapshot_line.fund_source_version_id', to: 'master_record_version.id' },
  ],
} as const;
const DATASET_TITLES = vietnameseData<{ 'disbursement.title': string; 'contract.title': string }>('bi-dataset');
const DISBURSEMENT_TITLE = DATASET_TITLES['disbursement.title'];
/** The joins approved for the contract dataset: its lines are read from the contract fact and go to the project and the unit for the scope of the reader, nothing else is reachable through it. */
export const CONTRACT_JOIN_PATHS = {
  dimensions: ['project', 'unit', 'fund_source', 'investor', 'contractor', 'contract_status', 'contract_type'],
  joins: [
    { from: 'contract_fact.project_id', to: 'project.id' },
    { from: 'contract_fact.unit_id', to: 'organization_unit.id' },
    { from: 'contract_fact.contractor_id', to: 'contractor.id' },
  ],
} as const;

/** What a dataset of the registry is when the catalogue of the tenant is made: its title, the grain of its lines, the joins approved for it and the kind of source it is read from. */
interface DatasetDefinition {
  title: string;
  sourceKind: DatasetSourceKind;
  grain: string;
  joinPaths: Record<string, unknown>;
  /** The module whose dataset in the catalogue of DGV the dataset is linked to (its data contract and its quality runs). */
  producerModule: string;
}
const DEFINITIONS: Readonly<Record<string, DatasetDefinition>> = {
  [DISBURSEMENT_DATASET_CODE]: { title: DISBURSEMENT_TITLE, sourceKind: 'PERIOD_SNAPSHOT', grain: 'project', joinPaths: DISBURSEMENT_JOIN_PATHS, producerModule: 'DIS' },
  [CONTRACT_DATASET_CODE]: { title: DATASET_TITLES['contract.title'], sourceKind: 'CONTRACT_FACT', grain: 'contract_party', joinPaths: CONTRACT_JOIN_PATHS, producerModule: 'CTR' },
};
/** A build that stays BUILDING this long is taken for dead: the next build marks it FAILED and goes on. */
const STALE_BUILD_MINUTES = 60;

export interface BiDatasetRow {
  id: string;
  datasetCode: string;
  title: string;
  sourceKind: string;
  grain: string;
  joinPaths: Record<string, unknown>;
  dgvDatasetId: string | null;
  classification: string;
  refreshPolicy: string;
  status: string;
  version: number;
  /** The version that serves now (the frozen one of the newest period), if any. */
  latest: { asOfPeriod: string; qualityBadge: QualityBadge; builtAt: string } | null;
}

export interface DatasetVersionRow {
  id: string;
  datasetId: string;
  asOfPeriod: string;
  reportingPeriodId: string | null;
  sourceSnapshotId: string | null;
  builtAt: string;
  rowCount: number;
  checksumSha256: string;
  qualityRunId: string | null;
  qualityBadge: QualityBadge;
  excludedQuarantineRows: number;
  status: DatasetVersionStatus;
  supersedesId: string | null;
  createdAt: string;
  /** The creation time with the microseconds the table keeps: the key a page is continued from (a Date has milliseconds only). */
  createdAtKey: string;
  version: number;
}

export interface DatasetVersionFilter {
  asOfPeriod?: string | undefined;
  status?: string | undefined;
}

export interface BuildInput {
  datasetId: string;
  /** The period (the code of the reporting period); read from the snapshot when only the snapshot is named. */
  asOfPeriod?: string | undefined;
  sourceSnapshotId?: string | undefined;
  actor: string;
}

export interface BuildResult {
  version: DatasetVersionRow;
  /** BUILT: a version was made; UNCHANGED: the version that stands is the same content. */
  outcome: 'BUILT' | 'UNCHANGED';
  supersededId: string | null;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  dataset_code: string;
  title: string;
  source_kind: string;
  grain: string;
  join_paths: Record<string, unknown>;
  dgv_dataset_id: string | null;
  classification: string;
  refresh_policy: string;
  status: string;
  latest_built_at: string | number | Date;
  dataset_id: string;
  as_of_period: string;
  reporting_period_id: string | null;
  source_snapshot_id: string | null;
  built_at: string | number | Date;
  quality_run_id: string | null;
  quality_badge: "FAILED" | "NOT_ASSESSED" | "PASSED" | "WARNING" | "STALE";
  supersedes_id: string | null;
  created_at: string | number | Date;
  created_at_key: string;
  latest_badge: "FAILED" | "NOT_ASSESSED" | "PASSED" | "WARNING" | "STALE";
  latest_period: string;
  checksum_sha256: string;
}

const DATASET_SELECT = `select d.id, d.dataset_code, d.title, d.source_kind, d.grain, d.join_paths, d.dgv_dataset_id, d.classification, d.refresh_policy, d.status, d.version::text as version,
  l.as_of_period as latest_period, l.quality_badge as latest_badge, l.built_at as latest_built_at
  from machvon.bi_dataset d
  left join lateral (select v.as_of_period, v.quality_badge, v.built_at from machvon.bi_dataset_version v where v.tenant_id = d.tenant_id and v.dataset_id = d.id and v.status = 'FROZEN' order by v.as_of_period desc limit 1) l on true`;

const toDataset = (row: Sql): BiDatasetRow => ({
  id: row.id,
  datasetCode: row.dataset_code,
  title: row.title,
  sourceKind: row.source_kind,
  grain: row.grain,
  joinPaths: row.join_paths,
  dgvDatasetId: row.dgv_dataset_id,
  classification: row.classification,
  refreshPolicy: row.refresh_policy,
  status: row.status,
  version: Number(row.version),
  latest: row.latest_period === null ? null : { asOfPeriod: row.latest_period, qualityBadge: row.latest_badge, builtAt: new Date(row.latest_built_at).toISOString() },
});

const VERSION_SELECT = `select v.id, v.dataset_id, v.as_of_period, v.reporting_period_id, v.source_snapshot_id, v.built_at, v.row_count::text as row_count, v.checksum_sha256, v.quality_run_id,
  v.quality_badge, v.excluded_quarantine_rows::text as excluded_quarantine_rows, v.status, v.supersedes_id, v.created_at,
  to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_key, v.version::text as version
  from machvon.bi_dataset_version v`;

const toVersion = (row: Sql): DatasetVersionRow => ({
  id: row.id,
  datasetId: row.dataset_id,
  asOfPeriod: row.as_of_period,
  reportingPeriodId: row.reporting_period_id,
  sourceSnapshotId: row.source_snapshot_id,
  builtAt: new Date(row.built_at).toISOString(),
  rowCount: Number(row.row_count),
  checksumSha256: row.checksum_sha256.trim(),
  qualityRunId: row.quality_run_id,
  qualityBadge: row.quality_badge,
  excludedQuarantineRows: Number(row.excluded_quarantine_rows),
  status: row.status as "FAILED" | "SUPERSEDED" | "BUILDING" | "FROZEN",
  supersedesId: row.supersedes_id,
  createdAt: new Date(row.created_at).toISOString(),
  createdAtKey: row.created_at_key,
  version: Number(row.version),
});

/**
 * The datasets of BI and their versions by period (ST-BI-002, BI 3 F2). A version is made from one frozen close snapshot of DIS and the quality run DGV made of it: with no run it is `NOT_ASSESSED`; when a
 * run completes the version is made again with the run linked and the rows its rules quarantined counted, and the one before is superseded but stays, because a drill that was opened on it is served from it.
 * Per dataset and period one version is frozen.
 */
export class BiDatasetStore {
  async find(tx: TenantTx, id: string): Promise<BiDatasetRow | undefined> {
    const rows = await tx.query<Sql>(`${DATASET_SELECT} where d.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toDataset(rows[0]);
  }

  /** The datasets of the tenant by code. */
  async list(tx: TenantTx, page: { limit: number; after?: { code: string } | undefined }): Promise<BiDatasetRow[]> {
    const rows = await tx.query<Sql>(`${DATASET_SELECT} where ($1::text is null or d.dataset_code > $1) order by d.dataset_code limit $2`, [page.after?.code ?? null, page.limit]);
    return rows.map(toDataset);
  }

  /** The versions of a dataset, the newest period first. */
  async versions(tx: TenantTx, datasetId: string, filter: DatasetVersionFilter, page: { limit: number; after?: { builtAt: string; id: string } | undefined }): Promise<DatasetVersionRow[]> {
    const rows = await tx.query<Sql>(
      `${VERSION_SELECT}
        where v.dataset_id = $1::uuid and ($2::text is null or v.as_of_period = $2) and ($3::text is null or v.status = $3)
          and ($4::timestamptz is null or (v.created_at, v.id) < ($4::timestamptz, $5::uuid))
        order by v.created_at desc, v.id desc limit $6`,
      [datasetId, filter.asOfPeriod ?? null, filter.status ?? null, page.after?.builtAt ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toVersion);
  }

  /** The dataset of the disbursement figures of the tenant: created the first time a snapshot freezes, then found. */
  async ensureDisbursementDataset(tx: TenantTx, actor: string): Promise<string> {
    return this.ensureDataset(tx, DISBURSEMENT_DATASET_CODE, actor);
  }

  /**
   * A dataset of the registry in the catalogue of the tenant: created the first time it is needed, then found. A dataset whose source is not registered in this build (the contract fact, until part 2 of CA-1) is
   * refused as `DATASET_SOURCE_UNAVAILABLE`, and a code that is not in the registry is 422 on the dataset.
   */
  async ensureDataset(tx: TenantTx, datasetCode: string, actor: string): Promise<string> {
    const definition = datasetAdapterOf(datasetCode) === undefined ? undefined : DEFINITIONS[datasetCode];
    if (definition === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset');
    if (!hasQuerySource(definition.sourceKind)) throw new DomainError('DATASET_SOURCE_UNAVAILABLE', 422, 'dataset', { extensions: { dataset_code: datasetCode, source_kind: definition.sourceKind } });
    const found = await tx.query<{ id: string }>('select id from machvon.bi_dataset where dataset_code = $1', [datasetCode]);
    if (found[0] !== undefined) return found[0].id;
    const id = randomUUID();
    await this.lockCatalogueDataset(tx, definition.producerModule);
    await tx.query(
      `insert into machvon.bi_dataset (tenant_id, id, dataset_code, title, source_kind, grain, join_paths, dgv_dataset_id, owner_user_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $6, $7, $4::jsonb,
               (select d.id from machvon.dataset d where d.producer_module = $8 and d.status <> 'RETIRED' order by d.created_at limit 1), $5::uuid, $5::uuid, $5::uuid)
       on conflict (tenant_id, dataset_code) do nothing`,
      [id, datasetCode, definition.title, JSON.stringify(definition.joinPaths), actor, definition.sourceKind, definition.grain, definition.producerModule],
    );
    const stored = await tx.query<{ id: string }>('select id from machvon.bi_dataset where dataset_code = $1', [datasetCode]);
    return (stored[0] as { id: string }).id;
  }

  /** The datasets built from period snapshots, which a freezing of one feeds. */
  async snapshotDatasets(tx: TenantTx): Promise<string[]> {
    return (await tx.query<{ id: string }>("select id from machvon.bi_dataset where source_kind = 'PERIOD_SNAPSHOT' and status = 'ACTIVE' order by dataset_code")).map((row) => row.id);
  }

  /** The dataset of the contract portfolio of the tenant: made the first time the contract fact is frozen, then found. */
  async ensureContractDataset(tx: TenantTx, actor: string): Promise<string> {
    return this.ensureDataset(tx, CONTRACT_DATASET_CODE, actor);
  }

  /**
   * Builds the version of a period. The snapshot must be a frozen close snapshot (named, or the latest of the period); a build already in progress for the dataset and period is BUILD_ALREADY_RUNNING.
   * The version is made from the snapshot and the latest completed quality run of it: when that is the content of the version that stands nothing is made, otherwise the one that stands is superseded.
   */
  async build(tx: TenantTx, input: BuildInput): Promise<BuildResult> {
    const dataset = await this.find(tx, input.datasetId);
    if (dataset === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (dataset.status !== 'ACTIVE' || (dataset.sourceKind !== 'PERIOD_SNAPSHOT' && dataset.sourceKind !== 'CONTRACT_FACT')) throw new DomainError('VALIDATION_FAILED', 422, 'dataset');
    const producerModule = DEFINITIONS[dataset.datasetCode]?.producerModule ?? 'DIS';
    const fromContractFact = dataset.sourceKind === 'CONTRACT_FACT';
    const dis = await this.snapshotOf(tx, input);
    // The dataset of the contracts is read from the contract fact frozen with the close snapshot of DIS: its rows and its hash are the ones of the version.
    const fact = fromContractFact ? await this.contractFactOf(tx, dis.id) : undefined;
    const snapshot = fact === undefined ? dis : { ...dis, payloadSha256: fact.payloadSha256, rowCount: fact.rowCount };
    const locked = await tx.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtextextended('bi_dataset:' || current_setting('app.tenant_id', true) || ':' || $1 || ':' || $2, 0)) as locked",
      [dataset.id, snapshot.periodCode],
    );
    if (locked[0]?.locked !== true) throw new DomainError('BUILD_ALREADY_RUNNING', 409);
    // The snapshot was read before the lock: a replacement may have been frozen since, and its own build may already have made its version. It is read again and held (a freezing of its replacement waits for this
    // transaction), so a version of a snapshot that has been replaced never takes the place of the version of the one that replaced it.
    await this.hold(tx, dis.id);
    await tx.query(
      `update machvon.bi_dataset_version set status = 'FAILED', updated_at = now(), version = version + 1
        where dataset_id = $1::uuid and as_of_period = $2 and status = 'BUILDING' and created_at < now() - make_interval(mins => $3::int)`,
      [dataset.id, snapshot.periodCode, STALE_BUILD_MINUTES],
    );
    const running = await tx.query<{ id: string }>("select id from machvon.bi_dataset_version where dataset_id = $1::uuid and as_of_period = $2 and status = 'BUILDING'", [
      dataset.id,
      snapshot.periodCode,
    ]);
    if (running[0] !== undefined) throw new DomainError('BUILD_ALREADY_RUNNING', 409);
    // The dataset may have been made before DIS had a dataset in the catalogue of DGV: the link is made as soon as there is one.
    const linked = dataset.dgvDatasetId ?? (await this.linkCatalogue(tx, dataset.id, producerModule));
    // The quality runs of DGV are over the snapshots of DIS: the contract fact has none yet, so its versions are NOT_ASSESSED until a rule set of the producer CTR runs over it.
    const quality = qualityOfVersion(fromContractFact ? undefined : await this.qualityRun(tx, { ...dataset, dgvDatasetId: linked }, snapshot.id, producerModule), snapshot.payloadSha256);
    const content: VersionContent = {
      datasetCode: dataset.datasetCode,
      asOfPeriod: snapshot.periodCode,
      sourceSnapshotId: snapshot.id,
      snapshotSha256: snapshot.payloadSha256,
      rowCount: snapshot.rowCount,
      qualityRunId: quality.runId,
      excludedQuarantineRows: quality.excludedQuarantineRows,
    };
    const standing = await tx.query<Sql>(`${VERSION_SELECT} where v.dataset_id = $1::uuid and v.as_of_period = $2 and v.status = 'FROZEN'`, [dataset.id, snapshot.periodCode]);
    const current = standing[0] === undefined ? undefined : toVersion(standing[0]);
    if (current !== undefined && isSameBuild(current, content)) {
      // A version built before the lineage of data was kept has no source in it: asking for the same build again tells it (what is there already is not written again).
      await this.lineageOf(tx, dataset.datasetCode, current.id, snapshot, fact?.id);
      return { version: current, outcome: 'UNCHANGED', supersededId: null };
    }
    if (current !== undefined) {
      await tx.query("update machvon.bi_dataset_version set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [current.id, input.actor]);
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.bi_dataset_version
         (tenant_id, id, dataset_id, as_of_period, reporting_period_id, source_snapshot_id, built_at, row_count, checksum_sha256, quality_run_id, quality_badge, excluded_quarantine_rows, status, supersedes_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, now(), $6::bigint, $7, $8::uuid, $9, $10::bigint, 'FROZEN', $11::uuid, $12::uuid, $12::uuid)`,
      [
        id,
        dataset.id,
        snapshot.periodCode,
        snapshot.periodId,
        snapshot.id,
        snapshot.rowCount,
        versionChecksum(content),
        quality.runId,
        quality.badge,
        quality.excludedQuarantineRows,
        current?.id ?? null,
        input.actor,
      ],
    );
    const made = await tx.query<Sql>(`${VERSION_SELECT} where v.id = $1::uuid`, [id]);
    // The lineage of data is told what the version was made from: the snapshot of DIS and the projects it holds.
    await this.lineageOf(tx, dataset.datasetCode, id, snapshot, fact?.id);
    return { version: toVersion(made[0] as Sql), outcome: 'BUILT', supersededId: current?.id ?? null };
  }

  /** The lineage of a version: from the snapshot of DIS and its projects, or, for the contract dataset, from the frozen contract fact. */
  private async lineageOf(tx: TenantTx, datasetCode: string, versionId: string, snapshot: { id: string; periodCode: string }, factId: string | undefined): Promise<void> {
    const lineage = new BiLineageStore();
    if (factId === undefined) await lineage.datasetBuilt(tx, { versionId, datasetCode, asOfPeriod: snapshot.periodCode, sourceSnapshotId: snapshot.id, observedAt: new Date() });
    else await lineage.contractFactBuilt(tx, { versionId, datasetCode, asOfPeriod: snapshot.periodCode, factSnapshotId: factId, observedAt: new Date() });
  }

  /** The contract fact frozen with a snapshot of DIS; SOURCE_SNAPSHOT_NOT_FROZEN when there is none (it is made before the version is built). */
  private async contractFactOf(tx: TenantTx, periodSnapshotId: string): Promise<{ id: string; payloadSha256: string; rowCount: number }> {
    const rows = await tx.query<{ id: string; payload_sha256: string; row_count: number }>('select id, payload_sha256, row_count from machvon.contract_fact_snapshot where period_snapshot_id = $1::uuid', [periodSnapshotId]);
    const found = rows[0];
    if (found === undefined) throw new DomainError('SOURCE_SNAPSHOT_NOT_FROZEN', 422, 'source_snapshot_id');
    return { id: found.id, payloadSha256: found.payload_sha256.trim(), rowCount: Number(found.row_count) };
  }

  /**
   * The dataset DGV keeps for the producer DIS is held in share mode until this transaction ends: a breaking revision of its contract locks it for update before it reads its consumers, so a link made here either
   * waits for that publication or is committed in time to be seen by it.
   */
  private async lockCatalogueDataset(tx: TenantTx, producerModule: string): Promise<void> {
    await tx.query("select d.id from machvon.dataset d where d.producer_module = $1 and d.status <> 'RETIRED' order by d.created_at limit 1 for share", [producerModule]);
  }

  /** Links a dataset of BI to the dataset DGV keeps for the producer DIS, if DGV has one now; the link made earlier is never changed. */
  private async linkCatalogue(tx: TenantTx, datasetId: string, producerModule: string): Promise<string | null> {
    await this.lockCatalogueDataset(tx, producerModule);
    const rows = await tx.query<{ dgv_dataset_id: string | null }>(
      `update machvon.bi_dataset b set dgv_dataset_id = (select d.id from machvon.dataset d where d.producer_module = $2 and d.status <> 'RETIRED' order by d.created_at limit 1), updated_at = now(), version = version + 1
        where b.id = $1::uuid and b.dgv_dataset_id is null and exists (select 1 from machvon.dataset d where d.producer_module = $2 and d.status <> 'RETIRED')
        returning b.dgv_dataset_id`,
      [datasetId, producerModule],
    );
    return rows[0]?.dgv_dataset_id ?? null;
  }

  /** The snapshot is still a frozen close snapshot: SOURCE_SNAPSHOT_NOT_FROZEN if it is not any more, and a lock on its row that keeps it so until this transaction ends. */
  private async hold(tx: TenantTx, snapshotId: string): Promise<void> {
    const held = await tx.query<{ id: string }>("select id from machvon.period_snapshot where id = $1::uuid and status = 'FROZEN' and snapshot_kind = 'PERIOD_CLOSE' for share", [snapshotId]);
    if (held[0] === undefined) throw new DomainError('SOURCE_SNAPSHOT_NOT_FROZEN', 422, 'source_snapshot_id');
  }

  /** The frozen close snapshot a build reads: the one named, or the latest of the period; anything else is SOURCE_SNAPSHOT_NOT_FROZEN. */
  private async snapshotOf(tx: TenantTx, input: BuildInput): Promise<{ id: string; periodId: string; periodCode: string; payloadSha256: string; rowCount: number }> {
    if (input.sourceSnapshotId === undefined && input.asOfPeriod === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_period');
    const rows = await tx.query<{ id: string; status: string; snapshot_kind: string; payload_sha256: string | null; row_count: number; period_id: string; period_code: string }>(
      `select s.id, s.status, s.snapshot_kind, s.payload_sha256, s.row_count, s.period_id, p.code as period_code
         from machvon.period_snapshot s join machvon.reporting_period p on p.tenant_id = s.tenant_id and p.id = s.period_id
        where ($1::uuid is null or s.id = $1::uuid) and ($2::text is null or p.code = $2) and s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and s.payload_sha256 is not null
        order by s.frozen_at desc nulls last, s.id limit 1`,
      [input.sourceSnapshotId ?? null, input.asOfPeriod ?? null],
    );
    const found = rows[0];
    if (found === undefined) {
      // Named and not a frozen close snapshot (or not of the period asked, or not there) is the answer of the story.
      throw new DomainError('SOURCE_SNAPSHOT_NOT_FROZEN', 422, input.sourceSnapshotId === undefined ? 'as_of_period' : 'source_snapshot_id');
    }
    return { id: found.id, periodId: found.period_id, periodCode: found.period_code, payloadSha256: found.payload_sha256 as string, rowCount: Number(found.row_count) };
  }

  /** The latest completed quality run DGV made of this snapshot for the dataset; a dataset not yet linked to DGV takes the dataset DGV keeps for the producer of its snapshots. */
  private async qualityRun(tx: TenantTx, dataset: BiDatasetRow, snapshotId: string, producerModule: string): Promise<QualityRunFacts | undefined> {
    const rows = await tx.query<{ id: string; status: string; overall_result: string | null; certified_blocked: boolean; quarantined_count: string; snapshot_sha256: string | null }>(
      `select r.id, r.status, r.overall_result, r.certified_blocked, r.quarantined_count::text as quarantined_count, r.snapshot_sha256
         from machvon.quality_run r
        where r.snapshot_id = $1::uuid and r.status = 'COMPLETED'
          and r.dataset_id = coalesce($2::uuid, (select d.id from machvon.dataset d where d.producer_module = $3 and d.status <> 'RETIRED' order by d.created_at limit 1))
        order by r.finished_at desc, r.id limit 1`,
      [snapshotId, dataset.dgvDatasetId, producerModule],
    );
    const run = rows[0];
    return run === undefined
      ? undefined
      : {
          id: run.id,
          status: run.status,
          overallResult: run.overall_result,
          certifiedBlocked: run.certified_blocked,
          quarantinedCount: Number(run.quarantined_count),
          snapshotSha256: run.snapshot_sha256 === null ? null : run.snapshot_sha256.trim(),
        };
  }
}
