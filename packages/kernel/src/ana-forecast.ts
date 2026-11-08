import { percentOf } from './dis-review.ts';

/**
 * The year-end outlook of the disbursement (G3-5, BI and DIS): from the weekly cumulative figures of the year the engine measures the speed over every window of 4 to 8 weeks (all of them are kept: the
 * slowest and the fastest give the band), projects the cumulative to the end of the plan year in a straight line and, when the year before has a complete weekly series, along its seasonal shape, and says
 * how much has to be paid each week from now to reach the plan ("needed per week") and how many times the recent pace that is. Everything is exact (whole dong as text, bigint inside, rational results rounded
 * half up) and deterministic. No figure is invented: a value that cannot be computed is null with a reason, never 0.
 *
 * The seasonal projection is the "pace ratio" method: the remaining amount of the year before (what it paid between the same day and its year end) is scaled by how this year's pace in the window compares
 * with the pace of the year before over the same calendar window. It needs a prior series that starts the year at 0 on 1 January (a year to date figure is 0 by definition) and reaches its year end.
 */

export interface ForecastParams {
  windowMinWeeks: number;
  windowMaxWeeks: number;
  central: 'MEDIAN' | 'MEAN';
  seasonality: boolean;
  /** A week point is accepted for a window when it falls within this many days of the day the window starts. */
  pointToleranceDays: number;
  /** The share of the plan under which the central projection calls the year "to watch". */
  attentionBelowPct: number;
}

export interface SeriesPoint {
  /** The day the figure is as of (`YYYY-MM-DD`). */
  asOfDate: string;
  /** The Treasury disbursement of the year to that day, whole dong. */
  cumulativeVnd: string;
}

export type ForecastNullReason = 'NO_PLAN' | 'NO_TREASURY_DATA' | 'TOO_FEW_WEEKS' | 'ALL_WINDOWS_UNUSABLE' | 'YEAR_ENDED';
export type SeasonalNullReason = 'SEASONALITY_OFF' | 'NO_PRIOR_YEAR' | 'PRIOR_YEAR_TOO_SHORT' | 'PRIOR_WINDOW_ZERO' | 'NO_WINDOW';
export type SkippedWindowReason = 'NO_POINT_AT_WINDOW_START' | 'NEGATIVE_DELTA';
export type NeededStatus = 'NEEDED' | 'REACHED' | 'NA';
export type MultipleNullReason = 'ZERO_SPEED' | 'NO_SPEED';

export interface WindowProjection {
  weeks: number;
  startDate: string;
  days: number;
  deltaVnd: string;
  /** What was paid per week in the window, whole dong. */
  weeklySpeedVnd: string;
  linearYearEndVnd: string;
  seasonalYearEndVnd: string | null;
  seasonalNullReason: SeasonalNullReason | null;
}

export interface Band {
  lowVnd: string;
  centralVnd: string;
  highVnd: string;
}

export interface BandRatios {
  low: string | null;
  central: string | null;
  high: string | null;
}

export interface NeededPerWeek {
  status: NeededStatus;
  nullReason: ForecastNullReason | null;
  remainingVnd: string | null;
  remainingDays: number | null;
  perWeekVnd: string | null;
  /** The recent pace (central of the window speeds), whole dong per week. */
  speedVnd: string | null;
  /** Needed per week over the recent pace, two decimals ("1.80"). */
  multiple: string | null;
  multipleNullReason: MultipleNullReason | null;
}

export interface Outlook {
  nullReason: ForecastNullReason | null;
  asOfDate: string | null;
  planYearEnd: string;
  cumulativeVnd: string | null;
  planTotalVnd: string | null;
  remainingDays: number | null;
  windows: WindowProjection[];
  skipped: Array<{ weeks: number; reason: SkippedWindowReason }>;
  linear: Band | null;
  linearRatioPct: BandRatios | null;
  seasonal: Band | null;
  seasonalRatioPct: BandRatios | null;
  seasonalNullReason: SeasonalNullReason | null;
  /** The central straight-line projection less the plan (negative: short of the plan). */
  gapVnd: string | null;
  /** True when the central straight-line projection is under the attention share of the plan; null when it cannot be judged. */
  attention: boolean | null;
  needed: NeededPerWeek;
}

