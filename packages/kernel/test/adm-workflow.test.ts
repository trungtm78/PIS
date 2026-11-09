import { DomainError } from '../src/errors';
import { BUSINESS_TYPES, advance, assertValidDefinition, businessTypeOf, finalCommandKey, requiredApprovals, slaAction, validateDefinition } from '../src/adm-workflow';
import type { TaskClock, WorkflowDefinition, WorkflowStep } from '../src/adm-workflow';

const UNIT = '00000000-0000-4000-8000-000000000001';
const MEMBER_A = '00000000-0000-4000-8000-0000000000a1';
const MEMBER_B = '00000000-0000-4000-8000-0000000000a2';

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  name: `Bước ${id}`,
  assignee_rule: { type: 'DOA' },
  min_approvals: 1,
  sla_working_hours: 24,
  on_timeout: 'REMIND',
  ...overrides,
});

const definition = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  steps: [step('review'), step('approve', { allow_return_to: 'review' })],
  terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' },
  ...overrides,
});

const codes = (value: unknown, businessType = 'report.accept'): Array<[string, string]> => validateDefinition(value, businessType).map((defect) => [defect.path, defect.code]);

describe('a workflow definition (BR-ADM-05)', () => {
  it('knows the eight business types, each with the three commands an end can call', () => {
    expect(BUSINESS_TYPES.map((type) => type.code)).toEqual(['report.accept', 'plan.publish', 'payment.approve', 'contract.change', 'period.reopen', 'document.review', 'fnd.figures.accept', 'ind.entry.accept']);
    expect(businessTypeOf('payment.approve')?.commands.APPROVED).toBe('approvePaymentRequest');
    expect(businessTypeOf('nothing')).toBeUndefined();
  });

  it('accepts a definition that follows the language, for each business type', () => {
    expect(validateDefinition(definition(), 'report.accept')).toEqual([]);
    for (const type of BUSINESS_TYPES) {
      const ok = definition({ terminal: { approved: type.commands.APPROVED, returned: type.commands.RETURNED, rejected: type.commands.REJECTED } });
      expect([type.code, validateDefinition(ok, type.code)]).toEqual([type.code, []]);
    }
    const mixed = definition({
      steps: [
        step('legal', { assignee_rule: { type: 'ROLE_IN_UNIT', role_code: 'LEGAL_REVIEWER', unit_id: UNIT }, min_approvals: 2, on_timeout: 'ESCALATE', escalate_to: MEMBER_A }),
        step('chief', { assignee_rule: { type: 'SPECIFIC', membership_ids: [MEMBER_A, MEMBER_B] }, min_approvals: 2, on_timeout: 'EXPIRE', allow_return_to: 'legal' }),
      ],
    });
    expect(validateDefinition(mixed, 'report.accept')).toEqual([]);
  });

  it('AC-ST-ADM-012-4, UAT-PLAN-45: names each defect by its JSON path', () => {
    expect(codes('x')).toEqual([['$', 'NOT_AN_OBJECT']]);
    expect(codes(null)).toEqual([['$', 'NOT_AN_OBJECT']]);
    expect(codes(definition({ steps: [] }))).toEqual([['$.steps', 'STEPS_REQUIRED']]);
    expect(codes(definition({ steps: Array.from({ length: 11 }, (_, n) => step(`step-${n}`)) }))).toEqual([['$.steps', 'TOO_MANY_STEPS']]);
    expect(codes(definition({ steps: [step('aa'), step('bb', { id: 'aa' })] }))).toEqual([['$.steps[1].id', 'STEP_ID_DUPLICATE']]);
    expect(codes(definition({ steps: [step('Bad Id')] }))).toEqual([['$.steps[0].id', 'STEP_ID_INVALID']]);
    expect(codes(definition({ steps: [step('ab', { min_approvals: 0 }), step('cd', { sla_working_hours: 0 }), step('ef', { on_timeout: 'IGNORE' as never })] }))).toEqual([
      ['$.steps[0].min_approvals', 'MIN_APPROVALS_INVALID'],
      ['$.steps[1].sla_working_hours', 'SLA_INVALID'],
      ['$.steps[2].on_timeout', 'ON_TIMEOUT_INVALID'],
    ]);
    expect(codes(definition({ steps: [step('ab', { assignee_rule: { type: 'MANAGER' as never } })] }))).toEqual([['$.steps[0].assignee_rule.type', 'ASSIGNEE_TYPE_INVALID']]);
    expect(codes(definition({ steps: [step('ab', { assignee_rule: { type: 'ROLE_IN_UNIT' } })] }))).toEqual([
      ['$.steps[0].assignee_rule.role_code', 'ROLE_CODE_REQUIRED'],
      ['$.steps[0].assignee_rule.unit_id', 'UNIT_REQUIRED'],
    ]);
    expect(codes(definition({ steps: [step('ab', { assignee_rule: { type: 'SPECIFIC', membership_ids: [] } })] }))).toEqual([['$.steps[0].assignee_rule.membership_ids', 'MEMBERS_REQUIRED']]);
    expect(codes(definition({ steps: [step('ab', { assignee_rule: { type: 'SPECIFIC', membership_ids: [MEMBER_A] }, min_approvals: 2 })] }))).toEqual([['$.steps[0].min_approvals', 'MIN_APPROVALS_EXCEEDS_APPROVERS']]);
    expect(codes(definition({ steps: [step('ab', { on_timeout: 'ESCALATE' })] }))).toEqual([['$.steps[0].escalate_to', 'ESCALATE_TO_REQUIRED']]);
    expect(codes(definition({ steps: [step('ab', { escalate_to: MEMBER_A })] }))).toEqual([['$.steps[0].escalate_to', 'UNEXPECTED_OPERAND']]);
  });

  it('lets a step return only to a step before it, so that no cycle exists but the returns', () => {
    expect(codes(definition({ steps: [step('first', { allow_return_to: 'first' }), step('second')] }))).toEqual([['$.steps[0].allow_return_to', 'RETURN_TARGET_INVALID']]);
    expect(codes(definition({ steps: [step('first', { allow_return_to: 'second' }), step('second')] }))).toEqual([['$.steps[0].allow_return_to', 'RETURN_TARGET_INVALID']]);
    expect(codes(definition({ steps: [step('first'), step('second', { allow_return_to: 'nowhere' })] }))).toEqual([['$.steps[1].allow_return_to', 'RETURN_TARGET_INVALID']]);
  });

  it('maps every end to the command the business type registered, and refuses a business type it does not know and a field it does not have', () => {
    expect(codes(definition({ terminal: undefined }))).toEqual([['$.terminal', 'TERMINAL_REQUIRED']]);
    expect(codes(definition({ terminal: { approved: 'publishPlan', returned: 'returnReport', rejected: 'rejectReport' } }))).toEqual([['$.terminal.approved', 'COMMAND_NOT_REGISTERED']]);
    expect(codes(definition({ terminal: { approved: 'acceptReport', returned: 'returnReport' } }))).toEqual([['$.terminal.rejected', 'COMMAND_REQUIRED']]);
    expect(codes(definition(), 'invoice.pay')).toEqual([['$.business_type', 'BUSINESS_TYPE_UNKNOWN']]);
    expect(codes(definition({ extra: 1 }))).toEqual([['$.extra', 'UNKNOWN_FIELD']]);
    expect(codes(definition({ steps: [step('ab', { assignee_rule: { type: 'DOA', role_code: 'LEADER' } })] }))).toEqual([['$.steps[0].assignee_rule', 'DOA_TAKES_NO_OPERANDS']]);
  });

  it('is refused with 422, naming the first path, and every defect in the extensions', () => {
    let refusal: DomainError | undefined;
    try {
      assertValidDefinition(definition({ steps: [step('ab', { min_approvals: 0, sla_working_hours: -1 })] }), 'report.accept');
    } catch (error) {
      refusal = error as DomainError;
    }
    expect(refusal).toMatchObject({ code: 'WORKFLOW_DEFINITION_INVALID', status: 422, detail: '$.steps[0].min_approvals' });
    expect((refusal?.extensions as { defects: Array<{ path: string }> }).defects.map((defect) => defect.path)).toEqual(['$.steps[0].min_approvals', '$.steps[0].sla_working_hours']);
    expect(assertValidDefinition(definition(), 'report.accept').steps).toHaveLength(2);
  });
});

