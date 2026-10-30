import { DomainError } from './errors.ts';

/**
 * The ISO weeks the weekly matrix of the issues is made over (ST-ISS-006, ISS 3.1, BR-ISS-08): a week begins on a Monday and ends on the Sunday after it, on the Vietnam calendar, and is named by its ISO year and number
 * (`2026-W42`). Pure functions of their input.
 */
const WEEK = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;

export interface IsoWeek {
  week: string;
  /** The Monday, as a Vietnam calendar day. */
  from: string;
  /** The Sunday. */
  to: string;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The Monday of the week 1 of an ISO year: the week that holds the 4th of January. */
function firstMonday(year: number): number {
  const fourth = Date.UTC(year, 0, 4);
  const weekday = (new Date(fourth).getUTCDay() + 6) % 7;
  return fourth - weekday * DAY_MS;
}

/** The number of weeks of an ISO year: 53 when the year begins on a Thursday, or is a leap year that begins on a Wednesday, and 52 otherwise. */
export function weeksInYear(year: number): number {
  return Math.round((firstMonday(year + 1) - firstMonday(year)) / (7 * DAY_MS));
}

/** The days of a week named `YYYY-Www`; 422 `VALIDATION_FAILED` on `week` for a name that is not one, or a number the year does not have. */
export function isoWeekRange(week: unknown): IsoWeek {
  const matched = typeof week === 'string' ? WEEK.exec(week) : null;
  const year = matched === null ? 0 : Number(matched[1]);
  const number = matched === null ? 0 : Number(matched[2]);
  if (matched === null || year < 2000 || year > 2100 || number < 1 || number > weeksInYear(year)) throw new DomainError('VALIDATION_FAILED', 422, 'week');
  const monday = firstMonday(year) + (number - 1) * 7 * DAY_MS;
  return { week: `${year}-W${String(number).padStart(2, '0')}`, from: dayOf(monday), to: dayOf(monday + 6 * DAY_MS) };
}

/** The ISO week a Vietnam calendar day lies in. */
export function isoWeekOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  // The Thursday of the week decides the year of the week.
  const thursday = ms - weekday * DAY_MS + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const number = Math.floor((thursday - firstMonday(year)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(number).padStart(2, '0')}`;
}
