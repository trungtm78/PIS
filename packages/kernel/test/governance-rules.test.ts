import { DomainError } from '../src/errors';
import {
  RULE_TYPE_PATTERN,
  alertTypeDefaults,
  assertRulePeriod,
  builtInCodes,
  builtInDefault,
  defaultGovernanceRule,
  describeRuleType,
  diffRuleParams,
  isGovernanceRuleType,
  isRuleCode,
  isRuleTypeName,
  nextRuleStatus,
  provenanceOf,
  registerAllGovernanceRules,
  registerAnalyticsRules,
  registerBaselineRules,
  registerContractRules,
  registerCoreRules,
  registerDirectiveRules,
  registerEnterpriseRules,
  registerIntegrationRules,
  registerIntegrityRules,
  registerMoneyRules,
  registerRuleDefaults,
  registerRuleType,
  registerWorkClockRules,
  registeredRuleTypes,
  resolveGovernanceRule,
  ruleTypeDefinitions,
  validateRuleParams,
} from '../src/governance-rules';
import type { GovernanceRuleVersion, RuleTypeInput } from '../src/governance-rules';
import { reminderPolicyDefaults } from '../src/work-clock';

const REMINDER = { every_working_hours: { URGENT: 2, ACTION: 6, WATCH: 30 }, max_per_item: { URGENT: 10, ACTION: 5, WATCH: 3 } };
const version = (overrides: Partial<GovernanceRuleVersion> = {}): GovernanceRuleVersion => ({
  id: '00000000-0000-4000-8000-000000000001',
  type: 'REMINDER_POLICY',
  code: 'DEFAULT',
  version: 1,
  status: 'APPROVED',
  params: REMINDER,
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  unitId: null,
  ...overrides,
});

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return `${error.code}:${error.detail ?? ''}`;
    return error instanceof Error ? `other:${error.message}` : 'other';
  }
  return undefined;
};

const MINIMAL: RuleTypeInput = {
  type: 'TEST_ONLY_RULE',
  ownerModule: 'ADM',
  modules: ['ADM'],
  formula: 'Giá trị kiểm thử phải là một số nguyên không âm',
  source: 'Bài kiểm thử đơn vị của sổ đăng ký',
  asOf: '2026-11-08',
  legalStatus: 'VERIFIED',
  schema: { limit: { kind: 'int', min: 0, max: 10 } },
  defaults: { DEFAULT: { params: { limit: 3 } } },
};

