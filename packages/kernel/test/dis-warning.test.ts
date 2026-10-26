import type { DomainError } from '../src/errors.ts';
import { checkRule, dedupeKeyOf, evaluateRule, expectedRatePct, inForce, nextWarningStatus, reasonOf } from '../src/dis-warning.ts';
import type { ProjectFacts, RuleInput } from '../src/dis-warning.ts';

const rule = (over: RuleInput = {}): RuleInput => ({
  rule_code: 'EW-01',
  name: 'Disbursement below the expected curve',
  metric_code: 'YTD_RATE_GAP',
  comparator: 'GTE',
  threshold_json: { points: 10, critical_points: 20 },
  severity: 'WARNING',
  scope_kind: 'PROJECT',
  legal_basis: 'DIS BR-DIS-13 [assumption until the finance office signs]',
  effective_from: '2027-01-01',
  ...over,
});
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ ratePct: '50.0000', expectedPct: '45.0000', reportHandedIn: true, daysPastDeadline: -2, hasCapital: true, hasNationalCode: true, periodDeltaVnd: '0', ...over });
const refusal = (work: () => unknown): { code: string; status: number; detail: string | undefined } => {
  try {
    work();
  } catch (error) {
    const e = error as DomainError;
    return { code: e.code, status: e.status, detail: e.detail };
  }
  throw new Error('expected a refusal');
};

