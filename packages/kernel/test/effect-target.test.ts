import {
  CALENDAR_DEFAULTS,
  EFFECT_POLICY_DEFAULTS,
  assertAssessment,
  assertAssessmentDecider,
  assertAssessmentDecision,
  assertFixer,
  assertIndicators,
  assertMeasurement,
  assertProjectStatus,
  calendarRuleCode,
  calendarRuleParams,
  calendarState,
  computeVariance,
  daysLate,
  deriveCalendar,
  effectPolicyParams,
  microText,
  parseCalendarRule,
  parseEffectPolicy,
  suggestConclusion,
  toMicro,
} from '../src/effect-target';
import { builtInDefault, builtInCodes, validateRuleParams } from '../src/governance-rules';

const POLICY = EFFECT_POLICY_DEFAULTS;
const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const uuid = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : undefined);

describe('exact decimals', () => {
  it('reads and writes whole millionths without a float', () => {
    expect(toMicro('1.5', 'v')).toBe(1_500_000n);
    expect(toMicro('-0.000001', 'v')).toBe(-1n);
    expect(microText(1_500_000n)).toBe('1.5');
    expect(microText(2_000_000n)).toBe('2');
    expect(microText(-1n)).toBe('-0.000001');
    expect(microText(0n)).toBe('0');
    expect(refusal(() => toMicro('1.0000001', 'v')).detail).toBe('v');
    expect(refusal(() => toMicro('1e3', 'v')).detail).toBe('v');
    expect(refusal(() => toMicro(5, 'v')).detail).toBe('v');
  });
});

describe('the variance of an indicator against its target (MR.03)', () => {
  it('runs from the baseline (0 percent) to the target (100 percent) when there is a baseline', () => {
    const half = computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '100', targetValue: '200', actualValue: '150' }, POLICY);
    expect(half).toEqual({ varianceValue: '-50', variancePct: '-25.00', achievementPct: '50.00', basis: 'BASELINE_TO_TARGET', band: 'MISSED' });
    const partly = computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '100', targetValue: '200', actualValue: '180' }, POLICY);
    expect(partly.achievementPct).toBe('80.00');
    expect(partly.band).toBe('PARTIAL');
    const met = computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '100', targetValue: '200', actualValue: '230' }, POLICY);
    expect(met.achievementPct).toBe('130.00');
    expect(met.band).toBe('MET');
  });

  it('reads a lower-is-better indicator through the same line from baseline to target', () => {
    const met = computeVariance({ direction: 'LOWER_IS_BETTER', baselineValue: '40', targetValue: '20', actualValue: '18' }, POLICY);
    expect(met.achievementPct).toBe('110.00');
    expect(met.band).toBe('MET');
    expect(met.varianceValue).toBe('-2');
    const away = computeVariance({ direction: 'LOWER_IS_BETTER', baselineValue: '40', targetValue: '20', actualValue: '50' }, POLICY);
    expect(away.achievementPct).toBe('-50.00');
    expect(away.band).toBe('MISSED');
  });

  it('falls back to the ratio of the actual to the target when there is no baseline, and to the direction when nothing else can be said', () => {
    expect(computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: null, targetValue: '1000', actualValue: '750' }, POLICY)).toMatchObject({ achievementPct: '75.00', basis: 'RATIO', band: 'PARTIAL' });
    expect(computeVariance({ direction: 'LOWER_IS_BETTER', baselineValue: null, targetValue: '10', actualValue: '20' }, POLICY)).toMatchObject({ achievementPct: '50.00', basis: 'RATIO', band: 'MISSED' });
    expect(computeVariance({ direction: 'LOWER_IS_BETTER', baselineValue: null, targetValue: '10', actualValue: '0' }, POLICY)).toMatchObject({ achievementPct: '100.00', band: 'MET' });
    expect(computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '5', targetValue: '5', actualValue: '6' }, POLICY)).toMatchObject({ achievementPct: null, basis: 'DIRECTION_ONLY', band: 'MET' });
    expect(computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '5', targetValue: '5', actualValue: '4' }, POLICY)).toMatchObject({ achievementPct: null, band: 'MISSED' });
  });

  it('never makes up a number for what was not measured or cannot be divided', () => {
    expect(computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '1', targetValue: '2', actualValue: null }, POLICY)).toEqual({ varianceValue: null, variancePct: null, achievementPct: null, basis: 'NONE', band: 'NOT_MEASURED' });
    expect(computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: null, targetValue: '0', actualValue: '3' }, POLICY)).toMatchObject({ variancePct: null, achievementPct: null, band: 'MET' });
  });

  it('uses the thresholds of the policy it is given', () => {
    const lenient = { metAtPct: 80, partlyAtPct: 30 };
    expect(computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '100', targetValue: '200', actualValue: '185' }, lenient).band).toBe('MET');
    expect(computeVariance({ direction: 'HIGHER_IS_BETTER', baselineValue: '100', targetValue: '200', actualValue: '185' }, POLICY).band).toBe('PARTIAL');
  });

  it('suggests a conclusion from the bands of the measured indicators only', () => {
    expect(suggestConclusion(['MET', 'MET', 'NOT_MEASURED'])).toBe('SATISFACTORY');
    expect(suggestConclusion(['MISSED', 'MISSED'])).toBe('UNSATISFACTORY');
    expect(suggestConclusion(['MET', 'PARTIAL', 'MISSED'])).toBe('PARTIALLY_SATISFACTORY');
    expect(suggestConclusion(['NOT_MEASURED'])).toBeNull();
  });
});

