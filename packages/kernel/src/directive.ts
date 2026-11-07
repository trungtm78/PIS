import { DomainError } from './errors.ts';

/**
 * The directives of the steering meetings (customer requirements CN.03 and QT.02, "chỉ đạo giao ban"; governance deepening, lane DIR-1): what the leadership orders in an investment steering meeting, who must do it, by
 * when, and how it is followed until somebody other than the person who recorded it closes it with evidence. Everything here is pure: the thresholds come in as arguments (they are data, a `DirectivePolicy` read
 * through the policy reader of the database side, never a constant of a screen or a controller), and the clock of the caller is a day (`YYYY-MM-DD`, Vietnam time).
 *
 * The stored states of a directive are four: OPEN, IN_PROGRESS, DONE and CANCELLED. OVERDUE is not stored: it is what an OPEN or IN_PROGRESS directive is on the day after its due day, so that it is always right and no
 * job has to keep it right (`effectiveDirectiveStatus`). The five states of the design are the ones a reader sees.
 */

export const MEETING_TYPES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'EXTRAORDINARY', 'SITE_VISIT', 'OTHER'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];
export const meetingTypeOf = (value: unknown): MeetingType | undefined => MEETING_TYPES.find((type) => type === value);

/** A directive is about a project, or about a unit (a directive to a unit that no project carries). */
export const DIRECTIVE_SCOPE_KINDS = ['PROJECT', 'UNIT'] as const;
export type DirectiveScopeKind = (typeof DIRECTIVE_SCOPE_KINDS)[number];
export const directiveScopeKindOf = (value: unknown): DirectiveScopeKind | undefined => DIRECTIVE_SCOPE_KINDS.find((kind) => kind === value);

export const STORED_DIRECTIVE_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type StoredDirectiveStatus = (typeof STORED_DIRECTIVE_STATUSES)[number];
export const DIRECTIVE_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'OVERDUE', 'CANCELLED'] as const;
export type DirectiveStatus = (typeof DIRECTIVE_STATUSES)[number];
export const directiveStatusOf = (value: unknown): DirectiveStatus | undefined => DIRECTIVE_STATUSES.find((status) => status === value);

/** The events of the timeline of a directive: append-only, in the order they happened. */
export const DIRECTIVE_EVENT_TYPES = ['CREATED', 'ASSIGNED', 'PROGRESS', 'EXTENSION_REQUESTED', 'EXTENSION_APPROVED', 'EXTENSION_REJECTED', 'CLOSED', 'CANCELLED', 'REOPENED'] as const;
export type DirectiveEventType = (typeof DIRECTIVE_EVENT_TYPES)[number];

export const DIRECTIVE_RULE_TYPES = ['DIRECTIVE_POLICY'] as const;
export type DirectiveRuleType = (typeof DIRECTIVE_RULE_TYPES)[number];
/** The code of the rule of a tenant that has not chosen one. */
export const DIRECTIVE_POLICY_DEFAULT_CODE = 'DEFAULT';

/** The source of the alert centre this lane feeds. */
export const DIRECTIVE_ALERT_SOURCE = 'DIRECTIVE';

// -- The policy -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DirectivePolicy {
  /** The days before the due day on which the assignee is reminded (T-3, T-1, T+0 are 3, 1 and 0); the alert centre shows a directive from the earliest of them until it is done. */
  reminderDaysBefore: readonly number[];
  /** A directive this many days past its due day is urgent and is raised to the head of the assignee unit (the research: one week). */
  escalateAfterOverdueDays: number;
  /** How many times the due day of a directive may be moved. */
  maxExtensions: number;
  /** How far one extension may move the due day, in days. */
  maxExtensionDays: number;
  /** Closing needs at least one evidence document. */
  closeRequiresEvidence: boolean;
}

/**
 * The starting values of the research (docs/governance-roadmap-10of10.md, DIR-1): reminders on T-3, T-1 and the due day, escalation after seven days overdue, at most three extensions of at most sixty days each, evidence to
 * close. None of them is a rule of law: they are to be settled with the customer and the audit, and the screens say so.
 */
export const DIRECTIVE_POLICY_DEFAULTS: DirectivePolicy = { reminderDaysBefore: [3, 1, 0], escalateAfterOverdueDays: 7, maxExtensions: 3, maxExtensionDays: 60, closeRequiresEvidence: true };

/** What a read of the policy gives: the parameters in force, the version of the rule they came from (null for the built-in default) and where they came from. */
export interface DirectivePolicyReading {
  type: DirectiveRuleType;
  code: string;
  version: number | null;
  source: 'DEFAULT' | 'RULE';
  params: DirectivePolicy;
}

