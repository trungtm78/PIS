import { minusKnown, ratioOf, sumKnown } from './fnd-figures.ts';
import type { CellFigures, FigureQuery, ProjectFigures, RateReason } from './fnd-figures.ts';
import type { FundingPack, FundingRatio, Measure, RatioBasis, RatioTerm } from './fnd-taxonomy.ts';
import type { PeriodRef } from './fnd-period.ts';
import { message } from './messages.ts';

/**
 * The indicators of the funding model (docs/fnd-funding-model.md section 5.3): the ratios a pack publishes, each with its numerator and its denominator (BR-HOME-03), and the additive money figures. A group (a unit, the
 * whole tenant) is made from the SUMS of its projects: the numerators are added, the denominators are added, then one division; never the mean of the rates (BR-DIS-04). Every indicator carries what a reader needs to
 * trust it (I8): the formula (code and sentence), the terms, the source basis, the knowledge date and the pack.
 */

/** The terms the figure engine evaluates from a book (the two public terms, the plan split by origin and the Treasury, are evaluated from the lines of a snapshot by `fnd-public.ts`). */
export const BOOK_TERMS: readonly RatioTerm[] = ['ACTUAL', 'CUMULATIVE_YTD', 'CUMULATIVE_SINCE_START', 'ESTIMATE_YEAR', 'ESTIMATE_AS_REPORTED', 'PLAN_IN_FORCE', 'PLAN_YEAR', 'PLAN_PERIOD', 'PLAN_TO_DATE', 'TMDT_IN_FORCE', 'CLASS_SUM'];

export interface Indicator {
  code: string;
  /** The class the figure is about (a structure share is one per class); null when it is over the whole scope. */
  classCode: string | null;
  measure: Measure;
  numeratorTerm: RatioTerm;
  denominatorTerm: RatioTerm;
  basis: RatioBasis;
  numeratorVnd: string | null;
  denominatorVnd: string;
  /** Percent with four decimals; null with the reason. Never zero for a missing figure. */
  ratePct: string | null;
  nullReason: RateReason | null;
  /** How many projects the sums are over. */
  projects: number;
  asOf: string;
  period: PeriodRef;
  packCode: string;
  additive: false;
}

const cellTerm = (cell: CellFigures, term: RatioTerm): string | null => {
  switch (term) {
    case 'ACTUAL':
      return cell.actual;
    case 'CUMULATIVE_YTD':
      return cell.cumulativeYtd;
    case 'CUMULATIVE_SINCE_START':
      return cell.cumulativeSinceStart;
    case 'ESTIMATE_YEAR':
      return cell.estimateYear;
    case 'ESTIMATE_AS_REPORTED':
      return cell.estimateAsReported;
    case 'PLAN_IN_FORCE':
      return cell.planInForce;
    case 'PLAN_YEAR':
      return cell.planYear;
    case 'PLAN_PERIOD':
      return cell.planPeriod;
    case 'PLAN_TO_DATE':
      return cell.planToDate;
    default:
      return null;
  }
};

const isBookRatio = (ratio: FundingRatio): boolean => BOOK_TERMS.includes(ratio.numerator) && BOOK_TERMS.includes(ratio.denominator);

/**
 * The ratios the pack publishes, from the figures of its projects for one query. A ratio over the classes in its filter (all when it has none); `CLASS_SUM` as the denominator gives one share per additive class over the sum
 * of the classes of the same scope (and measure); `TMDT_IN_FORCE` is a figure of the project, not of a class, so it is summed over projects and ignores the class filter. A ratio that reads the public terms is not made here.
 */
export function indicatorsOf(pack: FundingPack, projects: readonly ProjectFigures[], query: FigureQuery): Indicator[] {
  const found: Indicator[] = [];
  const inScope = (ratio: FundingRatio): CellFigures[] => projects.flatMap((project) => project.cells).filter((cell) => ratio.classFilter.length === 0 || ratio.classFilter.includes(cell.classCode));
  const make = (ratio: FundingRatio, classCode: string | null, numeratorVnd: string | null, denominatorVnd: string | null): Indicator => {
    const rate = ratioOf(numeratorVnd, denominatorVnd);
    return {
      code: ratio.code,
      classCode,
      measure: query.measure,
      numeratorTerm: ratio.numerator,
      denominatorTerm: ratio.denominator,
      basis: ratio.basis,
      numeratorVnd,
      denominatorVnd: denominatorVnd ?? '0',
      ratePct: rate.ratePct,
      nullReason: rate.nullReason,
      projects: projects.length,
      asOf: query.asOf,
      period: query.period,
      packCode: pack.packCode,
      additive: false,
    };
  };
  for (const ratio of pack.ratios) {
    if (!isBookRatio(ratio)) continue;
    const cells = inScope(ratio);
    if (ratio.denominator === 'CLASS_SUM') {
      const additive = pack.classes.filter((one) => one.additive && (ratio.classFilter.length === 0 || ratio.classFilter.includes(one.code)));
      const whole = sumKnown(cells.filter((cell) => additive.some((one) => one.code === cell.classCode)).map((cell) => cellTerm(cell, ratio.numerator)));
      for (const one of additive) found.push(make(ratio, one.code, sumKnown(cells.filter((cell) => cell.classCode === one.code).map((cell) => cellTerm(cell, ratio.numerator))), whole));
      continue;
    }
    const numerator = ratio.numerator === 'TMDT_IN_FORCE' ? sumKnown(projects.map((project) => project.tmdtInForce)) : sumKnown(cells.map((cell) => cellTerm(cell, ratio.numerator)));
    const denominator = ratio.denominator === 'TMDT_IN_FORCE' ? sumKnown(projects.map((project) => project.tmdtInForce)) : sumKnown(cells.map((cell) => cellTerm(cell, ratio.denominator)));
    found.push(make(ratio, null, numerator, denominator));
  }
  return found;
}

