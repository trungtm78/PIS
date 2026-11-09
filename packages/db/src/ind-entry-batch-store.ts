import { DomainError, versionConflict } from '@machvon/kernel';
import { figureSetLockKey } from './ind-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const UNIQUE_VIOLATION = '23505';

export const IND_ENTRY_BATCH_RESOURCE = 'ind_entry_batch';
export const ENTRY_BATCH_STATUSES = ['SUBMITTED', 'ACCEPTED', 'RETURNED', 'WITHDRAWN'] as const;
export type EntryBatchStatus = (typeof ENTRY_BATCH_STATUSES)[number];

/** One figure of a batch as the person typed it. */
export interface EntryBatchFigure {
  indicator_code: string;
  value: string;
  reason?: string | undefined;
}

export interface EntryBatchRow {
  id: string;
  projectId: string;
  projectCode: string;
  periodId: string;
  periodCode: string;
  revision: number;
  status: EntryBatchStatus;
  figures: EntryBatchFigure[];
  /** The warnings of the entry rules at the hand-in (they do not block, BBH 43): they go back with the batch to the person who entered and are in front of the approver. */
  warnings: Array<Record<string, unknown>>;
  figureCount: number;
  enteredBy: string;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  writtenCount: number | null;
  version: number;
}

interface BatchSql {
  id: string;
  project_id: string;
  project_code: string;
  period_id: string;
  period_code: string;
  revision: number;
  status: EntryBatchStatus;
  figures: EntryBatchFigure[];
  warnings: Array<Record<string, unknown>>;
  figure_count: number;
  entered_by: string;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  written_count: number | null;
  version: string;
}

const COLUMNS = `b.id, b.project_id, p.code as project_code, b.period_id, rp.code as period_code, b.revision, b.status, b.figures, b.warnings, b.figure_count, b.entered_by,
  to_char(b.submitted_at at time zone 'UTC', ${ISO}) as submitted_at, b.decided_by, to_char(b.decided_at at time zone 'UTC', ${ISO}) as decided_at, b.decision_reason, b.written_count, b.version::text as version`;
const FROM = `${SCOPE_FROM}
  join machvon.ind_entry_batch b on b.tenant_id = p.tenant_id and b.project_id = p.id
  join machvon.reporting_period rp on rp.tenant_id = b.tenant_id and rp.id = b.period_id`;

const toBatch = (row: BatchSql): EntryBatchRow => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  periodId: row.period_id,
  periodCode: row.period_code,
  revision: row.revision,
  status: row.status,
  figures: row.figures,
  warnings: row.warnings,
  figureCount: row.figure_count,
  enteredBy: row.entered_by,
  submittedAt: row.submitted_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  writtenCount: row.written_count,
  version: Number(row.version),
});

const stateInvalid = (status: string): DomainError => new DomainError('IND_ENTRY_BATCH_STATE_INVALID', 409, 'status', { extensions: { batch_status: status } });

export interface EntryBatchFilter {
  projectId?: string | undefined;
  periodId?: string | undefined;
  status?: EntryBatchStatus | undefined;
}

/**
 * The batches of indicator entries that go through the staged approval (ENT-3c): a person hands in the figures they typed as one batch (judged by the entry rules, the warnings kept), the steps decide it, and only the
 * last approval writes the figures to the register (`IndFigureStore.write`, append-only). A batch is never edited; a return keeps its figures and its warnings, and the person enters a new one. Maker is not checker.
 */
export class IndEntryBatchStore {
  async find(tx: TenantTx, id: string, scope: ScopeBuilder, lock = false): Promise<EntryBatchRow | undefined> {
    const visible = scope(2);
    const rows = await tx.query<BatchSql>(`select ${COLUMNS} from ${FROM} where b.id = $1::uuid and ${visible.sql}${lock ? ' for update of b' : ''}`, [id, ...visible.params]);
    return rows[0] === undefined ? undefined : toBatch(rows[0]);
  }

  async list(tx: TenantTx, filter: EntryBatchFilter, scope: ScopeBuilder, limit: number): Promise<EntryBatchRow[]> {
    const visible = scope(5);
    const rows = await tx.query<BatchSql>(
      `select ${COLUMNS} from ${FROM}
        where ($1::uuid is null or b.project_id = $1::uuid) and ($2::uuid is null or b.period_id = $2::uuid) and ($3::text is null or b.status = $3) and ${visible.sql}
        order by b.submitted_at desc, b.id desc limit $4::int`,
      [filter.projectId ?? null, filter.periodId ?? null, filter.status ?? null, limit, ...visible.params],
    );
    return rows.map(toBatch);
  }

