import { DomainError } from './errors.ts';
import { DEFAULT_WORKING_INTERVALS, addWorkingTime, workingMinutesBetween } from './working-time.ts';
import type { WorkCalendarSource, WorkingInterval } from './working-time.ts';

/**
 * The clocks of the Treasury control of a payment request (G1-17 of docs/governance-roadmap-10of10.md, PAY 3.3): the Treasury answers a complete dossier within a number of working days (2 for a payment, 1 for an
 * advance, both flagged "not confirmed" until the decree is checked with the customer), and a dossier that is given back carries a reason from a standard list. Everything here is pure: the calendar, the
 * policy and the clock of the caller come in as arguments. A year without a published working calendar never gives a guessed day: the clock then says `CALENDAR_UNAVAILABLE` and has no due instant.
 */

export const PAYMENT_CLOCK_RULE_TYPE = 'PAYMENT_CLOCK';
export const PAYMENT_RETURN_REASON_RULE_TYPE = 'PAYMENT_RETURN_REASON';
export const PAYMENT_CLOCK_KINDS = ['PAYMENT', 'ADVANCE'] as const;
export type PaymentClockKind = (typeof PAYMENT_CLOCK_KINDS)[number];

/** The clock of a payment request kind: an advance request has its own (shorter) clock, interim and final payments share one. */
export const clockKindOf = (requestKind: string): PaymentClockKind => (requestKind === 'ADVANCE' ? 'ADVANCE' : 'PAYMENT');

export interface PaymentClockParams {
  /** Working days the Treasury may take from the receipt of the complete dossier. */
  working_days: number;
  /** The clock is "near its end" when this many working hours or fewer are left. */
  near_working_hours: number;
  /** A dossier that is returned must name a reason of the standard list. */
  reason_code_required: boolean;
}

/** The built-in defaults: 2 working days for a payment, 1 for an advance (roadmap G1-17, Decree 254/2025 as the roadmap cites it: not verified against the text). */
export function paymentClockDefaults(kind: PaymentClockKind): PaymentClockParams {
  return kind === 'ADVANCE' ? { working_days: 1, near_working_hours: 4, reason_code_required: true } : { working_days: 2, near_working_hours: 8, reason_code_required: true };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export function paymentClockParams(raw: unknown): PaymentClockParams {
  if (!isRecord(raw)) throw invalid('params');
  const days = raw.working_days;
  const near = raw.near_working_hours;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) throw invalid('working_days');
  if (typeof near !== 'number' || !Number.isInteger(near) || near < 1 || near > 240) throw invalid('near_working_hours');
  if (typeof raw.reason_code_required !== 'boolean') throw invalid('reason_code_required');
  return { working_days: days, near_working_hours: near, reason_code_required: raw.reason_code_required };
}

// -- The standard reasons to return a request -----------------------------------------------------------------------------------------------------------------------------------------------

export const RETURN_REASON_CATEGORIES = ['DOSSIER', 'AMOUNT', 'BUDGET', 'PAYEE', 'LEGAL', 'OTHER'] as const;
export type ReturnReasonCategory = (typeof RETURN_REASON_CATEGORIES)[number];
export const RETURN_REASON_SIDES = ['INVESTOR', 'TREASURY'] as const;
export type ReturnReasonSide = (typeof RETURN_REASON_SIDES)[number];

export interface ReturnReasonParams {
  category: ReturnReasonCategory;
  /** The free note must say more than a word (at least `MIN_NOTE_LENGTH` characters). */
  requires_note: boolean;
  /** Who usually causes the return: the investor (the dossier is wrong) or the Treasury (the dossier is refused on a ground the investor disputes). Informs the breakdown, never blocks. */
  owner_side: ReturnReasonSide;
  /** A reason that is not active is still read on old returns but is no longer offered. */
  active: boolean;
}

export const MIN_NOTE_LENGTH = 10;
export const RETURN_REASON_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The starting list of standard reasons, as data: a province adds, retires or changes codes through the governance rules (rule type `PAYMENT_RETURN_REASON`). */
export const RETURN_REASON_DEFAULTS: Readonly<Record<string, ReturnReasonParams>> = {
  MISSING_DOCUMENT: { category: 'DOSSIER', requires_note: false, owner_side: 'INVESTOR', active: true },
  MISSING_SIGNATURE: { category: 'DOSSIER', requires_note: false, owner_side: 'INVESTOR', active: true },
  ACCEPTANCE_MISMATCH: { category: 'DOSSIER', requires_note: false, owner_side: 'INVESTOR', active: true },
  GUARANTEE_INVALID: { category: 'LEGAL', requires_note: false, owner_side: 'INVESTOR', active: true },
  WRONG_AMOUNT: { category: 'AMOUNT', requires_note: true, owner_side: 'INVESTOR', active: true },
  ADVANCE_NOT_RECOVERED: { category: 'AMOUNT', requires_note: false, owner_side: 'INVESTOR', active: true },
  NO_BUDGET_ROOM: { category: 'BUDGET', requires_note: true, owner_side: 'TREASURY', active: true },
  WRONG_PAYEE_ACCOUNT: { category: 'PAYEE', requires_note: false, owner_side: 'INVESTOR', active: true },
  OTHER: { category: 'OTHER', requires_note: true, owner_side: 'INVESTOR', active: true },
};

