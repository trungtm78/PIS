import type { ApiClient } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { t } from '../../i18n';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';

export const TENANT = { id: '00000000-0000-4000-8000-00000000000a', name: 'Cao Bằng', monogram: 'CB', membershipId: '00000000-0000-4000-8000-0000000000e9', theme: { themeId: 'tenant', version: 1, overlay: {} } };

export interface PwaHarness {
  client: ApiClient;
  read: ReturnType<typeof vi.fn>;
  readAll: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
}

/** A client whose reads and commands are answered by the functions given (a value, or an Error to reject with). */
export function pwaClient(answers: { read?: (operation: string, input: unknown) => unknown; readAll?: (operation: string, input: unknown) => unknown; command?: (operation: string, input: unknown) => unknown }): PwaHarness {
  const respond = (value: unknown): Promise<unknown> => (value instanceof Error ? Promise.reject(value) : value instanceof Promise ? value : Promise.resolve(value));
  const read = vi.fn((operation: string, input?: unknown) => respond(answers.read?.(operation, input) ?? new Error(`unexpected read ${operation}`)));
  const readAll = vi.fn((operation: string, input?: unknown) => respond(answers.readAll?.(operation, input) ?? new Error(`unexpected readAll ${operation}`)));
  const command = vi.fn((operation: string, input: unknown) => respond(answers.command?.(operation, input) ?? { operation_id: 'op-1', status: 'OK', resource_version: 2 }));
  return { client: { read, readAll, command } as unknown as ApiClient, read, readAll, command };
}

export interface MountOptions {
  permissions?: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
  session?: Partial<SessionValue>;
}

export function mountPwa(screen: ReactElement, harness: PwaHarness, options: MountOptions = {}): RenderResult & { queries: QueryClient } {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const session: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Lãnh đạo', initials: 'LD' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    ...('permissions' in options ? { permissions: options.permissions } : {}),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...options.session,
  };
  return {
    queries,
    ...render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={harness.client}>
            <MemoryRouter initialEntries={[options.path ?? '/m']}>{screen}</MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  };
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const FAR_PAST = '2020-01-01T08:00:00.000Z';
export const FAR_FUTURE = '2099-01-01T08:00:00.000Z';

/** One pending approval task as `get_resources_approval_task` returns it. */
export function approvalTask(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(n),
    step_id: 'review',
    step_name: 'Rà soát số liệu kỳ',
    due_at: FAR_FUTURE,
    status: 'Pending',
    business_type: 'report.accept',
    resource: { type: 'report', id: uuid(900 + n) },
    version: 3,
    overdue: false,
    escalated_at: null,
    instance: { id: uuid(100 + n), version: 7, amount_vnd: '2500000000', unit_id: uuid(1) },
    actions: { decide: true },
    ...extra,
  };
}
export const taskId = uuid;

/** The Vietnamese text of a key (the catalogue and the parts, as the translator reads them). */
export const word = (key: string, params?: Record<string, string | number>): string => t(key, params);
