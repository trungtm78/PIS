import type { DomainError } from '../src/errors';
import { FIN_CRITERIA_CATEGORIES, FIN_CRITERIA_DEFAULTS, assertCriteriaSet, isFinCriteriaCategory, scoreCriteria } from '../src/fin-criteria';
import type { FinCriteriaSet } from '../src/fin-criteria';
import { defaultGovernanceRule, registeredRuleTypes, validateRuleParams } from '../src/governance-rules';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const set = (...weights: string[]): FinCriteriaSet => ({ category: 'SAFETY', criteria: weights.map((weightPct, index) => ({ key: `criterion_${index}`, label: `Tiêu chí ${index}`, weightPct })) });
const evidence = 'Biên bản kiểm tra hiện trạng ngày 01/11/2026';

describe('the non-financial criteria of a safety, compliance or maintenance project', () => {
  it('has built-in sets that add up to exactly 100 and are flagged as unverified', () => {
    for (const category of FIN_CRITERIA_CATEGORIES) {
      const defaults = FIN_CRITERIA_DEFAULTS[category];
      expect(defaults.unverified).toBe(true);
      expect(() => assertCriteriaSet({ category, criteria: [...defaults.criteria] })).not.toThrow();
    }
    expect(isFinCriteriaCategory('SAFETY')).toBe(true);
    expect(isFinCriteriaCategory('REVENUE')).toBe(false);
  });

  it('refuses a set whose weights do not add up to 100, or that is not well formed', () => {
    const reasonOf = (candidate: FinCriteriaSet): unknown => refusal(() => assertCriteriaSet(candidate)).extensions?.['reason'];
    expect(reasonOf(set('50', '49.99'))).toBe('WEIGHTS_MUST_ADD_UP_TO_100');
    expect(reasonOf(set('50', '50.01'))).toBe('WEIGHTS_MUST_ADD_UP_TO_100');
    expect(reasonOf(set('100'))).toBe('COUNT_OUT_OF_RANGE');
    expect(reasonOf(set('100', '0'))).toBe('MUST_BE_POSITIVE');
    expect(reasonOf(set('50.001', '49.999'))).toBe('TOO_MANY_DECIMALS');
    expect(reasonOf(set('-10', '110'))).toBe('MUST_NOT_BE_NEGATIVE');
    expect(reasonOf({ category: 'REVENUE' as 'SAFETY', criteria: set('50', '50').criteria })).toBe('UNKNOWN_CATEGORY');
    expect(reasonOf({ category: 'SAFETY', criteria: [{ key: 'a', label: 'x', weightPct: '50' }, { key: 'b', label: 'y', weightPct: '50' }] })).toBe('NOT_A_KEY');
    expect(reasonOf({ category: 'SAFETY', criteria: [{ key: 'aa', label: 'x', weightPct: '50' }, { key: 'aa', label: 'y', weightPct: '50' }] })).toBe('DUPLICATE_KEY');
    expect(reasonOf({ category: 'SAFETY', criteria: [{ key: 'aa', label: ' ', weightPct: '50' }, { key: 'bb', label: 'y', weightPct: '50' }] })).toBe('EMPTY');
    expect(reasonOf({ category: 'SAFETY', criteria: Array.from({ length: 16 }, (_, index) => ({ key: `key_${index}`, label: 'x', weightPct: '6.25' })) })).toBe('COUNT_OUT_OF_RANGE');
  });

  it('weighs the scores with exact arithmetic and gives the index against the best possible', () => {
    const result = scoreCriteria(set('30', '25', '20', '15', '10'), [
      { key: 'criterion_0', score: 5, evidence },
      { key: 'criterion_1', score: 4, evidence },
      { key: 'criterion_2', score: 3, evidence },
      { key: 'criterion_3', score: 2, evidence },
      { key: 'criterion_4', score: 1, evidence },
    ]);
    // 30x5 + 25x4 + 20x3 + 15x2 + 10x1 = 150 + 100 + 60 + 30 + 10 = 350 -> 3.50 of 5, 70.00%
    expect(result.weightedScore).toBe('3.50');
    expect(result.indexPct).toBe('70.00');
    expect(result.lines.map((line) => line.contribution)).toEqual(['1.500', '1.000', '0.600', '0.300', '0.100']);
    expect(result.formula).toContain('Σ');
  });

  it('gives the best set 5.00 and 100.00 and the worst 1.00 and 20.00', () => {
    const best = scoreCriteria(set('33.33', '33.33', '33.34'), ['criterion_0', 'criterion_1', 'criterion_2'].map((key) => ({ key, score: 5, evidence })));
    expect([best.weightedScore, best.indexPct]).toEqual(['5.00', '100.00']);
    const worst = scoreCriteria(set('33.33', '33.33', '33.34'), ['criterion_0', 'criterion_1', 'criterion_2'].map((key) => ({ key, score: 1, evidence })));
    expect([worst.weightedScore, worst.indexPct]).toEqual(['1.00', '20.00']);
  });

  it('refuses a score that is missing, repeated, unknown, out of the scale or without evidence', () => {
    const base = set('50', '50');
    const both = [{ key: 'criterion_0', score: 3, evidence }, { key: 'criterion_1', score: 3, evidence }];
    const reasonOf = (scores: Parameters<typeof scoreCriteria>[1]): unknown => refusal(() => scoreCriteria(base, scores)).extensions?.['reason'];
    expect(refusal(() => scoreCriteria(base, [both[0] as (typeof both)[number]])).extensions).toMatchObject({ reason: 'MISSING_SCORES', missing: ['criterion_1'] });
    expect(reasonOf([...both, both[0] as (typeof both)[number]])).toBe('DUPLICATE_KEY');
    expect(reasonOf([{ key: 'nothing', score: 3, evidence }])).toBe('UNKNOWN_CRITERION');
    expect(reasonOf([{ key: 'criterion_0', score: 0, evidence }, both[1] as (typeof both)[number]])).toBe('OUT_OF_RANGE');
    expect(reasonOf([{ key: 'criterion_0', score: 6, evidence }, both[1] as (typeof both)[number]])).toBe('OUT_OF_RANGE');
    expect(reasonOf([{ key: 'criterion_0', score: 2.5, evidence }, both[1] as (typeof both)[number]])).toBe('OUT_OF_RANGE');
    expect(reasonOf([{ key: 'criterion_0', score: 3, evidence: '  ' }, both[1] as (typeof both)[number]])).toBe('EVIDENCE_REQUIRED');
  });
});

