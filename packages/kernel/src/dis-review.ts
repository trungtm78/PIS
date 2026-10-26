import { DomainError } from './errors.ts';
import type { MeasurementBasis, RevisionStatus } from './dis-report.ts';
import type { ProgressInput } from './dis-progress.ts';

/** BR-DIS-07: what blocks the sending of a report (an error) and what is told and lets it through (a warning). */
export type ReviewSeverity = 'ERROR' | 'WARNING';

export interface ReviewFinding {
  /** An error carries the code of the problem the server answers when the report is sent as it is; a warning carries its own code. */
  code: string;
  severity: ReviewSeverity;
  /** The place on the report the finding is about, as the contract names it (`funding_lines[2].ctmtqg_subset_vnd`, `progress`, `period`...). */
  field: string;
  /** The figures that make the finding, as text (whole dong, percent with one decimal, or null when they are not defined). */
  values: Record<string, string | null>;
}

/** What the review looks at: the cells with what the plan allocated and what the period before reached, the volumes, and the state of the period, the plan and the report. */
export interface ReviewCell {
  cumulativeVnd: string;
  ctmtqgVnd: string | null;
  nextMonthVnd: string;
  nextMonthCtmtqgVnd: string | null;
  allocatedVnd: string;
  deltaVnd: string | null;
}

export interface ReviewInput {
  status: RevisionStatus;
  deleted: boolean;
  /** The period takes no report: it is locked and no approved reopening covers the project. */
  periodClosed: boolean;
  /** The plan version of the report is the one in force at the end of the period. */
  planInForce: boolean;
  cells: readonly ReviewCell[];
  negativeDeltaExplanation: string | null;
  progress: ProgressInput | null;
  /** What the Treasury paid for the project in the window of the basis (reversals taken off), or null when it recorded nothing in the window (BR-DIS-08: no data is not zero). */
  treasuryVnd: string | null;
}

export interface Review {
  errors: ReviewFinding[];
  warnings: ReviewFinding[];
  /** An error stops the sending; a warning does not. */
  blocking: boolean;
}

export const WARNING_CODES = {
  volumeExceedsAllocation: 'VOLUME_EXCEEDS_ALLOCATION',
  treasuryGap: 'TREASURY_GAP',
  nextMonthEmptyWithCapitalLeft: 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT',
  negativeDelta: 'NEGATIVE_DELTA',
} as const;

/** The gap between what is reported and what the Treasury paid that is told above 5% (BR-DIS-07, an assumption until the capital owner signs it, CXN-03). */
export const TREASURY_GAP_THRESHOLD_PCT = 5n;

const sum = (values: readonly string[]): bigint => values.reduce((total, value) => total + BigInt(value), 0n);

/** `numerator / denominator` as a percent with one decimal, rounded half up, written `203.8`; null when the denominator is zero. */
export function percentOf(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  const tenths = (numerator * 2000n + denominator) / (2n * denominator);
  return `${tenths / 10n}.${tenths % 10n}`;
}

/** The first and the last day the Treasury payments count in for a basis (BR-DIS-12): the period, the fiscal year up to the period, or everything up to the period. */
export function treasuryWindow(basis: MeasurementBasis, period: { startDate: string; endDate: string; fiscalYear: number }): { from: string | null; to: string } {
  if (basis === 'PERIOD') return { from: period.startDate, to: period.endDate };
  if (basis === 'YTD') return { from: `${period.fiscalYear}-01-01`, to: period.endDate };
  return { from: null, to: period.endDate };
}

/**
 * The review of DIS-06 (BR-DIS-07), the same one that stops a send: every error and every warning at once, so that a person fixes them in one pass and not one at a time. The errors are the
 * ones the server would answer (`REVISION_IMMUTABLE`, `PERIOD_LOCKED`, `PLAN_VERSION_NOT_EFFECTIVE`, `SUBSET_EXCEEDS_PARENT`, `NEGATIVE_DELTA_EXPLANATION_REQUIRED`, and `VALIDATION_FAILED` for the
 * volumes that are missing); the warnings are told and do not stop anything.
 */
