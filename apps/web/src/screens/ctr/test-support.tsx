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

export const MAKER = ['contract.read', 'contract.create', 'contract.update'];
export const READER = ['contract.read'];
export const BOQ_MANAGER = ['contract.read', 'boq.manage', 'boq_line.read'];
export const BOQ_READER = ['contract.read', 'boq_line.read'];
export const GUARANTEE_OFFICER = ['contract.read', 'guarantee.read', 'guarantee.manage'];
export const ACCOUNTANT = ['guarantee.read', 'guarantee.verify', 'guarantee.release', 'guarantee.manage'];
export const GUARANTEE_READER = ['guarantee.read'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/ctr/${id.toLowerCase()}`, title: id, kind: 'table', area: 'investment', module: 'CTR', group: 'Hợp đồng & điều khoản', role: 'workspace', parent: null, req });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0001', 1);
export const PACKAGE = uuid('0002', 1);
export const LEAD = uuid('0003', 1);
export const SECOND = uuid('0003', 2);
export const THIRD = uuid('0003', 3);
export const DOCUMENT = uuid('0004', 1);

export const contractId = (n: number): string => uuid('0010', n);

export const line = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: contractId(n),
  code: `HD-A-00${n}`,
  title: `Hợp đồng số ${n}`,
  status: 'DRAFT',
  type: 'LUMP_SUM',
  project_id: PROJECT,
  project_code: 'DA-2026-001',
  project_name: 'Dự án cầu',
  package_id: PACKAGE,
  contractor_id: LEAD,
  contractor_name: 'Công ty Xây dựng An Phát',
  owner_unit_id: uuid('0005', 1),
  is_joint_venture: false,
  contract_value_vnd: '10200000000',
  estimate_ceiling_vnd: '10200000000',
  completion_due: '2027-12-31',
  version: 1,
  ...overrides,
});

export const revision = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0011', n),
  contract_id: contractId(n),
  contract_code: `HD-A-00${n}`,
  revision: 1,
  kind: 'BASE',
  status: 'DRAFT',
  amount_vnd: '10200000000',
  document_version_id: DOCUMENT,
  valid_from: '2026-10-24',
  valid_until: null,
  retroactive: false,
  decided_at: null,
  version: 1,
  created_at: '2026-10-24T01:00:00.000Z',
  ...overrides,
});

export const party = (n: number, contractorId: string, name: string, role: string, share: string, work: string) => ({
  id: uuid('0012', n),
  contractor_id: contractorId,
  contractor_name: name,
  role,
  share_pct: share,
  work_value_vnd: work,
  valid_from: '2026-10-24',
  valid_until: null,
  version: 1,
});

export const boqLine = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0013', n),
  contract_id: contractId(1),
  contract_code: 'HD-A-001',
  contract_revision_id: uuid('0011', 1),
  revision: 1,
  revision_status: 'DRAFT',
  line_no: n,
  business_key: `B0${n}`,
  description: `Hạng mục ${n}`,
  unit_code: 'M3',
  quantity: '3',
  unit_price: '1234.5',
  rounding_rule: 'HALF_UP',
  amount_vnd: '3704',
  retention_pct: '5.0000',
  milestone_code: null,
  milestone_due_on: null,
  party_contractor_id: null,
  party_name: null,
  boq_item_id: uuid('0014', n),
  ...overrides,
});

export const guarantee = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0015', n),
  contract_id: contractId(1),
  contract_code: 'HD-A-001',
  kind: 'PERFORMANCE',
  issuer: 'Ngân hàng Tỉnh',
  guarantee_no: `BL-A-00${n}`,
  party_contractor_id: null,
  party_name: null,
  amount_vnd: '500000000',
  currency: 'VND',
  valid_from: '2026-03-01',
  expires_at: '2026-12-31T16:59:00.000Z',
  expires_on: '2026-12-31',
  status: 'PENDING_VERIFICATION',
  verification_status: 'UNVERIFIED',
  last_alert_days: null,
  extended_from_id: null,
  version: 1,
  registered_by: uuid('0030', 7),
  ...overrides,
});

export const detail = (n: number, overrides: Record<string, unknown> = {}) => ({
  ...line(n),
  advance_category: 'CONSTRUCTION',
  requires_quality_acceptance: true,
  signed_on: null,
  effective_from: null,
  status_reason: null,
  created_at: '2026-10-24T01:00:00.000Z',
  updated_at: '2026-10-24T01:00:00.000Z',
  revisions: [revision(n)],
  parties: [],
  parties_check: { share_total: '0', work_value_total_vnd: '0', shares_complete: false, work_matches_value: false },
  status_changes: [],
  created_by: uuid('0030', 1),
  ...overrides,
});

export const option = (id: string, extra: Record<string, unknown>) => ({ id, ...extra });

export interface World {
  contracts: Array<Record<string, unknown>>;
  details: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  contractors: Array<Record<string, unknown>>;
  boqLines: Array<Record<string, unknown>>;
  guarantees: Array<Record<string, unknown>>;
  /** The answer of the read of the guarantees about to expire, by window. */
  expiring: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
  /** The answer of the read of one contract when it is not in `details`. */
  missing?: Error;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    contracts: [line(1), line(2, { status: 'ACTIVE', is_joint_venture: true, contractor_name: 'Liên danh Hà Giang', contract_value_vnd: '25000000000', completion_due: null, title: null })],
    details: [detail(1)],
    projects: [option(PROJECT, { code: 'DA-2026-001', name: 'Dự án cầu' }), option(uuid('0001', 2), { code: 'DA-2026-002', name: 'Dự án đường' })],
    contractors: [
      option(LEAD, { legal_name: 'Công ty Xây dựng An Phát', verification_status: 'VERIFIED' }),
      option(SECOND, { legal_name: 'Công ty Cơ khí Bình Minh', verification_status: 'VERIFIED' }),
      option(THIRD, { legal_name: 'Công ty chưa xác minh', verification_status: 'UNVERIFIED' }),
    ],
    boqLines: [],
    guarantees: [],
    expiring: [],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_contract_id') {
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
      return state.details.find((item) => item.id === id) ?? state.missing ?? new Error('not found');
    }
    if (operation === 'listExpiringGuarantees') return { items: state.expiring, next_cursor: null, as_of: '2026-10-24T00:00:00.000Z', within_days: (input as { query?: { within_days?: number } } | undefined)?.query?.within_days };
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      case 'get_resources_project':
        return Promise.resolve(state.projects);
      case 'get_resources_contractor':
        return Promise.resolve(state.contractors);
      case 'get_resources_boq_line':
        return Promise.resolve(state.boqLines);
      case 'get_resources_guarantee':
        return Promise.resolve(state.guarantees);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
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
