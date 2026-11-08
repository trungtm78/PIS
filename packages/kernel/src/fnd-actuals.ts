import { DomainError } from './errors.ts';
import type { FigureGrain, PeriodStatus } from './fnd-period.ts';
import type { ActualsPrecedence, Measure } from './fnd-taxonomy.ts';

/**
 * The stored figures of the funding model and the sources of an actual (docs/fnd-funding-model.md sections 5.2, 6): what a revision row is for the engine, how the official actual of a month is chosen between the figure
 * the owner reported and the figure of the books (ERP), how the two are compared, and how a correction after a close is read in the two views. Pure.
 */

/** The kinds of figure that are stored (the rest are derived by the engine). */
export const STORED_FIGURE_KINDS = ['PLAN_YEAR', 'PLAN_ADJUSTED', 'PLAN_QUARTER', 'PLAN_MONTH', 'ESTIMATE', 'ACTUAL'] as const;
export type StoredFigureKind = (typeof STORED_FIGURE_KINDS)[number];
export const isStoredFigureKind = (value: unknown): value is StoredFigureKind => typeof value === 'string' && (STORED_FIGURE_KINDS as readonly string[]).includes(value);

/** Where the number of a stored figure comes from (6.2). */
export const FIGURE_BASES = ['REPORTED', 'ERP', 'TREASURY', 'ADJUSTMENT', 'OPENING_BALANCE', 'PLAN_DECISION', 'OWNER_ESTIMATE'] as const;
export type FigureBasis = (typeof FIGURE_BASES)[number];
export const isFigureBasis = (value: unknown): value is FigureBasis => typeof value === 'string' && (FIGURE_BASES as readonly string[]).includes(value);

