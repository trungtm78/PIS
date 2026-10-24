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

export const MANAGER = ['contractor.read', 'bid.contractor.manage'];
export const VERIFIER = ['contractor.read', 'bid.contractor.verify', 'bid.contractor.read'];
export const READER = ['contractor.read'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/bid/${id.toLowerCase()}`, title: id, kind: 'list', area: 'investment', module: 'BID', group: 'Đấu thầu', role: 'workspace', parent: null, req });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const DOCUMENT = uuid('0002', 1);
export const MASTER = uuid('0003', 1);

export const line = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0010', n),
  tax_identifier: `010****56${n}`,
  tax_identifier_masked: true,
  legal_name: `Công ty nhà thầu ${n}`,
  legal_form: 'TNHH',
  verification_status: 'UNVERIFIED',
  verification_basis: null,
  identity_lookup: null,
  master_record_id: null,
  contract_count: 0,
  verified_at: null,
  restriction_in_force: null,
  version: 1,
  ...overrides,
});

export const verifiedLine = (n: number, overrides: Record<string, unknown> = {}) =>
  line(n, { verification_status: 'VERIFIED', verification_basis: 'EVIDENCE_DOCUMENT', verified_at: '2026-10-20T02:00:00.000000Z', contract_count: 2, ...overrides });

export const restriction = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0020', n),
  kind: 'DEBARMENT',
  source: 'DECISION',
  effective_from: '2026-01-01',
  effective_until: '2027-12-31',
  ...overrides,
});

export const detail = (n: number, overrides: Record<string, unknown> = {}) => ({
  ...line(n),
  tax_identifier: `010123456${n}`,
  tax_identifier_masked: false,
  profile_document_id: DOCUMENT,
  verified_by: null,
  verification_evidence_document_id: null,
  restrictions: [],
  ...overrides,
});

export interface World {
  contractors: Array<Record<string, unknown>>;
  details: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
  /** The answer of the read of one contractor when it is not in `details`. */
  missing?: Error;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    contractors: [line(1), verifiedLine(2, { restriction_in_force: restriction(1) })],
    details: [detail(1)],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_contractor_id') {
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
      return state.details.find((item) => item.id === id) ?? state.missing ?? new Error('not found');
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_contractor') return Promise.resolve(state.contractors);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
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
