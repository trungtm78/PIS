import { RISK_INDICATORS, RISK_SIGNAL_DEFAULTS, RISK_SIGNAL_KINDS, crossings, criticalEnded, evidenceOf, likelihoodOf, lineMove, parseRiskSignalPolicy, riskSignalParams, scoreSignal, scoreSignals, trendOf } from '../src/risk-signals';
import type { RiskSignalPolicy } from '../src/risk-signals';
import { builtInDefault, validateRuleParams } from '../src/governance-rules';

const POLICY: RiskSignalPolicy = RISK_SIGNAL_DEFAULTS;

const refusal = (run: () => unknown): { code: string; detail: string | undefined } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string };
    return { code: known.code, detail: known.detail };
  }
  throw new Error('it was allowed');
};

describe('the likelihood of a figure against four rising thresholds', () => {
  it('is 1 below the first threshold and one more for each threshold reached', () => {
    const line = [5, 10, 20, 30] as const;
    expect([0, 4.99, 5, 9.99, 10, 19, 20, 29.99, 30, 500].map((value) => likelihoodOf(value, line))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe('the score of a kind of signal (MR.02)', () => {
  it('takes the highest likelihood of the indicators that are known and multiplies it by the fixed impact', () => {
    const scored = scoreSignal('SCHEDULE_DELAY', { SPI_SHORTFALL_PCT: 12, MILESTONE_SLIP_DAYS: 35 }, POLICY);
    expect(scored.known).toBe(true);
    expect(scored.likelihood).toBe(4);
    expect(scored.impact).toBe(POLICY.impact.SCHEDULE_DELAY);
    expect(scored.score).toBe(4 * POLICY.impact.SCHEDULE_DELAY);
    expect(scored.level).toBe('CRITICAL');
    expect(scored.active).toBe(true);
    expect(scored.drivers.map((driver) => [driver.indicator, driver.likelihood])).toEqual([
      ['SPI_SHORTFALL_PCT', 3],
      ['MILESTONE_SLIP_DAYS', 4],
    ]);
  });

  it('does not turn an indicator that could not be known into a zero: the others decide, and none known means no reading at all', () => {
    const partly = scoreSignal('SCHEDULE_DELAY', { SPI_SHORTFALL_PCT: null, MILESTONE_SLIP_DAYS: 8 }, POLICY);
    expect(partly.known).toBe(true);
    expect(partly.likelihood).toBe(2);
    expect(partly.unknown).toEqual(['SPI_SHORTFALL_PCT']);
    const none = scoreSignal('SCHEDULE_DELAY', { SPI_SHORTFALL_PCT: null }, POLICY);
    expect(none.known).toBe(false);
    expect(none.active).toBe(false);
    expect(none.unknown).toEqual(['SPI_SHORTFALL_PCT', 'MILESTONE_SLIP_DAYS']);
  });

  it('opens a line only from the likelihood the rule names', () => {
    const quiet = scoreSignal('FUNDING_GAP', { FUNDING_GAP_PCT: 2 }, POLICY);
    expect(quiet.likelihood).toBe(1);
    expect(quiet.active).toBe(false);
    const stricter: RiskSignalPolicy = { ...POLICY, openFromLikelihood: 3 };
    expect(scoreSignal('FUNDING_GAP', { FUNDING_GAP_PCT: 6 }, stricter).active).toBe(false);
    expect(scoreSignal('FUNDING_GAP', { FUNDING_GAP_PCT: 12 }, stricter).active).toBe(true);
  });

  it('scores every kind at once, each from its own indicators only', () => {
    const all = scoreSignals({ OPEN_CLAIMS: 3, PROCUREMENT_SLIP_DAYS: 70 }, POLICY);
    expect(all.map((one) => one.kind)).toEqual([...RISK_SIGNAL_KINDS]);
    expect(all.find((one) => one.kind === 'CLAIM_EARLY_WARNING')?.likelihood).toBe(4);
    expect(all.find((one) => one.kind === 'PROCUREMENT_DELAY')?.likelihood).toBe(5);
    expect(all.find((one) => one.kind === 'PAYMENT_INTEGRITY')?.known).toBe(false);
  });

  it('reads the thresholds of the rule it is given, not constants of its own', () => {
    const tight: RiskSignalPolicy = { ...POLICY, thresholds: { ...POLICY.thresholds, MILESTONE_SLIP_DAYS: [1, 2, 3, 4] } };
    expect(scoreSignal('SCHEDULE_DELAY', { MILESTONE_SLIP_DAYS: 4 }, tight).likelihood).toBe(5);
    expect(scoreSignal('SCHEDULE_DELAY', { MILESTONE_SLIP_DAYS: 4 }, POLICY).likelihood).toBe(1);
  });
});

describe('the alerts a move of a score raises', () => {
  it('raises the critical alert when the score goes up across the critical line, once', () => {
    expect(crossings(12, 16, POLICY)).toEqual([{ alertType: 'RISK_SCORE_CRITICAL', threshold: 15 }]);
    expect(crossings(15, 16, POLICY)).toEqual([]);
    expect(crossings(20, 12, POLICY)).toEqual([]);
    expect(crossings(0, 20, POLICY)).toEqual([{ alertType: 'RISK_SCORE_CRITICAL', threshold: 15 }]);
  });

  it('raises the jump alert for a line that stood and rose by the points of the rule, never for a new line', () => {
    expect(crossings(4, 10, POLICY)).toEqual([{ alertType: 'RISK_SCORE_JUMP', threshold: 6 }]);
    expect(crossings(4, 9, POLICY)).toEqual([]);
    expect(crossings(0, 10, POLICY)).toEqual([]);
    expect(crossings(8, 16, POLICY).map((one) => one.alertType)).toEqual(['RISK_SCORE_CRITICAL', 'RISK_SCORE_JUMP']);
  });

  it('knows when a standing critical alert has ended', () => {
    expect(criticalEnded(14, POLICY)).toBe(true);
    expect(criticalEnded(15, POLICY)).toBe(false);
  });
});

describe('what a pass does with a line', () => {
  const active = scoreSignal('FUNDING_GAP', { FUNDING_GAP_PCT: 25 }, POLICY);
  const quiet = scoreSignal('FUNDING_GAP', { FUNDING_GAP_PCT: 1 }, POLICY);
  const unknown = scoreSignal('FUNDING_GAP', { FUNDING_GAP_PCT: null }, POLICY);

  it('opens, re-scores, clears, keeps and skips', () => {
    expect(lineMove(undefined, active)).toBe('OPEN');
    expect(lineMove({ status: 'CLEARED', likelihood: 1, impact: 5 }, active)).toBe('OPEN');
    expect(lineMove({ status: 'ACTIVE', likelihood: active.likelihood, impact: active.impact }, active)).toBe('KEEP');
    expect(lineMove({ status: 'ACTIVE', likelihood: 2, impact: active.impact }, active)).toBe('RESCORE');
    expect(lineMove({ status: 'ACTIVE', likelihood: 4, impact: 5 }, quiet)).toBe('CLEAR');
    expect(lineMove(undefined, quiet)).toBe('KEEP');
    expect(lineMove({ status: 'ACTIVE', likelihood: 4, impact: 5 }, unknown)).toBe('SKIP');
  });

  it('puts the readings and the unknown indicators into the evidence, nothing else', () => {
    const readings = { FUNDING_GAP_PCT: 25 };
    const evidence = evidenceOf(active, readings, { year: 2026 });
    expect(evidence).toEqual({ indicators: { FUNDING_GAP_PCT: 25 }, drivers: [{ indicator: 'FUNDING_GAP_PCT', value: 25, likelihood: 4 }], unknown: [], facts: { year: 2026 } });
  });

  it('shows the trend against the score before it', () => {
    expect([trendOf(null, 8), trendOf(8, 12), trendOf(12, 8), trendOf(8, 8)]).toEqual(['NEW', 'UP', 'DOWN', 'FLAT']);
  });
});

describe('the rule RISK_SIGNAL_POLICY', () => {
  it('is registered with a starting value that passes its own schema and parser and is flagged not verified', () => {
    const found = builtInDefault('RISK_SIGNAL_POLICY', 'DEFAULT');
    expect(found?.unverified).toBe(true);
    expect(found?.source.length).toBeGreaterThan(10);
    expect(found?.formula.length).toBeGreaterThan(10);
    expect(parseRiskSignalPolicy(found?.params)).toEqual(POLICY);
    expect(validateRuleParams('RISK_SIGNAL_POLICY', riskSignalParams(POLICY))).toEqual(riskSignalParams(POLICY));
  });

  it('refuses thresholds that do not rise, an impact off the scale and an indicator that is missing, naming the field', () => {
    const base = riskSignalParams(POLICY) as { impact: Record<string, number>; thresholds: Record<string, number[]> };
    expect(refusal(() => parseRiskSignalPolicy({ ...base, thresholds: { ...base.thresholds, OPEN_CLAIMS: [1, 1, 3, 5] } }))).toEqual({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: 'thresholds.OPEN_CLAIMS' });
    expect(refusal(() => parseRiskSignalPolicy({ ...base, impact: { ...base.impact, FUNDING_GAP: 6 } }))).toEqual({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: 'impact.FUNDING_GAP' });
    const missing = { ...base, thresholds: { ...base.thresholds } };
    delete missing.thresholds.SPI_SHORTFALL_PCT;
    expect(refusal(() => parseRiskSignalPolicy(missing))).toEqual({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: 'thresholds.SPI_SHORTFALL_PCT' });
    expect(refusal(() => validateRuleParams('RISK_SIGNAL_POLICY', { ...base, jump_points: 25 })).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
  });

  it('has a threshold line for every indicator and an impact for every kind', () => {
    expect(Object.keys(POLICY.thresholds).sort()).toEqual([...RISK_INDICATORS].sort());
    expect(Object.keys(POLICY.impact).sort()).toEqual([...RISK_SIGNAL_KINDS].sort());
  });
});
