import { ApiError } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';
import { TENANT_A } from '../../test/render';

export const ME = TENANT_A.membershipId;
export const OTHER = '00000000-0000-4000-8000-0000000000aa';

export const failure = (status: number, code = 'FAILED') => new ApiError({ status, code, correlationId: 'corr' });

export function rawItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'PERMIT',
    source: 'PERMIT',
    severity: 'ACTION',
    title: `Việc ${id}`,
    subtitle: 'Gói thầu 01',
    status: 'OPEN',
    due_on: '2999-12-31',
    original_due_on: '2999-12-31',
    bucket: 'LATER',
    overdue: false,
    days_late: 0,
    target: { screen: 'PRJ-19', id },
    lifecycle: 'NEW',
    claimed_by: null,
    assignee: null,
    escalation: null,
    consequence: null,
    snoozed_until: null,
    ...overrides,
  };
}

export const listAnswer = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  view: 'mine',
  items,
  counts: { urgent: 0, action: items.length, watch: 0, total: items.length },
  unavailable_sources: [],
  as_of: '2026-11-07T02:15:00Z',
  next_cursor: null,
  ...extra,
});

export const countsAnswer = (urgent: number, action: number, watch: number, extra: Record<string, unknown> = {}) => ({
  view: 'mine',
  counts: { urgent, action, watch, total: urgent + action + watch },
  unavailable_sources: [],
  as_of: '2026-11-07T02:15:00Z',
  ...extra,
});

export const STAFF = [
  { id: OTHER, display_name: 'Trần Bình', status: 'Active', membership_type: 'STAFF' },
  { id: '00000000-0000-4000-8000-0000000000ab', display_name: 'Lê Chi', status: 'Active', membership_type: 'STAFF' },
];

export interface Harness {
  client: ApiClient;
  read: ReturnType<typeof vi.fn>;
  readAll: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
}

/** A fake of the HTTP boundary: reads are answered by `answer(operation, input)` (a value, or an Error to reject with). */
export function harness(answer: (operation: string, input: unknown) => unknown, command: (operation: string, input: unknown) => unknown = () => ({}), people: () => unknown[] | Error = () => STAFF): Harness {
  const respond = (value: unknown): Promise<unknown> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const read = vi.fn((operation: string, input?: unknown) => respond(answer(operation, input)));
  const readAll = vi.fn((operation: string) => (operation === 'get_resources_membership' ? respond(people()) : Promise.reject(new Error(`unexpected readAll ${operation}`))));
  const cmd = vi.fn((operation: string, input: unknown) => respond(command(operation, input)));
  return { client: { read, readAll, command: cmd } as unknown as ApiClient, read, readAll, command: cmd };
}

const viewOf = (input: unknown): string => (input as { query?: { view?: string } } | undefined)?.query?.view ?? 'mine';

/** Counts and list by view; a view that is missing answers 403. */
export function alertsBackend(views: Partial<Record<'mine' | 'scope', { counts: unknown; list: unknown }>>) {
  return (operation: string, input: unknown): unknown => {
    const entry = views[viewOf(input) as 'mine' | 'scope'];
    if (entry === undefined) return failure(403, 'FORBIDDEN');
    if (operation === 'getMyWorkCounts') return entry.counts;
    if (operation === 'getMyWork') return entry.list;
    return new Error(`unexpected read ${operation}`);
  };
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

export interface MountResult extends RenderResult {
  queries: QueryClient;
}

/** Renders a component under a router, a query client, a session and the fake client. */
export function mount(element: ReactElement, h: Harness, path = '/'): MountResult {
  const session: SessionValue = {
    tenant: TENANT_A,
    tenants: [TENANT_A],
    user: { displayName: 'Nguyễn An', initials: 'NA' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={h.client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="*" element={element} />
            </Routes>
            <Where />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return Object.assign(view, { queries });
}

/** The providers around a hook under test (`renderHook(..., { wrapper })`). */
export function hookWrapper(h: Harness): { wrapper: (props: { children: ReactNode }) => ReactElement; queries: QueryClient } {
  const session: SessionValue = {
    tenant: TENANT_A,
    tenants: [TENANT_A],
    user: { displayName: 'Nguyễn An', initials: 'NA' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={h.client}>{children}</ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>
  );
  return { wrapper, queries };
}