describe('the open registry of rule types', () => {
  it('knows the types of every domain, each registered by its own function', () => {
    const types = registeredRuleTypes();
    expect(types).toEqual(
      expect.arrayContaining([
        // core (A1)
        'ALERT_TYPE',
        'RAG_THRESHOLDS',
        'GATE_CRITERIA',
        'KPI_DEFINITION',
        'NOTIFICATION_POLICY',
        'ADVANCE_POLICY',
        'RED_FLAG_RULE',
        'WORKING_CALENDAR',
        // work clocks (A2)
        'SNOOZE_POLICY',
        'CLOCK_POLICY',
        'REMINDER_POLICY',
        // baseline, EVM, disbursement precondition (B1)
        'BASELINE_DEVIATION',
        'EVM_POLICY',
        'DISBURSEMENT_PRECONDITION',
        // money (B2)
        'CHANGE_ORDER_TIER',
        'RESERVE_POLICY',
        'CONTRACT_AVC',
        'ADVANCE_RECOVERY',
        // integrity (D)
        'SOD_MATRIX',
        'PAYMENT_INTEGRITY',
        'RECONCILIATION_POLICY',
        // contract analytics, integration, enterprise
        'CONTRACT_HEALTH_RAG',
        'CONTRACT_CONCENTRATION',
        'CONNECTOR_FRESHNESS',
        'EGP_POSTING_DEADLINES',
        'FUNDING_TAXONOMY',
        'DATA_ENTRY_RULE',
        // directives (DIR-1)
        'DIRECTIVE_POLICY',
      ]),
    );
    expect(types.every((type) => RULE_TYPE_PATTERN.test(type))).toBe(true);
  });

  it('runs every register function again without registering anything twice', () => {
    const before = registeredRuleTypes().length;
    const codes = builtInCodes('ALERT_TYPE').length;
    for (const register of [registerCoreRules, registerWorkClockRules, registerBaselineRules, registerMoneyRules, registerAnalyticsRules, registerIntegrityRules, registerContractRules, registerIntegrationRules, registerDirectiveRules, registerEnterpriseRules, registerAllGovernanceRules]) register();
    expect(registeredRuleTypes()).toHaveLength(before);
    expect(builtInCodes('ALERT_TYPE')).toHaveLength(codes);
  });

  it('names a type with the same pattern as the table: upper case, 3 to 64 characters', () => {
    expect(isRuleTypeName('ABC')).toBe(true);
    expect(isRuleTypeName('AB')).toBe(false);
    expect(isRuleTypeName('abc')).toBe(false);
    expect(isRuleTypeName('1ABC')).toBe(false);
    expect(isRuleTypeName(`A${'B'.repeat(63)}`)).toBe(true);
    expect(isRuleTypeName(`A${'B'.repeat(64)}`)).toBe(false);
  });

  it('lets a lane register a type and add codes under it, and refuses a second registration, a code that exists and a default that breaks its own schema', () => {
    expect(isGovernanceRuleType('TEST_ONLY_RULE')).toBe(false);
    registerRuleType(MINIMAL);
    expect(isGovernanceRuleType('TEST_ONLY_RULE')).toBe(true);
    expect(validateRuleParams('TEST_ONLY_RULE', { limit: 4 })).toEqual({ limit: 4 });
    expect(builtInDefault('TEST_ONLY_RULE', 'DEFAULT')).toMatchObject({ legalStatus: 'VERIFIED', unverified: false, asOf: '2026-11-08', source: MINIMAL.source });
    registerRuleDefaults('TEST_ONLY_RULE', { SECOND: { params: { limit: 5 }, legalStatus: 'UNVERIFIED' } });
    expect(builtInDefault('TEST_ONLY_RULE', 'SECOND')).toMatchObject({ legalStatus: 'UNVERIFIED', unverified: true, formula: MINIMAL.formula });
    expect(codeOf(() => registerRuleType(MINIMAL))).toMatch(/already registered/);
    expect(codeOf(() => registerRuleDefaults('TEST_ONLY_RULE', { SECOND: { params: { limit: 5 } } }))).toMatch(/already has a default/);
    expect(codeOf(() => registerRuleDefaults('TEST_ONLY_RULE', { THIRD: { params: { limit: 50 } } }))).toMatch(/does not pass its own schema \(limit\)/);
    expect(codeOf(() => registerRuleDefaults('NOT_REGISTERED_AT_ALL', { X1: { params: {} } }))).toMatch(/not registered/);
    expect(codeOf(() => registerRuleType({ ...MINIMAL, type: 'bad name' }))).toMatch(/not a rule type name/);
    expect(codeOf(() => registerRuleType({ ...MINIMAL, type: 'TEST_NO_SOURCE', source: '' }))).toMatch(/source/);
    expect(codeOf(() => registerRuleType({ ...MINIMAL, type: 'TEST_NO_FORMULA', formula: 'ngắn' }))).toMatch(/formula/);
    expect(codeOf(() => registerRuleType({ ...MINIMAL, type: 'TEST_BAD_DAY', asOf: '2026-02-30' }))).toMatch(/as-of/);
    expect(codeOf(() => registerRuleType({ ...MINIMAL, type: 'TEST_NO_OWNER', ownerModule: 'x' }))).toMatch(/module/);
    expect(codeOf(() => registerRuleType({ ...MINIMAL, type: 'TEST_BAD_DEFAULT', defaults: { DEFAULT: { params: { limit: 99 } } } }))).toMatch(/does not pass its own schema/);
  });

  it('describes a type as plain data for a screen: schema, provenance and the codes with theirs', () => {
    const described = describeRuleType('PAYMENT_INTEGRITY');
    expect(described).toMatchObject({ type: 'PAYMENT_INTEGRITY', ownerModule: 'PAY', legalStatus: 'UNVERIFIED' });
    expect(described.codes).toEqual([expect.objectContaining({ code: 'DEFAULT', unverified: true })]);
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });
});

