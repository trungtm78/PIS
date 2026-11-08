import { DomainError } from '@machvon/kernel';
import type { ContractorExportRecord, ContractorExportScope, ContractorExportFormat, ExportFile, ExportRequest, Submission } from '@machvon/kernel';
import { SCOPE_FROM } from './ctr-contract-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const EXPORT_PERMISSION = 'contractor.export';
/** A file of more rows than this is not made: a period that large is asked for in parts. */
export const EXPORT_ROW_LIMIT = 20_000;

type BatchStatus = 'GENERATED' | 'SUBMITTED_EXTERNALLY' | 'CONFIRMED' | 'FAILED';

export interface Batch {
  id: string;
  scope: ContractorExportScope;
  periodFrom: string;
  periodTo: string;
  format: ContractorExportFormat;
  fileSha256: string;
  rowCount: number;
  status: BatchStatus;
  submittedRef: string | null;
  submittedOn: string | null;
  createdAt: string;
  version: number;
}

interface BatchSql {
  id: string;
  scope: ContractorExportScope;
  period_from: string;
  period_to: string;
  format: ContractorExportFormat;
  file_sha256: string;
  row_count: number;
  status: BatchStatus;
  submitted_ref: string | null;
  submitted_on: string | null;
  created_at: string;
  version: string;
}

const BATCH_COLUMNS = `b.id, b.scope, b.period_from::text as period_from, b.period_to::text as period_to, b.format, b.file_sha256, b.row_count, b.status, b.submitted_ref, b.submitted_on::text as submitted_on,
  ${timestampKey('b.created_at')} as created_at, b.version::text as version`;

const toBatch = (row: BatchSql): Batch => ({
  id: row.id,
  scope: row.scope,
  periodFrom: row.period_from,
  periodTo: row.period_to,
  format: row.format,
  fileSha256: row.file_sha256,
  rowCount: row.row_count,
  status: row.status,
  submittedRef: row.submitted_ref,
  submittedOn: row.submitted_on,
  createdAt: row.created_at,
  version: Number(row.version),
});

/** The rows of a batch the caller may read: every contract the file covers is in their scope as it is now, so a scope that was narrowed since the file was made no longer reaches it. */
const covered = (scope: ScopeBuilder, first: number): { sql: string; params: unknown[] } => {
  const predicate = scope(first);
  return { sql: `not exists (select 1 from unnest(b.contract_ids) as covered(contract_id) where not exists (select 1 from ${SCOPE_FROM} where c.id = covered.contract_id and ${predicate.sql}))`, params: predicate.params };
};

const DAY_VN = (column: string): string => `(${column} at time zone 'Asia/Ho_Chi_Minh')::date`;

/**
 * The export of the records of the contractors (ST-CTR-015). The records are the approved evaluations that stand and the confirmed violations whose decision was made in the period (the day of the approval, the day of the
 * confirmation), of the contracts the caller holds `contractor.export` over. The batch is named by the hash of its file: the same records give the same batch, never a second one.
 */
