import { DomainError } from './errors.ts';
import { CALENDAR_TIMEZONES, DAY_MS, MONTHLY_DEADLINE_DAY, QUARTERLY_DEADLINE_OFFSET_DAYS, YEARLY_DEADLINE_OFFSET_DAYS, dayOf, isoOf } from './reporting-calendar.ts';

/**
 * The reporting schedule of the enterprise edition (QT.02, ENT-4c): for each kind of period (month, quarter, year, steering meeting) and for the in-year plan adjustment, a deadline for EACH STEP of the chain a
 * period of figures goes through (entry, approval by the unit, review by the planning board, close of the period, push to the group system). The schedule is a governance rule (rule type `REPORTING_SCHEDULE`, one
 * code per kind): it is versioned, takes effect on a day and is approved by someone other than who proposed it, like every other threshold. This module is pure: it holds the shape of the rule, the built-in defaults, the
 * arithmetic of the deadlines and the decision of which reminder is due. The constant `MONTHLY_DEADLINE_DAY` of the calendar is now only the entry offset of the built-in monthly default.
 */

export const SCHEDULE_RULE_TYPE = 'REPORTING_SCHEDULE';

/** The kinds of period the schedule covers, and the in-year plan adjustment (a quarterly process with the same five steps). */
export const SCHEDULE_CODES = ['MONTH', 'QUARTER', 'YEAR', 'MEETING', 'PLAN_ADJUSTMENT'] as const;
export type ScheduleCode = (typeof SCHEDULE_CODES)[number];
export const isScheduleCode = (value: unknown): value is ScheduleCode => typeof value === 'string' && (SCHEDULE_CODES as readonly string[]).includes(value);

/** What a period of each code is counted from: its last day, or for a meeting the day it was held. */
export type ScheduleBasis = 'MONTH' | 'QUARTER' | 'YEAR' | 'MEETING';
export const BASIS_OF: Readonly<Record<ScheduleCode, ScheduleBasis>> = { MONTH: 'MONTH', QUARTER: 'QUARTER', YEAR: 'YEAR', MEETING: 'MEETING', PLAN_ADJUSTMENT: 'QUARTER' };

