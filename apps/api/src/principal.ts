import { DomainError, parseTenantContext } from '@machvon/kernel';
import type { Plane, TenantContext } from '@machvon/kernel';

/** Request property that the authentication guard fills with the verified Principal. */
export const PRINCIPAL_REQUEST_KEY = 'principal';

const PLANES: readonly Plane[] = ['tenant', 'control', 'internal', 'edge'];
const MAX_SESSION_ID_LENGTH = 128;

/** Who is calling: the tenant context of the token plus the claims the policy decision needs. */
export interface Principal {
  tenant: TenantContext;
  /** The plane the token was issued for (`aud`). */
  audience: Plane;
  assurance: 'aal1' | 'aal2';
  /** When the principal last reached aal2; a step-up command needs it within 15 minutes. */
  aal2At?: Date;
  sessionId: string;
  /** Realm roles of a control-plane token (SystemAdmin, ...); the tenant plane has none. */
  roles?: readonly string[];
  /**
   * Set when the token is a support token (`act=support`, ST-SAS-015): the operator of the platform who acts in the tenant under a support access grant. The membership of the tenant context is the operator's
   * identifier, not a member of the tenant; the policy guard judges the grant on every request and gives the permissions of the grant instead of those of a membership.
   */
  support?: SupportClaim;
}

/** What a support token says: the grant it acts under and the operator it was given to. */
export interface SupportClaim {
  grantId: string;
  operatorId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function supportClaimOf(source: unknown): SupportClaim {
  const { grantId, operatorId } = (typeof source === 'object' && source !== null ? source : {}) as Record<string, unknown>;
  if (typeof grantId !== 'string' || typeof operatorId !== 'string' || !UUID.test(grantId) || !UUID.test(operatorId)) throw invalidPrincipal();
  return { grantId: grantId.toLowerCase(), operatorId: operatorId.toLowerCase() };
}

function invalidPrincipal(): DomainError {
  return new DomainError('SESSION_EXPIRED', 401);
}

/**
 * Validates what an authentication guard put on the request. A request without a principal, or with one
 * whose claims are malformed, is answered 401 SESSION_EXPIRED; a malformed tenant context is 400
 * TENANT_CONTEXT_INVALID as everywhere else.
 */
export function principalOf(request: { [PRINCIPAL_REQUEST_KEY]?: unknown }): Principal {
  const source = request[PRINCIPAL_REQUEST_KEY];
  if (typeof source !== 'object' || source === null) throw invalidPrincipal();
  const { tenant, audience, assurance, aal2At, sessionId, roles, support } = source as Record<string, unknown>;
  const context = parseTenantContext(tenant);
  if (!PLANES.includes(audience as Plane)) throw invalidPrincipal();
  if (assurance !== 'aal1' && assurance !== 'aal2') throw invalidPrincipal();
  if (aal2At !== undefined && !(aal2At instanceof Date && !Number.isNaN(aal2At.getTime()))) throw invalidPrincipal();
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > MAX_SESSION_ID_LENGTH) throw invalidPrincipal();
  if (roles !== undefined && !(Array.isArray(roles) && roles.every((role) => typeof role === 'string'))) throw invalidPrincipal();
  const claim = support === undefined ? undefined : supportClaimOf(support);
  // A support token acts on the tenant plane only, as the operator the grant was given to.
  if (claim !== undefined && (audience !== 'tenant' || claim.operatorId !== context.membershipId.toLowerCase())) throw invalidPrincipal();
  return { tenant: context, audience: audience as Plane, assurance, aal2At: aal2At as Date | undefined, sessionId, ...(roles === undefined ? {} : { roles: roles as readonly string[] }), ...(claim === undefined ? {} : { support: claim }) };
}
