import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, sign } from 'node:crypto';
import { issuerFromEnvironment, issuerKeyFromPem } from '../../src/auth/tenant-token-issuer';
import type { LocalTenantTokenIssuer } from '../../src/auth/tenant-token-issuer';
import { JwksTokenVerifier } from '../../src/auth/jwks-token-verifier';
import {
  CONTROL_AUDIENCE,
  IDENTITY_AUDIENCE,
  NOW,
  NOW_SECONDS,
  SESSION_ID,
  TENANT,
  TENANT_ISSUER,
  issuerKey,
  newIssuer,
} from './auth-fixtures';
import { newKey } from './oidc-test-provider';

// Key generation (RSA 2048) is slow on a loaded machine.
jest.setTimeout(30_000);

function verifierFor(issuer: LocalTenantTokenIssuer, now: () => Date = () => NOW): JwksTokenVerifier {
  return new JwksTokenVerifier({
    issuer: 'https://idp.example',
    identityAudience: IDENTITY_AUDIENCE,
    controlAudience: CONTROL_AUDIENCE,
    jwks: { keyFor: () => Promise.resolve(undefined) },
    tenantTokenKeys: async () => (await issuer.publicKeys()).keys,
    tenantIssuer: TENANT_ISSUER,
    now,
  });
}

