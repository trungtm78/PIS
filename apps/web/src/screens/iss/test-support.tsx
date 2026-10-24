import { vi } from 'vitest';
import { harness as baseHarness, mount as baseMount, routeOf as baseRoute } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };

export const MANAGER = ['issue.sla.manage', 'issue.read', 'master.read'];
export const READER = ['issue.read'];

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'ISS', path: `/iss/${id.toLowerCase()}` });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(10, '0')}`;

/** A row of the policy read, in the shape the server writes it. */
export const policy = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('a1', n),
  code: `SLA-${n}`,
  revision: 1,
  category_version_id: uuid('b1', n),
  category_record_id: uuid('c1', n),
  category_key: `GPMB-${n}`,
  category_label: `Giải phóng mặt bằng ${n}`,
  severity: 'HIGH',
  owner_unit_id: null,
  calendar_code: 'WORKDAY_VN',
  response_hours: 4,
  resolve_hours: 72,
  escalate_l2_pct: 100,
  escalate_l3_pct: 150,
  require_independent_verifier: true,
  require_evidence: true,
  valid_from: '2026-01-01',
  valid_until: null,
  status: 'ACTIVE',
  version: 1,
  ...overrides,
});

export const category = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('c1', n),
  namespace: 'TENANT',
  master_type: 'ISSUE_CATEGORY',
  business_key: `GPMB-${n}`,
  status: 'EFFECTIVE',
  label: `Giải phóng mặt bằng ${n}`,
  version_id: uuid('b1', n),
  version: 2,
  ...overrides,
});

export const unit = (n: number, overrides: Record<string, unknown> = {}) => ({ id: uuid('d1', n), code: `UBND-${n}`, name: `Ủy ban nhân dân ${n}`, ...overrides });

export interface World {
  categories: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  /** Operations whose read fails. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { categories: [category(1), category(2)], units: [unit(1)], failing: new Set(), ...overrides };
}

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation) => new Error(`unexpected read ${operation}`), command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'searchMasterRecords':
        return Promise.resolve(state.categories);
      case 'get_resources_organization_unit':
        return Promise.resolve(state.units);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export const mount = baseMount;
