import { DomainError } from './errors.ts';
import { addWorkingTime, workingMinutesBetween } from './working-time.ts';
import type { WorkCalendarSource, WorkingInterval } from './working-time.ts';

/**
 * The clocks of the alert centre (roadmap G0-2, G2-1, G2-2, G2-4; docs/work-clocks.md). An item of the alert centre carries two clocks of its own, how long it may wait before somebody takes it up
 * (time to claim) and how long it may take until it is done (time to resolve); a clock can be paused, but only with a reason and the name of the person who allowed it; and the item is reminded, put off
 * and taken up again by rules that are data (`snoozePolicyDefaults`, `clockPolicyDefaults`, `reminderPolicyDefaults`), never constants of a screen or a controller.
 *
 * Everything here is pure: the calendars, the policies and the clock of the caller come in as arguments. A year without a published working calendar never gives a guessed day: the clocks of an item
 * are then absent and say so (`basis: 'CALENDAR_UNAVAILABLE'`), exactly as `addWorkingTime` refuses (422 CALENDAR_NOT_EFFECTIVE).
 */

export type ClockSeverity = 'URGENT' | 'ACTION' | 'WATCH';
type PerSeverity<T> = Readonly<Record<ClockSeverity, T>>;

/** The kinds of governance rule these policies are; the code of the one that applies to everybody is `DEFAULT` (a province can add codes and approve them through the governance store). */
export const WORK_POLICY_RULE_TYPES = { snooze: 'SNOOZE_POLICY', clock: 'CLOCK_POLICY', reminder: 'REMINDER_POLICY' } as const;
export const WORK_POLICY_DEFAULT_CODE = 'DEFAULT';
/** The version a decision carries when the policy it used was the built-in default, not an approved rule. */
export const BUILTIN_POLICY_VERSION = 'builtin';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const VIETNAM_OFFSET = '+07:00';

// -- Snooze (G2-1) ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SNOOZE_REASONS = ['WAITING_INFORMATION', 'WAITING_THIRD_PARTY', 'SCHEDULED_ACTION', 'BLOCKED_BY_OTHER_WORK', 'ON_LEAVE', 'OTHER'] as const;
export type SnoozeReason = (typeof SNOOZE_REASONS)[number];

export interface SnoozePolicy {
  /** The reasons a person can choose from. */
  reasons: readonly string[];
  /** The reasons that need words of the person besides the code. */
  note_required_for: readonly string[];
  /** The furthest an item of each severity may be put off, in days from now; 0 means it cannot be put off at all. */
  max_days_by_severity: PerSeverity<number>;
  /** How many times in a row an item may be put off; a claim or a handover in between starts the count again. */
  max_consecutive: number;
  /** The last allowed snooze tells the next level. */
  final_notifies_next_level: boolean;
}

/** G2-1: Cần xử lý at most 3 days, Theo dõi at most 14 days, Khẩn never, two in a row, the last one tells the next level. Starting values to be settled with the customer and the audit, not legal numbers. */
export function snoozePolicyDefaults(): SnoozePolicy {
  return {
    reasons: SNOOZE_REASONS,
    note_required_for: ['OTHER'],
    max_days_by_severity: { URGENT: 0, ACTION: 3, WATCH: 14 },
    max_consecutive: 2,
    final_notifies_next_level: true,
  };
}

export interface SnoozeRequest {
  severity: ClockSeverity;
  now: Date;
  until: Date;
  reasonCode: string | undefined;
  note: string | undefined;
  /** The day the module itself says the item is due on, when it says one: nothing is put off past it. */
  dueOn: string | null;
  /** How many snoozes in a row the item already has. */
  consecutive: number;
}

export type SnoozeVerdict =
  | { ok: true; ordinal: number; final: boolean; maxDays: number }
  | { ok: false; code: 'VALIDATION_FAILED' | 'WORK_SNOOZE_NOT_ALLOWED' | 'WORK_SNOOZE_TOO_LONG' | 'WORK_SNOOZE_LIMIT'; field: string };

/** The Vietnam calendar day of an instant (YYYY-MM-DD). */
export const dayInVietnam = (instant: Date): string => new Date(instant.getTime() + 7 * HOUR_MS).toISOString().slice(0, 10);

