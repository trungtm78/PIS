import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ApiClientProvider } from '../../../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../../../navigation/model';
import { SessionContext } from '../../../../session/SessionContext';
import type { SessionMode, SessionValue } from '../../../../session/SessionContext';
import { PLATFORM_TENANT } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';

/** Mounts a screen like the shared test support does, and lets the test say the mode of the session (read-only freezes every write). */
export function mountAs(screen: ReactElement, h: Harness, options: { permissions?: readonly string[] | undefined; mode?: SessionMode; path?: string } = {}) {
  const session: SessionValue = {
    tenant: PLATFORM_TENANT,
    tenants: [PLATFORM_TENANT],
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
