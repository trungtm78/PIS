import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import BoardScreen from './BoardScreen';
import { HANDLER, MATCHER, READER, client, commandsOf, item, itemId, mount, paymentId, routeOf, sentRequest, settledAnswer, transaction, transactionId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-05', 'FR-PAY-05');
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<BoardScreen route={ROUTE} />, h, { permissions: options.permissions ?? MATCHER, path: '/pay/pay-05', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-item="${id}"]`) as HTMLElement;
const dialog = (): HTMLElement => screen.getByRole('dialog');

describe('BoardScreen (PAY-05): matching and the differences', () => {
  it('UI-PAY-05: shows each difference with both figures, the signed difference, the file and its hash, the owner and the day it is due, and what the board counts', async () => {
    const overdue = item(2, { overdue: true, due_at: '2026-07-10T03:00:00.000000Z', difference_vnd: '10000000', confirmed_amount_vnd: '1010000000', status: 'EXPLAINED' });
    open(world({ items: [item(1), overdue], summary: { waiting: 2, overdue: 1, waiting_difference_vnd: '0' } }), { permissions: READER });
    await screen.findByTestId('items');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.recon.title']);
    expect(screen.getByText(text('pay.recon.footer', { id: 'PAY-05', req: 'FR-PAY-05' }))).toBeTruthy();
    const first = rowOf(itemId(1));
    expect(within(first).getByTestId('kind').textContent).toBe(vi_['pay.recon.kind.amountMismatch']);
    expect(within(first).getByTestId('internal').textContent).toBe('1.000.000.000');
    expect(within(first).getByTestId('confirmed').textContent).toBe('990.000.000');
    expect(within(first).getByTestId('difference').textContent).toBe('-10.000.000');
    expect(within(first).getByTestId('file').textContent).toBe('KB-A-2026-07-20.csv');
    expect(within(first).getByTestId('hash').textContent?.trim()).toBe('ab'.repeat(8));
    expect(within(first).getByTestId('owner').textContent).toBe('Kế toán trưởng');
    expect(within(first).getByTestId('status').textContent).toBe(vi_['pay.recon.status.open']);
    expect(within(first).getByTestId('voucher').textContent).toBe('CT-0201');
    expect(within(first).queryByTestId('overdue')).toBeNull();
    expect((within(first).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-06?item=${itemId(1)}`);
    expect(within(first).getByRole('link', { name: 'DNTT-001' }).getAttribute('href')).toBe(`/pay/pay-03?request=${paymentId(1)}`);
    const second = rowOf(itemId(2));
    expect(second.getAttribute('data-overdue')).toBe('yes');
    expect(within(second).getByTestId('overdue').textContent?.trim()).toBe(vi_['pay.recon.overdue']);
    expect(within(second).getByTestId('difference').textContent).toBe('+10.000.000');
    expect(within(second).getByTestId('status').textContent).toBe(vi_['pay.recon.status.explained']);
    expect(screen.getByTestId('waiting').textContent).toBe('2');
    expect(screen.getByTestId('overdue-count').textContent).toBe('1');
    expect(screen.getByTestId('difference-sum').textContent).toBe('0');
  });

  it('leaves out the cells an item does not have, and narrows the items by status', async () => {
    const bare = item(3, { payment_request_id: null, request_no: null, document_no: null, source_file_name: null, source_file_sha256: null, internal_amount_vnd: null, confirmed_amount_vnd: null, difference_vnd: null, owner_name: null });
    const h = open(world({ items: [bare, item(4, { status: 'RESOLVED' })] }), { permissions: READER });
    await screen.findByTestId('items');
    const row = rowOf(itemId(3));
    for (const cell of ['request', 'voucher', 'internal', 'confirmed', 'difference', 'file']) expect(within(row).getByTestId(cell).textContent).toBe('');
    expect(within(row).queryByTestId('hash')).toBeNull();
    expect(within(row).getByTestId('owner').textContent).toBe(item(3).owner_membership_id);
    fireEvent.change(screen.getByLabelText(vi_['pay.recon.filter.status']), { target: { value: 'RESOLVED' } });
    await waitFor(() => expect(rowOf(itemId(3))).toBeNull());
    expect(rowOf(itemId(4))).not.toBeNull();
    expect(h.read.mock.calls.some((call) => (call[1] as { query?: { status?: string } } | undefined)?.query?.status === 'RESOLVED')).toBe(true);
  });

  it('says so when no difference matches, and shows the state of a failed read', async () => {
    open(world({ items: [] }), { permissions: READER });
    expect((await screen.findByTestId('nothing')).textContent).toBe(vi_['pay.recon.items.empty']);
    cleanup();
    open(world({ failing: new Set(['listReconciliationItems']) }), { permissions: READER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });

  it('says so when the caller may not read the differences, and shows no list', async () => {
    open(world(), { permissions: ['treasury_transaction.read'] });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['pay.recon.read.denied']);
    expect(screen.queryByTestId('items')).toBeNull();
  });

  it('lists the transactions that wait to be matched and no other, with the button only for who may match', async () => {
    const state = world({ transactions: [transaction(1), transaction(2, { match_status: 'MATCHED' }), transaction(3, { direction: 'REFUND' }), transaction(4, { amount_vnd: '990000000', document_no: null })], requests: [sentRequest(1)] });
    open(state);
    await screen.findByTestId('pending');
    expect(document.querySelectorAll('tr[data-transaction]')).toHaveLength(2);
    const first = document.querySelector(`tr[data-transaction="${transactionId(1)}"]`) as HTMLElement;
    expect(within(first).getByTestId('voucher').textContent).toBe('CT-0001');
    expect(within(first).getByTestId('amount').textContent).toBe('2.100.000.000');
    expect(within(first).getByTestId('project').textContent).toBe('DA-A-001');
    expect(within(first).getByRole('button', { name: vi_['pay.recon.action.match'] })).toBeTruthy();
    expect((document.querySelector(`tr[data-transaction="${transactionId(4)}"]`) as HTMLElement).querySelector('[data-testid="voucher"]')?.textContent).toBe(transactionId(4));
    cleanup();
    open(state, { permissions: READER });
    await screen.findByTestId('pending');
    expect(document.querySelector('button[data-action="match"]')).toBeNull();
    cleanup();
    open(state, { mode: 'READ_ONLY' });
    await screen.findByTestId('pending');
    expect(document.querySelector('button[data-action="match"]')).toBeNull();
  });

  it('says so when nothing waits, and when the transactions cannot be read', async () => {
    open(world({ transactions: [transaction(2, { match_status: 'MATCHED' })] }));
    expect((await screen.findByTestId('nothing-pending')).textContent).toBe(vi_['pay.recon.pending.empty']);
    cleanup();
    open(world({ failing: new Set(['get_resources_treasury_transaction']) }));
    expect((await screen.findByTestId('transactions-failed')).textContent).toBe(vi_['pay.recon.pending.failed']);
  });

  it('does not offer the transactions to a caller who may not read them', async () => {
    open(world(), { permissions: HANDLER });
    await screen.findByTestId('items');
    expect(screen.queryByTestId('pending')).toBeNull();
    expect(screen.queryByTestId('nothing-pending')).toBeNull();
  });

  describe('matching a transaction', () => {
    const state = (): World => world({ transactions: [transaction(1)], requests: [sentRequest(1), sentRequest(2, { net_vnd: '990000000', request_no: 'DNTT-002' }), sentRequest(3, { project_id: '00000000-0000-4000-8000-0000000000ff' })] });
    const begin = async (h: ReturnType<typeof open>): Promise<void> => {
      await screen.findByTestId('pending');
      fireEvent.click(await screen.findByRole('button', { name: vi_['pay.recon.action.match'] }));
      expect(within(dialog()).getByTestId('match-amount').textContent).toBe(text('pay.recon.match.intro', { amount: '2.100.000.000' }));
      await waitFor(() => expect(h.client.readAll).toHaveBeenCalledWith('get_resources_payment_request', expect.anything()));
    };

    it('UAT-AC335: offers the requests that are with the Treasury in the project of the transaction, tells whether the amounts agree, and settles the request', async () => {
      const h = open(state(), { command: () => settledAnswer() });
      await begin(h);
      await waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(3));
      expect(within(dialog()).getAllByRole('option').map((option) => option.textContent)).toEqual([
        vi_['pay.recon.match.request.choose'],
        text('pay.recon.match.request.option', { no: 'DNTT-001', net: '2.100.000.000' }),
        text('pay.recon.match.request.option', { no: 'DNTT-002', net: '990.000.000' }),
      ]);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.recon.match.submit'] }));
      expect(await within(dialog()).findByText(vi_['pay.recon.problem.required'])).toBeTruthy();
      expect(commandsOf(h, 'matchTreasuryTransaction')).toEqual([]);
      fireEvent.change(document.getElementById('match-request') as HTMLSelectElement, { target: { value: paymentId(1) } });
      expect(within(dialog()).getByTestId('match-agree').getAttribute('data-agree')).toBe('yes');
      expect(within(dialog()).getByTestId('match-agree').textContent).toBe(vi_['pay.recon.match.agree']);
      fireEvent.change(document.getElementById('match-note') as HTMLTextAreaElement, { target: { value: 'Khớp sao kê 24/7' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.recon.match.submit'] }));
      await waitFor(() => expect(commandsOf(h, 'matchTreasuryTransaction')).toHaveLength(1));
      expect(commandsOf(h, 'matchTreasuryTransaction')[0]).toMatchObject({ path: { id: transactionId(1) }, body: { payment_request_id: paymentId(1), note: 'Khớp sao kê 24/7' } });
      expect((await screen.findByTestId('done')).textContent).toBe(text('pay.recon.done.settled', { day: '2026-07-25' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('UAT-AC12: when the amounts differ the server refuses, and the dialog shows both figures, the difference and the way to the item, and nothing is settled', async () => {
      const mismatch = refusal('AMOUNT_MISMATCH_OPENED', { reconciliation_item_id: itemId(9), internal_amount_vnd: '990000000', confirmed_amount_vnd: '2100000000', difference_vnd: '1110000000' });
      const h = open(state(), { command: () => mismatch });
      await begin(h);
      await waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(document.getElementById('match-request') as HTMLSelectElement, { target: { value: paymentId(2) } });
      expect(within(dialog()).getByTestId('match-agree').getAttribute('data-agree')).toBe('no');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.recon.match.submit'] }));
      const shown = await within(dialog()).findByTestId('mismatch');
      expect(shown.textContent).toContain(text('pay.recon.match.mismatch', { internal: '990.000.000', confirmed: '2.100.000.000', difference: '+1.110.000.000' }));
      expect((within(dialog()).getByTestId('mismatch-item') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-06?item=${itemId(9)}`);
      expect(within(dialog()).queryByTestId('refusal')).toBeNull();
      expect(screen.queryByTestId('done')).toBeNull();
    });

    it('words a mismatch whose figures it could not read', async () => {
      const h = open(state(), { command: () => refusal('AMOUNT_MISMATCH_OPENED', {}) });
      await begin(h);
      await waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(document.getElementById('match-request') as HTMLSelectElement, { target: { value: paymentId(2) } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.recon.match.submit'] }));
      expect((await within(dialog()).findByTestId('mismatch')).textContent).toBe(vi_['pay.recon.error.mismatch']);
    });

    it('words the other refusals in the dialog and keeps it open', async () => {
      const h = open(state(), { command: () => refusal('TRANSACTION_ALREADY_MATCHED', {}, 409) });
      await begin(h);
      await waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(document.getElementById('match-request') as HTMLSelectElement, { target: { value: paymentId(1) } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.recon.match.submit'] }));
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['pay.recon.error.alreadyMatched']);
    });

    it('says when no request of the project is with the Treasury, and closes without doing anything', async () => {
      const h = open(world({ transactions: [transaction(1)], requests: [] }));
      await screen.findByTestId('pending');
      fireEvent.click(await screen.findByRole('button', { name: vi_['pay.recon.action.match'] }));
      expect(within(dialog()).getByText(vi_['pay.recon.match.request.empty'])).toBeTruthy();
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.recon.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(commandsOf(h, 'matchTreasuryTransaction')).toEqual([]);
    });
  });
});