/** Whether a snooze is allowed and which one it is of the series. The refusals have stable codes; none of them carries what the person wrote. */
export function evaluateSnooze(policy: SnoozePolicy, request: SnoozeRequest): SnoozeVerdict {
  if (request.reasonCode === undefined || !policy.reasons.includes(request.reasonCode)) return { ok: false, code: 'VALIDATION_FAILED', field: 'reason_code' };
  if (policy.note_required_for.includes(request.reasonCode) && (request.note === undefined || request.note.trim().length < 5)) return { ok: false, code: 'VALIDATION_FAILED', field: 'reason' };
  const maxDays = policy.max_days_by_severity[request.severity];
  if (maxDays <= 0) return { ok: false, code: 'WORK_SNOOZE_NOT_ALLOWED', field: 'severity' };
  if (request.consecutive >= policy.max_consecutive) return { ok: false, code: 'WORK_SNOOZE_LIMIT', field: 'snooze_until' };
  if (request.dueOn !== null && dayInVietnam(request.until) > request.dueOn) return { ok: false, code: 'WORK_SNOOZE_NOT_ALLOWED', field: 'snooze_until' };
  if (request.until.getTime() - request.now.getTime() > maxDays * DAY_MS) return { ok: false, code: 'WORK_SNOOZE_TOO_LONG', field: 'snooze_until' };
  const ordinal = request.consecutive + 1;
  return { ok: true, ordinal, final: ordinal >= policy.max_consecutive, maxDays };
}

// -- Two clocks and pausing (G2-2) ------------------------------------------------------------------------------------------------------------------------------------------------------------

