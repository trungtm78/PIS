import { vi } from 'vitest';
import { inspection, inspectionId, routeOf } from '../inspection/test-support';
import { contractId, line as contractLine } from '../../ctr/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount } from '../../ctr/test-support';
export { inspection, inspectionId, routeOf };
export type { Harness };

export const SUPERVISOR = ['qacceptance.read', 'qacceptance.manage', 'qacceptance.sign', 'inspection.read'];
export const OWNER = ['qacceptance.read', 'qacceptance.sign', 'qacceptance.approve', 'qacceptance.revoke'];
export const READER = ['qacceptance.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const acceptanceId = (n: number): string => uuid('00a0', n);
export const PAPER = uuid('00a1', 1);

const signature = (role: string, name: string, overrides: Record<string, unknown> = {}) => ({
  role,
  membership_id: uuid('00a2', role.length),
  signer_name: name,
  method: 'IN_APP_OTP',
  legal_effect: 'INTERNAL_RECORD',
  cert_serial: null,
  signed_at: '2026-10-25T02:30:00.000Z',
  valid: true,
  ...overrides,
});
export { signature };

/** Minutes as the list answers them: being signed by the contractor, with the supervisor and the owner still to sign, and signable by the caller unless the test says otherwise. */
export const acceptance = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: acceptanceId(n),
  record_no: `QA-W-00${n}`,
  contract: { id: contractId(2), code: 'HD-A-002', status: 'ACTIVE' },
  project_id: uuid('0001', 1),
  inspection: { id: inspectionId(n), inspection_no: `KT-00${n}`, inspection_type: 'CONCEALED_WORK', title: `Kiểm tra vật liệu đợt ${n}`, result: 'PASS' },
  boq_item: { id: uuid('0014', 1), business_key: 'B01', description: 'Hạng mục 1' },
  acceptance_scope: 'WORK_ITEM',
  document_version_id: PAPER,
  status: 'SIGNING',
  required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
  signatures: [signature('CONTRACTOR', 'Nhà thầu An Phát')],
  missing_roles: ['SUPERVISOR', 'OWNER'],
  open_critical_ncr: 0,
  regime: { version_id: uuid('0090', 1), label: 'Nghị định 06/2021/NĐ-CP', legal_basis: 'Nghị định 06/2021/NĐ-CP', awaiting_confirmation: true, cxn: 'CXN-07' },
  decision_note: null,
  approved_at: null,
  approved_by: null,
  created_by: { membership_id: uuid('00a3', 1), display_name: 'Giám sát Bình' },
  revoke_reason: null,
  revoked_at: null,
  created_at: '2026-10-25T01:00:00.000Z',
  signable_roles: ['SUPERVISOR'],
  actions: { sign: true, approve: false, reject: false, revoke: false },
  version: 2,
  ...overrides,
});

export interface World {
  contracts: Array<Record<string, unknown>>;
  acceptances: Array<Record<string, unknown>>;
  inspections: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

/** An inspection that passed and has no minutes yet. */
export const passed = (n: number, overrides: Record<string, unknown> = {}) => inspection(n, { status: 'RESULT_RECORDED', result: 'PASS', actions: { schedule: false, record: false, cancel: false }, ...overrides });

export function world(overrides: Partial<World> = {}): World {
  return {
    contracts: [contractLine(1), contractLine(2, { status: 'ACTIVE', title: null })],
    acceptances: [],
    inspections: [],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const wanted = (input as { query?: { contract_id?: string } } | undefined)?.query?.contract_id;
    if (operation === 'listQualityAcceptances') return { items: state.acceptances.filter((item) => wanted === undefined || (item.contract as { id: string }).id === wanted), as_of: '2026-10-25T03:00:00.000Z' };
    if (operation === 'listInspections') return { items: state.inspections.filter((item) => wanted === undefined || (item.contract as { id: string }).id === wanted), as_of: '2026-10-25T03:00:00.000Z' };
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_contract') return Promise.resolve(state.contracts);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