export interface OutlookInput {
  planTotalVnd: string | null;
  points: readonly SeriesPoint[];
  priorPoints: readonly SeriesPoint[];
  planYearEnd: string;
  params: ForecastParams;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const days = (from: string, to: string): number => dayNumber(to) - dayNumber(from);
const dayAfter = (day: string, offset: number): string => new Date((dayNumber(day) + offset) * DAY_MS).toISOString().slice(0, 10);

/** The same calendar day one year earlier (29 February becomes 28 February). */
export function sameDayLastYear(day: string): string {
  const year = Number(day.slice(0, 4)) - 1;
  const tail = day.slice(5);
  return `${String(year).padStart(4, '0')}-${tail === '02-29' ? '02-28' : tail}`;
}

/** `numerator / denominator` rounded half up (away from zero for a negative); the denominator is positive. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = (2n * absolute + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

const sortedDistinct = (points: readonly SeriesPoint[]): SeriesPoint[] => {
  const byDay = new Map<string, SeriesPoint>();
  for (const point of points) byDay.set(point.asOfDate, point);
  return [...byDay.values()].sort((left, right) => left.asOfDate.localeCompare(right.asOfDate));
};

/**
 * The cumulative of a series on a day by straight-line interpolation between the two points around it; 1 January of the year has 0 (the year to date figure starts the year at 0). Null when the day
 * is after the last point or before 1 January of its year.
 */
export function cumulativeAt(points: readonly SeriesPoint[], day: string): bigint | null {
  const year = day.slice(0, 4);
  const start = `${year}-01-01`;
  if (day < start) return null;
  let previous: { day: string; cumulative: bigint } = { day: start, cumulative: 0n };
  for (const point of points) {
    if (point.asOfDate.slice(0, 4) !== year) continue;
    const value = BigInt(point.cumulativeVnd);
    if (point.asOfDate === day) return value;
    if (point.asOfDate > day) {
      const span = BigInt(days(previous.day, point.asOfDate));
      return previous.cumulative + divRound((value - previous.cumulative) * BigInt(days(previous.day, day)), span);
    }
    previous = { day: point.asOfDate, cumulative: value };
  }
  return null;
}

function centralOf(values: readonly bigint[], mode: ForecastParams['central']): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (mode === 'MEAN') return divRound(sorted.reduce((sum, value) => sum + value, 0n), BigInt(sorted.length));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as bigint) : divRound((sorted[middle - 1] as bigint) + (sorted[middle] as bigint), 2n);
}

const bandOf = (values: readonly bigint[], mode: ForecastParams['central']): Band | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { lowVnd: (sorted[0] as bigint).toString(), centralVnd: centralOf(values, mode).toString(), highVnd: (sorted[sorted.length - 1] as bigint).toString() };
};

function ratiosOf(band: Band | null, plan: bigint | null): BandRatios | null {
  if (band === null || plan === null || plan <= 0n) return null;
  const ratio = (value: string): string | null => (BigInt(value) < 0n ? null : percentOf(BigInt(value), plan));
  return { low: ratio(band.lowVnd), central: ratio(band.centralVnd), high: ratio(band.highVnd) };
}

const noNeed = (nullReason: ForecastNullReason): NeededPerWeek => ({ status: 'NA', nullReason, remainingVnd: null, remainingDays: null, perWeekVnd: null, speedVnd: null, multiple: null, multipleNullReason: null });

