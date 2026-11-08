import { DomainError } from './errors.ts';
import type { PeriodGrain } from './fnd-taxonomy.ts';

/**
 * The periods of the funding figures (docs/fnd-funding-model.md section 5.1): the plan year (the fiscal year is the calendar year, assumption A-4), its quarters and its months. Containment is by dates, never by a
 * column: a month is in the quarter `ceil(m / 3)`, a quarter is in its year. A week belongs to no month for sums. Pure date arithmetic on `YYYY-MM-DD` text, so that the Vietnam calendar day never goes through a timezone.
 */

export const FIGURE_GRAINS = ['MONTH', 'QUARTER', 'YEAR'] as const;
export type FigureGrain = (typeof FIGURE_GRAINS)[number];
export const isFigureGrain = (value: unknown): value is FigureGrain => typeof value === 'string' && (FIGURE_GRAINS as readonly string[]).includes(value);

export const PERIOD_STATUSES = ['OPEN', 'SOFT_CLOSED', 'LOCKED'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

/** A period of a plan year: the grain and its ordinal (the month 1 to 12, the quarter 1 to 4, 0 for the year). */
export interface PeriodRef {
  grain: FigureGrain;
  planYear: number;
  ordinal: number;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const pad = (value: number, width: number): string => String(value).padStart(width, '0');
const lastDayOfMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** 422 `VALIDATION_FAILED` naming `field` unless the year is a plausible plan year. */
export function assertPlanYear(year: number, field = 'plan_year'): void {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw invalid(field);
}

/** The ordinal range of a grain: the year has only 0 (the opening balances use it), a quarter 1 to 4, a month 1 to 12. */
export function assertOrdinal(grain: FigureGrain, ordinal: number, field = 'period_ordinal'): void {
  const [low, high] = grain === 'YEAR' ? [0, 0] : grain === 'QUARTER' ? [1, 4] : [1, 12];
  if (!Number.isInteger(ordinal) || ordinal < low || ordinal > high) throw invalid(field);
}

export const quarterOfMonth = (month: number): number => Math.ceil(month / 3);
export const monthsOfQuarter = (quarter: number): readonly number[] => [quarter * 3 - 2, quarter * 3 - 1, quarter * 3];
export const lastMonthOf = (period: PeriodRef): number => (period.grain === 'MONTH' ? period.ordinal : period.grain === 'QUARTER' ? period.ordinal * 3 : 12);
export const firstMonthOf = (period: PeriodRef): number => (period.grain === 'MONTH' ? period.ordinal : period.grain === 'QUARTER' ? period.ordinal * 3 - 2 : 1);

/** The first and last day of a period, `YYYY-MM-DD`. */
export function periodRange(period: PeriodRef): { start: string; end: string } {
  assertPlanYear(period.planYear);
  assertOrdinal(period.grain, period.ordinal);
  const first = firstMonthOf(period);
  const last = lastMonthOf(period);
  return { start: `${pad(period.planYear, 4)}-${pad(first, 2)}-01`, end: `${pad(period.planYear, 4)}-${pad(last, 2)}-${pad(lastDayOfMonth(period.planYear, last), 2)}` };
}

/** The months (year, ordinal) of a period in calendar order. */
export function monthsOf(period: PeriodRef): Array<{ planYear: number; ordinal: number }> {
  const months: Array<{ planYear: number; ordinal: number }> = [];
  for (let month = firstMonthOf(period); month <= lastMonthOf(period); month += 1) months.push({ planYear: period.planYear, ordinal: month });
  return months;
}

/** The ordering key of a month: earlier months sort first across years. */
export const monthIndex = (planYear: number, ordinal: number): number => planYear * 12 + (ordinal - 1);

/** The period of a day: the month it falls in. */
export function monthOfDay(day: string): { planYear: number; ordinal: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) throw invalid('as_of_date');
  return { planYear: Number(match[1]), ordinal: Number(match[2]) };
}

/** Whether a period has ended on the day `asOf` (its last day is not after it). */
export const periodEnded = (period: PeriodRef, asOf: string): boolean => periodRange(period).end <= asOf;

/**
 * DIS F4 lifecycle of a period, as it governs a figure: OPEN accepts estimates and actuals; SOFT_CLOSED accepts no new estimate (422 `ESTIMATE_AFTER_ACTUAL` is for a key that has an actual; a soft-closed period refuses
 * the estimate with the same code) but still accepts actuals and corrections; LOCKED accepts nothing (409 `FIGURE_PERIOD_LOCKED`), the only paths being the reopen window and a late adjustment in the open period.
 */
export function assertPeriodAccepts(status: PeriodStatus, figureKind: string, field = 'period_id'): void {
  if (status === 'LOCKED') throw new DomainError('FIGURE_PERIOD_LOCKED', 409, field);
  if (status === 'SOFT_CLOSED' && figureKind === 'ESTIMATE') throw new DomainError('ESTIMATE_AFTER_ACTUAL', 422, field);
}

/** A year closes only when its twelfth month and its fourth quarter are LOCKED. */
export function yearMayClose(input: { month12: PeriodStatus | undefined; quarter4: PeriodStatus | undefined }): boolean {
  return input.month12 === 'LOCKED' && input.quarter4 === 'LOCKED';
}

/** Whether a grain is one the pack accepts for figures (WEEK is for public reporting only). */
export const grainAccepted = (accepted: readonly PeriodGrain[], grain: FigureGrain): boolean => accepted.includes(grain);
