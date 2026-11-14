import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { seriousViolations } from '../../test/axe';
import ApprovalQueueScreen from './ApprovalQueueScreen';
import { checkPendingComment, pendingCommand, pendingLink, toPendingDecision } from './pending-model';
import { approvalTask, mountPwa, pwaClient, taskId, word } from './test-support';

const DECIDER = ['approval_task.read', 'approval.decide'];
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const summaryOf = (kind: string, extra: Record<string, unknown> = {}) => ({
  kind,
  subject: null,
  unit: { id: id(1), code: 'SO', name: 'Sở Kế hoạch' },
  project: { id: id(2), code: 'DA-01', name: 'Cầu Thủ Thiêm 4' },
  period: null,
  facts: [{ code: 'TASK', value: 'Lập hồ sơ dự toán' }, { code: 'DUE_DATE', value: '2026-11-20' }],
  body: 'Đã đủ chứng từ, đề nghị duyệt hoàn thành.',
  target: { screen: 'PWF-04', id: id(30) },
  ...extra,
});

const completion = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `pwf.task.completion:${id(n)}`,
  kind: 'pwf.task.completion',
  resource: { type: 'project_task', id: id(n) },
  version: 4,
  submitted_at: '2026-11-14T03:00:00.000Z',
  initiator: { name: 'Nguyễn Văn An' },
  due_at: null,
  overdue: false,
  summary: summaryOf('pwf.task.completion'),
  actions: [
    { decision: 'approve', operation_id: 'approveProjectTaskCompletion', reason_required: false, reason_min: 5, reason_max: 500 },
    { decision: 'return', operation_id: 'returnProjectTask', reason_required: true, reason_min: 20, reason_max: 500 },
  ],
  ...extra,
});

const exception = (n: number): Record<string, unknown> => ({
  ...completion(n),
  id: `pwf.task.exception:${id(n)}`,
  kind: 'pwf.task.exception',
  resource: { type: 'project_task_exception', id: id(n) },
  version: 1,
  summary: summaryOf('pwf.task.exception', { facts: [{ code: 'TASK', value: 'Lập hồ sơ dự toán' }, { code: 'EXCEPTION_KIND', value: 'WAIVE_REQUIREMENT' }, { code: 'WAIVED_ITEMS', value: 1 }], body: 'Báo cáo được thay bằng quyết định của tỉnh.' }),
  actions: [
    { decision: 'approve', operation_id: 'decideProjectTaskException', reason_required: false, reason_min: 5, reason_max: 500 },
    { decision: 'reject', operation_id: 'decideProjectTaskException', reason_required: false, reason_min: 5, reason_max: 500 },
  ],
});

function open(items: Array<Record<string, unknown>>, options: { tasks?: Array<Record<string, unknown>>; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; unavailable?: string[] } = {}) {
  const h = pwaClient({
    read: (operation) => (operation === 'listMyPendingDecisions' ? { items, unavailable_sources: options.unavailable ?? [], truncated: false, as_of: '2026-11-15T00:00:00.000Z' } : undefined),
    readAll: (operation) => (operation === 'get_resources_approval_task' ? (options.tasks ?? []) : operation === 'get_resources_organization_unit' ? [] : undefined),
    command: options.command,
  });
  return { ...h, ...mountPwa(<ApprovalQueueScreen />, h, { permissions: DECIDER, ...(options.mode === undefined ? {} : { mode: options.mode }), path: '/m/approvals' }) };
}

afterEach(cleanup);

describe('the model of the pending decisions (PWF 20.9)', () => {
  it('reads an item with its summary, its screen and the commands it names, and drops what it cannot name', () => {
    const item = toPendingDecision(completion(5));
    expect(item).toMatchObject({ id: `pwf.task.completion:${id(5)}`, resourceId: id(5), version: 4, initiatorName: 'Nguyễn Văn An', overdue: false, dueAt: null });
    expect(item?.actions.map((one) => one.operationId)).toEqual(['approveProjectTaskCompletion', 'returnProjectTask']);
    expect(toPendingDecision({ ...completion(5), actions: [{ decision: 'approve', operation_id: 'somethingElse', reason_required: false }] })?.actions).toEqual([]);
    expect(toPendingDecision({ id: 'x' })).toBeUndefined();
  });

  it('builds the request of the command each action names, in the words of that command', () => {
    const done = toPendingDecision(completion(5));
    const back = toPendingDecision(exception(6));
    expect(done && pendingCommand(done, done.actions[0]!, '')).toEqual({ operationId: 'approveProjectTaskCompletion', path: { task_id: id(5) }, body: { decision: 'APPROVE' } });
    expect(done && pendingCommand(done, done.actions[1]!, '  Thiếu chữ ký của tư vấn giám sát  ')).toEqual({ operationId: 'returnProjectTask', path: { task_id: id(5) }, body: { reason: 'Thiếu chữ ký của tư vấn giám sát' } });
    expect(back && pendingCommand(back, back.actions[1]!, 'Không đủ lý do')).toEqual({ operationId: 'decideProjectTaskException', path: { id: id(6) }, body: { decision: 'REJECT', note: 'Không đủ lý do' } });
  });

  it('checks the words against the limits of the command, and links the full record of the module', () => {
    const done = toPendingDecision(completion(5))!;
    expect(checkPendingComment(done.actions[1]!, '')).toBe('required');
    expect(checkPendingComment(done.actions[1]!, 'quá ngắn')).toBe('tooShort');
    expect(checkPendingComment(done.actions[0]!, '')).toBeUndefined();
    expect(checkPendingComment(done.actions[0]!, 'x'.repeat(501))).toBe('tooLong');
    expect(pendingLink(done)).toContain(id(30));
  });
});

