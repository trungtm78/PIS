import { DomainError } from './errors.ts';
import { findingOf } from './rule-findings.ts';
import type { RuleFinding } from './rule-findings.ts';
import { CALENDAR_TIMEZONES, DAY_MS, dayOf, isoOf, weekdayOf } from './reporting-calendar.ts';

/**
 * The working-time calendar of a tenant (ADM 3.8, BR-ADM-08): which days are worked and how long a deadline lasts when it is
 * counted in working hours. It answers "when does a task created now fall due"; it does not say which reporting week a report
 * belongs to, which is the reporting calendar of MDM (reporting-calendar.ts). The two share the day arithmetic and the zone.
 */

/** The zone in which working hours are read. Vietnam has no daylight saving, so the offset is fixed (see CALENDAR_TIMEZONES). */
export const WORKING_TIME_ZONE = 'Asia/Ho_Chi_Minh';

/** A span of the day that counts as working time, in local time. */
export interface WorkingInterval {
  from: string;
  to: string;
}

/** BR-ADM-08: 08:00-12:00 and 13:00-17:00. The tables carry no tenant-specific hours yet (TODOS.md, ST-ADM-010). */
export const DEFAULT_WORKING_INTERVALS: readonly WorkingInterval[] = [
  { from: '08:00', to: '12:00' },
  { from: '13:00', to: '17:00' },
];

/** A public holiday of a calendar (`WorkCalendarDraft.holidays` of openapi.json). */
export interface Holiday {
  date: string;
  name: string;
  legal_basis_ref?: string;
}

/** The content of one working calendar version: one year of one calendar (`WorkCalendarDraft`). Weekdays are ISO numbers, 1 = Monday to 7 = Sunday. */
export interface WorkCalendarContent {
  calendar_code: string;
  year: number;
  working_days: readonly number[];
  holidays: readonly Holiday[];
  compensated_workdays?: readonly string[];
  legal_basis_ref: string;
}

/** The calendars in force, by year: a deadline may run past the end of a year into the next. */
export interface WorkCalendarSource {
  forYear(year: number): WorkCalendarContent | undefined;
}

/** A length of working time: hours and minutes are added. */
export interface WorkingDuration {
  hours?: number;
  minutes?: number;
}

/** One finding of `validateWorkCalendar`: the field it is about and a code the screen can translate. */
export type CalendarFinding = RuleFinding;

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
/** A deadline is not counted further than this from its start: an empty calendar must not loop for ever. */
const MAX_SCAN_DAYS = 3 * 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const offsetMs = (): number => (CALENDAR_TIMEZONES[WORKING_TIME_ZONE] as number) * MINUTE_MS;
const finding = (field: string, code: string): CalendarFinding => findingOf('adm.calendar.error', field, code);
const isRealDate = (value: string): boolean => ISO_DATE.test(value) && isoOf(dayOf(value)) === value;
const isoWeekday = (day: number): number => weekdayOf(day) + 1;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clockMs(clock: string): number {
  const match = CLOCK.exec(clock);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'segments');
  return (Number(match[1]) * HOUR_MINUTES + Number(match[2])) * MINUTE_MS;
}

/** The working intervals of a day in milliseconds from local midnight: each one non-empty, in order, none overlapping the next. */
function spansOf(intervals: readonly WorkingInterval[]): Array<{ from: number; to: number }> {
  const spans = intervals.map((interval) => ({ from: clockMs(interval.from), to: clockMs(interval.to) }));
  const ordered = spans.every((span, index) => span.from < span.to && (index === 0 || (spans[index - 1] as { to: number }).to <= span.from));
  if (spans.length === 0 || !ordered) throw new DomainError('VALIDATION_FAILED', 422, 'segments');
  return spans;
}

/**
 * Whether a local date (`YYYY-MM-DD`) is worked: a holiday never is, a compensated day always is, any other day is by its
 * weekday. The calendar must be the one of the date's year.
 */