/** The steps of the chain, in the order they run. */
export const SCHEDULE_STEP_KINDS = ['ENTRY', 'UNIT_APPROVAL', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH'] as const;
export type ScheduleStepKind = (typeof SCHEDULE_STEP_KINDS)[number];

export interface ScheduleStep {
  kind: ScheduleStepKind;
  /** Days after the last day of the period (after the meeting day for a meeting). */
  offsetDays: number;
  /** Local time `HH:MM`; null means the deadline time of the reporting calendar. */
  time: string | null;
}

export interface SchedulePolicy {
  steps: ScheduleStep[];
  /** How many days before a deadline a reminder goes out, most distant first. */
  reminderDaysBefore: number[];
  /** Days between two reminders once a deadline has passed; 0 means one reminder only. */
  overdueRepeatDays: number;
  overdueMaxReminders: number;
  /** Days overdue after which the leader of the unit is told once; 0 means never. */
  escalateAfterOverdueDays: number;
}

export const SCHEDULE_TIMEZONE = 'Asia/Ho_Chi_Minh';
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MAX_STEP_OFFSET_DAYS = 366;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The built-in defaults. Every number is an assumption of the first release until the business owner signs the deadlines (D03): the rule says `UNVERIFIED`, and the screens say so. */
const DEFAULT_OFFSETS: Readonly<Record<ScheduleCode, readonly [number, number, number, number, number]>> = {
  MONTH: [MONTHLY_DEADLINE_DAY, 7, 10, 12, 15],
  QUARTER: [QUARTERLY_DEADLINE_OFFSET_DAYS, 13, 17, 20, 25],
  YEAR: [YEARLY_DEADLINE_OFFSET_DAYS, 30, 40, 45, 60],
  MEETING: [2, 4, 6, 8, 10],
  PLAN_ADJUSTMENT: [10, 15, 20, 25, 30],
};

export function scheduleDefaults(code: ScheduleCode): Record<string, unknown> {
  const offsets = DEFAULT_OFFSETS[code];
  return {
    steps: SCHEDULE_STEP_KINDS.map((kind, at) => ({ kind, offset_days: offsets[at] })),
    reminder_days_before: [3, 1],
    overdue_repeat_days: 1,
    overdue_max_reminders: 5,
    escalate_after_overdue_days: 3,
  };
}

/** Reads params that passed the schema into the policy. */
export function schedulePolicyOf(params: unknown): SchedulePolicy {
  const record = isRecord(params) ? params : {};
  const steps = Array.isArray(record.steps) ? record.steps.filter(isRecord) : [];
  return {
    steps: steps.map((raw) => ({ kind: raw.kind as ScheduleStepKind, offsetDays: Number(raw.offset_days), time: typeof raw.time === 'string' ? raw.time : null })),
    reminderDaysBefore: Array.isArray(record.reminder_days_before) ? record.reminder_days_before.map(Number) : [],
    overdueRepeatDays: Number(record.overdue_repeat_days ?? 0),
    overdueMaxReminders: Number(record.overdue_max_reminders ?? 0),
    escalateAfterOverdueDays: Number(record.escalate_after_overdue_days ?? 0),
  };
}

/** The field that makes params wrong, or undefined: five steps in the order of the chain, deadlines that never go back, reminders that are distinct and most distant first. */
export function scheduleDefect(params: Record<string, unknown>): string | undefined {
  const policy = schedulePolicyOf(params);
  if (policy.steps.length !== SCHEDULE_STEP_KINDS.length) return 'steps';
  for (let at = 0; at < policy.steps.length; at += 1) {
    const step = policy.steps[at] as ScheduleStep;
    if (step.kind !== SCHEDULE_STEP_KINDS[at]) return `steps[${at}].kind`;
    if (!Number.isInteger(step.offsetDays) || step.offsetDays < 0 || step.offsetDays > MAX_STEP_OFFSET_DAYS) return `steps[${at}].offset_days`;
    if (step.time !== null && !TIME.test(step.time)) return `steps[${at}].time`;
    if (at > 0 && goesBack(policy.steps[at - 1] as ScheduleStep, step)) return `steps[${at}].offset_days`;
  }
  for (let at = 1; at < policy.reminderDaysBefore.length; at += 1) if ((policy.reminderDaysBefore[at] as number) >= (policy.reminderDaysBefore[at - 1] as number)) return 'reminder_days_before';
  if (policy.overdueRepeatDays === 0 && policy.overdueMaxReminders > 1) return 'overdue_max_reminders';
  return undefined;
}

/** Whether a step is due before the one that precedes it. The same day with a step that has no time of its own cannot be judged (the time of the calendar is not known to the rule), so it is accepted. */
const goesBack = (previous: ScheduleStep, step: ScheduleStep): boolean =>
  step.offsetDays < previous.offsetDays || (step.offsetDays === previous.offsetDays && step.time !== null && previous.time !== null && step.time < previous.time);

// -- Periods -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A period as the schedule needs it: a code, the days it covers and the day its steps are counted from. */
export interface SchedulePeriod {
  code: string;
  basis: ScheduleBasis;
  year: number;
  number: number;
  startsOn: string;
  endsOn: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');
const monthStart = (year: number, month: number): number => Math.floor(Date.UTC(year, month - 1, 1) / DAY_MS);

/** The periods of a basis in a year (a steering meeting is not a period of the year: it is a day someone holds one). */
export function schedulePeriods(basis: Exclude<ScheduleBasis, 'MEETING'>, year: number): SchedulePeriod[] {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) throw new DomainError('VALIDATION_FAILED', 422, 'year');
  if (basis === 'YEAR') return [{ code: `Y${year}`, basis, year, number: 1, startsOn: isoOf(monthStart(year, 1)), endsOn: isoOf(monthStart(year + 1, 1) - 1) }];
  const length = basis === 'MONTH' ? 1 : 3;
  const count = 12 / length;
  return Array.from({ length: count }, (_, at) => {
    const number = at + 1;
    const first = at * length + 1;
    return { code: basis === 'MONTH' ? `M${year}-${pad(number)}` : `Q${year}-${number}`, basis, year, number, startsOn: isoOf(monthStart(year, first)), endsOn: isoOf(monthStart(year, first + length) - 1) };
  });
}

/** The pseudo-period of a steering meeting: the day it was held. */
export function meetingPeriod(code: string, meetingDate: string): SchedulePeriod {
  return { code, basis: 'MEETING', year: Number(meetingDate.slice(0, 4)), number: 1, startsOn: meetingDate, endsOn: meetingDate };
}

// -- Deadlines -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface StepDeadline {
  kind: ScheduleStepKind;
  /** The instant the step is due, in UTC. */
  dueAt: string;
  /** The local day and time it is due, for the screen. */
  dueOn: string;
  dueTime: string;
}

