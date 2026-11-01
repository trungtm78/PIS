import { DomainError, MIGRATION_MAPPINGS, checkReferences, checkRegistration, judgeMigrationFile, migrationMappingOf, totalsMatch, versionConflict } from '@machvon/kernel';
import type { ControlTotals, JudgedRow, MigrationJudgement, MigrationMapping } from '@machvon/kernel';
import { cursorFor, cursorOf } from './dgv-keyset.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The conversion of legacy data in batches (ST-ADM-020, ADM.md 3.10, BR-ADM-01, BR-ADM-12, ADM-13): a file is registered once for an entity (its hash is its identity), dry-run without a row written, applied by somebody
 * other than who registered it, lot by lot, and rolled back while nothing built on its rows. The rows are upserted by the business key of the source, so that a lot that is run again does not double; what was written
 * is added up and compared with what the file said before the batch is Applied.
 */
export const MIGRATION_BATCH_RESOURCE = 'migration_batch';
const MAX_PAGE = 200;
const MAX_ERRORS_SHOWN = 1000;
const UNIQUE_VIOLATION = '23505';

type Sql = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const MIGRATION_STATUSES = ['Uploaded', 'Validating', 'Validated', 'DryRunPassed', 'DryRunFailed', 'PendingApproval', 'Applying', 'Applied', 'Failed', 'RolledBack'] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export interface MigrationBatch {
  id: string;
  sourceSystem: string;
  targetEntity: string;
  fileSha256: string;
  fileStorageKey: string;
  mappingVersion: string;
  rowCount: number;
  errorCount: number;
  status: MigrationStatus;
  dryRunReportRef: string | null;
  controlTotals: { expected?: ControlTotals; actual?: ControlTotals; matched?: boolean } | null;
  rowsApplied: number;
  failureCode: string | null;
  createdBy: string;
  approvedBy: string | null;
  appliedAt: string | null;
  rolledBackBy: string | null;
  rolledBackAt: string | null;
  rollbackReason: string | null;
  createdAt: string;
  version: number;
}

export interface MigrationErrorRow {
  rowNumber: number;
  lineNumber: number;
  field: string;
  code: string;
  message: string;
}

export interface MigrationPage {
  items: MigrationBatch[];
  next: string | null;
}

/** What a dry run decided about a batch. */
export interface DryRunOutcome {
  status: 'DryRunPassed' | 'DryRunFailed';
  judgement: MigrationJudgement;
}

const BATCH_SELECT = `select id, source_system, target_entity, file_sha256, file_storage_key, mapping_version, row_count, error_count, status, dry_run_report_ref, control_totals, rows_applied, failure_code,
  created_by, approved_by, applied_at::text as applied_at, rolled_back_by, rolled_back_at::text as rolled_back_at, rollback_reason, created_at::text as created_at, version::text as version
  from machvon.migration_batch`;

function batchOf(row: Sql): MigrationBatch {
  return {
    id: row.id,
    sourceSystem: row.source_system,
    targetEntity: row.target_entity,
    fileSha256: row.file_sha256,
    fileStorageKey: row.file_storage_key,
    mappingVersion: row.mapping_version,
    rowCount: row.row_count,
    errorCount: row.error_count,
    status: row.status,
    dryRunReportRef: row.dry_run_report_ref,
    controlTotals: row.control_totals,
    rowsApplied: row.rows_applied,
    failureCode: row.failure_code,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    appliedAt: row.applied_at,
    rolledBackBy: row.rolled_back_by,
    rolledBackAt: row.rolled_back_at,
    rollbackReason: row.rollback_reason,
    createdAt: row.created_at,
    version: Number(row.version),
  };
}

const reasonOf = (reason: string): string => {
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return trimmed;
};

export class AdmMigrationStore {
  private readonly mappings: ReadonlyMap<string, MigrationMapping>;

  constructor(mappings: ReadonlyMap<string, MigrationMapping> = MIGRATION_MAPPINGS) {
    this.mappings = mappings;
  }

  mappingOf(version: string): MigrationMapping {
    return migrationMappingOf(version, this.mappings);
  }