describe('the built-in defaults', () => {
  it('passes its own schema and carries formula, source, as-of and legal status, for every code of every type', () => {
    expect(registeredRuleTypes().length).toBeGreaterThanOrEqual(27);
    for (const definition of ruleTypeDefinitions()) {
      if (definition.type === 'TEST_ONLY_RULE') continue;
      expect(['VERIFIED', 'UNVERIFIED']).toContain(definition.legalStatus);
      expect(definition.ownerModule.length).toBeGreaterThan(1);
      const codes = builtInCodes(definition.type);
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(isRuleCode(code)).toBe(true);
        const found = builtInDefault(definition.type, code);
        expect(found).toBeDefined();
        expect(validateRuleParams(definition.type, found?.params)).toEqual(found?.params);
        expect(found?.formula.length).toBeGreaterThan(7);
        expect(found?.source.length).toBeGreaterThan(2);
        expect(found?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(found?.unverified).toBe(found?.legalStatus === 'UNVERIFIED');
        expect(provenanceOf(definition.type, code)).toMatchObject({ legalStatus: found?.legalStatus, asOf: found?.asOf });
      }
    }
  });

  it('registers an alert type for every source of the alert centre, each with owner, action, consequence, response time and review day', () => {
    const codes = builtInCodes('ALERT_TYPE');
    expect(codes).toEqual(
      expect.arrayContaining([
        'APPROVAL',
        'EXPLANATION',
        'REPORT',
        'EARLY_WARNING',
        'ADVANCE',
        'PERMIT_EXPIRED',
        'AUDIT_RECOMMENDATION_OVERDUE',
        'ISSUE_SLA_BREACH',
        'SITE_DIARY',
        'GUARANTEE',
        'EAC_EXCEEDS_TMDT',
        'RESERVE_BELOW_RISK_EV',
        'ADVANCE_EXCEEDS_REMAINING',
        'PAYMENT_INTEGRITY_BLOCKED',
        'CROSS_TOTAL_MISMATCH',
        'EGP_POSTING_DUE',
        'EGP_POSTING_OVERDUE',
        'CONNECTOR_STALE',
        'DIRECTIVE_DUE',
        'DIRECTIVE_OVERDUE',
        'DIRECTIVE_ESCALATED',
      ]),
    );
    for (const code of codes) {
      const params = builtInDefault('ALERT_TYPE', code)?.params as Record<string, unknown>;
      expect(String(params.owner).length).toBeGreaterThan(0);
      expect(String(params.expected_action).length).toBeGreaterThan(0);
      expect(String(params.consequence).length).toBeGreaterThan(0);
      expect(Number(params.response_hours)).toBeGreaterThan(0);
      expect(params.review_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keeps the numbers of the research as flagged starting values', () => {
    expect(builtInDefault('RAG_THRESHOLDS', 'DISBURSEMENT_RATIO')?.params).toMatchObject({ green: 0.95, amber: 0.85 });
    expect(builtInDefault('RAG_THRESHOLDS', 'CPI')?.unverified).toBe(true);
    expect(builtInDefault('SNOOZE_POLICY', 'DEFAULT')?.params).toMatchObject({ max_consecutive: 2, max_days_by_severity: { URGENT: 0, ACTION: 3, WATCH: 14 } });
    expect(builtInDefault('CLOCK_POLICY', 'DEFAULT')?.params).toMatchObject({ claim_within_working_hours: { URGENT: 2, ACTION: 8, WATCH: 24 } });
    expect(builtInDefault('REMINDER_POLICY', 'DEFAULT')?.params).toEqual(reminderPolicyDefaults());
    expect(builtInDefault('ADVANCE_POLICY', 'DEFAULT')?.unverified).toBe(true);
    expect(builtInDefault('WORKING_CALENDAR', 'DEFAULT')?.unverified).toBe(false);
    expect(builtInDefault('EVM_POLICY', 'DEFAULT')?.params).toMatchObject({ eac_method: 'CPI_CUMULATIVE', amber_below: 0.95, red_below: 0.85 });
    expect(builtInDefault('BASELINE_DEVIATION', 'DEFAULT')?.params).toMatchObject({ cost_pct: 10, slip_days: 90, reschedule_alert_count: 3 });
    expect(builtInDefault('DISBURSEMENT_PRECONDITION', 'DEFAULT')?.legalStatus).toBe('UNVERIFIED');
    expect(builtInDefault('CHANGE_ORDER_TIER', 'DEFAULT')?.params).toMatchObject({ projectAdjustmentPct: '10', requireReserveCover: true });
    expect(builtInDefault('ADVANCE_RECOVERY', 'DEFAULT')?.params).toEqual({ finalPaymentRequiresFullRecovery: true, toleranceVnd: '0' });
  });

  it('adds the codes of the analytics lane under KPI_DEFINITION and RAG_THRESHOLDS without touching the core ones', () => {
    expect(builtInCodes('KPI_DEFINITION')).toEqual(expect.arrayContaining(['DISBURSEMENT_RATE', 'PHYSICAL_PROGRESS', 'DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL']));
    expect(builtInCodes('RAG_THRESHOLDS')).toEqual(expect.arrayContaining(['DISBURSEMENT_RATIO', 'CPI', 'SPI', 'EWS_SCORE', 'EWS_RATE_VS_PACE']));
    expect(builtInDefault('KPI_DEFINITION', 'DISBURSEMENT_RATE_PM')?.formula).toMatch(/Kho bạc/);
  });

  it('widens the matrix of duties with the scope of a procurement package and the pairs of lane D', () => {
    const params = builtInDefault('SOD_MATRIX', 'DEFAULT')?.params as { conflicts: Array<{ action_a: string; action_b: string; scope: string }> };
    expect(params.conflicts.length).toBeGreaterThanOrEqual(8);
    expect(params.conflicts.some((pair) => pair.scope === 'SAME_PACKAGE')).toBe(true);
    expect(codeOf(() => validateRuleParams('SOD_MATRIX', { exception_approvers: 2, conflicts: [{ action_a: 'a.b', action_b: 'c.d', scope: 'SAME_GALAXY', severity: 'BLOCK', exception_max_days: 0 }] }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:conflicts[0].scope');
  });

  it('answers undefined for a code without a default and refuses an unknown type', () => {
    expect(builtInDefault('KPI_DEFINITION', 'NOT_A_KPI')).toBeUndefined();
    expect(defaultGovernanceRule('KPI_DEFINITION', 'NOT_A_KPI')).toBeUndefined();
    expect(codeOf(() => builtInDefault('NOPE', 'X'))).toBe('VALIDATION_FAILED:rule_type');
    expect(defaultGovernanceRule('NOT_REGISTERED_AT_ALL', 'X')).toBeUndefined();
  });

  it('builds the defaults of the alert types of a lane from its seeds', () => {
    const made = alertTypeDefaults([{ code: 'LANE_ALERT', source: 'LANE', owner: 'OWNER', action: 'Làm việc cần làm.', consequence: 'Việc không làm thì dừng.', hours: 24, severity: 'ACTION', why: 'Có lý do để tồn tại.' }]);
    expect(made.LANE_ALERT?.params).toMatchObject({ source: 'LANE', response_hours: 24, enabled: true });
    expect(validateRuleParams('ALERT_TYPE', made.LANE_ALERT?.params)).toEqual(made.LANE_ALERT?.params);
  });
});

describe('validateRuleParams', () => {
  it('refuses a missing field, an unknown field, a wrong type and a value out of range, naming the field and never the value', () => {
    const base = { ...REMINDER };
    expect(codeOf(() => validateRuleParams('REMINDER_POLICY', { every_working_hours: REMINDER.every_working_hours }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:max_per_item');
    expect(codeOf(() => validateRuleParams('REMINDER_POLICY', { ...base, extra: 1 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:extra');
    expect(codeOf(() => validateRuleParams('REMINDER_POLICY', { ...base, every_working_hours: { URGENT: '2', ACTION: 6, WATCH: 30 } }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:every_working_hours.URGENT');
    expect(codeOf(() => validateRuleParams('REMINDER_POLICY', { ...base, every_working_hours: { URGENT: 721, ACTION: 6, WATCH: 30 } }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:every_working_hours.URGENT');
    expect(codeOf(() => validateRuleParams('REMINDER_POLICY', { ...base, every_working_hours: { URGENT: 1.5, ACTION: 6, WATCH: 30 } }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:every_working_hours.URGENT');
    expect(codeOf(() => validateRuleParams('REMINDER_POLICY', []))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:params');
    expect(codeOf(() => validateRuleParams('NOPE', {}))).toBe('VALIDATION_FAILED:rule_type');
  });

  it('judges the params of a lane with the parser of the lane, so the registry never accepts what the lane would refuse', () => {
    const snooze = { ...(builtInDefault('SNOOZE_POLICY', 'DEFAULT')?.params as Record<string, unknown>) };
    expect(codeOf(() => validateRuleParams('SNOOZE_POLICY', { ...snooze, max_days_by_severity: { URGENT: 1, ACTION: 3, WATCH: 14 } }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:max_days_by_severity.URGENT');
    const tier = builtInDefault('CHANGE_ORDER_TIER', 'DEFAULT')?.params as { bands: Array<Record<string, string>> } & Record<string, unknown>;
    const bands = tier.bands;
    expect(codeOf(() => validateRuleParams('CHANGE_ORDER_TIER', { ...tier, bands: [bands[1], bands[0]] }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:bands');
    expect(codeOf(() => validateRuleParams('CHANGE_ORDER_TIER', { ...tier, projectAdjustmentPct: '5' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:projectAdjustmentPct');
    expect(codeOf(() => validateRuleParams('CHANGE_ORDER_TIER', { ...tier, projectAdjustmentPct: 10 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:projectAdjustmentPct');
    expect(codeOf(() => validateRuleParams('EVM_POLICY', { eac_method: 'CPI_CUMULATIVE', amber_below: 0.8, red_below: 0.9 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:red_below');
  });

  it('lets a type with no expected action be watched only', () => {
    const base = { ...(builtInDefault('ALERT_TYPE', 'APPROVAL')?.params as Record<string, unknown>), expected_action: '' };
    expect(codeOf(() => validateRuleParams('ALERT_TYPE', { ...base, default_severity: 'ACTION' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:default_severity');
    expect(codeOf(() => validateRuleParams('ALERT_TYPE', { ...base, default_severity: 'URGENT' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:default_severity');
    expect(codeOf(() => validateRuleParams('ALERT_TYPE', { ...base, default_severity: 'WATCH' }))).toBeUndefined();
    expect(codeOf(() => validateRuleParams('ALERT_TYPE', { ...base, expected_action: 'Làm gì đó', default_severity: 'URGENT' }))).toBeUndefined();
  });

  it('checks the lines across fields: RAG direction, advance recovery curve, contract health weights, concentration lines, dates and times', () => {
    expect(codeOf(() => validateRuleParams('RAG_THRESHOLDS', { direction: 'HIGHER_IS_BETTER', green: 0.8, amber: 0.9, min_coverage_pct: 50 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:green');
    expect(codeOf(() => validateRuleParams('RAG_THRESHOLDS', { direction: 'LOWER_IS_BETTER', green: 0.8, amber: 0.9, min_coverage_pct: 50 }))).toBeUndefined();
    expect(codeOf(() => validateRuleParams('ADVANCE_POLICY', { max_pct_of_contract: 20, recovery_starts_at_pct: 90, fully_recovered_at_pct: 80, overdue_after_days: 30 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:recovery_starts_at_pct');
    // The colour of a contract is the worst of its indicators (CA-2): the lines run from amber to red the way each indicator is bad, and an unknown key is a typo that must not become a threshold nobody reads.
    const health = builtInDefault('CONTRACT_HEALTH_RAG', 'DEFAULT')?.params as Record<string, unknown>;
    expect(codeOf(() => validateRuleParams('CONTRACT_HEALTH_RAG', health))).toBeUndefined();
    expect(codeOf(() => validateRuleParams('CONTRACT_HEALTH_RAG', { ...health, days_late_red: 0 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:days_late_red');
    expect(codeOf(() => validateRuleParams('CONTRACT_HEALTH_RAG', { ...health, change_growth_red_pct: 1 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:change_growth_red_pct');
    expect(codeOf(() => validateRuleParams('CONTRACT_HEALTH_RAG', { ...health, guarantee_coverage_red_pct: 101 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:guarantee_coverage_red_pct');
    expect(codeOf(() => validateRuleParams('CONTRACT_HEALTH_RAG', { ...health, score_green_at_most: 25 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:score_green_at_most');
    const threeWay = builtInDefault('CONTRACT_THREE_WAY_MATCH', 'DEFAULT')?.params as Record<string, unknown>;
    expect(codeOf(() => validateRuleParams('CONTRACT_THREE_WAY_MATCH', threeWay))).toBeUndefined();
    expect(codeOf(() => validateRuleParams('CONTRACT_THREE_WAY_MATCH', { ...threeWay, tolerance_pct: 101 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:tolerance_pct');
    expect(codeOf(() => validateRuleParams('CONTRACT_THREE_WAY_MATCH', { ...threeWay, tolerance_pct: 1.234 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:tolerance_pct');
    const concentration = builtInDefault('CONTRACT_CONCENTRATION', 'DEFAULT')?.params as Record<string, unknown>;
    expect(codeOf(() => validateRuleParams('CONTRACT_CONCENTRATION', { ...concentration, hhi_amber: 2000 }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:hhi_amber');
    expect(codeOf(() => validateRuleParams('CONNECTOR_FRESHNESS', { max_age_hours: 24, warn_after_hours: 48, stale_severity: 'ACTION', figures_blocked_when_stale: true }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:warn_after_hours');
    const calendar = { weekend_days: [0, 6], holidays: ['2026-09-02'], special_workdays: [], day_starts: '08:00', day_ends: '17:00' };
    expect(codeOf(() => validateRuleParams('WORKING_CALENDAR', calendar))).toBeUndefined();
    expect(codeOf(() => validateRuleParams('WORKING_CALENDAR', { ...calendar, holidays: ['2026-02-30'] }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:holidays[0]');
    expect(codeOf(() => validateRuleParams('WORKING_CALENDAR', { ...calendar, day_starts: '25:00' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:day_starts');
    expect(codeOf(() => validateRuleParams('WORKING_CALENDAR', { ...calendar, weekend_days: [7] }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:weekend_days[0]');
  });

  it('refuses text with padding and an empty required text', () => {
    const base = builtInDefault('KPI_DEFINITION', 'DISBURSEMENT_RATE')?.params as Record<string, unknown>;
    expect(codeOf(() => validateRuleParams('KPI_DEFINITION', { ...base, name: ' Tỷ lệ' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:name');
    expect(codeOf(() => validateRuleParams('KPI_DEFINITION', { ...base, name: '' }))).toBe('GOVERNANCE_RULE_PARAMS_INVALID:name');
  });
});

describe('resolveGovernanceRule', () => {
  it('falls back to the built-in default (version 0, source DEFAULT, with its provenance) when no rule is approved', () => {
    const resolved = resolveGovernanceRule([], 'REMINDER_POLICY', 'DEFAULT', '2026-11-08');
    expect(resolved).toMatchObject({ source: 'DEFAULT', version: 0, ruleId: null, unitId: null, unverified: true, params: { max_per_item: { URGENT: 40 } }, provenance: { legalStatus: 'UNVERIFIED' } });
    expect(resolveGovernanceRule([], 'REMINDER_POLICY', 'NOPE', '2026-11-08')).toBeUndefined();
  });

  it('reads only approved or retired versions that cover the day, half open', () => {
    const rules = [version({ status: 'DRAFT', version: 9 }), version({ status: 'SUBMITTED', version: 8 }), version({ version: 2, effectiveFrom: '2026-11-05', effectiveTo: '2026-11-10', id: 'b' })];
    expect(resolveGovernanceRule(rules, 'REMINDER_POLICY', 'DEFAULT', '2026-11-04')?.source).toBe('DEFAULT');
    expect(resolveGovernanceRule(rules, 'REMINDER_POLICY', 'DEFAULT', '2026-11-05')).toMatchObject({ source: 'RULE', version: 2, ruleId: 'b', unverified: false });
    expect(resolveGovernanceRule(rules, 'REMINDER_POLICY', 'DEFAULT', '2026-11-09')).toMatchObject({ source: 'RULE', version: 2 });
    expect(resolveGovernanceRule(rules, 'REMINDER_POLICY', 'DEFAULT', '2026-11-10')?.source).toBe('DEFAULT');
  });

  it('keeps a retired version for the days it was in force, and takes the newest of two that cover a day', () => {
    const rules = [version({ version: 1, status: 'RETIRED', effectiveTo: '2026-12-01', id: 'old' }), version({ version: 2, effectiveFrom: '2026-12-01', id: 'new' })];
    expect(resolveGovernanceRule(rules, 'REMINDER_POLICY', 'DEFAULT', '2026-11-30')?.ruleId).toBe('old');
    expect(resolveGovernanceRule(rules, 'REMINDER_POLICY', 'DEFAULT', '2026-12-01')?.ruleId).toBe('new');
    const overlapping = [version({ version: 1, id: 'one' }), version({ version: 3, id: 'three' }), version({ version: 2, id: 'two' })];
    expect(resolveGovernanceRule(overlapping, 'REMINDER_POLICY', 'DEFAULT', '2026-11-08')?.ruleId).toBe('three');
  });

  it('prefers the override of the nearest unit, then the rule of the whole tenant, and ignores a unit that is not above the thing', () => {
    const rules = [version({ id: 'tenant' }), version({ id: 'province', unitId: 'U-PROVINCE' }), version({ id: 'dept', unitId: 'U-DEPT' }), version({ id: 'other', unitId: 'U-OTHER' })];
    const at = (chain: string[]): string | null | undefined => resolveGovernanceRule(rules, 'REMINDER_POLICY', 'DEFAULT', '2026-11-08', { unitChain: chain })?.ruleId;
    expect(at(['U-DEPT', 'U-PROVINCE'])).toBe('dept');
    expect(at(['U-X', 'U-PROVINCE'])).toBe('province');
    expect(at(['U-X'])).toBe('tenant');
    expect(at([])).toBe('tenant');
  });

  it('gives a rule of a type nobody registered no default, but still resolves an approved version of it', () => {
    const stray = version({ type: 'STRAY_TYPE', code: 'ANY_CODE', id: 'stray' });
    expect(resolveGovernanceRule([stray], 'STRAY_TYPE', 'ANY_CODE', '2026-11-08')).toMatchObject({ ruleId: 'stray', provenance: null });
    expect(resolveGovernanceRule([], 'STRAY_TYPE', 'ANY_CODE', '2026-11-08')).toBeUndefined();
  });

  it('refuses a day that is not a day', () => {
    expect(codeOf(() => resolveGovernanceRule([], 'REMINDER_POLICY', 'DEFAULT', '2026-02-30'))).toBe('VALIDATION_FAILED:as_of');
  });
});

describe('the life of a version', () => {
  const who = { actor: 'checker', maker: 'maker', submitter: 'submitter' };
  it('moves draft to submitted to approved to retired, and a submitted draft can be withdrawn', () => {
    expect(nextRuleStatus('DRAFT', 'SUBMIT', who)).toBe('SUBMITTED');
    expect(nextRuleStatus('SUBMITTED', 'APPROVE', who)).toBe('APPROVED');
    expect(nextRuleStatus('APPROVED', 'RETIRE', who)).toBe('RETIRED');
    expect(nextRuleStatus('SUBMITTED', 'WITHDRAW', who)).toBe('DRAFT');
  });

  it('retires a version that was never approved', () => {
    expect(nextRuleStatus('DRAFT', 'RETIRE', who)).toBe('RETIRED');
    expect(nextRuleStatus('SUBMITTED', 'RETIRE', who)).toBe('RETIRED');
  });

  it('refuses a move that does not start from where the version is', () => {
    expect(codeOf(() => nextRuleStatus('DRAFT', 'APPROVE', who))).toBe('GOVERNANCE_RULE_STATE_INVALID:status');
    expect(codeOf(() => nextRuleStatus('APPROVED', 'SUBMIT', who))).toBe('GOVERNANCE_RULE_STATE_INVALID:status');
    expect(codeOf(() => nextRuleStatus('RETIRED', 'RETIRE', who))).toBe('GOVERNANCE_RULE_STATE_INVALID:status');
  });

  it('does not let the maker or the submitter approve', () => {
    expect(codeOf(() => nextRuleStatus('SUBMITTED', 'APPROVE', { ...who, actor: 'maker' }))).toBe('SELF_APPROVAL_DENIED:');
    expect(codeOf(() => nextRuleStatus('SUBMITTED', 'APPROVE', { ...who, actor: 'submitter' }))).toBe('SELF_APPROVAL_DENIED:');
    expect(nextRuleStatus('SUBMITTED', 'APPROVE', { ...who, submitter: null })).toBe('APPROVED');
  });

  it('checks the period', () => {
    expect(codeOf(() => assertRulePeriod('2026-11-01', null))).toBeUndefined();
    expect(codeOf(() => assertRulePeriod('2026-11-01', '2026-11-01'))).toBe('VALIDATION_FAILED:effective_to');
    expect(codeOf(() => assertRulePeriod('2026-13-01', null))).toBe('VALIDATION_FAILED:effective_from');
  });
});

describe('diffRuleParams', () => {
  it('lists the paths that changed, added and removed', () => {
    expect(diffRuleParams({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { a: 1, b: { c: 5 }, e: [1, 2], f: true })).toEqual([
      { path: 'b.c', before: 2, after: 5 },
      { path: 'b.d', before: 3, after: undefined },
      { path: 'e', before: [1], after: [1, 2] },
      { path: 'f', before: undefined, after: true },
    ]);
    expect(diffRuleParams({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
