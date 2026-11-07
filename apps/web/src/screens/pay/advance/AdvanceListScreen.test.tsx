import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import AdvanceListScreen from './AdvanceListScreen';
import { ACCOUNTANT, EVIDENCE, READER, advance, advanceId, answer, client, commandsOf, contractId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-07', 'PAY', 'FR-PAY-07');
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<AdvanceListScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: options.path ?? '/pay/pay-07', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const rowOf = (id: string): HTMLElement => (document.querySelector(`[data-advance="${id}"]`)?.closest('tr') ?? null) as HTMLElement;
const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (id: string): HTMLInputElement & HTMLSelectElement => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};

describe('AdvanceListScreen (PAY-07): advances and recovery', () => {
  it('UI-PAY-07: lists each advance with what was paid, recovered and is owed, the deadline, the threshold and the days late', async () => {
    open(world());
    await screen.findByTestId('advances');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.advance.list.title']);
    expect(screen.getByText(text('pay.advance.list.footer', { id: 'PAY-07', req: 'FR-PAY-07' }))).toBeTruthy();
    const first = rowOf(advanceId(1));
    expect(within(first).getByTestId('schedule').textContent).toBe('HD-A-001');
    expect((within(first).getByTestId('schedule') as HTMLAnchorElement).getAttribute('href')).toBe(`/ctr/ctr-06?contract=${contractId(1)}&advance=${advanceId(1)}`);
    expect(within(first).getByTestId('tranche').textContent).toBe(text('pay.advance.tranche', { no: 1, kind: vi_['pay.advance.kind.gpmb'] }));
    expect(within(first).getByTestId('member').textContent).toBe('Nhà thầu A');
    expect(within(first).getByTestId('status').textContent).toBe(vi_['pay.advance.status.recovering']);
    expect(within(first).getByTestId('status').querySelector('.ui-tone-warning')).not.toBeNull();
    expect(within(first).getByTestId('paid').textContent).toBe('2.000.000.000');
    expect(within(first).getByTestId('recovered').textContent).toBe('750.000.000');
    expect(within(first).getByTestId('outstanding').textContent).toBe('1.250.000.000');
    expect(within(first).getByTestId('deadline').textContent).toBe('2026-07-31');
    expect(within(first).getByTestId('threshold').textContent).toBe(text('pay.advance.threshold', { pct: '80' }));
    expect(within(first).getByTestId('overdue').textContent).toBe('12');
    const planned = rowOf(advanceId(2));
    expect(within(planned).getByTestId('status').querySelector('.ui-tone-warning')).toBeNull();
    expect(within(planned).getByTestId('overdue').textContent).toBe('');
    expect(within(planned).getByTestId('deadline').textContent).toBe('');
  });

  it('puts an advance with no name for its member under the role, and shows a cancelled one as a warning', async () => {
    open(world({ advances: [advance(1, { status: 'CANCELLED', overdue_days: null, party: { id: advanceId(9), role: 'SOLE', name: null, work_value_vnd: '1' } })] }));
    await screen.findByTestId('advances');
    const row = rowOf(advanceId(1));
    expect(within(row).getByTestId('member').textContent).toBe('SOLE');
    expect(within(row).getByTestId('status').querySelector('.ui-tone-warning')).not.toBeNull();
  });

  it('narrows the list by contract and by status', async () => {
    const h = open(world(), { path: `/pay/pay-07?contract=${contractId(1)}&status=PLANNED` });
    await screen.findByTestId('advances');
    expect(h.client.readAll).toHaveBeenCalledWith('listAdvances', { query: { contract_id: contractId(1), status: 'PLANNED' } });
    expect(rowOf(advanceId(2))).not.toBeNull();
    expect(rowOf(advanceId(1))).toBeNull();
    const contract = screen.getByTestId('filter-contract') as HTMLSelectElement;
    await waitFor(() => expect(contract.options.length).toBeGreaterThan(1));
    fireEvent.change(contract, { target: { value: '' } });
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'PAID' } });
    await waitFor(() => expect(screen.getByTestId('no-advances').textContent).toBe(vi_['pay.advance.list.empty']));
  });

  it('shows no button to a reader, none in a read-only session, and those the server allows to the others', async () => {
    open(world({ advances: [advance(1, { actions: { cancel: false, record_recovery: false } })] }));
    await screen.findByTestId('advances');
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
    cleanup();
    open(world(), { permissions: ACCOUNTANT, mode: 'READ_ONLY' });
    await screen.findByTestId('advances');
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
    cleanup();
    open(world(), { permissions: ACCOUNTANT });
    await screen.findByTestId('advances');
    expect(within(rowOf(advanceId(1))).getByRole('button', { name: vi_['pay.advance.action.recover'] })).toBeTruthy();
    expect(within(rowOf(advanceId(1))).queryByRole('button', { name: vi_['pay.advance.action.cancel'] })).toBeNull();
    expect(within(rowOf(advanceId(2))).getByRole('button', { name: vi_['pay.advance.action.cancel'] })).toBeTruthy();
  });

  it('AC-ST-PAY-004-4: records a recovery with its basis and evidence, says how much is owed, and says it was recorded', async () => {
    const h = open(world(), { permissions: ACCOUNTANT, command: () => answer(1) });
    await screen.findByTestId('advances');
    fireEvent.click(within(rowOf(advanceId(1))).getByRole('button', { name: vi_['pay.advance.action.recover'] }));
    expect(within(dialog()).getByTestId('owed').textContent).toBe(text('pay.advance.recovery.owed', { amount: '1.250.000.000' }));
    press(vi_['pay.advance.recovery.submit']);
    expect((await within(dialog()).findAllByText(vi_['pay.payment.problem.required'])).length).toBe(3);
    expect(commandsOf(h, 'recordAdvanceRecovery')).toEqual([]);
    type('recovery-amount', '1250000000');
    type('recovery-basis', 'COMPENSATION_PAYMENT');
    type('recovery-evidence', EVIDENCE);
    press(vi_['pay.advance.recovery.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'recordAdvanceRecovery')[0]).toMatchObject({ path: { id: advanceId(1) }, ifMatchVersion: 4, body: { amount_vnd: '1250000000', basis: 'COMPENSATION_PAYMENT', evidence_document_version_id: EVIDENCE } });
    expect(screen.getByTestId('done').textContent).toBe(vi_['pay.advance.done.recovered']);
  });

  it('AC-ST-PAY-004-4: puts the refusal of a recovery into words, and a source that is not an identifier', async () => {
    open(world(), { permissions: ACCOUNTANT, command: () => refusal('ADVANCE_RECOVERY_EXCEEDED') });
    await screen.findByTestId('advances');
    fireEvent.click(within(rowOf(advanceId(1))).getByRole('button', { name: vi_['pay.advance.action.recover'] }));
    type('recovery-amount', '9999999999');
    type('recovery-basis', 'REFUND');
    type('recovery-source', 'not-an-id');
    type('recovery-evidence', EVIDENCE);
    press(vi_['pay.advance.recovery.submit']);
    expect(await within(dialog()).findByText(vi_['pay.payment.problem.uuid'])).toBeTruthy();
    type('recovery-source', '');
    press(vi_['pay.advance.recovery.submit']);
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.advance.error.recoveryExceeded']);
    press(vi_['pay.advance.dialog.cancel']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels an advance with a reason, which it asks for in words, and says it was cancelled', async () => {
    const h = open(world(), { permissions: ACCOUNTANT, command: () => answer(2, { status: 'CANCELLED' }) });
    await screen.findByTestId('advances');
    fireEvent.click(within(rowOf(advanceId(2))).getByRole('button', { name: vi_['pay.advance.action.cancel'] }));
    press(vi_['pay.advance.cancel.submit']);
    expect(await within(dialog()).findByText(vi_['pay.payment.problem.required'])).toBeTruthy();
    expect(commandsOf(h, 'cancelAdvance')).toEqual([]);
    type('cancel-reason', 'The advance is not needed.');
    press(vi_['pay.advance.cancel.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'cancelAdvance')[0]).toMatchObject({ path: { id: advanceId(2) }, ifMatchVersion: 4, body: { reason: 'The advance is not needed.' } });
    expect(screen.getByTestId('done').textContent).toBe(vi_['pay.advance.done.cancelled']);
  });

  it('puts the refusal of a cancellation into words', async () => {
    open(world(), { permissions: ACCOUNTANT, command: () => refusal('ADVANCE_STATE_INVALID', 409) });
    await screen.findByTestId('advances');
    fireEvent.click(within(rowOf(advanceId(2))).getByRole('button', { name: vi_['pay.advance.action.cancel'] }));
    type('cancel-reason', 'The advance is not needed.');
    press(vi_['pay.advance.cancel.submit']);
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.advance.error.stateInvalid']);
  });

  it('shows the states of an empty list, of a refusal and of a failed read, and never half a list', async () => {
    open(world({ advances: [] }));
    expect((await screen.findByTestId('no-advances')).textContent).toBe(vi_['pay.advance.list.empty']);
    cleanup();
    open(world({ failing: new Set(['listAdvances']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