export function reviewReport(input: ReviewInput): Review {
  const errors: ReviewFinding[] = [];
  const warnings: ReviewFinding[] = [];
  const error = (code: string, field: string, values: Record<string, string | null> = {}): void => void errors.push({ code, severity: 'ERROR', field, values });
  const warn = (code: string, field: string, values: Record<string, string | null>): void => void warnings.push({ code, severity: 'WARNING', field, values });

  if (input.status !== 'DRAFT' || input.deleted) error('REVISION_IMMUTABLE', 'status', { report_status: input.status });
  if (input.periodClosed) error('PERIOD_LOCKED', 'period');
  if (!input.planInForce) error('PLAN_VERSION_NOT_EFFECTIVE', 'plan_version');
  input.cells.forEach((cell, index) => {
    if (cell.ctmtqgVnd !== null && BigInt(cell.ctmtqgVnd) > BigInt(cell.cumulativeVnd)) {
      error('SUBSET_EXCEEDS_PARENT', `funding_lines[${index}].ctmtqg_subset_vnd`, { parent_vnd: cell.cumulativeVnd, subset_vnd: cell.ctmtqgVnd });
    }
    if (cell.nextMonthCtmtqgVnd !== null && BigInt(cell.nextMonthCtmtqgVnd) > BigInt(cell.nextMonthVnd)) {
      error('SUBSET_EXCEEDS_PARENT', `funding_lines[${index}].next_month_ctmtqg_subset_vnd`, { parent_vnd: cell.nextMonthVnd, subset_vnd: cell.nextMonthCtmtqgVnd });
    }
  });
  if (input.negativeDeltaExplanation === null && input.cells.some((cell) => cell.deltaVnd !== null && cell.deltaVnd.startsWith('-'))) {
    error('NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation');
  }
  if (input.progress === null) error('VALIDATION_FAILED', 'progress', { missing: 'construction_vnd' });

  const falls = input.cells.flatMap((cell) => (cell.deltaVnd !== null && cell.deltaVnd.startsWith('-') ? [BigInt(cell.deltaVnd)] : []));
  // A fall that is explained is told, not hidden: the report goes with it, and the change is what it is (never forced to zero).
  if (falls.length > 0 && input.negativeDeltaExplanation !== null) {
    warn(WARNING_CODES.negativeDelta, 'negative_delta_explanation', { delta_vnd: falls.reduce((total, fall) => total + fall, 0n).toString() });
  }
  const allocated = sum(input.cells.map((cell) => cell.allocatedVnd));
  const cumulative = sum(input.cells.map((cell) => cell.cumulativeVnd));
  const nextMonth = sum(input.cells.map((cell) => cell.nextMonthVnd));
  if (input.progress !== null && BigInt(input.progress.constructionVnd) > allocated) {
    warn(WARNING_CODES.volumeExceedsAllocation, 'progress.construction_vnd', { construction_vnd: input.progress.constructionVnd, allocated_vnd: allocated.toString(), ratio_pct: percentOf(BigInt(input.progress.constructionVnd), allocated) });
  }
  if (input.treasuryVnd !== null) {
    const treasury = BigInt(input.treasuryVnd);
    const gap = cumulative > treasury ? cumulative - treasury : treasury - cumulative;
    // The gap is above the threshold when gap / treasury > 5%; with nothing paid, any reported amount is a gap.
    if (treasury === 0n ? gap > 0n : gap * 100n > TREASURY_GAP_THRESHOLD_PCT * treasury) {
      warn(WARNING_CODES.treasuryGap, 'funding_lines', { reported_vnd: cumulative.toString(), treasury_vnd: input.treasuryVnd, gap_pct: percentOf(gap, treasury) });
    }
  }
  if (nextMonth === 0n && allocated > cumulative) {
    warn(WARNING_CODES.nextMonthEmptyWithCapitalLeft, 'funding_lines', { remaining_vnd: (allocated - cumulative).toString() });
  }
  return { errors, warnings, blocking: errors.length > 0 };
}

/** The statuses a refused send answers: a report that cannot be edited and a period that is locked are conflicts of state, the rest are entries that are not valid. */
const CONFLICTS: ReadonlySet<string> = new Set(['REVISION_IMMUTABLE', 'PERIOD_LOCKED']);

/**
 * The refusal of a send that has errors: the first error of the review, as the problem the server answers (409 for the state of the report or the period, 422 for the entries), naming its field,
 * with the codes of every error so that a client can show them all. Undefined when there is none.
 */
export function submitRefusal(review: Review): DomainError | undefined {
  const first = review.errors[0];
  if (first === undefined) return undefined;
  return new DomainError(first.code, CONFLICTS.has(first.code) ? 409 : 422, first.field, { extensions: { error_codes: review.errors.map((entry) => entry.code), ...first.values } });
}