describe('the target indicators of a draft', () => {
  const ONE = { code: 'KWH_OUTPUT', name: 'Output of the plant', unit: 'kWh', direction: 'HIGHER_IS_BETTER', baseline_value: '0', baseline_on: '2026-01-01', target_value: '1500000.5', measure_after_months: 12, data_source: 'Meter readings', formula: 'Sum of monthly meter readings' };

  it('takes an indicator whole and keeps the numbers as decimal texts', () => {
    const [one] = assertIndicators([ONE]);
    expect(one).toEqual({ code: 'KWH_OUTPUT', name: 'Output of the plant', unit: 'kWh', direction: 'HIGHER_IS_BETTER', baselineValue: '0', baselineOn: '2026-01-01', targetValue: '1500000.5', measureAfterMonths: 12, dataSource: 'Meter readings', formula: 'Sum of monthly meter readings' });
  });

  it('refuses an empty list, a repeated code, a baseline without its day and a number that is not a decimal, naming the field', () => {
    expect(refusal(() => assertIndicators([])).detail).toBe('indicators');
    expect(refusal(() => assertIndicators([ONE, ONE]))).toMatchObject({ detail: 'indicators[1].code', status: 422 });
    expect(refusal(() => assertIndicators([{ ...ONE, baseline_on: undefined }])).detail).toBe('indicators[0].baseline_on');
    expect(refusal(() => assertIndicators([{ ...ONE, target_value: 1500 }])).detail).toBe('indicators[0].target_value');
    expect(refusal(() => assertIndicators([{ ...ONE, direction: 'SIDEWAYS' }])).detail).toBe('indicators[0].direction');
    expect(refusal(() => assertIndicators([{ ...ONE, code: 'lower' }])).detail).toBe('indicators[0].code');
    expect(refusal(() => assertIndicators([{ ...ONE, data_source: '' }])).detail).toBe('indicators[0].data_source');
    expect(refusal(() => assertIndicators([{ ...ONE, baseline_on: '2026-02-30' }])).detail).toBe('indicators[0].baseline_on');
  });
});

