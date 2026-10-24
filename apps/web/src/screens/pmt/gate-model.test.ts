import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_GATE_FORM, asOfOf, canRetire, describeGateProblem, rulePhase, rulesByGate, toEvaluation, toGateRule, toPublishBody, validateGateRule, validateRetireDate } from './gate-model';
import type { GateRuleForm, GateRuleView } from './gate-model';

const TODAY = '2026-10-24';
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  gate_code: 'START_CONSTRUCTION',
  project_milestone_code: 'START_CONSTRUCTION',
  permit_type_id: 't1',
  permit_type_code: 'BUILDING',
  requirement: 'VALID_PERMIT',
  applies_to_rule: { project_group_keys: ['A'], min_total_investment_vnd: '5000000000' },
  legal_basis: 'Luật Xây dựng, điều 41',
  effective_from: '2026-01-01',
  effective_until: null,
  revision: 1,
  status: 'PUBLISHED',
  version: 1,
  ...overrides,
});
const rule = (overrides: Record<string, unknown> = {}): GateRuleView => toGateRule(raw(overrides)) as GateRuleView;
const form = (overrides: Partial<GateRuleForm> = {}): GateRuleForm => ({ ...EMPTY_GATE_FORM, permitTypeId: 't1', legalBasis: 'Điều 41', effectiveFrom: '2026-11-01', ...overrides });
const problem = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

