import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { TENANT } from '../test-support';

export { mount, routeOf } from '../test-support';
export type { Harness };

export const PROPOSER = ['bid.read', 'bid.result.submit'];
export const AUTHORITY = ['bid.read', 'bid.result.approve'];
export const READER = ['bid.read'];
/** The membership the session signs in as: a result it submitted is its own. */
export const ME = TENANT.membershipId;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0030', 1);
export const packageId = (n: number): string => uuid('0020', n);
export const resultId = (n: number): string => uuid('00d0', n);
export const contractorId = (n: number): string => uuid('0090', n);
export const MINUTES = uuid('00e0', 1);
export const DECISION = uuid('00e0', 2);
export const SOMEONE = uuid('00b0', 7);

export const pack = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: packageId(n),
  code: `GT-${n}`,
  title: `Gói thầu xây lắp ${n}`,
  project: { id: PROJECT, code: 'PRJ-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION' },
  status: 'APPROVED',
  version: 3,
  ...overrides,
});

/** A result as the list answers it: submitted by someone else unless the test says it is the signed-in member. */
export const result = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: resultId(n),
  package: { id: packageId(packageNumber), code: `GT-${packageNumber}`, budget_vnd: '18000000000' },
  outcome: 'AWARDED',
  winner: { id: contractorId(1), legal_name: 'Công ty nhà thầu 1' },
  award_price_vnd: '17650000000',
  evaluation_minutes: { document_id: MINUTES, title: 'Biên bản đánh giá' },
  decision_document_id: null,
  status: 'SUBMITTED',
  submitted_by: { membership_id: SOMEONE, display_name: 'Chuyên viên đấu thầu' },
  submitted_at: '2026-10-20T02:00:00.000Z',
  decided_by: null,
  decided_at: null,
  comment: null,
  version: 1,
  ...overrides,
});

export interface World {
  packages: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
  contractors: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    packages: [pack(1), pack(2, { status: 'AWARDED' }), pack(3, { status: 'DRAFT' })],
    results: [],
    contractors: [
      { id: contractorId(1), legal_name: 'Công ty nhà thầu 1', verification_status: 'VERIFIED', restriction_in_force: null },
      { id: contractorId(3), legal_name: 'Công ty chưa xác minh', verification_status: 'UNVERIFIED', restriction_in_force: null },
    ],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'listProcurementResults') {
      const wanted = (input as { query?: { package_id?: string } } | undefined)?.query?.package_id;
      return { items: state.results.filter((item) => wanted === undefined || (item.package as { id: string }).id === wanted), as_of: '2026-10-25T03:00:00.000Z' };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_procurement_package':
        return Promise.resolve(state.packages);
      case 'get_resources_contractor':
        return Promise.resolve(state.contractors);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
