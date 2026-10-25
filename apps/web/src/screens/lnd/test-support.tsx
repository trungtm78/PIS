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
  const h = baseHarness(answer, command);
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Record<string, string> }) => Promise<unknown[]> }).readAll = vi.fn(
    (operation: string, input?: { query?: Record<string, string> }) => {
      if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
      switch (operation) {
        case 'get_resources_project':
          return Promise.resolve(state.projects);
        case 'listLandParcels':
          return Promise.resolve(state.parcels.filter((item) => item.project_id === input?.query?.project_id));
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
