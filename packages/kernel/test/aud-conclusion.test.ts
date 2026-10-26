import {
  CONCLUSION_KINDS,
  FINANCIAL_RECOMMENDATION_TYPES,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  RECOMMENDATION_TYPES,
  assertWithinConclusionTotal,
  financialShortfall,
  isFinancialRecommendation,
  recommendationAmount,
  wholeVnd,
} from '../src/aud-conclusion.ts';
import { DomainError } from '../src/errors.ts';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the money of a conclusion (AUD 5, BR-AUD-01, BR-AUD-05)', () => {
  it('names the kinds, categories, severities and recommendation types of the record, each once', () => {
    for (const list of [CONCLUSION_KINDS, FINDING_CATEGORIES, FINDING_SEVERITIES, RECOMMENDATION_TYPES]) expect(new Set(list).size).toBe(list.length);
    expect(RECOMMENDATION_TYPES.filter(isFinancialRecommendation)).toEqual([...FINANCIAL_RECOMMENDATION_TYPES]);
  });

  it('reads a whole amount of VND from its decimal string, without leading zeros, and refuses anything else naming the field', () => {
    expect(wholeVnd('1250000000', 'total_financial_vnd')).toBe('1250000000');
    expect(wholeVnd('0007', 'total_financial_vnd')).toBe('7');
    expect(wholeVnd('9'.repeat(24), 'total_financial_vnd')).toBe('9'.repeat(24));
    for (const bad of ['', '-1', '1.5', '1e3', ' 12', '1'.repeat(25), '12 000']) {
      const error = refusal(() => wholeVnd(bad, 'total_financial_vnd'));
      expect([error.status, error.code, error.detail]).toEqual([422, 'VALIDATION_FAILED', 'total_financial_vnd']);
    }
  });

  it('AC-ST-AUD-002-1: a financial recommendation without an amount is 422 AMOUNT_REQUIRED, one with a zero amount is a field problem', () => {
    for (const type of FINANCIAL_RECOMMENDATION_TYPES) {
      const missing = refusal(() => recommendationAmount(type, undefined));
      expect([missing.status, missing.code, missing.detail]).toEqual([422, 'AMOUNT_REQUIRED', 'amount_vnd']);
      expect(refusal(() => recommendationAmount(type, '0')).code).toBe('VALIDATION_FAILED');
      expect(refusal(() => recommendationAmount(type, '12.5')).code).toBe('VALIDATION_FAILED');
      expect(recommendationAmount(type, '100000000')).toBe('100000000');
    }
  });

  it('gives a recommendation that is not financial no amount, and refuses one that names an amount', () => {
    for (const type of RECOMMENDATION_TYPES.filter((candidate) => !isFinancialRecommendation(candidate))) {
      expect(recommendationAmount(type, undefined)).toBeNull();
      const error = refusal(() => recommendationAmount(type, '5'));
      expect([error.status, error.code, error.detail]).toEqual([422, 'VALIDATION_FAILED', 'amount_vnd']);
    }
  });

  it('AC-ST-AUD-002-1: the shortfall is the total less the recommended, 50,000,000 for 1,250,000,000 with 800,000,000 and 400,000,000, and never below zero', () => {
    expect(financialShortfall('1250000000', '1200000000')).toBe('50000000');
    expect(financialShortfall('1250000000', '1250000000')).toBe('0');
    expect(financialShortfall('0', '0')).toBe('0');
    expect(financialShortfall('100', '250')).toBe('0');
  });

  it('AC-ST-AUD-002-1: a 100,000,000 recommendation on 1,200,000,000 of 1,250,000,000 is 422 FINANCIAL_TOTAL_MISMATCH with the figures, and the 50,000,000 that fits is allowed', () => {
    expect(() => assertWithinConclusionTotal('1250000000', '1200000000', '50000000')).not.toThrow();
    expect(() => assertWithinConclusionTotal('1250000000', '0', '1250000000')).not.toThrow();
    const error = refusal(() => assertWithinConclusionTotal('1250000000', '1200000000', '100000000'));
    expect([error.status, error.code, error.detail]).toEqual([422, 'FINANCIAL_TOTAL_MISMATCH', 'amount_vnd']);
    expect(error.extensions).toEqual({
      total_financial_vnd: '1250000000',
      recommended_vnd: '1200000000',
      amount_vnd: '100000000',
      remaining_vnd: '50000000',
      excess_vnd: '50000000',
    });
  });

  it('adds up in whole dong beyond the range of a double', () => {
    const big = '9'.repeat(24);
    expect(() => assertWithinConclusionTotal(big, '0', big)).not.toThrow();
    expect(refusal(() => assertWithinConclusionTotal(big, big, '1')).extensions?.excess_vnd).toBe('1');
  });
});
