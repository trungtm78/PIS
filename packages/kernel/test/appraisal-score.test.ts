import { appraisalTotal, assertCriteriaWeights, decisionOpposesRecommendation, meanAppraisalScore, thresholdRecommendation } from '../src/appraisal-score';
import type { AppraisalCriterion } from '../src/appraisal-score';
import { DomainError } from '../src/errors';

const SET: AppraisalCriterion[] = [
  { code: 'POLICY', weight: '30' },
  { code: 'FEASIBILITY', weight: '25' },
  { code: 'EFFECT', weight: '20' },
  { code: 'READINESS', weight: '15' },
  { code: 'RISK', weight: '10' },
];

const scoresOf = (values: number[], criteria: AppraisalCriterion[] = SET) => criteria.map((criterion, index) => ({ criterionCode: criterion.code, score: values[index] as number }));

function refusal(work: () => unknown): { code: string; status: number; detail?: string | undefined } {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, detail: error.detail };
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('the appraisal score (BR-PRJ-03, ST-PRJ-003)', () => {
  it('AC-ST-PRJ-003-1: weights 30/25/20/15/10 and scores 4,3,5,2,4 give 73.00', () => {
    expect(appraisalTotal(SET, scoresOf([4, 3, 5, 2, 4]))).toBe('73.00');
  });

  it('AC-ST-PRJ-003-1: the ends of the scale are 0.00 and 100.00 whatever the weights', () => {
    expect(appraisalTotal(SET, scoresOf([0, 0, 0, 0, 0]))).toBe('0.00');
    expect(appraisalTotal(SET, scoresOf([5, 5, 5, 5, 5]))).toBe('100.00');
  });

  it('AC-ST-PRJ-003-1: weights with a fraction are exact and the half is rounded up to two digits', () => {
    const fractional: AppraisalCriterion[] = [
      { code: 'A', weight: '33.33' },
      { code: 'B', weight: '33.33' },
      { code: 'C', weight: '33.34' },
    ];
    // (1 x 33.33 + 2 x 33.33 + 3 x 33.34) / 5 = 40.002 -> 40.00 ; (1 x 33.33 + 1 x 33.33 + 2 x 33.34) / 5 = 26.668 -> 26.67
    expect(appraisalTotal(fractional, scoresOf([1, 2, 3], fractional))).toBe('40.00');
    expect(appraisalTotal(fractional, scoresOf([1, 1, 2], fractional))).toBe('26.67');
    const tie: AppraisalCriterion[] = [
      { code: 'A', weight: '0.25' },
      { code: 'B', weight: '99.75' },
    ];
    // (1 x 0.25) / 5 = 0.05 and (3 x 0.25) / 5 = 0.15 exactly: the decimals of the weights stay exact all the way
    expect(appraisalTotal(tie, scoresOf([1, 0], tie))).toBe('0.05');
    expect(appraisalTotal(tie, scoresOf([3, 0], tie))).toBe('0.15');
    const half: AppraisalCriterion[] = [
      { code: 'A', weight: '12.5' },
      { code: 'B', weight: '87.5' },
    ];
    expect(appraisalTotal(half, scoresOf([1, 0], half))).toBe('2.50');
    expect(appraisalTotal(half, scoresOf([0, 1], half))).toBe('17.50');
  });

  it('AC-ST-PRJ-003-1: a set whose weights do not add up to 100 is CRITERIA_WEIGHT_INVALID and nothing is scored', () => {
    const light = SET.map((criterion) => (criterion.code === 'RISK' ? { ...criterion, weight: '9' } : criterion));
    const heavy = SET.map((criterion) => (criterion.code === 'RISK' ? { ...criterion, weight: '10.01' } : criterion));
    for (const broken of [light, heavy]) expect(refusal(() => appraisalTotal(broken, scoresOf([4, 3, 5, 2, 4], broken)))).toMatchObject({ code: 'CRITERIA_WEIGHT_INVALID', status: 422 });
  });

  it('AC-ST-PRJ-003-1: an empty set, a repeated code, a zero or malformed weight are CRITERIA_WEIGHT_INVALID', () => {
    for (const broken of [[], [...SET, { code: 'POLICY', weight: '0' }], SET.map((criterion) => ({ ...criterion, weight: criterion.code === 'RISK' ? '0' : criterion.weight })), [{ code: 'A', weight: '1e2' }], [{ code: 'A', weight: '100.123' }], [{ code: 'A', weight: '-100' }]]) {
      expect(refusal(() => assertCriteriaWeights(broken)).code).toBe('CRITERIA_WEIGHT_INVALID');
    }
    expect(refusal(() => assertCriteriaWeights(Array.from({ length: 51 }, (_, index) => ({ code: `C${index}`, weight: '1' })))).code).toBe('CRITERIA_WEIGHT_INVALID');
    expect(() => assertCriteriaWeights(SET)).not.toThrow();
    expect(() => assertCriteriaWeights([{ code: 'ONLY', weight: '100' }])).not.toThrow();
  });

  it('AC-ST-PRJ-003-1: a score outside 0..5, fractional or not a number is SCORE_OUT_OF_RANGE', () => {
    for (const bad of [6, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const scores = scoresOf([4, 3, 5, 2, 4]);
      scores[2] = { criterionCode: 'EFFECT', score: bad };
      expect(refusal(() => appraisalTotal(SET, scores))).toMatchObject({ code: 'SCORE_OUT_OF_RANGE', status: 422 });
    }
  });

  it('AC-ST-PRJ-003-1: every criterion is scored once and nothing else is scored', () => {
    const missing = scoresOf([4, 3, 5, 2, 4]).slice(0, 4);
    const unknown = [...scoresOf([4, 3, 5, 2, 4]).slice(0, 4), { criterionCode: 'OTHER', score: 3 }];
    const repeated = [...scoresOf([4, 3, 5, 2, 4]).slice(0, 4), { criterionCode: 'POLICY', score: 3 }];
    for (const bad of [missing, unknown, repeated, []]) expect(refusal(() => appraisalTotal(SET, bad))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'scores' });
  });

  it('AC-ST-PRJ-003-1: the mean of the sheets of a round is exact on hundredths, half-up (BR-PRJ-03)', () => {
    expect(meanAppraisalScore(['73.00', '72.00'])).toBe('72.50');
    expect(meanAppraisalScore(['100.00', '100.00', '100.00'])).toBe('100.00');
    expect(meanAppraisalScore(['100.00', '0.00', '0.00'])).toBe('33.33');
    expect(meanAppraisalScore(['0.00', '0.00', '100.00', '100.00', '100.00', '100.00'])).toBe('66.67');
    expect(meanAppraisalScore(['72.01', '0.00'])).toBe('36.01');
    expect(meanAppraisalScore(['0.01', '0.00'])).toBe('0.01');
    expect(meanAppraisalScore(['0.00'])).toBe('0.00');
    expect(meanAppraisalScore(['7'])).toBe('7.00');
    expect(() => meanAppraisalScore([])).toThrow(RangeError);
  });

  it('AC-ST-PRJ-003-3: the threshold recommends ADMIT from the threshold up and REJECT below it, never RETURN', () => {
    expect(thresholdRecommendation('60.00', '60')).toBe('ADMIT');
    expect(thresholdRecommendation('59.99', '60')).toBe('REJECT');
    expect(thresholdRecommendation('72.50', '60.00')).toBe('ADMIT');
  });

  it('AC-ST-PRJ-003-3: a decision opposes the sheets when it differs from one of them or admits under the threshold', () => {
    expect(decisionOpposesRecommendation('ADMIT', ['ADMIT', 'ADMIT'], '72.50', '60')).toBe(false);
    expect(decisionOpposesRecommendation('ADMIT', ['ADMIT', 'REJECT'], '72.50', '60')).toBe(true);
    expect(decisionOpposesRecommendation('REJECT', ['ADMIT'], '72.50', '60')).toBe(true);
    expect(decisionOpposesRecommendation('RETURN', ['RETURN'], '72.50', '60')).toBe(false);
    expect(decisionOpposesRecommendation('ADMIT', ['ADMIT'], '55.00', '60')).toBe(true);
    expect(decisionOpposesRecommendation('REJECT', ['REJECT'], '55.00', '60')).toBe(false);
  });
});
