import type { JsonWebKey } from 'node:crypto';
import { HttpJwksSource, discoverJwksUri } from '../../src/auth/jwks-source';
import { JwksTokenVerifier } from '../../src/auth/jwks-token-verifier';
import {
  CONTROL_AUDIENCE,
  IDENTITY_AUDIENCE,
  NOW,
  NOW_SECONDS,
  SESSION_ID,
  SUBJECT,
  TENANT,
  TENANT_ISSUER,
  controlClaims,
  identityClaims,
  issuerKey,
  newIssuer,
  tenantClaims,
} from './auth-fixtures';
import { OidcTestProvider, hs256WithPublicKey, newKey, signJwt, unsecuredJwt } from './oidc-test-provider';
import type { ProviderKey } from './oidc-test-provider';
import { runTokenVerifierContract } from './token-verifier.contract';
import type { ContractSubject } from './token-verifier.contract';

// Key generation (RSA 2048) is slow on a loaded machine.
jest.setTimeout(30_000);

interface Clock {
  now: Date;
}

interface Harness {
  provider: OidcTestProvider;
  key: ProviderKey;
  clock: Clock;
  verifier: JwksTokenVerifier;
  source: HttpJwksSource;
  tenantKey: ProviderKey;
  issueTenant: (now?: Date) => Promise<string>;
}

