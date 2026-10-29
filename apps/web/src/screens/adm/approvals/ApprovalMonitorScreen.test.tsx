import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import ApprovalMonitorScreen from './ApprovalMonitorScreen';
import * as labels from './labels';
import { NO_FILTER, applyFilters, byUrgency, describeProblem, toTask } from './model';
import type { Problem } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0180'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('ADM-18', 'FR-ADM-18');
const OPERATOR = ['approval_task.read', 'adm.workflow.operate'];
const FAR_PAST = '2020-01-01T08:00:00.000Z';
const FAR_FUTURE = '2099-01-01T08:00:00.000Z';

const task = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  workflow_instance_id: uuid(100 + n),
  step_id: 'review',
  step_name: 'Rà soát',
  assignee: { id: uuid(500 + n), name: `Người ${n}` },
  due_at: FAR_FUTURE,
  status: 'Pending',
  business_type: 'report.accept',
  resource: { type: 'report', id: uuid(900 + n) },
  version: 3,
  overdue: false,
  overdue_reminders: 0,
  escalated_at: null,
  instance: { id: uuid(100 + n), version: 7, status: 'Running', amount_vnd: '2500000', document_type: 'REPORT_ACCEPT', unit_id: uuid(1), workflow_revision: 4 },
  actions: { decide: false, reassign: true, cancel: true },
  ...extra,
});
const MEMBERS = [
  { id: uuid(501), display_name: 'Người 1', status: 'Active', membership_type: 'STAFF' },
  { id: uuid(700), display_name: 'Lê Văn Thay', status: 'Active', membership_type: 'STAFF' },
  { id: uuid(701), display_name: 'Nghỉ việc', status: 'Suspended', membership_type: 'STAFF' },
];

interface World {
  tasks: Array<Record<string, unknown>>;
  failing: boolean;
}