describe('the pending decisions in the approval queue (PWF 20.9)', () => {
  it('lists them beside the tasks of the engine, counts them with the others and shows what the decider reads', async () => {
    open([completion(5), exception(6)], { tasks: [approvalTask(1)] });
    const section = await screen.findByTestId('pending-decisions');
    expect(Array.from(section.querySelectorAll('.pwa-card-head h3')).map((one) => one.textContent)).toEqual([word('fix12.inbox.kind.completion'), word('fix12.inbox.kind.exception')]);
    const first = section.querySelector(`[data-pending="pwf.task.completion:${id(5)}"]`) as HTMLElement;
    expect(first.textContent).toContain('Cầu Thủ Thiêm 4');
    expect(first.textContent).toContain('Lập hồ sơ dự toán');
    expect(first.textContent).toContain('20/11/2026');
    expect(first.textContent).toContain('Nguyễn Văn An');
    expect(first.textContent).toContain('Đã đủ chứng từ, đề nghị duyệt hoàn thành.');
    // A code is never a label: the kind of exception is a sentence.
    expect((section.querySelector(`[data-pending="pwf.task.exception:${id(6)}"]`) as HTMLElement).textContent).toContain(word('fix12.apvException.waive.word'));
    expect(screen.getByTestId('counts').textContent).toContain('3 việc chờ duyệt');
    expect(taskId(1)).toBeDefined();
  });

  it('decides through the command the item names, under its version, then reads the list again', async () => {
    const h = open([completion(5)]);
    const section = await screen.findByTestId('pending-decisions');
    fireEvent.click(within(section).getByRole('button', { name: word('fix12.inbox.action.approve') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('fix12.inbox.action.approve') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('approveProjectTaskCompletion', expect.objectContaining({ path: { task_id: id(5) }, body: { decision: 'APPROVE' }, ifMatchVersion: 4 }));
    await screen.findByTestId('pending-receipt');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listMyPendingDecisions').length).toBeGreaterThan(1);
  });

  it('asks for the reason of a return and sends it to returnProjectTask', async () => {
    const h = open([completion(5)]);
    const section = await screen.findByTestId('pending-decisions');
    fireEvent.click(within(section).getByRole('button', { name: word('fix12.inbox.action.return') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('fix12.inbox.action.return') }));
    expect(await within(dialog).findByText(word('fix12.inbox.problem.required'))).toBeInTheDocument();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Thiếu chữ ký của tư vấn giám sát' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('fix12.inbox.action.return') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('returnProjectTask', expect.objectContaining({ path: { task_id: id(5) }, body: { reason: 'Thiếu chữ ký của tư vấn giám sát' }, ifMatchVersion: 4 })));
  });

  it('says in words that the person worked on it when the command refuses the maker, and keeps the item', async () => {
    const h = open([completion(5)], { command: () => new ApiError({ status: 403, code: 'MAKER_IS_APPROVER', correlationId: 'c' }) });
    const section = await screen.findByTestId('pending-decisions');
    fireEvent.click(within(section).getByRole('button', { name: word('fix12.inbox.action.approve') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('fix12.inbox.action.approve') }));
    expect(await within(dialog).findByText(word('fix12.inbox.problem.maker'))).toBeInTheDocument();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('shows no decision button in a read-only session, names a source that could not be read, and has no section when nothing waits', async () => {
    open([completion(5)], { mode: 'READ_ONLY', unavailable: ['PWF'] });
    const section = await screen.findByTestId('pending-decisions');
    expect(within(section).queryByRole('button', { name: word('fix12.inbox.action.approve') })).toBeNull();
    expect(screen.getByTestId('pending-unavailable').textContent).toContain(word('fix12.inbox.unavailable'));
    cleanup();
    open([]);
    await screen.findByTestId('counts');
    expect(screen.queryByTestId('pending-decisions')).toBeNull();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = open([completion(5), exception(6)]);
    await screen.findByTestId('pending-decisions');
    expect(await seriousViolations(container)).toEqual([]);
  });
});