// -- the additive figures -------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const MONEY_INDICATOR_CODES = [
  'PLAN_YEAR',
  'PLAN_ADJUSTED',
  'PLAN_ADJUSTMENT_DELTA',
  'PLAN_IN_FORCE',
  'PLAN_PERIOD',
  'PLAN_TO_DATE',
  'ESTIMATE',
  'ESTIMATE_AS_REPORTED',
  'ACTUAL',
  'CUMULATIVE_YTD',
  'CUMULATIVE_SINCE_START',
  'ESTIMATE_YEAR',
  'REMAINING_YEAR',
  'CONVERSION_DELTA',
] as const;
export type MoneyIndicatorCode = (typeof MONEY_INDICATOR_CODES)[number];

export interface MoneyIndicator {
  code: MoneyIndicatorCode;
  classCode: string | null;
  measure: Measure;
  valueVnd: string | null;
  /** Always true: a money figure is the sum of its parts (`reconciles_to_parent`, BR-HOME-03). */
  additive: true;
  asOf: string;
  packCode: string;
}

/** Whether a figure of a cell is the cell of this class (or any class, when `classCode` is null). */
const cellsOf = (projects: readonly ProjectFigures[], classCode: string | null): CellFigures[] => projects.flatMap((project) => project.cells).filter((cell) => classCode === null || cell.classCode === classCode);

/**
 * The money figures of the scope, in total (`classCode` null) or of one class. `PLAN_ADJUSTMENT_DELTA = PLAN_ADJUSTED - PLAN_YEAR` where there is an adjustment; `REMAINING_YEAR = PLAN_IN_FORCE - CUMULATIVE_YTD` (negative means
 * over plan and is shown, never clamped; null without a year plan); `CONVERSION_DELTA = ACTUAL - ESTIMATE_AS_REPORTED` summed over the cells that have both.
 */
export function moneyIndicatorsOf(pack: FundingPack, projects: readonly ProjectFigures[], query: FigureQuery, classCode: string | null = null): MoneyIndicator[] {
  const cells = cellsOf(projects, classCode);
  const sum = (pick: (cell: CellFigures) => string | null): string | null => sumKnown(cells.map(pick));
  const adjusted = cells.filter((cell) => cell.planAdjusted !== null && cell.planYear !== null);
  const values: Record<MoneyIndicatorCode, string | null> = {
    PLAN_YEAR: sum((cell) => cell.planYear),
    PLAN_ADJUSTED: sum((cell) => cell.planAdjusted),
    PLAN_ADJUSTMENT_DELTA: adjusted.length === 0 ? null : sumKnown(adjusted.map((cell) => minusKnown(cell.planAdjusted, cell.planYear))),
    PLAN_IN_FORCE: sum((cell) => cell.planInForce),
    PLAN_PERIOD: sum((cell) => cell.planPeriod),
    PLAN_TO_DATE: sum((cell) => cell.planToDate),
    ESTIMATE: sum((cell) => cell.estimate),
    ESTIMATE_AS_REPORTED: sum((cell) => cell.estimateAsReported),
    ACTUAL: sum((cell) => cell.actual),
    CUMULATIVE_YTD: sum((cell) => cell.cumulativeYtd),
    CUMULATIVE_SINCE_START: sum((cell) => cell.cumulativeSinceStart),
    ESTIMATE_YEAR: sum((cell) => cell.estimateYear),
    REMAINING_YEAR: sum((cell) => cell.planInForce) === null ? null : minusKnown(sum((cell) => cell.planInForce), sum((cell) => cell.cumulativeYtd) ?? '0'),
    CONVERSION_DELTA: sumKnown(cells.filter((cell) => cell.actual !== null && cell.estimateAsReported !== null).map((cell) => minusKnown(cell.actual, cell.estimateAsReported))),
  };
  return MONEY_INDICATOR_CODES.map((code) => ({ code, classCode, measure: query.measure, valueVnd: values[code], additive: true, asOf: query.asOf, packCode: pack.packCode }));
}

/** The sentence a reader sees for an indicator (formula, in Vietnamese, from the kernel messages); a code with no sentence is a defect of the pack. */
export const indicatorFormula = (code: string): string => message(`fnd.indicator.${code.toLowerCase()}.formula`);
