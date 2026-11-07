import {
  B1_BUILT_IN_VERSION,
  B1_DEFAULTS,
  B1_DEFAULT_CODE,
  B1_RULE_TYPES,
  BUILT_IN_B1_READER,
  EAC_METHODS,
  builtInB1,
  readB1Params,
  resolveB1Policy,
} from '../src/gov-b1-policy';
import type { B1PolicyReader, B1RawRule, B1RuleType } from '../src/gov-b1-policy';

describe('the starting values of the lane B1 policies are those of the research', () => {
  it('keeps the thresholds of the baseline, the EVM lines and the stages that are not paid', () => {
    expect(B1_DEFAULTS.BASELINE_DEVIATION).toEqual({ costPct: 10, slipDays: 90, rescheduleAlertCount: 3 });
    expect(B1_DEFAULTS.EVM_POLICY).toEqual({ eacMethod: 'CPI_CUMULATIVE', amberBelow: 0.95, redBelow: 0.85 });
    expect(B1_DEFAULTS.DISBURSEMENT_PRECONDITION).toEqual({ unlistedStatuses: ['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED', 'CLOSED'], requireApprovedPlan: true });
    expect([...B1_RULE_TYPES]).toEqual(['BASELINE_DEVIATION', 'EVM_POLICY', 'DISBURSEMENT_PRECONDITION']);
    expect([...EAC_METHODS]).toEqual(['CPI_CUMULATIVE', 'AC_PLUS_REMAINING', 'AC_PLUS_REMAINING_OVER_CPI_SPI']);
  });
  it('has a default for every rule type, and the built-in one is stamped with the version that says nobody approved it', () => {
    for (const type of B1_RULE_TYPES) {
      const answer = builtInB1(type);
      expect(answer).toEqual({ type, code: B1_DEFAULT_CODE, params: B1_DEFAULTS[type], version: B1_BUILT_IN_VERSION });
    }
    expect(B1_BUILT_IN_VERSION).toBe('built-in:1');
    expect(builtInB1('EVM_POLICY', 'PROJECT_X').code).toBe('PROJECT_X');
  });
});

describe('the params of a rule are read defensively: one wrong field never turns a guard off', () => {
  it('answers with the default for a rule with no params at all', () => {
    for (const type of B1_RULE_TYPES) expect(readB1Params(type, undefined)).toEqual(B1_DEFAULTS[type]);
    expect(readB1Params('BASELINE_DEVIATION', {})).toEqual(B1_DEFAULTS.BASELINE_DEVIATION);
  });

  describe('BASELINE_DEVIATION', () => {
    it('takes the fields of the rule in their snake_case names', () => {
      expect(readB1Params('BASELINE_DEVIATION', { cost_pct: 15.5, slip_days: 30, reschedule_alert_count: 5 })).toEqual({ costPct: 15.5, slipDays: 30, rescheduleAlertCount: 5 });
    });
    it('takes the edges of each range and falls back, field by field, outside it', () => {
      expect(readB1Params('BASELINE_DEVIATION', { cost_pct: 0, slip_days: 0, reschedule_alert_count: 1 })).toEqual({ costPct: 0, slipDays: 0, rescheduleAlertCount: 1 });
      expect(readB1Params('BASELINE_DEVIATION', { cost_pct: 1000, slip_days: 3650, reschedule_alert_count: 50 })).toEqual({ costPct: 1000, slipDays: 3650, rescheduleAlertCount: 50 });
      expect(readB1Params('BASELINE_DEVIATION', { cost_pct: -1, slip_days: 30, reschedule_alert_count: 5 })).toEqual({ costPct: 10, slipDays: 30, rescheduleAlertCount: 5 });
      expect(readB1Params('BASELINE_DEVIATION', { cost_pct: 1000.5, slip_days: 3651, reschedule_alert_count: 0 })).toEqual({ costPct: 10, slipDays: 90, rescheduleAlertCount: 3 });
      expect(readB1Params('BASELINE_DEVIATION', { slip_days: 1.5, reschedule_alert_count: 51 })).toEqual({ costPct: 10, slipDays: 90, rescheduleAlertCount: 3 });
    });
    it('does not take a number written as text, nor NaN or infinity, for a number', () => {
      expect(readB1Params('BASELINE_DEVIATION', { cost_pct: '25', slip_days: '40', reschedule_alert_count: '2' })).toEqual(B1_DEFAULTS.BASELINE_DEVIATION);
      expect(readB1Params('BASELINE_DEVIATION', { cost_pct: Number.NaN, slip_days: Number.POSITIVE_INFINITY })).toEqual(B1_DEFAULTS.BASELINE_DEVIATION);
    });
  });

  describe('EVM_POLICY', () => {
    it('takes a known formula and the two lines', () => {
      expect(readB1Params('EVM_POLICY', { eac_method: 'AC_PLUS_REMAINING', amber_below: 0.9, red_below: 0.8 })).toEqual({ eacMethod: 'AC_PLUS_REMAINING', amberBelow: 0.9, redBelow: 0.8 });
    });
    it('falls back to the cumulative CPI for a formula that does not exist', () => {
      expect(readB1Params('EVM_POLICY', { eac_method: 'MAGIC' }).eacMethod).toBe('CPI_CUMULATIVE');
      expect(readB1Params('EVM_POLICY', { eac_method: 7 }).eacMethod).toBe('CPI_CUMULATIVE');
    });
    it('never lets the red line sit above the amber one, so a colour cannot be both', () => {
      expect(readB1Params('EVM_POLICY', { amber_below: 0.9, red_below: 0.95 })).toMatchObject({ amberBelow: 0.9, redBelow: 0.9 });
      expect(readB1Params('EVM_POLICY', { red_below: 1.5 })).toMatchObject({ amberBelow: 0.95, redBelow: 0.95 });
    });
    it('falls back for a line out of its range', () => {
      expect(readB1Params('EVM_POLICY', { amber_below: 3, red_below: -1 })).toMatchObject({ amberBelow: 0.95, redBelow: 0.85 });
    });
  });

  describe('DISBURSEMENT_PRECONDITION', () => {
    it('takes the list of stages and the flag', () => {
      expect(readB1Params('DISBURSEMENT_PRECONDITION', { unlisted_statuses: ['CONCEPT'], require_approved_plan: false })).toEqual({ unlistedStatuses: ['CONCEPT'], requireApprovedPlan: false });
    });
    it('keeps an empty list as the rule says (nothing is unlisted), but not a list with something that is not a text', () => {
      expect(readB1Params('DISBURSEMENT_PRECONDITION', { unlisted_statuses: [] }).unlistedStatuses).toEqual([]);
      expect(readB1Params('DISBURSEMENT_PRECONDITION', { unlisted_statuses: ['CONCEPT', 4] }).unlistedStatuses).toEqual(B1_DEFAULTS.DISBURSEMENT_PRECONDITION.unlistedStatuses);
      expect(readB1Params('DISBURSEMENT_PRECONDITION', { unlisted_statuses: 'CONCEPT' }).unlistedStatuses).toEqual(B1_DEFAULTS.DISBURSEMENT_PRECONDITION.unlistedStatuses);
    });
    it('does not read the word "false" as the flag being off: the guard stays on', () => {
      expect(readB1Params('DISBURSEMENT_PRECONDITION', { require_approved_plan: 'false' }).requireApprovedPlan).toBe(true);
      expect(readB1Params('DISBURSEMENT_PRECONDITION', { require_approved_plan: 0 }).requireApprovedPlan).toBe(true);
    });
  });

  it('refuses a rule type it does not know instead of answering with something', () => {
    expect(() => readB1Params('NOPE' as B1RuleType, {})).toThrow('unknown B1 rule type');
  });
});