export const defaultDirectivePolicy = (code: string = DIRECTIVE_POLICY_DEFAULT_CODE): DirectivePolicyReading => ({
  type: 'DIRECTIVE_POLICY',
  code,
  version: null,
  source: 'DEFAULT',
  params: { ...DIRECTIVE_POLICY_DEFAULTS, reminderDaysBefore: [...DIRECTIVE_POLICY_DEFAULTS.reminderDaysBefore] },
});

const badParams = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** The parameters of an approved rule, judged again as they are read: one that cannot be understood is never half applied. */
export function parseDirectivePolicy(raw: unknown): DirectivePolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw badParams('params');
  const input = raw as Record<string, unknown>;
  const allowed = new Set(['reminder_days_before', 'escalate_after_overdue_days', 'max_extensions', 'max_extension_days', 'close_requires_evidence']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw badParams(key);
  const days = input.reminder_days_before;
  if (!Array.isArray(days) || days.length === 0 || days.length > 8 || !days.every((day) => isInt(day, 0, 60)) || new Set(days).size !== days.length) throw badParams('reminder_days_before');
  if (!isInt(input.escalate_after_overdue_days, 1, 90)) throw badParams('escalate_after_overdue_days');
  if (!isInt(input.max_extensions, 0, 20)) throw badParams('max_extensions');
  if (!isInt(input.max_extension_days, 1, 365)) throw badParams('max_extension_days');
  if (typeof input.close_requires_evidence !== 'boolean') throw badParams('close_requires_evidence');
  return {
    reminderDaysBefore: [...(days as number[])].sort((left, right) => right - left),
    escalateAfterOverdueDays: input.escalate_after_overdue_days,
    maxExtensions: input.max_extensions,
    maxExtensionDays: input.max_extension_days,
    closeRequiresEvidence: input.close_requires_evidence,
  };
}

// -- Days and the clock of a directive --------------------------------------------------------------------------------------------------------------------------------------------------------------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY_RE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const dayNumber = (value: string): number => Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetweenDays = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

export const addDaysTo = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** What a reader sees: an open directive past its due day is OVERDUE. */
export function effectiveDirectiveStatus(stored: StoredDirectiveStatus, dueOn: string, today: string): DirectiveStatus {
  return (stored === 'OPEN' || stored === 'IN_PROGRESS') && dueOn < today ? 'OVERDUE' : stored;
}

/** Where a directive stands on its clock: DUE_LATER (no reminder yet), DUE_SOON (T-3 to T-1), DUE_TODAY (T+0), OVERDUE, ESCALATED (overdue past the escalation days), ENDED (done or cancelled). */
export type DirectivePhase = 'DUE_LATER' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'ESCALATED' | 'ENDED';

export interface DirectiveClock {
  status: DirectiveStatus;
  phase: DirectivePhase;
  /** Days to the due day (negative when past); null when the directive has ended. */
  daysToDue: number | null;
  /** Days past the due day (0 when it is not overdue); null when the directive has ended. */
  overdueDays: number | null;
  /** Today is exactly one of the reminder days (T-3, T-1, T+0): the day a reminder goes to the assignee. */
  reminderToday: boolean;
  /** The day the directive will be raised to the head of the assignee unit, when it is not already and has not ended. */
  escalatesOn: string | null;
}

/**
 * The clock of one directive on one day (BR-DIR-04): the policy says when the reminders go and when an overdue directive goes up. A directive that has ended (done or cancelled) has no clock. Pure: the same
 * directive, day and policy always give the same clock.
 */
export function directiveClock(stored: StoredDirectiveStatus, dueOn: string, today: string, policy: DirectivePolicy): DirectiveClock {
  const status = effectiveDirectiveStatus(stored, dueOn, today);
  if (stored === 'DONE' || stored === 'CANCELLED') return { status, phase: 'ENDED', daysToDue: null, overdueDays: null, reminderToday: false, escalatesOn: null };
  const daysToDue = daysBetweenDays(today, dueOn);
  const overdueDays = Math.max(0, -daysToDue);
  const window = Math.max(...policy.reminderDaysBefore);
  let phase: DirectivePhase;
  if (daysToDue < 0) phase = overdueDays >= policy.escalateAfterOverdueDays ? 'ESCALATED' : 'OVERDUE';
  else if (daysToDue === 0) phase = 'DUE_TODAY';
  else phase = daysToDue <= window ? 'DUE_SOON' : 'DUE_LATER';
  const escalatesOn = phase === 'ESCALATED' ? null : addDaysTo(dueOn, policy.escalateAfterOverdueDays);
  return { status, phase, daysToDue, overdueDays, reminderToday: policy.reminderDaysBefore.includes(daysToDue), escalatesOn };
}

