import { randomUUID } from 'node:crypto';
import { CLOSE_TARGETS, DomainError, MAX_CLOSE_REASON, MIN_CLOSE_REASON, MIN_REOPEN_REASON, addDecimal, closeAllowed, reopenIssues, reopenedUntil, versionConflict } from '@machvon/kernel';
import type { CloseTarget, YearStatus } from '@machvon/kernel';
import { BalanceDriftError, CapPlanPublicationStore } from './cap-plan-publication-store.ts';
import { debitBalance, lockLedgerRows } from './ledger-lock.ts';
import type { TenantTx } from './tenant-database.ts';

export interface FiscalYearRow {
  /** Null for a year the control does not know yet. */
  id: string | null;
  year: number;
  status: YearStatus;
  /** A year without a control row is open and has version 1 (the first change creates the row). */
  version: number;
  softClosedAt: string | null;
  softClosedBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  closeReason: string | null;
  reopenReason: string | null;
  reopenedAt: string | null;
  reopenedUntil: string | null;
  reopenApprovedBy: string | null;
  /** The reference the LAPSE entries of the last locking carry (`source_ref_id` of kind YEAR_CLOSE). */
  lockRefId: string | null;
}

/** What locking a year did to the capital that was not carried over: the lines it lapsed, the total, and the requests to carry capital over that could no longer be decided. */
export interface LapseSummary {
  refId: string;
  lines: number;
  totalVnd: string;
  extensionsLapsed: number;
  entryIds: string[];
}

export interface CloseYearInput {
  year: number;
  target: string;
  reason: string;
  closedBy: string;
  expectedVersion: number;
}

export interface ClosedYear {
  row: FiscalYearRow;
  previous: YearStatus;
  /** Present when the year was locked. */
  lapse: LapseSummary | undefined;
}

export interface ReopenYearInput {
  year: number;
  reason: string;
  windowHours: number;
  reopenedBy: string;
  expectedVersion: number;
}

export interface RelockOutcome {
  years: number[];
  lapsedVnd: string;
}

interface SqlRow {
  id: string;
  plan_year: number;
  status: YearStatus;
  version: string;
  soft_closed_at: string | null;
  soft_closed_by: string | null;
  locked_at: string | null;
  locked_by: string | null;
  close_reason: string | null;
  reopen_reason: string | null;
  reopened_at: string | null;
  reopened_until: string | null;
  reopen_approved_by: string | null;
  lock_ref_id: string | null;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const COLUMNS = `id, plan_year, status, version::text as version, to_char(soft_closed_at at time zone 'UTC', ${ISO}) as soft_closed_at, soft_closed_by,
  to_char(locked_at at time zone 'UTC', ${ISO}) as locked_at, locked_by, close_reason, reopen_reason, to_char(reopened_at at time zone 'UTC', ${ISO}) as reopened_at,
  to_char(reopened_until at time zone 'UTC', ${ISO}) as reopened_until, reopen_approved_by, lock_ref_id`;

const toRow = (row: SqlRow): FiscalYearRow => ({
  id: row.id,
  year: row.plan_year,
  status: row.status,
  version: Number(row.version),
  softClosedAt: row.soft_closed_at,
  softClosedBy: row.soft_closed_by,
  lockedAt: row.locked_at,
  lockedBy: row.locked_by,
  closeReason: row.close_reason,
  reopenReason: row.reopen_reason,
  reopenedAt: row.reopened_at,
  reopenedUntil: row.reopened_until,
  reopenApprovedBy: row.reopen_approved_by,
  lockRefId: row.lock_ref_id,
});

const OPEN_VERSION = 1;
const RELOCK_REASON = 'The window of the reopening ended';
const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? {} : { extensions: { reason } });
const stateInvalid = (reason: string, extra: Record<string, unknown> = {}): DomainError => new DomainError('YEAR_STATE_INVALID', 409, 'status', { extensions: { reason, ...extra } });

