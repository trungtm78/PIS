import { vi } from 'vitest';
import { handover, handoverId, unitId } from '../handover/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount } from '../../ctr/test-support';
export { contractId } from '../../ctr/test-support';
export { handover, handoverId, unitId };
export type { Harness };

export const READER = ['asset_record.read'];
export const ACCOUNTANT = ['asset_record.read', 'asset.manage'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const assetId = (n: number): string => uuid('006c', n);
export const DOCUMENT = uuid('006d', 1);

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

/** An asset as the list answers it: registered, with the figures the caller may see and nothing to do unless the test says so. */
export const asset = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: assetId(n),
  asset_code: `AS-00${n}`,
  name: `Trạm bơm ${n}`,
  handover: { id: handoverId(1), handover_no: 'BG-001', status: 'ACCEPTED' },
  contract: { id: '00000000-0000-4000-8000-000000000002', code: 'HD-A-002', value_vnd: '10000000000' },
  project_id: '00000000-0000-4000-8000-000000010001',
  recipient_unit: { id: unitId(1), code: 'SOGT', name: 'Sở Giao thông' },
  asset_class_master_version_id: null,
  value_vnd: '3200000000',
  value_basis: 'CONTRACT_VALUE',
  contract_assets_vnd: '5000000000',
  funding_origin: null,
  status: 'REGISTERED',
  registered_on: '2026-10-20',
  transferred_on: null,
  warranty_until: null,
  commissioning_document_version_id: null,
  external_asset_id: null,
  created_at: `2026-10-25T01:00:0${n}.000000Z`,
  allowed: { transfer: false },
  version: 1,
  ...overrides,
});

export interface World {
  handovers: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    handovers: [handover(1, { status: 'ACCEPTED', project_id: '00000000-0000-4000-8000-000000010001' }), handover(2, { status: 'ACCEPTED' }), handover(3, { status: 'PUNCH_PENDING' })],
    assets: [],
    units: [
      { id: unitId(1), code: 'SOGT', name: 'Sở Giao thông' },
      { id: unitId(2), code: 'BQL', name: 'Ban Quản lý' },
    ],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    if (operation === 'get_resources_handover') return { items: state.handovers, next_cursor: null, as_of: '2026-10-25T03:00:00.000Z' };
    if (operation === 'get_resources_asset_record') {
      return {
        items: state.assets.filter((entry) => query.handover_id === undefined || (entry.handover as { id: string }).id === query.handover_id),
        next_cursor: null,
        as_of: '2026-10-25T03:00:00.000Z',
      };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_organization_unit') return Promise.resolve(state.units);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