  /** The batch that waits for a decision for a project and a period, if any. */
  async openFor(tx: TenantTx, projectId: string, periodId: string): Promise<EntryBatchRow | undefined> {
    const rows = await tx.query<BatchSql>(`select ${COLUMNS} from ${FROM} where b.project_id = $1::uuid and b.period_id = $2::uuid and b.status = 'SUBMITTED'`, [projectId, periodId]);
    return rows[0] === undefined ? undefined : toBatch(rows[0]);
  }

  /** Hands a batch in: the next revision for the project and the period; one batch waits for a decision at a time (409 `IND_ENTRY_BATCH_STATE_INVALID`). */
  async submit(tx: TenantTx, input: { projectId: string; periodId: string; figures: readonly EntryBatchFigure[]; warnings: ReadonlyArray<Record<string, unknown>> }, actor: string, now: Date): Promise<EntryBatchRow> {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [figureSetLockKey(input.projectId, input.periodId)]);
    const [next] = await tx.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from machvon.ind_entry_batch where project_id = $1::uuid and period_id = $2::uuid', [input.projectId, input.periodId]);
    try {
      const [inserted] = await tx.query<{ id: string }>(
        `insert into machvon.ind_entry_batch (tenant_id, id, project_id, period_id, revision, status, figures, warnings, figure_count, entered_by, submitted_at, created_at, updated_at)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3, 'SUBMITTED', $4::jsonb, $5::jsonb, $6, $7::uuid, $8::timestamptz, $8::timestamptz, $8::timestamptz) returning id`,
        [input.projectId, input.periodId, next?.revision ?? 1, JSON.stringify(input.figures), JSON.stringify(input.warnings), input.figures.length, actor, now.toISOString()],
      );
      const row = await this.find(tx, (inserted as { id: string }).id, () => ({ sql: 'true', params: [] }));
      return row as EntryBatchRow;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw stateInvalid('SUBMITTED');
      throw error;
    }
  }

  private async move(tx: TenantTx, batch: EntryBatchRow, to: 'ACCEPTED' | 'RETURNED' | 'WITHDRAWN', actor: string, now: Date, extra: { reason: string | null; written: number | null }): Promise<EntryBatchRow> {
    await tx.query(
      `update machvon.ind_entry_batch set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_reason = $5, written_count = $6, version = version + 1, updated_at = $4::timestamptz where id = $1::uuid`,
      [batch.id, to, to === 'WITHDRAWN' ? null : actor, to === 'WITHDRAWN' ? null : now.toISOString(), extra.reason, extra.written],
    );
    return (await this.find(tx, batch.id, () => ({ sql: 'true', params: [] }))) as EntryBatchRow;
  }

  /** The preparer takes a batch that waits back (to WITHDRAWN); nobody else does. */
  async withdraw(tx: TenantTx, id: string, expectedVersion: number, actor: string, scope: ScopeBuilder, now: Date): Promise<EntryBatchRow> {
    const batch = await this.find(tx, id, scope, true);
    if (batch === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (batch.version !== expectedVersion) throw versionConflict(batch.version);
    if (batch.status !== 'SUBMITTED') throw stateInvalid(batch.status);
    if (batch.enteredBy !== actor) throw new DomainError('SCOPE_DENIED', 403);
    return this.move(tx, batch, 'WITHDRAWN', actor, now, { reason: null, written: null });
  }

  /** The decision of a checker on a batch that waits: accepted (with the number of figures written to the register) or returned (with the reason); never by the person who entered it (403 `SELF_APPROVAL_DENIED`). */
  async decide(tx: TenantTx, id: string, outcome: { kind: 'ACCEPTED'; written: number } | { kind: 'RETURNED'; reason: string }, actor: string, scope: ScopeBuilder, now: Date, expectedVersion?: number): Promise<{ before: EntryBatchRow; row: EntryBatchRow }> {
    const before = await this.find(tx, id, scope, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (expectedVersion !== undefined && before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.status !== 'SUBMITTED') throw stateInvalid(before.status);
    if (before.enteredBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const row = await this.move(tx, before, outcome.kind, actor, now, outcome.kind === 'ACCEPTED' ? { reason: null, written: outcome.written } : { reason: outcome.reason, written: null });
    return { before, row };
  }
}
