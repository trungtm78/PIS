import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_TENANT_ID } from '@machvon/db';
import type { Plane } from '@machvon/kernel';
import { PRINCIPAL_REQUEST_KEY } from '../principal';
import type { Principal } from '../principal';
import { PUBLIC_METADATA_KEY } from '../public.decorator';
import type { SessionDenyList } from '../session-deny-list';
import { TENANT_REQUEST_KEY } from '../tenant-context.decorator';
import { controlMembershipId } from './claims';
import { MAX_TOKEN_LENGTH, peekAudiences, sessionExpired } from './jwt';
import type { TokenVerifier } from './token-verifier';

/** Request property with what the verified token says beyond the Principal: realm roles, mode and expiry. */
export const AUTH_TOKEN_REQUEST_KEY = 'authenticatedToken';
export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');

export interface AuthenticatedToken {
  audience: Plane;
  roles: readonly string[];
  /** `READ_ONLY` while the tenant is suspended: the policy guard refuses commands for such a session. */
  mode: 'FULL' | 'READ_ONLY';
  expiresAt?: Date;
  /** The identity subject of a control principal; tenant principals are identified by their membership. */
  subject?: string;
}

export interface AuthGuardOptions {
  verifier: TokenVerifier;
  /** Sessions revoked before their token expired; checked after the token has been verified. */
  denyList?: SessionDenyList;
  /** The `aud` that sends a token to the control-plane verification. */
  controlAudience: string;
  /** Reads the audiences of a token without verifying it, only to choose the verification; defaults to the JWT payload. */
  audienceOf?: (token: string) => readonly string[];
}

interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  [TENANT_REQUEST_KEY]?: unknown;
  [PRINCIPAL_REQUEST_KEY]?: unknown;
  [AUTH_TOKEN_REQUEST_KEY]?: AuthenticatedToken;
}

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

/** The token of an `Authorization: Bearer <token>` header; any other shape, or a repeated header, gives nothing. */
export function bearerOf(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const token = BEARER.exec(header)?.[1];
  return token === undefined || token.length > MAX_TOKEN_LENGTH ? undefined : token;
}

/**
 * Authenticates every route that is not @Public: it takes the Bearer token, verifies it with the TokenVerifier port
 * (control-plane tokens by the identity provider, tenant tokens by the tenant token issuer), refuses revoked
 * sessions, and fills the request with the tenant context, the Principal of the policy guard and the token facts.
 * Any failure is 401 SESSION_EXPIRED. It must run before the policy guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_OPTIONS) private readonly options: AuthGuardOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_METADATA_KEY, [context.getHandler(), context.getClass()]) === true) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = bearerOf(request.headers.authorization);
    if (token === undefined) throw sessionExpired();

    const audiences = (this.options.audienceOf ?? peekAudiences)(token);
    if (audiences.includes(this.options.controlAudience)) await this.authenticateControl(request, token);
    else await this.authenticateTenant(request, token);
    return true;
  }

  private async authenticateControl(request: AuthRequest, token: string): Promise<void> {
    const identity = await this.options.verifier.verifyIdentity(token);
    if (identity.audience !== 'control-client') throw sessionExpired();
    await this.refuseRevoked(identity.sessionId, undefined);
    const tenant = { tenantId: PLATFORM_TENANT_ID, membershipId: controlMembershipId(identity.subject), scopeVersion: 0 };
    this.fill(request, {
      tenant,
      principal: { tenant, audience: 'control', assurance: identity.assurance, aal2At: identity.aal2At, sessionId: identity.sessionId, roles: identity.roles },
      token: { audience: 'control', roles: identity.roles, mode: 'FULL', subject: identity.subject },
    });
  }

  private async authenticateTenant(request: AuthRequest, token: string): Promise<void> {
    const verified = await this.options.verifier.verifyTenantToken(token);
    // The session of a support token is the operator's own, of the control plane, which no tenant tracks: what ends a support token is its grant, which the policy guard judges on every request.
    await this.refuseRevoked(verified.sessionId, verified.support === undefined ? verified.tenant.tenantId : undefined);
    this.fill(request, {
      tenant: verified.tenant,
      principal: { tenant: verified.tenant, audience: verified.audience, assurance: verified.assurance, aal2At: verified.aal2At, sessionId: verified.sessionId, ...(verified.support === undefined ? {} : { support: verified.support }) },
      token: { audience: verified.audience, roles: verified.roles, mode: verified.mode, expiresAt: verified.expiresAt },
    });
  }

  private async refuseRevoked(sessionId: string, tenantId: string | undefined): Promise<void> {
    if (this.options.denyList !== undefined && (await this.options.denyList.isRevoked(sessionId, tenantId))) throw sessionExpired();
  }

  private fill(request: AuthRequest, found: { tenant: Principal['tenant']; principal: Principal; token: AuthenticatedToken }): void {
    request[TENANT_REQUEST_KEY] = found.tenant;
    request[PRINCIPAL_REQUEST_KEY] = found.principal;
    request[AUTH_TOKEN_REQUEST_KEY] = found.token;
  }
}
