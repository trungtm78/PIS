import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../App';
import type { ScreenLoader } from '../routes/types';
import { SessionContext } from '../session/SessionContext';
import type { SessionTenant, SessionValue } from '../session/SessionContext';
import { ALL_MODULES_VISIBLE } from '../navigation/model';

export const TENANT_A: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bằng',
  monogram: 'CB',
  membershipId: '00000000-0000-4000-8000-0000000000f1',
  theme: { themeId: 'theme-a', version: 3, overlay: { primary: '#007D77', primaryText: '#FFFFFF' } },
};

export const TENANT_B: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000b',
  name: 'Lào Cai',
  monogram: 'LC',
  membershipId: '00000000-0000-4000-8000-0000000000f1',
  theme: { themeId: 'theme-b', version: 9, overlay: { primary: '#0B5CAD', primaryText: '#FFFFFF' } },
};

interface StatefulSessionProps {
  tenants: readonly SessionTenant[];
  overrides?: Partial<SessionValue>;
  children: ReactNode;
}

/** A session whose tenant can be switched, like the development provider, without any dev-only import. */
function StatefulSession({ tenants, overrides, children }: StatefulSessionProps) {
  const [tenantId, setTenantId] = useState(tenants[0]?.id);
  const value: SessionValue = {
    tenant: tenants.find((tenant) => tenant.id === tenantId),
    tenants,
    user: { displayName: 'Nguyễn An', initials: 'AN' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: setTenantId,
    getSession: () => Promise.resolve({ token: 'test-token' }),
    ...overrides,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export interface RenderAppOptions {
  tenants?: readonly SessionTenant[];
  session?: Partial<SessionValue>;
  /** Screen implementations by id; the default is none, so shell tests see the fallback and never depend on a screen that has landed. */
  screens?: Record<string, ScreenLoader>;
}

/** Renders the routed application at a path with a test session. */
export function renderApp(path: string, options: RenderAppOptions = {}): RenderResult {
  const { tenants = [TENANT_A, TENANT_B], session, screens = {} } = options;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <StatefulSession tenants={tenants} overrides={session}>
      <QueryClientProvider client={queries}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes screenModules={screens} />
        </MemoryRouter>
      </QueryClientProvider>
    </StatefulSession>,
  );
}

/** Makes `window.matchMedia` answer the given media queries; the rest do not match. */
export function mockMatchMedia(matching: (query: string) => boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: matching(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
