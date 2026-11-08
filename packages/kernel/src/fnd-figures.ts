import { currentAsOf, everAccepted, officialActual } from './fnd-actuals.ts';
import type { FigureBasis, FigureView, StoredFigure } from './fnd-actuals.ts';
import { firstMonthOf, lastMonthOf, monthsOfQuarter, periodRange } from './fnd-period.ts';
import type { PeriodRef } from './fnd-period.ts';
import type { FundingPack, Measure } from './fnd-taxonomy.ts';

/**
 * The figure engine of FND-1 (docs/fnd-funding-model.md section 5): from the stored figures of a project (the year plan and its adjustments, the quarter and month phasing, the estimates, the actuals, the opening
 * balances) it derives, for any period and any knowledge date, the figures of section 5.2 and the indicators of section 5.3, each with its numerator and its denominator. Pure and exact: whole dong as text, `bigint`
 * inside, percent with four decimals rounded half up, never a float. An absent figure is null (never zero); an absent plan counts as zero in a denominator and gives `ZERO_DENOMINATOR`; an absent numerator gives `NO_DATA`.
 *
 * Consumers (RPT-1c, IND-1, ENT-1): build a `FigureBook` per project from the stored figures, call `figuresOfProject` for the cells, `indicatorsOf` for the ratios the pack publishes and `moneyIndicatorsOf` for the additive
 * figures; a group (a unit, the whole tenant) is the sum of its projects (`indicatorsOf` takes many projects and divides the sums, never averages the rates).
 */

export type RateReason = 'ZERO_DENOMINATOR' | 'NO_DATA';

export interface FigureBook {
  pack: FundingPack;
  /** The stored figures of one project, every status; the engine reads only what was ever accepted. The year plans of CAP are read in the same shape (`PLAN_YEAR` for the first published revision, `PLAN_ADJUSTED` for each later one). */
  figures: readonly StoredFigure[];
  /** The approved total investment of the project over time (the baseline of lane B2): the one in force on a day is the latest effective on or before it. */
  tmdt: ReadonlyArray<{ effectiveOn: string; amountVnd: string }>;
  /** The plan years that are closed: the books are the record of a closed year (YEAR_END_ERP_WINS). */
  yearsClosed: ReadonlySet<number>;
}

export interface FigureQuery {
  period: PeriodRef;
  /** The knowledge date: a figure counts only when its own knowledge date is not after this day. */
  asOf: string;
  measure: Measure;
  view: FigureView;
}

/** The figures of one cell (class and tier) for a query, every one null when nobody has it. */
export interface CellFigures {
  classCode: string;
  tierCode: string;
  measure: Measure;
  planYear: string | null;
  planAdjusted: string | null;
  planInForce: string | null;
  planPeriod: string | null;
  planToDate: string | null;
  estimate: string | null;
  estimateAsReported: string | null;
  actual: string | null;
  cumulativeYtd: string | null;
  cumulativeSinceStart: string | null;
  estimateYear: string | null;
  estimateYearReason: 'ESTIMATE_GAP' | null;
  /** The months of the period (or of the year to date) that have no actual figure. */
  gapMonths: number[];
  /** The bases that went into the actual of a month period, and whether it is a flash figure of the books. */
  actualBases: FigureBasis[];
  actualFlash: boolean;
  /** The stored figures the numbers come from (I8: every number says where it comes from); a derived figure has no entry. */
  sourceIds: Partial<Record<SourcedFigure, string>>;
}

export type SourcedFigure = 'PLAN_YEAR' | 'PLAN_ADJUSTED' | 'PLAN_PERIOD' | 'ESTIMATE' | 'ESTIMATE_AS_REPORTED' | 'ACTUAL';

export interface ProjectFigures {
  projectId: string;
  cells: CellFigures[];
  tmdtInForce: string | null;
}

// -- exact arithmetic --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const RATE_SCALE = 10_000n;

