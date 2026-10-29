import { randomUUID } from 'node:crypto';
import { DomainError, INCIDENT_SLA_HOURS, assertComparable, assertPeriod, gateBatch, reconcileSources, unitFactor, versionConflict } from '@machvon/kernel';
import type { ConfirmedMapping, DifferenceKind, GateOutcome, ReconResult, ReportedLine, TreasuryLine } from '@machvon/kernel';
import { DATASET_VISIBLE, DgvDatasetStore } from './dgv-dataset-store.ts';
import type { DatasetViewer } from './dgv-dataset-store.ts';
import { lockIncidentOf } from './dgv-incident-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UNIQUE_VIOLATION = '23505';
/** The most differences a reconciliation keeps one by one; the totals and the counts by kind are always whole. */
export const MAX_DIFFERENCES = 1000;

export type MappingStatus = 'PROPOSED' | 'CONFIRMED' | 'REJECTED' | 'RETIRED';

export interface MappingRecord {
  id: string;
  datasetId: string;
  datasetCode: string;
  sourceSystem: string;
  sourceField: string;
  targetField: string;
  transformRule: string | null;
  unit: string | null;
  status: MappingStatus;
  proposedBy: string;
  proposedByName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  version: number;
  sortKey: string;
}

interface MappingRow {
  id: string;
  dataset_id: string;
  dataset_code: string;
  source_system: string;
  source_field: string;
  target_field: string;
  transform_rule: string | null;
  unit: string | null;
  status: MappingStatus;
  created_by: string;
  created_by_name: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

const MAPPING_FROM = `machvon.dataset_source_mapping m
  join machvon.dataset d on d.tenant_id = m.tenant_id and d.id = m.dataset_id
  left join machvon.tenant_user_directory cr on cr.tenant_id = m.tenant_id and cr.membership_id = m.created_by
  left join machvon.tenant_user_directory dc on dc.tenant_id = m.tenant_id and dc.membership_id = m.decided_by`;
const MAPPING_COLUMNS = `m.id, m.dataset_id, d.dataset_code, m.source_system, m.source_field, m.target_field, m.transform_rule, m.unit, m.status, m.created_by, cr.display_name as created_by_name, m.decided_by,
  dc.display_name as decided_by_name, ${TIME('m.decided_at')} as decided_at, m.decision_note, ${TIME('m.created_at')} as created_at, m.version::text as version, to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key`;

const toMapping = (row: MappingRow): MappingRecord => ({
  id: row.id,
  datasetId: row.dataset_id,
  datasetCode: row.dataset_code,
  sourceSystem: row.source_system,
  sourceField: row.source_field,
  targetField: row.target_field,
  transformRule: row.transform_rule,
  unit: row.unit,
  status: row.status,
  proposedBy: row.created_by,
  proposedByName: row.created_by_name,
  decidedBy: row.decided_by,
  decidedByName: row.decided_by_name,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

export interface BatchGateRecord {
  id: string;
  datasetId: string;
  sourceSystem: string;
  batchRef: string;
  outcome: 'APPLIED' | 'QUARANTINED';
  reason: string | null;
  rowCount: number;
  fields: unknown;
  gatedAt: string;
  gatedBy: string;
  sortKey: string;
}

export interface MappingFilters {
  datasetId?: string | undefined;
  status?: string | undefined;
  sourceSystem?: string | undefined;
}

/**
 * The mappings of the fields of a source (ST-DGV-004, DGV.md F7): a steward proposes, someone else confirms or rejects, and the pipeline reads only the confirmed ones. The people are memberships, as in the rest of DGV;
 * a dataset the viewer may not see is not there for them.
 */
export class DgvMappingStore {
  private readonly datasets = new DgvDatasetStore();

  /** Proposes a mapping of a field of a source to a field of the dataset, in the unit the source writes it in (422 `unit` for one that is not known, 409 `MAPPING_DUPLICATE` for one that is live already). */
  async propose(tx: TenantTx, viewer: DatasetViewer, input: { datasetId: string; sourceSystem: string; sourceField: string; targetField: string; transformRule: string | undefined; unit: string | undefined }): Promise<{ id: string }> {
    if ((await this.datasets.find(tx, input.datasetId, viewer)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (unitFactor(input.unit) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'unit');
    const transform = input.transformRule === undefined || input.transformRule === '' ? null : input.transformRule;
    const unit = input.unit === undefined || input.unit === '' ? null : input.unit;
    // A confirmed mapping is changed by proposing another for the same fields; one that says the same is nothing new.
    const same = await tx.query(
      "select 1 from machvon.dataset_source_mapping where dataset_id = $1::uuid and source_system = $2 and source_field = $3 and target_field = $4 and status = 'CONFIRMED' and unit is not distinct from $5 and transform_rule is not distinct from $6",
      [input.datasetId, input.sourceSystem, input.sourceField, input.targetField, unit, transform],
    );
    if (same.length > 0) throw new DomainError('MAPPING_DUPLICATE', 409, 'target_field');
    try {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.dataset_source_mapping (tenant_id, id, dataset_id, source_system, source_field, target_field, transform_rule, unit, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::uuid, $7::uuid) returning id`,
        [input.datasetId, input.sourceSystem, input.sourceField, input.targetField, transform, unit, viewer.membershipId],
      );
      return row as { id: string };
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('MAPPING_DUPLICATE', 409, 'target_field');
      throw error;
    }
  }

  async find(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<MappingRecord | undefined> {
    const [row] = await tx.query<MappingRow>(`select ${MAPPING_COLUMNS} from ${MAPPING_FROM} where m.id = $3::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], id]);
    return row === undefined ? undefined : toMapping(row);
  }

  /**
   * Confirms or rejects a proposed mapping at the version read; not the one who proposed it (403 `SELF_APPROVAL_DENIED`), and only a proposed one (409 `MAPPING_STATE_INVALID`). Confirming a mapping retires the one it replaces
   * (the confirmed mapping of the same fields), so that the pipeline reads one and the old one stays in the history.
   */
  async decide(tx: TenantTx, viewer: DatasetViewer, input: { id: string; expectedVersion: number; decision: 'CONFIRMED' | 'REJECTED'; note: string | undefined; at: Date }): Promise<MappingRecord & { retiredIds: string[] }> {
    const [locked] = await tx.query<MappingRow>(`select ${MAPPING_COLUMNS} from ${MAPPING_FROM} where m.id = $3::uuid and ${DATASET_VISIBLE} for update of m`, [viewer.membershipId, [...viewer.roleCodes], input.id]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const mapping = toMapping(locked);
    if (mapping.version !== input.expectedVersion) throw versionConflict(mapping.version);
    if (mapping.status !== 'PROPOSED') throw new DomainError('MAPPING_STATE_INVALID', 409, 'status', { extensions: { mapping_status: mapping.status } });
    if (mapping.proposedBy === viewer.membershipId) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    let retiredIds: string[] = [];
    if (input.decision === 'CONFIRMED') {
      const retired = await tx.query<{ id: string }>(
        `update machvon.dataset_source_mapping set status = 'RETIRED', updated_at = now(), updated_by = $2::uuid, version = version + 1
          where dataset_id = $1::uuid and source_system = $3 and source_field = $4 and target_field = $5 and status = 'CONFIRMED' and id <> $6::uuid returning id`,
        [mapping.datasetId, viewer.membershipId, mapping.sourceSystem, mapping.sourceField, mapping.targetField, mapping.id],
      );
      retiredIds = retired.map((row) => row.id);
    }
    await tx.query(
      `update machvon.dataset_source_mapping
          set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_note = $5, confirmed_by = case when $2 = 'CONFIRMED' then $3::uuid end, confirmed_at = case when $2 = 'CONFIRMED' then $4::timestamptz end,
              updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [mapping.id, input.decision, viewer.membershipId, input.at.toISOString(), input.note ?? null],
    );
    return { ...mapping, status: input.decision, decidedBy: viewer.membershipId, decidedAt: input.at.toISOString(), decisionNote: input.note ?? null, version: mapping.version + 1, retiredIds };
  }

  async list(tx: TenantTx, viewer: DatasetViewer, filters: MappingFilters, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<MappingRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<MappingRow>(
      `select ${MAPPING_COLUMNS} from ${MAPPING_FROM}
        where ${DATASET_VISIBLE} and ($3::uuid is null or m.dataset_id = $3::uuid) and ($4::text is null or m.status = $4) and ($5::text is null or m.source_system = $5)
          and ($6::timestamptz is null or (m.created_at, m.id) < ($6::timestamptz, $7::uuid))
        order by m.created_at desc, m.id desc limit $8::int`,
      [viewer.membershipId, [...viewer.roleCodes], filters.datasetId ?? null, filters.status ?? null, filters.sourceSystem ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toMapping);
  }

  /** The confirmed mappings of a source into a dataset: what the pipeline may use. */
  async confirmedFor(tx: TenantTx, datasetId: string, sourceSystem: string): Promise<ConfirmedMapping[]> {
    const rows = await tx.query<{ id: string; source_field: string; target_field: string; unit: string | null }>(
      "select id, source_field, target_field, unit from machvon.dataset_source_mapping where dataset_id = $1::uuid and source_system = $2 and status = 'CONFIRMED' order by source_field, target_field",
      [datasetId, sourceSystem],
    );
    return rows.map((row) => ({ id: row.id, sourceField: row.source_field, targetField: row.target_field, unit: row.unit }));
  }

  /**
   * The gate of the pipeline for a batch of a source (DGV.md F7): every field of the batch needs a mapping that was confirmed, else the batch is kept out in quarantine with the reason `MAPPING_NOT_CONFIRMED`. What happened
   * is written once. The caller converts the amounts with the factor of each field (`convertAmount`). The pipelines (DIS, PAY, MDM) call this before they read a batch; it is not a command of a person.
   */
  async gate(tx: TenantTx, input: { datasetId: string; sourceSystem: string; batchRef: string; rowCount: number; sourceFields: readonly string[]; actor: string }): Promise<GateOutcome & { gateId: string }> {
    const outcome = gateBatch(input.sourceFields, await this.confirmedFor(tx, input.datasetId, input.sourceSystem));
    const gateId = randomUUID();
    const fields = outcome.outcome === 'APPLIED' ? outcome.fields.map((field) => ({ source_field: field.sourceField, target_field: field.targetField, mapping_id: field.mappingId, factor: field.factor.toString() })) : outcome.missing.map((field) => ({ source_field: field, missing: true }));
    await tx.query(
      `insert into machvon.dataset_batch_gate (tenant_id, id, dataset_id, source_system, batch_ref, outcome, reason, row_count, fields, gated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6, $7::bigint, $8::jsonb, $9::uuid)`,
      [gateId, input.datasetId, input.sourceSystem, input.batchRef, outcome.outcome, outcome.outcome === 'QUARANTINED' ? outcome.reason : null, input.rowCount, JSON.stringify(fields), input.actor],
    );
    return { ...outcome, gateId };
  }

  async listGates(tx: TenantTx, viewer: DatasetViewer, filters: { datasetId?: string | undefined; outcome?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<BatchGateRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<{ id: string; dataset_id: string; source_system: string; batch_ref: string; outcome: 'APPLIED' | 'QUARANTINED'; reason: string | null; row_count: string; fields: unknown; gated_at: string; gated_by: string; sort_key: string }>(
      `select g.id, g.dataset_id, g.source_system, g.batch_ref, g.outcome, g.reason, g.row_count::text as row_count, g.fields, ${TIME('g.gated_at')} as gated_at, g.gated_by,
              to_char(g.gated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key
         from machvon.dataset_batch_gate g join machvon.dataset d on d.tenant_id = g.tenant_id and d.id = g.dataset_id
        where ${DATASET_VISIBLE} and ($3::uuid is null or g.dataset_id = $3::uuid) and ($4::text is null or g.outcome = $4)
          and ($5::timestamptz is null or (g.gated_at, g.id) < ($5::timestamptz, $6::uuid))
        order by g.gated_at desc, g.id desc limit $7::int`,
      [viewer.membershipId, [...viewer.roleCodes], filters.datasetId ?? null, filters.outcome ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map((row) => ({ id: row.id, datasetId: row.dataset_id, sourceSystem: row.source_system, batchRef: row.batch_ref, outcome: row.outcome, reason: row.reason, rowCount: Number(row.row_count), fields: row.fields, gatedAt: row.gated_at, gatedBy: row.gated_by, sortKey: row.sort_key }));
  }
}

// ---- reconciliation ------------------------------------------------------------------------------------------------------------------

export interface ReconDifferenceRecord {
  key: string;
  kind: DifferenceKind;
  side: 'A_ONLY' | 'B_ONLY' | 'BOTH';
  amount_a_vnd: string;
  amount_b_vnd: string;
  difference_vnd: string;
}

export interface ReconciliationRecord {
  id: string;
  reconCode: string;
  sourceA: string;
  sourceB: string;
  asOfPeriod: string;
  basis: string;
  countA: number;
  countB: number;
  totalAVnd: string;
  totalBVnd: string;
  differenceVnd: string;
  toleranceVnd: string;
  differences: ReconDifferenceRecord[];
  differencesTruncated: boolean;
  byKind: Record<DifferenceKind, number>;
  /** How many differences there were, whole, whatever part of them is kept one by one. */
  differencesCount: number;
  result: ReconResult;
  ownerId: string;
  ownerName: string | null;
  datasetId: string | null;
  incidentId: string | null;
  createdAt: string;
  sortKey: string;
}

interface ReconRow {
  id: string;
  recon_code: string;
  source_a: string;
  source_b: string;
  as_of_period: string;
  basis: string;
  count_a: string;
  count_b: string;
  total_a_vnd: string;
  total_b_vnd: string;
  tolerance_vnd: string;
  differences_json: ReconDifferenceRecord[];
  differences_truncated: boolean;
  differences_count: number;
  by_kind: Partial<Record<DifferenceKind, number>>;
  result: ReconResult;
  owner_user_id: string;
  owner_name: string | null;
  dataset_id: string | null;
  incident_id: string | null;
  created_at: string;
  sort_key: string;
}

const RECON_FROM = `machvon.reconciliation_run c left join machvon.tenant_user_directory o on o.tenant_id = c.tenant_id and o.membership_id = c.owner_user_id`;
const RECON_COLUMNS = `c.id, c.recon_code, c.source_a, c.source_b, c.as_of_period, c.basis, c.count_a::text as count_a, c.count_b::text as count_b, c.total_a_vnd::text as total_a_vnd, c.total_b_vnd::text as total_b_vnd, c.tolerance_vnd::text as tolerance_vnd,
  c.differences_json, c.differences_truncated, c.differences_count, c.by_kind, c.result, c.owner_user_id, o.display_name as owner_name, c.dataset_id, c.incident_id, ${TIME('c.created_at')} as created_at,
  to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key`;

const countKinds = (differences: readonly ReconDifferenceRecord[]): Record<DifferenceKind, number> => {
  const counted = { MISSING: 0, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 0 };
  for (const entry of differences) counted[entry.kind] += 1;
  return counted;
};

const toRecon = (row: ReconRow): ReconciliationRecord => ({
  id: row.id,
  reconCode: row.recon_code,
  sourceA: row.source_a,
  sourceB: row.source_b,
  asOfPeriod: row.as_of_period,
  basis: row.basis,
  countA: Number(row.count_a),
  countB: Number(row.count_b),
  totalAVnd: row.total_a_vnd,
  totalBVnd: row.total_b_vnd,
  differenceVnd: (BigInt(row.total_a_vnd) - BigInt(row.total_b_vnd)).toString(),
  toleranceVnd: row.tolerance_vnd,
  differences: row.differences_json,
  differencesTruncated: row.differences_truncated,
  byKind: { MISSING: row.by_kind.MISSING ?? 0, TIMING: row.by_kind.TIMING ?? 0, REVERSAL: row.by_kind.REVERSAL ?? 0, MAPPING: row.by_kind.MAPPING ?? 0, AMOUNT: row.by_kind.AMOUNT ?? 0 },
  differencesCount: row.differences_count,
  result: row.result,
  ownerId: row.owner_user_id,
  ownerName: row.owner_name,
  datasetId: row.dataset_id,
  incidentId: row.incident_id,
  createdAt: row.created_at,
  sortKey: row.sort_key,
});

/**
 * The reconciliation of the Treasury of PAY with the report DIS accepted for a month (DGV.md F7, BR-DGV-09): the two are read on the same period and basis, project by project, and every difference is classified and
 * kept; neither is chosen and the totals are never added. A difference opens an incident for the owner of the dataset, once while it stays open.
 */
export class DgvReconciliationStore {
  private readonly datasets = new DgvDatasetStore();

  async run(
    tx: TenantTx,
    viewer: DatasetViewer,
    input: { reconCode: string; sourceA: string; sourceB: string; asOfPeriod: string; basis: string; toleranceVnd: string; datasetId: string | undefined; at: Date },
  ): Promise<ReconciliationRecord> {
    assertComparable({ sourceA: input.sourceA, sourceB: input.sourceB, basis: input.basis });
    const period = assertPeriod(input.asOfPeriod);
    const dataset = await this.owningDataset(tx, viewer, input.datasetId);
    const [frozen] = await tx.query<{ snapshot_id: string; end_date: string; fiscal_year: number; cutoff: string }>(
      `select s.id as snapshot_id, p.end_date::text as end_date, p.fiscal_year as fiscal_year, s.treasury_cutoff_date::text as cutoff
         from machvon.reporting_period p join machvon.period_snapshot s on s.tenant_id = p.tenant_id and s.period_id = p.id and s.snapshot_kind = 'PERIOD_CLOSE' and s.status = 'FROZEN'
        where p.period_type = 'MONTH' and to_char(p.start_date, 'YYYY-MM') = $1 order by s.frozen_at desc, s.id limit 1`,
      [period],
    );
    // The report must exist and be closed: there is nothing to compare with otherwise.
    if (frozen === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 422, 'as_of_period');
    const a = await this.treasury(tx, `${frozen.fiscal_year}-01-01`, frozen.end_date, frozen.cutoff);
    const b = await this.reported(tx, frozen.snapshot_id);
    const outcome = reconcileSources({ a, b, toleranceVnd: BigInt(input.toleranceVnd) });
    const kept = outcome.differences.slice(0, MAX_DIFFERENCES).map<ReconDifferenceRecord>((entry) => ({
      key: entry.key,
      kind: entry.kind,
      side: entry.side,
      amount_a_vnd: entry.amountAVnd.toString(),
      amount_b_vnd: entry.amountBVnd.toString(),
      difference_vnd: entry.differenceVnd.toString(),
    }));
    const kinds = countKinds(outcome.differences.map((entry) => ({ key: entry.key, kind: entry.kind, side: entry.side, amount_a_vnd: '', amount_b_vnd: '', difference_vnd: '' })));
    const id = randomUUID();
    // A difference has its incident when it is written (the database says so): the open one for the same code and month, or a new one that is written first and points forward to this reconciliation (that key is checked at the commit).
    const incident = outcome.result === 'DIFFERENT' ? await this.incidentFor(tx, { reconCode: input.reconCode, period, datasetId: dataset.id }) : undefined;
    if (incident !== undefined && incident.isNew) await this.createIncident(tx, { id: incident.id, reconciliationId: id, reconCode: input.reconCode, period, ownerId: dataset.ownerId, snapshotId: frozen.snapshot_id });
    await tx.query(
      `insert into machvon.reconciliation_run
         (tenant_id, id, recon_code, source_a, source_b, as_of_period, basis, count_a, count_b, total_a_vnd, total_b_vnd, tolerance_vnd, differences_json, differences_truncated, differences_count, by_kind, result, owner_user_id, dataset_id, snapshot_id, incident_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9::numeric, $10::numeric, $11::numeric, $12::jsonb, $13, $20::integer, $21::jsonb, $14, $15::uuid, $16::uuid, $17::uuid, $18::uuid, $19::uuid, $19::uuid)`,
      [id, input.reconCode, input.sourceA, input.sourceB, period, input.basis, outcome.countA, outcome.countB, outcome.totalAVnd.toString(), outcome.totalBVnd.toString(), input.toleranceVnd, JSON.stringify(kept), outcome.differences.length > MAX_DIFFERENCES, outcome.result, dataset.ownerId, dataset.id, frozen.snapshot_id, incident?.id ?? null, viewer.membershipId, outcome.differences.length, JSON.stringify(kinds)],
    );
    const [row] = await tx.query<ReconRow>(`select ${RECON_COLUMNS} from ${RECON_FROM} where c.id = $1::uuid`, [id]);
    return toRecon(row as ReconRow);
  }

  /** The dataset an incident of the reconciliation belongs to: the one named, or the only dataset of DIS the viewer may see. */
  private async owningDataset(tx: TenantTx, viewer: DatasetViewer, datasetId: string | undefined): Promise<{ id: string; ownerId: string }> {
    if (datasetId !== undefined) {
      const found = await this.datasets.find(tx, datasetId, viewer);
      if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
      return { id: found.id, ownerId: found.ownerId };
    }
    const candidates = await tx.query<{ id: string; owner_user_id: string }>(`select d.id, d.owner_user_id from machvon.dataset d where d.producer_module = 'DIS' and ${DATASET_VISIBLE} order by d.dataset_code, d.id limit 2`, [viewer.membershipId, [...viewer.roleCodes]]);
    if (candidates.length !== 1) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
    return { id: (candidates[0] as { id: string }).id, ownerId: (candidates[0] as { owner_user_id: string }).owner_user_id };
  }

  /** What the Treasury paid, project by project, from the first day of the fiscal year of the report to the last day of the month, by the day it paid (a refund takes away; the report is cumulative within its year), and what part of it was confirmed after the cut-off the report was made on. */
  private async treasury(tx: TenantTx, startDate: string, endDate: string, cutoff: string): Promise<TreasuryLine[]> {
    const rows = await tx.query<{ key: string; amount: string; reversal: string; after_cutoff: string }>(
      `select project_id::text as key,
              sum(case direction when 'REFUND' then -amount_vnd else amount_vnd end)::text as amount,
              coalesce(sum(case direction when 'REFUND' then -amount_vnd else 0 end), 0)::text as reversal,
              coalesce(sum(case when (confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date > $2::date then (case direction when 'REFUND' then -amount_vnd else amount_vnd end) else 0 end), 0)::text as after_cutoff
         from machvon.treasury_transaction where (confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date between $3::date and $1::date group by project_id`,
      [endDate, cutoff, startDate],
    );
    return rows.map((row) => ({ key: row.key, amountVnd: BigInt(row.amount), reversalVnd: BigInt(row.reversal), afterCutoffVnd: BigInt(row.after_cutoff) }));
  }

  /** What the accepted report says each project had disbursed (the frozen snapshot of the month closing); a project the report gives no figure for is not in it. */
  private async reported(tx: TenantTx, snapshotId: string): Promise<ReportedLine[]> {
    const rows = await tx.query<{ key: string; amount: string }>(
      'select project_id::text as key, sum(disbursed_reported_vnd)::text as amount from machvon.period_snapshot_line where snapshot_id = $1::uuid and disbursed_reported_vnd is not null group by project_id',
      [snapshotId],
    );
    return rows.map((row) => ({ key: row.key, amountVnd: BigInt(row.amount) }));
  }

  /** The incident of a difference: the one still open for the same reconciliation code and month when there is one (the difference goes on, it is not a second problem), otherwise the id of a new one. */
  private async incidentFor(tx: TenantTx, input: { reconCode: string; period: string; datasetId: string }): Promise<{ id: string; isNew: boolean }> {
    // Together with the run of the rules and the end of a waiver on the dataset: one at a time.
    await lockIncidentOf(tx, input.datasetId, `recon:${input.reconCode}:${input.period}`);
    const [open] = await tx.query<{ id: string }>(
      `select i.id from machvon.quality_incident i join machvon.reconciliation_run c on c.tenant_id = i.tenant_id and c.id = i.reconciliation_id
        where i.status <> 'CLOSED' and c.recon_code = $1 and c.as_of_period = $2 and c.dataset_id = $3::uuid order by i.created_at, i.id limit 1`,
      [input.reconCode, input.period, input.datasetId],
    );
    return open === undefined ? { id: randomUUID(), isNew: true } : { id: open.id, isNew: false };
  }

  /** A new incident of a reconciliation: HIGH, due by the SLA of that severity, owned by the owner of the dataset, about the frozen report that was compared. */
  private async createIncident(tx: TenantTx, input: { id: string; reconciliationId: string; reconCode: string; period: string; ownerId: string; snapshotId: string }): Promise<void> {
    const hours = INCIDENT_SLA_HOURS.HIGH;
    await tx.query(
      `insert into machvon.quality_incident (tenant_id, id, dataset_version_id, affected_refs, severity, owner_id, status, due_at, title, sla_hours, reconciliation_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, '[]'::jsonb, 'HIGH', $3::uuid, 'OPEN', now() + $4::integer * interval '1 hour', $5, $4::integer, $6::uuid)`,
      [input.id, input.snapshotId, input.ownerId, hours, `${input.reconCode} / ${input.period}`, input.reconciliationId],
    );
    await tx.query(
      "insert into machvon.quality_incident_event (tenant_id, id, incident_id, event_kind, to_status) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'CREATED', 'OPEN')",
      [input.id],
    );
  }

  async find(tx: TenantTx, viewer: DatasetViewer, id: string): Promise<ReconciliationRecord | undefined> {
    const [row] = await tx.query<ReconRow>(`select ${RECON_COLUMNS} from ${RECON_FROM} join machvon.dataset d on d.tenant_id = c.tenant_id and d.id = c.dataset_id where c.id = $3::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], id]);
    return row === undefined ? undefined : toRecon(row);
  }

  async list(tx: TenantTx, viewer: DatasetViewer, filters: { reconCode?: string | undefined; period?: string | undefined; result?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<ReconciliationRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<ReconRow>(
      `select ${RECON_COLUMNS} from ${RECON_FROM} join machvon.dataset d on d.tenant_id = c.tenant_id and d.id = c.dataset_id
        where ${DATASET_VISIBLE} and ($3::text is null or c.recon_code = $3) and ($4::text is null or c.as_of_period = $4) and ($5::text is null or c.result = $5)
          and ($6::timestamptz is null or (c.created_at, c.id) < ($6::timestamptz, $7::uuid))
        order by c.created_at desc, c.id desc limit $8::int`,
      [viewer.membershipId, [...viewer.roleCodes], filters.reconCode ?? null, filters.period ?? null, filters.result ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map((row) => toRecon(row));
  }
}
