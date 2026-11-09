import { BUSINESS_TYPES, enabledBusinessTypes, validateDefinition } from '../src/adm-workflow';
import { defaultReportWorkflowParams, engineDefinitionOf, isStaged, reportWorkflowOf } from '../src/dis-report-workflow';
import { resolveGovernanceRule, validateRuleParams } from '../src/governance-rules';
import { APPROVAL_WORKFLOW_RULE_TYPE } from '../src/dis-report-workflow';
import { assertDeliverable } from '../src/report-issue';
import type { IssuedCopyRef } from '../src/report-issue';
import {
  FND_FIGURE_BUSINESS_TYPE,
  IND_ENTRY_BUSINESS_TYPE,
  STAGED_APPROVALS,
  approvalPushKeyOf,
  holdMoveOnReceipt,
  holdStateAfterPush,
  holdsStep,
  isOpenHold,
  pushLayoutCodeOf,
  pushPackageOf,
  stagedApprovalOfBusinessType,
  stepStateOf,
} from '../src/staged-approval';

const UNIT = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-0000000000b1';

const step = (id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind, name: `Step ${id}`, assignee_type: 'DOA', min_approvals: 1, sla_working_hours: 24, on_timeout: 'REMIND', ...extra });
const CHAIN = [
  step('unit-approver', 'UNIT_APPROVER'),
  step('planning-review', 'PLANNING_REVIEW', { assignee_type: 'ROLE_IN_UNIT', role_code: 'PLANNING_REVIEWER', unit_id: UNIT, sla_working_hours: 16 }),
  step('period-close', 'PERIOD_CLOSE', { assignee_type: 'SPECIFIC', membership_ids: [MEMBER], sla_working_hours: 8 }),
  step('push', 'PUSH', { assignee_type: 'SPECIFIC', membership_ids: [MEMBER], on_timeout: 'ESCALATE', escalate_to: MEMBER }),
];
const STAGED = { mode: 'STAGED', steps: CHAIN };

const failure = (run: () => unknown): { code?: string; status?: number } => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; status?: number };
  }
  return {};
};

