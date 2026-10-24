import { randomUUID } from 'node:crypto';
import { DomainError, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { AuditEntry } from './audit-writer.ts';
import { MasterRules } from './master-rules.ts';
import type { RuleReading } from './master-rules.ts';
import type { OutboxEventInput } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';
const MAX_CALENDAR_CODE = 50;
const FIRST_YEAR = 1970;
const LAST_YEAR = 9999;

/** The resource type of the audit rows and the events of a period. */
export const PERIOD_RESOURCE = 'reporting_period';
/** The calendar that the reporting calendar of MDM-11 holds: the rule port reads this key and no other (ST-MDM-004). */
export const REPORTING_CALENDAR_CODE = 'DEFAULT';
/**
 * The working calendar (ADM-07) that counts the working days between the deadline of a period and its lock. D03 assumption: the lock comes
 * three working days after the deadline (DIS 3 F4); the days are counted on this calendar, and a year without a published version is
 * refused rather than guessed.
 */
export const PERIOD_WORKING_CALENDAR = 'WORKDAY_VN';
export const DEFAULT_LOCK_AFTER_WORKING_DAYS = 3;
/** The metric of a submission and its base labels (DIS 9): the submit story counts with `submitLabels`. */
export const DIS_SUBMIT_METRIC = 'dis_submit_total';
export const submitLabels = (late: boolean): { late: string } => ({ late: late ? 'true' : 'false' });
/** The metric of a move of a period, counted by the command and by the job. */
export const DIS_PERIOD_TRANSITION_METRIC = 'dis_period_transition_total';

export const PERIOD_TYPES = ['WEEK', 'MONTH', 'QUARTER', 'HALF_YEAR', 'YEAR'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];
/** The types the reporting calendar can produce: it counts weeks; the other types wait for a rule of the business owner. */
const GENERATED_TYPES: ReadonlySet<PeriodType> = new Set(['WEEK']);
export type PeriodStatus = 'OPEN' | 'SOFT_CLOSED' | 'LOCKED';

export interface PeriodRow {
  id: string;
  code: string;
  calendarCode: string;
  periodType: PeriodType;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  /** The instant the report is due (UTC, `...Z`), by the calendar version the period is bound to. */
  deadlineAt: string;
  /** The revision of the calendar version, and the id of that version: lateness is judged by it for ever after. */
  calendarRevision: number;
  calendarVersionId: string;
  status: PeriodStatus;
  softClosedAt: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  version: number;
}

export type ReopenScopeKind = 'PERIOD' | 'PROJECTS';
export type ReopenStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CLOSED';

/** A project a reopening names: the code is what a person recognises it by. */
export interface ReopenProject {
  id: string;
  code: string;
}

/**
 * A request to reopen a locked period (ST-DIS-002). `status` is the effective one: an approved request whose window has ended is EXPIRED
 * from that instant, whether or not the job has stored it yet.
 */
export interface PeriodReopenRow {
  id: string;
  periodId: string;
  scopeKind: ReopenScopeKind;
  status: ReopenStatus;
  /** The end of the window that was granted; empty until the request is approved. */
  windowUntil: string | null;
  requestedAt: string;
  reason: string;
  requestedBy: string;
  requestedWindowHours: number;
  /** The approver (empty for a rejection and a request that waits), and when and why the decision was made. */
  approvedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  /** The projects of a request for projects, in the order of their codes; empty for a request for the whole period. */
  projects: ReopenProject[];
  version: number;
}

export interface PeriodFilter {
  fiscalYear?: number | undefined;
  status?: PeriodStatus | undefined;
  periodType?: PeriodType | undefined;
  calendarCode?: string | undefined;
}

export interface GenerateRequest {
  calendarCode: string;
  fiscalYear: number;
  periodType: PeriodType;
}

export interface GeneratedPeriods {
  periods: Array<{ id: string; code: string; startDate: string; endDate: string; deadlineAt: string }>;
  calendar: RuleReading;
}

/** How a submission to a period is judged: whether it is late by the calendar the period is bound to, and the deadline it was judged by. */
export interface SubmissionJudgement {
  period: PeriodRow;
  late: boolean;
  deadlineAt: string;
  /** The reopening that lets a locked period take this project's report, and the end of its window; empty when the period is not locked. */
  reopen: { id: string; windowUntil: string } | null;
}

interface SqlRow {
  id: string;
  code: string;
  calendar_code: string;
  period_type: PeriodType;
  fiscal_year: number;
  start_date: string;
  end_date: string;
  deadline_at: string;
  calendar_version: number;
  calendar_version_id: string;
  status: PeriodStatus;
  soft_closed_at: string | null;
  locked_at: string | null;
  locked_by: string | null;
  version: string;
}

export interface ReopenSqlRow {
  id: string;
  period_id: string;
  scope_kind: ReopenScopeKind;
  status: ReopenStatus;
  window_until: string | null;
  requested_at: string;
  reason: string;
  requested_by: string;
  requested_window_hours: number;
  approved_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  scope_project_ids: string[] | null;
  version: string;
}

/** The columns of a request as the store reads them, the status turned into EXPIRED once the window has ended (`$1` is the time of the read). */
export const REOPEN_SELECT = `select r.id, r.period_id, r.scope_kind,
  case when r.status = 'APPROVED' and r.window_until <= $1::timestamptz then 'EXPIRED' else r.status end as status,
  to_char(r.window_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as window_until,
  to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as requested_at,
  r.reason, r.requested_by, r.requested_window_hours, r.approved_by, r.decided_by,
  to_char(r.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as decided_at,
  r.decision_reason, r.scope_project_ids, r.version::text as version
  from machvon.period_reopen r`;

/** The requests with their projects named by code; a project that no longer resolves is left out rather than guessed. */
export async function readReopens(tx: TenantTx, rows: readonly ReopenSqlRow[]): Promise<PeriodReopenRow[]> {
  const ids = [...new Set(rows.flatMap((row) => row.scope_project_ids ?? []))];
  const codes = new Map<string, string>();
  if (ids.length > 0) {
    for (const project of await tx.query<{ id: string; code: string }>('select id, code from machvon.project where id = any($1::uuid[])', [ids])) codes.set(project.id, project.code);
  }
  return rows.map((row) => ({
    id: row.id,
    periodId: row.period_id,
    scopeKind: row.scope_kind,
    status: row.status,
    windowUntil: row.window_until,
    requestedAt: row.requested_at,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedWindowHours: row.requested_window_hours,
    approvedBy: row.approved_by,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    projects: (row.scope_project_ids ?? []).flatMap((id) => (codes.has(id) ? [{ id, code: codes.get(id) as string }] : [])).sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)),
    version: Number(row.version),
  }));
}

