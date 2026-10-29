import type { JsonWebKey } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  MAX_CLOCK_SKEW_SECONDS,
  TENANT_AUDIENCE as DEFAULT_TENANT_AUDIENCE,
  realmRoles,
  scopeVersionClaim,
  sessionClaim,
  stringClaim,
  stringList,
  subjectClaim,
  uuidClaim,
} from './claims';
import type { JwksSource } from './jwks-source';
import { assuranceOf, audiencesOf, checkTimes, parseJwt, sessionExpired, verifySignature } from './jwt';
import type { ParsedJwt } from './jwt';
import type { TokenVerifier, VerifiedIdentity, VerifiedTenantToken } from './token-verifier';

export interface JwksTokenVerifierOptions {
  /** `iss` of identity tokens (the realm of the identity provider). */
  issuer: string;
  /** The client id the tenant web and mobile applications use: `aud` of their identity tokens. */
  identityAudience: string;
  /** The control-plane client: `aud` of control tokens. */
  controlAudience: string;
  jwks: JwksSource;
  /** The public keys of the tenant token issuer (published by it, also during rotation overlap). */
  tenantTokenKeys: () => Promise<readonly JsonWebKey[]>;
  /** `iss` of tenant tokens. */
  tenantIssuer: string;
  /** `aud` of tenant tokens; default `machvon-api`. */
  tenantAudience?: string;
  /** Tolerated clock difference in seconds, at most 60; default 30. */
  clockSkewSeconds?: number;
  now?: () => Date;
}

const MODES = new Set(['FULL', 'READ_ONLY']);

/**
 * The OIDC/JWKS adapter of the authentication port, on Node's own crypto: RS256 and ES256 only, the key chosen by
 * `kid` from the provider's JWKS (cached, refreshed on rotation, fail closed), issuer, audience and time claims
 * checked with a bounded clock skew. Every failure is the same 401 SESSION_EXPIRED without detail.
 */
export class JwksTokenVerifier implements TokenVerifier {
  private readonly skew: number;
  private readonly clock: () => Date;
  private readonly tenantAudience: string;

  constructor(private readonly options: JwksTokenVerifierOptions) {
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (!Number.isFinite(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_SECONDS) {
      throw new Error(`clock skew must be between 0 and ${MAX_CLOCK_SKEW_SECONDS} seconds`);
    }
    this.skew = skew;
    this.clock = options.now ?? (() => new Date());
    this.tenantAudience = options.tenantAudience ?? DEFAULT_TENANT_AUDIENCE;
  }

  async verifyIdentity(token: string): Promise<VerifiedIdentity> {
    const parsed = parseJwt(token);
    await this.checkSignature(parsed, (kid) => this.options.jwks.keyFor(kid));
    const { payload } = parsed;
    if (payload.iss !== this.options.issuer) throw sessionExpired();
    checkTimes(payload, Math.floor(this.clock().getTime() / 1000), this.skew);

    const audiences = audiencesOf(payload);
    const forTenant = audiences.includes(this.options.identityAudience);
    const forControl = audiences.includes(this.options.controlAudience);
    // A token for both clients would let one login act on both planes: refuse it.
    if (forTenant === forControl) throw sessionExpired();

    const subject = subjectClaim(payload.sub);
    const sessionId = sessionClaim(payload.sid);
    if (subject === undefined || sessionId === undefined) throw sessionExpired();
    const email = stringClaim(payload.email, 320);
    return {
      subject,
      ...(email === undefined ? {} : { email }),
      ...(typeof payload.email_verified === 'boolean' ? { emailVerified: payload.email_verified } : {}),
      sessionId,
      ...assuranceOf(payload),
      audience: forControl ? 'control-client' : 'tenant-client',
      roles: forControl ? realmRoles(payload) : [],
    };
  }

  async verifyTenantToken(token: string): Promise<VerifiedTenantToken> {
    const parsed = parseJwt(token);
    // Tenant tokens are always signed with ES256 by the tenant token issuer.
    if (parsed.algorithm !== 'ES256') throw sessionExpired();
    await this.checkSignature(parsed, async (kid) => (await this.options.tenantTokenKeys()).find((key) => key.kid === kid));
    const { payload } = parsed;
    if (payload.iss !== this.options.tenantIssuer) throw sessionExpired();
    checkTimes(payload, Math.floor(this.clock().getTime() / 1000), this.skew);

    const audiences = audiencesOf(payload);
    const audience = audiences.includes(this.options.controlAudience) ? 'control' : audiences.includes(this.tenantAudience) ? 'tenant' : undefined;
    const tenantId = uuidClaim(payload.tid);
    const membershipId = uuidClaim(payload.mid);
    const scopeVersion = scopeVersionClaim(payload.sv);
    const sessionId = sessionClaim(payload.sid);
    const mode = payload.mode;
    if (audience === undefined || audiences.length !== 1) throw sessionExpired();
    if (tenantId === undefined || membershipId === undefined || scopeVersion === undefined || sessionId === undefined) throw sessionExpired();
    if (typeof mode !== 'string' || !MODES.has(mode)) throw sessionExpired();
    // `act` is the actor of the token: only `support` exists, and it names the grant and the operator, who is the membership of the context (the operator has no membership of the tenant).
    let support: VerifiedTenantToken['support'];
    if (payload.act !== undefined) {
      const grantId = uuidClaim(payload.gid);
      const operatorId = uuidClaim(payload.opr);
      if (payload.act !== 'support' || audience !== 'tenant' || grantId === undefined || operatorId === undefined || operatorId !== membershipId) throw sessionExpired();
      support = { grantId, operatorId };
    }
    return {
      tenant: { tenantId, membershipId, scopeVersion },
      sessionId,
      ...assuranceOf(payload),
      audience,
      mode: mode as 'FULL' | 'READ_ONLY',
      roles: stringList(payload.roles),
      expiresAt: new Date((payload.exp as number) * 1000),
      ...(support === undefined ? {} : { support }),
    };
  }

  private async checkSignature(
    parsed: ParsedJwt,
    keyFor: (kid: string) => Promise<JsonWebKey | undefined>,
  ): Promise<void> {
    let key: JsonWebKey | undefined;
    try {
      key = await keyFor(parsed.keyId);
    } catch (error) {
      // The key source could not be trusted (provider down, set too old): fail closed, say nothing about why.
      throw error instanceof DomainError ? error : sessionExpired();
    }
    if (key === undefined || !verifySignature(parsed, key)) throw sessionExpired();
  }
}