/** A percent with four decimals, rounded half up, from whole numbers, written `48.0000`. The denominator must be positive and the numerator not negative. */
export function percentOf(numerator: bigint, denominator: bigint): string {
  const scaled = (numerator * 100n * RATE_SCALE * 2n + denominator) / (2n * denominator);
  return `${scaled / RATE_SCALE}.${(scaled % RATE_SCALE).toString().padStart(4, '0')}`;
}

/** One ratio: null with `ZERO_DENOMINATOR` when there is nothing to divide by (an absent denominator is zero), null with `NO_DATA` when there is nothing to divide or the numerator is below zero (a figure to look at, not a rate). */
export function ratioOf(numeratorVnd: string | null, denominatorVnd: string | null): { ratePct: string | null; nullReason: RateReason | null } {
  const denominator = denominatorVnd === null ? 0n : BigInt(denominatorVnd);
  if (denominator <= 0n) return { ratePct: null, nullReason: 'ZERO_DENOMINATOR' };
  if (numeratorVnd === null || BigInt(numeratorVnd) < 0n) return { ratePct: null, nullReason: 'NO_DATA' };
  return { ratePct: percentOf(BigInt(numeratorVnd), denominator), nullReason: null };
}

/** The sum of the figures that exist; null when none exists (a sum of nothing is not zero). */
export function sumKnown(values: ReadonlyArray<string | null>): string | null {
  let total = 0n;
  let any = false;
  for (const value of values) {
    if (value === null) continue;
    total += BigInt(value);
    any = true;
  }
  return any ? total.toString() : null;
}

export const minusKnown = (left: string | null, right: string | null): string | null => (left === null || right === null ? null : (BigInt(left) - BigInt(right)).toString());

// -- one cell ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ofKey = (book: FigureBook, classCode: string, tierCode: string, measure: Measure): StoredFigure[] => book.figures.filter((figure) => figure.classCode === classCode && figure.tierCode === tierCode && figure.measure === measure);

const latest = (figures: readonly StoredFigure[], kind: StoredFigure['kind'], grain: StoredFigure['grain'], planYear: number, ordinal: number, asOf: string): StoredFigure | undefined =>
  currentAsOf(
    figures.filter((figure) => figure.kind === kind && figure.grain === grain && figure.planYear === planYear && figure.ordinal === ordinal),
    asOf,
  );

/** The year plan of a plan year as of a day: the first published revision, the adjustment in force, and the one that counts (the adjustment when there is one, else the first). An absent year plan is null. */
export function yearPlanOf(figures: readonly StoredFigure[], planYear: number, asOf: string): { planYear: string | null; planAdjusted: string | null; inForce: string | null; firstId: string | null; adjustedId: string | null } {
  const first = latest(figures, 'PLAN_YEAR', 'YEAR', planYear, 0, asOf);
  const adjusted = latest(figures, 'PLAN_ADJUSTED', 'YEAR', planYear, 0, asOf);
  return { planYear: first?.amountVnd ?? null, planAdjusted: adjusted?.amountVnd ?? null, inForce: adjusted?.amountVnd ?? first?.amountVnd ?? null, firstId: first?.id ?? null, adjustedId: adjusted?.id ?? null };
}

interface ActualLedger {
  month(planYear: number, ordinal: number): { amountVnd: string | null; bases: FigureBasis[]; flash: boolean; sourceId: string | null };
  quarter(planYear: number, ordinal: number): string | null;
  /** The sum of the actuals of the months 1 to `endMonth` of a year, with the months that have none. */
  ytd(planYear: number, endMonth: number): { totalVnd: string | null; gaps: number[] };
  openingBalance(): string | null;
  years(): number[];
}

