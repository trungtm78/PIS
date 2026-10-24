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

export const ME = '00000000-0000-4000-8000-000000000001';
export const OTHER = '00000000-0000-4000-8000-0000000000f1';

export const TENANT: SessionTenant = { id: '00000000-0000-4000-8000-00000000000a', name: 'Cao Bang', monogram: 'CB', membershipId: ME, theme: { themeId: 'tenant', version: 1, overlay: {} } };

export const PLANNER = ['capital.read', 'capital.appropriation.manage'];
export const APPROVER = ['capital.read', 'capital.appropriation.approve'];
export const READER = ['capital.read'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/cap/${id.toLowerCase()}`, title: id, kind: 'table', area: 'investment', module: 'CAP', group: 'Kế hoạch và nguồn vốn', role: 'workspace', parent: null, req });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const FUND_NSTW = uuid('0001', 1);
export const FUND_NSDP = uuid('0001', 2);
export const FUND_ODA = uuid('0001', 3);
export const PROGRAM_NTM = uuid('0002', 1);
export const DOCUMENT = uuid('0003', 1);
export const EXTENSION = uuid('0003', 2);
export const BILLION = 1_000_000_000;

const fund = (versionId: string, key: string, label: string, category: string, extra: Record<string, unknown> = {}) => ({
  version_id: versionId,
  business_key: key,
  label,
  category,
  relation: 'ADDITIVE',
  onlending: null,
  valid_from: '2020-01-01',
  valid_until: null,
  ...extra,
});

export const NSTW = fund(FUND_NSTW, 'NSTW-DTPT', 'Ngân sách trung ương đầu tư phát triển', 'NSTW');
export const NSDP = fund(FUND_NSDP, 'NSDP-DTPT', 'Ngân sách địa phương đầu tư phát triển', 'NSDP');
export const ODA = fund(FUND_ODA, 'ODA-WB', 'ODA Ngân hàng Thế giới', 'ODA', { onlending: true, valid_until: '2030-12-31' });

const vnd = (billions: number): string => String(billions * BILLION);

/** One line of the register as the API answers it (x-exposure dto). */
export const line = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0010', n),
  fund_source: NSTW,
  program: null,
  plan_year: 2026,
  origin: 'PM_ASSIGNED',
  budget_level: 'CENTRAL',
  amount_vnd: vnd(10),
  allocated_total_vnd: vnd(6),
  remaining_vnd: vnd(4),
  decision_document: { id: DOCUMENT, symbol: `${n}/QD-TTg`, issued_on: '2026-01-15' },
  issuing_authority: 'Thủ tướng Chính phủ',
  source_year: 2026,
  is_extended: false,
  extended_to: null,
  extension_document_id: null,
  revision: 1,
  supersedes_id: null,
  capital_plan_id: null,
  status: 'PUBLISHED',
  created_by: OTHER,
  approved_by: uuid('0030', 1),
  version: 2,
  ...overrides,
});

export const master = (versionId: string, masterType: string, businessKey: string, label: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0020', Number.parseInt(versionId.slice(-8), 10)),
  version_id: versionId,
  master_type: masterType,
  business_key: businessKey,
  label,
  status: 'EFFECTIVE',
  attributes: {},
  version: 1,
  ...overrides,
});

export interface World {
  lines: Array<Record<string, unknown>>;
  masters: Array<Record<string, unknown>>;
  /** Reads that fail, by operation, with the error they fail with. */
  failing: Map<string, unknown>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    lines: [
      line(1),
      line(2, { origin: 'LOCAL_ADDED', budget_level: 'LOCAL', fund_source: NSDP, amount_vnd: vnd(4), allocated_total_vnd: '0', remaining_vnd: vnd(4), issuing_authority: 'Hội đồng nhân dân tỉnh' }),
      line(3, { origin: 'CENTRAL_SUPPORT', amount_vnd: vnd(20), allocated_total_vnd: vnd(20), remaining_vnd: '0', plan_year: 2025, source_year: 2025 }),
      line(4, { origin: 'REVENUE_INCREASE', budget_level: 'LOCAL', fund_source: NSDP, amount_vnd: vnd(15), allocated_total_vnd: vnd(5), remaining_vnd: vnd(10), plan_year: 2025, source_year: 2025 }),
      line(5, { fund_source: ODA, amount_vnd: '1234567890', allocated_total_vnd: '0', remaining_vnd: '1234567890', status: 'DRAFT', version: 1, created_by: ME, approved_by: null }),
    ],
    masters: [
      master(FUND_NSTW, 'FUND_SOURCE', 'NSTW-DTPT', 'Ngân sách trung ương đầu tư phát triển', { attributes: { category: 'NSTW', relation: 'ADDITIVE' } }),
      master(FUND_NSDP, 'FUND_SOURCE', 'NSDP-DTPT', 'Ngân sách địa phương đầu tư phát triển', { attributes: { category: 'NSDP', relation: 'ADDITIVE' } }),
      master(uuid('0001', 9), 'FUND_SOURCE', 'CTMTQG-NTM', 'Nông thôn mới', { attributes: { category: 'CTMTQG', relation: 'SUBSET_OF' } }),
      master(uuid('0001', 8), 'FUND_SOURCE', 'OLD-SOURCE', 'Nguồn cũ', { status: 'RETIRED', attributes: { category: 'NSTW', relation: 'ADDITIVE' } }),
      master(PROGRAM_NTM, 'PROGRAM', 'NTM', 'Nông thôn mới'),
    ],
    failing: new Map(),
    ...overrides,
  };
}

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Record<string, string> }) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: { query?: Record<string, string> }) => {
    if (state.failing.has(operation)) return Promise.reject(state.failing.get(operation));
    switch (operation) {
      case 'listAppropriations':
        return Promise.resolve(state.lines);
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