export function returnReasonParams(raw: unknown): ReturnReasonParams {
  if (!isRecord(raw)) throw invalid('params');
  const { category, owner_side: side } = raw;
  if (typeof category !== 'string' || !(RETURN_REASON_CATEGORIES as readonly string[]).includes(category)) throw invalid('category');
  if (typeof side !== 'string' || !(RETURN_REASON_SIDES as readonly string[]).includes(side)) throw invalid('owner_side');
  if (typeof raw.requires_note !== 'boolean') throw invalid('requires_note');
  if (typeof raw.active !== 'boolean') throw invalid('active');
  return { category: category as ReturnReasonCategory, requires_note: raw.requires_note, owner_side: side as ReturnReasonSide, active: raw.active };
}

export type ReasonCatalogue = ReadonlyMap<string, ReturnReasonParams>;

/**
 * Judges the reason of a return against the catalogue: the code is required (when the policy says so) and must be a known, active reason; a reason that asks for a note needs one of at least
 * `MIN_NOTE_LENGTH` characters. Returns the code to keep (null when none is required and none was given). 422 `VALIDATION_FAILED` naming `reason_code` or `reason`.
 */
export function judgeReturnReason(input: { reasonCode: string | undefined; note: string; catalogue: ReasonCatalogue; required: boolean }): string | null {
  const { reasonCode } = input;
  if (reasonCode === undefined) {
    if (input.required) throw invalid('reason_code');
    return null;
  }
  const reason = RETURN_REASON_CODE.test(reasonCode) ? input.catalogue.get(reasonCode) : undefined;
  if (reason === undefined || !reason.active) throw new DomainError('VALIDATION_FAILED', 422, 'reason_code', { extensions: { reason_code: reasonCode } });
  if (reason.requires_note && input.note.trim().length < MIN_NOTE_LENGTH) throw new DomainError('VALIDATION_FAILED', 422, 'reason', { extensions: { reason_code: reasonCode, min_length: MIN_NOTE_LENGTH } });
  return reasonCode;
}

// -- The clock ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The minutes of working time in one working day of the window. */
export function workingMinutesPerDay(intervals: readonly WorkingInterval[] = DEFAULT_WORKING_INTERVALS): number {
  return intervals.reduce((sum, span) => {
    const [fromHour, fromMinute] = span.from.split(':').map(Number) as [number, number];
    const [toHour, toMinute] = span.to.split(':').map(Number) as [number, number];
    return sum + (toHour * 60 + toMinute - (fromHour * 60 + fromMinute));
  }, 0);
}

export type ClockBasis = 'WORKING_TIME' | 'CALENDAR_UNAVAILABLE';

/**
 * The instant the Treasury must have answered by: `workingDays` of working time counted from the instant it received the complete dossier (a dossier received outside working hours starts counting at the next
 * opening). No published calendar for a year the count passes through: no instant, basis `CALENDAR_UNAVAILABLE` (never a guessed weekly pattern).
 */
export function clockDueAt(calendars: WorkCalendarSource | undefined, startedAt: Date, workingDays: number, intervals: readonly WorkingInterval[] = DEFAULT_WORKING_INTERVALS): { dueAt: Date | null; basis: ClockBasis } {
  if (calendars === undefined) return { dueAt: null, basis: 'CALENDAR_UNAVAILABLE' };
  try {
    return { dueAt: addWorkingTime(calendars, startedAt, { minutes: workingDays * workingMinutesPerDay(intervals) }, intervals), basis: 'WORKING_TIME' };
  } catch (failure) {
    if (failure instanceof DomainError && failure.code === 'CALENDAR_NOT_EFFECTIVE') return { dueAt: null, basis: 'CALENDAR_UNAVAILABLE' };
    throw failure;
  }
}

export const PAYMENT_CLOCK_STATES = ['RUNNING', 'NEAR', 'BREACHED', 'MET', 'MET_LATE', 'RETURNED', 'RETURNED_LATE'] as const;
export type PaymentClockState = (typeof PAYMENT_CLOCK_STATES)[number];
export type ClockEnd = 'SETTLED' | 'RETURNED';

export interface PaymentClockInput {
  startedAt: Date;
  /** The due instant kept when the clock started; null when no calendar was available then (it is counted again here). */
  dueAt: Date | null;
  workingDays: number;
  nearWorkingHours: number;
  now: Date;
  endedAt: Date | null;
  endKind: ClockEnd | null;
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[];
}

export interface PaymentClockReading {
  state: PaymentClockState;
  basis: ClockBasis;
  dueAt: Date | null;
  /** Working minutes left while it runs (0 once past the due instant); null when ended or when the calendar is unavailable. */
  workingMinutesLeft: number | null;
  /** Working minutes past the due instant, for a breached clock or one that ended late; null otherwise. */
  workingMinutesLate: number | null;
}

