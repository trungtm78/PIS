import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { DomainError, verifyTenantContext } from '@machvon/kernel';
import { PRINCIPAL_REQUEST_KEY } from '../../src/principal';
import { PUBLIC_METADATA_KEY } from '../../src/public.decorator';
import { TENANT_REQUEST_KEY } from '../../src/tenant-context.decorator';

export const TENANT_HEADER = 'x-tenant-context';
/** Test-only stand-in for the token claims the policy guard reads: JSON with optional aud, aal, aal2At (ISO), sid and roles (control-plane realm roles). */
export const CLAIMS_HEADER = 'x-test-claims';
export const TEST_SIGNING_KEY = Symbol('TEST_SIGNING_KEY');

interface GuardedRequest {
  headers: Record<string, string | string[] | undefined>;
  [TENANT_REQUEST_KEY]?: unknown;
  [PRINCIPAL_REQUEST_KEY]?: unknown;
}

interface TestClaims {
  aud?: string;
  aal?: string;
  aal2At?: string;
  sid?: string;
  roles?: string[];
  /** A support token (act=support): the grant it acts under; the operator is the membership of the tenant context. */
  support?: { grantId: string };
}

function claimsOf(header: string | string[] | undefined): TestClaims {
  return typeof header === 'string' ? (JSON.parse(header) as TestClaims) : {};
}

/**
 * Test-only stand-in for authentication (real authentication arrives with ST-IAM-002): it trusts a
 * TenantContext only when the header carries a token signed with the test key. It is registered by
 * the test module alone, never by AppModule.
 */
@Injectable()
export class TestAuthGuard implements CanActivate {
  private readonly signingKey: Buffer;

  constructor(
    @Inject(TEST_SIGNING_KEY) signingKey: Buffer,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
    this.signingKey = signingKey;
  }

  canActivate(context: ExecutionContext): boolean {
    // A route that is public (a provider callback, authenticated by its signature) has no caller to trust: it gets through without a tenant, as it does in the application.
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_METADATA_KEY, [context.getHandler(), context.getClass()]) === true) return true;
    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const token = request.headers[TENANT_HEADER];
    if (typeof token !== 'string') throw new DomainError('TENANT_CONTEXT_INVALID', 400);
    const tenant = verifyTenantContext(token, this.signingKey);
    request[TENANT_REQUEST_KEY] = tenant;
    const claims = claimsOf(request.headers[CLAIMS_HEADER]);
    request[PRINCIPAL_REQUEST_KEY] = {
      tenant,
      audience: claims.aud ?? 'tenant',
      assurance: claims.aal ?? 'aal1',
      aal2At: claims.aal2At === undefined ? undefined : new Date(claims.aal2At),
      sessionId: claims.sid ?? 'test-session',
      ...(claims.roles === undefined ? {} : { roles: claims.roles }),
      ...(claims.support === undefined ? {} : { support: { grantId: claims.support.grantId, operatorId: tenant.membershipId } }),
    };
    return true;
  }
}
