/**
 * The reporting periods of a calendar, for the preview of MDM-11 and of the calendar form. The rule is the one of
 * packages/kernel/src/reporting-calendar.ts (the server generates the periods that are stored); both are held to the same answers by
 * packages/contracts/test-vectors/reporting-calendar.json, so the preview shows what the server will generate.
 */

export const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The zones of a calendar, with their offset from UTC in minutes (Vietnam has no daylight saving). */
const TIMEZONES: Readonly<Record<string, number>> = { 'Asia/Ho_Chi_Minh': 7 * 60 };
const DEADLINE_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;
const WEEK = 7;
/** 1970-01-01 was a Thursday: with Monday as day 0 the epoch is day 3 of the week. */
const EPOCH_WEEKDAY = 3;

export interface CalendarDefinition {
  weekStartsOn: Weekday;
  deadlineWeekday: Weekday;
  deadlineTime: string;
  timezone: string;
}

export interface ReportingPeriod {
  code: string;
  year: number;
  number: number;
  startsOn: string;
  endsOn: string;
  deadlineAt: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');
const isoOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const dayOf = (date: string): number => {
  const [year, month, dayOfMonth] = date.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, dayOfMonth) / DAY_MS);
};
const weekdayOf = (day: number): number => (((day + EPOCH_WEEKDAY) % WEEK) + WEEK) % WEEK;
const dayOfYear = (day: number): number => day - Math.floor(Date.UTC(new Date(day * DAY_MS).getUTCFullYear(), 0, 1) / DAY_MS) + 1;

const isWeekday = (value: unknown): value is Weekday => typeof value === 'string' && (WEEKDAYS as readonly string[]).includes(value);

/** The calendar that an attributes object describes, or undefined when it does not describe one (the form is still being filled). */
export function calendarOf(attributes: Record<string, unknown>): CalendarDefinition | undefined {
  const { week_starts_on: weekStartsOn, deadline_weekday: deadlineWeekday, deadline_time: deadlineTime, timezone } = attributes;
  if (!isWeekday(weekStartsOn) || !isWeekday(deadlineWeekday)) return undefined;
  if (typeof deadlineTime !== 'string' || !DEADLINE_TIME.test(deadlineTime)) return undefined;
  if (typeof timezone !== 'string' || !Object.hasOwn(TIMEZONES, timezone)) return undefined;
  return { weekStartsOn, deadlineWeekday, deadlineTime, timezone };
}

function periodStartingOn(calendar: CalendarDefinition, start: number): ReportingPeriod {
  const end = start + WEEK - 1;
  const year = new Date(end * DAY_MS).getUTCFullYear();
  const number = Math.floor((dayOfYear(end) - 1) / WEEK) + 1;
  const offset = (WEEKDAYS.indexOf(calendar.deadlineWeekday) - weekdayOf(start) + WEEK) % WEEK;
  const [hours, minutes] = calendar.deadlineTime.split(':').map(Number) as [number, number];
  const zone = TIMEZONES[calendar.timezone] as number;
  const deadline = new Date(start * DAY_MS + offset * DAY_MS + (hours * 60 + minutes - zone) * 60_000);
  return { code: `W${year}-${pad(number)}`, year, number, startsOn: isoOf(start), endsOn: isoOf(end), deadlineAt: deadline.toISOString() };
}

/** The period that contains a business date (`YYYY-MM-DD`). */
export function periodOf(calendar: CalendarDefinition, date: string): ReportingPeriod {
  const day = dayOf(date);
  return periodStartingOn(calendar, day - ((weekdayOf(day) - WEEKDAYS.indexOf(calendar.weekStartsOn) + WEEK) % WEEK));
}

/** Every period of a year, in order: the periods whose last day is in that year. */
export function reportingPeriods(calendar: CalendarDefinition, year: number): ReportingPeriod[] {
  const endWeekday = (WEEKDAYS.indexOf(calendar.weekStartsOn) + WEEK - 1) % WEEK;
  const january = dayOf(`${year}-01-01`);
  const firstEnd = january + ((endWeekday - weekdayOf(january) + WEEK) % WEEK);
  const periods: ReportingPeriod[] = [];
  for (let end = firstEnd; new Date(end * DAY_MS).getUTCFullYear() === year; end += WEEK) periods.push(periodStartingOn(calendar, end - WEEK + 1));
  return periods;
}

/** The `count` periods from the one that contains `from`: what a calendar that starts on that date would produce first. */
export function periodsFrom(calendar: CalendarDefinition, from: string, count: number): ReportingPeriod[] {
  const first = periodOf(calendar, from);
  const start = dayOf(first.startsOn);
  return Array.from({ length: count }, (_unused, index) => periodStartingOn(calendar, start + index * WEEK));
}
