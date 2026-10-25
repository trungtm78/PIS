import { compareDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The result of the selection of a contractor (BID 3 F7, ST-BID-006): what the three outcomes carry, that the price of an award never passes the price of the package, and
 * what a decision does to the package. An award is the decision of a person with the authority to take it, on a decision document; nothing here reads an analysis made by a machine.
 */
export const RESULT_OUTCOMES = ['AWARDED', 'NO_ACCEPTABLE_BID', 'CANCELLED'] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

export const RESULT_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const RESULT_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type ResultDecision = (typeof RESULT_DECISIONS)[number];

/** The status a package takes when the result that ends its selection is approved. */
export const PACKAGE_STATUS_AFTER_RESULT: Readonly<Record<ResultOutcome, string>> = {
  AWARDED: 'AWARDED',
  NO_ACCEPTABLE_BID: 'NO_ACCEPTABLE_BID',
  CANCELLED: 'CANCELLED',
};

/** The DoA document type under which the approval of a result is limited, when the tenant configured a rule for it. */
export const RESULT_DOA_DOCUMENT_TYPE = 'BID_RESULT';

export const MAX_RESULT_COMMENT = 2000;

/**
 * An award names the winner and the price; the other two outcomes name neither (422 `VALIDATION_FAILED` on the field that does not belong): a package with no acceptable bid
 * or a cancelled one has no winner to speak of, and a price without one would be read as an award by whoever sees it.
 */
export function assertResultShape(outcome: ResultOutcome, winnerContractorId: string | undefined, awardPriceVnd: string | undefined): void {
  if (outcome === 'AWARDED') {
    if (winnerContractorId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'winner_contractor_id');
    if (awardPriceVnd === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'award_price_vnd');
    if (compareDecimal(awardPriceVnd, '0') <= 0) throw new DomainError('VALIDATION_FAILED', 422, 'award_price_vnd');
    return;
  }
  if (winnerContractorId !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'winner_contractor_id');
  if (awardPriceVnd !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'award_price_vnd');
}

/** 422 `PRICE_EXCEEDS_PACKAGE_BUDGET` when the price of the award is above the price of the package; equal is within it (both whole VND as decimal text). */
export function assertPriceWithinBudget(awardPriceVnd: string, budgetVnd: string): void {
  if (compareDecimal(awardPriceVnd, budgetVnd) > 0) {
    throw new DomainError('PRICE_EXCEEDS_PACKAGE_BUDGET', 422, 'award_price_vnd', { extensions: { budget_vnd: budgetVnd, award_price_vnd: awardPriceVnd } });
  }
}