/** The deadline of each step of a period: the end of the period plus the offset of the step, at the time of the step or, with none, the deadline time of the calendar, in the zone of the calendar. */
export function stepDeadlines(policy: SchedulePolicy, period: Pick<SchedulePeriod, 'endsOn'>, calendarTime: string, timezone: string = SCHEDULE_TIMEZONE, entryDueAt?: string): StepDeadline[] {
  if (!Object.hasOwn(CALENDAR_TIMEZONES, timezone)) throw new DomainError('VALIDATION_FAILED', 422, 'timezone');
  if (!TIME.test(calendarTime)) throw new DomainError('VALIDATION_FAILED', 422, 'deadline_time');
  const zone = CALENDAR_TIMEZONES[timezone] as number;
  const end = dayOf(period.endsOn);
  return policy.steps.map((step) => {
    // A period that exists keeps the entry deadline it was generated with: a newer rule moves the periods generated after it and none that exist (no retroactive change).
    if (step.kind === 'ENTRY' && entryDueAt !== undefined) {
      const local = new Date(Date.parse(entryDueAt) + zone * 60_000);
      return { kind: step.kind, dueAt: new Date(entryDueAt).toISOString(), dueOn: isoOf(Math.floor(local.getTime() / DAY_MS)), dueTime: localTimeOf(entryDueAt, timezone) };
    }
    const time = step.time ?? calendarTime;
    const [hours, minutes] = time.split(':').map(Number) as [number, number];
    const day = end + step.offsetDays;
    return { kind: step.kind, dueAt: new Date(day * DAY_MS + (hours * 60 + minutes - zone) * 60_000).toISOString(), dueOn: isoOf(day), dueTime: time };
  });
}

/** The deadline of the entry step: what a period stores as its deadline (the moment a report is late). */
export function entryDeadline(policy: SchedulePolicy, period: Pick<SchedulePeriod, 'endsOn'>, calendarTime: string, timezone?: string): string {
  const entry = stepDeadlines(policy, period, calendarTime, timezone).find((step) => step.kind === 'ENTRY');
  if (entry === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'steps');
  return entry.dueAt;
}

/** The offset of the entry step, which the generator of the periods of a kind uses as their deadline. */
export function entryOffsetOf(policy: SchedulePolicy): number {
  return policy.steps.find((step) => step.kind === 'ENTRY')?.offsetDays ?? MONTHLY_DEADLINE_DAY;
}

// -- State of a step -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SCHEDULE_STEP_STATES = ['DONE', 'DONE_LATE', 'DUE_SOON', 'OPEN', 'OVERDUE', 'NOT_TRACKED'] as const;
export type ScheduleStepState = (typeof SCHEDULE_STEP_STATES)[number];

/** How many days before a deadline a step counts as due soon on the board. */
export const SCHEDULE_DUE_SOON_DAYS = 3;

/**
 * Where a step stands. `doneAt` is the instant the step was finished, `null` when it is not finished, `undefined` when the platform has no fact about this step (it is not tracked yet): a step is never shown as done
 * or open without a fact, and "not tracked" is its own word.
 */
export function scheduleStepState(dueAt: string, doneAt: string | null | undefined, now: Date): ScheduleStepState {
  if (doneAt === undefined) return 'NOT_TRACKED';
  const due = Date.parse(dueAt);
  if (doneAt !== null) return Date.parse(doneAt) > due ? 'DONE_LATE' : 'DONE';
  if (now.getTime() > due) return 'OVERDUE';
  return due - now.getTime() <= SCHEDULE_DUE_SOON_DAYS * DAY_MS ? 'DUE_SOON' : 'OPEN';
}

/** Whole days a deadline is past at `now` (0 when it is not). */
export const daysOverdue = (dueAt: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(dueAt)) / DAY_MS));

// -- Reminders -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SCHEDULE_REMINDER_KINDS = ['BEFORE_DUE', 'OVERDUE', 'ESCALATED'] as const;
export type ScheduleReminderKind = (typeof SCHEDULE_REMINDER_KINDS)[number];

export interface DueReminder {
  kind: ScheduleReminderKind;
  /** 1-based number in the series of its kind; the series key of the store is the period, the unit, the step, the kind and this number. */
  ordinal: number;
  /** The instant the reminder became due. */
  dueAt: string;
}

/**
 * The reminder to send now for a step that is not finished, given which ordinals of each kind were already sent. Only the newest reminder that is due and not sent is returned: a job that was down for two days sends
 * one reminder, not a burst of the ones it missed. Before the deadline the reminders are those of `reminderDaysBefore` (a reminder that falls before the step could have been asked for, the day the period ended, is
 * not sent); after it, one at the deadline and then every `overdueRepeatDays` up to `overdueMaxReminders`, and one escalation once `escalateAfterOverdueDays` have passed.
 */
