import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TENANT } from './dev-tenants';
import DevSessionProvider from './DevSessionProvider';
import { useSession } from './SessionContext';

const KEY = Buffer.alloc(32, 9).toString('base64');
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e9';
const TENANTS = [{ ...PLATFORM_TENANT, membershipId: MEMBERSHIP }];

const claimsOf = (token: string | undefined): Record<string, unknown> => JSON.parse(Buffer.from((token ?? '').split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

describe('DevSessionProvider for a control-plane user', () => {
  it('signs tokens of the control audience with the realm roles and scope version 0 on the platform tenant', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DevSessionProvider keyBase64={KEY} tenants={TENANTS} controlRoles={['SystemAdmin']}>
        {children}
      </DevSessionProvider>
    );
    const { result } = renderHook(() => useSession(), { wrapper });
    const claims = claimsOf((await result.current.getSession())?.token);
    expect(claims).toMatchObject({ tenantId: PLATFORM_TENANT.id, membershipId: MEMBERSHIP, scopeVersion: 0, aud: 'control', roles: ['SystemAdmin'] });
  });

  it('tells the shell that the session is a control-plane one, and a tenant session that it is not', () => {
    const control = renderHook(() => useSession(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DevSessionProvider keyBase64={KEY} tenants={TENANTS} controlRoles={['SystemAdmin']}>
          {children}
        </DevSessionProvider>
      ),
    });
    expect(control.result.current.controlPlane).toBe(true);
    const tenant = renderHook(() => useSession(), { wrapper: ({ children }: { children: ReactNode }) => <DevSessionProvider keyBase64={KEY}>{children}</DevSessionProvider> });
    expect(tenant.result.current.controlPlane).toBe(false);
  });

  it('keeps the control claims after the step-up', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DevSessionProvider keyBase64={KEY} tenants={TENANTS} controlRoles={['PlatformOperator']}>
        {children}
      </DevSessionProvider>
    );
    const { result } = renderHook(() => useSession(), { wrapper });
    await result.current.requestStepUp?.();
    expect(claimsOf((await result.current.getSession())?.token)).toMatchObject({ aud: 'control', roles: ['PlatformOperator'], aal: 'aal2' });
  });

  it('signs no control claim for a tenant user', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <DevSessionProvider keyBase64={KEY}>{children}</DevSessionProvider>;
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(claimsOf((await result.current.getSession())?.token)).not.toHaveProperty('aud');
  });
});