export class CtrExportStore {
  /** The records of the request in the scope of the caller, and whether there are more than the file may hold. */
  async records(tx: TenantTx, request: ExportRequest, scope: ScopeBuilder): Promise<{ records: ContractorExportRecord[]; overflow: boolean }> {
    const predicate = scope(3);
    const params = [request.periodFrom, request.periodTo, ...predicate.params];
    const records: ContractorExportRecord[] = [];
    if (request.scope !== 'VIOLATION') {
      const rows = await tx.query<{
        id: string;
        contract_id: string;
        tax: string;
        name: string;
        code: string;
        kind: string;
        period: string;
        revision: number;
        quality: number;
        schedule: number;
        safety: number;
        cooperation: number;
        financial: number;
        overall: string;
        rating: string;
        approved_on: string;
      }>(
        `select e.id, c.id as contract_id, k.tax_identifier as tax, k.legal_name as name, c.code, e.evaluation_kind as kind, e.period_label as period, e.revision, e.score_quality as quality, e.score_schedule as schedule,
                e.score_safety_env as safety, e.score_cooperation as cooperation, e.score_financial as financial, e.overall_score::text as overall, e.rating, ${DAY_VN('e.approved_at')}::text as approved_on
           from machvon.contractor_performance e join ${SCOPE_FROM} on c.tenant_id = e.tenant_id and c.id = e.contract_id join machvon.contractor k on k.tenant_id = e.tenant_id and k.id = e.contractor_id
          where e.status = 'APPROVED' and ${DAY_VN('e.approved_at')} between $1::date and $2::date and ${predicate.sql}
          order by e.approved_at, e.id limit ${EXPORT_ROW_LIMIT + 1}`,
        params,
      );
      for (const row of rows) {
        records.push({
          record_type: 'EVALUATION',
          contractId: row.contract_id,
          sort: ['1', row.tax, row.code, row.period, String(row.revision).padStart(6, '0'), row.id].join('|'),
          contractor_tax_identifier: row.tax,
          contractor_name: row.name,
          contract_code: row.code,
          evaluation_kind: row.kind,
          period_label: row.period,
          revision: String(row.revision),
          score_quality: String(row.quality),
          score_schedule: String(row.schedule),
          score_safety_env: String(row.safety),
          score_cooperation: String(row.cooperation),
          score_financial: String(row.financial),
          overall_score: row.overall,
          rating: row.rating,
          approved_on: row.approved_on,
        });
      }
    }
    if (request.scope !== 'PERFORMANCE') {
      const rows = await tx.query<{
        id: string;
        contract_id: string;
        tax: string;
        name: string;
        code: string;
        kind: string;
        severity: string;
        occurred_on: string;
        penalty: string;
        amount: string;
        decision: string | null;
        confirmed_on: string;
      }>(
        `select v.id, c.id as contract_id, k.tax_identifier as tax, k.legal_name as name, c.code, v.violation_kind as kind, v.severity, v.occurred_on::text as occurred_on, v.penalty_kind as penalty, v.penalty_amount_vnd::text as amount,
                v.decision_document_version_id as decision, ${DAY_VN('v.confirmed_at')}::text as confirmed_on
           from machvon.contractor_violation v join ${SCOPE_FROM} on c.tenant_id = v.tenant_id and c.id = v.contract_id join machvon.contractor k on k.tenant_id = v.tenant_id and k.id = v.contractor_id
          where v.status = 'CONFIRMED' and ${DAY_VN('v.confirmed_at')} between $1::date and $2::date and ${predicate.sql}
          order by v.confirmed_at, v.id limit ${EXPORT_ROW_LIMIT + 1}`,
        params,
      );
      for (const row of rows) {
        records.push({
          record_type: 'VIOLATION',
          contractId: row.contract_id,
          sort: ['2', row.tax, row.code, row.occurred_on, '000000', row.id].join('|'),
          contractor_tax_identifier: row.tax,
          contractor_name: row.name,
          contract_code: row.code,
          violation_kind: row.kind,
          severity: row.severity,
          occurred_on: row.occurred_on,
          penalty_kind: row.penalty,
          penalty_amount_vnd: row.amount,
          ...(row.decision === null ? {} : { decision_document_version_id: row.decision }),
          confirmed_on: row.confirmed_on,
        });
      }
    }
    const overflow = records.filter((record) => record.record_type === 'EVALUATION').length > EXPORT_ROW_LIMIT || records.filter((record) => record.record_type === 'VIOLATION').length > EXPORT_ROW_LIMIT;
    return { records: overflow ? [] : records, overflow };
  }

  /** The batch that already holds this file for this request, if there is one. */
  async findByFile(tx: TenantTx, request: ExportRequest, sha256: string): Promise<Batch | undefined> {
    const [row] = await tx.query<BatchSql>(
      `select ${BATCH_COLUMNS} from machvon.contractor_export_batch b where b.scope = $1 and b.period_from = $2::date and b.period_to = $3::date and b.file_sha256 = $4`,
      [request.scope, request.periodFrom, request.periodTo, sha256],
    );
    return row === undefined ? undefined : toBatch(row);
  }

  /**
   * Writes the batch of a file that was stored under `key`. Two people asking for the same file at once make one batch: the one that finds the other's row gets it back and `created` is false.
   */
  async insert(tx: TenantTx, id: string, request: ExportRequest, file: ExportFile, key: string, actor: string): Promise<{ batch: Batch; created: boolean }> {
    const [made] = await tx.query<{ id: string }>(
      `insert into machvon.contractor_export_batch (tenant_id, id, scope, period_from, period_to, format, file_sha256, file_object_key, row_count, contract_ids, status, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::date, $4::date, $5, $6, $7, $8, $10::uuid[], 'GENERATED', $9::uuid)
       on conflict (tenant_id, scope, period_from, period_to, file_sha256) do nothing returning id`,
      [id, request.scope, request.periodFrom, request.periodTo, request.format, file.sha256, key, file.rows, actor, file.contractIds],
    );
    const batch = await this.findByFile(tx, request, file.sha256);
    if (batch === undefined) throw new Error('the batch that was just written is not there');
    return { batch, created: made !== undefined };
  }