describe('the weights as rule data of the governance platform', () => {
  it('registers FIN_CRITERIA with a built-in default for each category, flagged as unverified', () => {
    expect(registeredRuleTypes()).toContain('FIN_CRITERIA');
    for (const category of FIN_CRITERIA_CATEGORIES) {
      const found = defaultGovernanceRule('FIN_CRITERIA', category);
      expect(found).toMatchObject({ type: 'FIN_CRITERIA', code: category, version: 0, source: 'DEFAULT', unverified: true });
      const params = found?.params as { criteria: Array<{ key: string; label: string; weight_pct: string }> };
      expect(params.criteria.length).toBe(FIN_CRITERIA_DEFAULTS[category].criteria.length);
      expect(() => validateRuleParams('FIN_CRITERIA', params)).not.toThrow();
    }
  });

  it('refuses params whose weights do not add up to 100 or whose keys repeat, naming the field', () => {
    const detailOf = (params: unknown): string | undefined => refusal(() => validateRuleParams('FIN_CRITERIA', params)).detail;
    expect(detailOf({ criteria: [{ key: 'one_a', label: 'Một', weight_pct: '60' }, { key: 'two_b', label: 'Hai', weight_pct: '39' }] })).toBe('criteria');
    expect(detailOf({ criteria: [{ key: 'one_a', label: 'Một', weight_pct: '50' }, { key: 'one_a', label: 'Hai', weight_pct: '50' }] })).toBe('criteria[1].key');
    expect(detailOf({ criteria: [{ key: 'one_a', label: 'Một', weight_pct: '120' }, { key: 'two_b', label: 'Hai', weight_pct: '50' }] })).toContain('weight_pct');
    expect(detailOf({ criteria: [{ key: 'one_a', label: 'Một', weight_pct: '100' }] })).toBe('criteria');
  });
});
