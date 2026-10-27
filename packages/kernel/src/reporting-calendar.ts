import { DomainError } from './errors.ts';

export const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The time zones a calendar may name, with their offset from UTC in minutes. Vietnam has no daylight saving, so the offset is fixed (BR-MDM-08). */
export const CALENDAR_TIMEZONES: Readonly<Record<string, number>> = { 'Asia/Ho_Chi_Minh': 7 * 60 };

const DEADLINE_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** 1970-01-01 was a Thursday: with Monday as day 0, day 0 of the epoch is day 3 of the week. */
const EPOCH_WEEKDAY = 3;

/** How a tenant counts its reporting weeks (MDM 3.1 BR-MDM-08). The definition is data; a version of it is a version of the master record. */
export interface CalendarDefinition {
  weekStartsOn: Weekday;
  /** The weekday on which the report is due, at `deadlineTime`; the first such day on or after the start of the period. */
  deadlineWeekday: Weekday;
  /** Local time, `HH:MM`. */
  deadlineTime: string;
  timezone: string;
}

export interface ReportingPeriod {
  /** `W<year>-<number>`: the year and the number of the week are those of its last day, so no day belongs to two periods or to none. */
  code: string;
  year: number;
  number: number;
  startsOn: string;
  endsOn: string;
  /** The instant the report is due, in UTC (`...Z`). */
  deadlineAt: string;
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
/** Day arithmetic shared with the working-time calendar of ADM (days since 1970-01-01, Monday as weekday 0). */
export const isoOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
export const dayOf = (date: string): number => {
  const [year, month, dayOfMonth] = date.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, dayOfMonth) / DAY_MS);
};
export const weekdayOf = (day: number): number => (((day + EPOCH_WEEKDAY) % WEEK_DAYS) + WEEK_DAYS) % WEEK_DAYS;
const dayOfYear = (day: number): number => day - Math.floor(Date.UTC(new Date(day * DAY_MS).getUTCFullYear(), 0, 1) / DAY_MS) + 1;

/** Refuses a definition that cannot produce a calendar (an unknown weekday or zone, a time that is not `HH:MM`). */
export function assertCalendar(calendar: CalendarDefinition): void {
  if (!WEEKDAYS.includes(calendar.weekStartsOn)) throw new DomainError('VALIDATION_FAILED', 422, 'attributes.week_starts_on');
  if (!WEEKDAYS.includes(calendar.deadlineWeekday)) throw new DomainError('VALIDATION_FAILED', 422, 'attributes.deadline_weekday');
  if (!DEADLINE_TIME.test(calendar.deadlineTime)) throw new DomainError('VALIDATION_FAILED', 422, 'attributes.deadline_time');
  if (!Object.hasOwn(CALENDAR_TIMEZONES, calendar.timezone)) throw new DomainError('VALIDATION_FAILED', 422, 'attributes.timezone');
}

function periodStartingOn(calendar: CalendarDefinition, start: number): ReportingPeriod {
  const end = start + WEEK_DAYS - 1;
  const year = new Date(end * DAY_MS).getUTCFullYear();
  const number = Math.floor((dayOfYear(end) - 1) / WEEK_DAYS) + 1;
  // The deadline falls on the first such weekday of the period: Saturday to Friday with a Friday deadline is the last day.
  const offset = (WEEKDAYS.indexOf(calendar.deadlineWeekday) - weekdayOf(start) + WEEK_DAYS) % WEEK_DAYS;
  const [hours, minutes] = calendar.deadlineTime.split(':').map(Number) as [number, number];
  const zone = CALENDAR_TIMEZONES[calendar.timezone] as number;
  const deadline = new Date(start * DAY_MS + offset * DAY_MS + (hours * 60 + minutes - zone) * 60_000);
  return { code: `W${year}-${pad(number)}`, year, number, startsOn: isoOf(start), endsOn: isoOf(end), deadlineAt: deadline.toISOString() };
}

/** The period that contains a business date (`YYYY-MM-DD`). */
export function periodOf(calendar: CalendarDefinition, date: string): ReportingPeriod {
  assertCalendar(calendar);
  const day = dayOf(date);
  const startWeekday = WEEKDAYS.indexOf(calendar.weekStartsOn);
  return periodStartingOn(calendar, day - ((weekdayOf(day) - startWeekday + WEEK_DAYS) % WEEK_DAYS));
}

/** Every period of a year, in order, with no gap and no overlap: the periods whose last day is in that year. */
export function reportingPeriods(calendar: CalendarDefinition, year: number): ReportingPeriod[] {
  assertCalendar(calendar);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) throw new DomainError('VALIDATION_FAILED', 422, 'year');
  const endWeekday = (WEEKDAYS.indexOf(calendar.weekStartsOn) + WEEK_DAYS - 1) % WEEK_DAYS;
  const january = dayOf(`${year}-01-01`);
  const firstEnd = january + ((endWeekday - weekdayOf(january) + WEEK_DAYS) % WEEK_DAYS);
  const periods: ReportingPeriod[] = [];
  for (let end = firstEnd; new Date(end * DAY_MS).getUTCFullYear() === year; end += WEEK_DAYS) periods.push(periodStartingOn(calendar, end - WEEK_DAYS + 1));
  return periods;
}

/** Whether a report handed in at `at` is late for a period (`at` after the deadline; the deadline itself is still in time). */
export const isLate = (period: Pick<ReportingPeriod, 'deadlineAt'>, at: Date): boolean => at.getTime() > Date.parse(period.deadlineAt);

/**
 * The monthly period (ST-DIS-015, an assumption of the first release until the business owner signs the deadline, D03): a calendar month, due on the 5th of the next month at the deadline time of
 * the calendar, in its time zone. The calendar definition holds the weekly rule only; the monthly one is a constant until it is data.
 */
export const MONTHLY_DEADLINE_DAY = 5;

function monthPeriod(calendar: CalendarDefinition, year: number, month: number): ReportingPeriod {
  const first = Math.floor(Date.UTC(year, month - 1, 1) / DAY_MS);
  const last = Math.floor(Date.UTC(year, month, 1) / DAY_MS) - 1;
  const [hours, minutes] = calendar.deadlineTime.split(':').map(Number) as [number, number];
  const zone = CALENDAR_TIMEZONES[calendar.timezone] as number;
  const deadline = new Date(Date.UTC(year, month, MONTHLY_DEADLINE_DAY) + (hours * 60 + minutes - zone) * 60_000);
  return { code: `M${year}-${pad(month)}`, year, number: month, startsOn: isoOf(first), endsOn: isoOf(last), deadlineAt: deadline.toISOString() };
}

/** The twelve monthly periods of a year, in order, with no gap and no overlap. */
export function monthlyPeriods(calendar: CalendarDefinition, year: number): ReportingPeriod[] {
  assertCalendar(calendar);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) throw new DomainError('VALIDATION_FAILED', 422, 'year');
  return Array.from({ length: 12 }, (_, n) => monthPeriod(calendar, year, n + 1));
}

/** The monthly period that contains a business date (`YYYY-MM-DD`). */
export function monthlyPeriodOf(calendar: CalendarDefinition, date: string): ReportingPeriod {
  assertCalendar(calendar);
  const [year, month] = date.split('-').map(Number) as [number, number];
  return monthPeriod(calendar, year, month);
}

/** The period of a type that contains a date: the deadline of a period is judged by its type. */
export function periodOfType(calendar: CalendarDefinition, periodType: string, date: string): ReportingPeriod {
  return periodType === 'MONTH' ? monthlyPeriodOf(calendar, date) : periodOf(calendar, date);
}