function open(state: Partial<World> = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}): Harness & { world: World; queries: { getQueryCache(): { getAll(): Array<{ queryKey: readonly unknown[] }> } } } {
  const world: World = { tasks: [], failing: false, ...state };
  const h = baseHarness(() => new Error('unexpected read'), options.command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation === 'get_resources_approval_task') return world.failing ? Promise.reject(new Error('failed')) : Promise.resolve(world.tasks);
    if (operation === 'get_resources_membership') return Promise.resolve(MEMBERS);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  const mounted = mountInSession(<ApprovalMonitorScreen route={ROUTE} />, h, { permissions: options.permissions ?? OPERATOR, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/adm/adm-18');
  return { ...h, world, queries: mounted.queries };
}

const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');
const rowsOf = (): string[] => Array.from(document.querySelectorAll('[data-task]')).map((row) => row.getAttribute('data-task') as string);

afterEach(() => cleanup());

describe('ApprovalMonitorScreen (ADM-18): the approvals that run', () => {
  it('UI-ADM-18, AC-ST-ADM-013-5: lists the open tasks with the record, type, amount, step, assignee, deadline and the workflow version; the late ones are red and come first', async () => {
    open({ tasks: [task(1, { due_at: '2099-02-01T08:00:00.000Z' }), task(2, { due_at: FAR_PAST, overdue: true, overdue_reminders: 2 }), task(3, { due_at: FAR_FUTURE, escalated_at: '2099-01-01T00:00:00.000Z' })] });
    await screen.findByTestId('tasks');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.monitor.title'));
    // The late one first, then by deadline.
    expect(rowsOf()).toEqual([uuid(2), uuid(3), uuid(1)]);
    const late = document.querySelector(`[data-task="${uuid(2)}"]`) as HTMLElement;
    expect(late.getAttribute('data-overdue')).toBe('yes');
    expect(late.className).toContain('late');
    expect((document.querySelector(`[data-task="${uuid(1)}"]`) as HTMLElement).getAttribute('data-overdue')).toBe('no');
    const cells = Array.from(late.querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells[0]).toContain('report');
    expect(cells[0]).toContain(uuid(902).slice(0, 8));
    expect(cells[1]).toBe(word('adm.workflow.type.reportAccept'));
    expect(cells[2]).toContain('2');
    expect(cells[3]).toBe('Rà soát');
    expect(cells[4]).toBe('Người 2');
    expect(cells[6]).toBe('4');
    expect(within(late).getByTestId('status').textContent).toBe(word('adm.monitor.status.late'));
    expect(within(document.querySelector(`[data-task="${uuid(1)}"]`) as HTMLElement).getByTestId('status').textContent).toBe(word('adm.monitor.status.pending'));
    expect(within(document.querySelector(`[data-task="${uuid(3)}"]`) as HTMLElement).getByTestId('escalated').textContent).toBe(word('adm.monitor.status.escalated'));
    expect(screen.getByTestId('counts').textContent).toBe(word('adm.monitor.counts').replace('{open}', '3').replace('{late}', '1'));
  });

  it('filters by business type and by late, and says when nothing matches', async () => {
    open({ tasks: [task(1), task(2, { business_type: 'payment.approve', overdue: true, due_at: FAR_PAST }), task(3, { overdue: true, due_at: FAR_PAST })] });
    await screen.findByTestId('tasks');
    fireEvent.change(document.getElementById('monitor-type') as HTMLElement, { target: { value: 'payment.approve' } });
    expect(rowsOf()).toEqual([uuid(2)]);
    fireEvent.change(document.getElementById('monitor-type') as HTMLElement, { target: { value: '' } });
    fireEvent.click(document.getElementById('monitor-late') as HTMLElement);
    expect(rowsOf()).toEqual([uuid(2), uuid(3)]);
    fireEvent.change(document.getElementById('monitor-type') as HTMLElement, { target: { value: 'plan.publish' } });
    expect(screen.getByTestId('none-shown').textContent).toBe(word('adm.monitor.noneShown'));
  });

  it('reassigns a task with a reason to the person chosen, at the version that was read, and closes when it is done', async () => {
    const h = open({ tasks: [task(1)] }, { command: () => ({ resource_id: uuid(99), resource_version: 1 }) });
    await screen.findByTestId('tasks');
    fireEvent.click(document.querySelector('[data-action="reassign"]') as HTMLElement);
    // The one who holds it is not offered, nor a member who is not active.
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Lê Văn Thay' })).toBeTruthy());
    expect(within(dialog()).queryByRole('option', { name: 'Người 1' })).toBeNull();
    expect(within(dialog()).queryByRole('option', { name: 'Nghỉ việc' })).toBeNull();
    // Nothing is sent without the person and a reason.
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.monitor.reassign.submit') }));
    expect(within(dialog()).getByText(word('adm.monitor.problem.assigneeRequired'))).toBeTruthy();
    expect(within(dialog()).getByText(word('adm.monitor.problem.reasonShort'))).toBeTruthy();
    expect(commandsCalled(h, 'reassignApprovalTask')).toHaveLength(0);
    type('reassign-to', uuid(700));
    type('reassign-reason', 'short');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.monitor.reassign.submit') }));
    expect(commandsCalled(h, 'reassignApprovalTask')).toHaveLength(0);
    type('reassign-reason', 'Người xử lý đang nghỉ phép dài ngày.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.monitor.reassign.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'reassignApprovalTask')).toEqual([expect.objectContaining({ path: { taskId: uuid(1) }, body: { new_assignee_membership_id: uuid(700), reason: 'Người xử lý đang nghỉ phép dài ngày.' }, ifMatchVersion: 3 })]);
  });

  it('cancels the whole approval with a reason at the version of the instance, and says why when the server refuses', async () => {
    let answer: unknown = problem('WORKFLOW_STATE_INVALID');
    const h = open({ tasks: [task(1)] }, { command: () => answer });
    await screen.findByTestId('tasks');
    fireEvent.click(document.querySelector('[data-action="cancel"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.monitor.cancel.submit') }));
    expect(within(dialog()).getByText(word('adm.monitor.problem.reasonShort'))).toBeTruthy();
    expect(commandsCalled(h, 'cancelWorkflowInstance')).toHaveLength(0);
    type('cancel-reason', 'Hồ sơ được chủ sở hữu rút lại.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.monitor.cancel.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.monitor.error.notRunning'));
    answer = { resource_id: uuid(101), resource_version: 8 };
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.monitor.cancel.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'cancelWorkflowInstance')[1]).toMatchObject({ path: { instanceId: uuid(101) }, body: { reason: 'Hồ sơ được chủ sở hữu rút lại.' }, ifMatchVersion: 7 });
  });

  it('says in words why a reassignment was refused and keeps the dialog open', async () => {
    let answer: unknown = problem('APPROVER_NOT_AUTHORIZED', 403);
    open({ tasks: [task(1)] }, { command: () => answer });
    await screen.findByTestId('tasks');
    fireEvent.click(document.querySelector('[data-action="reassign"]') as HTMLElement);
    await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'Lê Văn Thay' })).toBeTruthy());
    type('reassign-to', uuid(700));
    type('reassign-reason', 'Người xử lý đang nghỉ phép dài ngày.');
    const send = (): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.monitor.reassign.submit') }));
    };
    send();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.monitor.error.notAuthorized'));
    answer = problem('SELF_APPROVAL_DENIED', 403);
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.monitor.error.selfApproval')));
    answer = problem('TASK_ALREADY_DECIDED');
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.monitor.error.alreadyDecided')));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers an action only where the server says it may be done, and nothing while read-only', async () => {
    open({ tasks: [task(1, { actions: { decide: false, reassign: false, cancel: false } }), task(2, { actions: { decide: false, reassign: true, cancel: false } })] });
    await screen.findByTestId('tasks');
    expect(within(document.querySelector(`[data-task="${uuid(1)}"]`) as HTMLElement).queryByRole('button')).toBeNull();
    const second = within(document.querySelector(`[data-task="${uuid(2)}"]`) as HTMLElement);
    expect(second.getByRole('button', { name: word('adm.monitor.action.reassign') })).toBeTruthy();
    expect(second.queryByRole('button', { name: word('adm.monitor.action.cancel') })).toBeNull();
    cleanup();
    open({ tasks: [task(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('tasks');
    expect(document.querySelector('[data-action]')).toBeNull();
  });

  it('shows the states of the screen: nothing waiting, a read that failed with a way to read again, and no right to read', async () => {
    const empty = open({ tasks: [] });
    await waitFor(() => expect(empty.client.readAll).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByTestId('tasks')).toBeNull();
    cleanup();
    const failing = open({ failing: true });
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.world.failing = false;
    failing.world.tasks = [task(1)];
    fireEvent.click(retry);
    await screen.findByTestId('tasks');
    cleanup();
    const denied = open({ tasks: [task(1)] }, { permissions: [] });
    await waitFor(() => expect(screen.queryByTestId('tasks')).toBeNull());
    expect(denied.client.readAll).not.toHaveBeenCalled();
  });

  it('reads the directory in the scope of the membership that is signed in: its query is keyed by the tenant and the membership, so switching memberships never shows the other directory', async () => {
    const h = open({ tasks: [task(1)] });
    await screen.findByTestId('tasks');
    fireEvent.click(document.querySelector('[data-action="reassign"]') as HTMLElement);
    await waitFor(() =>
      expect(
        h.queries
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey.includes('assignees')),
      ).toBe(true),
    );
    const key =
      h.queries
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey.includes('assignees'))?.queryKey ?? [];
    expect(key.slice(0, 2)).toEqual(['adm', 'approvals']);
    expect(typeof key[2]).toBe('string');
    expect(typeof key[3]).toBe('string');
  });
});

