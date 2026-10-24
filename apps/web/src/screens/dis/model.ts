import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

/** Soft close and generation (IAM scope: the whole tenant). */
export const PERIOD_MANAGE_PERMISSION = 'period.manage';
/** Lock is a permission of its own: the person who may close a period may not lock it unless the role says so. */
export const PERIOD_LOCK_PERMISSION = 'period.lock';

export const PERIOD_STATUSES = ['OPEN', 'SOFT_CLOSED', 'LOCKED'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
const REOPEN_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CLOSED'] as const;
export type ReopenStatus = (typeof REOPEN_STATUSES)[number];
const REOPEN_SCOPES = ['PERIOD', 'PROJECTS'] as const;
export type ReopenScope = (typeof REOPEN_SCOPES)[number];

export interface ReopenView {
  id: string;
  scopeKind: ReopenScope;
  status: ReopenStatus;
  windowUntil: string | null;
  requestedAt: string;
}

export interface PeriodView {
  id: string;
  code: string;
  calendarCode: string;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  /** The instant the report is due, UTC. */
  deadlineAt: string;
  /** The revision of the calendar the period was generated from. */
  calendarRevision: number;
  status: PeriodStatus;
  softClosedAt: string | null;
  lockedAt: string | null;
  version: number;
  reopens: ReopenView[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((item) => item === value);

function toReopen(raw: unknown): ReopenView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const scopeKind = oneOf(REOPEN_SCOPES, row.scope_kind);
  const status = oneOf(REOPEN_STATUSES, row.status);
  const requestedAt = text(row.requested_at);
  if (id === undefined || scopeKind === undefined || status === undefined || requestedAt === undefined) return undefined;
  return { id, scopeKind, status, windowUntil: nullableText(row.window_until), requestedAt };
}

/** A period as the calendar answers it; a row that does not have the shape is dropped rather than shown half-filled. */
export function toPeriod(raw: unknown): PeriodView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const code = text(row.code);
  const calendarCode = text(row.calendar_code);
  const fiscalYear = whole(row.fiscal_year);
  const startDate = text(row.start_date);
  const endDate = text(row.end_date);
  const deadlineAt = text(row.deadline_at);
  const calendarRevision = whole(row.calendar_version);
  const status = oneOf(PERIOD_STATUSES, row.status);
  const version = whole(row.version);
  if (
    id === undefined || code === undefined || calendarCode === undefined || fiscalYear === undefined || startDate === undefined || endDate === undefined || deadlineAt === undefined ||
    calendarRevision === undefined || status === undefined || version === undefined
  ) {
    return undefined;
  }
  const reopens = Array.isArray(row.reopens) ? row.reopens.flatMap((item) => toReopen(item) ?? []) : [];
  return { id, code, calendarCode, fiscalYear, startDate, endDate, deadlineAt, calendarRevision, status, softClosedAt: nullableText(row.soft_closed_at), lockedAt: nullableText(row.locked_at), version, reopens };
}

/** The offset of Vietnam from UTC in minutes: the calendar of DIS counts days and deadlines in this zone and it has no daylight saving. */
const VIETNAM_OFFSET_MINUTES = 7 * 60;
const MS_PER_MINUTE = 60_000;

/** A UTC instant as `YYYY-MM-DD HH:mm` in Vietnam time (the columns say UTC+7); anything that is not an instant is shown as it came. */
export function vietnamMoment(instant: string): string {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return instant;
  return new Date(time + VIETNAM_OFFSET_MINUTES * MS_PER_MINUTE).toISOString().slice(0, 16).replace('T', ' ');
}

export const hasPassed = (period: Pick<PeriodView, 'deadlineAt'>, now: number): boolean => now >= Date.parse(period.deadlineAt);

export type PeriodMove = 'softClose' | 'lock';

export interface ActionRights {
  /** The caller holds period.manage. */
  manage: boolean;
  /** The caller holds period.lock. */
  lock: boolean;
}

/**
 * The move a person may make on a period now: a soft close needs period.manage, an OPEN period and a deadline that has passed (the server
 * refuses it before); a lock needs period.lock and a soft-closed period. A locked period offers nothing: it is reopened by a request.
 */
export function movesOf(period: PeriodView, rights: ActionRights, now: number): PeriodMove[] {
  const moves: PeriodMove[] = [];
  if (rights.manage && period.status === 'OPEN' && hasPassed(period, now)) moves.push('softClose');
  if (rights.lock && period.status === 'SOFT_CLOSED') moves.push('lock');
  return moves;
}

/** The fiscal years of the periods, the latest first, always including `current` so a tenant with no period can generate this year. */
export function yearsOf(periods: readonly PeriodView[], current: number): number[] {
  return [...new Set([...periods.map((period) => period.fiscalYear), current])].sort((left, right) => right - left);
}

/** The periods of a year (and a status when one is chosen), in calendar order. */
export function periodsOf(periods: readonly PeriodView[], year: number, status: PeriodStatus | ''): PeriodView[] {
  return periods
    .filter((period) => period.fiscalYear === year && (status === '' || period.status === status))
    .sort((left, right) => (left.startDate < right.startDate ? -1 : left.startDate > right.startDate ? 1 : 0));
}

/** How many periods of a year are in each status, for the line above the table. */
export function countsOf(periods: readonly PeriodView[], year: number): Record<PeriodStatus, number> {
  const counts: Record<PeriodStatus, number> = { OPEN: 0, SOFT_CLOSED: 0, LOCKED: 0 };
  for (const period of periods) if (period.fiscalYear === year) counts[period.status] += 1;
  return counts;
}

// ---- forms ----------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidYear';

export const MIN_REASON_LENGTH = 5;
export const MAX_REASON_LENGTH = 2000;
export const FIRST_YEAR = 2000;
export const LAST_YEAR = 2100;
const YEAR_TEXT = /^\d{4}$/;

/** The reason of a soft close or a lock: the audit trail keeps it, so it is never empty. */
export function validateReason(value: string): FieldProblem | undefined {
  const reason = value.trim();
  if (reason === '') return 'required';
  if (reason.length < MIN_REASON_LENGTH) return 'tooShort';
  return reason.length > MAX_REASON_LENGTH ? 'tooLong' : undefined;
}

/** The fiscal year to generate: four digits within the years the calendar is kept for. */
export function validateYear(value: string): FieldProblem | undefined {
  const year = value.trim();
  if (year === '') return 'required';
  if (!YEAR_TEXT.test(year)) return 'invalidYear';
  return Number(year) < FIRST_YEAR || Number(year) > LAST_YEAR ? 'invalidYear' : undefined;
}

export type GenerateBody = components['schemas']['DisPeriodGenerate'];

/** Only weeks are generated: the reporting calendar counts weeks, and the other period types wait for a rule of the business owner. */
export const generateBody = (year: number): GenerateBody => ({ calendar_code: 'DEFAULT', fiscal_year: year, period_type: 'WEEK' });

// ---- refusals -------------------------------------------------------------------------------------------------------

export type ProblemReason = 'overlap' | 'noCalendar' | 'beforeDeadline' | 'stateInvalid' | 'versionConflict' | 'notFound' | 'validation' | 'denied' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  PERIOD_OVERLAP: 'overlap',
  CALENDAR_NOT_EFFECTIVE: 'noCalendar',
  PERIOD_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

/** Maps the error of a command of this screen to what it shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemReason {
  if (!(error instanceof ApiError)) return 'general';
  // A soft close before the deadline is told apart from a period that is no longer in the state the screen showed.
  if (error.code === 'PERIOD_STATE_INVALID' && error.detail === 'deadline_at') return 'beforeDeadline';
  return REASON_BY_CODE[error.code] ?? 'general';
}