export function isWorkingDay(calendar: WorkCalendarContent, date: string): boolean {
  if (calendar.holidays.some((holiday) => holiday.date === date)) return false;
  if ((calendar.compensated_workdays ?? []).includes(date)) return true;
  return calendar.working_days.includes(isoWeekday(dayOf(date)));
}

function dateFindings(field: string, dates: readonly string[], year: number): CalendarFinding[] {
  const found: CalendarFinding[] = [];
  const seen = new Set<string>();
  dates.forEach((date, index) => {
    const at = `${field}[${index}]`;
    if (!isRealDate(date)) found.push(finding(at, 'DATE_INVALID'));
    else if (Number(date.slice(0, 4)) !== year) found.push(finding(at, 'OUT_OF_YEAR'));
    else if (seen.has(date)) found.push(finding(at, 'DUPLICATE'));
    seen.add(date);
  });
  return found;
}

/** Every rule of a calendar version that the request schema cannot state; an empty list means it is valid. */
export function calendarFindings(content: WorkCalendarContent): CalendarFinding[] {
  const found: CalendarFinding[] = [];
  if (!CALENDAR_CODE.test(content.calendar_code)) found.push(finding('calendar_code', 'CODE_INVALID'));
  if (content.legal_basis_ref.trim() === '') found.push(finding('legal_basis_ref', 'LEGAL_BASIS_REQUIRED'));
  const weekdays = content.working_days;
  if (weekdays.length === 0) found.push(finding('working_days', 'NO_WORKING_DAYS'));
  else if (new Set(weekdays).size !== weekdays.length) found.push(finding('working_days', 'DUPLICATE'));
  const holidayDates = content.holidays.map((holiday) => holiday.date);
  found.push(...dateFindings('holidays', holidayDates, content.year));
  content.holidays.forEach((holiday, index) => {
    if (holiday.name.trim() === '') found.push(finding(`holidays[${index}].name`, 'NAME_REQUIRED'));
  });
  const compensated = content.compensated_workdays ?? [];
  found.push(...dateFindings('compensated_workdays', compensated, content.year));
  compensated.forEach((date, index) => {
    if (!isRealDate(date)) return;
    if (holidayDates.includes(date)) found.push(finding(`compensated_workdays[${index}]`, 'COMPENSATED_ON_HOLIDAY'));
    else if (weekdays.includes(isoWeekday(dayOf(date)))) found.push(finding(`compensated_workdays[${index}]`, 'COMPENSATED_ALREADY_WORKING'));
  });
  return found;
}

/**
 * Refuses a calendar version that cannot be used to count working time (AC-ST-ADM-010-2): a date that is not a date or not in
 * the year of the calendar, a date listed twice, no working weekday, a compensated day that is a holiday or an ordinary working
 * day. Fails with 422 CALENDAR_INVALID, naming every finding in `errors`; the detail names the first field, never a value.
 */
export function validateWorkCalendar(content: WorkCalendarContent): void {
  const found = calendarFindings(content);
  if (found.length > 0) throw new DomainError('CALENDAR_INVALID', 422, found[0]?.field, { extensions: { errors: found } });
}

/** The calendars of a set that has the one given version only; any other year is not covered. */
export function singleYear(calendar: WorkCalendarContent): WorkCalendarSource {
  return { forYear: (year) => (year === calendar.year ? calendar : undefined) };
}

function asSource(calendars: WorkCalendarContent | WorkCalendarSource): WorkCalendarSource {
  return 'forYear' in calendars ? calendars : singleYear(calendars);
}

function totalMinutes(duration: WorkingDuration): number {
  const total = (duration.hours ?? 0) * HOUR_MINUTES + (duration.minutes ?? 0);
  if (!Number.isFinite(total) || total < 0 || !Number.isInteger(total)) throw new DomainError('VALIDATION_FAILED', 422, 'duration');
  return total;
}

