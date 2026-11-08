import { describe, expect, it } from 'vitest';
import { plannedDaysOf, showsSteps, stepperOf, toWorkflow } from './workflow-model';
import type { WorkflowStep } from './workflow-model';

const TASK = { task_id: '00000000-0000-4000-8000-0000000000a1', assignee: { id: '00000000-0000-4000-8000-0000000000b1', name: 'An' }, status: 'Pending', decision: null, decided_at: null, due_at: '2026-12-18T00:00:00.000Z', overdue_reminders: 1, escalated_at: null };
const step = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'UNIT_APPROVER', name: `Step ${id}`, status, sla_working_hours: 24, due_at: null, overdue: false, tasks: [], ...extra });
const answer = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ mode: 'STAGED', rule_version: 2, rule_source: 'RULE', instance: { status: 'Running' }, steps, as_of: '2026-12-15T00:00:00.000Z', ...extra });

describe('the steps of the approval of a report (WF-1)', () => {
  it('reads the answer of the server into steps with their tasks, and refuses what is not an answer', () => {
    const workflow = toWorkflow(answer([step('a', 'CURRENT', { due_at: '2026-12-18T00:00:00.000Z', tasks: [TASK] }), step('b', 'WAITING')]));
    expect(workflow).toMatchObject({ mode: 'STAGED', ruleVersion: 2, instanceStatus: 'Running' });
    expect(workflow?.steps.map((one) => [one.id, one.state])).toEqual([['a', 'CURRENT'], ['b', 'WAITING']]);
    expect(workflow?.steps[0]?.tasks[0]).toMatchObject({ assigneeName: 'An', overdueReminders: 1, status: 'Pending' });
    for (const bad of [undefined, null, 'x', {}, { mode: 'STAGED' }, { mode: 'OTHER', steps: [] }]) expect(toWorkflow(bad)).toBeUndefined();
    expect(toWorkflow(answer([step('a', 'UNKNOWN'), { id: 3 }]))?.steps).toEqual([]);
  });

  it('shows the steps for the staged mode or a report that went through an instance, never for the plain default', () => {
    expect(showsSteps(toWorkflow(answer([step('a', 'CURRENT')])) as never)).toBe(true);
    expect(showsSteps(toWorkflow(answer([step('a', 'CURRENT')], { mode: 'SINGLE_DECISION', instance: null })) as never)).toBe(false);
    expect(showsSteps(toWorkflow(answer([step('a', 'DONE')], { mode: 'SINGLE_DECISION', instance: { status: 'Completed' } })) as never)).toBe(true);
  });

  it('counts a step in days of 8 working hours, at least one', () => {
    expect([1, 8, 9, 16, 24, 40].map(plannedDaysOf)).toEqual([1, 1, 2, 2, 3, 5]);
  });

  it('maps the steps to the stepper of the kit: done, current, upcoming, skipped, and a current step past its deadline is late by whole days', () => {
    const steps = (toWorkflow(answer([step('a', 'DONE'), step('b', 'CURRENT', { overdue: true, due_at: '2026-12-12T00:00:00.000Z' }), step('c', 'WAITING'), step('d', 'CANCELLED')]))?.steps ?? []) as WorkflowStep[];
    const mapped = stepperOf(steps, new Date('2026-12-15T12:00:00Z'), (one) => one.name);
    expect(mapped.map((one) => [one.code, one.status])).toEqual([['a', 'done'], ['b', 'late'], ['c', 'upcoming'], ['d', 'skipped']]);
    expect(mapped[1]).toMatchObject({ lateDays: 3, current: true, plannedDays: 3 });
    expect(mapped[0]?.label).toBe('Step a');
    const onTime = stepperOf([steps[1] as WorkflowStep].map((one) => ({ ...one, overdue: false })), new Date('2026-12-10T00:00:00Z'), (one) => one.name);
    expect(onTime[0]).toMatchObject({ status: 'current' });
  });
});
