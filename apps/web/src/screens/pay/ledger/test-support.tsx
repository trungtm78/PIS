import type { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { contractId, mount } from '../../ctr/test-support';
import { itemId } from '../../ctr/measurement/test-support';

export { contractId, mount, itemId };
export type { Harness };

export const READER = ['ledger.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const ledgerId = (n: number): string => uuid('0060', n);
export const acceptanceId = (n: number): string => uuid('0050', n);
export const entryId = (n: number): string => uuid('0070', n);

export const routeOf = (id: string, req: string) => ({
  id,
  path: `/pay/${id.toLowerCase()}`,
  title: id,
  kind: 'reconcile' as const,
  area: 'investment' as const,
  module: 'PAY',
  group: 'Đối soát & kiểm soát',
  role: 'workspace' as const,
  parent: null,
  req,
});

/** One entry as the ledger answers it: the recognition of 400,000,000 on the item. */
export const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: entryId(n),
  kind: 'RECOGNIZE_ACCEPTANCE',
  accepted_delta_vnd: '400000000',
  requested_delta_vnd: '0',
  paid_delta_vnd: '0',
  advance_recovery_delta_vnd: '0',
  retention_delta_vnd: '0',
  advance_outstanding_after_vnd: '0',
  reversal_of_id: null,
  payment_request_id: null,
  reason: null,
  posted_at: '2026-10-25T03:00:00.000Z',
  ...overrides,
});

/** A balance: item B0n of acceptance NT-001 with 400,000,000 accepted, 150,000,000 requested and 100,000,000 paid. */
export const line = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: ledgerId(n),
  boq_item_id: itemId(n),
  boq_item_key: `B0${n}`,
  description: `Hạng mục ${n}`,
  unit_code: 'M3',
  acceptance_id: acceptanceId(1),
  acceptance_no: 'NT-001',
  party_id: null,
  accepted_vnd: '400000000',
  requested_vnd: '150000000',
  paid_vnd: '100000000',
  advance_recovered_vnd: '20000000',
  retention_held_vnd: '10000000',
  version: '2',
  entries: [entry(n), entry(n + 10, { kind: 'CLAIM', accepted_delta_vnd: '0', requested_delta_vnd: '150000000', advance_outstanding_after_vnd: '30000000', reason: 'Claim 1' })],
  ...overrides,
});

/** The page of the ledger the server answers. */
export const page = (items: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => ({
  contract: {
    id: contractId(1),
    code: 'HD-A-001',
    version: 5,
    contract_value_vnd: '10200000000',
    accepted_total_vnd: String(items.length * 400000000),
    requested_total_vnd: String(items.length * 150000000),
    paid_total_vnd: String(items.length * 100000000),
    advance_paid_vnd: '50000000',
    advance_recovered_vnd: String(items.length * 20000000),
    advance_outstanding_vnd: '30000000',
    retention_held_vnd: String(items.length * 10000000),
    retention_released_vnd: '0',
  },
  items,
  total: {
    accepted_vnd: String(items.length * 400000000),
    requested_vnd: String(items.length * 150000000),
    paid_vnd: String(items.length * 100000000),
    advance_recovered_vnd: String(items.length * 20000000),
    retention_held_vnd: String(items.length * 10000000),
  },
  reconciled: true,
  next_cursor: null,
  as_of: '2026-10-25T03:00:00.000Z',
  ...overrides,
});

export interface World {
  /** Every balance of the contract; the read keeps the ones the filter names and pages them by two. */
  lines: Array<Record<string, unknown>>;
  /** Replaces the whole answer (an error to fail the read, a page to answer it as it is). */
  answer?: unknown;
  overrides?: Record<string, unknown>;
}

export function world(lines: Array<Record<string, unknown>> = [line(1), line(2)], rest: Omit<World, 'lines'> = {}): World {
  return { lines, ...rest };
}

interface Query {
  boq_item_id?: string;
  acceptance_id?: string;
  cursor?: string;
  limit?: number;
}

/** A client whose ledger is `state`: the filters are applied, and two lines make a page (the cursor is the index of the next one). */
export function client(state: World): Harness {
  return baseHarness((operation, input) => {
    if (operation !== 'getCumulativeLedger') return new Error(`unexpected read ${operation}`);
    if (state.answer !== undefined) return state.answer;
    const query = (input as { query?: Query } | undefined)?.query ?? {};
    const kept = state.lines.filter((item) => (query.boq_item_id === undefined || item.boq_item_id === query.boq_item_id) && (query.acceptance_id === undefined || item.acceptance_id === query.acceptance_id));
    const from = query.cursor === undefined ? 0 : Number(query.cursor);
    const shown = kept.slice(from, from + 2);
    return page(shown, { next_cursor: from + 2 < kept.length ? String(from + 2) : null, ...state.overrides });
  });
}

export const calls = (h: Harness): Array<{ path?: { id?: string }; query?: Query }> => (h.read as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as { path?: { id?: string }; query?: Query });