export const FIGURE_STATUSES = ['DRAFT', 'SUBMITTED', 'ACCEPTED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export type FigureStatus = (typeof FIGURE_STATUSES)[number];

export const CONVERSION_REASONS = ['PERIOD_ACTUAL_IN', 'CORRECTION_IN_OPEN_PERIOD', 'LATE_ADJUSTMENT', 'RESTATEMENT'] as const;
export type ConversionReason = (typeof CONVERSION_REASONS)[number];

export const FIGURE_VIEWS = ['AS_REPORTED', 'RESTATED'] as const;
export type FigureView = (typeof FIGURE_VIEWS)[number];
export const isFigureView = (value: unknown): value is FigureView => typeof value === 'string' && (FIGURE_VIEWS as readonly string[]).includes(value);

/** A row of `plan_figure_revision` (or a year plan of CAP read in the same shape) as the engine sees it; money is whole dong as text. */
export interface StoredFigure {
  id: string;
  classCode: string;
  tierCode: string;
  measure: Measure;
  kind: StoredFigureKind;
  grain: FigureGrain;
  planYear: number;
  /** The month 1 to 12, the quarter 1 to 4, 0 for the year. */
  ordinal: number;
  amountVnd: string;
  basis: FigureBasis;
  /** The knowledge date of the figure: it is read as of a day only when this is not after it. */
  asOfDate: string;
  revision: number;
  status: FigureStatus;
  /** An ERP figure taken before the books of the period closed. */
  flash?: boolean;
  /** For a late adjustment: the month it corrects (it is booked in the period named by `planYear` and `ordinal`). */
  adjusts?: { planYear: number; ordinal: number } | null;
  convertedFromId?: string | null;
  estimateAmountVnd?: string | null;
  conversionReason?: ConversionReason | null;
}

/** A figure that was ever accepted: accepted or superseded by a later revision (a superseded row is still the truth as of its own day). */
export const everAccepted = (figure: StoredFigure): boolean => figure.status === 'ACCEPTED' || figure.status === 'SUPERSEDED';

/** The order of revisions of one key: by knowledge date, then by revision. */
export const byKnowledge = (left: StoredFigure, right: StoredFigure): number => (left.asOfDate < right.asOfDate ? -1 : left.asOfDate > right.asOfDate ? 1 : left.revision - right.revision);

/** The figure that was current on `asOf`: the latest ever-accepted revision whose knowledge date is not after it; undefined when there is none. */
export function currentAsOf(figures: readonly StoredFigure[], asOf: string): StoredFigure | undefined {
  let found: StoredFigure | undefined;
  for (const figure of figures) {
    if (!everAccepted(figure) || figure.asOfDate > asOf) continue;
    if (found === undefined || byKnowledge(found, figure) < 0) found = figure;
  }
  return found;
}

export interface OfficialActual {
  amountVnd: string | null;
  /** The bases that went into the number, in the order they were added (the base figure first, then adjustments). */
  bases: FigureBasis[];
  /** The base figure is a flash figure of the books (not closed yet). */
  flash: boolean;
  /** The stored figure the base number comes from; null when only adjustments (or nothing) make the number. */
  sourceId: string | null;
}

export interface OfficialInput {
  /** The accepted figures of one month (or one quarter) of one key, any basis; adjustments included. */
  figures: readonly StoredFigure[];
  asOf: string;
  precedence: ActualsPrecedence;
  /** The year the period belongs to is closed: the books are the record of the year (YEAR_END_ERP_WINS). */
  yearClosed: boolean;
  view: FigureView;
  /** The period the figures are asked for. */
  planYear: number;
  ordinal: number;
}

const sameMonth = (figure: StoredFigure, planYear: number, ordinal: number): boolean => figure.planYear === planYear && figure.ordinal === ordinal;

/**
 * 6.3: the official actual of a period. The base figure comes from the precedence of the pack: `REPORTED_UNTIL_RECONCILED` takes the accepted reported figure, else the figure of the books (the latest ERP, flash or not), and
 * a year that closed takes the books (`YEAR_END_ERP_WINS`); `TREASURY_HEADLINE` takes the Treasury, else the reported figure. A late adjustment is added on top: in the AS_REPORTED view in the period it was booked in, in the
 * RESTATED view in the period it corrects (5.4). No figure at all is null, never zero.
 */
export function officialActual(input: OfficialInput): OfficialActual {
  const base = (basis: FigureBasis): StoredFigure | undefined =>
    currentAsOf(
      input.figures.filter((figure) => figure.basis === basis && figure.kind === 'ACTUAL' && sameMonth(figure, input.planYear, input.ordinal)),
      input.asOf,
    );
  const reported = base('REPORTED');
  const erp = base('ERP');
  const treasury = base('TREASURY');
  let chosen: StoredFigure | undefined;
  if (input.precedence === 'TREASURY_HEADLINE') chosen = treasury ?? reported;
  else if (input.yearClosed && erp !== undefined) chosen = erp;
  else chosen = reported ?? erp;

  // Adjustments: one current figure per (booking period, corrected period), then the ones that count in this period under the view.
  const adjustments = new Map<string, StoredFigure>();
  for (const figure of input.figures) {
    if (figure.basis !== 'ADJUSTMENT' || figure.kind !== 'ACTUAL' || !everAccepted(figure) || figure.asOfDate > input.asOf) continue;
    const corrected = figure.adjusts ?? { planYear: figure.planYear, ordinal: figure.ordinal };
    const key = `${figure.planYear}/${figure.ordinal}>${corrected.planYear}/${corrected.ordinal}`;
    const held = adjustments.get(key);
    if (held === undefined || byKnowledge(held, figure) < 0) adjustments.set(key, figure);
  }
  const counted = [...adjustments.values()].filter((figure) => {
    const corrected = figure.adjusts ?? { planYear: figure.planYear, ordinal: figure.ordinal };
    return input.view === 'RESTATED' ? corrected.planYear === input.planYear && corrected.ordinal === input.ordinal : figure.planYear === input.planYear && figure.ordinal === input.ordinal;
  });
  if (chosen === undefined && counted.length === 0) return { amountVnd: null, bases: [], flash: false, sourceId: null };
  const total = (chosen === undefined ? 0n : BigInt(chosen.amountVnd)) + counted.reduce((sum, figure) => sum + BigInt(figure.amountVnd), 0n);
  return { amountVnd: total.toString(), bases: [...(chosen === undefined ? [] : [chosen.basis]), ...counted.map(() => 'ADJUSTMENT' as FigureBasis)], flash: chosen?.flash === true, sourceId: chosen?.id ?? null };
}

// -- variance (6.4) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const VARIANCE_REASONS = ['TIMING', 'CLASSIFICATION', 'ACCRUAL', 'ERROR_REPORT', 'ERROR_ERP', 'OTHER'] as const;
export type VarianceReason = (typeof VARIANCE_REASONS)[number];
export const VARIANCE_RESOLUTIONS = ['ACCEPT_ERP', 'ACCEPT_REPORTED', 'EXPLAINED', 'WAIVED'] as const;
export type VarianceResolution = (typeof VARIANCE_RESOLUTIONS)[number];
export const MIN_EXPLANATION = 20;
export const MAX_EXPLANATION = 2000;

export interface Variance {
  /** Reported less ERP, whole dong; null when either source has no figure. */
  varianceVnd: string | null;
  /** The size above which the difference needs an explanation: the larger of the absolute floor and the percent of the books' figure. */
  thresholdVnd: string | null;
  needsExplanation: boolean;
}

/** The percent as basis points (two decimals), so that the comparison stays in whole numbers. */
const basisPoints = (pct: number): bigint => BigInt(Math.round(pct * 100));

/** 6.4: `variance = reported - ERP`; it needs an explanation when `abs(variance) > max(tolerance.abs_vnd, tolerance.pct x abs(ERP) / 100)`. A source with no figure gives no variance. */
export function varianceOf(reportedVnd: string | null, erpVnd: string | null, tolerance: { pct: number; absVnd: number }): Variance {
  if (reportedVnd === null || erpVnd === null) return { varianceVnd: null, thresholdVnd: null, needsExplanation: false };
  const variance = BigInt(reportedVnd) - BigInt(erpVnd);
  const magnitude = variance < 0n ? -variance : variance;
  const erp = BigInt(erpVnd) < 0n ? -BigInt(erpVnd) : BigInt(erpVnd);
  const floor = BigInt(tolerance.absVnd) * 10_000n;
  const relative = erp * basisPoints(tolerance.pct);
  const limit = floor > relative ? floor : relative;
  // The threshold is shown rounded up to a whole dong; the comparison itself is exact.
  const thresholdVnd = ((limit + 9_999n) / 10_000n).toString();
  return { varianceVnd: variance.toString(), thresholdVnd, needsExplanation: magnitude * 10_000n > limit };
}

/** The explanation of a variance: 20 to 2000 characters after trimming (422 `ACTUALS_VARIANCE_UNEXPLAINED` naming `explanation`). */
export function varianceExplanation(text: string | undefined): string {
  const words = (text ?? '').normalize('NFC').trim();
  if (words.length < MIN_EXPLANATION || words.length > MAX_EXPLANATION) throw new DomainError('ACTUALS_VARIANCE_UNEXPLAINED', 422, 'explanation');
  return words;
}

/** The resolver of a variance is not the preparer of the report it concerns (403 `SELF_APPROVAL_DENIED`: maker is not checker). */
export function assertResolverIsNotPreparer(resolver: string, preparer: string | null): void {
  if (preparer !== null && resolver === preparer) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/** 6.3 step 4: a year with an unresolved variance does not close (409 `YEAR_CLOSE_BLOCKED_BY_VARIANCE`); a waived one is resolved. */
export function assertYearMayClose(unresolvedVariances: number): void {
  if (unresolvedVariances > 0) throw new DomainError('YEAR_CLOSE_BLOCKED_BY_VARIANCE', 409, 'plan_year', { extensions: { unresolved: unresolvedVariances } });
}

/** Whether a period of this status still lets the books and the report disagree without notice: only a locked period is compared for a variance (the snapshot freezes both). */
export const comparedAtClose = (status: PeriodStatus): boolean => status === 'LOCKED';

// -- the history of a period: estimates, then the actual that replaced them --------------------------------------------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  kind: StoredFigureKind;
  basis: FigureBasis;
  revision: number;
  asOfDate: string;
  status: FigureStatus;
  amountVnd: string;
  /** Against the figure before it of the same key, whole dong; null for the first. */
  changeVnd: string | null;
  /** For an actual that replaced an estimate: the estimate it replaced and what it was. */
  convertedFromId: string | null;
  estimateAmountVnd: string | null;
  conversionReason: ConversionReason | null;
  /** Actual less the estimate it replaced; null when it replaced none. */
  conversionDeltaVnd: string | null;
}

/** The transition history of one period of one key (7.3): the estimate revisions in knowledge-date order, then the actual, each linked to what it replaced. Only figures that were ever accepted are in it. */
export function periodHistory(figures: readonly StoredFigure[]): HistoryEntry[] {
  const accepted = figures.filter(everAccepted).sort((left, right) => (left.kind === right.kind ? byKnowledge(left, right) : left.kind === 'ESTIMATE' ? -1 : right.kind === 'ESTIMATE' ? 1 : byKnowledge(left, right)));
  const lastOfKind = new Map<string, string>();
  return accepted.map((figure) => {
    const lane = `${figure.kind}/${figure.basis}`;
    const before = lastOfKind.get(lane);
    lastOfKind.set(lane, figure.amountVnd);
    const estimate = figure.estimateAmountVnd ?? null;
    return {
      id: figure.id,
      kind: figure.kind,
      basis: figure.basis,
      revision: figure.revision,
      asOfDate: figure.asOfDate,
      status: figure.status,
      amountVnd: figure.amountVnd,
      changeVnd: before === undefined ? null : (BigInt(figure.amountVnd) - BigInt(before)).toString(),
      convertedFromId: figure.convertedFromId ?? null,
      estimateAmountVnd: estimate,
      conversionReason: figure.conversionReason ?? null,
      conversionDeltaVnd: estimate === null ? null : (BigInt(figure.amountVnd) - BigInt(estimate)).toString(),
    };
  });
}
