import { vi } from 'vitest';
import { PROJECT, TENANT, contractId, line as contractLine } from '../../ctr/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount } from '../../ctr/test-support';
export { PROJECT, contractId };
export type { Harness };

export const READER = ['quality_nonconformance.read'];
export const RAISER = ['quality_nonconformance.read', 'ncr.raise', 'ncr.manage', 'contract.read', 'membership.read'];
/** Whoever also answers, verifies, closes and reopens: each command needs its own right besides what the server allows on the line. */
export const HANDLER = [...RAISER, 'ncr.respond', 'ncr.verify', 'ncr.close'];
/** The membership the session signs in as. */
export const ME = TENANT.membershipId;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const ncrId = (n: number): string => uuid('0061', n);
export const actionId = (n: number): string => uuid('0062', n);
export const memberId = (n: number): string => uuid('0070', n);
export const DOCUMENT = uuid('0063', 1);
export const PHOTO = uuid('0064', 1);

export const routeOf = (id: string, req: string) => ({
  id,
  path: `/qms/${id.toLowerCase()}`,
  title: id,
  kind: 'board' as const,
  area: 'investment' as const,
  module: 'QMS',
  group: 'Chất lượng & nghiệm thu',
  role: 'workspace' as const,
  parent: null,
  req,
});

const NONE = { assign: false, respond: false, verify: false, close: false, reopen: false };

/** An action as the list answers it: assigned to someone else, waiting for evidence. */
export const action = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: actionId(n),
  description: `Đục bỏ và đổ lại lớp bảo vệ ${n}`,
  owner: { membership_id: memberId(2), display_name: 'Nhà thầu An Phát' },
  due_at: '2026-11-05T16:59:00.000Z',
  overdue: false,
  status: 'ASSIGNED',
  evidence_document_version_id: null,
  evidence_photo_id: null,
  evidence_note: null,
  submitted_at: null,
  verified_by: null,
  verified_at: null,
  verification_note: null,
  version: 1,
  ...overrides,
});

/** A non-conformance as the list answers it: raised against a contract being performed, nothing the caller may do unless the test says so. */
export const ncr = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: ncrId(n),
  ncr_no: `NCR-00${n}`,
  title: `Lớp bảo vệ cốt thép thiếu ${n}`,
  description: `Lớp bảo vệ của móng M${n} đo được 30 mm, bản vẽ yêu cầu 50 mm.`,
  severity: 'MAJOR',
  source_kind: 'SUPERVISOR_REMARK',
  status: 'OPEN',
  blocks_acceptance: false,
  contract: { id: contractId(2), code: 'HD-A-002', status: 'ACTIVE' },
  project_id: PROJECT,
  inspection_id: null,
  material_test_id: null,
  site_diary_id: null,
  measurement_id: null,
  detected_on: '2026-10-25',
  due_at: '2026-11-05T16:59:00.000Z',
  overdue: false,
  action_owner: { membership_id: memberId(1), display_name: 'Giám sát Bình' },
  root_cause: null,
  closure_note: null,
  reopen_reason: null,
  reopen_count: 0,
  verified_by: null,
  verified_at: null,
  closed_by: null,
  closed_at: null,
  actions: [],
  created_at: `2026-10-25T01:00:0${n}.000000Z`,
  allowed: { ...NONE },
  version: 1,
  ...overrides,
});

export const allowed = (patch: Partial<typeof NONE>) => ({ ...NONE, ...patch });

export interface World {
  contracts: Array<Record<string, unknown>>;
  nonconformances: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    contracts: [contractLine(1), contractLine(2, { status: 'ACTIVE', title: null }), contractLine(3, { status: 'ACTIVE', title: 'Hợp đồng số 3' })],
    nonconformances: [],
    members: [
      { id: memberId(1), display_name: 'Giám sát Bình', status: 'Active', membership_type: 'STAFF' },
      { id: memberId(2), display_name: 'Nhà thầu An Phát', status: 'Active', membership_type: 'GUEST_CONTRACTOR' },
      { id: memberId(3), display_name: 'Đã nghỉ', status: 'Ended', membership_type: 'STAFF' },
      { id: 5, display_name: 'Sai kiểu', status: 'Active' },
    ],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_quality_nonconformance') {
      const wanted = (input as { query?: { contract_id?: string } } | undefined)?.query?.contract_id;
      return { items: state.nonconformances.filter((item) => wanted === undefined || (item.contract as { id: string }).id === wanted), next_cursor: null, as_of: '2026-10-25T03:00:00.000Z' };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      case 'get_resources_membership':
        return Promise.resolve(state.members);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
