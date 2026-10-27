import { randomUUID } from 'node:crypto';
import { DomainError, TENANT_METRIC_PREFIX, metricSha256 } from '@machvon/kernel';
import type { MetricDefinition, MetricNode, MetricSyncPlan, RegisteredMetric } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type MetricOrigin = 'PLATFORM_CODE' | 'TENANT_UI';
export type MetricStatus = 'DRAFT' | 'IN_REVIEW' | 'CERTIFIED' | 'SUPERSEDED' | 'RETIRED';
export type SyncStatus = 'APPLIED' | 'REJECTED' | 'NO_CHANGE';

/** A revision of a metric as the catalogue lists it. */
export interface MetricRow {
  id: string;
  code: string;
  revision: number;
  grain: string;
  aggregationType: string;
  expressionAst: MetricNode;
  numeratorAst: MetricNode | null;
  denominatorAst: MetricNode | null;
  unit: string;
  ownerId: string;
  status: MetricStatus;
  origin: MetricOrigin;
  sourceCommit: string | null;
  definitionSha256: string | null;
  nullPolicy: string;
  dimensionCodes: string[];
  datasetId: string | null;
  glossaryTermId: string | null;
  effectiveFrom: string | null;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  supersedesId: string | null;
  certifiedBy: string | null;
  certifiedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  version: number;
}

export interface MetricFilter {
  origin?: string | undefined;
  status?: string | undefined;
  code?: string | undefined;
}

export interface MetricPage {
  limit: number;
  after?: { code: string; revision: number } | undefined;
}

export interface SyncRun {
  id: string;
  sourceCommit: string;
  bundleSha256: string;
  bundleObjectKey: string;
  addedCount: number;
  revisedCount: number;
  retiredCount: number;
  status: SyncStatus;
  errorJson: Record<string, unknown> | null;
  triggeredBy: string;
  createdAt: string;
}

export interface SyncRunInput {
  sourceCommit: string;
  bundleSha256: string;
  bundleObjectKey: string;
  triggeredBy: string;
}

export interface TenantMetricInput {
  definition: MetricDefinition;
  datasetId: string;
  glossaryTermId?: string | undefined;
  actor: string;
}

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const METRIC_ORIGINS: readonly string[] = ['PLATFORM_CODE', 'TENANT_UI'];
export const METRIC_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'CERTIFIED', 'SUPERSEDED', 'RETIRED'];

const SELECT = `select m.id, m.code, m.revision, m.grain, m.aggregation_type, m.expression_ast, m.numerator_ast, m.denominator_ast, m.unit, m.owner_id, m.status, m.origin,
  m.source_commit, m.definition_sha256, m.null_policy, m.dimension_codes, m.dataset_id, m.glossary_term_id, m.effective_from::text as effective_from,
  m.effective_until::text as effective_until, m.supersedes_id, m.certified_by, m.certified_at, m.created_at, m.created_by, m.version::text as version
  from machvon.metric_definition m`;

