import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { COMMENT_MAX, NO_FILTER, PERIOD_FILTER, applyFilter, byUrgency, checkComment, decisionBody, describeProblem, mayDecide, toApprovalTask } from './approval-model';
import ApprovalQueueScreen from './ApprovalQueueScreen';
import { FAR_FUTURE, FAR_PAST, approvalTask, mountPwa, pwaClient, taskId, word } from './test-support';

const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const DECIDER = ['approval_task.read', 'approval.decide'];

interface World {
  tasks: Array<Record<string, unknown>>;
  failing?: boolean | Error;
}

function open(world: World, options: { permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; requestStepUp?: () => Promise<void> } = {}) {
  const h = pwaClient({
    readAll: (operation) => {
      if (operation === 'get_resources_approval_task') return world.failing === undefined || world.failing === false ? world.tasks : world.failing instanceof Error ? world.failing : new Error('failed');
      if (operation === 'get_resources_organization_unit') return [{ id: taskId(1), code: 'SO-A', name: 'Sở Kế hoạch', parent_id: null, valid_from: '2020-01-01', unit_type: 'DEPARTMENT', status: 'Active', version: 1 }];
      return new Error(`unexpected ${operation}`);
    },
    command: options.command,
  });
  const mounted = mountPwa(<ApprovalQueueScreen />, h, { permissions: 'permissions' in options ? options.permissions : DECIDER, ...(options.mode === undefined ? {} : { mode: options.mode }), path: '/m/approvals', ...(options.requestStepUp === undefined ? {} : { session: { requestStepUp: options.requestStepUp } }) });
  return { ...h, ...mounted, world };
}

const taskRows = (): string[] => Array.from(document.querySelectorAll('[data-task]')).map((row) => row.getAttribute('data-task') as string);
const card = (id: string): HTMLElement => document.querySelector(`[data-task="${id}"]`) as HTMLElement;
const decisionCalls = (h: ReturnType<typeof open>) => h.command.mock.calls.filter((call) => call[0] === 'decideApprovalTask').map((call) => call[1] as { path: { taskId: string }; body: Record<string, unknown>; ifMatchVersion: number; attempt: { key: string } });

afterEach(cleanup);

