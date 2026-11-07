import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import parts_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import SodScreen from './SodScreen';

const catalogue = { ...(vi_ as Record<string, string>), ...(parts_ as Record<string, string>) };
const word = (key: string): string => catalogue[key] ?? key;
const refusal = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0240'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('ADM-24', 'FR-ADM-24');
const ME = '00000000-0000-4000-8000-000000000001';
const ALL = ['adm.sod.read', 'adm.sod.exception.request', 'adm.sod.exception.approve', 'adm.sod.exception.revoke'];
const today = (offset = 0): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const MATRIX = {
  as_of: today(),
  rule_version: 0,
  source: 'DEFAULT',
  unverified: true,
  exception_approvers: 2,
  formula: 'Một người không được giữ cả hai việc của một cặp trong cùng phạm vi.',
  source_text: 'G4-1 của lộ trình quản trị',
  rule_as_of: '2026-11-08',
  expiring_exceptions: 2,
  conflicts: [
    { action_a: 'payment.request', action_b: 'payment.verify', scope: 'SAME_RECORD', severity: 'BLOCK', exception_max_days: 14 },
    { action_a: 'bid.evaluate', action_b: 'bid.award', scope: 'SAME_PACKAGE', severity: 'BLOCK', exception_max_days: 0 },
    { action_a: 'acceptance.approve', action_b: 'payment.verify', scope: 'SAME_CONTRACT', severity: 'WARN', exception_max_days: 14 },
  ],
};

const exception = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  action_a: 'acceptance.approve',
  action_b: 'payment.verify',
  scope: 'SAME_CONTRACT',
  subject_id: uuid(900),
  member_id: uuid(600 + n),
  member_name: `Người ${n}`,
  requested_by: uuid(700),
  requested_by_name: 'Lê Văn Xin',
  reason: 'Kiểm soát viên duy nhất nghỉ phép',
  valid_from: today(-1),
  valid_to: today(3),
  rule_version: 0,
  approvers_needed: 2,
  approvals: 1,
  status: 'REQUESTED',
  stored_status: 'REQUESTED',
  revoke_reason: null,
  uses: 0,
  version: 2,
  ...extra,
});

interface World {
  matrix: Record<string, unknown> | Error;
  exceptions: Array<Record<string, unknown>> | Error;
}

