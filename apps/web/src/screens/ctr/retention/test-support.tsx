import { ApiError } from '@machvon/api-client';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { contractId, mount } from '../test-support';
import { itemId } from '../measurement/test-support';

export { contractId, mount, itemId };
export type { Harness };

export const READER = ['ledger.read'];
export const ACCOUNTANT = ['ledger.read', 'retention.release'];
export const DECISION = '00000000-0000-4000-8000-00800000dec1';

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const holdId = (n: number): string => uuid('0081', n);

export const routeOf = (id: string, req: string) => ({
  id,
  path: `/ctr/${id.toLowerCase()}`,
  title: id,
  kind: 'funding' as const,
  area: 'investment' as const,
  module: 'CTR',
  group: 'Hợp đồng & điều khoản',
  role: 'workspace' as const,
  parent: null,
  req,
});

/** A hold as the list answers it: B0n with 100,000,000 held, nothing released, waiting for the warranty to end, and nothing to do unless the test says so. */
export const hold = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: holdId(n),
  boq_item: { id: itemId(n), key: `B0${n}`, description: `Hạng mục ${n}` },
  party_id: null,
  payment_request_id: uuid('0082', 1),
  acceptance_id: uuid('0050', 1),
  held_vnd: '100000000',
  released_vnd: '0',
  left_vnd: '100000000',
  release_condition: 'WARRANTY_END',
  release_not_before: null,
  status: 'HELD',
  condition: { met: false, reason: 'WARRANTY_OPEN' },
  released_at: null,
  release_reason: null,
  decision_document_version_id: null,
  created_at: `2026-10-25T01:00:0${n}.000000Z`,
  allowed: { release: false },
  version: 1,
  ...overrides,
});

export interface World {
  holds: Array<Record<string, unknown>>;
  contract: Record<string, unknown>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
  /** Contracts the caller may not see: a 404. */
  missing: boolean;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    holds: [],
    contract: { id: contractId(1), code: 'HD-A-001', status: 'COMPLETED', retention_held_vnd: '150000000', retention_released_vnd: '0' },
    failing: new Set(),
    missing: false,
    ...overrides,
  };
}

/** A client over `state`: the list is answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'listRetentionHolds') {
      if (state.missing) return new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
      return { contract: state.contract, items: state.holds, next_cursor: null, as_of: '2026-10-25T03:00:00.000Z' };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
}
