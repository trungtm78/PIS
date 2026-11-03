import { createPublicKey, verify } from 'node:crypto';
import { POWERSYNC_AUDIENCE, POWERSYNC_TOKEN_TTL_SECONDS } from '../../src/auth/claims';
import { NOW, NOW_SECONDS, TENANT, TENANT_ISSUER, issuerKey, newIssuer } from './auth-fixtures';

jest.setTimeout(30_000);

function parts(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const [header = '', payload = '', signature = ''] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

describe('the token a phone gives the PowerSync service (ST-MOB-007, TK-MOB-007-2)', () => {
  it('AC-ST-MOB-007-3 UAT-NFR-TENANCY-07: carries the member, the active tenant and the scope version of the context it was judged under, for five minutes at most', () => {
    const key = issuerKey();
    const issuer = newIssuer(key);
    const issued = issuer.issuePowerSync({ tenant: TENANT, now: NOW });
    const { header, payload } = parts(issued.token);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: key.kid });
    expect(payload).toEqual({
      iss: TENANT_ISSUER,
      aud: POWERSYNC_AUDIENCE,
      sub: TENANT.membershipId,
      tenant_id: TENANT.tenantId,
      membership_id: TENANT.membershipId,
      scope_version: TENANT.scopeVersion,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + POWERSYNC_TOKEN_TTL_SECONDS,
    });
    expect(POWERSYNC_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(issued.expiresInSeconds).toBe(POWERSYNC_TOKEN_TTL_SECONDS);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(300);
  });

  it('is signed with the key the service can read among the published keys, and a changed claim breaks the signature', async () => {
    const issuer = newIssuer();
    const { token } = issuer.issuePowerSync({ tenant: TENANT, now: NOW });
    const { signingInput, signature, payload } = parts(token);
    const jwk = (await issuer.publicKeys()).keys[0];
    const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
    expect(verify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
    const forged = Buffer.from(JSON.stringify({ ...payload, tenant_id: '00000000-0000-4000-8000-00000000000b' })).toString('base64url');
    const [header = ''] = token.split('.');
    expect(verify('sha256', Buffer.from(`${header}.${forged}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(false);
  });

  it('takes the tenant only from the context it is given: a context that is not a tenant, a membership and a scope version is refused', () => {
    const issuer = newIssuer();
    expect(() => issuer.issuePowerSync({ tenant: { tenantId: 'tenant-b', membershipId: TENANT.membershipId, scopeVersion: 1 }, now: NOW })).toThrow();
    expect(() => issuer.issuePowerSync({ tenant: { ...TENANT, scopeVersion: -1 }, now: NOW })).toThrow();
  });

  it('does not accept a lifetime from outside: the same instant gives the same expiry, and a later instant a later one', () => {
    const issuer = newIssuer();
    const first = parts(issuer.issuePowerSync({ tenant: TENANT, now: NOW }).token).payload;
    const later = parts(issuer.issuePowerSync({ tenant: TENANT, now: new Date(NOW.getTime() + 60_000) }).token).payload;
    expect((later.exp as number) - (first.exp as number)).toBe(60);
    expect((later.exp as number) - (later.iat as number)).toBe(POWERSYNC_TOKEN_TTL_SECONDS);
  });
});
