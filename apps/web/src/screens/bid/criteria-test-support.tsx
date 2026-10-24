import { vi } from 'vitest';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';
import { pack, packageId, project } from './plan-test-support';

export { mount, routeOf } from './plan-test-support';
export { pack, packageId, project };
export type { Harness };

export const PLANNER = ['bid.read', 'bid.criteria.manage', 'criteria_version.read', 'procurement_package.read'];
export const APPROVER = ['bid.read', 'bid.criteria.approve', 'criteria_version.read', 'procurement_package.read'];
export const READER = ['bid.read', 'criteria_version.read', 'procurement_package.read'];
export const BOTH = ['bid.read', 'bid.criteria.manage', 'bid.criteria.approve', 'criteria_version.read', 'procurement_package.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const versionId = (n: number): string => uuid('0060', n);

export const scored = (code: string, weight: number, overrides: Record<string, unknown> = {}) => ({
  code,
  name: `Tiêu chí ${code}`,
  kind: 'SCORED',
  weight,
  max_score: 10,
  threshold: 5,
  mandatory: false,
  required_evidence: ['Báo cáo tài chính đã kiểm toán'],
  ...overrides,
});

export const passFail = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  name: `Yêu cầu ${code}`,
  kind: 'PASS_FAIL',
  weight: null,
  max_score: null,
  threshold: null,
  mandatory: true,
  required_evidence: [],
  ...overrides,
});

/** A version of the criteria of package 1 as the read answers it. */
export const version = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: versionId(n),
  package: { id: packageId(1), code: 'GT-1', title: 'Gói thầu xây lắp 1', status: 'PLANNED', project: project() },
  revision: n,
  status: 'APPROVED',
  criteria: [scored('C1', 40), scored('C2', 30), scored('C3', 20), scored('C4', 10), passFail('R1')],
  weights_sum: 100,
  legal_basis: 'Luật Đấu thầu 22/2023/QH15',
  approved_at: '2026-10-20T02:00:00.000000Z',
  version: 2,
  ...overrides,
});

export interface World {
  packages: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    packages: [pack(1, 1, { status: 'PLANNED', plan: { id: '00000000-0000-4000-8000-001000000001', revision: 1, status: 'APPROVED' } }), pack(2, 1, { status: 'PLANNED', plan: { id: '00000000-0000-4000-8000-001000000001', revision: 1, status: 'APPROVED' } })],
    versions: [version(1)],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the packages are answered from it, and the versions of the package named in the query; `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Record<string, unknown> }) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: { query?: Record<string, unknown> }) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_procurement_package') return Promise.resolve(state.packages);
    if (operation === 'get_resources_criteria_version') {
      const wanted = input?.query?.package_id;
      return Promise.resolve(state.versions.filter((raw) => (raw.package as { id: string }).id === wanted));
    }
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