function open(state: Partial<World> = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}): Harness & { world: World; readAll: ReturnType<typeof vi.fn> } {
  const world: World = { matrix: MATRIX, exceptions: [], ...state };
  const h = baseHarness((operation) => {
    if (operation === 'getSodMatrix') return world.matrix;
    return new Error(`unexpected read ${operation}`);
  }, options.command);
  const readAll = vi.fn((operation: string, input?: { query?: Record<string, string> }) => {
    if (operation === 'listSodExceptions') {
      if (world.exceptions instanceof Error) return Promise.reject(world.exceptions);
      const status = input?.query?.status;
      return Promise.resolve(world.exceptions.filter((row) => status === undefined || row.status === status));
    }
    if (operation === 'get_resources_membership') return Promise.resolve([{ id: uuid(601), display_name: 'Trần Thị Nhận', status: 'Active', membership_type: 'STAFF' }]);
    if (operation === 'get_resources_contract') return Promise.resolve([{ id: uuid(901), code: 'HD-001', title: 'Hợp đồng thi công' }]);
    if (operation === 'get_resources_procurement_package') return Promise.resolve([{ id: uuid(902), code: 'GT-001', title: 'Gói thầu xây lắp' }]);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  (h.client as unknown as { readAll: unknown }).readAll = readAll;
  const mounted = mountInSession(<SodScreen route={ROUTE} />, h, { permissions: options.permissions ?? ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/adm/adm-24');
  return { ...h, world, readAll, queries: mounted.queries } as never;
}

const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const dialog = (): HTMLElement => screen.getByRole('dialog');
const tab = async (name: 'matrix' | 'exceptions'): Promise<void> => {
  await waitFor(() => expect(document.querySelector(`[data-tab="${name}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-tab="${name}"]`) as HTMLElement);
};

afterEach(() => cleanup());

describe('SodScreen (ADM-24): the matrix of duties and its exceptions', () => {
  it('UI-ADM-24: shows the matrix with the effect of each pair, the days an exception may run, the version in force and the word that nobody confirmed the numbers', async () => {
    open();
    await screen.findByTestId('matrix');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('govd.sod.title'));
    expect(screen.getByTestId('unverified').textContent).toBe(word('govd.sod.unverified'));
    const row = (pair: string) => document.querySelector(`[data-pair="${pair}"]`) as HTMLElement;
    expect(row('payment.request|payment.verify|SAME_RECORD').textContent).toContain(word('govd.sod.action.paymentRequest'));
    expect(row('payment.request|payment.verify|SAME_RECORD').textContent).toContain(word('govd.sod.severity.block'));
    expect(within(row('payment.request|payment.verify|SAME_RECORD')).getByTestId('max-days').textContent).toBe('14 ngày');
    expect(within(row('bid.evaluate|bid.award|SAME_PACKAGE')).getByTestId('max-days').textContent).toBe(word('govd.sod.maxDays.none'));
    expect(row('acceptance.approve|payment.verify|SAME_CONTRACT').textContent).toContain(word('govd.sod.severity.warn'));
    expect(document.body.textContent).toContain(word('govd.sod.context.versionDefault'));
    // A pair with no exception offers no request; the others do.
    expect(row('bid.evaluate|bid.award|SAME_PACKAGE').querySelector('[data-action="request-pair"]')).toBeNull();
    expect(row('payment.request|payment.verify|SAME_RECORD').querySelector('[data-action="request-pair"]')).not.toBeNull();
    // The figures: three pairs, two that stop the command, one with no exception, two exceptions about to end.
    const tiles = Array.from(document.querySelectorAll('.ui-kpi')).map((tile) => tile.textContent ?? '');
    expect(tiles.join('|')).toContain('3');
    expect(tiles.join('|')).toContain(word('govd.sod.kpi.expiring'));
  });

  it('says why when it cannot show the matrix: denied without the grant (and nothing is read), an error with a retry, an empty matrix', async () => {
    const denied = open({}, { permissions: ['adm.security.read'] });
    await waitFor(() => expect(screen.getByText(word('states.denied.title'))).toBeTruthy());
    expect(denied.read).not.toHaveBeenCalled();
    cleanup();
    open({ matrix: new Error('down') });
    await waitFor(() => expect(screen.getByText(word('states.error.title'))).toBeTruthy());
    cleanup();
    open({ matrix: { ...MATRIX, conflicts: [] } });
    await waitFor(() => expect(screen.getByText(word('states.empty.title'))).toBeTruthy());
  });

  it('lists the exceptions with who asked, who is covered, the approvals so far, the days left of one in force and how often it was used', async () => {
    const h = open({
      exceptions: [
        exception(1),
        exception(2, { status: 'APPROVED', approvals: 2, uses: 3, valid_to: today(2) }),
        exception(3, { status: 'REVOKED', revoke_reason: 'Người kiểm đã quay lại' }),
        exception(4, { status: 'EXPIRED', valid_to: today(-2) }),
      ],
    });
    await tab('exceptions');
    await screen.findByTestId('exceptions');
    const row = (n: number) => document.querySelector(`[data-exception="${uuid(n)}"]`) as HTMLElement;
    await waitFor(() => expect(row(1)).not.toBeNull());
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('govd.sod.status.requested'));
    expect(within(row(1)).getByTestId('approvals').textContent).toBe('1/2 người');
    expect(row(1).textContent).toContain('Lê Văn Xin');
    expect(row(1).textContent).toContain('Người 1');
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('govd.sod.status.approved'));
    expect(within(row(2)).getByTestId('uses').textContent).toBe('3');
    expect(row(2).textContent).toContain('Còn 2 ngày');
    expect(row(3).textContent).toContain('Người kiểm đã quay lại');
    expect(within(row(4)).getByTestId('status').textContent).toBe(word('govd.sod.status.expired'));
    // The filter asks the server for one status.
    fireEvent.change(document.querySelector('[data-filter="status"]') as HTMLElement, { target: { value: 'APPROVED' } });
    await waitFor(() => expect(h.readAll).toHaveBeenCalledWith('listSodExceptions', { query: { status: 'APPROVED' } }));
    await waitFor(() => expect(document.querySelector(`[data-exception="${uuid(1)}"]`)).toBeNull());
    expect(document.querySelector(`[data-exception="${uuid(2)}"]`)).not.toBeNull();
  });

  it('offers approve and reject to a holder who is neither the person who asked nor the one covered, and revoke on a live exception', async () => {
    open({
      exceptions: [exception(1), exception(2, { requested_by: ME }), exception(3, { member_id: ME }), exception(4, { status: 'APPROVED', approvals: 2 }), exception(5, { status: 'REJECTED' })],
    });
    await tab('exceptions');
    await waitFor(() => expect(document.querySelector(`[data-exception="${uuid(1)}"]`)).not.toBeNull());
    const buttons = (n: number): string[] => Array.from(document.querySelectorAll(`[data-exception="${uuid(n)}"] [data-action]`)).map((button) => button.getAttribute('data-action') as string);
    expect(buttons(1)).toEqual(['approve', 'reject', 'revoke']);
    expect(buttons(2)).toEqual(['revoke']);
    expect(buttons(3)).toEqual(['revoke']);
    expect(buttons(4)).toEqual(['revoke']);
    expect(buttons(5)).toEqual([]);
  });

  it('hides every action from a reader and in read-only mode', async () => {
    open({ exceptions: [exception(1)] }, { permissions: ['adm.sod.read'] });
    await screen.findByTestId('matrix');
    expect(document.querySelector('[data-action="request"]')).toBeNull();
    expect(document.querySelector('[data-action="request-pair"]')).toBeNull();
    await tab('exceptions');
    await waitFor(() => expect(document.querySelector(`[data-exception="${uuid(1)}"]`)).not.toBeNull());
    expect(document.querySelectorAll('[data-action]').length).toBe(0);
    cleanup();
    open({ exceptions: [exception(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('matrix');
    expect(document.querySelector('[data-action="request"]')).toBeNull();
  });

  it('approves with the version it saw and an optional comment, and says what the server refused in words', async () => {
    const h = open({ exceptions: [exception(1)] }, { command: () => ({ resource_id: uuid(1), resource_version: 3 }) });
    await tab('exceptions');
    await waitFor(() => expect(document.querySelector('[data-action="approve"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="approve"]') as HTMLElement);
    expect(within(dialog()).getByText(word('govd.sod.approve.title'))).toBeTruthy();
    expect(dialog().textContent).toContain('1 / 2'.replace(' / ', '/'));
    fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: 'Đã kiểm tra lý do' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('govd.sod.approve.confirm') }));
    await waitFor(() => expect(commandsCalled(h, 'approveSodException')).toHaveLength(1));
    expect(commandsCalled(h, 'approveSodException')[0]).toMatchObject({ path: { id: uuid(1) }, ifMatchVersion: 2, body: { comment: 'Đã kiểm tra lý do' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the refusal of an approval inside the dialog and keeps the dialog open', async () => {
    const h = open({ exceptions: [exception(1)] }, { command: () => refusal('SELF_APPROVAL_DENIED', 403) });
    await tab('exceptions');
    await waitFor(() => expect(document.querySelector('[data-action="approve"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="approve"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('govd.sod.approve.confirm') }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toBe(word('govd.sod.refusal.self')));
    expect(commandsCalled(h, 'approveSodException')).toHaveLength(1);
  });

  it('rejects and revokes only with a reason in words, and sends it', async () => {
    const h = open({ exceptions: [exception(1), exception(2, { status: 'APPROVED', approvals: 2 })] }, { command: () => ({ resource_id: uuid(1), resource_version: 3 }) });
    await tab('exceptions');
    await waitFor(() => expect(document.querySelector(`[data-exception="${uuid(1)}"] [data-action="reject"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-exception="${uuid(1)}"] [data-action="reject"]`) as HTMLElement);
    const confirm = (name: string): HTMLButtonElement => within(dialog()).getByRole('button', { name }) as HTMLButtonElement;
    expect(confirm(word('govd.sod.reject.confirm')).disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: 'ngắn' } });
    expect(confirm(word('govd.sod.reject.confirm')).disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: 'Lý do chưa đủ thuyết phục' } });
    fireEvent.click(confirm(word('govd.sod.reject.confirm')));
    await waitFor(() => expect(commandsCalled(h, 'rejectSodException')).toHaveLength(1));
    expect(commandsCalled(h, 'rejectSodException')[0]).toMatchObject({ path: { id: uuid(1) }, ifMatchVersion: 2, body: { reason: 'Lý do chưa đủ thuyết phục' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(document.querySelector(`[data-exception="${uuid(2)}"] [data-action="revoke"]`) as HTMLElement);
    expect(dialog().textContent).toContain(word('govd.sod.revoke.note'));
    fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: 'Người kiểm đã quay lại làm việc' } });
    fireEvent.click(confirm(word('govd.sod.revoke.confirm')));
    await waitFor(() => expect(commandsCalled(h, 'revokeSodException')).toHaveLength(1));
    expect(commandsCalled(h, 'revokeSodException')[0]).toMatchObject({ path: { id: uuid(2) }, body: { reason: 'Người kiểm đã quay lại làm việc' } });
  });

  it('asks for an exception: only the pairs that take one, the subject from the list of its kind, the person, the days and a reason; nothing is sent while the form is not right', async () => {
    const h = open({}, { command: () => ({ resource_id: uuid(50), resource_version: 1 }) });
    await screen.findByTestId('matrix');
    fireEvent.click(document.querySelector('[data-action="request"]') as HTMLElement);
    const pair = document.getElementById('sod-pair') as HTMLSelectElement;
    expect(Array.from(pair.options).map((option) => option.value)).toEqual(['', 'payment.request|payment.verify|SAME_RECORD', 'acceptance.approve|payment.verify|SAME_CONTRACT']);
    // Sent empty: every problem is said and nothing is sent.
    fireEvent.click(within(dialog()).getByRole('button', { name: word('govd.sod.request.submit') }));
    expect(within(dialog()).getByText(word('govd.sod.problem.pair'))).toBeTruthy();
    expect(within(dialog()).getByText(word('govd.sod.problem.member'))).toBeTruthy();
    expect(within(dialog()).getByText(word('govd.sod.problem.reason'))).toBeTruthy();
    expect(commandsCalled(h, 'requestSodException')).toHaveLength(0);
    fireEvent.change(pair, { target: { value: 'acceptance.approve|payment.verify|SAME_CONTRACT' } });
    await waitFor(() => expect(within(document.getElementById('sod-subject') as HTMLElement).getByRole('option', { name: 'HD-001 - Hợp đồng thi công' })).toBeTruthy());
    fireEvent.change(document.getElementById('sod-subject') as HTMLElement, { target: { value: uuid(901) } });
    await waitFor(() => expect(within(document.getElementById('sod-member') as HTMLElement).getByRole('option', { name: 'Trần Thị Nhận' })).toBeTruthy());
    fireEvent.change(document.getElementById('sod-member') as HTMLElement, { target: { value: uuid(601) } });
    fireEvent.change(document.getElementById('sod-to') as HTMLElement, { target: { value: today(30) } });
    fireEvent.change(document.getElementById('sod-reason') as HTMLElement, { target: { value: 'Kiểm soát viên duy nhất nghỉ phép tuần này' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('govd.sod.request.submit') }));
    expect(within(dialog()).getByText(word('govd.sod.problem.tooLong'))).toBeTruthy();
    expect(commandsCalled(h, 'requestSodException')).toHaveLength(0);
    fireEvent.change(document.getElementById('sod-to') as HTMLElement, { target: { value: today(6) } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('govd.sod.request.submit') }));
    await waitFor(() => expect(commandsCalled(h, 'requestSodException')).toHaveLength(1));
    expect(commandsCalled(h, 'requestSodException')[0]?.body).toEqual({
      action_a: 'acceptance.approve',
      action_b: 'payment.verify',
      scope: 'SAME_CONTRACT',
      subject_id: uuid(901),
      member_id: uuid(601),
      reason: 'Kiểm soát viên duy nhất nghỉ phép tuần này',
      valid_from: today(),
      valid_to: today(6),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the request with the pair of the row already chosen and says in words what the server refused', async () => {
    open({}, { command: () => refusal('SOD_EXCEPTION_WINDOW_INVALID', 422, 'valid_to') });
    await screen.findByTestId('matrix');
    fireEvent.click(document.querySelector('[data-pair="payment.request|payment.verify|SAME_RECORD"] [data-action="request-pair"]') as HTMLElement);
    expect((document.getElementById('sod-pair') as HTMLSelectElement).value).toBe('payment.request|payment.verify|SAME_RECORD');
    // A record has no list to choose from: its id is typed.
    fireEvent.change(document.getElementById('sod-subject') as HTMLElement, { target: { value: uuid(77) } });
    await waitFor(() => expect(within(document.getElementById('sod-member') as HTMLElement).getByRole('option', { name: 'Trần Thị Nhận' })).toBeTruthy());
    fireEvent.change(document.getElementById('sod-member') as HTMLElement, { target: { value: uuid(601) } });
    fireEvent.change(document.getElementById('sod-reason') as HTMLElement, { target: { value: 'Kiểm soát viên duy nhất nghỉ phép tuần này' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('govd.sod.request.submit') }));
    await waitFor(() => expect(within(dialog()).getByTestId('refusal').textContent).toBe(word('govd.sod.refusal.window')));
    expect(within(dialog()).getByText(word('govd.sod.problem.tooLong'))).toBeTruthy();
  });
});
