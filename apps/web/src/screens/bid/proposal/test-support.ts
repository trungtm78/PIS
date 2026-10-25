import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount, routeOf } from '../test-support';
export type { Harness };

export const CLERK = ['bid.read', 'proposal.read', 'bid.proposal.receive'];
export const EVALUATOR = ['bid.read', 'proposal.read', 'bid.evaluate'];
export const AUTHORITY = ['bid.read', 'bid.conflict.decide'];
export const READER = ['proposal.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0030', 1);
export const packageId = (n: number): string => uuid('0020', n);
export const proposalId = (n: number): string => uuid('0080', n);
export const contractorId = (n: number): string => uuid('0090', n);
export const declarationId = (n: number): string => uuid('00a0', n);
export const MEMBER = uuid('00b0', 1);
export const SHA = 'a'.repeat(64);
export const KEY = 'tenants/00000000-0000-4000-8000-00000000000a/document/00000000-0000-4000-8000-0000000000aa';

/** A package of a plan in force, open for bids. */
export const pack = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: packageId(n),
  code: `GT-${n}`,
  title: `Gói thầu xây lắp ${n}`,
  project: { id: PROJECT, code: 'PRJ-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION' },
  status: 'APPROVED',
  version: 3,
  ...overrides,
});

export const opening = (packageNumber: number, at: string | null, kind = 'BID_OPENING') => ({
  id: uuid('0040', packageNumber),
  package_id: packageId(packageNumber),
  milestone_kind: kind,
  planned_at: at,
  actual_at: null,
  source: 'MANUAL',
  import_batch_id: null,
  version: 1,
});

/** A proposal as the clerk sees it: the receipt only, sealed. */
export const proposal = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: proposalId(n),
  package: { id: packageId(packageNumber), code: `GT-${packageNumber}`, title: `Gói thầu xây lắp ${packageNumber}` },
  project: { id: PROJECT, code: 'PRJ-001' },
  contractor: { id: contractorId(n), legal_name: `Công ty nhà thầu ${n}` },
  revision: 1,
  status: 'RECEIVED',
  submitted_at: '2026-11-10T02:00:00.000Z',
  access_released_at: '2099-11-12T02:00:00.000Z',
  locked: true,
  file_count: 2,
  classification: 'CONFIDENTIAL',
  access: 'METADATA',
  conflict_standing: 'UNDECLARED',
  version: 1,
  ...overrides,
});

/** The same proposal opened in full: the price and the files. */
export const opened = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) =>
  proposal(n, packageNumber, {
    access_released_at: '2026-11-12T02:00:00.000Z',
    locked: false,
    access: 'FULL',
    conflict_standing: 'CLEAR',
    bid_price_vnd: '17650000000',
    ...overrides,
  });

export const files = [
  { id: uuid('00c0', 1), part: 'TECHNICAL', title: 'Đề xuất kỹ thuật', mime: 'application/pdf', page_count: 120, size_bytes: 3 * 1024 * 1024 },
  { id: uuid('00c0', 2), part: 'FINANCIAL', title: 'Đề xuất tài chính', mime: 'application/pdf', page_count: 12, size_bytes: 200 * 1024 },
];

export const declaration = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: declarationId(n),
  package_id: packageId(1),
  member: { membership_id: MEMBER, display_name: `Chuyên gia ${n}` },
  has_conflict: true,
  relation_text: 'Giám đốc nhà thầu là anh em họ của tôi.',
  contractor: { id: contractorId(1), legal_name: 'Công ty nhà thầu 1' },
  declared_at: '2026-11-10T03:00:00.000Z',
  decision: null,
  decision_reason: null,
  decided_by: null,
  decided_at: null,
  standing: 'PENDING',
  is_own: false,
  version: 1,
  ...overrides,
});

export interface World {
  packages: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  /** The proposal as the read by id answers it, by id. */
  details: Record<string, unknown>;
  declarations: Array<Record<string, unknown>>;
  mayDecide: boolean;
  contractors: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    packages: [pack(1), pack(2)],
    milestones: [opening(1, '2099-11-12T02:00:00.000Z'), opening(2, '2099-11-20T02:00:00.000Z')],
    proposals: [proposal(1, 1), proposal(2, 1)],
    details: {},
    declarations: [],
    mayDecide: false,
    contractors: [
      { id: contractorId(1), legal_name: 'Công ty nhà thầu 1', verification_status: 'VERIFIED', restriction_in_force: null },
      { id: contractorId(2), legal_name: 'Công ty nhà thầu 2', verification_status: 'VERIFIED', restriction_in_force: { id: 'r', kind: 'DEBARMENT' } },
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
    switch (operation) {
      case 'listProcurementMilestones':
        return { items: state.milestones, as_of: '2026-10-25T03:00:00.000Z' };
      case 'listConflictDeclarations':
        return { items: state.declarations, may_decide: state.mayDecide, as_of: '2026-10-25T03:00:00.000Z' };
      case 'get_resources_proposal_id': {
        const id = (input as { path?: { id?: string } } | undefined)?.path?.id ?? '';
        return state.details[id] ?? new Error('not found');
      }
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: { package_id?: string } }) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_procurement_package':
        return Promise.resolve(state.packages);
      case 'get_resources_proposal':
        return Promise.resolve(state.proposals.filter((item) => (item.package as { id: string }).id === input?.query?.package_id));
      case 'get_resources_contractor':
        return Promise.resolve(state.contractors);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