const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const SELECT = `select p.id, p.code, p.calendar_code, p.period_type, p.fiscal_year, p.start_date::text as start_date, p.end_date::text as end_date,
  ${iso('p.deadline_at')} as deadline_at, p.calendar_version, p.calendar_version_id, p.status, ${iso('p.soft_closed_at')} as soft_closed_at,
  ${iso('p.locked_at')} as locked_at, p.locked_by, p.version::text as version
  from machvon.reporting_period p`;

const toRow = (row: SqlRow): PeriodRow => ({
  id: row.id,
  code: row.code,
  calendarCode: row.calendar_code,
  periodType: row.period_type,
  fiscalYear: row.fiscal_year,
  startDate: row.start_date,
  endDate: row.end_date,
  deadlineAt: row.deadline_at,
  calendarRevision: row.calendar_version,
  calendarVersionId: row.calendar_version_id,
  status: row.status,
  softClosedAt: row.soft_closed_at,
  lockedAt: row.locked_at,
  lockedBy: row.locked_by,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The latest of the day of the request and the first day of the year: the calendar a year is generated from is the one in force when it begins, or today. */
function calendarDateFor(year: number, now: Date): string {
  const today = vietnamDateOf(now);
  const january = `${String(year).padStart(4, '0')}-01-01`;
  return today > january ? today : january;
}

/**
 * The reporting periods (ST-DIS-001, DIS 3 F4). A period is generated from the reporting calendar in force (the rule port of MDM-11) and
 * keeps the version of that calendar for good: its deadline, and so whether a report is late (BR-DIS-09), never moves when a newer calendar
 * is published. `status` is the one source of truth: OPEN, SOFT_CLOSED (reports are still taken and are late) and LOCKED (none is taken);
 * the table refuses any other move, and a locked period is reopened by a period_reopen for a scope, never by changing the period.
 */
export class DisPeriodStore {
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<PeriodRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where p.id = $1::uuid${lock ? ' for update of p' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The periods of the tenant, the latest first, by year, status, type and calendar. */
  async list(tx: TenantTx, filter: PeriodFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<PeriodRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ($1::int is null or p.fiscal_year = $1::int) and ($2::text is null or p.status = $2) and ($3::text is null or p.period_type = $3)
          and ($4::text is null or p.calendar_code = $4)
          and ($5::date is null or (p.start_date, p.id) < ($5::date, $6::uuid))
        order by p.start_date desc, p.id desc limit $7`,
      [filter.fiscalYear ?? null, filter.status ?? null, filter.periodType ?? null, filter.calendarCode ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** The requests to reopen the periods, oldest first: the history that DIS-14 and DIS-22 show next to the status. Their status is judged at `now`. */
  async reopens(tx: TenantTx, periodIds: readonly string[], now: Date): Promise<Map<string, PeriodReopenRow[]>> {
    const byPeriod = new Map<string, PeriodReopenRow[]>();
    if (periodIds.length === 0) return byPeriod;
    const rows = await tx.query<ReopenSqlRow>(`${REOPEN_SELECT} where r.period_id = any($2::uuid[]) order by r.created_at, r.id`, [now.toISOString(), [...periodIds]]);
    for (const entry of await readReopens(tx, rows)) byPeriod.set(entry.periodId, [...(byPeriod.get(entry.periodId) ?? []), entry]);
    return byPeriod;
  }

  /**
   * Generates the periods of a fiscal year from the reporting calendar in force, all or none: a year that overlaps a period that exists
   * (the same calendar and type) is 409 PERIOD_OVERLAP and writes nothing, so generating a year twice is refused the second time. The
   * calendar is the one in force on the later of today and 1 January of the year; every period keeps its id and revision.
   */
  async generate(tx: TenantTx, request: GenerateRequest, actor: string, now: Date): Promise<GeneratedPeriods> {
    const calendarCode = request.calendarCode.trim();
    if (calendarCode === '' || calendarCode.length > MAX_CALENDAR_CODE) throw invalid('calendar_code');
    if (!Number.isInteger(request.fiscalYear) || request.fiscalYear < FIRST_YEAR || request.fiscalYear > LAST_YEAR) throw invalid('fiscal_year');
    if (!GENERATED_TYPES.has(request.periodType)) throw invalid('period_type');
    // MDM-11 keeps one reporting calendar; a code it does not hold has no version in force.
    if (calendarCode !== REPORTING_CALENDAR_CODE) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
    const generated = await this.rules.calendarPeriods(tx, request.fiscalYear, calendarDateFor(request.fiscalYear, now));
    if (generated === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
    const { periods, reading } = generated;
    const overlap = await tx.query(
      `select 1 from machvon.reporting_period p
         join unnest($3::date[], $4::date[]) as n(starts_on, ends_on) on daterange(p.start_date, p.end_date, '[]') && daterange(n.starts_on, n.ends_on, '[]')
        where p.calendar_code = $1 and p.period_type = $2 limit 1`,
      [calendarCode, request.periodType, periods.map((period) => period.startsOn), periods.map((period) => period.endsOn)],
    );
    if (overlap.length > 0) throw new DomainError('PERIOD_OVERLAP', 409, 'fiscal_year');
    const ids = periods.map(() => randomUUID());
    try {
      await tx.query(
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, n.id, n.code, $1::int, n.starts_on, n.ends_on, n.deadline_at, $2, $3, $4::int, 'OPEN', $5::uuid, $6::uuid, $6::uuid
           from unnest($7::uuid[], $8::text[], $9::date[], $10::date[], $11::timestamptz[]) as n(id, code, starts_on, ends_on, deadline_at)`,
        [
          reading.revision,
          calendarCode,
          request.periodType,
          request.fiscalYear,
          reading.versionId,
          actor,
          ids,
          periods.map((period) => period.code),
          periods.map((period) => period.startsOn),
          periods.map((period) => period.endsOn),
          periods.map((period) => period.deadlineAt),
        ],
      );
    } catch (error) {
      // A period generated by a command that ran at the same moment: the table has the last word on overlap and on the code.
      const code = (error as { code?: string }).code;
      if (code === EXCLUSION_VIOLATION || code === UNIQUE_VIOLATION) throw new DomainError('PERIOD_OVERLAP', 409, 'fiscal_year');
      throw error;
    }
    return {
      periods: periods.map((period, index) => ({ id: ids[index] as string, code: period.code, startDate: period.startsOn, endDate: period.endsOn, deadlineAt: period.deadlineAt })),
      calendar: reading,
    };
  }

  /**
   * OPEN to SOFT_CLOSED. Allowed only after the deadline of the period: before it the reports are not late and the period is not closed
   * to anything. Reports are still taken afterwards, and are marked late.
   */
  async softClose(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<PeriodRow> {
    const row = await this.lockForMove(tx, id, expectedVersion, 'OPEN');
    if (now.getTime() < Date.parse(row.deadlineAt)) throw new DomainError('PERIOD_STATE_INVALID', 409, 'deadline_at');
    await tx.query(
      `update machvon.reporting_period set status = 'SOFT_CLOSED', soft_closed_at = $2::timestamptz, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, now.toISOString(), actor],
    );
    return this.reloaded(tx, id);
  }

  /** SOFT_CLOSED to LOCKED: no report is taken afterwards, except under a reopening for its scope (ST-DIS-002). */
  async lock(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<PeriodRow> {
    await this.lockForMove(tx, id, expectedVersion, 'SOFT_CLOSED');
    await tx.query(
      `update machvon.reporting_period set status = 'LOCKED', locked_at = $2::timestamptz, locked_by = $3::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, now.toISOString(), actor],
    );
    return this.reloaded(tx, id);
  }

  /**
   * The periods that are not locked and whose deadline has passed, oldest first, locked for update so that a command that is acting on
   * one at the moment is not overtaken (its row is left to the next run). This is the work of the job `dis.period-autoclose`.
   */
  async pastDeadline(tx: TenantTx, now: Date): Promise<PeriodRow[]> {
    const rows = await tx.query<SqlRow>(`${SELECT} where p.status <> 'LOCKED' and p.deadline_at <= $1::timestamptz order by p.deadline_at, p.id for update of p skip locked`, [now.toISOString()]);
    return rows.map(toRow);
  }

  /**
   * Whether a report handed in at `at` is late for a period: by the deadline of the calendar version the period is bound to, never by the
   * calendar in force today (BR-DIS-09). A locked period takes nothing (409 PERIOD_LOCKED) unless a reopening (ST-DIS-002) that was approved
   * names the project, or the whole period, and its window is open at `at`: the window is judged by the time alone, so it ends on time
   * whether or not the job that stores the expiry has run, and it covers only the scope that was approved. A report handed in under a
   * reopening is late, as the period is past its deadline.
   */
  async judge(tx: TenantTx, periodId: string, projectId: string, at: Date): Promise<SubmissionJudgement> {
    const period = await this.find(tx, periodId);
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const reopen = period.status === 'LOCKED' ? await this.openWindow(tx, periodId, projectId, at) : null;
    if (period.status === 'LOCKED' && reopen === null) throw new DomainError('PERIOD_LOCKED', 409);
    const bound = { calendarVersionId: period.calendarVersionId, startsOn: period.startDate };
    const deadlineAt = await this.rules.boundDeadline(tx, bound);
    return { period, late: await this.rules.isLate(tx, bound, at), deadlineAt, reopen };
  }

  /** The approved reopening whose window is open at `at` and covers the project (the latest to end when several do); empty when none does. */
  private async openWindow(tx: TenantTx, periodId: string, projectId: string, at: Date): Promise<{ id: string; windowUntil: string } | null> {
    const rows = await tx.query<{ id: string; window_until: string }>(
      `select r.id, ${iso('r.window_until')} as window_until from machvon.period_reopen r
        where r.period_id = $1::uuid and r.status = 'APPROVED' and r.decided_at <= $3::timestamptz and r.window_until > $3::timestamptz
          and (r.scope_kind = 'PERIOD' or $2::uuid = any(r.scope_project_ids))
        order by r.window_until desc, r.id limit 1`,
      [periodId, projectId, at.toISOString()],
    );
    return rows[0] === undefined ? null : { id: rows[0].id, windowUntil: rows[0].window_until };
  }

  private async lockForMove(tx: TenantTx, id: string, expectedVersion: number, from: PeriodStatus): Promise<PeriodRow> {
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    if (row.status !== from) throw new DomainError('PERIOD_STATE_INVALID', 409, 'status');
    return row;
  }

  private async reloaded(tx: TenantTx, id: string): Promise<PeriodRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new Error('the period vanished after its update');
    return row;
  }
}