  async find(tx: TenantTx, id: string): Promise<MigrationBatch | undefined> {
    const rows = await tx.query<Sql>(`${BATCH_SELECT} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : batchOf(rows[0]);
  }

  async list(tx: TenantTx, filter: { status?: string | undefined; targetEntity?: string | undefined; cursor?: string | undefined; limit: number }): Promise<MigrationPage> {
    if (filter.status !== undefined && !(MIGRATION_STATUSES as readonly string[]).includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const limit = Math.min(filter.limit, MAX_PAGE);
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${BATCH_SELECT} where ($1::text is null or status = $1) and ($2::text is null or target_entity = $2) and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
        order by created_at desc, id desc limit $5::int`,
      [filter.status ?? null, filter.targetEntity ?? null, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit).map(batchOf);
    const last = page[page.length - 1];
    return { items: page, next: rows.length > limit && last !== undefined ? cursorFor(last.createdAt, last.id) : null };
  }

  /** The problems a dry run found, in the order of the rows. */
  async errorsOf(tx: TenantTx, id: string): Promise<MigrationErrorRow[]> {
    const rows = await tx.query<Sql>(
      'select row_number, line_number, field, code, message from machvon.migration_batch_error where batch_id = $1::uuid order by row_number, field, code limit $2::int',
      [id, MAX_ERRORS_SHOWN],
    );
    return rows.map((row) => ({ rowNumber: row.row_number, lineNumber: row.line_number, field: row.field, code: row.code, message: row.message }));
  }

  /** Batches in a state, oldest first: what the worker has to carry on. */
  async idsIn(tx: TenantTx, status: 'Validating' | 'Applying', limit: number): Promise<string[]> {
    const rows = await tx.query<{ id: string }>('select id from machvon.migration_batch where status = $1 order by created_at, id limit $2::int', [status, limit]);
    return rows.map((row) => row.id);
  }

  /** Registers a file for an entity. The same file for the same entity is registered once (409 `MIGRATION_FILE_ALREADY_REGISTERED`). */
  async register(tx: TenantTx, input: { sourceSystem: string; targetEntity: string; fileSha256: string; fileStorageKey: string; mappingVersion: string }, actor: string): Promise<MigrationBatch> {
    checkRegistration(input, this.mappings);
    const taken = await tx.query('select 1 from machvon.migration_batch where target_entity = $1 and file_sha256 = $2', [input.targetEntity, input.fileSha256]);
    if (taken.length > 0) throw new DomainError('MIGRATION_FILE_ALREADY_REGISTERED', 409);
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.migration_batch (tenant_id, id, source_system, target_entity, file_sha256, file_storage_key, mapping_version, status, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4, $5, 'Uploaded', $6::uuid) returning id`,
        [input.sourceSystem, input.targetEntity, input.fileSha256, input.fileStorageKey, input.mappingVersion, actor],
      );
      return (await this.find(tx, (rows[0] as { id: string }).id)) as MigrationBatch;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('MIGRATION_FILE_ALREADY_REGISTERED', 409);
      throw error;
    }
  }

  private async lock(tx: TenantTx, id: string, expected?: number): Promise<MigrationBatch> {
    const rows = await tx.query<Sql>(`${BATCH_SELECT} where id = $1::uuid for update`, [id]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const batch = batchOf(rows[0]);
    if (expected !== undefined && batch.version !== expected) throw versionConflict(batch.version);
    return batch;
  }

  /** Asks for a dry run against the version the caller read: a batch that is registered, failed its dry run or failed to apply (409 `MIGRATION_STATE_INVALID` otherwise). The worker does it. */
  async requestDryRun(tx: TenantTx, id: string, expected: number): Promise<MigrationBatch> {
    const batch = await this.lock(tx, id, expected);
    if (batch.status === 'Applied') throw new DomainError('MIGRATION_FILE_ALREADY_APPLIED', 409);
    if (!['Uploaded', 'DryRunFailed', 'Failed'].includes(batch.status)) throw new DomainError('MIGRATION_STATE_INVALID', 409, batch.status);
    await tx.query("update machvon.migration_batch set status = 'Validating', failure_code = null, updated_at = now(), version = version + 1 where id = $1::uuid", [id]);
    return (await this.find(tx, id)) as MigrationBatch;
  }

  /** The keys of the rows that were migrated and still stand, for each entity that the mapping refers to: what a reference can point at. */
  private async knownKeys(tx: TenantTx, judgement: MigrationJudgement): Promise<Map<string, Set<string>>> {
    const wanted = new Map<string, Set<string>>();
    for (const row of judgement.rows) for (const ref of row.refs) wanted.set(ref.entity, (wanted.get(ref.entity) ?? new Set<string>()).add(ref.key));
    const known = new Map<string, Set<string>>();
    for (const [entity, keys] of wanted) {
      const found = await tx.query<{ business_key: string }>("select business_key from machvon.migration_row where target_entity = $1 and state = 'VALID' and business_key = any($2::text[])", [
        entity,
        [...keys],
      ]);
      known.set(entity, new Set(found.map((row) => row.business_key)));
    }
    return known;
  }

  /**
   * The dry run (the worker): judges the table of the file, lists what is wrong row by row and writes nothing to the target. The batch becomes DryRunPassed when the file is clean, DryRunFailed otherwise, with the
   * control totals the file says. A batch that is not being validated is left alone (the worker may be told twice).
   */
  async recordDryRun(tx: TenantTx, id: string, table: { headers: readonly string[]; rows: readonly (readonly string[])[]; lines: readonly number[] }): Promise<DryRunOutcome | undefined> {
    const batch = await this.lock(tx, id);
    if (batch.status !== 'Validating') return undefined;
    const mapping = this.mappingOf(batch.mappingVersion);
    const base = judgeMigrationFile(table, mapping);
    const judgement = checkReferences(base, mapping, await this.knownKeys(tx, base));
    const status = judgement.errorCount === 0 ? 'DryRunPassed' : 'DryRunFailed';
    await tx.query('delete from machvon.migration_batch_error where batch_id = $1::uuid', [id]);
    for (const error of judgement.errors) {
      await tx.query(
        `insert into machvon.migration_batch_error (tenant_id, batch_id, row_number, line_number, field, code, message)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6) on conflict do nothing`,
        [id, error.rowNumber, error.lineNumber, error.field, error.code, error.message],
      );
    }
    await tx.query(
      `update machvon.migration_batch set status = $2, row_count = $3, error_count = $4, control_totals = jsonb_build_object('expected', $5::jsonb), dry_run_report_ref = $6, updated_at = now(), version = version + 1
        where id = $1::uuid`,
      [id, status, judgement.rowCount, judgement.errorCount, JSON.stringify(judgement.totals), `migration_batch_error:${id}`],
    );
    return { status, judgement };
  }

  /** Approves and starts the apply: only a batch that passed its dry run, and not by the person who registered it (403 `SELF_APPROVAL_DENIED`). The worker writes the lots. */
  async requestApply(tx: TenantTx, id: string, expected: number, actor: string): Promise<MigrationBatch> {
    const batch = await this.lock(tx, id, expected);
    if (batch.status === 'Applied') throw new DomainError('MIGRATION_FILE_ALREADY_APPLIED', 409);
    if (batch.status !== 'DryRunPassed') throw new DomainError('MIGRATION_STATE_INVALID', 409, batch.status);
    if (batch.createdBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await tx.query("update machvon.migration_batch set status = 'Applying', approved_by = $2::uuid, updated_at = now(), version = version + 1 where id = $1::uuid", [id, actor]);
    return (await this.find(tx, id)) as MigrationBatch;
  }

  /**
   * Writes one lot of rows of an applying batch, each upserted by its business key (running the lot again writes the same rows). Returns how many rows the batch has now, or undefined when the batch is not
   * applying any more (it was told twice, or failed).
   */
  async writeLot(tx: TenantTx, id: string, rows: readonly JudgedRow[]): Promise<number | undefined> {
    const batch = await this.lock(tx, id);
    if (batch.status !== 'Applying') return undefined;
    // A row may refer only to a row that still stands: the references are asked again with the lot, and the rows they name are held (a rollback of the batch they belong to waits for this lot, and then finds the rows written).
    const wanted = new Map<string, Set<string>>();
    for (const row of rows) for (const ref of row.refs) wanted.set(ref.entity, (wanted.get(ref.entity) ?? new Set<string>()).add(ref.key));
    for (const [entity, keys] of wanted) {
      const held = await tx.query<{ business_key: string }>(
        "select business_key from machvon.migration_row where target_entity = $1 and state = 'VALID' and business_key = any($2::text[]) for share",
        [entity, [...keys]],
      );
      if (held.length !== keys.size) throw new DomainError('VALIDATION_FAILED', 422, 'reference');
    }
    for (const row of rows) {
      await tx.query(
        `insert into machvon.migration_row (tenant_id, target_entity, business_key, payload, amount, refs, migrated_batch_id, state)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::jsonb, $4::numeric, $5::jsonb, $6::uuid, 'VALID')
         on conflict (tenant_id, target_entity, business_key) do update
           set payload = excluded.payload, amount = excluded.amount, refs = excluded.refs, migrated_batch_id = excluded.migrated_batch_id, state = 'VALID', version = machvon.migration_row.version + 1, updated_at = now()`,
        [batch.targetEntity, row.businessKey, JSON.stringify(row.payload), row.amount, JSON.stringify(row.refs), id],
      );
    }
    const counted = await tx.query<{ n: string }>("select count(*)::text as n from machvon.migration_row where migrated_batch_id = $1::uuid and state = 'VALID'", [id]);
    const applied = Number((counted[0] as { n: string }).n);
    await tx.query('update machvon.migration_batch set rows_applied = $2, updated_at = now() where id = $1::uuid', [id, applied]);
    return applied;
  }

  /**
   * Closes an applying batch: what was written is added up and compared with what the file said (BR-ADM-12). The batch is Applied when they agree and Failed (`CONTROL_TOTALS_MISMATCH`) when they do not.
   * A batch that is Applied already is `ALREADY_IMPORTED`: nothing is written twice.
   */
  async finishApply(tx: TenantTx, id: string): Promise<{ outcome: 'APPLIED' | 'FAILED' | 'ALREADY_IMPORTED' | 'NOT_APPLYING'; batch: MigrationBatch }> {
    const batch = await this.lock(tx, id);
    if (batch.status === 'Applied') return { outcome: 'ALREADY_IMPORTED', batch };
    if (batch.status !== 'Applying') return { outcome: 'NOT_APPLYING', batch };
    const sums = await tx.query<{ n: string; amount: string | null }>(
      "select count(*)::text as n, coalesce(sum(amount), 0)::text as amount from machvon.migration_row where migrated_batch_id = $1::uuid and state = 'VALID'",
      [id],
    );
    const actual: ControlTotals = { rows: Number((sums[0] as { n: string }).n), amount: String((sums[0] as { amount: string | null }).amount ?? '0') };
    const expected = batch.controlTotals?.expected as ControlTotals;
    const matched = totalsMatch(expected, actual);
    await tx.query(
      matched
        ? "update machvon.migration_batch set status = 'Applied', applied_at = now(), control_totals = jsonb_build_object('expected', $2::jsonb, 'actual', $3::jsonb, 'matched', true), updated_at = now(), version = version + 1 where id = $1::uuid"
        : "update machvon.migration_batch set status = 'Failed', failure_code = 'CONTROL_TOTALS_MISMATCH', control_totals = jsonb_build_object('expected', $2::jsonb, 'actual', $3::jsonb, 'matched', false), updated_at = now(), version = version + 1 where id = $1::uuid",
      [id, JSON.stringify(expected), JSON.stringify(actual)],
    );
    return { outcome: matched ? 'APPLIED' : 'FAILED', batch: (await this.find(tx, id)) as MigrationBatch };
  }

  /** A batch whose apply stopped (the file could not be read, a lot could not be written): Failed with the code, the rows written so far stay and a new dry run and apply go on from them. */
  async failApply(tx: TenantTx, id: string, code: string): Promise<MigrationBatch | undefined> {
    const batch = await this.lock(tx, id);
    if (batch.status !== 'Applying' && batch.status !== 'Validating') return undefined;
    await tx.query(
      `update machvon.migration_batch set status = case when status = 'Validating' then 'DryRunFailed' else 'Failed' end, failure_code = $2, updated_at = now(), version = version + 1 where id = $1::uuid`,
      [id, code.slice(0, 100)],
    );
    return (await this.find(tx, id)) as MigrationBatch;
  }

  /**
   * Rolls an applied batch back: its rows are marked INVALID (not deleted) and the batch is RolledBack. Refused while another batch's rows refer to rows of this one (409 `MIGRATION_DEPENDENTS_EXIST`), and for
   * a batch that is not Applied (409 `MIGRATION_STATE_INVALID`).
   */
  async rollback(tx: TenantTx, id: string, expected: number, reason: string, actor: string): Promise<{ batch: MigrationBatch; rows: number }> {
    const batch = await this.lock(tx, id, expected);
    const why = reasonOf(reason);
    if (batch.status !== 'Applied') throw new DomainError('MIGRATION_STATE_INVALID', 409, batch.status);
    // The rows of the batch are held before anything is asked about them: a lot of another batch that is being written and refers to them finishes first, and the question below is asked after it.
    await tx.query("select 1 from machvon.migration_row where migrated_batch_id = $1::uuid and state = 'VALID' for update", [id]);
    const dependents = await tx.query(
      `select 1 from machvon.migration_row d
        where d.migrated_batch_id <> $1::uuid and d.state = 'VALID'
          and exists (select 1 from jsonb_array_elements(d.refs) ref join machvon.migration_row m on m.migrated_batch_id = $1::uuid and m.state = 'VALID'
                       and m.target_entity = ref ->> 'entity' and m.business_key = ref ->> 'key') limit 1`,
      [id],
    );
    if (dependents.length > 0) throw new DomainError('MIGRATION_DEPENDENTS_EXIST', 409);
    const marked = await tx.query<{ business_key: string }>(
      "update machvon.migration_row set state = 'INVALID', version = version + 1, updated_at = now() where migrated_batch_id = $1::uuid and state = 'VALID' returning business_key",
      [id],
    );
    await tx.query(
      "update machvon.migration_batch set status = 'RolledBack', rolled_back_by = $2::uuid, rolled_back_at = now(), rollback_reason = $3, updated_at = now(), version = version + 1 where id = $1::uuid",
      [id, actor, why],
    );
    return { batch: (await this.find(tx, id)) as MigrationBatch, rows: marked.length };
  }
}
