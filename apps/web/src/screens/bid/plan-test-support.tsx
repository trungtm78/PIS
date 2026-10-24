import { vi } from 'vitest';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export { mount, routeOf } from './test-support';
export type { Harness };

export const PLANNER = ['bid.read', 'bid.plan.manage', 'procurement_package.read'];
export const APPROVER = ['bid.read', 'bid.plan.approve'];
export const READER = ['bid.read', 'procurement_package.read'];
export const BOTH = ['bid.read', 'bid.plan.manage', 'bid.plan.approve', 'procurement_package.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0030', 1);
export const LINE = uuid('0040', 1);
export const DECISION_DOCUMENT = uuid('0050', 1);
export const planId = (n: number): string => uuid('0010', n);
export const packageId = (n: number): string => uuid('0020', n);

export const project = (overrides: Record<string, unknown> = {}) => ({ id: PROJECT, code: 'PRJ-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION', ...overrides });

export const plan = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: planId(n),
  project: project(),
  revision: n,
  title: `Kế hoạch lựa chọn nhà thầu ${n}`,
  legal_basis: 'Luật Đấu thầu 22/2023/QH15',
  total_value_vnd: '28000000000',
  status: 'DRAFT',
  supersedes_id: null,
  decision_document: null,
  approved_at: null,
  package_count: 2,
  last_decision: null,
  version: 1,
  ...overrides,
});

export const pack = (n: number, planNumber: number | null, overrides: Record<string, unknown> = {}) => ({
  id: packageId(n),
  code: `GT-${n}`,
  title: `Gói thầu xây lắp ${n}`,
  project: project(),
  plan: planNumber === null ? null : { id: planId(planNumber), revision: planNumber, status: 'DRAFT' },
  budget_vnd: n === 1 ? '18000000000' : '10000000000',
  method: 'OPEN_BIDDING',
  contract_type: 'LUMP_SUM',
  bidding_form: 'ONLINE',
  allocation_line_id: LINE,
  fund_source: { business_key: 'NSTW', label: 'Ngân sách trung ương' },
  planned_start_period: '2026-Q4',
  duration_days: 180,
  status: 'DRAFT',
  approved_decision_id: null,
  version: 1,
  ...overrides,
});

export const line = (overrides: Record<string, unknown> = {}) => ({
  id: LINE,
  project: project(),
  plan_status: 'PUBLISHED',
  fund_source: { label: 'Ngân sách trung ương' },
  source_year: 2026,
  amount_vnd: '30000000000',
  ...overrides,
});

export interface World {
  plans: Array<Record<string, unknown>>;
  packages: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  lines: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { plans: [plan(1)], packages: [pack(1, 1), pack(2, 1)], projects: [project()], lines: [line()], failing: new Set(), ...overrides };
}

/** A client over `state`: every list read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness(() => new Error('unexpected read'), command);
  const sources: Record<string, () => unknown[]> = {
    listProcurementPlans: () => state.plans,
    get_resources_procurement_package: () => state.packages,
    get_resources_project: () => state.projects,
    get_resources_allocation_line: () => state.lines,
  };
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    const source = sources[operation];
    return source === undefined ? Promise.reject(new Error(`unexpected readAll ${operation}`)) : Promise.resolve(source());
  });
  return h;
}