/** Whether the series of the year before can carry a seasonal reading: it must reach its own year end. */
function priorUsable(prior: readonly SeriesPoint[], currentAsOf: string): SeasonalNullReason | null {
  if (prior.length === 0) return 'NO_PRIOR_YEAR';
  const priorYear = Number(sameDayLastYear(currentAsOf).slice(0, 4));
  const inYear = prior.filter((point) => point.asOfDate.startsWith(`${priorYear}-`));
  if (inYear.length === 0) return 'NO_PRIOR_YEAR';
  const last = inYear[inYear.length - 1] as SeriesPoint;
  return last.asOfDate >= `${priorYear}-12-31` || prior.some((point) => point.asOfDate > `${priorYear}-12-31`) ? null : 'PRIOR_YEAR_TOO_SHORT';
}

export function outlookOf(input: OutlookInput): Outlook {
  const { params } = input;
  const empty = (nullReason: ForecastNullReason, extra: Partial<Outlook> = {}): Outlook => ({
    nullReason,
    asOfDate: null,
    planYearEnd: input.planYearEnd,
    cumulativeVnd: null,
    planTotalVnd: input.planTotalVnd,
    remainingDays: null,
    windows: [],
    skipped: [],
    linear: null,
    linearRatioPct: null,
    seasonal: null,
    seasonalRatioPct: null,
    seasonalNullReason: null,
    gapVnd: null,
    attention: null,
    needed: noNeed(nullReason),
    ...extra,
  });
  const points = sortedDistinct(input.points);
  const last = points[points.length - 1];
  if (last === undefined) return empty('NO_TREASURY_DATA');
  const cumulative = BigInt(last.cumulativeVnd);
  const plan = input.planTotalVnd === null ? null : BigInt(input.planTotalVnd);
  const remainingDays = days(last.asOfDate, input.planYearEnd);
  const base = { asOfDate: last.asOfDate, cumulativeVnd: last.cumulativeVnd, remainingDays: Math.max(remainingDays, 0) };
  if (plan === null || plan <= 0n) return empty('NO_PLAN', base);
  if (remainingDays <= 0) return empty('YEAR_ENDED', base);

  const priorPoints = sortedDistinct(input.priorPoints);
  const priorReason: SeasonalNullReason | null = !params.seasonality ? 'SEASONALITY_OFF' : priorUsable(priorPoints, last.asOfDate);
  const priorYearEnd = `${sameDayLastYear(last.asOfDate).slice(0, 4)}-12-31`;
  const priorEndNow = priorReason === null ? cumulativeAt(priorPoints, sameDayLastYear(last.asOfDate)) : null;
  const priorTotal = priorReason === null ? cumulativeAt(priorPoints, priorYearEnd) : null;

  const windows: WindowProjection[] = [];
  const skipped: Outlook['skipped'] = [];
  for (let weeks = params.windowMinWeeks; weeks <= params.windowMaxWeeks; weeks += 1) {
    const wanted = dayAfter(last.asOfDate, -7 * weeks);
    let start: SeriesPoint | undefined;
    for (const point of points) {
      const gap = Math.abs(days(point.asOfDate, wanted));
      if (point !== last && gap <= params.pointToleranceDays && (start === undefined || gap < Math.abs(days(start.asOfDate, wanted)))) start = point;
    }
    if (start === undefined) {
      skipped.push({ weeks, reason: 'NO_POINT_AT_WINDOW_START' });
      continue;
    }
    const delta = cumulative - BigInt(start.cumulativeVnd);
    if (delta < 0n) {
      skipped.push({ weeks, reason: 'NEGATIVE_DELTA' });
      continue;
    }
    const span = days(start.asOfDate, last.asOfDate);
    const linearYearEnd = cumulative + divRound(delta * BigInt(remainingDays), BigInt(span));
    let seasonalYearEnd: bigint | null = null;
    let seasonalNullReason: SeasonalNullReason | null = priorReason;
    if (priorReason === null && priorEndNow !== null && priorTotal !== null) {
      const priorStart = cumulativeAt(priorPoints, sameDayLastYear(start.asOfDate));
      if (priorStart === null) seasonalNullReason = 'NO_WINDOW';
      else if (priorEndNow - priorStart <= 0n) seasonalNullReason = 'PRIOR_WINDOW_ZERO';
      else seasonalYearEnd = cumulative + divRound((priorTotal - priorEndNow) * delta, priorEndNow - priorStart);
    } else if (priorReason === null) seasonalNullReason = 'PRIOR_YEAR_TOO_SHORT';
    windows.push({
      weeks,
      startDate: start.asOfDate,
      days: span,
      deltaVnd: delta.toString(),
      weeklySpeedVnd: divRound(delta * 7n, BigInt(span)).toString(),
      linearYearEndVnd: linearYearEnd.toString(),
      seasonalYearEndVnd: seasonalYearEnd === null ? null : seasonalYearEnd.toString(),
      seasonalNullReason,
    });
  }
  if (windows.length === 0) {
    const reason: ForecastNullReason = skipped.some((one) => one.reason === 'NEGATIVE_DELTA') ? 'ALL_WINDOWS_UNUSABLE' : 'TOO_FEW_WEEKS';
    return { ...empty(reason, base), skipped, needed: neededOf(plan, cumulative, remainingDays, null, reason) };
  }

  const linear = bandOf(windows.map((one) => BigInt(one.linearYearEndVnd)), params.central);
  const seasonalValues = windows.flatMap((one) => (one.seasonalYearEndVnd === null ? [] : [BigInt(one.seasonalYearEndVnd)]));
  const seasonal = bandOf(seasonalValues, params.central);
  const seasonalNullReason = seasonal === null ? (windows[0] as WindowProjection).seasonalNullReason ?? 'NO_WINDOW' : null;
  const speed = centralOf(windows.map((one) => BigInt(one.weeklySpeedVnd)), params.central);
  const centralLinear = BigInt((linear as Band).centralVnd);
  return {
    nullReason: null,
    asOfDate: last.asOfDate,
    planYearEnd: input.planYearEnd,
    cumulativeVnd: last.cumulativeVnd,
    planTotalVnd: plan.toString(),
    remainingDays,
    windows,
    skipped,
    linear,
    linearRatioPct: ratiosOf(linear, plan),
    seasonal,
    seasonalRatioPct: ratiosOf(seasonal, plan),
    seasonalNullReason,
    gapVnd: (centralLinear - plan).toString(),
    attention: centralLinear * 100n < plan * BigInt(params.attentionBelowPct),
    needed: neededOf(plan, cumulative, remainingDays, speed, null),
  };
}