async function start(): Promise<Harness> {
  const provider = await OidcTestProvider.start();
  const key = provider.addKey('RS256');
  const clock: Clock = { now: NOW };
  const tenantKey = newKey('ES256');
  const issuer = newIssuer(issuerKey(tenantKey));
  const source = new HttpJwksSource({ jwksUri: provider.jwksUri, now: () => clock.now });
  const verifier = new JwksTokenVerifier({
    issuer: provider.issuer,
    identityAudience: IDENTITY_AUDIENCE,
    controlAudience: CONTROL_AUDIENCE,
    jwks: source,
    tenantTokenKeys: async () => (await issuer.publicKeys()).keys,
    tenantIssuer: TENANT_ISSUER,
    now: () => clock.now,
  });
  const issueTenant = async (now: Date = NOW): Promise<string> =>
    (await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal2', aal2At: new Date(NOW_SECONDS * 1000 - 60_000), mode: 'FULL', now })).accessToken;
  return { provider, key, clock, verifier, source, tenantKey, issueTenant };
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

runTokenVerifierContract('JwksTokenVerifier with an in-process OIDC provider', async () => {
  const h = await start();
  const other = newKey('RS256');
  const sameKidOtherMaterial = newKey('RS256', h.key.kid);
  const issuerClaims = (over: Record<string, unknown> = {}) => identityClaims(h.provider.issuer, over);
  const tenantKeyPair = h.tenantKey;
  const subject: ContractSubject = {
    verifier: h.verifier,
    valid: {
      identity: signJwt(h.key, issuerClaims()),
      control: signJwt(h.key, controlClaims(h.provider.issuer)),
      tenant: await h.issueTenant(),
    },
    expected: { subject: SUBJECT, sessionId: SESSION_ID, controlRoles: ['SystemAdmin'], tenant: TENANT },
    refusedIdentity: {
      'wrong issuer': signJwt(h.key, issuerClaims({ iss: 'https://evil.example' })),
      'wrong audience': signJwt(h.key, issuerClaims({ aud: 'someone-else' })),
      'both client audiences': signJwt(h.key, issuerClaims({ aud: [IDENTITY_AUDIENCE, CONTROL_AUDIENCE] })),
      'expired beyond the skew': signJwt(h.key, issuerClaims({ exp: NOW_SECONDS - 31 })),
      'not valid yet beyond the skew': signJwt(h.key, issuerClaims({ nbf: NOW_SECONDS + 31 })),
      'alg none': unsecuredJwt(issuerClaims(), h.key.kid),
      'HS256 keyed with the public key': hs256WithPublicKey(h.key, issuerClaims()),
      'unknown kid': signJwt(other, issuerClaims()),
      'signed by another key under the same kid': signJwt(sameKidOtherMaterial, issuerClaims()),
      'header algorithm does not match the key type': signJwt(h.key, issuerClaims(), { alg: 'ES256' }),
      'no session id': signJwt(h.key, issuerClaims({ sid: undefined })),
      'no expiry': signJwt(h.key, issuerClaims({ exp: undefined })),
      'no subject': signJwt(h.key, issuerClaims({ sub: undefined })),
    },
    refusedTenant: {
      'wrong issuer': signJwt(tenantKeyPair, tenantClaims({ iss: 'https://evil.example' })),
      'wrong audience': signJwt(tenantKeyPair, tenantClaims({ aud: 'machvon-web' })),
      'expired beyond the skew': signJwt(tenantKeyPair, tenantClaims({ exp: NOW_SECONDS - 31 })),
      'alg none': unsecuredJwt(tenantClaims(), tenantKeyPair.kid),
      'HS256 keyed with the public key': hs256WithPublicKey(tenantKeyPair, tenantClaims()),
      'unknown kid': signJwt(newKey('ES256'), tenantClaims()),
      'signed by another key under the same kid': signJwt(newKey('ES256', tenantKeyPair.kid), tenantClaims()),
      'tenant id is not a UUID': signJwt(tenantKeyPair, tenantClaims({ tid: 'tenant-a' })),
      'scope version is negative': signJwt(tenantKeyPair, tenantClaims({ sv: -1 })),
      'scope version is not an integer': signJwt(tenantKeyPair, tenantClaims({ sv: 1.5 })),
      'unknown mode': signJwt(tenantKeyPair, tenantClaims({ mode: 'ADMIN' })),
      'RS256 tenant token': signJwt(other, tenantClaims()),
    },
  };
  return { subject, stop: () => h.provider.stop() };
});

describe('JwksTokenVerifier', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await start();
  });

  afterEach(async () => {
    await h.provider.stop();
  });

  const identity = (over: Record<string, unknown> = {}, key: ProviderKey = h.key): string => signJwt(key, identityClaims(h.provider.issuer, over));

  describe('clock skew', () => {
    it.each([
      ['29 seconds past the expiry', NOW_SECONDS - 29],
      ['exactly 30 seconds past the expiry', NOW_SECONDS - 30],
    ])('accepts a token %s', async (_label, exp) => {
      await expect(h.verifier.verifyIdentity(identity({ exp }))).resolves.toMatchObject({ subject: SUBJECT });
    });

    it('refuses a token 31 seconds past the expiry', async () => {
      expect(await failure(h.verifier.verifyIdentity(identity({ exp: NOW_SECONDS - 31 })))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('accepts nbf 29 seconds ahead and refuses it 31 seconds ahead', async () => {
      await expect(h.verifier.verifyIdentity(identity({ nbf: NOW_SECONDS + 29 }))).resolves.toBeDefined();
      expect(await failure(h.verifier.verifyIdentity(identity({ nbf: NOW_SECONDS + 31 })))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('refuses an iat that lies in the future beyond the skew', async () => {
      expect(await failure(h.verifier.verifyIdentity(identity({ iat: NOW_SECONDS + 31 })))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it.each([61, 3600])('refuses to be built with a skew of %s seconds', (clockSkewSeconds) => {
      expect(
        () =>
          new JwksTokenVerifier({
            issuer: h.provider.issuer,
            identityAudience: IDENTITY_AUDIENCE,
            controlAudience: CONTROL_AUDIENCE,
            jwks: h.source,
            tenantTokenKeys: () => Promise.resolve([]),
            tenantIssuer: TENANT_ISSUER,
            clockSkewSeconds,
          }),
      ).toThrow(/clock skew/);
    });

    it('applies the same skew to a tenant token', async () => {
      const issued = await h.issueTenant(new Date(NOW.getTime() - 300_000 - 29_000));
      await expect(h.verifier.verifyTenantToken(issued)).resolves.toMatchObject({ tenant: TENANT });
      const late = await h.issueTenant(new Date(NOW.getTime() - 300_000 - 31_000));
      expect(await failure(h.verifier.verifyTenantToken(late))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });

  describe('assurance', () => {
    it('is aal2 with the time of authentication when acr says so', async () => {
      const result = await h.verifier.verifyIdentity(identity({ acr: 'aal2', amr: ['pwd'], auth_time: NOW_SECONDS - 120 }));
      expect(result.assurance).toBe('aal2');
      expect(result.aal2At).toEqual(new Date((NOW_SECONDS - 120) * 1000));
    });

    it('is aal2 when amr contains a second factor', async () => {
      expect((await h.verifier.verifyIdentity(identity({ acr: undefined, amr: ['pwd', 'otp'] }))).assurance).toBe('aal2');
    });

    it('is aal1, without an aal2 time, with a password alone', async () => {
      const result = await h.verifier.verifyIdentity(identity({ acr: '1', amr: ['pwd'] }));
      expect(result).toMatchObject({ assurance: 'aal1' });
      expect(result.aal2At).toBeUndefined();
    });

    it('is aal1 when acr says aal2 but there is no authentication time to date it', async () => {
      const result = await h.verifier.verifyIdentity(identity({ acr: 'aal2', auth_time: undefined }));
      expect(result.assurance).toBe('aal1');
    });
  });

  describe('the demonstration mode with one factor', () => {
    const demo = (): JwksTokenVerifier =>
      new JwksTokenVerifier({
        issuer: h.provider.issuer,
        identityAudience: IDENTITY_AUDIENCE,
        controlAudience: CONTROL_AUDIENCE,
        jwks: h.source,
        tenantTokenKeys: async () => [h.tenantKey.publicJwk],
        tenantIssuer: TENANT_ISSUER,
        now: () => h.clock.now,
        singleFactorCountsAsSecond: true,
      });

    it('takes a password alone as a second factor given now, for an identity token', async () => {
      const result = await demo().verifyIdentity(identity({ acr: 'aal1', amr: ['pwd'], auth_time: NOW_SECONDS - 3600 }));
      expect(result.assurance).toBe('aal2');
      expect(result.aal2At).toEqual(h.clock.now);
    });

    it('takes a tenant token of a session with one factor as fresh for a step-up', async () => {
      const issuer = newIssuer(issuerKey(h.tenantKey));
      const token = (await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW })).accessToken;
      expect((await h.verifier.verifyTenantToken(token)).assurance).toBe('aal1');
      expect(await demo().verifyTenantToken(token)).toMatchObject({ assurance: 'aal2', aal2At: h.clock.now });
    });

    it('still refuses a token that is not valid: the mode changes the assurance, nothing else', async () => {
      expect(await failure(demo().verifyIdentity(identity({ exp: NOW_SECONDS - 600 })))).toBeDefined();
      expect(await failure(demo().verifyIdentity(identity({ aud: 'someone-else' })))).toBeDefined();
    });

    it('is off by default: the same token is aal1', async () => {
      expect((await h.verifier.verifyIdentity(identity({ acr: 'aal1', amr: ['pwd'] }))).assurance).toBe('aal1');
    });
  });

  describe('identity details', () => {
    it('reads the e-mail and ignores roles of an identity token for the tenant client', async () => {
      const result = await h.verifier.verifyIdentity(identity({ realm_access: { roles: ['SystemAdmin'] } }));
      expect(result).toMatchObject({ email: 'an@example.test', emailVerified: true, audience: 'tenant-client' });
      expect(result.roles).toEqual([]);
    });

    it('accepts an audience array that contains the client', async () => {
      await expect(h.verifier.verifyIdentity(identity({ aud: ['account', IDENTITY_AUDIENCE] }))).resolves.toBeDefined();
    });

    it('keeps only string roles of the control client', async () => {
      const token = signJwt(h.key, controlClaims(h.provider.issuer, { realm_access: { roles: ['SystemAdmin', 7, null, 'PlatformOperator'] } }));
      expect([...(await h.verifier.verifyIdentity(token)).roles]).toEqual(['SystemAdmin', 'PlatformOperator']);
    });

    it('refuses a token above the size limit before it asks the provider for any key', async () => {
      const before = h.provider.jwksFetches;
      expect(await failure(h.verifier.verifyIdentity('a'.repeat(10_000)))).toMatchObject({ code: 'SESSION_EXPIRED' });
      expect(h.provider.jwksFetches).toBe(before);
    });
  });

  describe('key rotation', () => {
    it('fetches the key set once and serves the next tokens from the cache', async () => {
      await h.verifier.verifyIdentity(identity());
      await h.verifier.verifyIdentity(identity());
      expect(h.provider.jwksFetches).toBe(1);
    });

    it('refreshes once when an unknown kid appears, and not more than once in 10 seconds', async () => {
      await h.verifier.verifyIdentity(identity());
      expect(h.provider.jwksFetches).toBe(1);

      h.clock.now = new Date(NOW.getTime() + 11_000);
      const rotated = h.provider.rotate('RS256');
      await expect(h.verifier.verifyIdentity(identity({}, rotated))).resolves.toBeDefined();
      expect(h.provider.jwksFetches).toBe(2);

      // The old key is gone and a token under it asks for a refresh again: too soon, so no second fetch.
      expect(await failure(h.verifier.verifyIdentity(identity({}, h.key)))).toMatchObject({ code: 'SESSION_EXPIRED' });
      expect(h.provider.jwksFetches).toBe(2);

      h.clock.now = new Date(NOW.getTime() + 22_000);
      expect(await failure(h.verifier.verifyIdentity(identity({}, h.key)))).toMatchObject({ code: 'SESSION_EXPIRED' });
      expect(h.provider.jwksFetches).toBe(3);
    });

    it('accepts both keys while the provider publishes both and drops the old one afterwards', async () => {
      const second = h.provider.addKey('ES256');
      await expect(h.verifier.verifyIdentity(identity({}, second))).resolves.toBeDefined();
      await expect(h.verifier.verifyIdentity(identity({}, h.key))).resolves.toBeDefined();
      h.provider.removeKey(h.key.kid);
      h.clock.now = new Date(NOW.getTime() + 301_000);
      expect(await failure(h.verifier.verifyIdentity(identity({}, h.key)))).toMatchObject({ code: 'SESSION_EXPIRED' });
      await expect(h.verifier.verifyIdentity(identity({}, second))).resolves.toBeDefined();
    });
  });

  describe('provider outage', () => {
    it('keeps serving cached keys until their maximum age and then fails closed', async () => {
      await h.verifier.verifyIdentity(identity());
      h.provider.setDown(true);

      h.clock.now = new Date(NOW.getTime() + 200_000);
      await expect(h.verifier.verifyIdentity(identity())).resolves.toBeDefined();

      h.clock.now = new Date(NOW.getTime() + 301_000);
      expect(await failure(h.verifier.verifyIdentity(identity()))).toMatchObject({ code: 'SESSION_EXPIRED', detail: undefined });

      h.provider.setDown(false);
      h.clock.now = new Date(NOW.getTime() + 320_000);
      await expect(h.verifier.verifyIdentity(identity())).resolves.toBeDefined();
    });

    it('refuses an unknown kid while the provider is down', async () => {
      await h.verifier.verifyIdentity(identity());
      h.provider.setDown(true);
      h.clock.now = new Date(NOW.getTime() + 11_000);
      expect(await failure(h.verifier.verifyIdentity(identity({}, newKey('RS256'))))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('fails closed on the very first token when the provider was never reachable', async () => {
      h.provider.setDown(true);
      const fresh = new HttpJwksSource({ jwksUri: h.provider.jwksUri, now: () => h.clock.now });
      await expect(fresh.keyFor(h.key.kid)).rejects.toThrow();
    });
  });

  describe('discovery', () => {
    it('reads the JWKS address from the discovery document of the issuer', async () => {
      await expect(discoverJwksUri(h.provider.issuer)).resolves.toBe(h.provider.jwksUri);
      expect(h.provider.discoveryFetches).toBe(1);
    });

    it('refuses a discovery document that names another issuer', async () => {
      const lying = async (): Promise<Response> => new Response(JSON.stringify({ issuer: 'https://evil.example', jwks_uri: 'https://evil.example/jwks' }), { status: 200 });
      await expect(discoverJwksUri(h.provider.issuer, lying)).rejects.toThrow(/issuer/);
    });

    it('fails when discovery is unavailable or has no jwks_uri', async () => {
      h.provider.setDown(true);
      await expect(discoverJwksUri(h.provider.issuer)).rejects.toThrow();
      const empty = async (): Promise<Response> => new Response(JSON.stringify({ issuer: h.provider.issuer }), { status: 200 });
      await expect(discoverJwksUri(h.provider.issuer, empty)).rejects.toThrow(/jwks_uri/);
    });
  });

  describe('keys of the wrong kind', () => {
    it('ignores a published key that is not a signing key of a supported type', async () => {
      const source = {
        keyFor: () => Promise.resolve({ kty: 'oct', k: 'c2VjcmV0', kid: h.key.kid } as JsonWebKey),
      };
      const verifier = new JwksTokenVerifier({
        issuer: h.provider.issuer,
        identityAudience: IDENTITY_AUDIENCE,
        controlAudience: CONTROL_AUDIENCE,
        jwks: source,
        tenantTokenKeys: () => Promise.resolve([]),
        tenantIssuer: TENANT_ISSUER,
        now: () => NOW,
      });
      expect(await failure(verifier.verifyIdentity(identity()))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('refuses a key restricted to encryption', async () => {
      const source = { keyFor: () => Promise.resolve({ ...h.key.publicJwk, use: 'enc' }) };
      const verifier = new JwksTokenVerifier({
        issuer: h.provider.issuer,
        identityAudience: IDENTITY_AUDIENCE,
        controlAudience: CONTROL_AUDIENCE,
        jwks: source,
        tenantTokenKeys: () => Promise.resolve([]),
        tenantIssuer: TENANT_ISSUER,
        now: () => NOW,
      });
      expect(await failure(verifier.verifyIdentity(identity()))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });
});