// -- The moves of a directive ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type DirectiveMove = 'ASSIGN' | 'PROGRESS' | 'REQUEST_EXTENSION' | 'DECIDE_EXTENSION' | 'CLOSE' | 'CANCEL' | 'REOPEN';

/**
 * The state a directive is in after a move, or 409 `DIRECTIVE_STATE_INVALID`. Working on a directive (assigning, noting progress, asking for and deciding an extension) is for one that is not ended; the first note of
 * progress takes it from OPEN to IN_PROGRESS; closing and cancelling end it; reopening takes a done directive back to IN_PROGRESS and a cancelled one back to OPEN.
 */
export function nextDirectiveStatus(current: StoredDirectiveStatus, move: DirectiveMove): StoredDirectiveStatus {
  const live = current === 'OPEN' || current === 'IN_PROGRESS';
  switch (move) {
    case 'ASSIGN':
    case 'REQUEST_EXTENSION':
    case 'DECIDE_EXTENSION':
      if (!live) throw invalidState(current, move);
      return current;
    case 'PROGRESS':
      if (!live) throw invalidState(current, move);
      return 'IN_PROGRESS';
    case 'CLOSE':
      if (!live) throw invalidState(current, move);
      return 'DONE';
    case 'CANCEL':
      if (!live) throw invalidState(current, move);
      return 'CANCELLED';
    case 'REOPEN':
      if (current === 'DONE') return 'IN_PROGRESS';
      if (current === 'CANCELLED') return 'OPEN';
      throw invalidState(current, move);
  }
}

const invalidState = (current: StoredDirectiveStatus, move: DirectiveMove): DomainError => new DomainError('DIRECTIVE_STATE_INVALID', 409, undefined, { extensions: { status: current, move } });

/**
 * Closing is not for the person who recorded the directive, nor for the person it was given to: whoever recorded it can raise a directive and chase it but cannot say it is done, and whoever must do it cannot
 * say it themselves (403 `SELF_APPROVAL_DENIED`). Identifiers are compared as the lower-case text the database writes.
 */
