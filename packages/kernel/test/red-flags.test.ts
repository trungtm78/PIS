import { DomainError } from '../src/errors';
import {
  BUILT_IN_OCP_IDS,
  BUILT_IN_RED_FLAG_CODES,
  builtInDefault,
  compareFindings,
  evaluateRedFlags,
  nextRedFlagStatus,
  rankingDefaults,
  redFlagIndicator,
  registerRedFlagIndicator,
  registeredRedFlagIndicators,
  reopensAfterRescan,
  scoreOf,
  validateRuleParams,
} from '../src/index';
import type { IndicatorParams, RedFlagFacts } from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const blank: RedFlagFacts = {
  packageCode: 'G1',
  method: 'OPEN_BIDDING',
  estimateVnd: '900000000',
  bidderCount: 3,
  bidPricesVnd: ['800000000', '820000000', '850000000'],
  awardPriceVnd: '800000000',
  contractValueVnd: '800000000',
  contractOriginalValueVnd: '800000000',
  approvedChangeCount: 0,
  maxCumulativeVariationPct: 0,
  tenderPeriodDays: 20,
  splitCount: 1,
  splitTotalVnd: '900000000',
  nearThresholdDirectAwards: 0,
  restrictedBidderCount: 0,
};

const rules = (): Map<string, IndicatorParams> => {
  const map = new Map<string, IndicatorParams>();
  for (const code of BUILT_IN_RED_FLAG_CODES) map.set(code, builtInDefault('RED_FLAG_RULE', code)?.params as unknown as IndicatorParams);
  return map;
};

const firedBy = (facts: RedFlagFacts): string[] =>
  evaluateRedFlags(facts, rules())
    .filter((reading) => reading.status === 'FIRED')
    .map((reading) => reading.code);

