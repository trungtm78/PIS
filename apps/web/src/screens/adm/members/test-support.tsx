import { ApiError } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import type { WebRoute } from '../../../routes/types';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionMode, SessionStatus, SessionTenant, SessionValue } from '../../../session/SessionContext';

export const SELF = '00000000-0000-4000-8000-0000000000a1';
export const UNIT_ONE = '00000000-0000-4000-8000-000000000f01';
export const UNIT_TWO = '00000000-0000-4000-8000-000000000f02';
export const CONTRACTOR_ONE = '00000000-0000-4000-8000-000000000c01';
export const CONTRACTOR_TWO = '00000000-0000-4000-8000-000000000c02';

export const TENANT: SessionTenant = { id: '00000000-0000-4000-8000-00000000000a', name: 'Cao Bang', monogram: 'CB', membershipId: SELF, theme: { themeId: 'tenant', version: 1, overlay: {} } };

export const ADMIN = ['membership.read', 'iam.member.invite', 'iam.member.manage', 'iam.guest.invite'];
export const READER = ['membership.read'];

export function routeOf(id: string, req: string): WebRoute {
  return { id, path: `/adm/${id.toLowerCase()}`, title: id, kind: 'list', area: 'admin', module: 'ADM', group: 'Admin', role: 'workspace', parent: null, req };
}

export function member(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
    user_account_id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`,
    display_name: `Person ${n}`,
    email: `p${n}@example.test`,
    phone: null,
    status: 'Active',
    organization_id: UNIT_ONE,
    membership_type: 'STAFF',
    valid_from: '2026-01-01T00:00:00Z',
    valid_until: null,
    version: 3,
    role_codes: ['MEMBER'],
    invitation_status: null,
    contractor_id: null,
    contractor_name: null,
    contracts: [],
    ...over,
  };
}

export function guest(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return member(n, {
    membership_type: 'GUEST_CONTRACTOR',
    contractor_id: CONTRACTOR_ONE,
    contractor_name: 'Cao Bang Builders',
    role_codes: ['GUEST_CONTRACTOR'],
    contracts: [{ id: '00000000-0000-4000-8000-000000000d01', code: 'GC-A1' }],
    valid_until: '2027-03-31T00:00:00Z',
    ...over,
  });
}

export function problem(code: string, status: number, detail?: string): ApiError {
  return new ApiError({ status, code, detail, correlationId: 'c1' });
}

export const unit = (id: string, code: string, name: string): Record<string, unknown> => ({ id, code, name });
export const contract = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `00000000-0000-4000-8000-000000000d${String(n).padStart(2, '0')}`,
  code: `GC-${n}`,
  status: 'ACTIVE',
  contractor_id: CONTRACTOR_ONE,
  contractor_name: 'Cao Bang Builders',
  project_id: '00000000-0000-4000-8000-000000000e01',
  owner_unit_id: UNIT_ONE,
  completion_due: '2027-03-31',
  ...over,
});
export const role = (code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `role-${code}`,
  code,
  name: code,
  rank: 10,
  permissions: [],
  is_system: false,
  guest_allowed: false,
  status: 'Active',
  version: 1,
  ...over,
});

export interface Answers {
  members?: Array<Record<string, unknown>> | Error;
  units?: Array<Record<string, unknown>> | Error;
  contracts?: Array<Record<string, unknown>> | Error;
  roles?: Array<Record<string, unknown>> | Error;
  /** The answer of `getMyUsage`; without one the read fails as an unexpected one. */
  usage?: Record<string, unknown> | Error;
  command?: (operation: string, input: unknown) => unknown;
}

export interface Harness {
  client: ApiClient;
  read: ReturnType<typeof vi.fn>;
  readAll: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
}

const settle = (value: unknown): Promise<unknown> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));

export function harness(answers: Answers = {}): Harness {
  const read = vi.fn((operation: string) => {
    if (operation === 'getMyUsage') return settle(answers.usage ?? new Error('unexpected read'));
    if (operation !== 'get_resources_membership') return settle(new Error('unexpected read'));
    const rows = answers.members ?? [];
    return settle(rows instanceof Error ? rows : { items: rows, next_cursor: null });
  });
  const readAll = vi.fn((operation: string) => {
    if (operation === 'get_resources_organization_unit') return settle(answers.units ?? []);
    if (operation === 'get_resources_contract') return settle(answers.contracts ?? []);
    if (operation === 'get_resources_role_definition') return settle(answers.roles ?? []);
    return settle(new Error('unexpected read'));
  });
  const command = vi.fn((operation: string, input: unknown) => settle(answers.command === undefined ? { operation_id: 'o', status: 'OK', resource_version: 2, resource_id: 'x' } : answers.command(operation, input)));
  return { client: { read, readAll, command } as unknown as ApiClient, read, readAll, command };
}

export interface MountOptions {
  permissions?: readonly string[] | undefined;
  mode?: SessionMode;
  status?: SessionStatus;
}

export function mount(screen: ReactElement, h: Harness, options: MountOptions = {}): RenderResult & { queries: QueryClient } {
  const session: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Admin', initials: 'AD' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: 'permissions' in options ? options.permissions : ADMIN,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.status === undefined ? {} : { status: options.status }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    queries,
    ...render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>{screen}</ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  };
}
