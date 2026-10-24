import { ApiError } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionTenant, SessionValue } from '../../session/SessionContext';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';
import { permitType } from './test-support';

export type { Harness };

export const TENANT: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bang',
  monogram: 'CB',
  membershipId: '00000000-0000-4000-8000-000000000001',
  theme: { themeId: 'tenant', version: 1, overlay: {} },
};

/** The officer who manages and records, the one who may only manage, and the one who may only read. */
export const OFFICER = ['permit.manage', 'permit.record', 'permit.read'];
export const MANAGER_ONLY = ['permit.manage', 'permit.read'];
export const READ_ONLY = ['permit.read'];

export const TODAY = '2026-10-24';

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const dossierId = (n: number): string => uuid('0101', n);
export const permitId = (n: number): string => uuid('0102', n);
export const projectId = (n: number): string => uuid('0103', n);
export const DOCUMENT = uuid('0104', 1);
export const OWNER_UNIT = uuid('0105', 1);

/** A row of the dossier list, in the shape the server writes it. */
export const dossierLine = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: dossierId(n),
  project_id: projectId(n),
  project_code: `DA-2026-00${n}`,
  project_name: `Dự án số ${n}`,
  project_component_id: null,
  project_component_code: null,
  owner_unit_id: OWNER_UNIT,
  owner_unit_name: 'Ban QLDA tỉnh',
  owner_membership: null,
  status: 'OPEN',
  readiness_pct: '50.00',
  required_count: 2,
  satisfied_count: 1,
  issued_count: 1,
  expiring_count: 0,
  unconfirmed_count: 0,
  version: 1,
  ...overrides,
});

/** A permit of a dossier, in the shape the server writes it. */
export const permitLine = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: permitId(n),
  permit_type_id: uuid('0106', n),
  permit_type_code: `PERMIT_${n}`,
  permit_type_revision: 1,
  permit_type_name: `Giấy phép ${n}`,
  cxn_ref: null,
  exemption_allowed: false,
  is_required: true,
  status: 'PLANNED',
  permit_no: null,
  authority_name: 'Sở Xây dựng',
  submitted_on: null,
  expected_decision_on: null,
  issued_on: null,
  valid_from: null,
  valid_until: null,
  no_expiry: false,
  supersedes_id: null,
  responsible_membership: null,
  version: 1,
  ...overrides,
});

export const dossier = (n: number, permits: Array<Record<string, unknown>> = [permitLine(1)], overrides: Record<string, unknown> = {}) => ({ ...dossierLine(n), permits, ...overrides });

export const milestone = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0107', n),
  step_code: 'SUBMITTED',
  planned_on: null,
  actual_on: '2026-10-01',
  note: null,
  document_version_id: null,
  created_at: '2026-10-01T02:00:00.000000Z',
  ...overrides,
});

export const permitDetail = (n: number, overrides: Record<string, unknown> = {}) => ({
  ...permitLine(n),
  dossier_id: dossierId(1),
  project_id: projectId(1),
  project_code: 'DA-2026-001',
  project_name: 'Dự án số 1',
  document_version_id: null,
  exemption_basis: null,
  exemption_decision_document_version_id: null,
  revoke_reason: null,
  revocation_document_version_id: null,
  milestones: [],
  ...overrides,
});

export const projectRow = (n: number, overrides: Record<string, unknown> = {}) => ({ id: projectId(n), code: `DA-2026-00${n}`, name: `Dự án số ${n}`, owner_unit_id: OWNER_UNIT, ...overrides });

const NOT_FOUND = new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });

export interface World {
  dossiers: Array<Record<string, unknown>>;
  /** The detail answers of `get_resources_permit_dossier_id`, by dossier id. */
  dossierDetails: Array<Record<string, unknown>>;
  permits: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  types: Array<Record<string, unknown>>;
  /** The rows `listExpiringPermits` answers for the window it was asked with. */
  expiring?: (query: Record<string, unknown>) => Array<Record<string, unknown>>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { dossiers: [], dossierDetails: [], permits: [], projects: [], types: [permitType(1, { code: 'PERMIT_1' }), permitType(2, { code: 'PERMIT_2' })], failing: new Set(), ...overrides };
}

/** A client over `state`: reads are answered from it, `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
    if (operation === 'get_resources_permit_dossier_id') return state.dossierDetails.find((item) => item.id === id) ?? NOT_FOUND;
    if (operation === 'get_resources_permit_id') return state.permits.find((item) => item.id === id) ?? NOT_FOUND;
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Record<string, unknown> }) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: { query?: Record<string, unknown> }) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_permit_dossier':
        return Promise.resolve(state.dossiers);
      case 'get_resources_project':
        return Promise.resolve(state.projects);
      case 'get_resources_permit_type':
        return Promise.resolve(state.types);
      case 'listExpiringPermits':
        return Promise.resolve(state.expiring?.(input?.query ?? {}) ?? []);
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
