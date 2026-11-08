import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness } from '../../sas/test-support';
import { WorkflowSteps } from './workflow-parts';
import { REPORT, REVIEWER, mount } from './test-support';

afterEach(cleanup);

const TASK_A = { task_id: '00000000-0000-4000-8000-0000000000a1', assignee: { id: '00000000-0000-4000-8000-0000000000b1', name: 'Lê An' }, status: 'Decided', decision: 'approve', decided_at: '2026-12-15T03:00:00.000Z', due_at: '2026-12-18T00:00:00.000Z', overdue_reminders: 0, escalated_at: null };
const TASK_B = { task_id: '00000000-0000-4000-8000-0000000000a2', assignee: { id: '00000000-0000-4000-8000-0000000000b2', name: 'Trần Bình' }, status: 'Pending', decision: null, decided_at: null, due_at: '2020-01-02T00:00:00.000Z', overdue_reminders: 2, escalated_at: '2020-01-03T00:00:00.000Z' };
const staged = {
  mode: 'STAGED',
  rule_version: 3,
  rule_source: 'RULE',
  instance: { status: 'Running', outcome: null, current_step: 1 },
  steps: [
    { id: 'unit-approver', kind: 'UNIT_APPROVER', name: 'Người duyệt đơn vị', status: 'DONE', sla_working_hours: 24, due_at: '2026-12-18T00:00:00.000Z', overdue: false, tasks: [TASK_A] },
    { id: 'planning-review', kind: 'PLANNING_REVIEW', name: 'Ban KHĐT rà soát', status: 'CURRENT', sla_working_hours: 16, due_at: '2020-01-02T00:00:00.000Z', overdue: true, tasks: [TASK_B] },
    { id: 'push', kind: 'PUSH', name: 'Đẩy số', status: 'WAITING', sla_working_hours: 8, due_at: null, overdue: false, tasks: [] },
  ],
  as_of: '2026-12-15T00:00:00.000Z',
};

const open = (answer: unknown) => {
  const h = harness((operation) => (operation === 'getReportWorkflow' ? answer : new Error(`unexpected read ${operation}`)));
  mount(<WorkflowSteps reportId={REPORT} />, h, { permissions: REVIEWER });
  return h;
};

describe('the approval steps on the report (WF-1)', () => {
  it('lists the steps with their state, the deadline, who was given each and who decided it when, and says that the current step is late', async () => {
    const h = open(staged);
    const steps = await screen.findByTestId('workflow-steps');
    expect(h.read).toHaveBeenCalledWith('getReportWorkflow', { path: { id: REPORT } });
    expect(screen.getByRole('heading', { name: vi_['dis.workflow.title'] })).toBeTruthy();
    const list = within(steps).getByRole('list', { name: vi_['dis.workflow.list.label'] });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list.querySelector('[data-step="planning-review"]')?.className).toContain('late');
    expect(list.querySelector('[data-step="unit-approver"]')?.className).toContain('done');
    const details = within(steps).getByTestId('workflow-details');
    expect(details.querySelector('[data-step="unit-approver"]')?.textContent).toContain('Lê An');
    expect(details.querySelector('[data-step="unit-approver"] [data-task-status="Decided"]')).toBeTruthy();
    const current = details.querySelector('[data-step="planning-review"]')?.textContent ?? '';
    expect(current).toContain('Trần Bình');
    expect(current).toContain(vi_['dis.workflow.reminders.text'].replace('{count}', '2'));
    expect(current).toContain('2020');
  });

  it('shows nothing on the default definition, and nothing when the steps cannot be read', async () => {
    const plain = { ...staged, mode: 'SINGLE_DECISION', instance: null };
    const first = open(plain);
    await waitFor(() => expect(first.read.mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('workflow-steps')).toBeNull();
    cleanup();
    const failing = harness(() => new Error('no'));
    mount(<WorkflowSteps reportId={REPORT} />, failing, { permissions: REVIEWER });
    await waitFor(() => expect(failing.read.mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('workflow-steps')).toBeNull();
  });
});