/**
 * The instant at which `duration` of working time, counted from `start`, has been spent (BR-ADM-08, XM-ADM-01). Time counts
 * only inside the working intervals of working days; a start outside them begins at the next interval; a duration that ends
 * exactly where an interval ends falls due at that moment. A zero duration returns `start`.
 *
 * Example (UAT-AC134): 2026-04-29 15:00 +07 plus 8 hours, with 30 April and 1 May holidays and the weekend of 2-3 May, is
 * 2 hours that day and 6 hours on 4 May, so 2026-05-04 15:00 +07.
 *
 * `intervals` is the working window of the caller; it defaults to BR-ADM-08. A module with its own window (the issue SLA of
 * ISS works 07:30 to 17:00) passes it, so the calendar arithmetic exists once.
 *
 * The calendar of each year the deadline passes through must be given: a deadline is never guessed with a weekly pattern, so a
 * year without a calendar fails with 422 CALENDAR_NOT_EFFECTIVE. A deadline is not counted further than three years.
 */
export function addWorkingTime(
  calendars: WorkCalendarContent | WorkCalendarSource,
  start: Date,
  duration: WorkingDuration,
  intervals: readonly WorkingInterval[] = DEFAULT_WORKING_INTERVALS,
): Date {
  let remaining = totalMinutes(duration) * MINUTE_MS;
  const spans = spansOf(intervals);
  if (remaining === 0) return new Date(start.getTime());
  const source = asSource(calendars);
  const local = start.getTime() + offsetMs();
  const firstDay = Math.floor(local / DAY_MS);
  const startOfDay = local - firstDay * DAY_MS;
  for (let day = firstDay; day < firstDay + MAX_SCAN_DAYS; day += 1) {
    const year = new Date(day * DAY_MS).getUTCFullYear();
    const calendar = source.forYear(year);
    if (calendar === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'year');
    if (!isWorkingDay(calendar, isoOf(day))) continue;
    for (const span of spans) {
      const from = day === firstDay ? Math.max(span.from, startOfDay) : span.from;
      if (from >= span.to) continue;
      const available = span.to - from;
      if (remaining <= available) return new Date(day * DAY_MS + from + remaining - offsetMs());
      remaining -= available;
    }
  }
  throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'duration');
}

/**
 * How many minutes of working time lie between two instants, counted on the same calendars and in the same working window as `addWorkingTime`
 * (the two are inverse: `addWorkingTime(c, from, { minutes: workingMinutesBetween(c, from, to) })` is `to` when `to` falls inside working time). Zero
 * when `to` is not after `from`. Used by the clocks of the alert centre to say how much of a pause was working time. The calendar of each year the
 * span passes through must be given, as it must for `addWorkingTime`: a year without one fails with 422 `CALENDAR_NOT_EFFECTIVE`, never a guessed day.
 */
export function workingMinutesBetween(calendars: WorkCalendarContent | WorkCalendarSource, from: Date, to: Date, intervals: readonly WorkingInterval[] = DEFAULT_WORKING_INTERVALS): number {
  if (!(to.getTime() > from.getTime())) return 0;
  const spans = spansOf(intervals);
  const source = asSource(calendars);
  const localFrom = from.getTime() + offsetMs();
  const localTo = to.getTime() + offsetMs();
  const firstDay = Math.floor(localFrom / DAY_MS);
  const lastDay = Math.floor(localTo / DAY_MS);
  if (lastDay - firstDay > MAX_SCAN_DAYS) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'duration');
  let total = 0;
  for (let day = firstDay; day <= lastDay; day += 1) {
    const calendar = source.forYear(new Date(day * DAY_MS).getUTCFullYear());
    if (calendar === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'year');
    if (!isWorkingDay(calendar, isoOf(day))) continue;
    const dayStart = day * DAY_MS;
    for (const span of spans) {
      const begin = Math.max(dayStart + span.from, localFrom);
      const end = Math.min(dayStart + span.to, localTo);
      if (end > begin) total += end - begin;
    }
  }
  return Math.floor(total / MINUTE_MS);
}