describe('red flags of procurement (G4-3)', () => {
  it('registers the twelve OCP indicators with their ids, formula, source, day and an unconfirmed status', () => {
    expect(BUILT_IN_RED_FLAG_CODES).toHaveLength(12);
    expect(Object.values(BUILT_IN_OCP_IDS).sort()).toEqual(['R002', 'R003', 'R011', 'R018', 'R028', 'R031', 'R046', 'R054', 'R055', 'R059', 'R064', 'R069']);
    for (const code of BUILT_IN_RED_FLAG_CODES) {
      const indicator = redFlagIndicator(code);
      expect(indicator?.formula.length).toBeGreaterThan(7);
      expect(indicator?.legalStatus).toBe('UNVERIFIED');
      expect(builtInDefault('RED_FLAG_RULE', code)?.unverified).toBe(true);
      expect(validateRuleParams('RED_FLAG_RULE', builtInDefault('RED_FLAG_RULE', code)?.params)).toEqual(builtInDefault('RED_FLAG_RULE', code)?.params);
    }
  });

  it('is clear on an ordinary procurement', () => {
    expect(firedBy(blank)).toEqual([]);
  });

  it('fires each indicator on its own facts', () => {
    expect(firedBy({ ...blank, bidderCount: 1 })).toEqual(['SINGLE_BIDDER']);
    expect(firedBy({ ...blank, tenderPeriodDays: 5 })).toEqual(['SHORT_TENDER_PERIOD']);
    expect(firedBy({ ...blank, awardPriceVnd: '900000000' })).toContain('AWARD_AT_OR_ABOVE_ESTIMATE');
    expect(firedBy({ ...blank, bidPricesVnd: ['800000000', '800000000', '850000000'] })).toEqual(['IDENTICAL_BID_PRICES']);
    expect(firedBy({ ...blank, restrictedBidderCount: 1 })).toEqual(['DEBARRED_BIDDER']);
    expect(firedBy({ ...blank, contractValueVnd: '900000000' })).toEqual(['AWARD_VS_FINAL_PRICE_GAP']);
    expect(firedBy({ ...blank, approvedChangeCount: 3 })).toEqual(['CONTRACT_AMENDED']);
    expect(firedBy({ ...blank, maxCumulativeVariationPct: 12.5 })).toEqual(['ADDENDUM_PRICE_INCREASE']);
    expect(firedBy({ ...blank, estimateVnd: '960000000' })).toContain('THRESHOLD_MANIPULATION');
    expect(firedBy({ ...blank, splitCount: 3, splitTotalVnd: '2400000000' })).toEqual(['SPLIT_PROCUREMENT']);
    expect(firedBy({ ...blank, nearThresholdDirectAwards: 3 })).toEqual(['NEAR_THRESHOLD_DIRECT_AWARDS']);
    expect(firedBy({ ...blank, method: 'DIRECT_APPOINTMENT', bidderCount: 1, contractOriginalValueVnd: '900000000', contractValueVnd: '1100000000', awardPriceVnd: '1100000000' })).toContain('DIRECT_AWARD_THEN_CHANGE');
  });

  it('does not call a single bidder or a short period a flag on a method that has no competition to measure', () => {
    expect(firedBy({ ...blank, method: 'DIRECT_APPOINTMENT', bidderCount: 1, tenderPeriodDays: 1 })).toEqual([]);
  });

  it('says NOT_COMPUTABLE with the missing facts and never clear for want of data', () => {
    const readings = evaluateRedFlags({ ...blank, bidderCount: null, tenderPeriodDays: null, awardPriceVnd: null }, rules());
    const single = readings.find((reading) => reading.code === 'SINGLE_BIDDER');
    expect(single).toMatchObject({ status: 'NOT_COMPUTABLE', missing: ['bidderCount'] });
    expect(readings.find((reading) => reading.code === 'SHORT_TENDER_PERIOD')?.missing).toEqual(['tenderPeriodDays']);
    expect(readings.find((reading) => reading.code === 'AWARD_VS_FINAL_PRICE_GAP')?.status).toBe('NOT_COMPUTABLE');
    expect(scoreOf(readings, rankingDefaults()).notComputable).toEqual(expect.arrayContaining(['SINGLE_BIDDER', 'SHORT_TENDER_PERIOD']));
  });

  it('skips an indicator that the tenant switched off', () => {
    const off = rules();
    off.set('SINGLE_BIDDER', { ...(off.get('SINGLE_BIDDER') as IndicatorParams), enabled: false });
    expect(evaluateRedFlags({ ...blank, bidderCount: 1 }, off).some((reading) => reading.code === 'SINGLE_BIDDER')).toBe(false);
  });

  it('ranks by the sum of weights into bands and orders the work: highest, then oldest', () => {
    const all = evaluateRedFlags({ ...blank, bidderCount: 1, tenderPeriodDays: 5, restrictedBidderCount: 1 }, rules());
    const score = scoreOf(all, rankingDefaults());
    expect(score).toMatchObject({ score: 10, band: 'HIGH', fired: expect.arrayContaining(['SINGLE_BIDDER', 'SHORT_TENDER_PERIOD', 'DEBARRED_BIDDER']) });
    expect(scoreOf(evaluateRedFlags({ ...blank, approvedChangeCount: 3 }, rules()), rankingDefaults())).toMatchObject({ score: 2, band: 'LOW' });
    expect(scoreOf(evaluateRedFlags(blank, rules()), rankingDefaults()).band).toBe('NONE');
    const ordered = [
      { score: 3, firstFlaggedAt: '2026-01-01', subjectCode: 'B' },
      { score: 6, firstFlaggedAt: '2026-03-01', subjectCode: 'C' },
      { score: 6, firstFlaggedAt: '2026-02-01', subjectCode: 'A' },
    ].sort(compareFindings);
    expect(ordered.map((entry) => entry.subjectCode)).toEqual(['A', 'C', 'B']);
  });

  it('is open to indicators of other lanes, each with its own provenance, once', () => {
    registerRedFlagIndicator({
      code: 'VENDOR_SAME_ADDRESS',
      ocpId: 'R042',
      dataSources: ['VND vendor address'],
      vendorSide: true,
      formula: 'Two bidders share a registered address',
      source: 'OCP red flags 2024',
      asOf: '2026-11-08',
      legalStatus: 'UNVERIFIED',
      evaluate: () => ({ status: 'NOT_COMPUTABLE', value: null, threshold: null, missing: ['vendorAddress'] }),
    });
    expect(registeredRedFlagIndicators().some((indicator) => indicator.code === 'VENDOR_SAME_ADDRESS' && indicator.vendorSide)).toBe(true);
    expect(() => registerRedFlagIndicator({ ...(redFlagIndicator('VENDOR_SAME_ADDRESS') as unknown as Record<string, unknown>) } as never)).toThrow('already registered');
  });

  it('reviews a finding in two steps: clearing needs a second auditor, and every decision needs its reason', () => {
    expect(nextRedFlagStatus('NEW', 'TAKE', { actor: 'a', proposer: null })).toBe('IN_REVIEW');
    expect(refusal(() => nextRedFlagStatus('IN_REVIEW', 'PROPOSE_CLEAR', { actor: 'a', proposer: null, reason: 'ok' })).detail).toBe('reason');
    expect(nextRedFlagStatus('IN_REVIEW', 'PROPOSE_CLEAR', { actor: 'a', proposer: null, reason: 'the price is justified by the estimate' })).toBe('CLEAR_PROPOSED');
    expect(refusal(() => nextRedFlagStatus('CLEAR_PROPOSED', 'CONFIRM_CLEAR', { actor: 'a', proposer: 'a' })).code).toBe('SELF_APPROVAL_DENIED');
    expect(nextRedFlagStatus('CLEAR_PROPOSED', 'CONFIRM_CLEAR', { actor: 'b', proposer: 'a' })).toBe('CLEARED');
    expect(nextRedFlagStatus('CLEAR_PROPOSED', 'REJECT_CLEAR', { actor: 'b', proposer: 'a', reason: 'not convincing' })).toBe('IN_REVIEW');
    expect(nextRedFlagStatus('IN_REVIEW', 'REFER', { actor: 'a', proposer: null, reason: 'open an engagement' })).toBe('REFERRED');
    expect(refusal(() => nextRedFlagStatus('CLEARED', 'TAKE', { actor: 'a', proposer: null })).code).toBe('RED_FLAG_STATE_INVALID');
  });

  it('reopens a cleared finding when a new indicator fires or the score rises', () => {
    expect(reopensAfterRescan({ fired: ['SINGLE_BIDDER'], score: 3 }, { fired: ['SINGLE_BIDDER'], score: 3 })).toBe(false);
    expect(reopensAfterRescan({ fired: ['SINGLE_BIDDER'], score: 3 }, { fired: ['SINGLE_BIDDER', 'CONTRACT_AMENDED'], score: 5 })).toBe(true);
    expect(reopensAfterRescan({ fired: ['SINGLE_BIDDER'], score: 3 }, { fired: [], score: 0 })).toBe(false);
  });
});
