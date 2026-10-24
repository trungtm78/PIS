import { DomainError } from './errors.ts';
import { dayOf, isoOf, weekdayOf } from './reporting-calendar.ts';
import { shiftDays } from './effective-period.ts';

/** How often a rule asks for a report (the `frequency` of an obligation rule, MNE 7). */
export const MNE_FREQUENCIES = ['WEEKLY', 'SEMIANNUAL', 'ANNUAL', 'EVENT'] as const;
export type MneFrequency = (typeof MNE_FREQUENCIES)[number];

/** The project events that start an EVENT obligation (PRJ `project.stage_changed` to IMPLEMENTATION and COMPLETED, `project.revised`). */
export const MNE_EVENTS = ['PROJECT_START', 'PROJECT_ADJUSTED', 'PROJECT_COMPLETED'] as const;
export type MneEvent = (typeof MNE_EVENTS)[number];

const WEEKDAY_CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const SEMIANNUAL_PERIODS = ['H1', 'H2'] as const;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CALENDAR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** A rule has to land in the next years at most: a longer offset is a typing mistake, not a deadline. */
const MAX_YEAR_OFFSET = 2;
const MAX_DAYS_AFTER = 366;
/** The longest run of holidays that a shift to the next working day walks through before it gives up. */
const MAX_SHIFT_DAYS = 31;
/** February 29 is refused: a deadline that exists in one year of four is not a deadline. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

interface RuleBase {
  /** BR-MNE-03: a deadline on a day off moves to the next working day only when the rule says so. */
  shiftOnHoliday: boolean;
  /** The working calendar (ADM) that decides which days are off; required with `shiftOnHoliday`. */
  calendarCode: string | null;
}

export interface FixedDateRule extends RuleBase {
  frequency: 'SEMIANNUAL' | 'ANNUAL';
  /** `H1`, `H2` or `YEAR`: the period the report is about. */
  period: 'H1' | 'H2' | 'YEAR';
  month: number;
  day: number;
  /** How many calendar years after the year of the period the deadline falls (an annual report is due in February of the next year). */
  yearOffset: number;
}

export interface WeeklyRule extends RuleBase {
  frequency: 'WEEKLY';
  /** Monday is 0. */
  weekday: number;
  weekdayCode: string;
  /** Local time `HH:MM` of the deadline; the obligation stores the day and shows the time. */
  time: string;
}

export interface EventRule extends RuleBase {
  frequency: 'EVENT';
  event: MneEvent;
  daysAfter: number;
}

export type DueRule = FixedDateRule | WeeklyRule | EventRule;

export interface ReportPeriod {
  /** `H1-2026`, `H2-2026` or `YEAR-2026`. */
  label: string;
  /** The last day of the period, the day the revision in force is judged on (BR-MNE-02). */
  endsOn: string;
}

type Raw = Record<string, unknown>;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, `due_rule_json.${field}`);
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

function integerOf(raw: Raw, key: string, min: number, max: number, fallback?: number): number {
  const value = raw[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(key);
  return value;
}

function textOf(raw: Raw, key: string, allowed: readonly string[]): string {
  const value = raw[key];
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid(key);
  return value;
}

function shiftOf(raw: Raw): RuleBase {
  const flag = raw.shift_on_holiday;
  if (flag !== undefined && typeof flag !== 'boolean') throw invalid('shift_on_holiday');
  const code = raw.calendar_code;
  if (code !== undefined && (typeof code !== 'string' || !CALENDAR_CODE.test(code))) throw invalid('calendar_code');
  const shiftOnHoliday = flag === true;
  // A shift needs the calendar that says which days are off; a calendar without a shift would be a rule that does nothing.
  if (shiftOnHoliday !== (code !== undefined)) throw invalid(shiftOnHoliday ? 'calendar_code' : 'shift_on_holiday');
  return { shiftOnHoliday, calendarCode: code === undefined ? null : (code as string) };
}

function assertKeys(raw: Raw, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) if (!allowed.includes(key) && key !== 'shift_on_holiday' && key !== 'calendar_code') throw invalid(key);
}

