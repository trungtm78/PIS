import { vi } from 'vitest';
import { PLATFORM_TENANT, harness as baseHarness, mount as baseMount, routeOf as baseRoute } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };

/** The membership of the person who is signed in. */
export const ME = PLATFORM_TENANT.membershipId;

export const MANAGER = ['data.catalog.manage', 'data.catalog.read', 'membership.read'];
export const MANAGER_WITHOUT_MEMBERS = ['data.catalog.manage', 'data.catalog.read'];
export const READER = ['data.catalog.read'];

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'DGV', path: `/dgv/${id.toLowerCase()}` });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const MEMBER_ONE = uuid('0001', 1);
export const MEMBER_TWO = uuid('0001', 2);
export const MEMBER_THREE = uuid('0001', 3);

export const member = (n: number, name: string, overrides: Record<string, unknown> = {}) => ({ id: uuid('0001', n), display_name: name, status: 'Active', membership_type: 'STAFF', ...overrides });
export const MEMBERS = [member(1, 'Nguyen Van An'), member(2, 'Tran Thi Binh'), member(3, 'Le Van Cuong'), member(4, 'Guest Contractor', { membership_type: 'GUEST_CONTRACTOR' }), member(5, 'Suspended Person', { status: 'Suspended' })];

export const dataset = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0002', n),
  dataset_code: `DS-${n}`,
  title: `Dataset ${n}`,
  domain: 'TREASURY',
  grain: 'one row per payment order',
  producer_module: 'PAY',
  owner_user_id: MEMBER_ONE,
  owner_name: 'Nguyen Van An',
  steward_user_id: MEMBER_TWO,
  steward_name: 'Tran Thi Binh',
  classification: 'INTERNAL',
  is_critical: false,
  freshness_slo_seconds: 86_400,
  contract_revision: null,
  status: 'DRAFT',
  quality_badge: 'NOT_ASSESSED',
  version: 1,
  ...overrides,
});

export interface World {
  datasets: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { datasets: [], members: MEMBERS, failing: new Set(), ...overrides };
}

type Query = Record<string, string | undefined>;

/** A client over `state`: the catalogue and the members are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Query }) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: { query?: Query }) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    const query = input?.query ?? {};
    switch (operation) {
      case 'searchCatalog': {
        const needle = query.q?.toLowerCase();
        return Promise.resolve(
          state.datasets.filter(
            (item) =>
              (needle === undefined || `${String(item.dataset_code)} ${String(item.title)} ${String(item.grain)}`.toLowerCase().includes(needle)) &&
              (query.domain === undefined || item.domain === query.domain) &&
              (query.classification === undefined || item.classification === query.classification),
          ),
        );
      }
      case 'get_resources_membership':
        return Promise.resolve(state.members);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export const mount = baseMount;
