import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { TENANT } from '../test-support';

export { mount, routeOf } from '../test-support';
export type { Harness };

export const PLANNER = ['bid.read', 'bid.petition.manage'];
export const READER = ['bid.read'];
/** The membership the session signs in as. */
export const ME = TENANT.membershipId;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0030', 1);
export const packageId = (n: number): string => uuid('0020', n);
export const petitionId = (n: number): string => uuid('00f0', n);
export const contractorId = (n: number): string => uuid('0090', n);
export const PAPER = uuid('00e0', 1);
export const REPLY = uuid('00e0', 2);
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

/** A petition as the list answers it: waiting, not overdue, and answerable by the caller unless the test says otherwise. */
export const petition = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: petitionId(n),
  package: { id: packageId(packageNumber), code: `GT-${packageNumber}` },
  project_id: PROJECT,
  contractor: { id: contractorId(1), legal_name: 'Công ty nhà thầu 1' },
  petition_kind: 'PROCESS',
  received_on: '2026-11-25',
  due_on: '2026-12-04',
  days_applied: 7,
  status: 'RECEIVED',
  overdue: false,
  days_overdue: 0,
  petition_document_id: PAPER,
  resolution_document_id: null,
  viewer_in_conflict: false,
  handled_by: null,
  resolved_at: null,
  created_by: SOMEONE,
  created_at: '2026-11-25T03:00:00.000Z',
  actions: { resolve: true },
  version: 1,
  ...overrides,
});

export interface World {
  packages: Array<Record<string, unknown>>;
  petitions: Array<Record<string, unknown>>;
  contractors: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    packages: [pack(1), pack(2, { status: 'AWARDED' }), pack(3, { status: 'DRAFT' })],
    petitions: [],
    contractors: [
      { id: contractorId(1), legal_name: 'Công ty nhà thầu 1', verification_status: 'VERIFIED', restriction_in_force: null },
      { id: contractorId(2), legal_name: 'Công ty nhà thầu 2', verification_status: 'VERIFIED', restriction_in_force: null },
    ],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'listProcurementPetitions') {
      const query = (input as { query?: { package_id?: string; overdue?: boolean } } | undefined)?.query;
      const items = state.petitions.filter((item) => (query?.package_id === undefined || (item.package as { id: string }).id === query.package_id) && (query?.overdue !== true || item.overdue === true));
      return { items, as_of: '2026-12-05T03:00:00.000Z' };
    }
    if (operation === 'listConflictDeclarations') return { items: [], may_decide: false, as_of: '2026-12-05T03:00:00.000Z' };
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