export const PAUSE_REASONS = ['WAITING_EXTERNAL_PARTY', 'LEGAL_OR_AUDIT_HOLD', 'DATA_CORRECTION', 'FORCE_MAJEURE', 'OTHER'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface ClockPolicy {
  /** How long an item of each severity may wait before somebody takes it up, in working hours from the moment it started. */
  claim_within_working_hours: PerSeverity<number>;
  /** How long an item that has no due day of its own may take, in working hours from the moment it started. An item whose module says a due day keeps that day. */
  resolve_within_working_hours: PerSeverity<number>;
  /** An item somebody took up that shows no sign of work for this long (working hours) is shown to the next level as "cần nhận lại". */
  no_progress_after_working_hours: PerSeverity<number>;
  /** The longest a clock may be paused in one go, in days. */
  max_pause_days: number;
  pause_reasons: readonly string[];
}

export function clockPolicyDefaults(): ClockPolicy {
  return {
    claim_within_working_hours: { URGENT: 2, ACTION: 8, WATCH: 24 },
    resolve_within_working_hours: { URGENT: 8, ACTION: 40, WATCH: 80 },
    no_progress_after_working_hours: { URGENT: 4, ACTION: 24, WATCH: 40 },
    max_pause_days: 30,
    pause_reasons: PAUSE_REASONS,
  };
}

export type ClockState = 'RUNNING' | 'PAUSED' | 'MET' | 'MET_LATE' | 'BREACHED';

export interface ClockView {
  state: ClockState;
  started_at: string | null;
  due_at: string;
  /** When it was met (claimed, resolved); null while it runs, or when the module's own state met it without a time. */
  met_at: string | null;
}

/** One pause of an item's clocks: from when to when it is meant to last, and the moment it was ended early (null while it lasts or ran out by itself). */
export interface PauseSpan {
  from: string;
  until: string;
  resumedAt: string | null;
  reasonCode: string;
  reason: string;
  allowedBy: { id: string; name: string } | null;
  by: { id: string; name: string } | null;
}

export interface ItemClockInput {
  severity: ClockSeverity;
  now: Date;
  /** The moment the item became something to act on, when the module knows it; null when it does not (the claim clock is then absent, never guessed). */
  startedAt: Date | null;
  /** The module's own due day (Vietnam), which the item keeps. */
  dueOn: string | null;
  /** The first moment somebody took the item up, and the latest one (a re-claim starts the no-progress count again). */
  firstClaimAt: Date | null;
  lastClaimAt: Date | null;
  /** What the module and the people have done together: NEW, CLAIMED, IN_PROGRESS, RESOLVED. */
  lifecycle: 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
  pauses: readonly PauseSpan[];
  policy: ClockPolicy;
  /** The published working calendars; absent when they could not be read. */
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[];
}

export interface ItemClocks {
  /** `WORKING_TIME`: counted on the published working calendar; `CALENDAR_UNAVAILABLE`: a year is not published, the clocks that need it are absent; `NO_START`: the module gives no start. */
  basis: 'WORKING_TIME' | 'CALENDAR_UNAVAILABLE' | 'NO_START';
  claim: ClockView | null;
  resolve: ClockView | null;
  /** The pause that holds now, if one does. */
  paused: PauseSpan | null;
  /** The item was taken up and shows no sign of work past the threshold; `since` is when the threshold was passed. */
  needsReclaim: { since: string } | null;
}

const iso = (date: Date): string => date.toISOString();
const endOfDay = (day: string): Date => new Date(`${day}T23:59:59${VIETNAM_OFFSET}`);

/** The end of a pause as it counts now: the moment it was ended, or the end it was given, whichever is first. */
const spanEnd = (span: PauseSpan): Date => {
  const until = new Date(span.until);
  if (span.resumedAt === null) return until;
  const resumed = new Date(span.resumedAt);
  return resumed.getTime() < until.getTime() ? resumed : until;
};

/** The pause that holds at `now`, if one does. */
export function activePause(pauses: readonly PauseSpan[], now: Date): PauseSpan | null {
  for (let index = pauses.length - 1; index >= 0; index -= 1) {
    const span = pauses[index] as PauseSpan;
    if (new Date(span.from).getTime() <= now.getTime() && now.getTime() < spanEnd(span).getTime()) return span;
  }
  return null;
}

/** The working minutes the pauses took away between two moments. */
function pausedMinutes(calendars: WorkCalendarSource, pauses: readonly PauseSpan[], from: Date, to: Date, intervals: readonly WorkingInterval[] | undefined): number {
  let total = 0;
  for (const span of pauses) {
    const begin = Math.max(new Date(span.from).getTime(), from.getTime());
    const end = Math.min(spanEnd(span).getTime(), to.getTime());
    if (end > begin) total += workingMinutesBetween(calendars, new Date(begin), new Date(end), intervals);
  }
  return total;
}

/**
 * The two clocks of an item and whether it has to be taken up again. The claim clock starts when the module says the item started and runs for the working hours the policy gives its severity (a pause
 * stops it: the time paused is added to the end); it is met when somebody takes the item up. The resolve clock is the module's own due day when there is one (a pause does not move a day the module owns;
 * it only stops the clock from being called breached), otherwise the policy's working hours from the start. Only the working calendar is used for counting; none is guessed.
 */
export function itemClocks(input: ItemClockInput): ItemClocks {
  const { now, policy, severity } = input;
  const paused = activePause(input.pauses, now);
  const resolved = input.lifecycle === 'RESOLVED';
  let claim: ClockView | null = null;
  let resolve: ClockView | null = null;
  let needsReclaim: ItemClocks['needsReclaim'] = null;
  let basis: ItemClocks['basis'] = input.startedAt === null ? 'NO_START' : 'WORKING_TIME';

  if (input.dueOn !== null) {
    const due = endOfDay(input.dueOn);
    resolve = { state: resolved ? 'MET' : paused !== null ? 'PAUSED' : now.getTime() > due.getTime() ? 'BREACHED' : 'RUNNING', started_at: input.startedAt === null ? null : iso(input.startedAt), due_at: iso(due), met_at: null };
  }

  const calendars = input.calendars;
  if (calendars === undefined) {
    if (input.startedAt !== null || input.lastClaimAt !== null) basis = 'CALENDAR_UNAVAILABLE';
    return { basis, claim, resolve, paused, needsReclaim };
  }
  try {
    const taken = input.firstClaimAt !== null || input.lifecycle !== 'NEW';
    if (input.startedAt !== null) {
      const start = input.startedAt;
      const claimEnd = input.firstClaimAt ?? now;
      const stopped = pausedMinutes(calendars, input.pauses, start, claimEnd, input.intervals);
      const due = addWorkingTime(calendars, start, { minutes: policy.claim_within_working_hours[severity] * 60 + stopped }, input.intervals);
      const state: ClockState = taken ? (input.firstClaimAt !== null && input.firstClaimAt.getTime() > due.getTime() ? 'MET_LATE' : 'MET') : paused !== null ? 'PAUSED' : now.getTime() > due.getTime() ? 'BREACHED' : 'RUNNING';
      claim = { state, started_at: iso(start), due_at: iso(due), met_at: input.firstClaimAt === null ? null : iso(input.firstClaimAt) };
      if (resolve === null) {
        const resolveStopped = pausedMinutes(calendars, input.pauses, start, now, input.intervals);
        const resolveDue = addWorkingTime(calendars, start, { minutes: policy.resolve_within_working_hours[severity] * 60 + resolveStopped }, input.intervals);
        resolve = { state: resolved ? 'MET' : paused !== null ? 'PAUSED' : now.getTime() > resolveDue.getTime() ? 'BREACHED' : 'RUNNING', started_at: iso(start), due_at: iso(resolveDue), met_at: null };
      }
    }
    // Taken up and then silent: only an item that is still just "taken up" can be, the module or a handover moving it on is a sign of work.
    if (input.lifecycle === 'CLAIMED' && input.lastClaimAt !== null && paused === null) {
      const from = input.lastClaimAt;
      const stopped = pausedMinutes(calendars, input.pauses, from, now, input.intervals);
      const threshold = addWorkingTime(calendars, from, { minutes: policy.no_progress_after_working_hours[severity] * 60 + stopped }, input.intervals);
      if (now.getTime() > threshold.getTime()) needsReclaim = { since: iso(threshold) };
    }
  } catch (failure) {
    if (failure instanceof DomainError && failure.code === 'CALENDAR_NOT_EFFECTIVE') return { basis: 'CALENDAR_UNAVAILABLE', claim: null, resolve, paused, needsReclaim: null };
    throw failure;
  }
  return { basis, claim, resolve, paused, needsReclaim };
}

export interface NativeClockInput {
  startedAt: Date;
  /** The end the clock was given when it started, counted on the published working calendar. */
  dueAt: Date;
  now: Date;
  pauses: readonly PauseSpan[];
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[];
  /** The clock is "near its end" when this many working hours (or fewer) are left; the cadence of the reminders of its severity. */
  nearWorkingHours: number;
}

export interface NativeClock {
  basis: 'WORKING_TIME' | 'CALENDAR_UNAVAILABLE';
  resolve: ClockView;
  paused: PauseSpan | null;
  /** Running and within `nearWorkingHours` of its end. */
  near: boolean;
}

/**
 * A native clock of the alert centre (G0-2): the end it was given, moved later by the working time it was paused for. A pause stops the clock, so the end moves by what the pause took away; a year without a published calendar
 * leaves the end where it was given and says so, it never guesses a day.
 */
export function nativeClock(input: NativeClockInput): NativeClock {
  const { now } = input;
  const paused = activePause(input.pauses, now);
  let due = input.dueAt;
  let basis: NativeClock['basis'] = 'WORKING_TIME';
  let left: number | null = null;
  if (input.calendars === undefined) basis = 'CALENDAR_UNAVAILABLE';
  else {
    try {
      const stopped = pausedMinutes(input.calendars, input.pauses, input.startedAt, now, input.intervals);
      if (stopped > 0) due = addWorkingTime(input.calendars, input.dueAt, { minutes: stopped }, input.intervals);
      left = due.getTime() > now.getTime() ? workingMinutesBetween(input.calendars, now, due, input.intervals) : 0;
    } catch (failure) {
      if (!(failure instanceof DomainError) || failure.code !== 'CALENDAR_NOT_EFFECTIVE') throw failure;
      basis = 'CALENDAR_UNAVAILABLE';
      due = input.dueAt;
    }
  }
  const state: ClockState = paused !== null ? 'PAUSED' : now.getTime() > due.getTime() ? 'BREACHED' : 'RUNNING';
  const remaining = left ?? Math.max(0, Math.round((due.getTime() - now.getTime()) / 60_000));
  return { basis, resolve: { state, started_at: iso(input.startedAt), due_at: iso(due), met_at: null }, paused, near: state === 'RUNNING' && remaining <= input.nearWorkingHours * 60 };
}

/** What a pause asks for: a reason from the list and in words, a person who allowed it (not the person who asks) and an end, no further than the policy lets. */
export interface PauseRequest {
  reasonCode: string | undefined;
  reason: string | undefined;
  allowedBy: string | undefined;
  actor: string;
  until: Date;
  now: Date;
}

export type PauseVerdict = { ok: true } | { ok: false; code: 'VALIDATION_FAILED' | 'WORK_CLOCK_PAUSE_TOO_LONG' | 'WORK_CLOCK_ALLOWER_INVALID'; field: string };

export function evaluatePause(policy: ClockPolicy, request: PauseRequest): PauseVerdict {
  if (request.reasonCode === undefined || !policy.pause_reasons.includes(request.reasonCode)) return { ok: false, code: 'VALIDATION_FAILED', field: 'reason_code' };
  if (request.reason === undefined || request.reason.trim().length < 5) return { ok: false, code: 'VALIDATION_FAILED', field: 'reason' };
  if (request.allowedBy === undefined) return { ok: false, code: 'VALIDATION_FAILED', field: 'allowed_by_id' };
  if (request.allowedBy.toLowerCase() === request.actor.toLowerCase()) return { ok: false, code: 'WORK_CLOCK_ALLOWER_INVALID', field: 'allowed_by_id' };
  if (Number.isNaN(request.until.getTime()) || request.until.getTime() <= request.now.getTime()) return { ok: false, code: 'VALIDATION_FAILED', field: 'paused_until' };
  if (request.until.getTime() - request.now.getTime() > policy.max_pause_days * DAY_MS) return { ok: false, code: 'WORK_CLOCK_PAUSE_TOO_LONG', field: 'paused_until' };
  return { ok: true };
}

// -- Reminder cadence (G2-4) ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const REMINDER_KINDS = ['REMINDER', 'RECLAIM_NOTICE', 'SNOOZE_FINAL_NOTICE'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export interface ReminderPolicy {
  /** How often an item that is open is reminded, in working hours, by severity. */
  every_working_hours: PerSeverity<number>;
  /** The most reminders one item gets, by severity: a reminder that never ends is noise, and the escalation takes over. */
  max_per_item: PerSeverity<number>;
}

