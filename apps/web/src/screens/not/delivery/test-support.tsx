import { ApiError } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import type { WebRoute } from '../../../routes/types';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionTenant, SessionValue } from '../../../session/SessionContext';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { harness };
export type { Harness };

export const TENANT: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bang',
  monogram: 'CB',
  membershipId: '00000000-0000-4000-8000-000000000001',
  theme: { themeId: 'tenant', version: 1, overlay: {} },
};

export const OPERATOR = ['delivery_attempt.read', 'notification.replay', 'notification.operate'];
export const READER = ['delivery_attempt.read'];

export function routeOf(id: string, req: string): WebRoute {
  return { id, path: `/not/${id.toLowerCase()}`, title: id, kind: 'table', area: 'engagement', module: 'NOT', group: 'Theo dõi vận hành', role: 'workspace', parent: null, req };
}

export interface MountOptions {
  permissions?: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  entry?: string;
}

export function mount(screen: ReactElement, h: Harness, options: MountOptions = {}): RenderResult {
  const session: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Operator', initials: 'OP' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: 'permissions' in options ? options.permissions : OPERATOR,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={h.client}>
          <MemoryRouter initialEntries={[options.entry ?? '/']}>{screen}</MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
}

export const failure = (status: number, code: string): ApiError => new ApiError({ status, code, correlationId: 'c' });

/** One attempt as the API answers it. */
export function rawAttempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a-1',
    notification_id: '11111111-aaaa-4aaa-8aaa-111111111111',
    notification_status: 'Queued',
    notification_version: 3,
    expires_at: '2026-10-25T03:00:00.000Z',
    ack_required: false,
    acknowledged_at: null,
    channel: 'EMAIL',
    attempt_no: 1,
    status: 'Queued',
    failure_class: null,
    error_code: null,
    provider_message_id: null,
    queued_at: '2026-10-24T03:00:00.000Z',
    next_retry_at: null,
    sending_at: null,
    accepted_at: null,
    delivered_at: null,
    read_at: null,
    failed_at: null,
    fallback_channel: 'SMS',
    needs_reconcile: false,
    reconcile_due_at: null,
    replay_of: null,
    ...overrides,
  };
}
