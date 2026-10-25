import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ReversalScreen from './ReversalScreen';
import { READER, REVERSER, answer, client, commandsOf, documentId, ledgerLines, mount, paymentId, refund, routeOf, settled, transactionId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-08', 'FR-PAY-08');
const PATH = `/pay/pay-08?request=${paymentId(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<ReversalScreen route={ROUTE} />, h, { permissions: options.permissions ?? REVERSER, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const rowOf = (n: number): HTMLElement => document.querySelector(`tr[data-entry="00000000-0000-4000-8000-0070${String(n).padStart(8, '0')}"]`) as HTMLElement;

describe('ReversalScreen (PAY-08): reversing a payment that was settled', () => {
  it('asks for a request when the address names none', async () => {
    open(world(), { path: '/pay/pay-08' });
    expect((await screen.findByTestId('no-request')).textContent).toBe(vi_['pay.reversal.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.reversal.title']);
    expect(screen.getByText(text('pay.reversal.footer', { id: 'PAY-08', req: 'FR-PAY-08' }))).toBeTruthy();
    expect((screen.getByRole('link', { name: new RegExp(vi_['pay.reversal.back']) }) as HTMLAnchorElement).getAttribute('href')).toBe('/pay/pay-05');
  });

  it('UI-PAY-08: shows the payment and the entries it put on the ledger, each beside the entry that will undo it', async () => {
    open(world());
    await screen.findByTestId('entries');
    expect(screen.getByTestId('request-no').textContent).toBe('DNTT-001');
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.payment.status.settled']);
    expect(screen.getByTestId('gross').textContent).toBe('3.000.000.000');
    expect(screen.getByTestId('net').textContent).toBe('2.100.000.000');
    expect(screen.getByTestId('paid-on').textContent).toBe('2026-07-25');
    expect((screen.getByTestId('contract') as HTMLAnchorElement).getAttribute('href')).toContain('/pay/pay-10');
    expect(within(screen.getByTestId('entries')).getAllByRole('row')).toHaveLength(5);
    const payment = rowOf(4);
    expect(within(payment).getByTestId('item').textContent).toBe('B01');
    expect(within(payment).getByTestId('original-kind').textContent).toBe(vi_['pay.ledger.entry.kind.payment']);
    expect(within(payment).getByTestId('original-amount').textContent).toBe('+2.000.000.000');
    expect(payment.getAttribute('data-undone')).toBe('no');
    expect(within(payment).getByTestId('reversal-kind').textContent).toBe('');
    expect(screen.queryByTestId('reversed-at')).toBeNull();
    expect(screen.queryByTestId('not-settled')).toBeNull();
  });

  it('shows the entries that undo them once the payment is reversed, and no command', async () => {
    const reversed = settled({ status: 'REVERSED', reversed_at: '2026-07-31T03:00:00.000Z', refund_transaction_id: transactionId(11) });
    open(world({ payments: [reversed], lines: ledgerLines(true) }));
    await screen.findByTestId('entries');
    expect(screen.getByTestId('status').textContent).toBe(vi_['pay.payment.status.reversed']);
    expect(screen.getByTestId('reversed-at').textContent).not.toBe('');
    for (const [original, kind, amount] of [
      [4, 'paymentReversal', '-2.000.000.000'],
      [2, 'advanceRecoveryReversal', '-500.000.000'],
      [1, 'claimRelease', '-2.000.000.000'],
      [3, 'retentionRelease', '-100.000.000'],
    ] as const) {
      const row = rowOf(original);
      expect(row.getAttribute('data-undone')).toBe('yes');
      expect(within(row).getByTestId('reversal-kind').textContent).toBe(vi_[`pay.ledger.entry.kind.${kind}` as keyof typeof vi_]);
      expect(within(row).getByTestId('reversal-amount').textContent).toBe(amount);
    }
    expect(document.querySelector('button[data-action="reverse"]')).toBeNull();
    expect(screen.queryByTestId('not-settled')).toBeNull();
  });

  it('says that only a settled payment can be reversed', async () => {
    open(world({ payments: [settled({ status: 'SENT_TREASURY', treasury_paid_on: null, settled_transaction_id: null })] }));
    expect((await screen.findByTestId('not-settled')).textContent).toBe(vi_['pay.reversal.notSettled']);
    expect(document.querySelector('button[data-action="reverse"]')).toBeNull();
    expect(screen.queryByTestId('paid-on')).toBeNull();
  });

  it('says so when the request is not there, when the read fails, and when the ledger cannot be read or may not be', async () => {
    open(world({ payments: [] }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    open(world({ failing: new Set(['get_resources_payment_request_id']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(world({ failing: new Set(['getCumulativeLedger']) }));
    expect((await screen.findByTestId('ledger-failed')).textContent).toBe(vi_['pay.reversal.entries.failed']);
    cleanup();
    open(world(), { permissions: READER });
    expect((await screen.findByTestId('no-ledger')).textContent).toBe(vi_['pay.reversal.entries.denied']);
    cleanup();
    open(world({ lines: [] }));
    expect((await screen.findByTestId('no-entries')).textContent).toBe(vi_['pay.reversal.entries.empty']);
  });

  it('offers the command only to who holds the permission, in a session that is not read-only', async () => {
    open(world(), { permissions: READER });
    await screen.findByTestId('status');
    expect(document.querySelector('button[data-action="reverse"]')).toBeNull();
    cleanup();
    open(world(), { mode: 'READ_ONLY' });
    await screen.findByTestId('status');
    expect(document.querySelector('button[data-action="reverse"]')).toBeNull();
  });

  describe('the reversal (AC-ST-PAY-008-1, UAT-AC331)', () => {
    const begin = async (h: ReturnType<typeof open>): Promise<void> => {
      fireEvent.click(await screen.findByRole('button', { name: vi_['pay.reversal.action.reverse'] }));
      await waitFor(() => expect(h.client.readAll).toHaveBeenCalledWith('get_resources_treasury_transaction'));
    };

    it('offers only the refunds of this very payment, asks for all three things and sends them', async () => {
      const state = world({ transactions: [refund(1), refund(2, { reversal_of_id: transactionId(7) }), refund(3, { match_status: 'MATCHED' })] });
      const h = open(state, { command: () => answer() });
      await begin(h);
      await waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(2));
      expect(within(dialog()).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['pay.reversal.field.refund.choose'], text('pay.reversal.field.refund.option', { voucher: 'CT-0901', amount: '2.100.000.000', day: new Intl.DateTimeFormat('vi', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date('2026-07-30T03:00:00.000Z')) })]);
      expect(within(dialog()).getByText(text('pay.reversal.dialog.intro', { amount: '2.100.000.000' }))).toBeTruthy();
      press(vi_['pay.reversal.dialog.submit']);
      expect(await within(dialog()).findAllByText(vi_['pay.reversal.problem.required'])).toHaveLength(3);
      expect(commandsOf(h, 'reversePayment')).toEqual([]);
      type('reverse-refund', transactionId(11));
      type('reverse-reason', 'Kho bạc hoàn trả do sai số tài khoản thụ hưởng');
      type('reverse-approval', documentId(1));
      press(vi_['pay.reversal.dialog.submit']);
      await waitFor(() => expect(commandsOf(h, 'reversePayment')).toHaveLength(1));
      expect(commandsOf(h, 'reversePayment')[0]).toMatchObject({
        path: { id: paymentId(1) },
        ifMatchVersion: 9,
        body: { reason: 'Kho bạc hoàn trả do sai số tài khoản thụ hưởng', approval_document_version_id: documentId(1), refund_treasury_transaction_id: transactionId(11) },
      });
      expect((await screen.findByTestId('done')).textContent).toBe(text('pay.reversal.done.reversed', { entries: 2 }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('says when the Treasury has confirmed no refund of this payment', async () => {
      const h = open(world({ transactions: [] }));
      await begin(h);
      expect(within(dialog()).getByText(vi_['pay.reversal.field.refund.empty'])).toBeTruthy();
    });

    it.each([
      ['REFUND_NOT_CONFIRMED', { reason: 'AMOUNT' }, 'pay.reversal.error.refundAmount', 422],
      ['REFUND_NOT_CONFIRMED', { reason: 'ALREADY_USED' }, 'pay.reversal.error.refundUsed', 422],
      ['APPROVAL_REQUIRED', {}, 'pay.reversal.error.approvalRequired', 422],
      ['SELF_APPROVAL_DENIED', {}, 'pay.reversal.error.selfApproval', 403],
      ['PAYMENT_STATE_INVALID', { reason: 'RETENTION_RELEASED' }, 'pay.reversal.error.retentionReleased', 409],
      ['VERSION_CONFLICT', {}, 'pay.reversal.error.versionConflict', 409],
    ])('words the refusal %s %j in the dialog and keeps it open', async (code, extensions, key, status) => {
      const h = open(world(), { command: () => refusal(code, extensions, status) });
      await begin(h);
      await waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(2));
      type('reverse-refund', transactionId(11));
      type('reverse-reason', 'Hoàn trả');
      type('reverse-approval', documentId(1));
      press(vi_['pay.reversal.dialog.submit']);
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
      expect(screen.queryByTestId('done')).toBeNull();
    });

    it('closes without doing anything, and does without a reading of the answer', async () => {
      const h = open(world(), { command: () => ({}) });
      await begin(h);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.reversal.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await begin(h);
      await waitFor(() => expect(within(dialog()).getAllByRole('option')).toHaveLength(2));
      type('reverse-refund', transactionId(11));
      type('reverse-reason', 'Hoàn trả');
      type('reverse-approval', documentId(1));
      press(vi_['pay.reversal.dialog.submit']);
      expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.reversal.done.plain']);
    });
  });
});
