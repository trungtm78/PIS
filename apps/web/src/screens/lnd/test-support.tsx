import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import type { WebRoute } from '../../routes/types';
import { SessionContext } from '../../session/SessionContext';
import type { SessionTenant, SessionValue } from '../../session/SessionContext';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };

export const TENANT: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bang',
  monogram: 'CB',
  membershipId: '00000000-0000-4000-8000-000000000001',
  theme: { themeId: 'tenant', version: 1, overlay: {} },
};

export const OFFICER = ['land.manage', 'land.process', 'land.read'];
export const HOUSEHOLD_OFFICER = ['land.household.write', 'land.household.read', 'lnd.pii.read'];
export const HOUSEHOLD_READER = ['land.household.read'];
export const DPO = ['land.dsr.handle', 'land.household.read'];
export const COUNTER = ['land.process', 'land.household.read'];
export const PLANNER = ['land.plan.write', 'land.read'];
export const PLAN_READER = ['land.read'];
export const READER = ['land.read'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/lnd/${id.toLowerCase()}`, title: id, kind: 'map', area: 'investment', module: 'LND', group: 'Tổng quan & thửa đất', role: 'workspace', parent: null, req });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0001', 1);
export const OTHER_PROJECT = uuid('0001', 2);
export const UNIT_XA = uuid('0002', 1);
export const UNIT_TTQD = uuid('0002', 2);
export const SECTION = uuid('0003', 1);
export const DOCUMENT = uuid('0004', 1);
export const CONTRACT = uuid('0005', 1);

export const parcel = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0010', n),
  project_id: PROJECT,
  section_id: null,
  section_code: null,
  owner_unit_id: UNIT_XA,
  owner_unit_name: 'UBND xã An Phú',
  parcel_code: `TB-${n}/10`,
  address_text: `Thôn ${n}`,
  land_use_group: 'AGRICULTURAL',
  area_total_m2: '1200.50',
  area_affected_m2: '800.00',
  has_boundary: false,
  status: 'SURVEYED',
  recovery_notice_on: null,
  notice_days_applied: null,
  recovery_decision_on: null,
  deadline: null,
  version: 1,
  ...overrides,
});

/** A household as the list answers it: the personal data in its masked forms only. */
export const household = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0030', n),
  project_id: PROJECT,
  owner_unit_id: UNIT_XA,
  household_code: `HH-${String(n).padStart(6, '0')}`,
  head_name_masked: 'N***** V** A',
  national_id_masked: '********0001',
  phone_masked: '*******678',
  address_masked: '***, Quận 1',
  member_count: 4,
  policy_beneficiary: false,
  legal_basis: 'PUBLIC_TASK_LAND_LAW',
  legal_basis_ref: 'Luật Đất đai 2024, Điều 87',
  consent_record_id: null,
  retention_until: '2036-12-31',
  dsr_open: false,
  processing_restricted: false,
  anonymised: false,
  status: 'REGISTERED',
  parcels: [],
  created_at: '2026-10-26T00:00:00.000Z',
  version: 1,
  ...overrides,
});

/** A record of the inventory of a household as the list answers it. */
export const inventoryRecord = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0040', n),
  household_id: uuid('0030', 1),
  household_code: 'HH-000001',
  parcel_id: uuid('0010', 1),
  parcel_code: 'TB-1/10',
  owner_unit_id: UNIT_XA,
  item_kind: 'HOUSE',
  description: 'Nhà cấp 4 mái ngói, xây năm 2011',
  quantity: '80.000000',
  unit_code: 'M2',
  unit_price_vnd: '4500000',
  amount_vnd: '360000000',
  price_decision_ref: 'QD-GIA-2024',
  price_decision_revision: 1,
  surveyed_on: '2026-06-20',
  surveyed_by: '00000000-0000-4000-8000-0000000000aa',
  household_confirmed_on: null,
  household_dispute: false,
  confirmed_by: null,
  note: null,
  evidence_photo_id: null,
  document_version_id: null,
  status: 'DRAFT',
  version: 1,
  ...overrides,
});

/** A plan of compensation as the list answers it (one revision of it). */
export const planRecord = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0050', n),
  project_id: PROJECT,
  section_id: null,
  executor_unit_id: UNIT_XA,
  executor_kind: 'LAND_FUND_CENTRE',
  plan_code: `PA-${String(n).padStart(4, '0')}`,
  revision: 1,
  supersedes_id: null,
  revision_reason: null,
  total_compensation_vnd: '0',
  total_support_vnd: '0',
  total_resettlement_vnd: '0',
  grand_total_vnd: '0',
  status: 'DRAFT',
  posting_started_on: null,
  posting_ends_on: null,
  posting_place_text: null,
  feedback_summary: null,
  approved_on: null,
  payment_due_on: null,
  decision_document_version_id: null,
  version: 1,
  ...overrides,
});

/** An item of a plan as the list answers it. */
export const planItemRecord = (n: number, planId: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0060', n),
  plan_id: planId,
  household_id: uuid('0030', 1),
  household_code: 'HH-000001',
  parcel_id: null,
  parcel_code: null,
  owner_unit_id: UNIT_XA,
  item_kind: 'SUPPORT_LIVELIHOOD',
  amount_vnd: '10000000',
  basis_inventory_id: null,
  quantity: null,
  unit_code: null,
  unit_price_vnd: null,
  price_decision_ref: null,
  price_decision_revision: null,
  legal_basis: 'Nghị định 88/2024/NĐ-CP',
  ...overrides,
});

/** An opinion on a posted plan as the list answers it. */
export const feedbackRecord = (n: number, planId: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0070', n),
  plan_id: planId,
  household_id: uuid('0030', 1),
  household_code: 'HH-000001',
  owner_unit_id: UNIT_XA,
  channel: 'MEETING',
  summary: 'Giá nhà quá thấp',
  status: 'OPEN',
  recorded_on: '2026-08-05',
  handled_on: null,
  handling_note: null,
  version: 1,
  ...overrides,
});

/** A payment of a plan as the list answers it (waiting, with the day it is due). */
export const paymentRecord = (n: number, planId: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0080', n),
  plan_id: planId,
  household_id: uuid('0030', 1),
  household_code: 'HH-000001',
  owner_unit_id: UNIT_XA,
  payment_no: 1,
  amount_vnd: '450000000',
  due_on: '2026-10-10',
  paid_on: null,
  method: null,
  bank_account_masked: null,
  treasury_transaction_id: null,
  advance_id: null,
  voucher_document_version_id: null,
  deposit_reason: null,
  late_reason: null,
  status: 'PENDING',
  version: 1,
  ...overrides,
});

/** A complaint as the list answers it (received, with the days left). */
export const complaintRecord = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0090', n),
  project_id: PROJECT,
  household_id: uuid('0030', 1),
  household_code: 'HH-000001',
  plan_id: null,
  owner_unit_id: UNIT_XA,
  complaint_no: `LC-${String(n).padStart(6, '0')}`,
  filed_on: '2026-09-15',
  channel: 'MEETING',
  subject: 'PRICE',
  description: 'Giá nhà quá thấp so với thị trường',
  status: 'RECEIVED',
  due_on: '2026-10-15',
  remaining_days: 5,
  resolved_on: null,
  resolution_note: null,
  resolution_document_version_id: null,
  issue_id: null,
  version: 1,
  ...overrides,
});

/** The timers of a plan as the read answers them. */
export const timersRecord = (planId: string, overrides: Record<string, unknown> = {}) => ({
  plan_id: planId,
  project_id: PROJECT,
  status: 'POSTING',
  posting_started_on: '2026-08-01',
  posting_ends_on: '2026-08-31',
  approved_on: null,
  payment_due_on: null,
  payment_remaining_days: null,
  feedback_open: 0,
  feedback_handled: 0,
  deadlines: [
    {
      id: uuid('0020', 2),
      timer_code: 'PLAN_POSTING_30',
      days_applied: 30,
      started_on: '2026-08-01',
      due_on: '2026-08-31',
      satisfied_on: null,
      status: 'RUNNING',
      remaining_days: 30,
      legal_basis: 'Luật Đất đai 2024 và Nghị định 88/2024/NĐ-CP — số ngày chờ xác nhận văn bản gốc [CXN-12]',
      awaiting_confirmation: true,
      cxn: 'CXN-12',
    },
  ],
  as_of: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

export const deadline = (overrides: Record<string, unknown> = {}) => ({
  id: uuid('0020', 1),
  timer_code: 'NOTICE_AGRICULTURAL_90',
  days_applied: 90,
  started_on: '2026-07-01',
  due_on: '2026-09-29',
  satisfied_on: null,
  status: 'RUNNING',
  legal_basis: 'Luật Đất đai 2024 và Nghị định 88/2024/NĐ-CP — số ngày chờ xác nhận văn bản gốc [CXN-12]',
  awaiting_confirmation: true,
  cxn: 'CXN-12',
  ...overrides,
});

export interface World {
  projects: Array<Record<string, unknown>>;
  parcels: Array<Record<string, unknown>>;
  households: Array<Record<string, unknown>>;
  inventory: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  planItems: Array<Record<string, unknown>>;
  /** The opinions on the plans, and the timers of a plan by its id. */
  feedback: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  complaints: Array<Record<string, unknown>>;
  allocations: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  timers: Record<string, Record<string, unknown>>;
  sections: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    projects: [
      { id: PROJECT, code: 'DA-2026-001', name: 'Đường tỉnh lộ 205' },
      { id: OTHER_PROJECT, code: 'DA-2026-002', name: 'Cầu qua sông' },
    ],
    parcels: [parcel(1), parcel(2, { land_use_group: 'NON_AGRICULTURAL_RESIDENTIAL', owner_unit_name: 'Trung tâm phát triển quỹ đất', parcel_code: 'TB-2/20', address_text: null })],
    households: [],
    inventory: [],
    plans: [],
    planItems: [],
    feedback: [],
    payments: [],
    complaints: [],
    allocations: [],
    candidates: [],
    timers: {},
    sections: [{ id: SECTION, code: 'KM-0-3', name: 'Km 0 đến km 3' }],
    units: [
      { id: UNIT_XA, code: 'XA1', name: 'UBND xã An Phú' },
      { id: UNIT_TTQD, code: 'TTQD', name: 'Trung tâm phát triển quỹ đất' },
    ],
    contracts: [{ id: CONTRACT, code: 'HD-A-001', project_id: PROJECT }],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({}), answer: (operation: string, input: unknown) => unknown = () => new Error('unexpected read')): Harness {
  const reads = (operation: string, input: unknown): unknown => {
    if (operation !== 'getCompensationPlanTimers') return answer(operation, input);
    return state.timers[(input as { path: { id: string } }).path.id] ?? new Error('no timers');
  };
  const h = baseHarness(reads, command);
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Record<string, string>; path?: Record<string, string> }) => Promise<unknown[]> }).readAll = vi.fn(
    (operation: string, input?: { query?: Record<string, string>; path?: Record<string, string> }) => {
      if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
      switch (operation) {
        case 'get_resources_project':
          return Promise.resolve(state.projects);
        case 'listLandParcels':
          return Promise.resolve(state.parcels.filter((item) => item.project_id === input?.query?.project_id));
        case 'listAffectedHouseholds':
          return Promise.resolve(state.households.filter((item) => item.project_id === input?.query?.project_id));
        case 'listInventoryRecords':
          return Promise.resolve(state.inventory.filter((item) => item.household_id === input?.query?.household_id));
        case 'listCompensationPlans':
          return Promise.resolve(state.plans.filter((item) => item.project_id === input?.query?.project_id));
        case 'listCompensationPlanItems':
          return Promise.resolve(state.planItems.filter((item) => item.plan_id === input?.path?.id));
        case 'listCompensationPayments':
          return Promise.resolve(state.payments.filter((item) => item.plan_id === input?.path?.id));
        case 'listLandComplaints':
          return Promise.resolve(state.complaints.filter((item) => item.project_id === input?.query?.project_id));
        case 'listResettlementAllocations':
          return Promise.resolve(state.allocations.filter((item) => item.project_id === input?.query?.project_id));
        case 'listResettlementCandidates':
          return Promise.resolve(state.candidates);
        case 'listPlanFeedback':
          return Promise.resolve(state.feedback.filter((item) => item.plan_id === input?.path?.id));
        case 'listLandSections':
          return Promise.resolve(state.sections);
        case 'get_resources_organization_unit':
          return Promise.resolve(state.units);
        case 'get_resources_contract':
          return Promise.resolve(state.contracts);
        default:
          return Promise.reject(new Error(`unexpected readAll ${operation}`));
      }
    },
  );
  return h;
}

export interface SessionOptions {
  permissions: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
}

/** Mounts a screen in a session with the given permissions and mode, at the given address. */
export function mount(screen: ReactElement, h: Harness, options: SessionOptions): RenderResult & { queries: QueryClient } {
  const session: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Admin', initials: 'AD' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: options.permissions,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    queries,
    ...render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={[options.path ?? '/']}>{screen}</MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  };
}
