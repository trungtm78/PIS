import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { entry, entryId, ledgerId, line, page } from '../ledger/test-support';
import { PROJECT, mount, paymentId, payment, routeOf as baseRoute } from '../payment/test-support';
import { transaction, transactionId } from '../recon/test-support';

export { PROJECT, entryId, ledgerId, mount, paymentId, transactionId };
export type { Harness };

export const REVERSER = ['payment_request.read', 'payment.reverse', 'ledger.read', 'treasury_transaction.read', 'contract.read'];
export const READER = ['payment_request.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const documentId = (n: number): string => uuid('0e40', n);

export const routeOf = (id: string, req: string) => baseRoute(id, 'PAY', req);

/** A request that was settled by the transaction of the example: 2.1bn paid on 25 July. */
export const settled = (overrides: Record<string, unknown> = {}) => payment(1, { status: 'SETTLED', treasury_paid_on: '2026-07-25', settled_transaction_id: transactionId(1), version: 9, ...overrides });

/** A refund the Treasury confirmed for that payment, not yet used. */
export const refund = (n: number, overrides: Record<string, unknown> = {}) =>
  transaction(n + 10, { direction: 'REFUND', document_no: `CT-090${n}`, reversal_of_id: transactionId(1), confirmed_at: '2026-07-30T03:00:00.000Z', ...overrides });

const own = { payment_request_id: paymentId(1) };

/**
 * The ledger of the example (B01 2bn and B02 1bn): for each balance the claim, the payment and, when `undone`, the entries that undo them. B01 also holds a recovery of 500m and a hold of 100m.
 */
export function ledgerLines(undone: boolean): Array<Record<string, unknown>> {
  const claim = entry(1, { kind: 'CLAIM', accepted_delta_vnd: '0', requested_delta_vnd: '2000000000', posted_at: '2026-07-20T03:00:00.000Z', ...own });
  const recovery = entry(2, { kind: 'ADVANCE_RECOVERY', accepted_delta_vnd: '0', advance_recovery_delta_vnd: '500000000', posted_at: '2026-07-20T03:00:01.000Z', ...own });
  const hold = entry(3, { kind: 'RETENTION_HOLD', accepted_delta_vnd: '0', retention_delta_vnd: '100000000', posted_at: '2026-07-20T03:00:02.000Z', ...own });
  const payment_ = entry(4, { kind: 'PAYMENT', accepted_delta_vnd: '0', paid_delta_vnd: '2000000000', posted_at: '2026-07-25T03:00:00.000Z', ...own });
  const undo = [
    entry(5, { kind: 'PAYMENT_REVERSAL', accepted_delta_vnd: '0', paid_delta_vnd: '-2000000000', reversal_of_id: entryId(4), posted_at: '2026-07-31T03:00:00.000Z', ...own }),
    entry(6, { kind: 'ADVANCE_RECOVERY_REVERSAL', accepted_delta_vnd: '0', advance_recovery_delta_vnd: '-500000000', reversal_of_id: entryId(2), posted_at: '2026-07-31T03:00:01.000Z', ...own }),
    entry(7, { kind: 'RETENTION_RELEASE', accepted_delta_vnd: '0', retention_delta_vnd: '-100000000', posted_at: '2026-07-31T03:00:02.000Z', ...own }),
    entry(8, { kind: 'CLAIM_RELEASE', accepted_delta_vnd: '0', requested_delta_vnd: '-2000000000', reversal_of_id: entryId(1), posted_at: '2026-07-31T03:00:03.000Z', ...own }),
  ];
  const other = entry(9, { kind: 'CLAIM', accepted_delta_vnd: '0', requested_delta_vnd: '5', payment_request_id: paymentId(2), posted_at: '2026-07-21T03:00:00.000Z' });
  return [line(1, { entries: [entry(10), claim, recovery, hold, payment_, other, ...(undone ? undo : [])] }), line(2, { entries: [entry(11)] })];
}

export const answer = (overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('0e50', 1),
  status: 'REVERSED',
  resource_version: 10,
  resource_id: paymentId(1),
  refund_transaction_id: transactionId(11),
  treasury_paid_on: '2026-07-25',
  payment_entries: 2,
  ...overrides,
});

export interface World {
  payments: Array<Record<string, unknown>>;
  lines: Array<Record<string, unknown>>;
  transactions: Array<Record<string, unknown>>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { payments: [settled()], lines: ledgerLines(false), transactions: [refund(1)], failing: new Set(), ...overrides };
}

/** A client over `state`: the request, its ledger and the transactions are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => answer()): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
    if (operation === 'get_resources_payment_request_id') return state.payments.find((item) => item.id === id) ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} });
    if (operation === 'getCumulativeLedger') return page(state.lines);
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    return operation === 'get_resources_treasury_transaction' ? Promise.resolve(state.transactions) : Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
