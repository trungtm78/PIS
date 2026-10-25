import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { PROJECT, TENANT, contractId, line as contractLine } from '../../ctr/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount } from '../../ctr/test-support';
export { PROJECT, contractId };
export type { Harness };

export const READER = ['handover.read'];
export const DRAFTER = ['handover.read', 'handover.manage', 'contract.read'];
/** The membership the session signs in as. */
export const ME = TENANT.membershipId;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const handoverId = (n: number): string => uuid('0065', n);
export const itemId = (n: number): string => uuid('0066', n);
export const unitId = (n: number): string => uuid('0067', n);
export const DOCUMENT = uuid('0068', 1);
export const AS_BUILT = uuid('0068', 2);
export const PHOTO = uuid('0069', 1);
export const MINUTES = uuid('006a', 1);

export const routeOf = (id: string, req: string, kind: 'list' | 'review' = 'list') => ({
  id,
  path: `/ast/${id.toLowerCase()}`,
  title: id,
  kind,
  area: 'investment' as const,
  module: 'AST',
  group: 'Bàn giao tài sản',
  role: 'workspace' as const,
  parent: null,
  req,
});

const NONE = { add_item: false, approve: false, return: false, reject: false };
const NO_ITEM = { fix: false, verify: false, waive: false };

/** A handover as the list answers it: drafted for a contract being performed, nothing the caller may do unless the test says so. */
export const handover = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: handoverId(n),
  handover_no: `BG-00${n}`,
  handover_kind: 'COMPLETION',
  status: 'DRAFT',
  contract: { id: contractId(2), code: 'HD-A-002', status: 'ACTIVE' },
  project_id: PROJECT,
  recipient_unit: { id: unitId(1), code: 'SOGT', name: 'Sở Giao thông' },
  quality_acceptance_id: MINUTES,
  planned_on: '2026-11-10',
  handed_on: null,
  accepted_at: null,
  accepted_by: null,
  rejection_reason: null,
  decision_note: null,
  open_critical_punch_count: 0,
  punch_item_count: 0,
  document_version_id: DOCUMENT,
  as_built_document_version_id: null,
  om_manual_document_version_id: null,
  warranty_certificate_document_version_id: null,
  created_at: `2026-10-25T01:00:0${n}.000000Z`,
  allowed: { ...NONE },
  version: 1,
  ...overrides,
});

export const allowed = (patch: Partial<typeof NONE>) => ({ ...NONE, ...patch });
export const itemAllowed = (patch: Partial<typeof NO_ITEM>) => ({ ...NO_ITEM, ...patch });

/** One item of the punch list as the trace answers it. */
export const item = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: itemId(n),
  item_no: n,
  description: `Tay vịn cầu thang lỏng ${n}`,
  severity: 'MAJOR',
  location_text: null,
  responsible_contractor: { id: uuid('006b', 1), name: 'Nhà thầu An Phát' },
  due_on: '2026-11-05',
  overdue: false,
  status: 'OPEN',
  defect_photo_id: null,
  evidence_photo_id: null,
  evidence_document_version_id: null,
  fixed_by: null,
  fixed_at: null,
  fixed_note: null,
  verified_by: null,
  verified_at: null,
  verification_note: null,
  waiver_reason: null,
  waiver_approved_by: null,
  reopen_count: 0,
  allowed: { ...NO_ITEM },
  version: 1,
  ...overrides,
});

/** The trace of a handover: the handover, its items, assets, documents and minutes. */
export const trace = (overrides: Record<string, unknown> = {}) => ({
  handover: handover(1, { status: 'PUNCH_PENDING', punch_item_count: 2, open_critical_punch_count: 1 }),
  receiving_unit: { id: unitId(1), code: 'SOGT', name: 'Sở Giao thông' },
  items: [item(1, { severity: 'CRITICAL' }), item(2)],
  assets: [],
  documents: [{ role: 'MINUTES', document_version_id: DOCUMENT }],
  quality_acceptance: { id: MINUTES, record_no: 'QA-C-001', scope: 'COMPLETION', status: 'APPROVED' },
  as_of: '2026-10-25T03:00:00.000Z',
  ...overrides,
});

export interface World {
  contracts: Array<Record<string, unknown>>;
  handovers: Array<Record<string, unknown>>;
  traces: Record<string, Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    contracts: [contractLine(1), contractLine(2, { status: 'ACTIVE', title: null }), contractLine(3, { status: 'COMPLETED', title: 'Hợp đồng số 3' })],
    handovers: [],
    traces: {},
    units: [
      { id: unitId(1), code: 'SOGT', name: 'Sở Giao thông' },
      { id: unitId(2), code: 'BQL', name: 'Ban Quản lý' },
      { id: 5, code: 'X' },
    ],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_handover') {
      const wanted = (input as { query?: { contract_id?: string } } | undefined)?.query?.contract_id;
      return { items: state.handovers.filter((entry) => wanted === undefined || (entry.contract as { id: string }).id === wanted), next_cursor: null, as_of: '2026-10-25T03:00:00.000Z' };
    }
    if (operation === 'getHandoverTrace') {
      const wanted = (input as { path: { id: string } }).path.id;
      return state.traces[wanted] ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} });
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      case 'get_resources_organization_unit':
        return Promise.resolve(state.units);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