function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header = '', payload = ''] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('LocalTenantTokenIssuer', () => {
  const aal2At = new Date((NOW_SECONDS - 60) * 1000);

  describe('a support token (ST-SAS-015)', () => {
    const GRANT = '00000000-0000-4000-8000-0000000000e1';
    const support = (grantEndsAt: Date, operatorId: string = TENANT.membershipId) => ({ grantId: GRANT, operatorId, grantEndsAt });

    it('carries act=support, the grant and the operator, lives no longer than the grant, and is read back by the verifier', async () => {
      const issuer = newIssuer();
      const issued = await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW, support: support(new Date(NOW.getTime() + 120_000)) });
      expect(issued.expiresInSeconds).toBe(120);
      expect(decode(issued.accessToken).payload).toMatchObject({ act: 'support', gid: GRANT, opr: TENANT.membershipId, exp: NOW_SECONDS + 120 });
      await expect(verifierFor(issuer).verifyTenantToken(issued.accessToken)).resolves.toMatchObject({ tenant: TENANT, support: { grantId: GRANT, operatorId: TENANT.membershipId } });
      const long = await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW, support: support(new Date(NOW.getTime() + 8 * 3_600_000)) });
      expect(long.expiresInSeconds).toBe(300);
    });

    it('is never issued for a grant that has ended, or for an operator who is not the membership of the context', async () => {
      const issuer = newIssuer();
      expect(await failure(issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW, support: support(NOW) }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await failure(issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW, support: support(new Date(NOW.getTime() + 60_000), '00000000-0000-4000-8000-0000000000e2') }))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('is not carried by an ordinary token, and the verifier refuses a signed token whose act is not support or whose grant, operator or audience is wrong', async () => {
      const signing = issuerKey();
      const issuer = newIssuer(signing);
      const ordinary = await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW });
      expect(decode(ordinary.accessToken).payload).not.toHaveProperty('act');
      expect((await verifierFor(issuer).verifyTenantToken(ordinary.accessToken)).support).toBeUndefined();
      const signed = (extra: Record<string, unknown>): string => {
        const input = `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: signing.kid })).toString('base64url')}.${Buffer.from(JSON.stringify({ ...decode(ordinary.accessToken).payload, ...extra })).toString('base64url')}`;
        return `${input}.${sign('sha256', Buffer.from(input), { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
      };
      const good = { act: 'support', gid: GRANT, opr: TENANT.membershipId };
      await expect(verifierFor(issuer).verifyTenantToken(signed(good))).resolves.toMatchObject({ support: { grantId: GRANT, operatorId: TENANT.membershipId } });
      for (const bad of [{ act: 'admin' }, { act: 'support' }, { ...good, gid: 'not-a-uuid' }, { ...good, opr: '00000000-0000-4000-8000-0000000000e2' }, { ...good, aud: 'machvon-control' }, { act: ['support'], gid: GRANT, opr: TENANT.membershipId }]) {
        expect(await failure(verifierFor(issuer).verifyTenantToken(signed(bad)))).toMatchObject({ code: 'SESSION_EXPIRED' });
      }
    });
  });

  it('issues an ES256 token valid for 300 seconds that carries the tenant context, the session and the mode', async () => {
    const issuer = newIssuer();
    const issued = await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal2', aal2At, mode: 'FULL', now: NOW });
    expect(issued.expiresInSeconds).toBe(300);
    const { header, payload } = decode(issued.accessToken);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(typeof header.kid).toBe('string');
    expect(payload).toMatchObject({
      iss: TENANT_ISSUER,
      aud: 'machvon-api',
      sub: TENANT.membershipId,
      tid: TENANT.tenantId,
      mid: TENANT.membershipId,
      sv: TENANT.scopeVersion,
      sid: SESSION_ID,
      acr: 'aal2',
      mode: 'FULL',
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
    });
    await expect(verifierFor(issuer).verifyTenantToken(issued.accessToken)).resolves.toMatchObject({
      tenant: TENANT,
      sessionId: SESSION_ID,
      assurance: 'aal2',
      aal2At,
      mode: 'FULL',
      audience: 'tenant',
      expiresAt: new Date((NOW_SECONDS + 300) * 1000),
    });
  });

  it('round-trips READ_ONLY mode and an aal1 session without an aal2 time', async () => {
    const issuer = newIssuer();
    const issued = await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'READ_ONLY', now: NOW });
    const verified = await verifierFor(issuer).verifyTenantToken(issued.accessToken);
    expect(verified).toMatchObject({ assurance: 'aal1', mode: 'READ_ONLY' });
    expect(verified.aal2At).toBeUndefined();
    expect(decode(issued.accessToken).payload.auth_time).toBeUndefined();
  });

  it('refuses to issue for a malformed tenant context or an empty session', async () => {
    const issuer = newIssuer();
    await expect(issuer.issue({ tenant: { ...TENANT, tenantId: 'not-a-uuid' }, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW })).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    await expect(issuer.issue({ tenant: TENANT, sessionId: '', assurance: 'aal1', mode: 'FULL', now: NOW })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  describe('rotation', () => {
    it('signs with the active key and publishes both keys during the overlap', async () => {
      const oldKey = issuerKey();
      const rotated = newIssuer(issuerKey(), [oldKey]);
      const { keys } = await rotated.publicKeys();
      expect(keys).toHaveLength(2);
      expect(keys.map((key) => key.kid)).toContain(oldKey.kid);
      for (const key of keys) {
        expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
        expect(JSON.stringify(key)).not.toContain('"d"');
      }
    });

    it('accepts a token signed by the old key while the overlap lasts and refuses it afterwards', async () => {
      const oldKey = issuerKey();
      const before = newIssuer(oldKey);
      const token = (await before.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW })).accessToken;

      let current = newIssuer(issuerKey(), [oldKey]);
      const verifier = new JwksTokenVerifier({
        issuer: 'https://idp.example',
        identityAudience: IDENTITY_AUDIENCE,
        controlAudience: CONTROL_AUDIENCE,
        jwks: { keyFor: () => Promise.resolve(undefined) },
        tenantTokenKeys: async () => (await current.publicKeys()).keys,
        tenantIssuer: TENANT_ISSUER,
        now: () => NOW,
      });
      await expect(verifier.verifyTenantToken(token)).resolves.toMatchObject({ tenant: TENANT });

      current = newIssuer(issuerKey());
      expect(await failure(verifier.verifyTenantToken(token))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('refuses a token signed by a key it has never published', async () => {
      const stranger = newIssuer(issuerKey(newKey('ES256')));
      const token = (await stranger.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW })).accessToken;
      expect(await failure(verifierFor(newIssuer()).verifyTenantToken(token))).toMatchObject({ code: 'SESSION_EXPIRED' });
    });
  });

  describe('keys from the environment', () => {
    function pemFile(): { path: string; kid: string; publicPem: string } {
      const key = newKey('ES256');
      const dir = mkdtempSync(join(tmpdir(), 'machvon-keys-'));
      const path = join(dir, 'tenant-token.pem');
      writeFileSync(path, key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      return { path, kid: 'kid-from-env', publicPem: createPublicKey(key.privateKey).export({ type: 'spki', format: 'pem' }).toString() };
    }

    it('builds the issuer from a PEM file named by the environment', async () => {
      const file = pemFile();
      const issuer = issuerFromEnvironment({ TENANT_TOKEN_SIGNING_KEY_PEM_PATH: file.path, TENANT_TOKEN_KEY_ID: file.kid, TENANT_TOKEN_ISSUER: TENANT_ISSUER });
      const issued = await issuer.issue({ tenant: TENANT, sessionId: SESSION_ID, assurance: 'aal1', mode: 'FULL', now: NOW });
      expect(decode(issued.accessToken).header.kid).toBe(file.kid);
      await expect(verifierFor(issuer).verifyTenantToken(issued.accessToken)).resolves.toMatchObject({ tenant: TENANT });
    });

    it('reads a retired key too, so a rotation needs no code change', async () => {
      const active = pemFile();
      const retired = pemFile();
      const issuer = issuerFromEnvironment({
        TENANT_TOKEN_SIGNING_KEY_PEM_PATH: active.path,
        TENANT_TOKEN_KEY_ID: 'active',
        TENANT_TOKEN_RETIRED_KEY_PEM_PATH: retired.path,
        TENANT_TOKEN_RETIRED_KEY_ID: 'retired',
        TENANT_TOKEN_ISSUER: TENANT_ISSUER,
      });
      expect((await issuer.publicKeys()).keys.map((key) => key.kid)).toEqual(['active', 'retired']);
    });

    it.each([
      ['no key path', { TENANT_TOKEN_KEY_ID: 'kid', TENANT_TOKEN_ISSUER: TENANT_ISSUER }, /TENANT_TOKEN_SIGNING_KEY_PEM_PATH/],
      ['no key id', { TENANT_TOKEN_SIGNING_KEY_PEM_PATH: 'x.pem', TENANT_TOKEN_ISSUER: TENANT_ISSUER }, /TENANT_TOKEN_KEY_ID/],
      ['no issuer', { TENANT_TOKEN_SIGNING_KEY_PEM_PATH: 'x.pem', TENANT_TOKEN_KEY_ID: 'kid' }, /TENANT_TOKEN_ISSUER/],
    ])('refuses to start with %s', (_label, environment, message) => {
      expect(() => issuerFromEnvironment(environment)).toThrow(message);
    });

    it('refuses a key that is not an EC P-256 private key', () => {
      const rsa = newKey('RS256');
      const dir = mkdtempSync(join(tmpdir(), 'machvon-keys-'));
      const path = join(dir, 'rsa.pem');
      writeFileSync(path, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      expect(() => issuerKeyFromPem(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'kid')).toThrow(/P-256/);
      expect(() => issuerFromEnvironment({ TENANT_TOKEN_SIGNING_KEY_PEM_PATH: path, TENANT_TOKEN_KEY_ID: 'kid', TENANT_TOKEN_ISSUER: TENANT_ISSUER })).toThrow(/P-256/);
    });
  });
});