  async find(tx: TenantTx, id: string): Promise<(Batch & { objectKey: string }) | undefined> {
    const [row] = await tx.query<BatchSql & { file_object_key: string }>(`select ${BATCH_COLUMNS}, b.file_object_key from machvon.contractor_export_batch b where b.id = $1::uuid`, [id]);
    return row === undefined ? undefined : { ...toBatch(row), objectKey: row.file_object_key };
  }

  /** Lets a person read the batch: they asked for its file (once, however often they ask). */
  async grant(tx: TenantTx, id: string, membershipId: string): Promise<void> {
    await tx.query(
      `insert into machvon.contractor_export_access (tenant_id, batch_id, membership_id) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid) on conflict do nothing`,
      [id, membershipId],
    );
  }

  /**
   * Whether the person may read the batch: they asked for its file (or hold the permission over the whole tenant, `wholeTenant`), and their scope today covers every contract the file names. Someone whose scope was narrowed since
   * they asked no longer reads it.
   */
  async mayRead(tx: TenantTx, id: string, membershipId: string, scope: ScopeBuilder, wholeTenant: boolean): Promise<boolean> {
    const reach = covered(scope, 4);
    const [row] = await tx.query<{ found: boolean }>(
      `select exists (select 1 from machvon.contractor_export_batch b
               where b.id = $1::uuid and ($3::boolean or exists (select 1 from machvon.contractor_export_access a where a.batch_id = b.id and a.membership_id = $2::uuid)) and ${reach.sql}) as found`,
      [id, membershipId, wholeTenant, ...reach.params],
    );
    return row?.found === true;
  }

  /** The batches, the newest first, that the caller may read (see `mayRead`); the cursor is the time of creation and the id of the last one. `readBy` keeps the ones that person asked for; without it every batch the scope covers is listed. */
  async list(tx: TenantTx, request: { limit: number; after: { code: string; id: string } | undefined; readBy: string | undefined; scope: ScopeBuilder }): Promise<Batch[]> {
    assertTimestampCursor(request.after?.code);
    const reach = covered(request.scope, 5);
    const rows = await tx.query<BatchSql>(
      `select ${BATCH_COLUMNS} from machvon.contractor_export_batch b
        where ($1::text is null or (${timestampKey('b.created_at')}, b.id) < ($1::text, $2::uuid)) and ($4::uuid is null or exists (select 1 from machvon.contractor_export_access a where a.batch_id = b.id and a.membership_id = $4::uuid)) and ${reach.sql} order by b.created_at desc, b.id desc limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit, request.readBy ?? null, ...reach.params],
    );
    return rows.map(toBatch);
  }

  /**
   * Writes down the receipt of a submission made by hand: only a batch that was generated is submitted, once, and only by someone who may read it (see `mayRead`): a batch the caller may not read is not there for them (404).
   */
  async markSubmitted(tx: TenantTx, id: string, submission: Submission, actor: string, scope: ScopeBuilder, wholeTenant: boolean): Promise<Batch> {
    const [row] = await tx.query<{ status: BatchStatus }>('select status from machvon.contractor_export_batch where id = $1::uuid for update', [id]);
    if (row === undefined || !(await this.mayRead(tx, id, actor, scope, wholeTenant))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status !== 'GENERATED') throw new DomainError('EXPORT_STATE_INVALID', 409, 'id');
    await tx.query(
      `update machvon.contractor_export_batch set status = 'SUBMITTED_EXTERNALLY', submitted_ref = $2, submitted_on = $3::date, submitted_by = $4::uuid, submitted_at = now(), version = version + 1 where id = $1::uuid`,
      [id, submission.ref, submission.on, actor],
    );
    const batch = await this.find(tx, id);
    if (batch === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return batch;
  }

  /**
   * The receipt of a posting obligation of EGP-2 whose packet is this batch is the receipt of the batch (EGP-2 owns the posting and its receipt; CTR-24 keeps its screen and its own command): a batch that was generated
   * becomes SUBMITTED_EXTERNALLY with the reference the network gave and the day of the receipt; one that a person already marked (on CTR-24) is left as it is. The right to read the batch was judged when the obligation
   * was linked to it. Returns whether the batch moved.
   */
  async submitFromObligation(tx: TenantTx, id: string, submission: Submission, actor: string): Promise<boolean> {
    const [row] = await tx.query<{ status: BatchStatus }>('select status from machvon.contractor_export_batch where id = $1::uuid for update', [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status !== 'GENERATED') return false;
    await tx.query(
      `update machvon.contractor_export_batch set status = 'SUBMITTED_EXTERNALLY', submitted_ref = $2, submitted_on = $3::date, submitted_by = $4::uuid, submitted_at = now(), version = version + 1 where id = $1::uuid`,
      [id, submission.ref, submission.on, actor],
    );
    return true;
  }
}