export function assertDirectiveCloser(closer: string, parties: { createdBy: string; assigneeMembershipId: string | null }): void {
  const who = closer.toLowerCase();
  if (who === parties.createdBy.toLowerCase() || (parties.assigneeMembershipId !== null && who === parties.assigneeMembershipId.toLowerCase())) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/** An extension is decided by someone other than whoever asked for it (403 `SELF_APPROVAL_DENIED`). */
export function assertExtensionDecider(decider: string, requester: string): void {
  if (decider.toLowerCase() === requester.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/** Closing needs evidence where the policy says so (422 `DIRECTIVE_EVIDENCE_REQUIRED`). */
export function assertCloseEvidence(policy: DirectivePolicy, evidenceCount: number): void {
  if (policy.closeRequiresEvidence && evidenceCount < 1) throw new DomainError('DIRECTIVE_EVIDENCE_REQUIRED', 422, 'evidence_document_version_ids');
}

/**
 * The refusal of an extension that the policy does not allow: the proposed day must be after the current due day (422 `DIRECTIVE_EXTENSION_INVALID`), within the days one extension may move it, and the
 * directive must not have used its extensions (422 `DIRECTIVE_EXTENSION_LIMIT`). An ended directive has none to ask for (409, as for any move).
 */
export function assertExtension(policy: DirectivePolicy, input: { currentDueOn: string; proposedDueOn: string; extensionCount: number }): void {
  if (!isDay(input.proposedDueOn) || input.proposedDueOn <= input.currentDueOn) throw new DomainError('DIRECTIVE_EXTENSION_INVALID', 422, 'proposed_due_on');
  if (daysBetweenDays(input.currentDueOn, input.proposedDueOn) > policy.maxExtensionDays) throw new DomainError('DIRECTIVE_EXTENSION_INVALID', 422, 'proposed_due_on', { extensions: { max_extension_days: policy.maxExtensionDays } });
  if (input.extensionCount >= policy.maxExtensions) throw new DomainError('DIRECTIVE_EXTENSION_LIMIT', 422, 'proposed_due_on', { extensions: { max_extensions: policy.maxExtensions } });
}

// -- The directives of a period (the narrative input of the next report) ------------------------------------------------------------------------------------------------------------------------------

/** What happened to a directive, as far as the state on a day needs it. */
export interface DirectiveHistoryEvent {
  type: DirectiveEventType;
  /** The day (Vietnam time) the event happened. */
  day: string;
  /** The due day after the event, for the events that set it (an approved extension). */
  toDueOn: string | null;
}

export interface DirectiveHistory {
  /** The day the directive was raised (the day of the meeting, or of its recording when later). */
  raisedOn: string;
  originalDueOn: string;
  events: readonly DirectiveHistoryEvent[];
}

export interface DirectiveStateAt {
  /** Raised on or before the day. */
  existed: boolean;
  status: StoredDirectiveStatus;
  dueOn: string;
}

/** The state of a directive at the end of a day, replayed from its history: what a report of a closed period says, whatever happened afterwards. */
export function directiveStateAt(history: DirectiveHistory, day: string): DirectiveStateAt {
  let status: StoredDirectiveStatus = 'OPEN';
  let dueOn = history.originalDueOn;
  if (history.raisedOn > day) return { existed: false, status, dueOn };
  for (const event of history.events) {
    if (event.day > day) continue;
    switch (event.type) {
      case 'PROGRESS':
        if (status === 'OPEN') status = 'IN_PROGRESS';
        break;
      case 'EXTENSION_APPROVED':
        if (event.toDueOn !== null) dueOn = event.toDueOn;
        break;
      case 'CLOSED':
        status = 'DONE';
        break;
      case 'CANCELLED':
        status = 'CANCELLED';
        break;
      case 'REOPENED':
        status = status === 'DONE' ? 'IN_PROGRESS' : 'OPEN';
        break;
      default:
        break;
    }
  }
  return { existed: true, status, dueOn };
}

export interface PeriodDirectiveFacts {
  raisedInPeriod: boolean;
  closedInPeriod: boolean;
  extendedInPeriod: boolean;
  /** The state at the end of the period, as a reader would see it on that day. */
  statusAtEnd: DirectiveStatus;
  /** Open (not done, not cancelled) on the last day of the period. */
  openAtEnd: boolean;
}

/**
 * The facts of one directive for a period `[from, to]` (BR-DIR-07): raised in it, closed in it, extended in it, and its state on the last day. A directive that did not exist on the last day is not part of the period.
 * Returns undefined for it. A directive that ended before the period began and was not touched in it is not in the period either.
 */
export function periodFacts(history: DirectiveHistory, from: string, to: string): PeriodDirectiveFacts | undefined {
  const atEnd = directiveStateAt(history, to);
  if (!atEnd.existed) return undefined;
  const before = directiveStateAt(history, addDaysTo(from, -1));
  const inPeriod = (event: DirectiveHistoryEvent): boolean => event.day >= from && event.day <= to;
  const raisedInPeriod = history.raisedOn >= from && history.raisedOn <= to;
  const closedInPeriod = history.events.some((event) => event.type === 'CLOSED' && inPeriod(event));
  const extendedInPeriod = history.events.some((event) => event.type === 'EXTENSION_APPROVED' && inPeriod(event));
  const endedBefore = before.existed && (before.status === 'DONE' || before.status === 'CANCELLED');
  const touched = history.events.some((event) => inPeriod(event) && event.type !== 'CREATED');
  if (endedBefore && !raisedInPeriod && !touched) return undefined;
  const openAtEnd = atEnd.status === 'OPEN' || atEnd.status === 'IN_PROGRESS';
  return { raisedInPeriod, closedInPeriod, extendedInPeriod, statusAtEnd: effectiveDirectiveStatus(atEnd.status, atEnd.dueOn, addDaysTo(to, 1)), openAtEnd };
}

export interface PeriodCounts {
  /** Every directive that belongs to the period. */
  total: number;
  raised: number;
  closed: number;
  extended: number;
  openAtEnd: number;
  overdueAtEnd: number;
  /** By the status at the end of the period; every status is there, with 0 where there is none. */
  byStatus: Readonly<Record<DirectiveStatus, number>>;
}

/** The counts of a period from the facts of its directives (a plain sum: the list the report carries is the list these add up from). */
export function periodCounts(facts: readonly PeriodDirectiveFacts[]): PeriodCounts {
  const byStatus: Record<DirectiveStatus, number> = { OPEN: 0, IN_PROGRESS: 0, DONE: 0, OVERDUE: 0, CANCELLED: 0 };
  let raised = 0;
  let closed = 0;
  let extended = 0;
  let openAtEnd = 0;
  for (const fact of facts) {
    byStatus[fact.statusAtEnd] += 1;
    if (fact.raisedInPeriod) raised += 1;
    if (fact.closedInPeriod) closed += 1;
    if (fact.extendedInPeriod) extended += 1;
    if (fact.openAtEnd) openAtEnd += 1;
  }
  return { total: facts.length, raised, closed, extended, openAtEnd, overdueAtEnd: byStatus.OVERDUE, byStatus };
}
