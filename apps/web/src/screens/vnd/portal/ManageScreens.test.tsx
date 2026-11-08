import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import PortalManageScreen from './PortalManageScreen';
import RemediationScreen from './RemediationScreen';
import {
  AS_OF,
  CONTRACTOR,
  GUEST,
  STAFF,
  client,
  mount,
  planActionLine,
  planDetail,
  planLine,
  planPage,
  reconfirmationLine,
  reconfirmationPage,
  registerChoices,
  routeOf,
  staffRequest,
  staffRequestPage,
  uuid,
} from './test/portal-test-support';
import type { World } from './test/portal-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string): RegExp => new RegExp(escaped(label));
const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const sent = (): { attempt: { key: unknown } } => ({ attempt: { key: expect.any(String) } });
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
}

function open(element: ReactElement, answers: World['answers'], options: Options = {}) {
  const world: World = { answers, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(element, h, { permissions: options.permissions ?? STAFF, path: options.path ?? '/vnd/vnd-20', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

describe('PortalManageScreen (VND-20)', () => {
  const route = routeOf('VND-20', 'FR-VND-20');
  const answers = (items: Array<Record<string, unknown>> = [staffRequest(1), staffRequest(2, { status: 'OPEN', clock: 'ON_TIME', response_text: null, responded_at: null, response_late: null })]) => ({
    listVendorPortalRequests: staffRequestPage(items),
    listVendorReconfirmations: reconfirmationPage([reconfirmationLine(1), reconfirmationLine(2, { state: 'LAPSED' })]),
    listVendorRegister: registerChoices(),
  });
  const row = (n: number): HTMLElement => document.querySelector(`tr[data-request-id="${uuid('0045', n)}"]`) as HTMLElement;

  it('shows the counts with the "i" of the in-time figure, and each request with its clock, status and answer, a late answer marked', async () => {
    open(<PortalManageScreen route={route} />, answers());
    await screen.findByTestId('request-counts');
    expect(screen.getByTestId('count-open').textContent).toContain('3');
    expect(screen.getByTestId('count-overdue').textContent).toContain('1');
    expect(screen.getByTestId('count-in-time').textContent).toContain('75%');
    expect(within(screen.getByTestId('count-in-time')).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnp.manage.counts.inTime.label') }) })).toBeTruthy();
    expect(row(1).textContent).toContain('Công ty nhà thầu 1');
    expect(row(1).textContent).toContain(word('vnp.requestStatus.responded.name'));
    expect(row(1).textContent).toContain(word('vnp.requestClock.answeredLate.name'));
    expect(within(row(1)).getByTestId('staff-answer').textContent).toContain(word('vnp.requests.late.label'));
    expect(row(2).textContent).toContain('–');
  });

  it('accepts an answer, sending the version that was read', async () => {
    const h = open(<PortalManageScreen route={route} />, answers());
    await screen.findByTestId('request-counts');
    fireEvent.click(within(row(1)).getByTestId('accept'));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('vnp.accept.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('acceptVendorPortalRequest', { path: { id: uuid('0045', 1) }, ifMatchVersion: 4, ...sent() }));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnp.accept.title.text'));
  });

  it('sends an answer back and cancels a request, each with a reason of five characters; an answered request offers both, an open one only the cancel', async () => {
    const h = open(<PortalManageScreen route={route} />, answers());
    await screen.findByTestId('request-counts');
    expect(within(row(2)).queryByTestId('return')).toBeNull();
    expect(within(row(2)).queryByTestId('accept')).toBeNull();
    fireEvent.click(within(row(1)).getByTestId('return'));
    let box = dialog();
    const send = within(box).getByRole('button', { name: word('vnp.return.confirm.action') }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type(box, word('vnd.field.reason.label'), 'Thiếu trang ký');
    fireEvent.click(send);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('returnVendorPortalRequest', { path: { id: uuid('0045', 1) }, ifMatchVersion: 4, body: { reason: 'Thiếu trang ký' }, ...sent() }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(row(2)).getByTestId('cancel'));
    box = dialog();
    type(box, word('vnd.field.reason.label'), 'Gửi nhầm nhà thầu');
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.cancel.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('cancelVendorPortalRequest', { path: { id: uuid('0045', 2) }, ifMatchVersion: 4, body: { reason: 'Gửi nhầm nhà thầu' }, ...sent() }));
  });

  it('sends a request to a contractor chosen from the register; the contractor comes from the path, never from the body', async () => {
    const h = open(<PortalManageScreen route={route} />, answers());
    fireEvent.click(await screen.findByTestId('create-request'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Công ty nhà thầu 1/ });
    expect(h.read).toHaveBeenCalledWith('listVendorRegister', { query: { verification: 'VERIFIED', limit: 20 } });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.picker.field.label'))), { target: { value: CONTRACTOR } });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.create.field.kind.label'))), { target: { value: 'INFORMATION' } });
    type(box, word('vnp.create.field.title.label'), 'Báo cáo tài chính 2025');
    const confirm = within(box).getByRole('button', { name: word('vnp.create.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createVendorPortalRequest', { path: { id: CONTRACTOR }, body: { kind: 'INFORMATION', title: 'Báo cáo tài chính 2025' }, ...sent() }));
  });

  it('says in the dialog when the contractor has no guest account (422 CONTRACTOR_PORTAL_NOT_BOUND)', async () => {
    open(<PortalManageScreen route={route} />, answers(), { command: () => problem(422, 'CONTRACTOR_PORTAL_NOT_BOUND') });
    fireEvent.click(await screen.findByTestId('create-request'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Công ty nhà thầu 1/ });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.picker.field.label'))), { target: { value: CONTRACTOR } });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.create.field.kind.label'))), { target: { value: 'OTHER' } });
    type(box, word('vnp.create.field.title.label'), 'Câu hỏi');
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.create.confirm.action') }));
    expect((await within(box).findByTestId('dialog-error')).textContent).toBe(word('vnp.error.notBound.text'));
  });

  it('filters the requests by status and kind on the server', async () => {
    const h = open(<PortalManageScreen route={route} />, answers());
    await screen.findByTestId('request-counts');
    fireEvent.change(screen.getByLabelText(word('vnp.requests.filter.status.label')), { target: { value: 'OPEN' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorPortalRequests', { query: { status: 'OPEN' } }));
    fireEvent.change(screen.getByLabelText(word('vnp.manage.filter.kind.label')), { target: { value: 'INFORMATION' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorPortalRequests', { query: { status: 'OPEN', kind: 'INFORMATION' } }));
  });

  it('shows the confirmation of the profiles: the counts, the current share with its "i", the state of each contractor, and filters by state', async () => {
    const h = open(<PortalManageScreen route={route} />, answers());
    await screen.findByTestId('request-counts');
    fireEvent.click(screen.getByTestId('tab-reconfirmations'));
    await screen.findByTestId('reconfirm-counts');
    expect(screen.getByTestId('rc-current').textContent).toContain('41.7%');
    expect(screen.getByTestId('rc-state-lapsed').textContent).toContain('1');
    expect(screen.getByTestId('rc-state-never').textContent).toContain('3');
    const lapsed = document.querySelector(`tr[data-contractor-id="${uuid('0001', 2)}"]`) as HTMLElement;
    expect(lapsed.textContent).toContain(word('vnp.reconfirmState.lapsed.name'));
    fireEvent.change(screen.getByLabelText(word('vnp.manage.reconfirm.filter.label')), { target: { value: 'OVERDUE' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorReconfirmations', { query: { state: 'OVERDUE' } }));
  });

  it('offers no command to a reader, in a read-only workspace, and says the states: empty, error with retry, denied', async () => {
    open(<PortalManageScreen route={route} />, answers(), { permissions: ['vnd.read'] });
    await screen.findByTestId('request-counts');
    expect(screen.queryByTestId('create-request')).toBeNull();
    expect(screen.queryByTestId('accept')).toBeNull();
    cleanup();
    open(<PortalManageScreen route={route} />, answers(), { mode: 'READ_ONLY' });
    await screen.findByTestId('request-counts');
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    expect(screen.queryByTestId('create-request')).toBeNull();
    cleanup();
    open(<PortalManageScreen route={route} />, answers([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open(<PortalManageScreen route={route} />, answers(), { failing: { listVendorPortalRequests: { error: new Error('boom'), times: 1 } } });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('request-counts');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'listVendorPortalRequests').length).toBeGreaterThanOrEqual(2);
    cleanup();
    open(<PortalManageScreen route={route} />, { ...answers(), listVendorPortalRequests: problem(403, 'SCOPE_DENIED') });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });

  it('is not the portal of a contractor: it holds no guest right and never draws the guest frame', async () => {
    open(<PortalManageScreen route={route} />, answers(), { permissions: STAFF });
    await screen.findByTestId('request-counts');
    expect(document.querySelector('[data-portal="true"]')).toBeNull();
    expect(GUEST.some((permission) => STAFF.includes(permission))).toBe(false);
    expect(AS_OF).toBeTruthy();
  });
});

describe('RemediationScreen (VND-21)', () => {
  const route = routeOf('VND-21', 'FR-VND-21');
  const PLAN = uuid('0044', 1);
  const listAnswers = () => ({ listVendorRemediationPlans: planPage([planLine(1), planLine(2, { status: 'PROPOSED', overdue_count: 0 })]), listVendorRegister: registerChoices() });
  const detailAnswers = (over: Record<string, unknown> = {}) => ({ getVendorRemediationPlan: planDetail(over) });

  it('lists the plans with the progress, the overdue actions and a link to each plan', async () => {
    const h = open(<RemediationScreen route={route} />, listAnswers(), { path: '/vnd/vnd-21' });
    const first = (await screen.findByText('Khắc phục tiến độ 1')) as HTMLElement;
    expect(first.getAttribute('href')).toBe(`/vnd/vnd-21?plan=${PLAN}`);
    const rowOf = document.querySelector(`tr[data-plan-id="${PLAN}"]`) as HTMLElement;
    expect(rowOf.textContent).toContain(text('vnp.remediation.progress.text', { verified: 1, total: 2 }));
    expect(rowOf.textContent).toContain(text('vnp.remediation.overdue.text', { count: 1 }));
    expect(rowOf.textContent).toContain(word('vnp.planStatus.inProgress.name'));
    fireEvent.change(screen.getByLabelText(word('vnp.requests.filter.status.label')), { target: { value: 'PROPOSED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorRemediationPlans', { query: { status: 'PROPOSED' } }));
  });

  it('proposes a plan with actions that have a due day each; the contractor is in the path', async () => {
    const h = open(<RemediationScreen route={route} />, listAnswers(), { path: '/vnd/vnd-21' });
    fireEvent.click(await screen.findByTestId('create-plan'));
    const box = dialog();
    await within(box).findByRole('option', { name: /Công ty nhà thầu 1/ });
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.picker.field.label'))), { target: { value: CONTRACTOR } });
    type(box, word('vnp.create.field.title.label'), 'Khắc phục an toàn lao động');
    type(box, word('vnp.planCreate.field.objective.label'), 'Không có tai nạn trong ba tháng tới');
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.planCreate.field.trigger.label'))), { target: { value: 'NON_CONFORMANCE' } });
    const confirm = within(box).getByRole('button', { name: word('vnp.planCreate.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(box).getByLabelText(text('vnd.rows.cell.label', { column: word('vnp.planCreate.actions.column.description'), row: 1 })), { target: { value: 'Tập huấn an toàn cho công nhân' } });
    fireEvent.change(within(box).getByLabelText(text('vnd.rows.cell.label', { column: word('vnp.planCreate.actions.column.due'), row: 1 })), { target: { value: '2026-12-15' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('createVendorRemediationPlan', {
        path: { id: CONTRACTOR },
        body: { title: 'Khắc phục an toàn lao động', objective: 'Không có tai nạn trong ba tháng tới', trigger_kind: 'NON_CONFORMANCE', actions: [{ description: 'Tập huấn an toàn cho công nhân', due_on: '2026-12-15' }] },
        ...sent(),
      }),
    );
  });

  it('shows one plan with its actions, who reported each as done, and its history', async () => {
    open(<RemediationScreen route={route} />, detailAnswers(), { path: `/vnd/vnd-21?plan=${PLAN}` });
    await screen.findByTestId('timeline');
    const action = document.querySelector(`tr[data-action-id="${uuid('0043', 1)}"]`) as HTMLElement;
    expect(action.textContent).toContain(text('vnp.remediation.doneNote.text', { name: 'Nguyễn Văn An', note: 'Đã bổ sung hai giám sát' }));
    expect(action.textContent).toContain(word('vnp.actionStatus.done.name'));
    expect(screen.getByTestId('timeline').textContent).toContain('START');
    expect(screen.queryByTestId('start-plan')).toBeNull();
  });

  it('verifies an action that was reported done, or opens it again, with the version that was read', async () => {
    const h = open(<RemediationScreen route={route} />, detailAnswers(), { path: `/vnd/vnd-21?plan=${PLAN}` });
    await screen.findByTestId('timeline');
    expect(screen.getAllByTestId('verify-action')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('verify-action'));
    const box = dialog();
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.verify.field.outcome.label'))), { target: { value: 'REOPEN' } });
    type(box, word('vnp.verify.field.note.label'), 'Chưa có hồ sơ chứng minh');
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.verify.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('verifyVendorRemediationAction', { path: { id: uuid('0043', 1) }, ifMatchVersion: 3, body: { outcome: 'REOPEN', note: 'Chưa có hồ sơ chứng minh' }, ...sent() }));
  });

  it('completes a plan, starts one the contractor agreed to, and closes one as failed with a reason', async () => {
    const h = open(<RemediationScreen route={route} />, detailAnswers(), { path: `/vnd/vnd-21?plan=${PLAN}` });
    fireEvent.click(await screen.findByTestId('complete-plan'));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('vnp.planComplete.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('completeVendorRemediationPlan', { path: { id: PLAN }, ifMatchVersion: 6, ...sent() }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('close-plan'));
    const box = dialog();
    fireEvent.change(within(box).getByLabelText(labelOf(word('vnp.close.field.outcome.label'))), { target: { value: 'FAILED' } });
    type(box, word('vnd.field.reason.label'), 'Nhà thầu không còn liên lạc');
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.close.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('closeVendorRemediationPlan', { path: { id: PLAN }, ifMatchVersion: 6, body: { outcome: 'FAILED', reason: 'Nhà thầu không còn liên lạc' }, ...sent() }));
    cleanup();
    const g = open(<RemediationScreen route={route} />, detailAnswers({ may_start: true, may_complete: false, may_close: false }), { path: `/vnd/vnd-21?plan=${PLAN}` });
    fireEvent.click(await screen.findByTestId('start-plan'));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('vnp.planStart.confirm.action') }));
    await waitFor(() => expect(g.command).toHaveBeenCalledWith('startVendorRemediationPlan', { path: { id: PLAN }, ifMatchVersion: 6, ...sent() }));
  });

  it('says a plan that is not completable (409 REMEDIATION_STATE_INVALID) in the dialog, and a missing plan as empty', async () => {
    open(<RemediationScreen route={route} />, detailAnswers(), { path: `/vnd/vnd-21?plan=${PLAN}`, command: () => problem(409, 'REMEDIATION_STATE_INVALID') });
    fireEvent.click(await screen.findByTestId('complete-plan'));
    const box = dialog();
    fireEvent.click(within(box).getByRole('button', { name: word('vnp.planComplete.confirm.action') }));
    expect((await within(box).findByTestId('dialog-error')).textContent).toBe(word('vnp.error.planState.text'));
    cleanup();
    open(<RemediationScreen route={route} />, { getVendorRemediationPlan: problem(404, 'RESOURCE_NOT_FOUND') }, { path: `/vnd/vnd-21?plan=${PLAN}` });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });

  it('offers no command to a reader', async () => {
    open(<RemediationScreen route={route} />, detailAnswers(), { path: `/vnd/vnd-21?plan=${PLAN}`, permissions: ['vnd.read'] });
    await screen.findByTestId('timeline');
    for (const id of ['complete-plan', 'close-plan', 'verify-action', 'start-plan']) expect(screen.queryByTestId(id)).toBeNull();
    expect(planActionLine(1).status).toBe('DONE');
  });
});