function ledgerOf(book: FigureBook, figures: readonly StoredFigure[], query: FigureQuery): ActualLedger {
  const monthFigures = figures.filter((figure) => figure.kind === 'ACTUAL' && figure.grain === 'MONTH');
  const quarterFigures = figures.filter((figure) => figure.kind === 'ACTUAL' && figure.grain === 'QUARTER');
  const monthCache = new Map<string, ReturnType<ActualLedger['month']>>();
  const month: ActualLedger['month'] = (planYear, ordinal) => {
    const key = `${planYear}/${ordinal}`;
    const held = monthCache.get(key);
    if (held !== undefined) return held;
    const official = officialActual({ figures: monthFigures, asOf: query.asOf, precedence: book.pack.actualsPrecedence, yearClosed: book.yearsClosed.has(planYear), view: query.view, planYear, ordinal });
    const result = { amountVnd: official.amountVnd, bases: official.bases, flash: official.flash, sourceId: official.sourceId };
    monthCache.set(key, result);
    return result;
  };
  const quarter: ActualLedger['quarter'] = (planYear, ordinal) => {
    const found = currentAsOf(quarterFigures.filter((figure) => figure.planYear === planYear && figure.ordinal === ordinal && figure.basis !== 'ADJUSTMENT'), query.asOf);
    return found?.amountVnd ?? null;
  };
  const ytd: ActualLedger['ytd'] = (planYear, endMonth) => {
    let total = 0n;
    let any = false;
    const gaps: number[] = [];
    for (let q = 1; q <= Math.ceil(endMonth / 3); q += 1) {
      const months = monthsOfQuarter(q).filter((one) => one <= endMonth);
      const amounts = months.map((one) => ({ one, amount: month(planYear, one).amountVnd }));
      const stored = quarter(planYear, q);
      if (months.length === 3 && stored !== null && amounts.some((entry) => entry.amount === null)) {
        total += BigInt(stored);
        any = true;
        continue;
      }
      for (const entry of amounts) {
        if (entry.amount === null) gaps.push(entry.one);
        else {
          total += BigInt(entry.amount);
          any = true;
        }
      }
    }
    return { totalVnd: any ? total.toString() : null, gaps };
  };
  const openingBalance: ActualLedger['openingBalance'] = () => {
    const rows = figures.filter((figure) => figure.kind === 'ACTUAL' && figure.grain === 'YEAR' && figure.basis === 'OPENING_BALANCE');
    const years = [...new Set(rows.map((figure) => figure.planYear))];
    return sumKnown(years.map((planYear) => currentAsOf(rows.filter((figure) => figure.planYear === planYear), query.asOf)?.amountVnd ?? null));
  };
  const years: ActualLedger['years'] = () => [...new Set([...monthFigures, ...quarterFigures].filter(everAccepted).map((figure) => figure.planYear))].sort((left, right) => left - right);
  return { month, quarter, ytd, openingBalance, years };
}

/** The plan of the same grain as the period: the month plan, the quarter plan (or the sum of its three months when only those exist), the year plan in force. Null when the phasing does not exist. */
function planOfPeriod(figures: readonly StoredFigure[], period: PeriodRef, asOf: string, inForce: string | null): { amountVnd: string | null; sourceId: string | null } {
  if (period.grain === 'YEAR') return { amountVnd: inForce, sourceId: null };
  if (period.grain === 'MONTH') {
    const month = latest(figures, 'PLAN_MONTH', 'MONTH', period.planYear, period.ordinal, asOf);
    return { amountVnd: month?.amountVnd ?? null, sourceId: month?.id ?? null };
  }
  const quarter = latest(figures, 'PLAN_QUARTER', 'QUARTER', period.planYear, period.ordinal, asOf);
  if (quarter !== undefined) return { amountVnd: quarter.amountVnd, sourceId: quarter.id };
  const months = monthsOfQuarter(period.ordinal).map((month) => latest(figures, 'PLAN_MONTH', 'MONTH', period.planYear, month, asOf)?.amountVnd ?? null);
  return { amountVnd: months.every((one) => one !== null) ? sumKnown(months) : null, sourceId: null };
}

