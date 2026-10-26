import { DomainError } from './errors.ts';

export const CONCLUSION_KINDS = ['INSPECTION_CONCLUSION', 'AUDIT_REPORT', 'AUDIT_NOTICE', 'INTERNAL_REPORT'] as const;
export type ConclusionKind = (typeof CONCLUSION_KINDS)[number];

export const FINDING_CATEGORIES = ['FINANCIAL', 'PROCEDURE', 'PROCUREMENT', 'QUALITY', 'LAND', 'PLANNING', 'OTHER'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The recommendations that carry money (BR-AUD-01): recovery to the State budget, or an adjustment of a payment or a settlement. */
export const FINANCIAL_RECOMMENDATION_TYPES = ['FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT'] as const;
export const RECOMMENDATION_TYPES = [...FINANCIAL_RECOMMENDATION_TYPES, 'PROCESS_CORRECTION', 'ACCOUNTABILITY', 'REFERRAL', 'POLICY_CHANGE'] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const isFinancialRecommendation = (type: RecommendationType): boolean => (FINANCIAL_RECOMMENDATION_TYPES as readonly string[]).includes(type);

const WHOLE_VND = /^[0-9]{1,24}$/;

/** A whole amount of VND as the API writes it (a decimal string, never a number); the value is returned the way it is stored, without leading zeros. Anything else is 422 `VALIDATION_FAILED` naming the field. */
export function wholeDong(value: string, field: string): string {
  if (!WHOLE_VND.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return BigInt(value).toString();
}

/**
 * The amount a recommendation carries (BR-AUD-01): a financial one must name an amount above zero (422 `AMOUNT_REQUIRED` when it names none, `VALIDATION_FAILED` when it is
 * zero); one that is not financial has nothing to add up and carries none (`VALIDATION_FAILED`, naming `amount_vnd`).
 */
export function recommendationAmount(type: RecommendationType, amount: string | undefined): string | null {
  if (!isFinancialRecommendation(type)) {
    if (amount !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'amount_vnd');
    return null;
  }
  if (amount === undefined) throw new DomainError('AMOUNT_REQUIRED', 422, 'amount_vnd');
  const whole = wholeDong(amount, 'amount_vnd');
  if (whole === '0') throw new DomainError('VALIDATION_FAILED', 422, 'amount_vnd');
  return whole;
}

/** What a conclusion has not yet been given a recommendation for: its total less the financial recommendations, never below zero (the guard keeps the sum within the total). */
export function financialShortfall(total: string, recommended: string): string {
  const difference = BigInt(total) - BigInt(recommended);
  return (difference > 0n ? difference : 0n).toString();
}

/**
 * BR-AUD-05: the financial recommendations of a conclusion, a new one included, stay within its total; the sum above it is 422 `FINANCIAL_TOTAL_MISMATCH`. The extensions say the figures,
 * so that the screen can show the amount that is left and the excess of the one that was tried.
 */
export function assertWithinConclusionTotal(total: string, recommended: string, amount: string): void {
  const after = BigInt(recommended) + BigInt(amount);
  if (after > BigInt(total)) {
    throw new DomainError('FINANCIAL_TOTAL_MISMATCH', 422, 'amount_vnd', {
      extensions: {
        total_financial_vnd: total,
        recommended_vnd: recommended,
        amount_vnd: amount,
        remaining_vnd: financialShortfall(total, recommended),
        excess_vnd: (after - BigInt(total)).toString(),
      },
    });
  }
}
