import { DomainError } from './errors.ts';
import { isWorkingDay } from './working-time.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The pure helpers that every process of the platform shares (R29 of the PWF review): the arithmetic of calendar days written `YYYY-MM-DD`, and the count of working days on the calendars of a tenant. The procurement workflow (PRC-1,
 * bid-workflow.ts) and the project workflow (PWF, project-schedule.ts, deadline-band.ts) both count in these, so the rule "a day without a published calendar is never guessed" exists once. bid-workflow.ts re-exports these under the
 * names it always had, so no caller of PRC-1 changes.
 */

const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A scan never runs further than this many days (an empty calendar must not loop for ever). */
export const MAX_SCAN_DAYS = 3 * 366;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isWorkflowDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}
export const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
export const dayText = (number: number): string => new Date(number * DAY_MS).toISOString().slice(0, 10);
export const workflowAddDays = (day: string, days: number): string => dayText(dayNumber(day) + days);
/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export const workflowDaysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/**
 * The day on which `days` working days, counted from `from`, have passed (the day of entry is day 0): `from` itself for 0, else the day on which the count of working days after `from` reaches `days`.
 * A year without a published calendar gives `undefined` (a deadline is never guessed with a weekly pattern, as in the clocks of the alert centre).
 */
export function addWorkingDays(calendars: WorkCalendarSource | undefined, from: string, days: number): string | undefined {
  if (!isWorkflowDay(from) || !Number.isInteger(days) || days < 0) throw invalid('days');
  if (days === 0) return from;
  if (calendars === undefined) return undefined;
  let counted = 0;
  const start = dayNumber(from);
  for (let offset = 1; offset <= MAX_SCAN_DAYS; offset += 1) {
    const day = dayText(start + offset);
    const calendar = calendars.forYear(Number(day.slice(0, 4)));
    if (calendar === undefined) return undefined;
    if (!isWorkingDay(calendar, day)) continue;
    counted += 1;
    if (counted === days) return day;
  }
  return undefined;
}

/** The working days that lie after `from` up to and including `to` (0 when `to` is not later); `undefined` when a year in between has no calendar. */
export function workingDaysBetween(calendars: WorkCalendarSource | undefined, from: string, to: string): number | undefined {
  if (!isWorkflowDay(from) || !isWorkflowDay(to)) throw invalid('days');
  if (dayNumber(to) <= dayNumber(from)) return 0;
  if (calendars === undefined) return undefined;
  if (dayNumber(to) - dayNumber(from) > MAX_SCAN_DAYS) return undefined;
  let counted = 0;
  const end = dayNumber(to);
  let number = dayNumber(from) + 1;
  while (number <= end) {
    // The calendar is asked once for each year the count passes through, and a day already judged on a calendar is not judged again (a period of thousands of tasks counts the same days over and over).
    const year = new Date(number * DAY_MS).getUTCFullYear();
    const calendar = calendars.forYear(year);
    if (calendar === undefined) return undefined;
    const last = Math.min(end, Date.UTC(year + 1, 0, 1) / DAY_MS - 1);
    for (; number <= last; number += 1) if (workingOn(calendar, number)) counted += 1;
  }
  return counted;
}

const JUDGED = new WeakMap<object, Map<number, boolean>>();

/** Whether the day (by number) is a working day of the calendar, remembered per calendar version object. */
function workingOn(calendar: Parameters<typeof isWorkingDay>[0], number: number): boolean {
  let memo = JUDGED.get(calendar);
  if (memo === undefined) {
    memo = new Map();
    JUDGED.set(calendar, memo);
  }
  let judged = memo.get(number);
  if (judged === undefined) {
    judged = isWorkingDay(calendar, dayText(number));
    memo.set(number, judged);
  }
  return judged;
}
