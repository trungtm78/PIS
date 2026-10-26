import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

/** A maker asks for a locked period to be reopened (IAM scope: the units of the requester, the whole tenant for the whole period). */
export const REOPEN_REQUEST_PERMISSION = 'period.reopen.request';
/** An approver other than the requester decides (IAM scope: the whole tenant). */
export const REOPEN_APPROVE_PERMISSION = 'period.reopen.approve';
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

/** A project a reopening names. */
export interface ProjectChip {
  id: string;
  code: string;
}

/** What the server tells the requester and the approvers about a request, and nobody else: the reason, the people, the hours and the projects. */
export interface ReopenDetail {
  version: number;
  reason: string;
  requestedBy: string;
  requestedWindowHours: number;
  approvedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  projects: ProjectChip[];
}

export interface ReopenView {
  id: string;
  scopeKind: ReopenScope;
  /** The status the server judged at the time of the read; an approved window that has ended since is told by `effectiveStatus`. */
  status: ReopenStatus;
  windowUntil: string | null;
  requestedAt: string;
  detail: ReopenDetail | null;
}

export interface PeriodView {
  id: string;
  code: string;
  calendarCode: string;
  /** WEEK, MONTH and the others the calendar can produce. */
  periodType: string;
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

function toProjects(value: unknown): ProjectChip[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const row = asRecord(item);
        const id = text(row?.id);
        const code = text(row?.code);
        return id === undefined || code === undefined ? [] : [{ id, code }];
      })
    : [];
}