/** ENT-3c: one staged chain for the report of DIS, the figure batch of FND and the entry batch of IND, with a PUSH step that waits for the receipt (R22). */
describe('the staged approval of three owners (ENT-3c)', () => {
  it('names one business type, one rule code and one resource for each owner, all registered in the engine', () => {
    expect(STAGED_APPROVALS.map((spec) => spec.owner)).toEqual(['REPORT', 'FND_FIGURE', 'IND_ENTRY']);
    expect(new Set(STAGED_APPROVALS.map((spec) => spec.businessType)).size).toBe(3);
    expect(new Set(STAGED_APPROVALS.map((spec) => spec.ruleCode)).size).toBe(3);
    for (const spec of STAGED_APPROVALS) {
      expect(BUSINESS_TYPES.some((type) => type.code === spec.businessType)).toBe(true);
      expect(stagedApprovalOfBusinessType(spec.businessType)).toBe(spec);
    }
  });

  it('keeps the weekly report as it was: enabled by default, the other two owners enabled by configuration only', () => {
    const mounted = ['ADM', 'DIS', 'FND', 'IND'];
    expect(enabledBusinessTypes({}, mounted)).toEqual(['report.accept']);
    expect(enabledBusinessTypes({ MACHVON_APPROVAL_BUSINESS_TYPES: `${FND_FIGURE_BUSINESS_TYPE},${IND_ENTRY_BUSINESS_TYPE}` }, mounted)).toEqual(['report.accept', 'fnd.figures.accept', 'ind.entry.accept']);
    // A module that is not mounted in the process has its type left out: the boot guard (R14) asks for the handlers of the enabled ones only.
    expect(enabledBusinessTypes({ MACHVON_APPROVAL_BUSINESS_TYPES: `${FND_FIGURE_BUSINESS_TYPE},${IND_ENTRY_BUSINESS_TYPE}` }, ['ADM', 'DIS', 'FND'])).toEqual(['report.accept', 'fnd.figures.accept']);
  });

  it('gives every owner the single decision as the built-in default and accepts the same chain as data', () => {
    for (const spec of STAGED_APPROVALS) {
      const resolved = resolveGovernanceRule([], APPROVAL_WORKFLOW_RULE_TYPE, spec.ruleCode, '2026-12-15');
      expect(resolved).toMatchObject({ source: 'DEFAULT', version: 0 });
      expect(isStaged(resolved?.params)).toBe(false);
      expect(validateRuleParams(APPROVAL_WORKFLOW_RULE_TYPE, defaultReportWorkflowParams())).toEqual(defaultReportWorkflowParams());
      const params = validateRuleParams(APPROVAL_WORKFLOW_RULE_TYPE, STAGED);
      const definition = engineDefinitionOf(reportWorkflowOf(params), spec.businessType);
      expect(definition.steps.map((one) => one.tag)).toEqual(['UNIT_APPROVER', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH']);
      expect(validateDefinition(definition, spec.businessType)).toEqual([]);
    }
  });

  it('ends each owner in its own commands', () => {
    const fnd = engineDefinitionOf(reportWorkflowOf(STAGED), FND_FIGURE_BUSINESS_TYPE);
    expect(fnd.terminal).toEqual({ approved: 'acceptFundingFigures', returned: 'returnFundingFigures', rejected: 'rejectFundingFigures' });
    const ind = engineDefinitionOf(reportWorkflowOf(STAGED), IND_ENTRY_BUSINESS_TYPE);
    expect(ind.terminal).toEqual({ approved: 'acceptIndicatorEntry', returned: 'returnIndicatorEntry', rejected: 'rejectIndicatorEntry' });
    // The default business type is still the report: the existing callers are unchanged.
    expect(engineDefinitionOf(reportWorkflowOf(STAGED)).terminal.approved).toBe('acceptReport');
    expect(() => engineDefinitionOf(reportWorkflowOf(STAGED), 'nothing.here')).toThrow('not registered');
  });
});

describe('the package of the PUSH step', () => {
  it('has a series for each record: a project code that fits is kept, one that does not gets a hash so two codes never share a series', () => {
    expect(pushLayoutCodeOf('DIS_WEEKLY', 'DA-0001')).toBe('DIS_WEEKLY-DA-0001');
    const plain = pushLayoutCodeOf('DIS_WEEKLY', 'da 0001');
    const other = pushLayoutCodeOf('DIS_WEEKLY', 'da/0001');
    expect(plain).toMatch(/^DIS_WEEKLY-DA-0001-[0-9A-F]{6}$/);
    expect(other).not.toBe(plain);
    expect(pushLayoutCodeOf('DIS_WEEKLY', 'x'.repeat(200)).length).toBeLessThanOrEqual(60);
    expect(pushLayoutCodeOf('DIS_WEEKLY', 'x'.repeat(200))).toMatch(/^[A-Z][A-Z0-9_-]{1,59}$/);
  });

  it('is canonical: the same record always has the same hash, whatever the order of its facts', () => {
    const one = pushPackageOf({ layoutCode: 'DIS_WEEKLY-DA-1', period: '2026-12-13', revision: 2, owner: 'REPORT', facts: { a: 1, b: { c: 2, d: 3 } } });
    const two = pushPackageOf({ layoutCode: 'DIS_WEEKLY-DA-1', period: '2026-12-13', revision: 2, owner: 'REPORT', facts: { b: { d: 3, c: 2 }, a: 1 } });
    expect(one.sha256).toBe(two.sha256);
    expect(one.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(one.fileName).toBe('DIS_WEEKLY-DA-1-2026-12-13-r2.json');
    expect(pushPackageOf({ layoutCode: 'DIS_WEEKLY-DA-1', period: '2026-12-13', revision: 3, owner: 'REPORT', facts: { a: 1, b: { c: 2, d: 3 } } }).sha256).not.toBe(one.sha256);
    expect(pushPackageOf({ layoutCode: 'DIS_WEEKLY-DA-1', period: '2026-12-13', revision: 2, owner: 'REPORT', facts: { a: 1, b: { c: 2, d: 3 } }, adjustments: [{ id: 'x', amount_vnd: '5' }] }).sha256).not.toBe(one.sha256);
  });

  it('keys a push by organisation, layout, period and revision (R8): the key never changes for the same revision and differs for the next', () => {
    const key = approvalPushKeyOf({ orgId: ORG, layoutCode: 'DIS_WEEKLY-DA-1', period: '2026-12-13', revision: 2 });
    expect(key).toBe(`${ORG}|DIS_WEEKLY-DA-1|2026-12-13|r2`);
    expect(approvalPushKeyOf({ orgId: ORG, layoutCode: 'DIS_WEEKLY-DA-1', period: '2026-12-13', revision: 2 })).toBe(key);
    expect(approvalPushKeyOf({ orgId: ORG, layoutCode: 'DIS_WEEKLY-DA-1', period: '2026-12-13', revision: 3 })).not.toBe(key);
  });

  it('refuses a revision older than the newest one (R17) with the kernel rule the push log uses', () => {
    const copy = (revision: number): IssuedCopyRef => ({ id: `r${revision}`, orgId: ORG, layoutCode: 'DIS_WEEKLY-DA-1', layoutVersion: '', period: '2026-12-13', revision, supersedes: null, sha256: String(revision).repeat(64).slice(0, 64), snapshot: null });
    expect(failure(() => assertDeliverable(copy(1), copy(2), null)).code).toBe('REPORT_OUT_OF_DATE');
    expect(assertDeliverable(copy(2), copy(2), null)).toBe('DELIVER');
  });
});

describe('the hold of the PUSH step (R22)', () => {
  it('holds only the PUSH step, and only when there is a receiver to push to', () => {
    expect(holdsStep('PUSH', true)).toBe(true);
    expect(holdsStep('PUSH', false)).toBe(false);
    for (const tag of ['UNIT_APPROVER', 'PLANNING_REVIEW', 'PERIOD_CLOSE', undefined]) expect(holdsStep(tag, true)).toBe(false);
  });

  it('is awaiting the receipt after a package was written, never done: only an answer of the receiver moves it', () => {
    expect(holdStateAfterPush('WRITTEN')).toBe('AWAITING_RECEIPT');
    expect(holdStateAfterPush('PENDING')).toBe('AWAITING_RECEIPT');
    expect(holdStateAfterPush('FAILED')).toBe('PUSH_FAILED');
    expect(holdStateAfterPush('ACCEPTED')).toBe('PUSHED');
    expect(holdStateAfterPush('REJECTED')).toBe('REJECTED');
    expect(isOpenHold('AWAITING_RECEIPT')).toBe(true);
    expect(isOpenHold('PUSH_FAILED')).toBe(true);
    for (const state of ['PUSHED', 'REJECTED', 'CANCELLED'] as const) expect(isOpenHold(state)).toBe(false);
  });

  it('releases on an acceptance, ends on a rejection and takes no receipt in any other state', () => {
    expect(holdMoveOnReceipt({ state: 'AWAITING_RECEIPT' }, 'ACCEPTED')).toEqual({ to: 'PUSHED', release: true });
    expect(holdMoveOnReceipt({ state: 'AWAITING_RECEIPT' }, 'REJECTED')).toEqual({ to: 'REJECTED', release: false });
    for (const state of ['PUSH_FAILED', 'PUSHED', 'REJECTED', 'CANCELLED'] as const) {
      expect(failure(() => holdMoveOnReceipt({ state }, 'ACCEPTED'))).toMatchObject({ code: 'APPROVAL_HOLD_STATE_INVALID', status: 409 });
    }
  });

  it('shows the step as awaiting the receipt while the task is still pending', () => {
    expect(stepStateOf('Pending', undefined)).toBe('Pending');
    expect(stepStateOf('Pending', { state: 'AWAITING_RECEIPT' })).toBe('AWAITING_RECEIPT');
    expect(stepStateOf('Pending', { state: 'PUSH_FAILED' })).toBe('PUSH_FAILED');
    expect(stepStateOf('Decided', { state: 'PUSHED' })).toBe('PUSHED');
    expect(stepStateOf('Cancelled', { state: 'CANCELLED' })).toBe('Cancelled');
  });
});