export type PeriodMove = 'soft_close' | 'lock';
/** Who moved the period: a person's command, or the job that closes and locks by the calendar. */
export type PeriodTrigger = 'MANUAL' | 'AUTO';

export const transitionLabels = (move: PeriodMove, trigger: PeriodTrigger): { to: string; trigger: string } => ({ to: move === 'soft_close' ? 'soft_closed' : 'locked', trigger: trigger.toLowerCase() });

export interface PeriodMoveRecord {
  audit: Omit<AuditEntry, 'correlationId' | 'requestId'>;
  event: Omit<OutboxEventInput, 'correlationId'>;
}

/**
 * The audit row and the event of a move of a period, built once for the command and for the job so that the two leave the same trace
 * (DIS 3 F4: the events `period.soft_closed.v1` and `period.locked.v1`). `row` is the period after the move.
 */
export function periodMoveRecord(move: PeriodMove, row: PeriodRow, reason: string, trigger: PeriodTrigger): PeriodMoveRecord {
  const closed = move === 'soft_close';
  const type = closed ? 'period.soft_closed.v1' : 'period.locked.v1';
  return {
    audit: {
      action: closed ? 'dis.period_soft_closed' : 'dis.period_locked',
      resourceType: PERIOD_RESOURCE,
      resourceId: row.id,
      reason,
      diff: { code: row.code, calendar_code: row.calendarCode, period_type: row.periodType, status: row.status, deadline_at: row.deadlineAt, calendar_version_id: row.calendarVersionId, trigger },
    },
    event: {
      aggregateType: PERIOD_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: {
        period_id: row.id,
        code: row.code,
        calendar_code: row.calendarCode,
        period_type: row.periodType,
        fiscal_year: row.fiscalYear,
        status: row.status,
        deadline_at: row.deadlineAt,
        soft_closed_at: row.softClosedAt,
        locked_at: row.lockedAt,
        trigger,
      },
      eventKey: `${PERIOD_RESOURCE}:${row.id}:${row.version}`,
    },
  };
}