describe('the early-warning rules (ST-DIS-012, BR-DIS-13, thresholds are assumptions until the finance office signs)', () => {
  it('reads a rule that is well formed, with the threshold in the shape its metric asks for and the comparator that metric is read with', () => {
    expect(checkRule(rule())).toMatchObject({ ruleCode: 'EW-01', metricCode: 'YTD_RATE_GAP', comparator: 'GTE', threshold: { points: '10', critical_points: '20' }, severity: 'WARNING', scopeKind: 'PROJECT', autoExplanation: false, effectiveUntil: null });
    expect(checkRule(rule({ rule_code: 'EW-02', metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { explanation_due_days: 3 }, severity: 'CRITICAL', auto_explanation: true }))).toMatchObject({
      threshold: { grace_days: 0, explanation_due_days: 3 },
      autoExplanation: true,
    });
    expect(checkRule(rule({ rule_code: 'EW-05', metric_code: 'NATIONAL_CODE_MISSING', comparator: 'MISSING', threshold_json: {} })).threshold).toEqual({});
    expect(checkRule(rule({ rule_code: 'EW-07', metric_code: 'PERIOD_DELTA_NEGATIVE', comparator: 'LT', threshold_json: {}, effective_until: '2027-12-31' })).effectiveUntil).toBe('2027-12-31');
  });

  it('AC-ST-DIS-012-3 / UAT-PLAN-70: a metric the product does not compute is 422 METRIC_UNKNOWN, so that a rule never waits for a figure nobody makes', () => {
    expect(refusal(() => checkRule(rule({ metric_code: 'VIBES' })))).toEqual({ code: 'METRIC_UNKNOWN', status: 422, detail: 'metric_code' });
    expect(refusal(() => checkRule(rule({ metric_code: undefined })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'metric_code' });
  });

  it('is 422 on the field for every other fault: the code, the comparator of the metric, the severity, the scope, the days, the thresholds and the words', () => {
    const cases: Array<[RuleInput, string]> = [
      [{ rule_code: 'ew-01' }, 'rule_code'],
      [{ rule_code: '' }, 'rule_code'],
      [{ comparator: 'LT' }, 'comparator'],
      [{ severity: 'URGENT' }, 'severity'],
      [{ scope_kind: 'UNIT' }, 'scope_kind'],
      [{ scope_kind: 'TENANT' }, 'scope_kind'],
      [{ name: 'ab' }, 'name'],
      [{ legal_basis: 'x' }, 'legal_basis'],
      [{ effective_from: '2027-02-30' }, 'effective_from'],
      [{ effective_from: '1/1/2027' }, 'effective_from'],
      [{ effective_until: '2026-12-31' }, 'effective_until'],
      [{ auto_explanation: 'yes' }, 'auto_explanation'],
      [{ threshold_json: null }, 'threshold_json'],
      [{ threshold_json: [] }, 'threshold_json'],
      [{ threshold_json: { points: 0 } }, 'threshold_json.points'],
      [{ threshold_json: { points: 101 } }, 'threshold_json.points'],
      [{ threshold_json: { points: '1e1' } }, 'threshold_json.points'],
      [{ threshold_json: { points: 10, critical_points: 10 } }, 'threshold_json.critical_points'],
      [{ threshold_json: { points: 10, other: 1 } }, 'threshold_json.other'],
    ];
    for (const [over, detail] of cases) expect(refusal(() => checkRule(rule(over)))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail });
    expect(refusal(() => checkRule(rule({ metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { grace_days: -1 } })))).toMatchObject({ detail: 'threshold_json.grace_days' });
    expect(refusal(() => checkRule(rule({ metric_code: 'NATIONAL_CODE_MISSING', comparator: 'MISSING', threshold_json: { points: 1 } })))).toMatchObject({ detail: 'threshold_json.points' });
  });

  it('puts the rule in force from its first day to its last, both included', () => {
    const open = { effectiveFrom: '2027-01-01', effectiveUntil: null };
    expect([inForce(open, '2026-12-31'), inForce(open, '2027-01-01'), inForce(open, '2099-01-01')]).toEqual([false, true, true]);
    const closed = { effectiveFrom: '2027-01-01', effectiveUntil: '2027-06-30' };
    expect([inForce(closed, '2027-06-30'), inForce(closed, '2027-07-01')]).toEqual([true, false]);
  });

  it('EW-01: the expected curve is the share of the year gone, in percent with four decimals, a leap year included', () => {
    expect(expectedRatePct('2027-01-01')).toBe('0.2740');
    expect(expectedRatePct('2027-06-13')).toBe('44.9315');
    expect(expectedRatePct('2027-12-31')).toBe('100.0000');
    expect(expectedRatePct('2028-12-31')).toBe('100.0000');
    expect(expectedRatePct('2028-02-29')).toBe('16.3934');
  });

  it('AC-ST-DIS-012-1 / UAT-AC252: opens for a project 10 points under the curve (20% against 45%), says what was seen and what was expected, and is silent at 9.9999 points', () => {
    const published = checkRule(rule());
    const violation = evaluateRule(published, facts({ ratePct: '20.0000', expectedPct: '45.0000' }));
    expect(violation).toMatchObject({ severity: 'CRITICAL', observed: { metric: 'YTD_RATE_GAP', observed_pct: '20.0000', expected_pct: '45.0000', gap_points: '25.0000' } });
    expect(evaluateRule(published, facts({ ratePct: '35.0000', expectedPct: '45.0000' }))).toMatchObject({ severity: 'WARNING', observed: { gap_points: '10.0000' } });
    expect(evaluateRule(published, facts({ ratePct: '35.0001', expectedPct: '45.0000' }))).toBeNull();
    // The severity of the rule stands without a critical threshold, and a project with no rate is not a project with a low rate.
    expect(evaluateRule(checkRule(rule({ threshold_json: { points: 10 } })), facts({ ratePct: '1.0000' }))?.severity).toBe('WARNING');
    expect(evaluateRule(published, facts({ ratePct: null }))).toBeNull();
    // The second snapshot has the project at 22%: the same violation, with the new figure.
    expect(evaluateRule(published, facts({ ratePct: '22.0000', expectedPct: '45.0000' }))?.observed).toMatchObject({ observed_pct: '22.0000', gap_points: '23.0000' });
  });

  it('AC-ST-DIS-012-2 / UAT-AC253: opens CRITICAL when the deadline has passed without a report, asks for the explanation of the rule in 3 days, and is silent while the report is handed in or the deadline is ahead', () => {
    const published = checkRule(rule({ rule_code: 'EW-02', metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { explanation_due_days: 3 }, severity: 'CRITICAL', auto_explanation: true }));
    expect(evaluateRule(published, facts({ reportHandedIn: false, daysPastDeadline: 1 }))).toEqual({
      severity: 'CRITICAL',
      observed: { metric: 'REPORT_OVERDUE', days_past_deadline: 1 },
      autoExplanation: true,
      explanationDueDays: 3,
    });
    expect(evaluateRule(published, facts({ reportHandedIn: true, daysPastDeadline: 9 }))).toBeNull();
    expect(evaluateRule(published, facts({ reportHandedIn: false, daysPastDeadline: 0 }))).toBeNull();
    expect(evaluateRule(published, facts({ reportHandedIn: false, daysPastDeadline: -3 }))).toBeNull();
    const patient = checkRule(rule({ rule_code: 'EW-02', metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { grace_days: 2 }, severity: 'CRITICAL' }));
    expect(evaluateRule(patient, facts({ reportHandedIn: false, daysPastDeadline: 2 }))).toBeNull();
    expect(evaluateRule(patient, facts({ reportHandedIn: false, daysPastDeadline: 3 }))).toMatchObject({ autoExplanation: false, explanationDueDays: null });
  });

  it('EW-05 and EW-07: capital with no national code, and a fall in the period; a project with no capital, with a code, or with no period before it is silent', () => {
    const code = checkRule(rule({ rule_code: 'EW-05', metric_code: 'NATIONAL_CODE_MISSING', comparator: 'MISSING', threshold_json: {} }));
    expect(evaluateRule(code, facts({ hasNationalCode: false }))).toMatchObject({ observed: { metric: 'NATIONAL_CODE_MISSING' } });
    expect(evaluateRule(code, facts({ hasNationalCode: false, hasCapital: false }))).toBeNull();
    expect(evaluateRule(code, facts({ hasNationalCode: true }))).toBeNull();
    const fall = checkRule(rule({ rule_code: 'EW-07', metric_code: 'PERIOD_DELTA_NEGATIVE', comparator: 'LT', threshold_json: {} }));
    expect(evaluateRule(fall, facts({ periodDeltaVnd: '-20000000' }))).toMatchObject({ observed: { delta_vnd: '-20000000' } });
    expect(evaluateRule(fall, facts({ periodDeltaVnd: '0' }))).toBeNull();
    expect(evaluateRule(fall, facts({ periodDeltaVnd: '5' }))).toBeNull();
    expect(evaluateRule(fall, facts({ periodDeltaVnd: null }))).toBeNull();
  });

  it('keys a warning by the rule, the project and the year, and for the rules of a period by the period too, so that one is open at most', () => {
    const level = { ruleCode: 'EW-01', metricCode: 'YTD_RATE_GAP' } as const;
    expect(dedupeKeyOf(level, 'P-A-002', 2026, 'w40')).toBe('EW-01|P-A-002|2026');
    expect(dedupeKeyOf({ ruleCode: 'EW-02', metricCode: 'REPORT_OVERDUE' }, 'P-A-002', 2026, 'w40')).toBe('EW-02|P-A-002|2026|w40');
    expect(dedupeKeyOf({ ruleCode: 'EW-07', metricCode: 'PERIOD_DELTA_NEGATIVE' }, 'P-A-002', 2026, 'w41')).toBe('EW-07|P-A-002|2026|w41');
    expect(dedupeKeyOf({ ruleCode: 'EW-05', metricCode: 'NATIONAL_CODE_MISSING' }, 'P-A-002', 2026, 'w41')).toBe('EW-05|P-A-002|2026');
  });

  it('moves a warning by what a person does with it: acknowledge from OPEN, dismiss from OPEN or ACKNOWLEDGED; anything else is 409 WARNING_STATE_INVALID naming the status', () => {
    expect([nextWarningStatus('OPEN', 'acknowledge'), nextWarningStatus('OPEN', 'dismiss'), nextWarningStatus('ACKNOWLEDGED', 'dismiss')]).toEqual(['ACKNOWLEDGED', 'DISMISSED', 'DISMISSED']);
    for (const [status, action] of [
      ['ACKNOWLEDGED', 'acknowledge'],
      ['EXPLANATION_REQUESTED', 'acknowledge'],
      ['EXPLANATION_REQUESTED', 'dismiss'],
      ['RESOLVED', 'dismiss'],
      ['DISMISSED', 'acknowledge'],
    ] as const) {
      expect(refusal(() => nextWarningStatus(status, action))).toEqual({ code: 'WARNING_STATE_INVALID', status: 409, detail: 'status' });
    }
  });

  it('asks for a reason of at least five characters and at most 2000, trimmed', () => {
    expect(reasonOf('  Handed in on paper.  ')).toBe('Handed in on paper.');
    expect(refusal(() => reasonOf('no'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
    expect(refusal(() => reasonOf('x'.repeat(2001)))).toMatchObject({ detail: 'reason' });
    expect(refusal(() => reasonOf(undefined))).toMatchObject({ detail: 'reason' });
  });
});
