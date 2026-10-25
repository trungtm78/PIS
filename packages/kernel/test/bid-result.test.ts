import { DomainError, PACKAGE_STATUS_AFTER_RESULT, RESULT_DECISIONS, RESULT_OUTCOMES, RESULT_STATUSES, assertPriceWithinBudget, assertResultShape } from '../src/index.ts';

const refusal = (work: () => void): DomainError | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof DomainError ? error : undefined;
  }
  return undefined;
};

describe('the vocabulary of a result', () => {
  it('has the three outcomes, the five statuses and the two decisions of the specification', () => {
    expect(RESULT_OUTCOMES).toEqual(['AWARDED', 'NO_ACCEPTABLE_BID', 'CANCELLED']);
    expect(RESULT_STATUSES).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED']);
    expect(RESULT_DECISIONS).toEqual(['APPROVE', 'REJECT']);
  });

  it('gives the package the status of the outcome that ended its selection', () => {
    expect(PACKAGE_STATUS_AFTER_RESULT).toEqual({ AWARDED: 'AWARDED', NO_ACCEPTABLE_BID: 'NO_ACCEPTABLE_BID', CANCELLED: 'CANCELLED' });
  });
});

describe('assertResultShape', () => {
  it('asks an award for its winner and its price, and a price above zero', () => {
    expect(refusal(() => assertResultShape('AWARDED', undefined, '100'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'winner_contractor_id' });
    expect(refusal(() => assertResultShape('AWARDED', 'w', undefined))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'award_price_vnd' });
    expect(refusal(() => assertResultShape('AWARDED', 'w', '0'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'award_price_vnd' });
    expect(refusal(() => assertResultShape('AWARDED', 'w', '17650000000'))).toBeUndefined();
  });

  it('lets the other outcomes name neither a winner nor a price', () => {
    for (const outcome of ['NO_ACCEPTABLE_BID', 'CANCELLED'] as const) {
      expect(refusal(() => assertResultShape(outcome, undefined, undefined))).toBeUndefined();
      expect(refusal(() => assertResultShape(outcome, 'w', undefined))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'winner_contractor_id' });
      expect(refusal(() => assertResultShape(outcome, undefined, '5'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'award_price_vnd' });
    }
  });
});

describe('assertPriceWithinBudget', () => {
  it('AC-ST-BID-006-1, UAT-AC455: refuses 18,500,000,000 against a package of 18,000,000,000, says both figures, and takes 17,650,000,000 and the price itself', () => {
    expect(refusal(() => assertPriceWithinBudget('18500000000', '18000000000'))).toMatchObject({
      code: 'PRICE_EXCEEDS_PACKAGE_BUDGET',
      status: 422,
      detail: 'award_price_vnd',
      extensions: { budget_vnd: '18000000000', award_price_vnd: '18500000000' },
    });
    expect(refusal(() => assertPriceWithinBudget('18000000001', '18000000000'))?.code).toBe('PRICE_EXCEEDS_PACKAGE_BUDGET');
    expect(refusal(() => assertPriceWithinBudget('17650000000', '18000000000'))).toBeUndefined();
    expect(refusal(() => assertPriceWithinBudget('18000000000', '18000000000'))).toBeUndefined();
  });

  it('compares exact figures wider than a double holds', () => {
    expect(refusal(() => assertPriceWithinBudget('999999999999999999999999', '999999999999999999999998'))?.code).toBe('PRICE_EXCEEDS_PACKAGE_BUDGET');
    expect(refusal(() => assertPriceWithinBudget('999999999999999999999998', '999999999999999999999999'))).toBeUndefined();
  });
});