describe('the model of the monitor', () => {
  it('reads a pending task with its instance and leaves out a row that is not one', () => {
    const now = Date.parse('2026-10-29T00:00:00Z');
    expect(toTask(task(1), now)).toMatchObject({ id: uuid(1), version: 3, instanceId: uuid(101), instanceVersion: 7, amountVnd: '2500000', workflowRevision: 4, mayReassign: true, mayCancel: true, overdue: false, escalated: false });
    expect(toTask(task(1, { status: 'Decided' }), now)).toBeUndefined();
    expect(toTask(task(1, { instance: undefined }), now)).toBeUndefined();
    expect(toTask({ id: uuid(1) }, now)).toBeUndefined();
    expect(toTask(null, now)).toBeUndefined();
    // A payload without the flag is judged by the clock.
    expect(toTask(task(1, { overdue: undefined, due_at: '2026-10-28T00:00:00Z' }), now)?.overdue).toBe(true);
    expect(toTask(task(1, { overdue: undefined, due_at: '2026-10-30T00:00:00Z' }), now)?.overdue).toBe(false);
  });

  it('puts the late tasks first and the earlier deadline before the later, and filters', () => {
    const now = 0;
    const a = toTask(task(1, { due_at: '2099-03-01T00:00:00Z' }), now);
    const b = toTask(task(2, { due_at: '2099-02-01T00:00:00Z' }), now);
    const c = toTask(task(3, { due_at: '2098-01-01T00:00:00Z', overdue: true, business_type: 'plan.publish' }), now);
    const list = [a, b, c].flatMap((item) => (item === undefined ? [] : [item]));
    expect(byUrgency(list).map((item) => item.id)).toEqual([uuid(3), uuid(2), uuid(1)]);
    expect(applyFilters(list, NO_FILTER)).toHaveLength(3);
    expect(applyFilters(list, { businessType: 'plan.publish', onlyOverdue: false }).map((item) => item.id)).toEqual([uuid(3)]);
    expect(applyFilters(list, { businessType: '', onlyOverdue: true }).map((item) => item.id)).toEqual([uuid(3)]);
  });

  it('names each refusal and has a word for every one', () => {
    const cases: Array<[string, Problem]> = [
      ['VERSION_CONFLICT', 'versionConflict'],
      ['APPROVER_NOT_AUTHORIZED', 'notAuthorized'],
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['TASK_ALREADY_DECIDED', 'alreadyDecided'],
      ['WORKFLOW_STATE_INVALID', 'notRunning'],
      ['SCOPE_DENIED', 'denied'],
      ['PERMISSION_DENIED', 'denied'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['VALIDATION_FAILED', 'validation'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, expected] of cases) expect(describeProblem(problem(code))).toBe(expected);
    expect(describeProblem(new Error('x'))).toBe('general');
    const t = ((key: string) => word(key)) as Parameters<typeof labels.problemMessage>[0];
    for (const kind of ['versionConflict', 'notAuthorized', 'selfApproval', 'alreadyDecided', 'notRunning', 'denied', 'notFound', 'validation', 'general'] as const) expect(labels.problemMessage(t, kind)).not.toMatch(/^adm\.monitor\./);
  });
});