export function reminderPolicyDefaults(): ReminderPolicy {
  return { every_working_hours: { URGENT: 4, ACTION: 8, WATCH: 40 }, max_per_item: { URGENT: 40, ACTION: 20, WATCH: 8 } };
}

export interface ReminderInput {
  severity: ClockSeverity;
  now: Date;
  /** The moment the cadence counts from: the latest of the start of the item, the claim, the end of a snooze and the last reminder; null when there is none (the first reminder is then due at once). */
  anchorAt: Date | null;
  sent: number;
  /** A snoozed item and a paused one are not reminded. */
  snoozedUntil: Date | null;
  paused: boolean;
  lifecycle: 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
  policy: ReminderPolicy;
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[];
}

export interface ReminderState {
  /** The next reminder is due now or earlier. */
  due: boolean;
  /** When the next reminder is due; null when none is coming (resolved, snoozed, paused, out of reminders, or no calendar). */
  nextAt: string | null;
  /** The item has had all the reminders the policy gives it. */
  exhausted: boolean;
  cadenceWorkingHours: number;
}

/** Whether an item is to be reminded now and when the next reminder falls. A year without a calendar means no reminder is invented: the answer is "not due, no next time". */
export function reminderState(input: ReminderInput): ReminderState {
  const cadence = input.policy.every_working_hours[input.severity];
  const exhausted = input.sent >= input.policy.max_per_item[input.severity];
  const none: ReminderState = { due: false, nextAt: null, exhausted, cadenceWorkingHours: cadence };
  if (input.lifecycle === 'RESOLVED' || exhausted || input.paused) return none;
  if (input.snoozedUntil !== null && input.snoozedUntil.getTime() > input.now.getTime()) return { ...none, nextAt: iso(input.snoozedUntil) };
  if (input.anchorAt === null) return { ...none, due: true, nextAt: iso(input.now) };
  if (input.calendars === undefined) return none;
  try {
    const next = addWorkingTime(input.calendars, input.anchorAt, { minutes: cadence * 60 }, input.intervals);
    return { due: next.getTime() <= input.now.getTime(), nextAt: iso(next), exhausted, cadenceWorkingHours: cadence };
  } catch (failure) {
    if (failure instanceof DomainError && failure.code === 'CALENDAR_NOT_EFFECTIVE') return none;
    throw failure;
  }
}