describe('ApprovalQueueScreen (PWA-02): the queue of period data', () => {
  it('lists what waits for the person, the late ones first, each with its step, record, amount with the unit and the deadline', async () => {
    open({ tasks: [approvalTask(1, { due_at: '2099-02-01T08:00:00.000Z' }), approvalTask(2, { due_at: FAR_PAST, overdue: true }), approvalTask(3, { due_at: FAR_FUTURE, escalated_at: '2099-01-01T00:00:00.000Z' })] });
    await screen.findByRole('list', { name: word('pwa.approvals.list.aria') });
    expect(taskRows()).toEqual([taskId(2), taskId(3), taskId(1)]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('pwa.approvals.page.title'));
    const late = card(taskId(2));
    expect(late.getAttribute('data-overdue')).toBe('yes');
    // The colour is never the only cue: the pill says it.
    expect(within(late).getByText(word('pwa.approvals.status.late'))).toBeInTheDocument();
    expect(within(card(taskId(3))).getByText(word('pwa.approvals.status.escalated'))).toBeInTheDocument();
    expect(late.textContent).toContain('2.500.000.000');
    expect(late.textContent).toContain(word('pwa.approvals.unit.vnd'));
    expect(late.textContent).toContain('Rà soát số liệu kỳ');
    expect(within(late).getByRole('time')).toBeInTheDocument();
    expect(screen.getByTestId('counts').textContent).toContain('3 việc chờ duyệt, 1 quá hạn');
    // The name of the unit is shown when the reader may read it.
    await waitFor(() => expect(late.textContent).toContain('Sở Kế hoạch'));
  });

  it('reads the tasks of the person, pending only', async () => {
    const h = open({ tasks: [approvalTask(1)] });
    await screen.findByTestId('counts');
    expect(h.readAll).toHaveBeenCalledWith('get_resources_approval_task', { query: { mine: 'true', status: 'Pending' } });
  });

  it('shows a skeleton while loading, and never the number 0', async () => {
    const h = pwaClient({ readAll: () => new Promise(() => undefined) });
    mountPwa(<ApprovalQueueScreen />, h, { permissions: DECIDER, path: '/m/approvals' });
    const skeleton = await screen.findByRole('status', { name: word('states.loading.label') });
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('counts')).toBeNull();
  });

  it('has two empty states: nothing waits, and the filter found nothing with the way to clear it', async () => {
    const none = open({ tasks: [] });
    const empty = await screen.findByTestId('empty');
    expect(empty.getAttribute('data-kind')).toBe('none');
    expect(empty.textContent).toContain(word('pwa.approvals.empty.none.title'));
    none.unmount();

    open({ tasks: [approvalTask(1, { business_type: 'payment.approve' })] });
    await screen.findByTestId('counts');
    fireEvent.change(screen.getByLabelText(word('pwa.approvals.filter.kind')), { target: { value: PERIOD_FILTER } });
    const filtered = await screen.findByTestId('empty');
    expect(filtered.getAttribute('data-kind')).toBe('filtered');
    fireEvent.click(within(filtered).getByRole('button', { name: word('pwa.approvals.empty.filtered.clear') }));
    expect(taskRows()).toEqual([taskId(1)]);
  });

  it('filters by kind and by lateness', async () => {
    open({ tasks: [approvalTask(1), approvalTask(2, { business_type: 'payment.approve', overdue: true, due_at: FAR_PAST }), approvalTask(3, { business_type: 'period.reopen' })] });
    await screen.findByTestId('counts');
    fireEvent.change(screen.getByLabelText(word('pwa.approvals.filter.kind')), { target: { value: PERIOD_FILTER } });
    expect(taskRows().sort()).toEqual([taskId(1), taskId(3)].sort());
    fireEvent.change(screen.getByLabelText(word('pwa.approvals.filter.kind')), { target: { value: 'payment.approve' } });
    expect(taskRows()).toEqual([taskId(2)]);
    fireEvent.change(screen.getByLabelText(word('pwa.approvals.filter.kind')), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText(word('pwa.approvals.filter.late')));
    expect(taskRows()).toEqual([taskId(2)]);
  });

  it('names its failures in the standard states: error (retry in place), offline, denied by the server and denied by the permission', async () => {
    const world: World = { tasks: [approvalTask(1)], failing: true };
    const failing = open(world);
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    world.failing = false;
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('counts');
    failing.unmount();

    const offline = open({ tasks: [], failing: failure(0, NETWORK_ERROR_CODE) });
    expect(await screen.findByText(word('states.offline.title'))).toBeInTheDocument();
    offline.unmount();

    const denied = open({ tasks: [], failing: failure(403, 'SCOPE_DENIED') });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    denied.unmount();

    const forbidden = open({ tasks: [approvalTask(1)] }, { permissions: ['home.read'] });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(forbidden.readAll).not.toHaveBeenCalledWith('get_resources_approval_task', expect.anything());
  });

  it('keeps the list and says it is out of date when a later reading fails (stale, not empty)', async () => {
    const world: World = { tasks: [approvalTask(1)] };
    const h = open(world);
    await screen.findByTestId('counts');
    world.failing = true;
    await h.queries.refetchQueries();
    const stale = await screen.findByTestId('stale');
    expect(stale.textContent).toContain('Số liệu cũ');
    expect(taskRows()).toEqual([taskId(1)]);
  });

  it('approves under the version of the task on the screen, with the comment optional, and gives a receipt', async () => {
    const world: World = { tasks: [approvalTask(1), approvalTask(2)] };
    const h = open(world);
    await screen.findByTestId('counts');
    world.tasks = [approvalTask(2)];
    fireEvent.click(within(card(taskId(1))).getByRole('button', { name: word('pwa.approvals.action.approve') }));
    const sheet = screen.getByRole('dialog', { name: word('pwa.approvals.sheet.approve.title') });
    expect(sheet.textContent).toContain('Rà soát số liệu kỳ');
    expect(sheet.textContent).toContain('2.500.000.000');
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
    const receipt = await screen.findByTestId('receipt');
    expect(receipt.textContent).toContain(word('pwa.approvals.receipt.approved'));
    expect(receipt.textContent).toContain('Rà soát số liệu kỳ');
    expect(receipt.textContent).toContain(word('pwa.approvals.receipt.nextApproved'));
    const [call] = decisionCalls(h);
    expect(call).toMatchObject({ path: { taskId: taskId(1) }, body: { decision: 'approve' }, ifMatchVersion: 3 });
    expect(call?.body).not.toHaveProperty('reason');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The queue is read again: the decided task is gone.
    await waitFor(() => expect(taskRows()).toEqual([taskId(2)]));
  });

  it('sends the opinion of an approval when there is one', async () => {
    const h = open({ tasks: [approvalTask(1)] });
    await screen.findByTestId('counts');
    fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.approve') }));
    fireEvent.change(screen.getByLabelText(word('pwa.approvals.sheet.approve.comment')), { target: { value: '  Đồng ý  ' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
    await screen.findByTestId('receipt');
    expect(decisionCalls(h)[0]?.body).toEqual({ decision: 'approve', reason: 'Đồng ý' });
  });

  it('returns for correction only with a reason, and sends it', async () => {
    const h = open({ tasks: [approvalTask(1)] });
    await screen.findByTestId('counts');
    fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.return') }));
    const sheet = screen.getByRole('dialog', { name: word('pwa.approvals.sheet.return.title') });
    expect(within(sheet).getByLabelText(new RegExp(word('pwa.approvals.sheet.return.comment')))).toBeRequired();
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.return.submit') }));
    expect((await within(sheet).findByTestId('decision-problem')).textContent).toBe(word('pwa.approvals.problem.commentRequired'));
    expect(decisionCalls(h)).toHaveLength(0);
    fireEvent.change(within(sheet).getByLabelText(new RegExp(word('pwa.approvals.sheet.return.comment'))), { target: { value: 'Thiếu số liệu quý 3' } });
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.return.submit') }));
    const receipt = await screen.findByTestId('receipt');
    expect(receipt.textContent).toContain(word('pwa.approvals.receipt.returned'));
    expect(decisionCalls(h)[0]).toMatchObject({ body: { decision: 'return', reason: 'Thiếu số liệu quý 3' }, ifMatchVersion: 3 });
  });

  it('locks the sheet while the decision is on its way: one request however often it is tapped', async () => {
    let release: (value: unknown) => void = () => undefined;
    const h = open({ tasks: [approvalTask(1)] }, { command: () => new Promise((resolve) => (release = resolve)) });
    await screen.findByTestId('counts');
    fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.approve') }));
    const sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
    const busy = await within(sheet).findByRole('button', { name: word('pwa.approvals.sheet.pending') });
    expect(busy).toBeDisabled();
    expect(sheet.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(decisionCalls(h)).toHaveLength(1);
    release({ operation_id: 'op', status: 'OK', resource_version: 4 });
    await screen.findByTestId('receipt');
  });

  it('says why a refusal happened, in the sheet, with what the person can do about it', async () => {
    const refusals: Array<[string, number, string, string | undefined]> = [
      ['VERSION_CONFLICT', 409, 'pwa.approvals.problem.versionConflict', 'reload'],
      ['TASK_ALREADY_DECIDED', 409, 'pwa.approvals.problem.alreadyDecided', 'reload'],
      ['PERIOD_LOCKED', 409, 'pwa.approvals.problem.periodLocked', undefined],
      ['SELF_APPROVAL_DENIED', 403, 'pwa.approvals.problem.selfApproval', undefined],
      ['APPROVER_NOT_AUTHORIZED', 403, 'pwa.approvals.problem.notAuthorized', undefined],
      ['LICENSE_EXPIRED', 402, 'pwa.approvals.problem.licenseExpired', undefined],
      ['PERMISSION_DENIED', 403, 'pwa.approvals.problem.denied', undefined],
      ['VALIDATION_FAILED', 422, 'pwa.approvals.problem.validation', undefined],
      ['SESSION_EXPIRED', 401, 'pwa.approvals.problem.sessionEnded', undefined],
      ['SOMETHING_ELSE', 500, 'pwa.approvals.problem.general', undefined],
    ];
    for (const [code, status, key, remedy] of refusals) {
      const h = open({ tasks: [approvalTask(1)] }, { command: () => failure(status, code) });
      await screen.findByTestId('counts');
      fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.approve') }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
      const problem = await screen.findByTestId('decision-problem');
      expect(problem.textContent, code).toBe(word(key));
      expect(Boolean(document.querySelector('[data-action="reload"]')), code).toBe(remedy === 'reload');
      // Nothing is recorded as decided: no receipt.
      expect(screen.queryByTestId('receipt')).toBeNull();
      h.unmount();
    }
  });

  it('compares and decides again after a conflict: the reload remedy closes the sheet and reads the queue again', async () => {
    const world: World = { tasks: [approvalTask(1)] };
    const h = open(world, { command: () => failure(409, 'VERSION_CONFLICT') });
    await screen.findByTestId('counts');
    fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.approve') }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
    await screen.findByTestId('decision-problem');
    world.tasks = [approvalTask(1, { version: 4 })];
    const before = h.readAll.mock.calls.filter((call) => call[0] === 'get_resources_approval_task').length;
    fireEvent.click(document.querySelector('[data-action="reload"]') as HTMLElement);
    await waitFor(() => expect(h.readAll.mock.calls.filter((call) => call[0] === 'get_resources_approval_task').length).toBe(before + 1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for the second factor when the server wants it', async () => {
    const requestStepUp = vi.fn(() => Promise.resolve());
    open({ tasks: [approvalTask(1)] }, { command: () => failure(401, 'MFA_REQUIRED'), requestStepUp });
    await screen.findByTestId('counts');
    fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.approve') }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
    await screen.findByTestId('decision-problem');
    fireEvent.click(document.querySelector('[data-action="step-up"]') as HTMLElement);
    expect(requestStepUp).toHaveBeenCalledTimes(1);
  });

  it('sends the same request again with the same idempotency key after a lost answer, and a new one for another decision', async () => {
    let calls = 0;
    const h = open({ tasks: [approvalTask(1)] }, { command: () => (++calls === 1 ? failure(0, NETWORK_ERROR_CODE) : { operation_id: 'op', status: 'OK', resource_version: 4 }) });
    await screen.findByTestId('counts');
    fireEvent.click(screen.getByRole('button', { name: word('pwa.approvals.action.approve') }));
    const submit = (): void => void fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('pwa.approvals.sheet.approve.submit') }));
    submit();
    await screen.findByTestId('decision-problem');
    submit();
    await screen.findByTestId('receipt');
    const [first, second] = decisionCalls(h);
    expect(first?.attempt.key).toBeTruthy();
    expect(second?.attempt.key).toBe(first?.attempt.key);
  });

  it('shows no decision controls in a read-only session, nor for a step that is not the reader’s', async () => {
    const readOnly = open({ tasks: [approvalTask(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('counts');
    expect(screen.getByTestId('read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: word('pwa.approvals.action.approve') })).toBeNull();
    expect(screen.getByTestId('cannot-decide')).toBeInTheDocument();
    readOnly.unmount();

    open({ tasks: [approvalTask(1, { actions: { decide: false } })] });
    await screen.findByTestId('counts');
    expect(screen.queryByRole('button', { name: word('pwa.approvals.action.return') })).toBeNull();
    cleanup();

    // The right to read without the right to decide.
    open({ tasks: [approvalTask(1)] }, { permissions: ['approval_task.read'] });
    await screen.findByTestId('counts');
    expect(screen.queryByRole('button', { name: word('pwa.approvals.action.approve') })).toBeNull();
  });

  it('has no serious accessibility violation, in the list and in the open sheet', async () => {
    open({ tasks: [approvalTask(1), approvalTask(2, { overdue: true, due_at: FAR_PAST })] });
    await screen.findByTestId('counts');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: word('pwa.approvals.action.return') })[0] as HTMLElement);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('closes the sheet with Escape and returns the focus to the button that opened it', async () => {
    open({ tasks: [approvalTask(1)] });
    await screen.findByTestId('counts');
    const opener = screen.getByRole('button', { name: word('pwa.approvals.action.approve') });
    opener.focus();
    fireEvent.click(opener);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByLabelText(word('pwa.approvals.sheet.approve.comment'))).toHaveFocus();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('the model of the queue', () => {
  it('reads a task of the contract, and refuses what is not a pending one', () => {
    expect(toApprovalTask(approvalTask(1))).toMatchObject({ id: taskId(1), version: 3, businessType: 'report.accept', amountVnd: '2500000000', canDecide: true, overdue: false });
    expect(toApprovalTask({ ...approvalTask(1), status: 'Decided' })).toBeUndefined();
    expect(toApprovalTask({ ...approvalTask(1), version: 'x' })).toBeUndefined();
    expect(toApprovalTask({ ...approvalTask(1), due_at: undefined })).toBeUndefined();
    expect(toApprovalTask(null)).toBeUndefined();
    expect(toApprovalTask({ ...approvalTask(1), instance: { amount_vnd: '-5' } })?.amountVnd).toBeNull();
    expect(toApprovalTask({ ...approvalTask(1), step_name: undefined })?.stepName).toBe('review');
  });

  it('sorts the late first, then by deadline', () => {
    const a = toApprovalTask(approvalTask(1))!;
    const b = toApprovalTask(approvalTask(2, { overdue: true, due_at: FAR_PAST }))!;
    const c = toApprovalTask(approvalTask(3, { due_at: '2098-01-01T00:00:00.000Z' }))!;
    expect(byUrgency([a, b, c]).map((task) => task.id)).toEqual([b.id, c.id, a.id]);
    expect(applyFilter([a, b, c], NO_FILTER)).toHaveLength(3);
  });

  it('checks the comment: required for a return, never longer than the server keeps', () => {
    expect(checkComment('return', '   ')).toBe('required');
    expect(checkComment('approve', '')).toBeUndefined();
    expect(checkComment('approve', 'x'.repeat(COMMENT_MAX + 1))).toBe('tooLong');
    expect(checkComment('return', 'x'.repeat(COMMENT_MAX))).toBeUndefined();
    expect(decisionBody('approve', ' ')).toEqual({ decision: 'approve' });
    expect(decisionBody('return', ' no ')).toEqual({ decision: 'return', reason: 'no' });
  });

  it('maps the codes of the contract to what they mean, and the unknown to a general failure', () => {
    expect(describeProblem(failure(409, 'VERSION_CONFLICT'))).toBe('versionConflict');
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(describeProblem(failure(404, 'RESOURCE_NOT_FOUND'))).toBe('notFound');
    expect(describeProblem(failure(409, 'WORKFLOW_STATE_INVALID'))).toBe('notRunning');
    expect(describeProblem(failure(401, 'MFA_REQUIRED'))).toBe('stepUp');
    expect(mayDecide(toApprovalTask(approvalTask(1))!, false)).toBe(true);
    expect(mayDecide(toApprovalTask(approvalTask(1))!, true)).toBe(false);
  });
});
