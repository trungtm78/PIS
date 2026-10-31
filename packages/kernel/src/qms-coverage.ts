import { DomainError } from './errors.ts';
import { isWorkingDay } from './working-time.ts';
import type { WorkCalendarSource } from './working-time.ts';
import { workingDaysLate } from './doc-incoming.ts';

/**
 * The coverage of the site diary of a contract by working day (ST-QMS-008, QMS 3.1, BR-QMS-08, QMS-11, UAT-AC364). A working day is one of the calendar `WORKDAY_VN`. It has a main diary or it does not (`missing = working
 * days - days with a main diary`); the diary is DRAFT or signed by the contractor (or beyond); a copy of a device that nobody settled is counted on the side (`conflict`), never added to the total. A diary the contractor signed more
 * than one working day after its day is late, by the working days beyond the one that is allowed. Days after today are not counted: they are not missing yet. Pure functions of their input.
 */
export const COVERAGE_CALENDAR = 'WORKDAY_VN';
/** The working days a contractor has to sign after the day of the diary; beyond it the signature is late (BR-QMS-08). */
export const SIGN_ALLOWED_WORKING_DAYS = 1;
export const MAX_COVERAGE_DAYS = 366;

const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const dayNumber = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

export function isCalendarDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface CoverageRange {
  from: string;
  to: string;
  /** The last day counted: the end of the range, or today when the range reaches past it; absent when the range lies wholly in the future. */
  through: string | undefined;
}

/**
 * The range asked for. Without `to` it ends today; without `from` it starts on the first of the month of `to`. A day that is not a day of the calendar, a start after the end and a range of more than 366 days are 422
 * naming the field.
 */
export function coverageRange(from: string | undefined, to: string | undefined, today: string): CoverageRange {
  if (to !== undefined && !isCalendarDay(to)) throw invalid('to');
  if (from !== undefined && !isCalendarDay(from)) throw invalid('from');
  const end = to ?? today;
  const start = from ?? `${end.slice(0, 8)}01`;
  if (start > end) throw invalid('from');
  if (dayNumber(end) - dayNumber(start) + 1 > MAX_COVERAGE_DAYS) throw invalid('to');
  return { from: start, to: end, through: start > today ? undefined : end < today ? end : today };
}

/** A main diary of a day as the store reads it: `signedOn` is the day (Vietnamese time) of the first signature of the contractor on the diary of the day or on its corrections. */
export interface CoverageDiary {
  id: string;
  date: string;
  status: string;
  conflict: boolean;
  signedOn: string | undefined;
}

export type CoverageState = 'SIGNED' | 'DRAFT' | 'MISSING';

export interface CoverageDay {
  date: string;
  state: CoverageState;
  diaryId: string | null;
  status: string | null;
  conflict: boolean;
  signedOn: string | null;
  /** The working days from the day of the diary to the first signature of the contractor (the day itself is not counted); null while it is not signed. */
  workingDaysToSign: number | null;
  /** The working days beyond the one allowed; 0 when the signature was in time or is missing. */
  lateDays: number;
}

export interface CoverageTotals {
  workingDays: number;
  withDiary: number;
  signed: number;
  draft: number;
  missing: number;
  late: number;
  conflict: number;
}

export interface Coverage {
  days: CoverageDay[];
  totals: CoverageTotals;
}

/** The working days of the range counted, in order, with what each has. A year of the range without a published calendar is 422 `CALENDAR_NOT_EFFECTIVE`. */
export function diaryCoverage(range: CoverageRange, calendars: WorkCalendarSource, diaries: readonly CoverageDiary[]): Coverage {
  const days: CoverageDay[] = [];
  const totals: CoverageTotals = { workingDays: 0, withDiary: 0, signed: 0, draft: 0, missing: 0, late: 0, conflict: 0 };
  if (range.through === undefined) return { days, totals };
  const byDate = new Map(diaries.map((diary) => [diary.date, diary]));
  for (let day = dayNumber(range.from); day <= dayNumber(range.through); day += 1) {
    const date = dateOf(day);
    const calendar = calendars.forYear(Number(date.slice(0, 4)));
    if (calendar === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'from');
    if (!isWorkingDay(calendar, date)) continue;
    totals.workingDays += 1;
    const diary = byDate.get(date);
    if (diary === undefined) {
      totals.missing += 1;
      days.push({ date, state: 'MISSING', diaryId: null, status: null, conflict: false, signedOn: null, workingDaysToSign: null, lateDays: 0 });
      continue;
    }
    totals.withDiary += 1;
    const signed = diary.status !== 'DRAFT';
    if (signed) totals.signed += 1;
    else totals.draft += 1;
    if (diary.conflict) totals.conflict += 1;
    const toSign = signed && diary.signedOn !== undefined ? workingDaysLate(date, diary.signedOn, calendars) : null;
    const lateDays = toSign === null ? 0 : Math.max(0, toSign - SIGN_ALLOWED_WORKING_DAYS);
    if (lateDays > 0) totals.late += 1;
    days.push({ date, state: signed ? 'SIGNED' : 'DRAFT', diaryId: diary.id, status: diary.status, conflict: diary.conflict, signedOn: diary.signedOn ?? null, workingDaysToSign: toSign, lateDays });
  }
  return { days, totals };
}