// -- The clocks that were there before (G0-2: wrap, then migrate where safe) -------------------------------------------------------------------------------------------------------------------

/** One clock the modules already keep. The alert centre reads it as it is; nothing about it changes. `migrated` says whether the module's own job was moved onto the engine (none was in this version). */
export interface ExistingClock {
  source: string;
  code: string;
  module: string;
  /** What starts it, what stops it, what pauses it, in the module's own words. */
  starts: string;
  stops: string;
  pauses: string;
  basis: 'CALENDAR_DAYS' | 'WORKING_TIME';
  migrated: boolean;
}

export const EXISTING_CLOCKS: readonly ExistingClock[] = [
  { source: 'EARLY_WARNING', code: 'DIS-20', module: 'DIS', starts: 'A rule fires and the warning opens', stops: 'The warning is resolved or dismissed', pauses: 'An explanation is requested (the warning waits for the answer)', basis: 'CALENDAR_DAYS', migrated: false },
  { source: 'ADVANCE', code: 'PAY-12', module: 'PAY', starts: 'The recovery deadline of the advance passes unrecovered', stops: 'The advance is recovered in full', pauses: 'None', basis: 'CALENDAR_DAYS', migrated: false },
  { source: 'PERMIT', code: 'PMT-05', module: 'PMT', starts: '60 days before the permit expires', stops: 'The permit is renewed or replaced', pauses: 'None', basis: 'CALENDAR_DAYS', migrated: false },
  { source: 'ISSUE', code: 'ISS-09', module: 'ISS', starts: 'An issue is opened (the SLA counts the response and the resolve time)', stops: 'The issue is resolved or closed', pauses: 'An extension of the deadline granted by the unit', basis: 'WORKING_TIME', migrated: false },
  { source: 'GUARANTEE', code: 'CTR-05', module: 'CTR', starts: '30 days before the guarantee ends', stops: 'A replacement is verified or the contract ends', pauses: 'None', basis: 'CALENDAR_DAYS', migrated: false },
];

