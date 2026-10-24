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

export const MAKER = ['project.read', 'project.create', 'project.update'];
export const READER = ['project.read'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/prj/${id.toLowerCase()}`, title: id, kind: 'list', area: 'investment', module: 'PRJ', group: 'Danh mục & theo dõi', role: 'workspace', parent: null, req });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const UNIT_PROVINCE = uuid('0001', 1);
export const UNIT_DEPARTMENT = uuid('0001', 2);
export const AREA = uuid('0002', 1);
export const AREA_2 = uuid('0002', 2);
export const SECTOR = uuid('0003', 1);
export const SECTOR_2 = uuid('0003', 2);
export const PROJECT_TYPE = uuid('0004', 1);
export const PROGRAM = uuid('0005', 1);

export const line = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0010', n),
  code: `DA-2026-00${n}`,
  name: `Dự án số ${n}`,
  owner_unit_id: UNIT_DEPARTMENT,
  owner_unit_name: 'Sở Giao thông',
  investor_unit_id: UNIT_PROVINCE,
  investor_unit_name: 'Ban QLDA tỉnh',
  project_group: null,
  status: 'CONCEPT',
  national_project_code: null,
  leader_in_charge: null,
  version: 1,
  ...overrides,
});

export const detail = (n: number, overrides: Record<string, unknown> = {}) => ({
  ...line(n),
  decision_authority_unit_id: UNIT_PROVINCE,
  decision_authority_unit_name: 'UBND tỉnh',
  area: { version_id: AREA, business_key: 'TINH-P', label: 'Tỉnh P' },
  sector: { version_id: SECTOR, business_key: 'TRANSPORT', label: 'Giao thông' },
  project_type: null,
  program: null,
  classification: 'INTERNAL',
  total_investment_vnd: '500000000000',
  start_year: 2026,
  end_year: 2028,
  appraisal_score: null,
  pipeline_priority: null,
  status_changed_at: '2026-10-24T01:00:00.000Z',
  created_at: '2026-10-24T01:00:00.000Z',
  proposed_on: '2026-10-24',
  group_suggestion: { group_key: 'B', sector_key: null, as_of: '2026-10-24', rule_version_id: uuid('0006', 1), rule_revision: 1, legal_basis: 'Luật 58/2024/QH15', awaiting_confirmation: true, cxn: 'CXN-32' },
  ...overrides,
});

export const unit = (id: string, code: string, name: string) => ({ id, code, name });
export const master = (versionId: string, masterType: string, businessKey: string, label: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0020', Number.parseInt(versionId.slice(-8), 10)),
  version_id: versionId,
  master_type: masterType,
  business_key: businessKey,
  label,
  status: 'EFFECTIVE',
  version: 1,
  ...overrides,
});

export interface World {
  projects: Array<Record<string, unknown>>;
  details: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  masters: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
  /** The answer of the read of one project when it is not in `details`. */
  missing?: Error;
  /** The grants of the caller as `getMyEffectiveAccess` lists them; by default one grant on the whole tenant that carries every project permission. */
  grants?: Array<Record<string, unknown>>;
}

export const WHOLE_TENANT_GRANT = { role_code: 'PLANNER', scope_kind: 'TENANT', permissions: ['project.*'], state: 'ACTIVE' };
export const UNIT_GRANT = { role_code: 'PLANNER', scope_kind: 'UNIT_SUBTREE', permissions: ['project.*'], state: 'ACTIVE' };

export function world(overrides: Partial<World> = {}): World {
  return {
    projects: [line(1), line(2, { status: 'IMPLEMENTATION', national_project_code: '7654321', project_group: 'B', leader_in_charge: { membership_id: uuid('0030', 1), display_name: 'Nguyễn Văn An' } })],
    details: [detail(1)],
    units: [unit(UNIT_PROVINCE, 'U1', 'Ban QLDA tỉnh'), unit(UNIT_DEPARTMENT, 'U2', 'Sở Giao thông')],
    masters: [
      master(AREA, 'AREA', 'TINH-P', 'Tỉnh P'),
      master(AREA_2, 'AREA', 'TINH-Q', 'Tỉnh Q'),
      master(SECTOR, 'SECTOR', 'TRANSPORT', 'Giao thông'),
      master(SECTOR_2, 'SECTOR', 'ENERGY', 'Năng lượng'),
      master(PROJECT_TYPE, 'PROJECT_TYPE', 'CAPITAL_WORKS', 'Xây dựng cơ bản'),
      master(PROGRAM, 'PROGRAM', 'NTM', 'Nông thôn mới'),
      master(uuid('0003', 9), 'SECTOR', 'OLD', 'Lĩnh vực cũ', { status: 'RETIRED' }),
    ],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_project_id') {
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
      return state.details.find((item) => item.id === id) ?? state.missing ?? new Error('not found');
    }
    if (operation === 'getMyEffectiveAccess') return { membership_id: TENANT.membershipId, scope_version: 1, grants: state.grants ?? [WHOLE_TENANT_GRANT] };
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Record<string, string> }) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: { query?: Record<string, string> }) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_project':
        return Promise.resolve(state.projects);
      case 'get_resources_organization_unit':
        return Promise.resolve(state.units);
      case 'searchMasterRecords':
        return Promise.resolve(state.masters.filter((item) => input?.query?.master_type === undefined || item.master_type === input.query.master_type));
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