/**
 * The state of the clock of one attempt: running, near its end, breached (past the due instant and not ended), met (settled in time), met late, or returned (in time or late). A returned dossier ends the clock of
 * its attempt: the next send starts a new attempt with a new clock. Without a calendar the state is judged on the instant that was kept; with neither the clock stays `RUNNING` and says why in `basis`.
 */
export function judgePaymentClock(input: PaymentClockInput): PaymentClockReading {
  const intervals = input.intervals ?? DEFAULT_WORKING_INTERVALS;
  const counted = input.dueAt === null ? clockDueAt(input.calendars, input.startedAt, input.workingDays, intervals) : { dueAt: input.dueAt, basis: 'WORKING_TIME' as const };
  const due = counted.dueAt;
  const basis = counted.basis;
  const lateBy = (to: Date): number | null => {
    if (due === null || to.getTime() <= due.getTime()) return null;
    if (input.calendars === undefined) return Math.max(0, Math.round((to.getTime() - due.getTime()) / 60_000));
    try {
      return workingMinutesBetween(input.calendars, due, to, intervals);
    } catch (failure) {
      if (failure instanceof DomainError && failure.code === 'CALENDAR_NOT_EFFECTIVE') return Math.max(0, Math.round((to.getTime() - due.getTime()) / 60_000));
      throw failure;
    }
  };
  if (input.endedAt !== null && input.endKind !== null) {
    const late = due !== null && input.endedAt.getTime() > due.getTime();
    const state: PaymentClockState = input.endKind === 'SETTLED' ? (late ? 'MET_LATE' : 'MET') : late ? 'RETURNED_LATE' : 'RETURNED';
    return { state, basis, dueAt: due, workingMinutesLeft: null, workingMinutesLate: late ? lateBy(input.endedAt) : null };
  }
  if (due === null) return { state: 'RUNNING', basis, dueAt: null, workingMinutesLeft: null, workingMinutesLate: null };
  if (input.now.getTime() > due.getTime()) return { state: 'BREACHED', basis, dueAt: due, workingMinutesLeft: 0, workingMinutesLate: lateBy(input.now) };
  let left: number | null = null;
  if (input.calendars !== undefined) {
    try {
      left = workingMinutesBetween(input.calendars, input.now, due, intervals);
    } catch (failure) {
      if (!(failure instanceof DomainError) || failure.code !== 'CALENDAR_NOT_EFFECTIVE') throw failure;
    }
  }
  const near = left !== null && left <= input.nearWorkingHours * 60;
  return { state: near ? 'NEAR' : 'RUNNING', basis, dueAt: due, workingMinutesLeft: left, workingMinutesLate: null };
}

/** Whether a state is one that waits for the Treasury (shown on the board and in the alert centre). */
export const isOpenClockState = (state: PaymentClockState): boolean => state === 'RUNNING' || state === 'NEAR' || state === 'BREACHED';

// -- What the board adds up -----------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ClockFact {
  kind: PaymentClockKind;
  state: PaymentClockState;
  returnReasonCode: string | null;
}

export interface ClockSummary {
  total: number;
  open: number;
  breached: number;
  near: number;
  /** Ended in time (settled in time, or returned in time) over those that ended; null when none ended. One decimal, half up, from whole numbers. */
  inTimeRatePct: string | null;
  returned: number;
  returnsByReason: Array<{ reasonCode: string | null; count: number }>;
}

function percentOneDecimal(numerator: number, denominator: number): string {
  const scaled = Math.floor((numerator * 1000 * 2 + denominator) / (2 * denominator));
  return `${Math.floor(scaled / 10)}.${scaled % 10}`;
}

/** The totals of a board from the rows it shows, never from percentages of parts. A return without a code is counted under `null` (the old returns of before the list), never dropped. */
export function summariseClocks(facts: readonly ClockFact[]): ClockSummary {
  let open = 0;
  let breached = 0;
  let near = 0;
  let ended = 0;
  let inTime = 0;
  let returned = 0;
  const reasons = new Map<string | null, number>();
  for (const fact of facts) {
    if (isOpenClockState(fact.state)) {
      open += 1;
      if (fact.state === 'BREACHED') breached += 1;
      if (fact.state === 'NEAR') near += 1;
      continue;
    }
    ended += 1;
    if (fact.state === 'MET' || fact.state === 'RETURNED') inTime += 1;
    if (fact.state === 'RETURNED' || fact.state === 'RETURNED_LATE') {
      returned += 1;
      reasons.set(fact.returnReasonCode, (reasons.get(fact.returnReasonCode) ?? 0) + 1);
    }
  }
  const returnsByReason = [...reasons.entries()].map(([reasonCode, count]) => ({ reasonCode, count })).sort((a, b) => b.count - a.count || String(a.reasonCode).localeCompare(String(b.reasonCode)));
  return { total: facts.length, open, breached, near, inTimeRatePct: ended === 0 ? null : percentOneDecimal(inTime, ended), returned, returnsByReason };
}