// -- Reading what a governance rule carries ------------------------------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function perSeverity(value: unknown, field: string, min: number, max: number): PerSeverity<number> {
  if (!isRecord(value)) throw invalid(field);
  const read = (key: ClockSeverity): number => {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw invalid(`${field}.${key}`);
    return number;
  };
  return { URGENT: read('URGENT'), ACTION: read('ACTION'), WATCH: read('WATCH') };
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(entry))) throw invalid(field);
  return value as string[];
}

/** The params of a `SNOOZE_POLICY` rule, checked: a rule that does not say all of it is refused rather than half-applied. */
export function snoozePolicyOf(params: unknown): SnoozePolicy {
  if (!isRecord(params)) throw invalid('params');
  const reasons = stringList(params.reasons, 'reasons');
  const noteFor = Array.isArray(params.note_required_for) ? stringList(params.note_required_for, 'note_required_for') : [];
  const maxConsecutive = params.max_consecutive;
  if (typeof maxConsecutive !== 'number' || !Number.isInteger(maxConsecutive) || maxConsecutive < 1 || maxConsecutive > 10) throw invalid('max_consecutive');
  const days = perSeverity(params.max_days_by_severity, 'max_days_by_severity', 0, 90);
  if (days.URGENT !== 0) throw invalid('max_days_by_severity.URGENT');
  return { reasons, note_required_for: noteFor.filter((code) => reasons.includes(code)), max_days_by_severity: days, max_consecutive: maxConsecutive, final_notifies_next_level: params.final_notifies_next_level !== false };
}

export function clockPolicyOf(params: unknown): ClockPolicy {
  if (!isRecord(params)) throw invalid('params');
  const maxPause = params.max_pause_days;
  if (typeof maxPause !== 'number' || !Number.isInteger(maxPause) || maxPause < 1 || maxPause > 365) throw invalid('max_pause_days');
  return {
    claim_within_working_hours: perSeverity(params.claim_within_working_hours, 'claim_within_working_hours', 1, 720),
    resolve_within_working_hours: perSeverity(params.resolve_within_working_hours, 'resolve_within_working_hours', 1, 2400),
    no_progress_after_working_hours: perSeverity(params.no_progress_after_working_hours, 'no_progress_after_working_hours', 1, 720),
    max_pause_days: maxPause,
    pause_reasons: stringList(params.pause_reasons, 'pause_reasons'),
  };
}

export function reminderPolicyOf(params: unknown): ReminderPolicy {
  if (!isRecord(params)) throw invalid('params');
  return { every_working_hours: perSeverity(params.every_working_hours, 'every_working_hours', 1, 720), max_per_item: perSeverity(params.max_per_item, 'max_per_item', 1, 500) };
}