/**
 * The closing of a fiscal year of the capital plan (ST-CAP-008, CAP 3.1 F6, BR-CAP-04). A year without a control row is open. A year is soft-closed when its adjustment period begins
 * (from then on it takes no plan command, no appropriation, no reservation and no commitment, only what carries capital out of it or pays it), and locked when the adjustment period
 * ends: locking lapses the capital that was not carried over, as LAPSE entries of one closing against the lines of the year and the balances that hold them (allocated less committed and
 * disbursed), and ends the requests to carry capital over that nobody decided. Neither close is made while a plan of the year waits for a decision or for its publication, and locking is not
 * made while a reservation of the year is active. A locked year is reopened by someone other than the person who locked it, for a reason and a window of at most a week, and is locked
 * again when the window ends (`relockDue`, the job). Every move compares the ledger with the balances before the transaction ends.
 */
export class CapFiscalYearStore {
  private readonly publication: CapPlanPublicationStore;

  constructor(publication: CapPlanPublicationStore = new CapPlanPublicationStore()) {
    this.publication = publication;
  }

  /** The years the control knows, the latest first. A year it does not list is open. */
  async list(tx: TenantTx): Promise<FiscalYearRow[]> {
    const rows = await tx.query<SqlRow>(`select ${COLUMNS} from machvon.fiscal_year_control order by plan_year desc`);
    return rows.map(toRow);
  }

  /** The state of one year; a year the control does not know is open with version 1. */
  async find(tx: TenantTx, year: number): Promise<FiscalYearRow> {
    const [row] = await tx.query<SqlRow>(`select ${COLUMNS} from machvon.fiscal_year_control where plan_year = $1::integer`, [year]);
    return row === undefined ? this.openYear(year) : toRow(row);
  }

  /**
   * Closes a year to `target`. 422 VALIDATION_FAILED for a target or a reason that is not one (5 to 2000 characters), 409 VERSION_CONFLICT for a stale version, 409 YEAR_STATE_INVALID
   * (`reason`: ALREADY_SOFT_CLOSED, ALREADY_LOCKED, PLANS_PENDING with the plans, RESERVATIONS_ACTIVE) when the year cannot be taken there.
   */
  async close(tx: TenantTx, input: CloseYearInput, now: Date = new Date()): Promise<ClosedYear> {
    this.assertYear(input.year);
    if (!(CLOSE_TARGETS as readonly string[]).includes(input.target)) throw invalid('target_status');
    const target = input.target as CloseTarget;
    const reason = input.reason.trim();
    if (reason.length < MIN_CLOSE_REASON || reason.length > MAX_CLOSE_REASON) throw invalid('reason', 'REASON_LENGTH');

    const current = await this.lock(tx, input.year, input.closedBy);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version, { status: current.status });
    if (!closeAllowed(current.status, target)) throw stateInvalid(current.status === 'LOCKED' ? 'ALREADY_LOCKED' : 'ALREADY_SOFT_CLOSED');
    await this.assertNoPendingPlans(tx, input.year);