describe('the measurement, the assessment and the people who decide', () => {
  const TODAY = '2026-11-08';
  const MEASURE = { indicator_code: 'KWH_OUTPUT', measured_on: '2026-10-31', value: '1200000', method_note: 'Meter readings of October' };

  it('takes a measurement of a day that has come and refuses one of the future', () => {
    expect(assertMeasurement(MEASURE, TODAY, uuid)).toMatchObject({ indicatorCode: 'KWH_OUTPUT', measuredOn: '2026-10-31', value: '1200000', correctsId: null, correctionReason: null });
    expect(refusal(() => assertMeasurement({ ...MEASURE, measured_on: '2026-11-09' }, TODAY, uuid))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'measured_on' });
    expect(refusal(() => assertMeasurement({ ...MEASURE, value: 12 }, TODAY, uuid)).detail).toBe('value');
  });

  it('wants the reason of a correction and only with a correction', () => {
    const target = '00000000-0000-4000-8000-0000000000a1';
    expect(refusal(() => assertMeasurement({ ...MEASURE, corrects_id: target }, TODAY, uuid)).detail).toBe('correction_reason');
    expect(refusal(() => assertMeasurement({ ...MEASURE, correction_reason: 'a reason that is long enough' }, TODAY, uuid)).detail).toBe('correction_reason');
    expect(assertMeasurement({ ...MEASURE, corrects_id: target, correction_reason: 'Meter was read twice' }, TODAY, uuid).correctsId).toBe(target);
    expect(refusal(() => assertMeasurement({ ...MEASURE, corrects_id: 'nope', correction_reason: 'Meter was read twice' }, TODAY, uuid)).detail).toBe('corrects_id');
  });

  it('takes an assessment with one of the three conclusions and a summary, and a decision that returns only with a reason', () => {
    expect(assertAssessment({ kind: 'FINAL', conclusion: 'SATISFACTORY', summary: 'The plant reached its output.' })).toEqual({ kind: 'FINAL', conclusion: 'SATISFACTORY', summary: 'The plant reached its output.' });
    expect(refusal(() => assertAssessment({ kind: 'OTHER', conclusion: 'SATISFACTORY', summary: 'The plant reached its output.' })).detail).toBe('kind');
    expect(refusal(() => assertAssessment({ kind: 'FINAL', conclusion: 'FINE', summary: 'The plant reached its output.' })).detail).toBe('conclusion');
    expect(refusal(() => assertAssessment({ kind: 'FINAL', conclusion: 'SATISFACTORY', summary: 'short' })).detail).toBe('summary');
    expect(assertAssessmentDecision({ decision: 'APPROVE' })).toEqual({ decision: 'APPROVE', reason: null });
    expect(refusal(() => assertAssessmentDecision({ decision: 'RETURN' })).detail).toBe('reason');
    expect(assertAssessmentDecision({ decision: 'RETURN', reason: 'The October readings are missing' }).reason).toBe('The October readings are missing');
    expect(refusal(() => assertAssessmentDecision({ decision: 'SHELVE' })).detail).toBe('decision');
  });

  it('keeps the maker and the approver apart whatever the case of the identifiers', () => {
    expect(refusal(() => assertFixer('ABC', 'abc'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(() => assertFixer('abc', 'def')).not.toThrow();
    expect(refusal(() => assertAssessmentDecider('ABC', 'abc')).code).toBe('SELF_APPROVAL_DENIED');
    expect(() => assertAssessmentDecider('abc', 'def')).not.toThrow();
  });

  it('allows a step only in the statuses the policy names', () => {
    expect(() => assertProjectStatus('COMPLETED', POLICY.measureStatuses)).not.toThrow();
    expect(refusal(() => assertProjectStatus('IMPLEMENTATION', POLICY.measureStatuses))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422 });
  });
});

describe('the calendar of evaluations (Articles 76 and 77, flagged not verified)', () => {
  const ANCHORS = { IMPLEMENTATION_START: { on: '2024-01-31', source: 'STAGE_HISTORY' as const }, COMPLETION: { on: '2026-06-30', source: 'STAGE_HISTORY' as const } };

  it('gives group A four evaluations and groups B and C two, each by months from its anchor day (the last day of a shorter month)', () => {
    expect(CALENDAR_DEFAULTS.A.entries.map((entry) => entry.kind)).toEqual(['INITIAL', 'MIDTERM', 'FINAL', 'IMPACT']);
    expect(CALENDAR_DEFAULTS.B.entries.map((entry) => entry.kind)).toEqual(['FINAL', 'IMPACT']);
    const { entries, waiting } = deriveCalendar(CALENDAR_DEFAULTS.A, ANCHORS, new Set());
    expect(entries.map((entry) => [entry.kind, entry.dueOn])).toEqual([
      ['INITIAL', '2025-01-31'],
      ['MIDTERM', '2026-01-31'],
      ['FINAL', '2026-09-30'],
    ]);
    expect(waiting).toEqual([{ kind: 'IMPACT', anchor: 'HANDOVER' }]);
  });

  it('makes an entry once: kinds that exist are left alone', () => {
    const { entries } = deriveCalendar(CALENDAR_DEFAULTS.A, ANCHORS, new Set(['INITIAL', 'MIDTERM']));
    expect(entries.map((entry) => entry.kind)).toEqual(['FINAL']);
  });

  it('says whether an entry is done, overdue, due soon or upcoming, and how late', () => {
    expect(calendarState({ status: 'DONE', dueOn: '2020-01-01' }, '2026-11-08')).toBe('DONE');
    expect(calendarState({ status: 'PLANNED', dueOn: '2026-11-07' }, '2026-11-08')).toBe('OVERDUE');
    expect(calendarState({ status: 'PLANNED', dueOn: '2026-11-08' }, '2026-11-08')).toBe('DUE_SOON');
    expect(calendarState({ status: 'PLANNED', dueOn: '2026-12-08' }, '2026-11-08')).toBe('DUE_SOON');
    expect(calendarState({ status: 'PLANNED', dueOn: '2026-12-09' }, '2026-11-08')).toBe('UPCOMING');
    expect(daysLate('2026-11-01', '2026-11-08')).toBe(7);
    expect(daysLate('2026-11-09', '2026-11-08')).toBe(0);
  });
});

describe('the rules EFFECT_POLICY and EFFECT_EVALUATION_CALENDAR', () => {
  it('are registered with starting values that pass their own schema and parser and are flagged not verified, with source and as-of', () => {
    const policy = builtInDefault('EFFECT_POLICY', 'DEFAULT');
    expect(policy?.unverified).toBe(true);
    expect(parseEffectPolicy(policy?.params)).toEqual(POLICY);
    expect(validateRuleParams('EFFECT_POLICY', effectPolicyParams(POLICY))).toEqual(effectPolicyParams(POLICY));
    expect(builtInCodes('EFFECT_EVALUATION_CALENDAR')).toEqual(['GROUP_QTQG', 'GROUP_A', 'GROUP_B', 'GROUP_C']);
    for (const group of ['QTQG', 'A', 'B', 'C'] as const) {
      const one = builtInDefault('EFFECT_EVALUATION_CALENDAR', calendarRuleCode(group));
      expect(one?.unverified).toBe(true);
      expect(one?.legalStatus).toBe('UNVERIFIED');
      expect(one?.source).toContain('Điều 76');
      expect(one?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(parseCalendarRule(one?.params)).toEqual(CALENDAR_DEFAULTS[group]);
      expect(validateRuleParams('EFFECT_EVALUATION_CALENDAR', calendarRuleParams(CALENDAR_DEFAULTS[group]))).toEqual(calendarRuleParams(CALENDAR_DEFAULTS[group]));
    }
  });

  it('refuse a partial line at or above the met line and a calendar that names a kind twice, naming the field', () => {
    expect(refusal(() => validateRuleParams('EFFECT_POLICY', { ...effectPolicyParams(POLICY), partly_at_pct: 100 })).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
    expect(refusal(() => parseEffectPolicy({ ...effectPolicyParams(POLICY), partly_at_pct: 100 })).detail).toBe('partly_at_pct');
    const twice = calendarRuleParams({ projectGroup: 'B', entries: [CALENDAR_DEFAULTS.B.entries[0]!, CALENDAR_DEFAULTS.B.entries[0]!] });
    expect(refusal(() => parseCalendarRule(twice)).detail).toBe('entries[1].kind');
  });
});