describe('what a decision does to an instance', () => {
  const flow = assertValidDefinition(
    definition({ steps: [step('review', { min_approvals: 2 }), step('approve', { allow_return_to: 'review' }), step('sign')] }),
    'report.accept',
  ) as WorkflowDefinition;

  it('needs the approvals of the step before it moves on, and completes as approved after the last step', () => {
    expect(advance(flow, 0, 'approve', 1, undefined, undefined)).toEqual({ kind: 'STAY' });
    expect(advance(flow, 0, 'approve', 2, undefined, undefined)).toEqual({ kind: 'NEXT_STEP', stepIndex: 1 });
    expect(advance(flow, 1, 'approve', 1, undefined, undefined)).toEqual({ kind: 'NEXT_STEP', stepIndex: 2 });
    expect(advance(flow, 2, 'approve', 1, undefined, undefined)).toEqual({ kind: 'COMPLETE', outcome: 'APPROVED' });
  });

  it('asks for as many approvals as the DoA band has levels when that is more than the step says', () => {
    expect(requiredApprovals(step('x'), 2)).toBe(2);
    expect(requiredApprovals(step('x', { min_approvals: 3 }), 2)).toBe(3);
    expect(requiredApprovals(step('x', { assignee_rule: { type: 'SPECIFIC', membership_ids: [MEMBER_A] } }), 2)).toBe(1);
    expect(advance(flow, 2, 'approve', 1, 2, undefined)).toEqual({ kind: 'STAY' });
    expect(advance(flow, 2, 'approve', 2, 2, undefined)).toEqual({ kind: 'COMPLETE', outcome: 'APPROVED' });
  });

  it('ends a rejection as rejected, a return with no target as returned to the initiator, and sends a return back only to the step the step allows', () => {
    expect(advance(flow, 1, 'reject', 0, undefined, undefined)).toEqual({ kind: 'COMPLETE', outcome: 'REJECTED' });
    expect(advance(flow, 1, 'return', 0, undefined, undefined)).toEqual({ kind: 'COMPLETE', outcome: 'RETURNED' });
    expect(advance(flow, 1, 'return', 0, undefined, 'review')).toEqual({ kind: 'RETURN_TO_STEP', stepIndex: 0 });
    for (const target of ['sign', 'approve', 'nowhere']) expect(() => advance(flow, 1, 'return', 0, undefined, target)).toThrow(DomainError);
    expect(() => advance(flow, 2, 'return', 0, undefined, 'review')).toThrow(DomainError);
    expect(() => advance(flow, 9, 'approve', 1, undefined, undefined)).toThrow(DomainError);
  });

  it('sends the final command with a key that names the instance and the sequence of the decision', () => {
    expect(finalCommandKey('inst-1', 3)).toBe('wf:inst-1:final:3');
  });
});