const toRow = (row: Sql): MetricRow => ({
  id: row.id,
  code: row.code,
  revision: row.revision,
  grain: row.grain,
  aggregationType: row.aggregation_type,
  expressionAst: row.expression_ast,
  numeratorAst: row.numerator_ast,
  denominatorAst: row.denominator_ast,
  unit: row.unit,
  ownerId: row.owner_id,
  status: row.status,
  origin: row.origin,
  sourceCommit: row.source_commit,
  definitionSha256: row.definition_sha256,
  nullPolicy: row.null_policy,
  dimensionCodes: row.dimension_codes,
  datasetId: row.dataset_id,
  glossaryTermId: row.glossary_term_id,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  supersedesId: row.supersedes_id,
  certifiedBy: row.certified_by,
  certifiedAt: row.certified_at === null ? null : new Date(row.certified_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
  createdBy: row.created_by,
  version: Number(row.version),
});

const toRun = (row: Sql): SyncRun => ({
  id: row.id,
  sourceCommit: row.source_commit,
  bundleSha256: row.bundle_sha256,
  bundleObjectKey: row.bundle_object_key,
  addedCount: row.added_count,
  revisedCount: row.revised_count,
  retiredCount: row.retired_count,
  status: row.status,
  errorJson: row.error_json,
  triggeredBy: row.triggered_by,
  createdAt: new Date(row.created_at).toISOString(),
});

const SYNC_RUN_COLUMNS = 'id, source_commit, bundle_sha256, bundle_object_key, added_count, revised_count, retired_count, status, error_json, triggered_by, created_at';

/** The dimensions a dataset offers: what its join paths declare under `dimensions` (a list of codes, or an object keyed by code); a dataset that declares none offers none. */
function datasetDimensions(joinPaths: unknown): string[] {
  const declared = (joinPaths as { dimensions?: unknown } | null)?.dimensions;
  if (Array.isArray(declared)) return declared.filter((item): item is string => typeof item === 'string');
  if (typeof declared === 'object' && declared !== null) return Object.keys(declared);
  return [];
}

const metricFieldsOf = (definition: MetricDefinition) => [
  definition.code,
  definition.grain,
  definition.aggregationType,
  JSON.stringify(definition.expressionAst),
  definition.numeratorAst === null ? null : JSON.stringify(definition.numeratorAst),
  definition.denominatorAst === null ? null : JSON.stringify(definition.denominatorAst),
  definition.unit,
  definition.nullPolicy,
  JSON.stringify(definition.dimensionCodes),
  definition.effectiveFrom,
];

/**
 * The registry of metrics (ST-BI-001, BI 3 F1): a revision of a metric is a row that is never edited in place except to close it (superseded, retired). The metrics of the platform come from the
 * files of the repository through a sync, and a tenant cannot change them; the metrics of a tenant are drafted here under a code that starts with `t_`.
 */
export class BiMetricStore {
  async find(tx: TenantTx, id: string): Promise<MetricRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where m.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The revisions of the tenant by code and revision, narrowed by where they come from, their status and their code. */
  async list(tx: TenantTx, filter: MetricFilter, page: MetricPage): Promise<MetricRow[]> {
    const rows = await tx.query<Sql>(
      `${SELECT}
        where ($1::text is null or m.origin = $1) and ($2::text is null or m.status = $2) and ($3::text is null or m.code = $3)
          and ($4::text is null or (m.code, m.revision) > ($4::text, $5::int))
        order by m.code, m.revision limit $6`,
      [filter.origin ?? null, filter.status ?? null, filter.code ?? null, page.after?.code ?? null, page.after?.revision ?? null, page.limit],
    );
    return rows.map(toRow);
  }

  /** The latest revision of every metric of the platform in the registry, in the shape the sync compares with. */
  async registeredPlatform(tx: TenantTx): Promise<RegisteredMetric[]> {
    const rows = await tx.query<Sql>(`${SELECT} where m.origin = 'PLATFORM_CODE' and m.revision = (select max(x.revision) from machvon.metric_definition x where x.tenant_id = m.tenant_id and x.code = m.code) order by m.code`);
    return rows.map(toRow).map((row) => ({
      id: row.id,
      code: row.code,
      revision: row.revision,
      status: row.status,
      definitionSha256: row.definitionSha256 ?? '',
      definition: {
        code: row.code,
        grain: row.grain,
        aggregationType: row.aggregationType as MetricDefinition['aggregationType'],
        expressionAst: row.expressionAst,
        numeratorAst: row.numeratorAst,
        denominatorAst: row.denominatorAst,
        unit: row.unit,
        nullPolicy: row.nullPolicy as MetricDefinition['nullPolicy'],
        dimensionCodes: row.dimensionCodes,
        glossaryTerm: null,
        effectiveFrom: row.effectiveFrom ?? '',
      },
    }));
  }

  /** Serializes the syncs of a tenant: two pipelines never plan against the same registry at once. */
  async lockSync(tx: TenantTx): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bi_metric_sync:' || current_setting('app.tenant_id', true), 0))");
  }

  /**
   * The run that took this bundle from this commit, if one did (it applied it, or found nothing to change): sending the same deploy twice changes nothing, whatever the first one did. A refused run does
   * not count: the same deploy may be sent again once what refused it is put right.
   */
  async processedRun(tx: TenantTx, sourceCommit: string, bundleSha256: string): Promise<SyncRun | undefined> {
    const rows = await tx.query<Sql>(`select ${SYNC_RUN_COLUMNS} from machvon.bi_metric_sync_run where source_commit = $1 and bundle_sha256 = $2 and status in ('APPLIED', 'NO_CHANGE') order by created_at limit 1`, [sourceCommit, bundleSha256]);
    return rows[0] === undefined ? undefined : toRun(rows[0]);
  }

  async recordRun(tx: TenantTx, input: SyncRunInput, outcome: { status: SyncStatus; added: number; revised: number; retired: number; error?: Record<string, unknown> }): Promise<SyncRun> {
    const rows = await tx.query<Sql>(
      `insert into machvon.bi_metric_sync_run (tenant_id, id, source_commit, bundle_sha256, bundle_object_key, added_count, revised_count, retired_count, status, error_json, triggered_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::uuid)
       returning ${SYNC_RUN_COLUMNS}`,
      [randomUUID(), input.sourceCommit, input.bundleSha256, input.bundleObjectKey, outcome.added, outcome.revised, outcome.retired, outcome.status, outcome.error === undefined ? null : JSON.stringify(outcome.error), input.triggeredBy],
    );
    return toRun(rows[0] as Sql);
  }

  /** The runs of the tenant, the newest first. */
  async runs(tx: TenantTx, limit: number): Promise<SyncRun[]> {
    const rows = await tx.query<Sql>(`select ${SYNC_RUN_COLUMNS} from machvon.bi_metric_sync_run order by created_at desc, id limit $1`, [limit]);
    return rows.map(toRun);
  }

  /**
   * Takes a plan into the registry: the metrics that are new are certified at revision 1, a changed one is the next revision (the one it replaces is superseded, and closed on the day the next
   * one takes effect), and one that left the bundle is retired. Platform metrics are certified by the review of the change in the repository: no person certifies them here.
   */
  async applyPlan(tx: TenantTx, plan: MetricSyncPlan, input: SyncRunInput): Promise<void> {
    for (const definition of plan.added) await this.insertPlatform(tx, definition, 1, null, input);
    for (const revised of plan.revised) {
      await this.insertPlatform(tx, revised.definition, revised.revision, revised.supersedes, input);
      await tx.query(
        `update machvon.metric_definition
            set status = 'SUPERSEDED', effective_until = case when $2::date > effective_from then $2::date else effective_until end, version = version + 1
          where id = $1::uuid and status <> 'RETIRED'`,
        [revised.supersedes, revised.definition.effectiveFrom],
      );
    }
    for (const code of plan.retired) {
      await tx.query(
        `update machvon.metric_definition
            set status = 'RETIRED', effective_until = greatest(current_date, effective_from + 1), version = version + 1
          where origin = 'PLATFORM_CODE' and code = $1 and status = 'CERTIFIED'`,
        [code],
      );
    }
  }

  private async insertPlatform(tx: TenantTx, definition: MetricDefinition, revision: number, supersedes: string | null, input: SyncRunInput): Promise<void> {
    await tx.query(
      `insert into machvon.metric_definition
         (tenant_id, id, code, grain, aggregation_type, expression_ast, numerator_ast, denominator_ast, unit, null_policy, dimension_codes, effective_from, revision, owner_id, status, origin,
          source_commit, definition_sha256, supersedes_id, certified_at, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11::date, $12::int, $13::uuid, 'CERTIFIED', 'PLATFORM_CODE',
          $14, $15, $16::uuid, now(), $13::uuid)`,
      [randomUUID(), ...metricFieldsOf(definition), revision, input.triggeredBy, input.sourceCommit, metricSha256(definition), supersedes],
    );
  }

  /**
   * Drafts a metric of the tenant. The code of a metric of the platform is read-only here, whoever asks; any other code must start with `t_`, the dataset must exist and offer every dimension, and a
   * code that the tenant drafted before gets the next revision.
   */
  async createTenant(tx: TenantTx, input: TenantMetricInput): Promise<MetricRow> {
    const { definition } = input;
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bi_metric:' || current_setting('app.tenant_id', true) || ':' || $1, 0))", [definition.code]);
    const held = await tx.query<{ origin: MetricOrigin; revision: number }>('select origin, revision from machvon.metric_definition where code = $1 order by revision desc limit 1', [definition.code]);
    if (held[0]?.origin === 'PLATFORM_CODE') throw new DomainError('PLATFORM_METRIC_READ_ONLY', 422, 'code');
    if (!definition.code.startsWith(TENANT_METRIC_PREFIX) || definition.code.length === TENANT_METRIC_PREFIX.length) throw new DomainError('VALIDATION_FAILED', 422, 'code');
    const datasets = await tx.query<{ join_paths: unknown }>("select join_paths from machvon.bi_dataset where id = $1::uuid and status = 'ACTIVE'", [input.datasetId]);
    if (datasets[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
    if (input.glossaryTermId !== undefined) {
      const terms = await tx.query<{ id: string }>('select id from machvon.glossary_term where id = $1::uuid', [input.glossaryTermId]);
      if (terms[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'glossary_term_id');
    }
    const offered = datasetDimensions(datasets[0].join_paths);
    const missing = definition.dimensionCodes.find((code) => !offered.includes(code));
    if (missing !== undefined) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, missing);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.metric_definition
         (tenant_id, id, code, grain, aggregation_type, expression_ast, numerator_ast, denominator_ast, unit, null_policy, dimension_codes, effective_from, revision, owner_id, status, origin,
          dataset_id, glossary_term_id, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11::date, $12::int, $13::uuid, 'DRAFT', 'TENANT_UI',
          $14::uuid, $15::uuid, $13::uuid)`,
      [id, ...metricFieldsOf(definition), (held[0]?.revision ?? 0) + 1, input.actor, input.datasetId, input.glossaryTermId ?? null],
    );
    return (await this.find(tx, id)) as MetricRow;
  }
}
