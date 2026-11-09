import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import { DEV_SESSION_MARKER, DEV_TENANTS, DEV_USER } from './dev-tenants';
import { signDevToken } from './dev-token';
import { SessionContext } from './SessionContext';
import type { SessionAssurance, SessionTenant, SessionUser, SessionValue } from './SessionContext';

export interface DevSessionProviderProps {
  children: ReactNode;
  tenants?: readonly SessionTenant[];
  /** Base64 of at least 32 bytes shared with the development API; defaults to VITE_DEV_SESSION_KEY. */
  keyBase64?: string;
  /** Permissions the development user is shown as holding; undefined means unknown (every control is shown). */
  permissions?: readonly string[];
  /** The user shown in the sidebar; defaults to the development user. */
  user?: SessionUser;
  /** The realm roles of a control-plane user: the tokens then carry the control audience and these roles. */
  controlRoles?: readonly string[];
}

/**
 * A development stand-in for sign-in: a fixed user with two tenants and a locally signed token for the development
 * API. It is only imported when `import.meta.env.DEV` is true, so production bundles never contain it.
 */
export default function DevSessionProvider({ children, tenants = DEV_TENANTS, keyBase64 = import.meta.env.VITE_DEV_SESSION_KEY, permissions, user = DEV_USER, controlRoles }: DevSessionProviderProps) {
  const [tenantId, setTenantId] = useState<string | undefined>(tenants[0]?.id);
  const tenant = tenants.find((candidate) => candidate.id === tenantId);
  const [aal2At, setAal2At] = useState<Date | undefined>(undefined);
  // The token is signed from the latest assurance at the moment of each request: a command retried right after the
  // step-up still holds the getSession of the render before it, and must not send the old aal1 claim again.
  const aal2Ref = useRef<Date | undefined>(undefined);

  const getSession = useCallback(async () => {
    if (tenant === undefined || keyBase64 === undefined || keyBase64 === '') return undefined;
    const stepped = aal2Ref.current;
    const assuranceClaims = stepped === undefined ? { aal: 'aal1' as const } : { aal: 'aal2' as const, aal2At: stepped };
    const controlClaims = controlRoles === undefined ? {} : { audience: 'control' as const, roles: controlRoles };
    return { token: await signDevToken({ tenantId: tenant.id, membershipId: tenant.membershipId, scopeVersion: controlRoles === undefined ? 1 : 0, ...assuranceClaims, ...controlClaims }, keyBase64) };
  }, [tenant, keyBase64, controlRoles]);

  const switchTenant = useCallback(
    (nextId: string) => {
      if (tenants.some((candidate) => candidate.id === nextId)) setTenantId(nextId);
    },
    [tenants],
  );

  // The development user passes the second factor with one click; real step-up arrives with OIDC sign-in.
  const requestStepUp = useCallback(() => {
    aal2Ref.current = new Date();
    setAal2At(aal2Ref.current);
    return Promise.resolve();
  }, []);
  const assurance = useMemo<SessionAssurance>(() => (aal2At === undefined ? { level: 'aal1' } : { level: 'aal2', aal2At }), [aal2At]);

  const value = useMemo<SessionValue>(
    () => ({ tenant, tenants, user, access: ALL_MODULES_VISIBLE, switchTenant, getSession, permissions, assurance, requestStepUp, controlPlane: controlRoles !== undefined }),
    [tenant, tenants, user, switchTenant, getSession, permissions, assurance, requestStepUp, controlRoles],
  );

  return (
    <SessionContext.Provider value={value}>
      <span hidden data-dev-session={DEV_SESSION_MARKER} />
      {children}
    </SessionContext.Provider>
  );
}
