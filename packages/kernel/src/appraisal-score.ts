import { addDecimal, compareDecimal, multiplyDecimal, roundDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/** The scale of a score on the sheet: 0 (nothing) to 5 (all), whole numbers (BR-PRJ-03). */
export const APPRAISAL_MAX_SCORE = 5;
/** The weights of a set of criteria add up to this (BR-PRJ-03). */
export const APPRAISAL_WEIGHT_TOTAL = '100';
/** Digits of a total score and of the mean of the sheets: the column is numeric(5,2). */
export const APPRAISAL_SCORE_SCALE = 2;

const WEIGHT = /^(0|[1-9]\d{0,2})(\.\d{1,2})?$/;
const MAX_CRITERIA = 50;

/** A criterion of a set as the scoring needs it: its code and its weight, an exact decimal of at most two fraction digits. */
export interface AppraisalCriterion {
  code: string;
  weight: string;
}

export interface AppraisalScoreInput {
  criterionCode: string;
  score: number;
}

export type AppraisalRecommendation = 'ADMIT' | 'REJECT' | 'RETURN';
export const APPRAISAL_RECOMMENDATIONS: readonly AppraisalRecommendation[] = ['ADMIT', 'REJECT', 'RETURN'];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * Checks a set of criteria for scoring: at least one, no code twice, every weight a decimal with at most two fraction digits that is
 * more than nothing, and the weights adding up to 100. A set that does not is 422 CRITERIA_WEIGHT_INVALID: no sheet is scored against it.
 */
export function assertCriteriaWeights(criteria: readonly AppraisalCriterion[]): void {
  if (criteria.length === 0 || criteria.length > MAX_CRITERIA) throw new DomainError('CRITERIA_WEIGHT_INVALID', 422, 'criteria');
  const codes = new Set<string>();
  let total = '0';
  for (const criterion of criteria) {
    if (codes.has(criterion.code) || !WEIGHT.test(criterion.weight) || compareDecimal(criterion.weight, '0') <= 0) throw new DomainError('CRITERIA_WEIGHT_INVALID', 422, 'criteria');
    codes.add(criterion.code);
    total = addDecimal(total, criterion.weight);
  }
  if (compareDecimal(total, APPRAISAL_WEIGHT_TOTAL) !== 0) throw new DomainError('CRITERIA_WEIGHT_INVALID', 422, 'criteria');
}

/**
 * The total score of one sheet: `sum(score x weight) / 5`, half-up to two digits (BR-PRJ-03). Every criterion is scored once and nothing
 * else is: a missing, unknown or repeated criterion is 422 VALIDATION_FAILED naming `scores`, a score that is not a whole number from 0 to 5
 * is 422 SCORE_OUT_OF_RANGE. The weights are exact decimals, so 4,3,5,2,4 against 30/25/20/15/10 is 73.00 with no float in between.
 */
export function appraisalTotal(criteria: readonly AppraisalCriterion[], scores: readonly AppraisalScoreInput[]): string {
  assertCriteriaWeights(criteria);
  const given = new Map<string, number>();
  for (const entry of scores) {
    if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > APPRAISAL_MAX_SCORE) throw new DomainError('SCORE_OUT_OF_RANGE', 422, 'scores');
    if (given.has(entry.criterionCode)) throw invalid('scores');
    given.set(entry.criterionCode, entry.score);
  }
  if (given.size !== criteria.length) throw invalid('scores');
  let weighted = '0';
  for (const criterion of criteria) {
    const score = given.get(criterion.code);
    if (score === undefined) throw invalid('scores');
    weighted = addDecimal(weighted, multiplyDecimal(String(score), criterion.weight));
  }
  return roundDecimal(multiplyDecimal(weighted, '0.2'), APPRAISAL_SCORE_SCALE, 'HALF_UP');
}

const hundredths = (total: string): bigint => BigInt(roundDecimal(total, APPRAISAL_SCORE_SCALE, 'HALF_UP').replace('.', ''));

function fromHundredths(units: bigint): string {
  const digits = units.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * The score of a project: the arithmetic mean of the totals of its sheets, half-up to two digits (BR-PRJ-03). Done on whole hundredths,
 * so a third of 100.00 is 33.33 and a half of 72.01 is 36.01 and nothing depends on a float.
 */
export function meanAppraisalScore(totals: readonly string[]): string {
  if (totals.length === 0) throw new RangeError('the mean of no sheet is undefined');
  const sum = totals.reduce((acc, total) => acc + hundredths(total), 0n);
  const count = BigInt(totals.length);
  return fromHundredths((2n * sum + count) / (2n * count));
}

/**
 * What the score alone recommends (BR-PRJ-04): ADMIT from the threshold up, REJECT below it. It is only a recommendation: admission is
 * decided by a person, and a missing mandatory criterion is for the appraiser to answer with RETURN.
 */
export function thresholdRecommendation(score: string, passThreshold: string): 'ADMIT' | 'REJECT' {
  return compareDecimal(score, passThreshold) >= 0 ? 'ADMIT' : 'REJECT';
}

/**
 * Whether a decision goes against what the sheets say (BR-PRJ-04, F2): it differs from the recommendation of a sheet, or it admits a project
 * whose score is under the threshold. Such a decision needs an override reason.
 */
export function decisionOpposesRecommendation(decision: AppraisalRecommendation, recommendations: readonly AppraisalRecommendation[], score: string, passThreshold: string): boolean {
  if (recommendations.some((recommended) => recommended !== decision)) return true;
  return decision === 'ADMIT' && thresholdRecommendation(score, passThreshold) !== 'ADMIT';
}
