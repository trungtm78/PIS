import { ApiError } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import { SessionContext } from '../session/SessionContext';
import type { SessionValue } from '../session/SessionContext';
import { TENANT_A } from './render';

export const NOTIFICATION_IDS = {
  approval: '00000000-0000-4000-8000-0000000000a1',
  report: '00000000-0000-4000-8000-0000000000a2',
  budget: '00000000-0000-4000-8000-0000000000a3',
  gone: '00000000-0000-4000-8000-0000000000a4',
} as const;

export interface RawNotification {
  id: string;
  title: string;
  priority: string;
  status: string;
  ack_required?: boolean;
  read_at?: string;
  acknowledged_at?: string;
  resource_ref?: string;
}

/** The inbox of the mockup: an approval that needs action, a report, a budget alert that needs action, and one the member lost access to. */
export function inbox(): RawNotification[] {
  return [
    { id: NOTIFICATION_IDS.approval, title: 'notification.event.pay.request.submitted.title', priority: 'HIGH', status: 'Delivered', ack_required: true, resource_ref: '/pay/pay-03/1' },
    { id: NOTIFICATION_IDS.report, title: 'notification.event.dis.report.submitted.title', priority: 'NORMAL', status: 'Delivered', read_at: '2026-10-22T02:18:00Z' },
    { id: NOTIFICATION_IDS.budget, title: 'notification.event.llm.budget.warning.title', priority: 'CRITICAL', status: 'Delivered', ack_required: true, resource_ref: 'https://example.org/steal' },
    { id: NOTIFICATION_IDS.gone, title: 'notification.content.unavailable.title', priority: 'NORMAL', status: 'Delivered' },
  ];
}

export interface Harness {
  client: ApiClient;
  read: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
}

type Page = { items: RawNotification[]; next_cursor: string | null };

/** A fake client: `pages` are served in order for the successive `listMyNotifications` calls (the last one repeats). */
export function harness(pages: Page[] | Error = [{ items: inbox(), next_cursor: null }]): Harness {
  let call = 0;
  const read = vi.fn((operation?: string) => {
    // The alert bell of the shell reads its own counts; they are not a page of the inbox and must not use one up.
    if (operation === 'getMyWorkCounts') return Promise.resolve({ view: 'mine', counts: { urgent: 0, action: 0, watch: 0, total: 0 }, unavailable_sources: [], as_of: '2026-10-22T03:00:00Z' });
    if (operation === 'getMyWork') return Promise.reject(new Error('not part of the inbox'));
    if (pages instanceof Error) return Promise.reject(pages);
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return Promise.resolve(page);
  });
  const command = vi.fn(() => Promise.resolve({ operation_id: 'op-1', status: 'READ', resource_version: 2 }));
  return { client: { read, readAll: vi.fn(), command } as unknown as ApiClient, read, command };
}

export function problem(code: string, status: number): ApiError {
  return new ApiError({ status, code, correlationId: 'corr-1' });
}

export interface MountOptions {
  path: string;
  /** The route element(s) to render, keyed by path pattern. */
  routes: Record<string, ReactNode>;
  user?: SessionValue['user'];
  tenant?: SessionValue['tenant'];
}

/** Renders screens under a router, a query client, a session and the fake client. */
export function mount(h: Harness, options: MountOptions): RenderResult & { queries: QueryClient } {
  const session: SessionValue = {
    tenant: options.tenant ?? TENANT_A,
    tenants: [TENANT_A],
    user: options.user ?? { displayName: 'Nguyễn An', initials: 'AN' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={h.client}>
          <MemoryRouter initialEntries={[options.path]}>
            <Routes>
              {Object.entries(options.routes).map(([pattern, element]) => (
                <Route key={pattern} path={pattern} element={element} />
              ))}
            </Routes>
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return Object.assign(view, { queries });
}
