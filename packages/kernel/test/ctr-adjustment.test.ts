import { adjustmentImpact, assertReview, baselineImpactDefaults, baselineImpactOf, needsReview, pct2 } from '../src/ctr-adjustment.ts';
import { judgeLinkage } from '../src/ctr-linkage.ts';
import { addMonths, metStateOf, settlementClockReading, settlementDeadlineDefaults, settlementDeadlineParams, settlementDueOn, settlementMonths } from '../src/ctr-settlement-clock.ts';
import { builtInDefault, validateRuleParams } from '../src/governance-rules.ts';

const policy = baselineImpactOf(baselineImpactDefaults());

describe('the adjustment version of a contract (G1-18)', () => {
  it('is not an adjustment when the value did not change', () => {
    const result = adjustmentImpact({ originalVnd: '1000', previousVnd: '1000', newVnd: '1000', baselineBacVnd: '5000' }, policy);
    expect(result).toMatchObject({ classification: 'NONE', deltaVnd: '0', reasons: [] });
    expect(needsReview(result.classification)).toBe(false);
  });

  it('is within tolerance below both thresholds and needs review at or over the share of the baseline', () => {
    expect(adjustmentImpact({ originalVnd: '1000000', previousVnd: '1000000', newVnd: '1040000', baselineBacVnd: '10000000' }, policy)).toMatchObject({ classification: 'WITHIN_TOLERANCE', shareOfBaselinePct: '0.40', cumulativePctOfOriginal: '4.00' });
    const review = adjustmentImpact({ originalVnd: '1000000', previousVnd: '1000000', newVnd: '1060000', baselineBacVnd: '1000000' }, policy);
    expect(review).toMatchObject({ classification: 'REVIEW_REQUIRED', reasons: ['BASELINE'], shareOfBaselinePct: '6.00' });
    expect(needsReview(review.classification)).toBe(true);
  });

  it('judges the cumulative change over the original too, in both directions, so a cut is a change as much as an increase', () => {
    const cut = adjustmentImpact({ originalVnd: '1000000', previousVnd: '950000', newVnd: '890000', baselineBacVnd: '100000000' }, policy);
    expect(cut).toMatchObject({ classification: 'REVIEW_REQUIRED', reasons: ['ORIGINAL'], deltaVnd: '-60000', cumulativeDeltaVnd: '-110000', cumulativePctOfOriginal: '-11.00' });
  });

  it('says there is no baseline to compare with and still asks for a look, never a clearance', () => {
    const result = adjustmentImpact({ originalVnd: '1000000', previousVnd: '1000000', newVnd: '1010000', baselineBacVnd: null }, policy);
    expect(result).toMatchObject({ classification: 'NO_BASELINE', shareOfBaselinePct: null });
    expect(needsReview(result.classification)).toBe(true);
  });

  it('makes percents from whole numbers, half up, two decimals', () => {
    expect(pct2(1n, 3n)).toBe('33.33');
    expect(pct2(2n, 3n)).toBe('66.67');
    expect(pct2(-1n, 3n)).toBe('-33.33');
    expect(pct2(1n, 0n)).toBeNull();
  });

  it('asks the reviewer for a decision of the list and, by the rule, for words', () => {
    expect(assertReview({ decision: 'KEEP_BASELINE', note: 'The baseline still holds.', policy })).toBe('KEEP_BASELINE');
    expect(() => assertReview({ decision: 'MAYBE', note: 'The baseline still holds.', policy })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => assertReview({ decision: 'REBASELINE', note: 'short', policy })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(assertReview({ decision: 'REBASELINE', note: undefined, policy: { ...policy, noteRequired: false } })).toBe('REBASELINE');
  });

  it('is a governance rule with defaults that pass their own schema and are flagged not confirmed', () => {
    expect(validateRuleParams('CONTRACT_BASELINE_IMPACT', baselineImpactDefaults())).toEqual(baselineImpactDefaults());
    expect(builtInDefault('CONTRACT_BASELINE_IMPACT', 'DEFAULT')).toMatchObject({ unverified: true, legalStatus: 'UNVERIFIED' });
    expect(() => validateRuleParams('CONTRACT_BASELINE_IMPACT', { ...baselineImpactDefaults(), review_pct_of_baseline: -1 })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
  });
});

describe('the linkage of a contract to its project, package and contractor (G1-18)', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    contract: { projectId: 'p1', packageId: 'k1', contractorId: 'c1', originalValueVnd: '1000', currentValueVnd: '1000', isJointVenture: false },
    package: { projectId: 'p1', code: 'PKG-1' },
    award: { winnerContractorId: 'c1', awardPriceVnd: '1000' },
    parties: [{ contractorId: 'c1', lead: true }],
    effectiveChangeCount: 0,
    ...over,
  });

  it('holds when the package is of the project, the award went to the contractor and the price is within the award', () => {
    expect(judgeLinkage(facts())).toEqual({ ok: true, findings: [], awardGapVnd: '0' });
  });

  it('breaks on a package of another project, a package without an award and a contractor that did not win', () => {
    expect(judgeLinkage(facts({ package: { projectId: 'p2', code: 'PKG-2' } })).findings).toContainEqual({ code: 'PACKAGE_PROJECT_MISMATCH', severity: 'ERROR', field: 'package_id' });
    const unawarded = judgeLinkage(facts({ award: null }));
    expect(unawarded).toMatchObject({ ok: false, awardGapVnd: null });
    expect(unawarded.findings).toContainEqual({ code: 'PACKAGE_NOT_AWARDED', severity: 'ERROR', field: 'package_id' });
    const wrong = judgeLinkage(facts({ award: { winnerContractorId: 'c9', awardPriceVnd: '1000' } }));
    expect(wrong.ok).toBe(false);
    expect(wrong.findings).toContainEqual({ code: 'CONTRACTOR_NOT_WINNER', severity: 'ERROR', field: 'contractor_id' });
  });

  it('accepts a joint venture whose member won, warns on a price above the award and asks a joint venture for its leader', () => {
    const venture = facts({ contract: { projectId: 'p1', packageId: 'k1', contractorId: 'c1', originalValueVnd: '1100', currentValueVnd: '1100', isJointVenture: true }, award: { winnerContractorId: 'c2', awardPriceVnd: '1000' }, parties: [{ contractorId: 'c1', lead: true }, { contractorId: 'c2', lead: false }] });
    const reading = judgeLinkage(venture);
    expect(reading.ok).toBe(true);
    expect(reading.findings).toEqual([{ code: 'PRICE_ABOVE_AWARD', severity: 'WARNING', field: 'contract_value_vnd' }]);
    expect(reading.awardGapVnd).toBe('100');
    expect(judgeLinkage({ ...venture, parties: [{ contractorId: 'c2', lead: false }] }).findings).toContainEqual({ code: 'NO_PARTY_LEAD', severity: 'ERROR', field: 'parties' });
  });
});