describe('the gate rules as the read model gives them', () => {
  it('reads a rule with its applicability', () => {
    expect(rule()).toEqual({
      id: 'r1',
      gateCode: 'START_CONSTRUCTION',
      milestoneCode: 'START_CONSTRUCTION',
      permitTypeId: 't1',
      permitTypeCode: 'BUILDING',
      requirement: 'VALID_PERMIT',
      appliesTo: { projectGroupKeys: ['A'], workTypes: [], minTotalInvestmentVnd: '5000000000', maxTotalInvestmentVnd: null },
      legalBasis: 'Luật Xây dựng, điều 41',
      effectiveFrom: '2026-01-01',
      effectiveUntil: null,
      revision: 1,
      status: 'PUBLISHED',
      version: 1,
    });
    expect(rule({ project_milestone_code: null, applies_to_rule: 'x' })).toMatchObject({ milestoneCode: null, appliesTo: { projectGroupKeys: [], workTypes: [] } });
  });

  it('leaves out what is not a rule', () => {
    for (const bad of [undefined, 'x', raw({ id: undefined }), raw({ gate_code: 'ANY' }), raw({ requirement: 'ALWAYS' }), raw({ status: 'OPEN' }), raw({ revision: '1' }), raw({ legal_basis: undefined }), raw({ permit_type_code: undefined })]) {
      expect(toGateRule(bad)).toBeUndefined();
    }
  });

  it('puts the rule in force first and groups the rules by gate in the order of the gates', () => {
    const rules = [
      rule({ id: 'a', gate_code: 'HANDOVER', effective_from: '2025-01-01', effective_until: '2025-12-31', status: 'RETIRED', revision: 1 }),
      rule({ id: 'b', gate_code: 'HANDOVER', effective_from: '2026-01-01', revision: 2 }),
      rule({ id: 'c', gate_code: 'HANDOVER', effective_from: '2027-01-01', revision: 3 }),
      rule({ id: 'd', gate_code: 'CONTRACT_ACTIVATION' }),
    ];
    const grouped = rulesByGate(rules, TODAY);
    expect(grouped.map((group) => group.gateCode)).toEqual(['CONTRACT_ACTIVATION', 'HANDOVER']);
    expect(grouped[1]?.rules.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    expect(rulesByGate([], TODAY)).toEqual([]);
  });

  it('tells where a rule stands on a day: not published, scheduled, in force or ended (a retired one applies until its last day)', () => {
    expect(rulePhase(rule({ status: 'DRAFT' }), TODAY)).toBe('draft');
    expect(rulePhase(rule({ effective_from: '2026-10-25' }), TODAY)).toBe('scheduled');
    expect(rulePhase(rule(), TODAY)).toBe('inForce');
    expect(rulePhase(rule({ status: 'RETIRED', effective_until: '2026-10-24' }), TODAY)).toBe('inForce');
    expect(rulePhase(rule({ status: 'RETIRED', effective_until: '2026-10-23' }), TODAY)).toBe('ended');
  });
});

describe('the form that publishes a rule', () => {
  it('accepts a complete rule and sends it with the lists, the amounts and the dates', () => {
    expect(validateGateRule(form(), TODAY, false)).toEqual({});
    expect(toPublishBody(form({ milestoneCode: ' M ', projectGroupKeys: 'A, B A', workTypes: 'ROAD;BRIDGE', minInvestment: '1', maxInvestment: '2', effectiveUntil: '2027-01-01', legalBasis: '  basis  ' }))).toEqual({
      gate_code: 'START_CONSTRUCTION',
      project_milestone_code: 'M',
      permit_type_id: 't1',
      requirement: 'VALID_PERMIT',
      applies_to_rule: { project_group_keys: ['A', 'B'], work_types: ['ROAD', 'BRIDGE'], min_total_investment_vnd: '1', max_total_investment_vnd: '2' },
      legal_basis: 'basis',
      effective_from: '2026-11-01',
      effective_until: '2027-01-01',
    });
    expect(toPublishBody(form())).toEqual({ gate_code: 'START_CONSTRUCTION', permit_type_id: 't1', requirement: 'VALID_PERMIT', applies_to_rule: {}, legal_basis: 'Điều 41', effective_from: '2026-11-01' });
  });

  it('asks for the permit type, the legal basis and the first day, and refuses a basis or a milestone that is too long', () => {
    expect(validateGateRule({ ...EMPTY_GATE_FORM }, TODAY, false)).toEqual({ permitTypeId: 'required', legalBasis: 'required', effectiveFrom: 'required' });
    expect(validateGateRule(form({ legalBasis: 'x'.repeat(2001), milestoneCode: 'm'.repeat(101) }), TODAY, false)).toEqual({ legalBasis: 'tooLong', milestoneCode: 'tooLong' });
  });

  it('judges the days: real dates, an end after the beginning, and a beginning in the past only for the first rule of a gate and a permit type', () => {
    expect(validateGateRule(form({ effectiveFrom: '2026-02-30' }), TODAY, false)).toEqual({ effectiveFrom: 'invalidDate' });
    expect(validateGateRule(form({ effectiveFrom: '2020-01-01' }), TODAY, false)).toEqual({});
    expect(validateGateRule(form({ effectiveFrom: '2020-01-01' }), TODAY, true)).toEqual({ effectiveFrom: 'past' });
    expect(validateGateRule(form({ effectiveFrom: TODAY }), TODAY, true)).toEqual({});
    expect(validateGateRule(form({ effectiveUntil: '2026-11-01' }), TODAY, false)).toEqual({ effectiveUntil: 'untilOrder' });
    expect(validateGateRule(form({ effectiveUntil: '2026-13-01' }), TODAY, false)).toEqual({ effectiveUntil: 'invalidDate' });
    // An end is not compared with a beginning that is itself wrong.
    expect(validateGateRule(form({ effectiveFrom: '', effectiveUntil: '2026-01-01' }), TODAY, false)).toEqual({ effectiveFrom: 'required' });
  });

  it('judges the lists and the amounts', () => {
    expect(validateGateRule(form({ projectGroupKeys: 'a b' }), TODAY, false)).toEqual({ projectGroupKeys: 'invalidKeys' });
    expect(validateGateRule(form({ workTypes: Array.from({ length: 51 }, (_, index) => `K${index}`).join(',') }), TODAY, false)).toEqual({ workTypes: 'invalidKeys' });
    expect(validateGateRule(form({ minInvestment: '1.5', maxInvestment: '-1' }), TODAY, false)).toEqual({ minInvestment: 'invalidAmount', maxInvestment: 'invalidAmount' });
    expect(validateGateRule(form({ minInvestment: '10', maxInvestment: '9' }), TODAY, false)).toEqual({ maxInvestment: 'amountOrder' });
    expect(validateGateRule(form({ minInvestment: '9', maxInvestment: '9' }), TODAY, false)).toEqual({});
  });

  it('maps the refusals of the commands to what the screen says', () => {
    expect(describeGateProblem(problem('GATE_RULE_OVERLAP'))).toEqual({ reason: 'overlap', field: undefined });
    expect(describeGateProblem(problem('LEGAL_BASIS_REQUIRED', 'legal_basis'))).toEqual({ reason: 'legalBasis', field: 'legal_basis' });
    expect(describeGateProblem(problem('VALIDATION_FAILED', 'effective_from'))).toEqual({ reason: 'validation', field: 'effective_from' });
    expect(describeGateProblem(problem('SCOPE_DENIED'))).toMatchObject({ reason: 'denied' });
    expect(describeGateProblem(problem('RESOURCE_NOT_FOUND'))).toMatchObject({ reason: 'notFound' });
    expect(describeGateProblem(problem('OTHER'))).toMatchObject({ reason: 'general' });
    expect(describeGateProblem(new Error('offline'))).toEqual({ reason: 'general', field: undefined });
  });
});

describe('ending a rule', () => {
  it('judges the last day: a real day, after the rule began, not past, not later than the end it has', () => {
    const open = rule();
    const closed = rule({ effective_until: '2026-12-31' });
    expect(validateRetireDate('', open, TODAY)).toBe('required');
    expect(validateRetireDate('2026-02-30', open, TODAY)).toBe('invalidDate');
    expect(validateRetireDate('2026-01-01', open, TODAY)).toBe('untilOrder');
    expect(validateRetireDate('2027-01-01', closed, TODAY)).toBe('laterEnd');
    expect(validateRetireDate('2026-10-01', open, TODAY)).toBe('past');
    expect(validateRetireDate('2026-10-24', open, TODAY)).toBeUndefined();
    expect(validateRetireDate('2026-12-31', closed, TODAY)).toBeUndefined();
  });

  it('can end a rule that has no end or whose end has not come, never a draft', () => {
    expect(canRetire(rule(), TODAY)).toBe(true);
    expect(canRetire(rule({ effective_until: '2026-10-25' }), TODAY)).toBe(true);
    expect(canRetire(rule({ effective_until: '2026-10-24' }), TODAY)).toBe(false);
    expect(canRetire(rule({ status: 'DRAFT' }), TODAY)).toBe(false);
  });
});

describe('the evaluation as the API answers it', () => {
  const verdict = (overrides: Record<string, unknown> = {}) => ({
    rule_id: 'r1',
    revision: 2,
    project_milestone_code: null,
    permit_type_code: 'BUILDING',
    requirement: 'VALID_OR_EXEMPT',
    legal_basis: 'Điều 41',
    effective_from: '2026-01-01',
    effective_until: null,
    outcome: 'SATISFIED',
    permit: { id: 'p1', permit_no: 'GP-1', status: 'ISSUED', valid_until: '2026-12-31' },
    waiver: null,
    ...overrides,
  });

  it('reads the gates with the rules judged, the permit and the waiver', () => {
    const read = toEvaluation({
      project_id: 'pr1',
      as_of: TODAY,
      gates: [
        { gate_code: 'START_CONSTRUCTION', status: 'PASSED_WITH_WAIVER', rules: [verdict({ outcome: 'WAIVED', permit: null, waiver: { id: 'w1', valid_until: '2026-12-31' } }), verdict()] },
        { gate_code: 'HANDOVER', status: 'PASSED' },
      ],
    });
    expect(read?.projectId).toBe('pr1');
    expect(read?.gates.map((gate) => [gate.gateCode, gate.status, gate.rules.length])).toEqual([
      ['START_CONSTRUCTION', 'PASSED_WITH_WAIVER', 2],
      ['HANDOVER', 'PASSED', 0],
    ]);
    expect(read?.gates[0]?.rules[0]).toMatchObject({ outcome: 'WAIVED', permit: null, waiver: { id: 'w1', validUntil: '2026-12-31' }, milestoneCode: null, revision: 2 });
    expect(read?.gates[0]?.rules[1]).toMatchObject({ outcome: 'SATISFIED', permit: { id: 'p1', permitNo: 'GP-1', status: 'ISSUED', validUntil: '2026-12-31' } });
  });

  it('leaves out a gate or a rule that is not one, and an answer that is not an evaluation', () => {
    const read = toEvaluation({
      project_id: 'pr1',
      as_of: TODAY,
      gates: [{ gate_code: 'ANY', status: 'PASSED' }, { gate_code: 'HANDOVER', status: 'MAYBE' }, 'x', { gate_code: 'HANDOVER', status: 'BLOCKED', rules: [verdict({ outcome: 'MAYBE' }), verdict({ rule_id: undefined }), verdict({ requirement: 'X' }), verdict({ permit: { status: 'ISSUED' } })] }],
    });
    expect(read?.gates).toHaveLength(1);
    expect(read?.gates[0]?.rules).toHaveLength(1);
    expect(read?.gates[0]?.rules[0]?.permit).toBeNull();
    for (const bad of [undefined, 'x', { as_of: TODAY, gates: [] }, { project_id: 'p', gates: [] }, { project_id: 'p', as_of: TODAY }]) expect(toEvaluation(bad)).toBeUndefined();
  });

  it('takes a real day or nothing as the day to evaluate on', () => {
    expect(asOfOf('')).toEqual({ at: undefined, valid: true });
    expect(asOfOf('2026-06-30')).toEqual({ at: '2026-06-30', valid: true });
    expect(asOfOf('2026-02-30')).toEqual({ at: undefined, valid: false });
    expect(asOfOf('yesterday')).toEqual({ at: undefined, valid: false });
  });
});
