import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, mount, paymentId, payment, routeOf as baseRoute } from '../payment/test-support';

export { PROJECT, mount, paymentId };
export type { Harness };

export const MATCHER = ['reconciliation.read', 'treasury_transaction.read', 'treasury.match', 'payment_request.read'];
export const HANDLER = ['reconciliation.read', 'reconciliation.assign', 'reconciliation.resolve', 'membership.read'];
export const READER = ['reconciliation.read', 'treasury_transaction.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const itemId = (n: number): string => uuid('0d10', n);
export const transactionId = (n: number): string => uuid('0d20', n);
export const memberId = (n: number): string => uuid('0d30', n);
export const documentId = (n: number): string => uuid('0d40', n);

export const routeOf = (id: string, req: string) => baseRoute(id, 'PAY', req);

/** An item of difference as the read answers it: UAT-AC12 (ours 1bn, the Treasury 990m, the difference −10m), open, with an owner and a day. */
export const item = (n: number, overrides: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) => ({
  id: itemId(n),
  kind: 'AMOUNT_MISMATCH',
  status: 'OPEN',
  project_id: PROJECT,
  project_code: 'DA-A-001',
  contract_id: null,
  contract_code: null,
  payment_request_id: paymentId(1),
  request_no: 'DNTT-001',
  treasury_transaction_id: transactionId(n),
  document_no: `CT-020${n}`,
  source_file_name: 'KB-A-2026-07-20.csv',
  source_file_sha256: 'ab'.repeat(32),
  internal_amount_vnd: '1000000000',
  confirmed_amount_vnd: '990000000',
  difference_vnd: '-10000000',
  owner_membership_id: memberId(1),
  owner_name: 'Kế toán trưởng',
  due_at: '2026-12-31T10:00:00.000000Z',
  overdue: false,
  resolution_note: null,
  resolved_by: null,
  resolved_at: null,
  approval_document_version_id: null,
  issue_id: null,
  version: 1,
  actions: { assign: true, explain: true, resolve: false, write_off: true, ...actions },
  ...overrides,
});

/** A Treasury transaction as the read model shows it, not yet matched. */
export const transaction = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: transactionId(n),
  project_id: PROJECT,
  project_code: 'DA-A-001',
  provider: 'KBNN_FILE',
  source_kind: 'FILE_IMPORT',
  direction: 'PAYMENT',
  document_no: `CT-000${n}`,
  document_date: '2026-07-24',
  amount_vnd: '2100000000',
  confirmed_at: '2026-07-24T18:30:00.000Z',
  match_status: 'UNMATCHED',
  payment_request_id: null,
  import_id: null,
  plan_year: null,
  ...overrides,
});

export const sentRequest = (n: number, overrides: Record<string, unknown> = {}) => payment(n, { status: 'SENT_TREASURY', ...overrides });

export const tracking = (n: number, overrides: Record<string, unknown> = {}) => ({
  project_id: n === 1 ? PROJECT : uuid('0d50', n),
  project_code: `DA-A-00${n}`,
  project_name: `Dự án ${n}`,
  sent: { count: 2, amount_vnd: '4200000000' },
  settled: { count: 1, amount_vnd: '2100000000' },
  confirmed: { count: 3, amount_vnd: '5190000000' },
  unmatched: 1,
  differences: { count: 1, amount_vnd: '-10000000' },
  last_confirmed_at: '2026-07-24T18:30:00.000000Z',
  last_import_at: '2026-07-25T01:00:00.000000Z',
  ...overrides,
});

export const member = (n: number, name: string, overrides: Record<string, unknown> = {}) => ({ id: memberId(n), display_name: name, status: 'Active', membership_type: 'STAFF', ...overrides });

export const answer = (overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('0d60', 1),
  status: 'EXPLAINED',
  resource_version: 2,
  resource_id: itemId(1),
  owner_membership_id: memberId(1),
  due_at: '2026-12-31T10:00:00.000000Z',
  difference_vnd: '-10000000',
  ...overrides,
});

export const settledAnswer = (overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('0d60', 2),
  status: 'SETTLED',
  resource_version: 9,
  resource_id: paymentId(1),
  transaction_id: transactionId(1),
  payment_request_id: paymentId(1),
  amount_vnd: '2100000000',
  treasury_paid_on: '2026-07-25',
  confirmed_at: '2026-07-24T18:30:00.000000Z',
  ...overrides,
});

export interface World {
  items: Array<Record<string, unknown>>;
  transactions: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  tracking: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { items: [item(1)], transactions: [], requests: [], tracking: [], members: [], summary: { waiting: 1, overdue: 0, waiting_difference_vnd: '-10000000' }, failing: new Set(), ...overrides };
}

/** A client over `state`: the items, transactions, requests, tracking and members are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => answer()): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const typed = input as { path?: { id?: string }; query?: Record<string, string> } | undefined;
    if (operation === 'listReconciliationItems') {
      const status = typed?.query?.status;
      return { items: state.items.filter((row) => status === undefined || row.status === status), next_cursor: null, as_of: '2026-07-25T05:00:00.000Z', summary: state.summary };
    }
    if (operation === 'getReconciliationItem') return state.items.find((row) => row.id === typed?.path?.id) ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} });
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    const query = (input as { query?: Record<string, string> } | undefined)?.query;
    switch (operation) {
      case 'get_resources_treasury_transaction':
        return Promise.resolve(state.transactions);
      case 'get_resources_payment_request':
        return Promise.resolve(state.requests.filter((row) => query?.status === undefined || row.status === query.status));
      case 'getTreasuryTracking':
        return Promise.resolve(state.tracking);
      case 'get_resources_membership':
        return Promise.resolve(state.members);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