describe('the policy in force on a day', () => {
  it('the reader that is used until the governance port is wired has no rule for anything', async () => {
    await expect(BUILT_IN_B1_READER.get({}, 'EVM_POLICY', 'DEFAULT', '2026-01-01')).resolves.toBeUndefined();
  });

  it('is the built-in default with the built-in version when the reader has no rule', async () => {
    const answer = await resolveB1Policy(BUILT_IN_B1_READER, {}, 'BASELINE_DEVIATION', '2026-01-01');
    expect(answer).toEqual({ type: 'BASELINE_DEVIATION', code: 'DEFAULT', params: B1_DEFAULTS.BASELINE_DEVIATION, version: 'built-in:1' });
  });

  it('is the approved rule with its own version, read defensively, when the reader has one, and asks with the type, the code and the day', async () => {
    const asked: unknown[][] = [];
    const reader: B1PolicyReader<{ id: string }> = {
      get: (tx, type, code, asOf): Promise<B1RawRule | undefined> => {
        asked.push([tx.id, type, code, asOf]);
        return Promise.resolve({ params: { eac_method: 'AC_PLUS_REMAINING_OVER_CPI_SPI', amber_below: 0.9, red_below: 'junk' }, version: 'rule:7' });
      },
    };
    const answer = await resolveB1Policy(reader, { id: 'tx1' }, 'EVM_POLICY', '2026-03-04', 'PROJECT_GROUP_A');
    expect(asked).toEqual([['tx1', 'EVM_POLICY', 'PROJECT_GROUP_A', '2026-03-04']]);
    expect(answer).toEqual({ type: 'EVM_POLICY', code: 'PROJECT_GROUP_A', params: { eacMethod: 'AC_PLUS_REMAINING_OVER_CPI_SPI', amberBelow: 0.9, redBelow: 0.85 }, version: 'rule:7' });
  });

  it('keeps the version of the rule even when its params are empty: the decision says which rule it used', async () => {
    const reader: B1PolicyReader<null> = { get: () => Promise.resolve({ params: undefined, version: 'rule:9' }) };
    const answer = await resolveB1Policy(reader, null, 'DISBURSEMENT_PRECONDITION', '2026-03-04');
    expect(answer.version).toBe('rule:9');
    expect(answer.params).toEqual(B1_DEFAULTS.DISBURSEMENT_PRECONDITION);
  });
});
