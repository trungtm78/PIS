import { ApiError } from '@machvon/api-client';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

export type DayState = 'SIGNED' | 'DRAFT' | 'MISSING';
const STATES: readonly DayState[] = ['SIGNED', 'DRAFT', 'MISSING'];

export interface DayView {
  date: string;
  state: DayState;
  diaryId: string | null;
  conflict: boolean;
  signedOn: string | null;
  lateDays: number;
}

export interface Totals {
  workingDays: number;
  withDiary: number;
  signed: number;
  draft: number;
  missing: number;
  late: number;
  conflict: number;
}

export interface CoverageView {
  contractCode: string;
  from: string;
  to: string;
  through: string | null;
  totals: Totals;
  days: DayView[];
  missingDates: string[];
}

function toDay(raw: unknown): DayView[] {
  const row = asRecord(raw);
  const date = text(row?.date);
  const state = STATES.find((known) => known === row?.state);
  if (row === undefined || date === undefined || state === undefined) return [];
  return [{ date, state, diaryId: text(row.diary_id) ?? null, conflict: row.conflict === true, signedOn: text(row.signed_on) ?? null, lateDays: whole(row.late_days) }];
}

export function toCoverage(raw: unknown): CoverageView | undefined {
  const row = asRecord(raw);
  const from = text(row?.from);
  const to = text(row?.to);
  if (row === undefined || from === undefined || to === undefined) return undefined;
  const totals = asRecord(row.totals);
  return {
    contractCode: text(row.contract_code) ?? '',
    from,
    to,
    through: text(row.through) ?? null,
    totals: {
      workingDays: whole(totals?.working_days),
      withDiary: whole(totals?.with_diary),
      signed: whole(totals?.signed),
      draft: whole(totals?.draft),
      missing: whole(totals?.missing),
      late: whole(totals?.late),
      conflict: whole(totals?.conflict),
    },
    days: (Array.isArray(row.days) ? row.days : []).flatMap(toDay),
    missingDates: (Array.isArray(row.missing_dates) ? row.missing_dates : []).flatMap((date) => (typeof date === 'string' ? [date] : [])),
  };
}

// ---- the month ---------------------------------------------------------------------------------------------------------------

const MONTH = /^(\d{4})-(\d{2})$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

export const isMonth = (value: string): boolean => {
  const match = MONTH.exec(value);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12;
};

/** The first and the last day of a month (`YYYY-MM`) as the range the server is asked for. */
export function monthRange(month: string): { from: string; to: string } {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export interface Cell {
  date: string;
  /** What the server says of the day: absent for a day off and for a day it did not count (after today). */
  day: DayView | undefined;
}

/** The month as weeks from Monday to Sunday: the days of the neighbouring months are left empty (null). */
export function monthGrid(month: string, days: readonly DayView[]): Array<Array<Cell | null>> {
  const { from, to } = monthRange(month);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = new Date(`${from}T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const total = Number(to.slice(8, 10));
  const cells: Array<Cell | null> = Array.from({ length: offset }, () => null);
  for (let number = 1; number <= total; number += 1) {
    const date = `${month}-${String(number).padStart(2, '0')}`;
    cells.push({ date, day: byDate.get(date) });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type CoverageProblem = 'notFound' | 'noCalendar' | 'validation' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CoverageProblem>> = {
  RESOURCE_NOT_FOUND: 'notFound',
  CALENDAR_NOT_EFFECTIVE: 'noCalendar',
  VALIDATION_FAILED: 'validation',
};

export const describeCoverage = (error: unknown): CoverageProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
