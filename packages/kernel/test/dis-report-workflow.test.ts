import { validateDefinition } from '../src/adm-workflow';
import { APPROVAL_WORKFLOW_RULE_TYPE, REPORT_WORKFLOW_RULE_CODE, defaultReportWorkflowParams, engineDefinitionOf, isStaged, reportWorkflowDefect, reportWorkflowOf } from '../src/dis-report-workflow';
import { resolveGovernanceRule, ruleTypeOf, validateRuleParams } from '../src/governance-rules';

const UNIT = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-0000000000a1';

const step = (id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind,
  name: `Step ${id}`,
  assignee_type: 'DOA',
  min_approvals: 1,
  sla_working_hours: 24,
  on_timeout: 'REMIND',
  ...extra,
});

const CHAIN = [
  step('unit-approver', 'UNIT_APPROVER'),
  step('planning-review', 'PLANNING_REVIEW', { assignee_type: 'ROLE_IN_UNIT', role_code: 'PLANNING_REVIEWER', unit_id: UNIT, sla_working_hours: 16 }),
  step('period-close', 'PERIOD_CLOSE', { assignee_type: 'SPECIFIC', membership_ids: [MEMBER], sla_working_hours: 8 }),
  step('push', 'PUSH', { assignee_type: 'SPECIFIC', membership_ids: [MEMBER], on_timeout: 'ESCALATE', escalate_to: MEMBER }),
];

const staged = (steps: Array<Record<string, unknown>> = CHAIN): Record<string, unknown> => ({ mode: 'STAGED', steps });

/** The steps of the approval of a weekly report as a governance rule (WF-1): the default is the single decision, the staged chain is data. */
describe('the approval workflow of a weekly report as a governance rule', () => {
  it('is a registered rule type owned by ADM whose default for REPORT_ACCEPT is the single decision of the unit approver', () => {
    const type = ruleTypeOf(APPROVAL_WORKFLOW_RULE_TYPE);
    expect(type.ownerModule).toBe('ADM');
    expect(type.legalStatus).toBe('UNVERIFIED');
    const resolved = resolveGovernanceRule([], APPROVAL_WORKFLOW_RULE_TYPE, REPORT_WORKFLOW_RULE_CODE, '2026-12-15');
    expect(resolved).toMatchObject({ source: 'DEFAULT', version: 0 });
    const workflow = reportWorkflowOf(resolved?.params);
    expect(workflow.mode).toBe('SINGLE_DECISION');
    expect(workflow.steps.map((one) => one.kind)).toEqual(['UNIT_APPROVER']);
    expect(isStaged(resolved?.params)).toBe(false);
    expect(validateRuleParams(APPROVAL_WORKFLOW_RULE_TYPE, defaultReportWorkflowParams())).toEqual(defaultReportWorkflowParams());
  });

  it('accepts the chain unit approver, planning review, period close, push and turns it into a definition the engine accepts', () => {
    const params = validateRuleParams(APPROVAL_WORKFLOW_RULE_TYPE, staged());
    expect(isStaged(params)).toBe(true);
    const definition = engineDefinitionOf(reportWorkflowOf(params));
    expect(definition.steps.map((one) => one.id)).toEqual(['unit-approver', 'planning-review', 'period-close', 'push']);
    expect(definition.steps[1]).toMatchObject({ assignee_rule: { type: 'ROLE_IN_UNIT', role_code: 'PLANNING_REVIEWER', unit_id: UNIT }, sla_working_hours: 16 });
    expect(definition.steps[3]).toMatchObject({ on_timeout: 'ESCALATE', escalate_to: MEMBER });
    expect(definition.terminal).toEqual({ approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' });
    expect(validateDefinition(definition, 'report.accept')).toEqual([]);
  });

  it('accepts a shorter chain that starts with the unit approver, in the order of the chain', () => {
    expect(reportWorkflowDefect(staged(CHAIN.slice(0, 2)))).toBeUndefined();
    expect(reportWorkflowDefect(staged([CHAIN[0] as Record<string, unknown>, CHAIN[3] as Record<string, unknown>]))).toBeUndefined();
    expect(reportWorkflowDefect(staged([CHAIN[0] as Record<string, unknown>]))).toBeUndefined();
  });

  it('refuses what the platform cannot run, naming the field', () => {
    const fails = (value: unknown): string => {
      try {
        validateRuleParams(APPROVAL_WORKFLOW_RULE_TYPE, value);
      } catch (error) {
        return (error as { detail?: string }).detail ?? 'no detail';
      }
      return 'accepted';
    };
    expect(fails(staged([CHAIN[1] as Record<string, unknown>]))).toBe('steps[0].kind');
    expect(fails(staged([CHAIN[0] as Record<string, unknown>, CHAIN[2] as Record<string, unknown>, CHAIN[1] as Record<string, unknown>]))).toBe('steps[2].kind');
    expect(fails(staged([CHAIN[0] as Record<string, unknown>, step('again', 'UNIT_APPROVER')]))).toBe('steps[1].kind');
    expect(fails({ mode: 'SINGLE_DECISION', steps: CHAIN })).toBe('steps');
    expect(fails(staged([CHAIN[0] as Record<string, unknown>, step('planning-review', 'PLANNING_REVIEW', { assignee_type: 'ROLE_IN_UNIT', role_code: 'PLANNING_REVIEWER' })]))).toBe('steps[1].unit_id');
    expect(fails(staged([CHAIN[0] as Record<string, unknown>, step('planning-review', 'PLANNING_REVIEW', { on_timeout: 'ESCALATE' })]))).toBe('steps[1].escalate_to');
    expect(fails(staged([CHAIN[0] as Record<string, unknown>, step('planning-review', 'PLANNING_REVIEW', { min_approvals: 9 })]))).toBe('steps[1].min_approvals');
    expect(fails({ mode: 'PARALLEL', steps: CHAIN })).toBe('mode');
    expect(fails({ mode: 'STAGED', steps: [], extra: 1 })).toBe('extra');
    expect(fails(staged([{ ...CHAIN[0], surprise: true }]))).toBe('steps[0].surprise');
  });
});