function toDetail(row: Record<string, unknown>): ReopenDetail | null {
  const version = whole(row.version);
  const reason = text(row.reason);
  const requestedBy = text(row.requested_by);
  const requestedWindowHours = whole(row.requested_window_hours);
  if (version === undefined || reason === undefined || requestedBy === undefined || requestedWindowHours === undefined) return null;
  return {
    version,
    reason,
    requestedBy,
    requestedWindowHours,
    approvedBy: nullableText(row.approved_by),
    decidedBy: nullableText(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    decisionReason: nullableText(row.decision_reason),
    projects: toProjects(row.projects),
  };
}

function toReopen(raw: unknown): ReopenView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const scopeKind = oneOf(REOPEN_SCOPES, row.scope_kind);
  const status = oneOf(REOPEN_STATUSES, row.status);
  const requestedAt = text(row.requested_at);
  if (id === undefined || scopeKind === undefined || status === undefined || requestedAt === undefined) return undefined;
  return { id, scopeKind, status, windowUntil: nullableText(row.window_until), requestedAt, detail: toDetail(row) };
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
  return { id, code, calendarCode, periodType: text(row.period_type) ?? '', fiscalYear, startDate, endDate, deadlineAt, calendarRevision, status, softClosedAt: nullableText(row.soft_closed_at), lockedAt: nullableText(row.locked_at), version, reopens };
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

// ---- reopening requests (DIS-22) ---------------------------------------------------------------------------------------

/** The status of a request now: an approved window that has ended is EXPIRED from its last instant, whether or not the server has stored it yet. */
export function effectiveStatus(reopen: Pick<ReopenView, 'status' | 'windowUntil'>, now: number): ReopenStatus {
  return reopen.status === 'APPROVED' && reopen.windowUntil !== null && now >= Date.parse(reopen.windowUntil) ? 'EXPIRED' : reopen.status;
}

/** Whether the window of a request is open now: the projects it names can be reported on until it ends. */
export const isWindowOpen = (reopen: Pick<ReopenView, 'status' | 'windowUntil'>, now: number): boolean => effectiveStatus(reopen, now) === 'APPROVED';

export interface ReopenRequestView {
  period: PeriodView;
  reopen: ReopenView;
}

const byRequestedAt = (left: ReopenRequestView, right: ReopenRequestView): number => (left.reopen.requestedAt < right.reopen.requestedAt ? -1 : left.reopen.requestedAt > right.reopen.requestedAt ? 1 : 0);

/** Every request of the periods: those that wait for a decision first, oldest first (the queue of the approver), then the decided ones, newest first. */
export function queueOf(periods: readonly PeriodView[]): ReopenRequestView[] {
  const all = periods.flatMap((period) => period.reopens.map((reopen) => ({ period, reopen })));
  const waiting = all.filter((item) => item.reopen.status === 'REQUESTED').sort(byRequestedAt);
  const decided = all.filter((item) => item.reopen.status !== 'REQUESTED').sort((left, right) => byRequestedAt(right, left));
  return [...waiting, ...decided];
}

/** The periods a request can be made for: only a locked period is reopened, the others still take reports. The latest first. */
export const lockedPeriods = (periods: readonly PeriodView[]): PeriodView[] =>
  periods.filter((period) => period.status === 'LOCKED').sort((left, right) => (left.startDate < right.startDate ? 1 : left.startDate > right.startDate ? -1 : 0));

export interface DecisionRights {
  /** The caller holds period.reopen.approve. */
  approve: boolean;
  /** The membership of the caller. */
  me: string | undefined;
}

export type DecisionOffer = { kind: 'none' } | { kind: 'allowed' } | { kind: 'own' };

/**
 * What an approver is offered for a request. Only a request that waits is decided; the one the caller made is shown with the action
 * disabled and the reason why (the separation rule: whoever asks does not decide), never hidden and never sent to be refused.
 */
export function decisionOffer(request: ReopenRequestView, rights: DecisionRights): DecisionOffer {
  const { reopen } = request;
  if (!rights.approve || reopen.detail === null || reopen.status !== 'REQUESTED') return { kind: 'none' };
  return reopen.detail.requestedBy === rights.me ? { kind: 'own' } : { kind: 'allowed' };
}

export const MIN_REOPEN_REASON_LENGTH = 20;
export const MIN_DECISION_REASON_LENGTH = 5;
export const MAX_WINDOW_HOURS = 168;
export const DEFAULT_WINDOW_HOURS = 24;
/** The most projects one request names (the contract keeps the same limit). */
export const MAX_REOPEN_PROJECTS = 500;
const WHOLE_NUMBER = /^\d+$/;

export type ReopenField = 'periodId' | 'projects' | 'reason' | 'windowHours';
export type ReopenFieldProblem = 'required' | 'tooShort' | 'tooLong' | 'tooMany' | 'invalidHours';

export interface ReopenForm {
  periodId: string;
  scope: ReopenScope;
  projectIds: readonly string[];
  reason: string;
  windowHours: string;
}

export const EMPTY_REOPEN_FORM: ReopenForm = { periodId: '', scope: 'PROJECTS', projectIds: [], reason: '', windowHours: String(DEFAULT_WINDOW_HOURS) };

/** The hours of a window: a whole number from 1 to 168. */
export function validateHours(value: string): ReopenFieldProblem | undefined {
  const hours = value.trim();
  if (hours === '') return 'required';
  return WHOLE_NUMBER.test(hours) && Number(hours) >= 1 && Number(hours) <= MAX_WINDOW_HOURS ? undefined : 'invalidHours';
}

/** The reason of a request: at least 20 characters once trimmed (the audit trail keeps it), and not longer than the contract allows. */
export function validateRequestReason(value: string): ReopenFieldProblem | undefined {
  const reason = value.trim();
  if (reason === '') return 'required';
  if (reason.length < MIN_REOPEN_REASON_LENGTH) return 'tooShort';
  return reason.length > MAX_REASON_LENGTH ? 'tooLong' : undefined;
}

/** The problems of a request form; an empty object means it can be sent. */
export function validateReopenForm(form: ReopenForm): Partial<Record<ReopenField, ReopenFieldProblem>> {
  const problems: Partial<Record<ReopenField, ReopenFieldProblem>> = {};
  if (form.periodId === '') problems.periodId = 'required';
  if (form.scope === 'PROJECTS' && form.projectIds.length === 0) problems.projects = 'required';
  if (form.scope === 'PROJECTS' && form.projectIds.length > MAX_REOPEN_PROJECTS) problems.projects = 'tooMany';
  const reason = validateRequestReason(form.reason);
  if (reason !== undefined) problems.reason = reason;
  const hours = validateHours(form.windowHours);
  if (hours !== undefined) problems.windowHours = hours;
  return problems;
}

export type ReopenBody = components['schemas']['DisReopenRequest'];

/** The body of the request: a request for the whole period names no project, a request for projects names the ones chosen. */
export function reopenBody(form: ReopenForm): ReopenBody {
  const base = { scope_kind: form.scope, reason: form.reason.trim(), window_hours: Number(form.windowHours.trim()) };
  return form.scope === 'PROJECTS' ? { ...base, project_ids: [...form.projectIds] } : base;
}

export type DecisionBody = components['schemas']['DisReopenDecision'];

export interface DecisionForm {
  decision: 'approve' | 'reject';
  reason: string;
  windowHours: string;
}

export function validateDecision(form: DecisionForm): Partial<Record<'reason' | 'windowHours', ReopenFieldProblem>> {
  const problems: Partial<Record<'reason' | 'windowHours', ReopenFieldProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length < MIN_DECISION_REASON_LENGTH) problems.reason = 'tooShort';
  else if (reason.length > MAX_REASON_LENGTH) problems.reason = 'tooLong';
  if (form.decision === 'approve') {
    const hours = validateHours(form.windowHours);
    if (hours !== undefined) problems.windowHours = hours;
  }
  return problems;
}

/** The body of a decision: an approval grants the hours typed, a rejection grants none. */
export function decisionBody(form: DecisionForm): DecisionBody {
  const base = { decision: form.decision, reason: form.reason.trim() };
  return form.decision === 'approve' ? { ...base, window_hours: Number(form.windowHours.trim()) } : base;
}

/** A project the requester may name, from the project register. */
export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

export function toProjectOption(raw: unknown): ProjectOption | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  const name = text(row?.name);
  return id === undefined || code === undefined || name === undefined ? undefined : { id, code, name };
}

/** The projects whose code or name contains what was typed, ignoring case; nothing typed shows all of them. */
export function matchingProjects(options: readonly ProjectOption[], query: string): ProjectOption[] {
  const needle = query.trim().toLowerCase();
  return needle === '' ? [...options] : options.filter((option) => option.code.toLowerCase().includes(needle) || option.name.toLowerCase().includes(needle));
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

export type ProblemReason = 'overlap' | 'noCalendar' | 'beforeDeadline' | 'stateInvalid' | 'versionConflict' | 'notFound' | 'validation' | 'denied' | 'reasonRequired' | 'selfApproval' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  PERIOD_OVERLAP: 'overlap',
  CALENDAR_NOT_EFFECTIVE: 'noCalendar',
  PERIOD_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  REOPEN_REASON_REQUIRED: 'reasonRequired',
  SELF_APPROVAL_DENIED: 'selfApproval',
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
