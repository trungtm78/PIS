import { vi } from 'vitest';
import { PROJECT, TENANT, contractId, boqLine, line as contractLine } from '../../ctr/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount } from '../../ctr/test-support';
export { PROJECT, contractId, boqLine };
export type { Harness };

export const REQUESTER = ['inspection.read', 'inspection.request', 'contract.read'];
export const SUPERVISOR = ['inspection.read', 'inspection.request', 'inspection.manage', 'inspection.record', 'contract.read', 'membership.read'];
export const READER = ['inspection.read'];
/** The membership the session signs in as. */
export const ME = TENANT.membershipId;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const inspectionId = (n: number): string => uuid('0060', n);
export const memberId = (n: number): string => uuid('0070', n);
export const DIARY = uuid('0080', 1);
export const itemId = (n: number): string => uuid('0014', n);

export const routeOf = (id: string, req: string) => ({ id, path: `/qms/${id.toLowerCase()}`, title: id, kind: 'form' as const, area: 'investment' as const, module: 'QMS', group: 'Chất lượng & nghiệm thu', role: 'workspace' as const, parent: null, req });

export const CHECKLIST = [
  { code: 'DOC', label: 'Hồ sơ vật liệu đầy đủ' },
  { code: 'SAMPLE', label: 'Mẫu thử đạt yêu cầu' },
  { code: 'SAFE', label: 'Biện pháp an toàn tại vị trí' },
];

/** An inspection as the list answers it: requested, under the regime of the decree in force, and manageable by the caller unless the test says otherwise. */
export const inspection = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: inspectionId(n),
  inspection_no: `KT-00${n}`,
  contract: { id: contractId(2), code: 'HD-A-002', status: 'ACTIVE' },
  project_id: PROJECT,
  boq_item: null,
  inspection_type: 'MATERIAL_ENTRY',
  title: `Kiểm tra vật liệu đợt ${n}`,
  location_text: null,
  requested_by: { membership_id: ME, display_name: 'Nhà thầu An Phát' },
  requested_for: '2026-10-30',
  scheduled_at: null,
  participants: [],
  status: 'REQUESTED',
  result: null,
  result_note: null,
  result_recorded_at: null,
  checklist: CHECKLIST.map((item) => ({ ...item })),
  regime: { version_id: uuid('0090', 1), label: 'Nghị định 06/2021/NĐ-CP', legal_basis: 'Nghị định 06/2021/NĐ-CP', awaiting_confirmation: false, cxn: null },
  required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
  site_diary_id: null,
  cancel_reason: null,
  created_at: '2026-10-25T01:00:00.000Z',
  actions: { schedule: true, record: false, cancel: true },
  version: 1,
  ...overrides,
});

export interface World {
  contracts: Array<Record<string, unknown>>;
  inspections: Array<Record<string, unknown>>;
  boqLines: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    contracts: [contractLine(1), contractLine(2, { status: 'ACTIVE', title: null }), contractLine(3, { status: 'ACTIVE', title: 'Hợp đồng số 3' })],
    inspections: [],
    boqLines: [boqLine(1, { contract_id: contractId(2) }), boqLine(2, { contract_id: contractId(2), boq_item_id: null }), boqLine(3, { contract_id: contractId(2), boq_item_id: itemId(1), line_no: 3 }), boqLine(4, { contract_id: contractId(2), boq_item_id: itemId(4) })],
    members: [
      { id: memberId(1), display_name: 'Giám sát Bình', status: 'Active', membership_type: 'STAFF' },
      { id: memberId(2), display_name: 'Chủ đầu tư Cường', status: 'Active', membership_type: 'STAFF' },
      { id: memberId(3), display_name: 'Đã nghỉ', status: 'Ended', membership_type: 'STAFF' },
    ],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'listInspections') {
      const wanted = (input as { query?: { contract_id?: string } } | undefined)?.query?.contract_id;
      return { items: state.inspections.filter((item) => wanted === undefined || (item.contract as { id: string }).id === wanted), as_of: '2026-10-25T03:00:00.000Z' };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      case 'get_resources_boq_line':
        return Promise.resolve(state.boqLines);
      case 'get_resources_membership':
        return Promise.resolve(state.members);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