/** `PLAN_TO_DATE(p)`: the phased plan up to the end of the period: the month plans, a closed quarter taken from its quarter plan when its months are absent; null when some part has no phasing at all. */
function planToDate(figures: readonly StoredFigure[], planYear: number, endMonth: number, asOf: string): string | null {
  let total = 0n;
  for (let q = 1; q <= Math.ceil(endMonth / 3); q += 1) {
    const months = monthsOfQuarter(q).filter((one) => one <= endMonth);
    const amounts = months.map((one) => latest(figures, 'PLAN_MONTH', 'MONTH', planYear, one, asOf)?.amountVnd ?? null);
    if (amounts.every((one) => one !== null)) {
      total += BigInt(sumKnown(amounts) ?? '0');
      continue;
    }
    const wholeQuarter = months.length === 3 ? latest(figures, 'PLAN_QUARTER', 'QUARTER', planYear, q, asOf) : undefined;
    if (wholeQuarter === undefined) return null;
    total += BigInt(wholeQuarter.amountVnd);
  }
  return total.toString();
}

/** `ESTIMATE_YEAR(a)`: the actual of the months that have one plus, for the others, the estimate of the month, else its plan; null with `ESTIMATE_GAP` when a month has none of the three (no silent fill with history). */
function estimateYearOf(figures: readonly StoredFigure[], ledger: ActualLedger, planYear: number, asOf: string): { amountVnd: string | null; gaps: number[] } {
  let total = 0n;
  const gaps: number[] = [];
  for (let q = 1; q <= 4; q += 1) {
    const months = monthsOfQuarter(q);
    const partial: Array<string | null> = months.map((month) => {
      const actual = ledger.month(planYear, month).amountVnd;
      if (actual !== null) return actual;
      const estimate = latest(figures, 'ESTIMATE', 'MONTH', planYear, month, asOf);
      if (estimate !== undefined) return estimate.amountVnd;
      return latest(figures, 'PLAN_MONTH', 'MONTH', planYear, month, asOf)?.amountVnd ?? null;
    });
    if (partial.every((one) => one !== null)) {
      total += BigInt(sumKnown(partial) ?? '0');
      continue;
    }
    // The months of the quarter are not all there: a quarter estimate may stand for the whole quarter, only while no month of it has an actual.
    const quarterEstimate = months.every((month) => ledger.month(planYear, month).amountVnd === null) ? latest(figures, 'ESTIMATE', 'QUARTER', planYear, q, asOf) : undefined;
    if (quarterEstimate !== undefined) {
      total += BigInt(quarterEstimate.amountVnd);
      continue;
    }
    months.forEach((month, index) => {
      if (partial[index] === null) gaps.push(month);
    });
  }
  return { amountVnd: gaps.length === 0 ? total.toString() : null, gaps };
}

