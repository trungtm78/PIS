import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import AlertBoardScreen from './AlertBoardScreen';
import { ACCOUNTANT, EVIDENCE, READER, advance, advanceId, answer, client, commandsOf, contractId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-12', 'PAY', 'FR-PAY-12');
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const alerted = (n: number, level: number, overrides: Record<string, unknown> = {}) =>
  advance(n, { last_alert_level: level, overdue_since: level >= 3 ? '2026-08-01' : null, overdue_days: level >= 3 ? 10 : null, actions: { cancel: false, record_recovery: true, acknowledge_alert: level >= 3 }, ...overrides });

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<AlertBoardScreen route={ROUTE} />, h, { permissions: options.permissions ?? ACCOUNTANT, path: options.path ?? '/pay/pay-12', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-advance="${id}"]`) as HTMLElement;
const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (id: string): HTMLInputElement & HTMLSelectElement => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};

describe('AlertBoardScreen (PAY-12): overdue advances and recovery alerts', () => {
  it('UI-PAY-12: lists the advances under alert with what is owed, the deadline, the days late, the level and the plan, and leaves out those without an alert', async () => {
    open(
      world({
        advances: [
          alerted(1, 3),
          alerted(2, 1, { overdue_days: null, recovery_deadline: '2026-11-07', kind: 'CONTRACT' }),
          advance(3),
          alerted(4, 4, { acknowledgement: { note: 'Hoàn trả từ kỳ thanh toán tới', action_plan_due_on: '2999-01-31', acknowledged_by: advanceId(9), acknowledged_by_name: 'Trần Thị Kế Toán', acknowledged_at: '2026-10-30T01:00:00.000Z' } }),
          alerted(5, 3, { acknowledgement: { note: 'Đã gửi công văn', action_plan_due_on: '2999-02-28', acknowledged_by: advanceId(8), acknowledged_at: '2026-10-30T01:00:00.000Z' } }),
        ],
      }),
    );
    await screen.findByTestId('alerts');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.alert.title']);
    expect(screen.getByText(text('pay.alert.footer', { id: 'PAY-12', req: 'FR-PAY-12' }))).toBeTruthy();
    expect(document.querySelector(`tr[data-advance="${advanceId(3)}"]`)).toBeNull();
    const overdue = rowOf(advanceId(1));
    expect(within(overdue).getByTestId('schedule').textContent).toBe('HD-A-001');
    expect(within(overdue).getByTestId('member').textContent).toBe('Nhà thầu A');
    expect(within(overdue).getByTestId('outstanding').textContent).toBe('1.250.000.000');
    expect(within(overdue).getByTestId('deadline').textContent).toBe('2026-07-31');
    expect(within(overdue).getByTestId('overdue').textContent).toBe('10');
    expect(within(overdue).getByTestId('level').textContent).toBe(vi_['pay.alert.level.overdue']);
    expect(within(overdue).getByTestId('level').className).toContain('warning');
    expect(within(overdue).getByTestId('plan').textContent).toBe(vi_['pay.alert.noPlan']);
    // The person who answers for the advance (the catalogue field "Người xử lý"): nobody yet, the name of the one who gave the plan, or the words for a membership the directory no longer names.
    expect(screen.getByRole('columnheader', { name: text('pay.alert.column.handler') })).toBeTruthy();
    expect(within(overdue).getByTestId('handler').textContent).toBe(text('pay.alert.handler.none'));
    expect(within(rowOf(advanceId(4))).getByTestId('handler').textContent).toBe('Trần Thị Kế Toán');
    expect(within(rowOf(advanceId(5))).getByTestId('handler').textContent).toBe(text('pay.alert.handler.unnamed'));
    // The wide table scrolls inside its own named region, never the page.
    expect(screen.getByRole('region', { name: text('pay.alert.table.label') }).contains(screen.getByTestId('alerts'))).toBe(true);
    const warning = rowOf(advanceId(2));
    expect(within(warning).getByTestId('level').textContent).toBe(vi_['pay.alert.level.warning']);
    expect(within(warning).getByTestId('level').className).not.toContain('warning');
    expect(within(warning).getByTestId('overdue').textContent).toBe('');
    expect(within(warning).queryByRole('button', { name: vi_['pay.alert.action.acknowledge'] })).toBeNull();
    const escalated = rowOf(advanceId(4));
    expect(within(escalated).getByTestId('level').textContent).toBe(vi_['pay.alert.level.escalated']);
    expect(within(escalated).getByTestId('plan').textContent).toContain(text('pay.alert.plan', { day: '2999-01-31' }));
    expect(within(escalated).getByTestId('plan-note').textContent).toContain('Hoàn trả từ kỳ thanh toán tới');
  });

  it('narrows the board to one level and says in words that nothing is under alert', async () => {
    open(world({ advances: [alerted(1, 3), alerted(2, 4)] }));
    await screen.findByTestId('alerts');
    fireEvent.change(screen.getByTestId('filter-level'), { target: { value: '4' } });
    await waitFor(() => expect(rowOf(advanceId(2))).toBeTruthy());
    expect(document.querySelector(`tr[data-advance="${advanceId(1)}"]`)).toBeNull();
    fireEvent.change(screen.getByTestId('filter-level'), { target: { value: '2' } });
    expect((await screen.findByTestId('no-alerts')).textContent).toBe(vi_['pay.alert.empty']);
    fireEvent.change(screen.getByTestId('filter-level'), { target: { value: '' } });
    expect(await screen.findByTestId('alerts')).toBeTruthy();
  });

  it('reads the level from the address, and ignores one that is not a level', async () => {
    open(world({ advances: [alerted(1, 3), alerted(2, 4)] }), { path: '/pay/pay-12?level=3' });
    await screen.findByTestId('alerts');
    expect(rowOf(advanceId(1))).toBeTruthy();
    expect(document.querySelector(`tr[data-advance="${advanceId(2)}"]`)).toBeNull();
    cleanup();
    open(world({ advances: [alerted(1, 3), alerted(2, 4)] }), { path: '/pay/pay-12?level=9' });
    await screen.findByTestId('alerts');
    expect(rowOf(advanceId(2))).toBeTruthy();
  });

  it('gives a reader the board and no button, and takes no command in the read-only mode', async () => {
    open(world({ advances: [alerted(1, 3, { actions: { cancel: false, record_recovery: false, acknowledge_alert: false } })] }), { permissions: READER });
    await screen.findByTestId('alerts');
    expect(screen.queryByRole('button', { name: vi_['pay.alert.action.acknowledge'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['pay.advance.action.recover'] })).toBeNull();
    cleanup();
    // The server answers for the membership; the session of a person who holds only the right to read offers no button whatever the server says of the row.
    open(world({ advances: [alerted(1, 3)] }), { permissions: READER });
    await screen.findByTestId('alerts');
    expect(screen.queryByRole('button', { name: vi_['pay.alert.action.acknowledge'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['pay.advance.action.recover'] })).toBeNull();
    cleanup();
    open(world({ advances: [alerted(1, 3)] }), { permissions: ['advance.read', 'advance.alert.ack'] });
    await screen.findByTestId('alerts');
    expect(screen.getByRole('button', { name: vi_['pay.alert.action.acknowledge'] })).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['pay.advance.action.recover'] })).toBeNull();
    cleanup();
    open(world({ advances: [alerted(1, 3)] }), { mode: 'READ_ONLY' });
    await screen.findByTestId('alerts');
    expect(screen.queryByRole('button', { name: vi_['pay.alert.action.acknowledge'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['pay.advance.action.recover'] })).toBeNull();
  });

  it('AC-ST-PAY-011-2: records the plan with its note and its day at the version shown, and says that the advance is still owed', async () => {
    const h = open(world({ advances: [alerted(1, 3)] }), { command: () => answer(1) });
    await screen.findByTestId('alerts');
    fireEvent.click(within(rowOf(advanceId(1))).getByRole('button', { name: vi_['pay.alert.action.acknowledge'] }));
    expect(within(dialog()).getByTestId('owed').textContent).toContain('1.250.000.000');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.alert.ack.submit'] }));
    expect(await within(dialog()).findAllByRole('alert')).toHaveLength(2);
    expect(h.command).not.toHaveBeenCalled();
    type('ack-note', '  Nhà thầu hoàn trả từ kỳ tới  ');
    type('ack-due', '2020-01-01');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.alert.ack.submit'] }));
    expect(await within(dialog()).findByText(vi_['pay.payment.problem.date'])).toBeTruthy();
    type('ack-due', '2999-01-31');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.alert.ack.submit'] }));
    await waitFor(() => expect(commandsOf(h, 'acknowledgeAdvanceAlert')).toHaveLength(1));
    expect(commandsOf(h, 'acknowledgeAdvanceAlert')[0]).toMatchObject({ path: { id: advanceId(1) }, ifMatchVersion: 4, body: { note: 'Nhà thầu hoàn trả từ kỳ tới', action_plan_due_on: '2999-01-31' } });
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.alert.done.acknowledged']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the plan again with what was written and says in words why the server refused it', async () => {
    const plan = { note: 'Kế hoạch cũ', action_plan_due_on: '2999-01-31', acknowledged_by: advanceId(9), acknowledged_at: '2026-10-30T01:00:00.000Z' };
    open(world({ advances: [alerted(1, 3, { acknowledgement: plan })] }), { command: () => refusal('ADVANCE_NOT_OVERDUE') });
    await screen.findByTestId('alerts');
    fireEvent.click(within(rowOf(advanceId(1))).getByRole('button', { name: vi_['pay.alert.action.acknowledge'] }));
    expect(field('ack-note').value).toBe('Kế hoạch cũ');
    expect(field('ack-due').value).toBe('2999-01-31');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.alert.ack.submit'] }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.advance.error.notOverdue']);
  });

  it('records a recovery from the board with its basis and evidence, as PAY-07 does', async () => {
    const h = open(world({ advances: [alerted(1, 3)] }), { command: () => answer(1) });
    await screen.findByTestId('alerts');
    fireEvent.click(within(rowOf(advanceId(1))).getByRole('button', { name: vi_['pay.advance.action.recover'] }));
    type('recovery-amount', '400000000');
    type('recovery-basis', 'REFUND');
    type('recovery-evidence', EVIDENCE);
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.advance.recovery.submit'] }));
    await waitFor(() => expect(commandsOf(h, 'recordAdvanceRecovery')).toHaveLength(1));
    expect(commandsOf(h, 'recordAdvanceRecovery')[0]).toMatchObject({ path: { id: advanceId(1) }, ifMatchVersion: 4, body: { amount_vnd: '400000000', basis: 'REFUND' } });
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.advance.done.recovered']);
  });

  it('closes the dialog of an advance that left the board, and offers a retry when the board could not be read', async () => {
    const state = world({ advances: [alerted(1, 3)] });
    open(state);
    await screen.findByTestId('alerts');
    fireEvent.click(within(rowOf(advanceId(1))).getByRole('button', { name: vi_['pay.alert.action.acknowledge'] }));
    expect(dialog()).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.advance.dialog.cancel'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    const h = open(world({ failing: new Set(['listOverdueAdvances']) }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'listOverdueAdvances').length).toBeGreaterThanOrEqual(2));
    expect(contractId(1)).toBeTruthy();
  });
});
