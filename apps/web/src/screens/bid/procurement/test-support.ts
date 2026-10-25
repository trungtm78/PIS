import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount, routeOf } from '../test-support';
export type { Harness };

export const PLANNER = ['bid.read', 'bid.plan.manage', 'bid.import'];
export const READER = ['bid.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0030', 1);
export const OTHER_PROJECT = uuid('0030', 2);
export const packageId = (n: number): string => uuid('0020', n);
export const milestoneId = (n: number): string => uuid('0040', n);
export const linkId = (n: number): string => uuid('0050', n);
export const SHA = 'a'.repeat(64);
export const KEY = 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa';

export const pack = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: packageId(n),
  code: `GT-${n}`,
  title: `Gói thầu xây lắp ${n}`,
  project: { id: PROJECT, code: 'PRJ-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION' },
  status: 'PLANNED',
  version: 3,
  ...overrides,
});

export const milestone = (n: number, packageNumber: number, kind: string, overrides: Record<string, unknown> = {}) => ({
  id: milestoneId(n),
  package_id: packageId(packageNumber),
  milestone_kind: kind,
  planned_at: null,
  actual_at: '2026-09-01T02:00:00.000Z',
  source: 'MANUAL',
  import_batch_id: null,
  version: 1,
  ...overrides,
});

export const link = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: linkId(n),
  package_id: packageId(packageNumber),
  package_code: `GT-${packageNumber}`,
  package_title: `Gói thầu xây lắp ${packageNumber}`,
  project: { id: PROJECT, code: 'PRJ-001' },
  external_system: 'MUASAMCONG',
  external_code: `TBMT-${packageNumber}`,
  diff_status: 'IN_SYNC',
  diff: {},
  diff_owner: null,
  batch: { id: uuid('0060', 1), file_sha256: SHA, adapter_status: 'PROPOSED', applied_at: '2026-10-24T03:00:00.000Z', rows_total: 3, rows_ok: 2, rows_error: 1 },
  version: 1,
  ...overrides,
});

export interface World {
  packages: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  /** Whether the caller holds the permission on the whole tenant (the grants of getMyEffectiveAccess). */
  wholeTenant: boolean;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    packages: [pack(1), pack(2)],
    milestones: [milestone(1, 1, 'INVITATION_PUBLISHED', { actual_at: '2026-08-01T02:00:00.000Z' }), milestone(2, 1, 'BID_OPENING', { source: 'IMPORT', planned_at: '2026-08-30T02:00:00.000Z' })],
    links: [link(1, 1), link(2, 2, { diff_status: 'DIFFERENT', diff: { milestones: { BID_OPENING: { register: '2026-09-01T02:00:00.000Z', file: '2026-09-04T17:00:00.000Z' } } }, diff_owner: { membership_id: uuid('0070', 1), display_name: 'Nguyễn Văn An' } })],
    wholeTenant: true,
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the lists are answered from it, the grants say whether the caller holds the permission on the whole tenant, and `command` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    switch (operation) {
      case 'listProcurementMilestones':
        return { items: state.milestones, as_of: '2026-10-25T03:00:00.000Z' };
      case 'listProcurementExternalLinks':
        return { items: state.links, as_of: '2026-10-25T03:00:00.000Z' };
      case 'getMyEffectiveAccess':
        return { grants: [{ scope_kind: state.wholeTenant ? 'TENANT' : 'UNIT_SUBTREE', state: 'ACTIVE', permissions: ['bid.import'] }] };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_procurement_package') return Promise.resolve(state.packages);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