describe('slaAction (ST-ADM-013, ADM 3.7 item 4)', () => {
  const t = (iso: string): Date => new Date(iso);
  const clock = (overrides: Partial<TaskClock> = {}): TaskClock => ({ remindAt: t('2026-03-02T09:00:00Z'), remindedAt: null, dueAt: t('2026-03-02T17:00:00Z'), nextReminderAt: null, escalatedAt: null, ...overrides });

  it('does nothing before the reminder point', () => {
    expect(slaAction(clock(), 'REMIND', t('2026-03-02T08:59:59Z'))).toBe('NONE');
  });

  it('reminds once at the reminder point and not again before the deadline', () => {
    expect(slaAction(clock(), 'REMIND', t('2026-03-02T09:00:00Z'))).toBe('REMIND_BEFORE_DUE');
    expect(slaAction(clock({ remindedAt: t('2026-03-02T09:05:00Z') }), 'REMIND', t('2026-03-02T16:59:59Z'))).toBe('NONE');
  });

  it('at the deadline REMIND reminds again and repeats only when the next reminder is due', () => {
    expect(slaAction(clock({ remindedAt: t('2026-03-02T09:05:00Z') }), 'REMIND', t('2026-03-02T17:00:00Z'))).toBe('OVERDUE_REMIND');
    const sent = clock({ remindedAt: t('2026-03-02T09:05:00Z'), nextReminderAt: t('2026-03-03T17:00:00Z') });
    expect(slaAction(sent, 'REMIND', t('2026-03-03T16:59:00Z'))).toBe('NONE');
    expect(slaAction(sent, 'REMIND', t('2026-03-03T17:00:00Z'))).toBe('OVERDUE_REMIND');
  });

  it('at the deadline ESCALATE gives the task to the escalation target once and then only reminds', () => {
    expect(slaAction(clock(), 'ESCALATE', t('2026-03-02T17:00:00Z'))).toBe('ESCALATE');
    const escalated = clock({ escalatedAt: t('2026-03-02T17:01:00Z'), nextReminderAt: t('2026-03-03T17:01:00Z') });
    expect(slaAction(escalated, 'ESCALATE', t('2026-03-02T18:00:00Z'))).toBe('NONE');
    expect(slaAction(escalated, 'ESCALATE', t('2026-03-03T17:01:00Z'))).toBe('OVERDUE_REMIND');
  });

  it('at the deadline EXPIRE expires the task, even when the reminder was never sent', () => {
    expect(slaAction(clock(), 'EXPIRE', t('2026-03-02T17:00:00Z'))).toBe('EXPIRE');
  });

  it('a task found late after the reminder point and the deadline is dealt with as overdue, not reminded twice', () => {
    expect(slaAction(clock(), 'REMIND', t('2026-03-05T10:00:00Z'))).toBe('OVERDUE_REMIND');
  });

  it('a task without a reminder point is only judged at its deadline', () => {
    expect(slaAction(clock({ remindAt: null }), 'REMIND', t('2026-03-02T12:00:00Z'))).toBe('NONE');
    expect(slaAction(clock({ remindAt: null }), 'REMIND', t('2026-03-02T17:00:00Z'))).toBe('OVERDUE_REMIND');
  });
});
