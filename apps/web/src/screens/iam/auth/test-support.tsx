import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import type { WebRoute } from '../../../routes/types';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';

export const TENANT = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bang',
  monogram: 'CB',
  membershipId: '00000000-0000-4000-8000-000000000001',
  theme: { themeId: 'tenant', version: 1, overlay: {} },
};

export function routeOf(id: string, req: string): WebRoute {
  return { id, path: `/iam/${id.toLowerCase()}`, title: id, kind: 'auth', area: 'overview', module: 'IAM', group: 'Truy cập', role: 'workspace', parent: null, req };
}

/** A visitor with nobody signed in yet, as a real sign-in provides it; `overrides` adds what a test needs. */
export const SIGNED_OUT: SessionValue = {
  status: 'signedOut',
  tenant: undefined,
  tenants: [],
  user: undefined,
  access: ALL_MODULES_VISIBLE,
  switchTenant: () => undefined,
  getSession: () => Promise.resolve(undefined),
};

export function mountAuth(screen: ReactElement, overrides: Partial<SessionValue> = {}, path = '/'): RenderResult {
  return render(
    <SessionContext.Provider value={{ ...SIGNED_OUT, ...overrides }}>
      <MemoryRouter initialEntries={[path]}>{screen}</MemoryRouter>
    </SessionContext.Provider>,
  );
}
