import { asset, assetId } from '../asset/test-support';
import { handover, handoverId, unitId } from '../handover/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

import { contractId } from '../../ctr/test-support';

export { mount, contractId } from '../../ctr/test-support';
export { asset, assetId, handover, handoverId, unitId };
export type { Harness };

export const READER = ['warranty.read'];
export const MANAGER = ['warranty.read', 'warranty.manage'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const warrantyId = (n: number): string => uuid('006e', n);
export const GUARANTEE = uuid('006f', 1);

export const routeOf = (id: string, req: string) => ({
  id,
  path: `/ast/${id.toLowerCase()}`,
  title: id,
  kind: 'detail' as const,
  area: 'investment' as const,
  module: 'AST',
  group: 'Bàn giao tài sản',
  role: 'workspace' as const,
  parent: null,
  req,
});

/** An obligation as the list answers it: in warranty, for the whole of the first handover, held back by an amount and with nothing to do unless the test says so. */
export const warranty = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: warrantyId(n),
  contract: { id: contractId(2), code: 'HD-A-002' },
  handover: { id: handoverId(1), handover_no: 'BG-001', status: 'ACCEPTED' },
  project_id: '00000000-0000-4000-8000-000000010001',
  asset: null,
  scope_description: `Phạm vi bảo hành ${n}`,
  starts_on: '2026-09-01',
  ends_on: '2999-09-01',
  period_months: 12,
  construction_grade: 'II',
  minimum_months: 12,
  rule: { version_id: uuid('0070', 1), awaiting_confirmation: true, cxn: 'CXN-EXE-04' },
  guarantee: null,
  retention_amount_vnd: '150000000',
  status: 'ACTIVE',
  closed_at: null,
  close_note: null,
  open_claims: 0,
  total_claims: 0,
  created_at: `2026-10-25T01:00:0${n}.000000Z`,
  allowed: { close: false },
  version: 1,
  ...overrides,
});

export interface World {
  handovers: Array<Record<string, unknown>>;
  warranties: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  /** The obligations the expiring list answers (none unless a test says so). */
  expiring?: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    handovers: [handover(1, { status: 'ACCEPTED', project_id: '00000000-0000-4000-8000-000000010001' }), handover(2, { status: 'ACCEPTED' }), handover(3, { status: 'PUNCH_PENDING' })],
    warranties: [],
    assets: [asset(1)],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    const page = (items: Array<Record<string, unknown>>) => ({ items, next_cursor: null, as_of: '2026-10-25T03:00:00.000Z' });
    if (operation === 'get_resources_handover') return page(state.handovers);
    if (operation === 'get_resources_asset_record') return page(state.assets);
    if (operation === 'listExpiringWarranties') return { ...page(state.expiring ?? []), next_cursor: state.expiring !== undefined && state.expiring.length >= 50 ? 'next' : null };
    if (operation === 'listWarrantyObligations') return page(state.warranties.filter((entry) => query.handover_id === undefined || (entry.handover as { id: string }).id === query.handover_id));
    return new Error(`unexpected read ${operation}`);
  }, command);
}