/** How much a week has to bring from the day of the figure to the plan year end, and how many times the recent pace that is. */
export function neededOf(plan: bigint, cumulative: bigint, remainingDays: number, speed: bigint | null, nullReason: ForecastNullReason | null): NeededPerWeek {
  const remaining = plan - cumulative;
  if (remaining <= 0n) {
    return { status: 'REACHED', nullReason: null, remainingVnd: '0', remainingDays, perWeekVnd: '0', speedVnd: speed === null ? null : speed.toString(), multiple: '0.00', multipleNullReason: null };
  }
  const perWeek = divRound(remaining * 7n, BigInt(remainingDays));
  const speedVnd = speed === null ? null : speed.toString();
  if (speed === null) return { status: 'NEEDED', nullReason, remainingVnd: remaining.toString(), remainingDays, perWeekVnd: perWeek.toString(), speedVnd, multiple: null, multipleNullReason: 'NO_SPEED' };
  if (speed === 0n) return { status: 'NEEDED', nullReason, remainingVnd: remaining.toString(), remainingDays, perWeekVnd: perWeek.toString(), speedVnd, multiple: null, multipleNullReason: 'ZERO_SPEED' };
  const hundredths = divRound(perWeek * 100n, speed);
  return {
    status: 'NEEDED',
    nullReason: null,
    remainingVnd: remaining.toString(),
    remainingDays,
    perWeekVnd: perWeek.toString(),
    speedVnd,
    multiple: `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`,
    multipleNullReason: null,
  };
}