/** The figures of one cell for a query (section 5.2). */
export function cellFigures(book: FigureBook, classCode: string, tierCode: string, query: FigureQuery): CellFigures {
  const figures = ofKey(book, classCode, tierCode, query.measure);
  const { period, asOf } = query;
  const plan = yearPlanOf(figures, period.planYear, asOf);
  const ledger = ledgerOf(book, figures, query);
  const endMonth = lastMonthOf(period);
  const startMonth = firstMonthOf(period);

  // The actual of the period: the month's official actual; a quarter or a year only when every month of it has one (or the quarter was entered whole).
  let actual: string | null = null;
  let actualBases: FigureBasis[] = [];
  let actualFlash = false;
  let actualSource: string | null = null;
  const gaps: number[] = [];
  if (period.grain === 'MONTH') {
    const month = ledger.month(period.planYear, period.ordinal);
    actual = month.amountVnd;
    actualBases = month.bases;
    actualFlash = month.flash;
    actualSource = month.sourceId;
    if (actual === null) gaps.push(period.ordinal);
  } else {
    const inside = ledger.ytd(period.planYear, endMonth);
    const before = startMonth > 1 ? ledger.ytd(period.planYear, startMonth - 1) : { totalVnd: null, gaps: [] as number[] };
    const stored = period.grain === 'QUARTER' ? ledger.quarter(period.planYear, period.ordinal) : null;
    const own = inside.gaps.filter((month) => month >= startMonth);
    if (own.length === 0 && inside.totalVnd !== null) actual = (BigInt(inside.totalVnd) - BigInt(before.totalVnd ?? '0')).toString();
    else if (stored !== null) actual = stored;
    else gaps.push(...own);
  }

  const ytd = ledger.ytd(period.planYear, endMonth);
  const opening = ledger.openingBalance();
  const earlier = ledger.years().filter((year) => year < period.planYear).map((year) => ledger.ytd(year, 12).totalVnd);
  const sinceStart = sumKnown([opening, ...earlier, ytd.totalVnd]);

  const estimateAsReported = latest(figures, 'ESTIMATE', period.grain, period.planYear, period.ordinal, asOf < periodRange(period).end ? asOf : periodRange(period).end);
  const complete = period.grain === 'MONTH' ? actual !== null : gaps.length === 0 && actual !== null;
  const current = complete ? undefined : latest(figures, 'ESTIMATE', period.grain, period.planYear, period.ordinal, asOf);
  const estimateYear = estimateYearOf(figures, ledger, period.planYear, asOf);
  const toDate = planToDate(figures, period.planYear, endMonth, asOf);
  const planPeriod = planOfPeriod(figures, period, asOf, plan.inForce);
  const sourceIds: CellFigures['sourceIds'] = {};
  const remember = (key: SourcedFigure, id: string | null | undefined): void => {
    if (id !== null && id !== undefined) sourceIds[key] = id;
  };
  remember('PLAN_YEAR', plan.firstId);
  remember('PLAN_ADJUSTED', plan.adjustedId);
  remember('PLAN_PERIOD', planPeriod.sourceId);
  remember('ESTIMATE', current?.id);
  remember('ESTIMATE_AS_REPORTED', estimateAsReported?.id);
  remember('ACTUAL', actualSource);

  return {
    classCode,
    tierCode,
    measure: query.measure,
    planYear: plan.planYear,
    planAdjusted: plan.planAdjusted,
    planInForce: plan.inForce,
    planPeriod: planPeriod.amountVnd,
    planToDate: toDate,
    estimate: current?.amountVnd ?? null,
    estimateAsReported: estimateAsReported?.amountVnd ?? null,
    actual,
    cumulativeYtd: ytd.totalVnd,
    cumulativeSinceStart: sinceStart,
    estimateYear: estimateYear.amountVnd,
    estimateYearReason: estimateYear.amountVnd === null ? 'ESTIMATE_GAP' : null,
    gapMonths: [...new Set([...gaps, ...ytd.gaps])].sort((left, right) => left - right),
    actualBases,
    actualFlash,
    sourceIds,
  };
}

/** The total investment in force on a day (the latest effective on or before it), null when none is approved. */
export function tmdtInForce(book: FigureBook, asOf: string): string | null {
  let found: { effectiveOn: string; amountVnd: string } | undefined;
  for (const point of book.tmdt) if (point.effectiveOn <= asOf && (found === undefined || found.effectiveOn < point.effectiveOn)) found = point;
  return found?.amountVnd ?? null;
}

/** Every cell of the pack (each class on each tier) for a query, and the total investment in force. */
export function figuresOfProject(book: FigureBook, projectId: string, query: FigureQuery): ProjectFigures {
  const cells: CellFigures[] = [];
  for (const one of book.pack.classes) for (const tier of book.pack.tiers) cells.push(cellFigures(book, one.code, tier.code, query));
  return { projectId, cells, tmdtInForce: tmdtInForce(book, query.asOf) };
}
