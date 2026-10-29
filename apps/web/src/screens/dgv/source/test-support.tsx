import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { PLATFORM_TENANT, harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { dataset } from '../test-support';

export type { Harness };
export const ME = PLATFORM_TENANT.membershipId;
export const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

export const mappingId = (n: number): string => uuid('0040', n);
export const reconId = (n: number): string => uuid('0050', n);
export const gateId = (n: number): string => uuid('0060', n);
export const DATASET = dataset(1, { dataset_code: 'DS-DIS-1', producer_module: 'DIS' });

export const mapping = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: mappingId(n),
  dataset: { id: DATASET.id, code: 'DS-DIS-1' },
  source_system: 'PAY',
  source_field: `so_tien_${n}`,
  target_field: 'amount_vnd',
  transform_rule: null,
  unit: 'MILLION_VND',
  status: 'PROPOSED',
  proposed_by: { id: uuid('0001', 1), name: 'Nguyen Van An' },
  decided_by: null,
  decided_at: null,
  decision_note: null,
  created_at: `2026-10-2${n}T01:00:00.000000Z`,
  version: 1,
  actions: { decide: false },
  ...overrides,
});

export const gate = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: gateId(n),
  dataset_id: DATASET.id,
  source_system: 'PAY',
  batch_ref: `BATCH-${n}`,
  outcome: 'APPLIED',
  reason: null,
  row_count: 120,
  fields: [],
  gated_at: `2026-10-2${n}T02:00:00.000000Z`,
  gated_by: uuid('0001', 1),
  ...overrides,
});

export const difference = (key: string, kind: string, side: string, a: string, b: string) => ({ key, kind, side, amount_a_vnd: a, amount_b_vnd: b, difference_vnd: (BigInt(a) - BigInt(b)).toString() });

export const recon = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: reconId(n),
  recon_code: 'PAY-DIS-MONTH',
  source_a: 'PAY.treasury_transaction',
  source_b: 'DIS.report_accepted',
  as_of_period: '2026-10',
  basis: 'VND, ngày Kho bạc thanh toán',
  count_a: 4,
  count_b: 3,
  total_a_vnd: '385000000',
  total_b_vnd: '300000000',
  difference_vnd: '85000000',
  tolerance_vnd: '0',
  result: 'DIFFERENT',
  differences_count: 2,
  differences_truncated: false,
  by_kind: { MISSING: 1, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 1 },
  owner: { id: uuid('0001', 2), name: 'Tran Thi Binh' },
  dataset_id: DATASET.id,
  incident_id: uuid('0070', n),
  created_at: `2026-10-2${n}T03:00:00.000000Z`,
  ...overrides,
});

export interface World {
  mappings: Array<Record<string, unknown>>;
  gates: Array<Record<string, unknown>>;
  /** The summaries of the list; `details` holds the same ids with their differences. */
  reconciliations: Array<Record<string, unknown>>;
  details: Array<Record<string, unknown>>;
  failing: Set<string>;
  /** How many mappings a page holds; none: all of them. */
  pageSize?: number;
}

export function world(overrides: Partial<World> = {}): World {
  return { mappings: [], gates: [], reconciliations: [], details: [], failing: new Set(), ...overrides };
}

type Query = Record<string, string | undefined>;

/** A client over `state`: the lists and the one reconciliation are answered from it (filters applied as the server does), the catalogue holds the one dataset. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ resource_id: mappingId(1), resource_version: 2 })): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const query = (input as { query?: Query } | undefined)?.query ?? {};
    switch (operation) {
      case 'listSourceMappings': {
        const all = state.mappings.filter((item) => (query.status === undefined || item.status === query.status) && (query.dataset_id === undefined || (item.dataset as { id: string }).id === query.dataset_id));
        const from = query.cursor === undefined ? 0 : Number(query.cursor);
        const size = state.pageSize ?? all.length + 1;
        return { items: all.slice(from, from + size), next_cursor: from + size < all.length ? String(from + size) : null };
      }
      case 'listBatchGates':
        return { items: state.gates.filter((item) => (query.outcome === undefined || item.outcome === query.outcome) && (query.dataset_id === undefined || item.dataset_id === query.dataset_id)), next_cursor: null };
      case 'listReconciliations':
        return { items: state.reconciliations.filter((item) => query.result === undefined || item.result === query.result), next_cursor: null };
      case 'getReconciliation': {
        const found = state.details.find((item) => item.id === (input as { path: { id: string } }).path.id);
        return found === undefined ? problem('RESOURCE_NOT_FOUND', 404) : found;
      }
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => (operation === 'searchCatalog' ? Promise.resolve([DATASET]) : Promise.reject(new Error(`unexpected readAll ${operation}`))));
  return h;
}

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body?: Record<string, unknown>; ifMatchVersion?: number });