describe('the settlement clock of a contract (G1-18)', () => {
  const params = settlementDeadlineParams(settlementDeadlineDefaults());

  it('gives 5 months to the large groups and 4 to the small one, flagged not confirmed, and the default months to an unknown group', () => {
    expect(['QTQG', 'A', 'B', 'C'].map((group) => settlementMonths(params, group))).toEqual([5, 5, 5, 4]);
    expect(settlementMonths(params, null)).toBe(5);
    expect(builtInDefault('CONTRACT_SETTLEMENT_DEADLINE', 'DEFAULT')).toMatchObject({ unverified: true, legalStatus: 'UNVERIFIED' });
    expect(() => validateRuleParams('CONTRACT_SETTLEMENT_DEADLINE', { ...settlementDeadlineDefaults(), near_days: 0 })).toThrow(expect.objectContaining({ code: 'GOVERNANCE_RULE_PARAMS_INVALID' }));
  });

  it('counts calendar months and moves a day that does not exist to the last day of the month', () => {
    expect(addMonths('2026-10-31', 4)).toBe('2027-02-28');
    expect(addMonths('2027-10-31', 4)).toBe('2028-02-29');
    expect(settlementDueOn('2026-06-15', 5)).toBe('2026-11-15');
  });

  it('runs, comes near, passes and ends on time or late, the last day itself not being late', () => {
    const base = { dueOn: '2026-11-15', stored: 'OPEN' as const, metOn: null, nearDays: 30 };
    expect(settlementClockReading({ ...base, today: '2026-09-01' })).toEqual({ state: 'RUNNING', daysLeft: 75 });
    expect(settlementClockReading({ ...base, today: '2026-10-20' })).toEqual({ state: 'NEAR', daysLeft: 26 });
    expect(settlementClockReading({ ...base, today: '2026-11-15' })).toEqual({ state: 'NEAR', daysLeft: 0 });
    expect(settlementClockReading({ ...base, today: '2026-11-16' })).toEqual({ state: 'OVERDUE', daysLeft: -1 });
    expect(metStateOf('2026-11-15', '2026-11-15')).toBe('MET');
    expect(metStateOf('2026-11-16', '2026-11-15')).toBe('MET_LATE');
    expect(settlementClockReading({ ...base, today: '2027-01-01', stored: 'MET_LATE', metOn: '2026-11-20' })).toEqual({ state: 'MET_LATE', daysLeft: -5 });
  });
});