export function reminderDue(policy: SchedulePolicy, dueAt: string, now: Date, sent: Readonly<Record<ScheduleReminderKind, readonly number[]>>, periodEndsOn?: string): DueReminder | undefined {
  const due = Date.parse(dueAt);
  const at = now.getTime();
  const has = (kind: ScheduleReminderKind, ordinal: number): boolean => sent[kind].includes(ordinal);
  if (at > due) {
    if (policy.escalateAfterOverdueDays > 0 && at >= due + policy.escalateAfterOverdueDays * DAY_MS && !has('ESCALATED', 1)) return { kind: 'ESCALATED', ordinal: 1, dueAt: new Date(due + policy.escalateAfterOverdueDays * DAY_MS).toISOString() };
    if (policy.overdueMaxReminders > 0) {
      const gap = policy.overdueRepeatDays * DAY_MS;
      const reached = gap === 0 ? 1 : Math.floor((at - due) / gap) + 1;
      // Only the newest overdue reminder counts: an older one that was skipped stays skipped.
      const ordinal = Math.min(reached, policy.overdueMaxReminders);
      if (!has('OVERDUE', ordinal)) return { kind: 'OVERDUE', ordinal, dueAt: new Date(due + (ordinal - 1) * gap).toISOString() };
    }
    return undefined;
  }
  const floor = periodEndsOn === undefined ? Number.NEGATIVE_INFINITY : dayOf(periodEndsOn) * DAY_MS;
  for (let index = policy.reminderDaysBefore.length - 1; index >= 0; index -= 1) {
    const moment = due - (policy.reminderDaysBefore[index] as number) * DAY_MS;
    if (at >= moment && moment >= floor) return has('BEFORE_DUE', index + 1) ? undefined : { kind: 'BEFORE_DUE', ordinal: index + 1, dueAt: new Date(moment).toISOString() };
  }
  return undefined;
}

/** The alert type that stands for each kind of reminder (rule type `ALERT_TYPE`): who owns it, what is expected and what happens when nothing is done. */
export const REMINDER_ALERT_TYPES: Readonly<Record<ScheduleReminderKind, string>> = { BEFORE_DUE: 'REPORTING_STEP_DUE_SOON', OVERDUE: 'REPORTING_STEP_OVERDUE', ESCALATED: 'REPORTING_STEP_ESCALATED' };

/** The events the reminder job writes to the outbox; a tenant picks the channels, and the people the escalation goes to, with a notification workflow of each type. */
export const CALENDAR_REMINDER_EVENT = 'dis.calendar_step.reminded.v1';
export const CALENDAR_ESCALATION_EVENT = 'dis.calendar_step.escalated.v1';
export const reminderEventOf = (kind: ScheduleReminderKind): string => (kind === 'ESCALATED' ? CALENDAR_ESCALATION_EVENT : CALENDAR_REMINDER_EVENT);

// -- The calendar --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const CALENDAR_ITEM_KINDS = ['REPORT_PERIOD', 'PLAN_ADJUSTMENT', 'MEETING', 'DIRECTIVE_DUE'] as const;
export type CalendarItemKind = (typeof CALENDAR_ITEM_KINDS)[number];

/** The schedule code a calendar item kind runs on, or undefined when it has no steps of its own (a directive follows the clock of its own module). */
export function scheduleCodeOf(kind: CalendarItemKind, basis: ScheduleBasis): ScheduleCode | undefined {
  if (kind === 'REPORT_PERIOD') return basis === 'MEETING' ? undefined : basis;
  if (kind === 'PLAN_ADJUSTMENT') return 'PLAN_ADJUSTMENT';
  if (kind === 'MEETING') return 'MEETING';
  return undefined;
}

/**
 * The local time of day of an instant in the zone of the calendar, `HH:MM`. A period stores the instant its entry step is due; that instant carries the deadline time of the reporting calendar it was generated with, which the steps
 * without a time of their own follow.
 */
export function localTimeOf(instant: string, timezone: string = SCHEDULE_TIMEZONE): string {
  if (!Object.hasOwn(CALENDAR_TIMEZONES, timezone)) throw new DomainError('VALIDATION_FAILED', 422, 'timezone');
  const local = new Date(Date.parse(instant) + (CALENDAR_TIMEZONES[timezone] as number) * 60_000);
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}
