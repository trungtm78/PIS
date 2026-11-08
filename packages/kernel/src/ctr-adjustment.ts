import { DomainError } from './errors.ts';

/**
 * The adjustment version of a contract and what it does to the baseline of the project (G1-18, CTR 3.3, PRJ baseline): a change that takes effect makes a new version of the contract; the version carries what it
 * adds to the contract (against the version before and against the original), the share of the baseline cost of the project that this is, and whether somebody has to look at the baseline again. Pure: the
 * amounts are whole dong in strings, the percents are made from whole numbers (half up, two decimals), and the review thresholds are the params of the rule `CONTRACT_BASELINE_IMPACT`.
 */

export const BASELINE_IMPACT_RULE_TYPE = 'CONTRACT_BASELINE_IMPACT';
export const BASELINE_IMPACT_RULE_CODE = 'DEFAULT';
export const ADJUSTMENT_CLASSES = ['NONE', 'WITHIN_TOLERANCE', 'REVIEW_REQUIRED', 'NO_BASELINE'] as const;
export type AdjustmentClass = (typeof ADJUSTMENT_CLASSES)[number];
export const ADJUSTMENT_REVIEW_DECISIONS = ['KEEP_BASELINE', 'REBASELINE'] as const;
export type AdjustmentReviewDecision = (typeof ADJUSTMENT_REVIEW_DECISIONS)[number];

export interface BaselineImpactPolicy {
  /** The change of one version, as a share of the baseline cost of the project, at which the baseline has to be looked at (percent). */
  reviewPctOfBaseline: number;
  /** The change of the contract since its original value, at which the baseline has to be looked at (percent). */
  reviewPctOfOriginal: number;
  /** A review needs the words of the person who decides it. */
  noteRequired: boolean;
}

export function baselineImpactDefaults(): Record<string, unknown> {
  return { review_pct_of_baseline: 5, review_pct_of_original: 10, note_required: true };
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function baselineImpactOf(params: unknown): BaselineImpactPolicy {
  if (!isRecord(params)) throw invalid('params');
  const pct = (key: string): number => {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) throw invalid(key);
    return value;
  };
  const note = params.note_required;
  if (typeof note !== 'boolean') throw invalid('note_required');
  return { reviewPctOfBaseline: pct('review_pct_of_baseline'), reviewPctOfOriginal: pct('review_pct_of_original'), noteRequired: note };
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const hundredths = (value: number): bigint => BigInt(Math.round(value * 100));

/** `numerator / denominator` as a percent, two decimals, half up, signed; null without a positive denominator. */
export function pct2(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n;
  const scaled = (abs(numerator) * 20000n + denominator) / (2n * denominator);
  const text = `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
  return negative && scaled !== 0n ? `-${text}` : text;
}

export interface AdjustmentInput {
  /** The value of the first version of the contract. */
  originalVnd: string;
  /** The value of the version that this one replaces. */
  previousVnd: string;
  /** The value of the new version. */
  newVnd: string;
  /** The baseline cost of the project (BAC of the latest baseline); null when the project has no baseline. */
  baselineBacVnd: string | null;
}

export interface AdjustmentImpact {
  deltaVnd: string;
  deltaPctOfPrevious: string | null;
  cumulativeDeltaVnd: string;
  cumulativePctOfOriginal: string | null;
  shareOfBaselinePct: string | null;
  classification: AdjustmentClass;
  /** Which thresholds were passed: `BASELINE`, `ORIGINAL`. */
  reasons: Array<'BASELINE' | 'ORIGINAL'>;
}

/**
 * What a version does. NONE when the value did not change; NO_BASELINE when it did and the project has no baseline to compare with (somebody must still look: the classification is not a clearance);
 * REVIEW_REQUIRED when the change of this version is at or over the share of the baseline, or the cumulative change over the original is at or over the other threshold, in either direction (a cut is a
 * change of the baseline as much as an increase); else WITHIN_TOLERANCE.
 */
export function adjustmentImpact(input: AdjustmentInput, policy: BaselineImpactPolicy): AdjustmentImpact {
  const original = BigInt(input.originalVnd);
  const previous = BigInt(input.previousVnd);
  const next = BigInt(input.newVnd);
  const delta = next - previous;
  const cumulative = next - original;
  const bac = input.baselineBacVnd === null ? null : BigInt(input.baselineBacVnd);
  const figures = {
    deltaVnd: delta.toString(),
    deltaPctOfPrevious: pct2(delta, previous),
    cumulativeDeltaVnd: cumulative.toString(),
    cumulativePctOfOriginal: pct2(cumulative, original),
    shareOfBaselinePct: bac === null ? null : pct2(delta, bac),
  };
  if (delta === 0n) return { ...figures, classification: 'NONE', reasons: [] };
  const reasons: Array<'BASELINE' | 'ORIGINAL'> = [];
  if (bac !== null && bac > 0n && abs(delta) * 10_000n >= bac * hundredths(policy.reviewPctOfBaseline)) reasons.push('BASELINE');
  if (original > 0n && abs(cumulative) * 10_000n >= original * hundredths(policy.reviewPctOfOriginal)) reasons.push('ORIGINAL');
  if (reasons.length > 0) return { ...figures, classification: 'REVIEW_REQUIRED', reasons };
  if (bac === null || bac <= 0n) return { ...figures, classification: 'NO_BASELINE', reasons };
  return { ...figures, classification: 'WITHIN_TOLERANCE', reasons };
}

/** Whether a version of this class waits for a review by a person other than who made the change. */
export const needsReview = (classification: AdjustmentClass): boolean => classification === 'REVIEW_REQUIRED' || classification === 'NO_BASELINE';

/** A review: a decision from the list, the words of the person when the rule asks, and a person who is not the one who made the change (403 `SELF_APPROVAL_DENIED` is for the caller to raise). */
export function assertReview(input: { decision: string; note: string | undefined; policy: BaselineImpactPolicy }): AdjustmentReviewDecision {
  if (!(ADJUSTMENT_REVIEW_DECISIONS as readonly string[]).includes(input.decision)) throw invalid('decision');
  if (input.policy.noteRequired && (input.note === undefined || input.note.trim().length < 10)) throw invalid('note');
  return input.decision as AdjustmentReviewDecision;
}
