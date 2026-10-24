import { DomainError } from './errors.ts';
import { dayOf, isoOf } from './reporting-calendar.ts';
import { isWorkingDay } from './working-time.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The statutory timers of land clearance (LND BR-LND-01, rule data `LND_TIMER` of MDM): the notice before a recovery decision (90 days for
 * agricultural land, 180 for the rest), the posting of a compensation plan (30 days), the payment after approval (30 days) and the answer to a
 * complaint. The number of days, its legal basis and its dates are rule data; this file holds what does not change with the law: the names of
 * the timers, which timer a land use takes, and how a number of days is counted onto a date.
 */

export const LAND_TIMER_CODES = ['NOTICE_AGRICULTURAL_90', 'NOTICE_NON_AGRICULTURAL_180', 'PLAN_POSTING_30', 'PAYMENT_30', 'COMPLAINT_RESOLUTION'] as const;
export type LandTimerCode = (typeof LAND_TIMER_CODES)[number];

export const LAND_USE_GROUPS = ['AGRICULTURAL', 'NON_AGRICULTURAL_RESIDENTIAL', 'NON_AGRICULTURAL_OTHER', 'PUBLIC'] as const;
export type LandUseGroup = (typeof LAND_USE_GROUPS)[number];

/** How a number of days is counted: every calendar day (the statute's reading, BR-LND-01) or only the days the working calendar of ADM works. */
export const LAND_DAY_COUNTS = ['CALENDAR', 'WORKING'] as const;
export type LandDayCount = (typeof LAND_DAY_COUNTS)[number];

/** The two lengths of notice a parcel can carry (`land_parcel.notice_days_applied`). */
export const NOTICE_DAYS = [90, 180] as const;

/** The longest timer a rule may state, in days; it also bounds the scan of a working calendar. */
export const MAX_TIMER_DAYS = 366;
/** How far a working-day count looks past its start before the calendar is declared too short. */
const MAX_SCAN_DAYS = 3 * 366;

/** A timer as the rule data states it. */
export interface LandTimerRule {
  code: LandTimerCode;
  days: number;
  dayCount: LandDayCount;
  /** The working calendar the days are counted on; set exactly when `dayCount` is WORKING. */
  calendarCode: string | null;
}

/**
 * The notice timer of a parcel by its land use. Land that is not agricultural takes the longer notice, and so does public land: when the
 * land use is not agricultural the longer period is the safe reading (the assumption of BR-LND-01 for mixed parcels is the larger number).
 */
export function noticeTimerOf(group: LandUseGroup): 'NOTICE_AGRICULTURAL_90' | 'NOTICE_NON_AGRICULTURAL_180' {
  return group === 'AGRICULTURAL' ? 'NOTICE_AGRICULTURAL_90' : 'NOTICE_NON_AGRICULTURAL_180';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function dayNumber(date: string, field: string): number {
  if (!ISO_DATE.test(date) || isoOf(dayOf(date)) !== date) throw invalid(field);
  return dayOf(date);
}

/** The date `days` calendar days after `date`: the first day of the count is the day after `date` (2026-07-01 plus 90 is 2026-09-29). */
export function addCalendarDays(date: string, days: number): string {
  if (!Number.isInteger(days) || days < 0 || days > MAX_TIMER_DAYS) throw invalid('days');
  return isoOf(dayNumber(date, 'date') + days);
}

/**
 * The date `days` working days after `date`, by the working calendars given: the day of `date` is not counted, a day counts when its calendar
 * works it (a holiday never, a compensated day always). The calendar of every year the count passes through must be given, so a deadline is
 * never guessed from a weekly pattern (422 CALENDAR_NOT_EFFECTIVE).
 */
export function addWorkingDays(calendars: WorkCalendarSource, date: string, days: number): string {
  if (!Number.isInteger(days) || days < 0 || days > MAX_TIMER_DAYS) throw invalid('days');
  const start = dayNumber(date, 'date');
  let remaining = days;
  for (let step = 1; remaining > 0; step += 1) {
    if (step > MAX_SCAN_DAYS) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'days');
    const iso = isoOf(start + step);
    const calendar = calendars.forYear(Number(iso.slice(0, 4)));
    if (calendar === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'year');
    if (isWorkingDay(calendar, iso)) remaining -= 1;
    if (remaining === 0) return iso;
  }
  return date;
}