    if (target === 'SOFT_CLOSED') {
      const row = await this.settle(tx, input.year, "status = 'SOFT_CLOSED', soft_closed_at = $2::timestamptz, soft_closed_by = $3::uuid, close_reason = $4, updated_by = $3::uuid", [now, input.closedBy, reason]);
      return { row, previous: current.status, lapse: undefined };
    }
    await this.assertNoActiveReservations(tx, input.year);
    return this.lockYear(tx, input.year, current.status, reason, input.closedBy, now);
  }

  /**
   * Reopens a locked year for `windowHours`. 422 REOPEN_REASON_REQUIRED for a reason under 20 characters, 422 VALIDATION_FAILED for a window outside 1 to 168 hours, 409 VERSION_CONFLICT
   * for a stale version, 409 YEAR_STATE_INVALID for a year that is not locked, 403 SELF_APPROVAL_DENIED for the person who locked it (the database refuses the same).
   */
  async reopen(tx: TenantTx, input: ReopenYearInput, now: Date = new Date()): Promise<FiscalYearRow> {
    this.assertYear(input.year);
    const issues = reopenIssues({ reason: input.reason, windowHours: input.windowHours });
    const reasonIssue = issues.find((issue) => issue.field === 'reason');
    if (reasonIssue !== undefined) throw new DomainError('REOPEN_REASON_REQUIRED', 422, 'reason', { extensions: { min_length: MIN_REOPEN_REASON } });
    if (issues.length > 0) throw invalid('window_hours', 'WINDOW_INVALID');

    const [locked] = await tx.query<SqlRow>(`select ${COLUMNS} from machvon.fiscal_year_control where plan_year = $1::integer for update`, [input.year]);
    const current = locked === undefined ? this.openYear(input.year) : toRow(locked);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version, { status: current.status });
    if (current.status !== 'LOCKED') throw stateInvalid('NOT_LOCKED');
    if (current.lockedBy !== null && current.lockedBy.toLowerCase() === input.reopenedBy.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    return this.settle(
      tx,
      input.year,
      "status = 'OPEN', locked_at = null, reopen_reason = $2, reopened_at = $3::timestamptz, reopened_until = $4::timestamptz, reopen_approved_by = $5::uuid, updated_by = $5::uuid",
      [input.reason.trim(), now, reopenedUntil(now, input.windowHours), input.reopenedBy],
    );
  }

  /**
   * Locks again the years whose reopening has ended (the job every 15 minutes): the capital that came back during the window and was not carried over lapses again. Returns the years
   * and what lapsed. The pass is idempotent: a year that is locked is not touched.
   */
  async relockDue(tx: TenantTx, now: Date, actor: string): Promise<RelockOutcome> {
    const due = await tx.query<{ plan_year: number }>("select plan_year from machvon.fiscal_year_control where status = 'OPEN' and reopened_until is not null and reopened_until <= $1::timestamptz order by plan_year for update", [now]);
    let lapsed = '0';
    const years: number[] = [];
    for (const { plan_year: year } of due) {
      const closed = await this.lockYear(tx, year, 'OPEN', RELOCK_REASON, actor, now);
      lapsed = addDecimal(lapsed, closed.lapse?.totalVnd ?? '0');
      years.push(year);
    }
    return { years, lapsedVnd: lapsed };
  }

  // ---- locking ---------------------------------------------------------------------------------------------------------------------

  private async lockYear(tx: TenantTx, year: number, previous: YearStatus, reason: string, actor: string, now: Date): Promise<ClosedYear> {
    const refId = randomUUID();
    const lapse = await this.lapse(tx, year, refId, actor);
    const row = await this.settle(tx, year, "status = 'LOCKED', locked_at = $2::timestamptz, locked_by = $3::uuid, close_reason = $4, lock_ref_id = $5::uuid, updated_by = $3::uuid", [now, actor, reason, refId]);
    return { row, previous, lapse };
  }

  /**
   * Lapses the capital of the year that was not carried over: for every line in force of a published annual plan of the year, what is allocated less committed and disbursed becomes a
   * LAPSE entry of this closing and leaves the balance. The balances are locked in the one lock order and read under the lock; the ledger is compared with the balances before the
   * transaction goes on.
   */
  private async lapse(tx: TenantTx, year: number, refId: string, actor: string): Promise<LapseSummary> {
    const found = await tx.query<{ balance_id: string }>(
      `select b.id as balance_id
         from machvon.allocation_balance b
         join machvon.allocation_line l on l.tenant_id = b.tenant_id and l.id = b.allocation_line_id
         join machvon.plan_version pv on pv.tenant_id = l.tenant_id and pv.id = l.plan_version_id
         join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
        where cp.plan_kind = 'ANNUAL' and cp.plan_year = $1::integer and cp.status = 'PUBLISHED' and l.project_id is not null and l.appropriation_id is not null
        order by b.id`,
      [year],
    );
    await lockLedgerRows(tx, found.map((row) => ({ table: 'allocation_balance', id: row.balance_id })));
    const free = await tx.query<{ balance_id: string; line_id: string; project_id: string; appropriation_id: string; free_vnd: string }>(
      `select b.id as balance_id, l.id as line_id, l.project_id, l.appropriation_id, (b.allocated_vnd - b.committed_vnd - b.disbursed_vnd)::text as free_vnd
         from machvon.allocation_balance b join machvon.allocation_line l on l.tenant_id = b.tenant_id and l.id = b.allocation_line_id
        where b.id = any($1::uuid[]) and b.allocated_vnd - b.committed_vnd - b.disbursed_vnd > 0 order by b.id`,
      [found.map((row) => row.balance_id)],
    );
    let total = '0';
    const entryIds: string[] = [];
    const projects = new Set<string>();
    for (const line of free) {
      await debitBalance(tx, { table: 'allocation_balance', id: line.balance_id, column: 'allocated_vnd' }, line.free_vnd);
      const entryId = randomUUID();
      await tx.query(
        `insert into machvon.capital_ledger_entry
           (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reason, posted_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'LAPSE', $5::numeric, $6::integer, 'YEAR_CLOSE', $7::uuid, 'UNEXTENDED', $8::uuid)`,
        [entryId, line.appropriation_id, line.line_id, line.project_id, line.free_vnd, year, refId, actor],
      );
      entryIds.push(entryId);
      projects.add(line.project_id);
      total = addDecimal(total, line.free_vnd);
    }
    // A request to carry capital over that nobody decided cannot be decided once the year is locked.
    const ended = await tx.query(
      "update machvon.allocation_extension set status = 'LAPSED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where from_plan_year = $1::integer and status in ('REQUESTED', 'APPROVED') returning id",
      [year, actor],
    );
    if (projects.size > 0) {
      const drift = await this.publication.balanceDrift(tx, [...projects]);
      if (drift.length > 0) throw new BalanceDriftError(drift);
    }
    return { refId, lines: free.length, totalVnd: total, extensionsLapsed: ended.length, entryIds };
  }

  // ---- reading and guarding --------------------------------------------------------------------------------------------------------

  /** The row of the year under the lock, created open (version 1) when the control does not know the year yet. */
  private async lock(tx: TenantTx, year: number, actor: string): Promise<FiscalYearRow> {
    await tx.query(
      `insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::integer, 'OPEN', $3::uuid, $3::uuid, ${OPEN_VERSION}) on conflict (tenant_id, plan_year) do nothing`,
      [randomUUID(), year, actor],
    );
    const [row] = await tx.query<SqlRow>(`select ${COLUMNS} from machvon.fiscal_year_control where plan_year = $1::integer for update`, [year]);
    if (row === undefined) throw new Error('the fiscal year control was not created');
    return toRow(row);
  }

  private async settle(tx: TenantTx, year: number, assignments: string, params: unknown[]): Promise<FiscalYearRow> {
    const [row] = await tx.query<SqlRow>(
      `update machvon.fiscal_year_control set ${assignments}, updated_at = now(), version = version + 1 where plan_year = $1::integer returning ${COLUMNS}`,
      [year, ...params],
    );
    if (row === undefined) throw new Error('fiscal year update returned no row');
    return toRow(row);
  }

  private async assertNoPendingPlans(tx: TenantTx, year: number): Promise<void> {
    const pending = await tx.query<{ id: string }>("select id from machvon.capital_plan where plan_kind = 'ANNUAL' and plan_year = $1::integer and status in ('IN_REVIEW', 'APPROVED') order by id", [year]);
    if (pending.length > 0) throw stateInvalid('PLANS_PENDING', { plan_ids: pending.map((plan) => plan.id) });
  }

  private async assertNoActiveReservations(tx: TenantTx, year: number): Promise<void> {
    const active = await tx.query<{ id: string }>(
      `select r.id from machvon.fund_reservation r
         join machvon.allocation_line l on l.tenant_id = r.tenant_id and l.id = r.allocation_line_id
         join machvon.plan_version pv on pv.tenant_id = l.tenant_id and pv.id = l.plan_version_id
         join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
        where r.status = 'ACTIVE' and cp.plan_kind = 'ANNUAL' and cp.plan_year = $1::integer and cp.status = 'PUBLISHED' order by r.id`,
      [year],
    );
    if (active.length > 0) throw stateInvalid('RESERVATIONS_ACTIVE', { reservation_ids: active.map((reservation) => reservation.id) });
  }

  private assertYear(year: number): void {
    if (!Number.isInteger(year) || year < 1990 || year > 2100) throw invalid('year');
  }

  private openYear(year: number): FiscalYearRow {
    return {
      id: null,
      year,
      status: 'OPEN',
      version: OPEN_VERSION,
      softClosedAt: null,
      softClosedBy: null,
      lockedAt: null,
      lockedBy: null,
      closeReason: null,
      reopenReason: null,
      reopenedAt: null,
      reopenedUntil: null,
      reopenApprovedBy: null,
      lockRefId: null,
    };
  }
}