function fixedDateRule(frequency: 'SEMIANNUAL' | 'ANNUAL', raw: Raw): FixedDateRule {
  assertKeys(raw, ['period', 'month', 'day', 'year_offset']);
  const period = textOf(raw, 'period', frequency === 'ANNUAL' ? ['YEAR'] : SEMIANNUAL_PERIODS) as FixedDateRule['period'];
  const month = integerOf(raw, 'month', 1, 12);
  const day = integerOf(raw, 'day', 1, DAYS_IN_MONTH[month - 1] as number);
  const yearOffset = integerOf(raw, 'year_offset', 0, MAX_YEAR_OFFSET, 0);
  const rule: FixedDateRule = { frequency, period, month, day, yearOffset, ...shiftOf(raw) };
  // The report is about a period that has ended: a deadline on or before its last day is a mistake in the rule.
  const reference = 2027;
  if (fixedDueDate(rule, reference) <= reportPeriodOf(rule, reference).endsOn) throw invalid('month');
  return rule;
}

function weeklyRule(raw: Raw): WeeklyRule {
  assertKeys(raw, ['weekly', 'time']);
  const weekdayCode = textOf(raw, 'weekly', WEEKDAY_CODES);
  const time = raw.time === undefined ? '23:59' : raw.time;
  if (typeof time !== 'string' || !CLOCK.test(time)) throw invalid('time');
  return { frequency: 'WEEKLY', weekday: WEEKDAY_CODES.indexOf(weekdayCode as (typeof WEEKDAY_CODES)[number]), weekdayCode, time, ...shiftOf(raw) };
}

function eventRule(raw: Raw): EventRule {
  assertKeys(raw, ['event', 'days_after']);
  return { frequency: 'EVENT', event: textOf(raw, 'event', MNE_EVENTS) as MneEvent, daysAfter: integerOf(raw, 'days_after', 0, MAX_DAYS_AFTER), ...shiftOf(raw) };
}

/**
 * Reads the `due_rule_json` of an obligation rule for its frequency (BR-MNE-03). Anything the rule does not define is refused, so a
 * mistyped key never falls back to a default that nobody chose. The answer is 422 naming the field.
 */
export function parseDueRule(frequency: string, json: unknown): DueRule {
  if (!isRecord(json)) throw new DomainError('VALIDATION_FAILED', 422, 'due_rule_json');
  switch (frequency) {
    case 'SEMIANNUAL':
    case 'ANNUAL':
      return fixedDateRule(frequency, json);
    case 'WEEKLY':
      return weeklyRule(json);
    case 'EVENT':
      return eventRule(json);
    default:
      throw new DomainError('VALIDATION_FAILED', 422, 'frequency');
  }
}

/** The period of a half-year or yearly rule in a year: its label and its last day. */
export function reportPeriodOf(rule: FixedDateRule, year: number): ReportPeriod {
  const endsOn = rule.period === 'H1' ? `${year}-06-30` : `${year}-12-31`;
  return { label: `${rule.period}-${year}`, endsOn };
}

function fixedDueDate(rule: FixedDateRule, year: number): string {
  return `${year + rule.yearOffset}-${String(rule.month).padStart(2, '0')}-${String(rule.day).padStart(2, '0')}`;
}

/** The first day on or after `date` that `isWorkingDay` accepts. */
export function nextWorkingDay(date: string, isWorkingDay: (date: string) => boolean): string {
  for (let step = 0; step <= MAX_SHIFT_DAYS; step += 1) {
    const candidate = shiftDays(date, step);
    if (isWorkingDay(candidate)) return candidate;
  }
  throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
}

/** What decides which days are off for a rule that shifts: the calendar named by the rule, asked for a date. */
export type WorkingDayTest = (calendarCode: string, date: string) => boolean;

function shifted(rule: DueRule, date: string, working: WorkingDayTest | undefined): string {
  if (!rule.shiftOnHoliday) return date;
  const { calendarCode } = rule;
  if (working === undefined || calendarCode === null) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
  return nextWorkingDay(date, (candidate) => working(calendarCode, candidate));
}

/** The deadline of the half-year or yearly report of a year ("before the 10th of July" is stored as the 10th, the last day to file). */
export function periodicDueDate(rule: FixedDateRule, year: number, working?: WorkingDayTest): string {
  return shifted(rule, fixedDueDate(rule, year), working);
}

/** The deadline of the weekly report of the week that begins on `startsOn`: the first such weekday on or after it. */
export function weeklyDueDate(rule: WeeklyRule, startsOn: string, working?: WorkingDayTest): string {
  const start = dayOf(startsOn);
  const offset = (rule.weekday - weekdayOf(start) + 7) % 7;
  return shifted(rule, isoOf(start + offset), working);
}

/** The deadline of a report that an event starts: the event day and the days the rule allows after it. */
export function eventDueDate(rule: EventRule, eventDate: string, working?: WorkingDayTest): string {
  return shifted(rule, shiftDays(eventDate, rule.daysAfter), working);
}
