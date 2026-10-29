import type { TenantContext } from '@machvon/kernel';

/** What a verified identity token of the identity provider says about the person. */
export interface VerifiedIdentity {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  /** The identity provider's session id (`sid`). */
  sessionId: string;
  assurance: 'aal1' | 'aal2';
  /** When the person last authenticated with a second factor, known only for `aal2`. */
  aal2At?: Date;
  /** The client the token was issued for: the tenant web and mobile clients, or the control-plane client. */
  audience: 'tenant-client' | 'control-client';
  /** Realm roles of the control client (SAS section 2); empty for the tenant client. */
  roles: readonly string[];
}

/** What a verified tenant access token says: the tenant context and how the session was authenticated. */
export interface VerifiedTenantToken {
  tenant: TenantContext;
  sessionId: string;
  assurance: 'aal1' | 'aal2';
  aal2At?: Date;
  audience: 'tenant' | 'control';
  mode: 'FULL' | 'READ_ONLY';
  roles: readonly string[];
  expiresAt: Date;
  /** Present only on a support token (`act=support`, ST-SAS-015): the grant it acts under and the operator it was given to. Ordinary tenant tokens never carry it. */
  support?: { grantId: string; operatorId: string };
}

/**
 * The authentication port. Every implementation refuses an untrusted token with a 401 SESSION_EXPIRED that
 * carries no detail (see the shared contract suite), and never reaches a database before the token is verified.
 */
export interface TokenVerifier {
  verifyIdentity(token: string): Promise<VerifiedIdentity>;
  verifyTenantToken(token: string): Promise<VerifiedTenantToken>;
}
