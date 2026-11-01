import { vi } from 'vitest';
import { asset } from '../../ast/asset/test-support';
import { handover } from '../../ast/handover/test-support';
import { warranty } from '../../ast/warranty/test-support';
import { payment } from '../../pay/payment/test-support';
import { settlement } from '../../pay/settlement/test-support';
import { diary } from '../../qms/diary/test-support';
import { inspection } from '../../qms/inspection/test-support';
import { ncr } from '../../qms/nonconformance/test-support';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, contractId, detail, mount, routeOf as baseRouteOf } from '../test-support';

export { asset, handover, inspection, mount, ncr, payment, settlement, warranty, diary };
export type { Harness };

export const CONTRACT = contractId(2);
export const routeOf = (id: string) => baseRouteOf(id, `FR-${id}`);

/** Every right a view stands on; a reader holds the ones of the view it opens. */
export const READERS = {
  'CTR-09': ['site_diary.read'],
  'CTR-11': ['quality_nonconformance.read', 'inspection.read'],
  'CTR-15': ['handover.read'],
  'CTR-16': ['warranty.read'],
  'CTR-17': ['settlement_revision.read', 'payment_request.read'],
  'CTR-18': ['asset_record.read'],
} as const;

/** The contract as the staff read it, and as a guest contractor reads it: the register leaves the estimate ceiling out of the answer for a guest. */
export const staffContract = (overrides: Record<string, unknown> = {}) => detail(2, { status: 'ACTIVE', project_id: PROJECT, ...overrides });
export const guestContract = () => {
  const { estimate_ceiling_vnd: ceiling, ...rest } = staffContract();
  void ceiling;
  return rest;
};

export const coverage = (overrides: Record<string, unknown> = {}) => ({
  contract_code: 'HD-A-002',
  from: '2026-11-01',
  to: '2026-11-30',
  through: '2026-11-02',
  totals: { working_days: 2, with_diary: 1, signed: 1, draft: 0, missing: 1, late: 1, conflict: 0 },
  days: [],
  missing_dates: ['2026-11-02'],
  ...overrides,
});

export interface World {
  contract: Record<string, unknown> | Error;
  diaries: unknown[];
  ncrs: unknown[];
  inspections: unknown[];
  handovers: unknown[];
  warranties: unknown[];
  settlements: unknown[];
  finals: unknown[];
  assets: unknown[];
  coverage: Record<string, unknown> | Error;
  /** Fails every list read of the owners. */
  failing: Error | undefined;
  /** Leaves every list read of the owners pending. */
  loading: boolean;
}

export const world = (overrides: Partial<World> = {}): World => ({
  contract: staffContract(),
  diaries: [],
  ncrs: [],
  inspections: [],
  handovers: [],
  warranties: [],
  settlements: [],
  finals: [],
  assets: [],
  coverage: coverage(),
  failing: undefined,
  loading: false,
  ...overrides,
});

/** A client over `state`: the contract and the coverage are read one by one, the lists page by page (`readAll`) as the owner modules answer them. */
export function client(state: World): Harness {
  const h = harness((operation) => {
    if (operation === 'get_resources_contract_id') return state.contract;
    if (operation === 'getDiaryCoverage') return state.coverage;
    return new Error(`unexpected read ${operation}`);
  });
  const lists: Record<string, () => unknown[]> = {
    get_resources_site_diary: () => state.diaries,
    get_resources_quality_nonconformance: () => state.ncrs,
    listInspections: () => state.inspections,
    get_resources_handover: () => state.handovers,
    listWarrantyObligations: () => state.warranties,
    get_resources_settlement_revision: () => state.settlements,
    get_resources_payment_request: () => state.finals,
    get_resources_asset_record: () => state.assets,
  };
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    const list = lists[operation];
    if (list === undefined) return Promise.reject(new Error(`unexpected readAll ${operation}`));
    if (state.loading) return new Promise(() => undefined);
    return state.failing === undefined ? Promise.resolve(list()) : Promise.reject(state.failing);
  });
  return h;
}

export const readAllOf = (h: Harness, operation: string): Array<{ query?: Record<string, string> }> =>
  (h.client.readAll as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { query?: Record<string, string> });

export const open = (screen: Parameters<typeof mount>[0], state: World, options: { permissions: readonly string[] | undefined; path: string; mode?: 'FULL' | 'READ_ONLY' }): Harness => {
  const h = client(state);
  mount(screen, h, options);
  return h;
};

/** The rows the six views are tried with: a diary signed by the contractor, a critical NCR, an accepted handover, a warranty with a guarantee, a closed settlement and a final request, an asset. */
export const contractorSignature = {
  role: 'CONTRACTOR',
  membership_id: contractId(9),
  signer_name: 'Nhà thầu An Phát',
  method: 'IN_APP_OTP',
  legal_effect: 'INTERNAL_RECORD',
  cert_serial: null,
  signed_at: '2026-10-21T02:00:00.000Z',
  valid: true,
};

export const rows = {
  diary: diary(1, { contract: { id: CONTRACT, code: 'HD-A-002', status: 'ACTIVE' }, status: 'CONTRACTOR_SIGNED', signatures: [contractorSignature] }),
  ncr: ncr(1, { severity: 'CRITICAL', blocks_acceptance: true, overdue: true }),
  inspection: inspection(1, { status: 'RESULT_RECORDED', result: 'PASS' }),
  handover: handover(1, { status: 'ACCEPTED', accepted_at: '2026-10-28T03:00:00.000Z', open_critical_punch_count: 0, punch_item_count: 3 }),
  warranty: warranty(1, { guarantee: { guarantee_no: 'BL-1', issuer: 'Ngân hàng Tỉnh', amount_vnd: '500000000' } }),
  asset: asset(1),
};

export const finalRequest = payment(1, {
  request_kind: 'FINAL',
  status: 'SETTLED',
  contract: { id: CONTRACT, code: 'HD-A-002', status: 'ACTIVE' },
  treasury_paid_on: '2026-10-30',
  gross_vnd: '9000000000',
  net_vnd: '8100000000',
});
export const projectSettlement = settlement(1, { status: 'CLOSED', closed_at: '2026-10-29T03:00:00.000000Z', settled_amount_vnd: '9850000000' });
export const ownSettlement = settlement(2, {
  contract: { id: CONTRACT, code: 'HD-A-002' },
  settlement_scope: 'CONTRACT',
  status: 'VERIFIED',
  submitted_on: '2026-10-01',
  verification_due_on: '2027-03-30',
});
export const otherContractSettlement = settlement(3, { contract: { id: contractId(3), code: 'HD-A-003' }, settlement_scope: 'CONTRACT' });
