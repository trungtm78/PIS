import { generateKeyPairSync, sign } from 'node:crypto';
import { STANDARD_FEATURES, allowedFeature, licenseModeAt, licenseStatusAt, renewalWindow, signLicenseClaims, verifyLicenseToken } from '../src/index';
import type { LicenseClaims, LicenseRevisionState, LicenseSigner } from '../src/index';

const FROM = new Date('2026-10-01T00:00:00Z');
const UNTIL = new Date('2027-10-01T00:00:00Z');
const GRACE = new Date('2027-10-31T00:00:00Z');
const at = (iso: string): Date => new Date(iso);
const revision = (patch: Partial<LicenseRevisionState> = {}): LicenseRevisionState => ({ validFrom: FROM, validUntil: UNTIL, graceUntil: GRACE, ...patch });

describe('licenseStatusAt: the window is [valid_from, valid_until), then the grace period (SAS 3.8, AC40, AC-ST-SAS-003-2)', () => {
  it.each([
    ['one millisecond before valid_from', '2026-09-30T23:59:59.999Z', 'Scheduled'],
    ['exactly at valid_from', '2026-10-01T00:00:00.000Z', 'Active'],
    ['inside the window', '2027-03-01T00:00:00Z', 'Active'],
    ['one millisecond before valid_until', '2027-09-30T23:59:59.999Z', 'Active'],
    ['exactly at valid_until', '2027-10-01T00:00:00.000Z', 'Grace'],
    ['inside the grace period', '2027-10-15T00:00:00Z', 'Grace'],
    ['one millisecond before grace_until', '2027-10-30T23:59:59.999Z', 'Grace'],
    ['exactly at grace_until', '2027-10-31T00:00:00.000Z', 'Expired'],
    ['long after', '2030-01-01T00:00:00Z', 'Expired'],
  ] as const)('%s is %s', (_label, instant, expected) => {
    expect(licenseStatusAt(revision(), at(instant))).toBe(expected);
  });

  it('goes straight from Active to Expired when there is no grace period', () => {
    const noGrace = revision({ graceUntil: UNTIL });
    expect(licenseStatusAt(noGrace, at('2027-09-30T23:59:59.999Z'))).toBe('Active');
    expect(licenseStatusAt(noGrace, UNTIL)).toBe('Expired');
  });

  it('lets Revoked beat every instant of the window and every stored status of the others', () => {
    for (const instant of ['2026-09-01T00:00:00Z', '2027-03-01T00:00:00Z', '2027-10-15T00:00:00Z', '2030-01-01T00:00:00Z']) {
      expect(licenseStatusAt(revision({ status: 'Revoked' }), at(instant))).toBe('Revoked');
    }
    // Any other stored status is only a label of the clock: the clock decides.
    expect(licenseStatusAt(revision({ status: 'Active' }), at('2030-01-01T00:00:00Z'))).toBe('Expired');
    expect(licenseStatusAt(revision({ status: 'Issued' }), at('2027-03-01T00:00:00Z'))).toBe('Active');
  });
});

describe('licenseModeAt: the mode allowedFeature judges (BR-SAS-10)', () => {
  it.each([
    ['before the start', '2026-09-01T00:00:00Z', undefined, 'EXPIRED'],
    ['inside the window', '2027-03-01T00:00:00Z', undefined, 'FULL'],
    ['inside the grace period', '2027-10-15T00:00:00Z', undefined, 'GRACE'],
    ['after the grace period', '2028-01-01T00:00:00Z', undefined, 'EXPIRED'],
    ['revoked inside the window', '2027-03-01T00:00:00Z', 'Revoked', 'REVOKED'],
    ['suspended inside the window', '2027-03-01T00:00:00Z', 'Suspended', 'SUSPENDED'],
    ['suspended and past the grace period', '2028-01-01T00:00:00Z', 'Suspended', 'SUSPENDED'],
  ] as const)('%s is %s', (_label, instant, status, expected) => {
    expect(licenseModeAt(revision(status === undefined ? {} : { status }), at(instant))).toBe(expected);
  });

  const judge = (mode: ReturnType<typeof licenseModeAt>, feature: string, operationKind: 'read' | 'write' | 'export', now: Date): boolean =>
    allowedFeature({ features: STANDARD_FEATURES, overrides: [], licenseMode: mode, tenantPolicy: 'FULL', feature, operationKind, now }).allowed;

  it('makes an expired license follow the expiry behaviour of the plan: reporting reads, export exports, the rest is refused (AC-ST-SAS-003-3)', () => {
    const now = at('2028-01-01T00:00:00Z');
    const expired = licenseModeAt(revision(), now);
    expect([judge(expired, 'reporting', 'read', now), judge(expired, 'reporting', 'write', now), judge(expired, 'export', 'export', now), judge(expired, 'export', 'read', now)]).toEqual([true, false, true, false]);
  });

  it('follows the grace behaviour of the plan inside the grace period: reporting and export still work in full (AC-ST-SAS-003-3)', () => {
    const now = at('2027-10-15T00:00:00Z');
    const grace = licenseModeAt(revision(), now);
    expect([judge(grace, 'reporting', 'write', now), judge(grace, 'export', 'export', now)]).toEqual([true, true]);
  });

  it('refuses everything of a revoked license even inside its window', () => {
    const now = at('2027-03-01T00:00:00Z');
    const revoked = licenseModeAt(revision({ status: 'Revoked' }), now);
    expect([judge(revoked, 'reporting', 'read', now), judge(revoked, 'export', 'export', now)]).toEqual([false, false]);
  });
});

const CLAIMS: LicenseClaims = {
  iss: 'machvon-platform',
  tenant_id: '00000000-0000-4000-8000-00000000000a',
  license_id: '00000000-0000-4000-8000-0000000000f1',
  serial: 'LIC-20261001-0001',
  revision: 1,
  edition: 'STANDARD',
  valid_from: FROM.toISOString(),
  valid_until: UNTIL.toISOString(),
  grace_until: GRACE.toISOString(),
  entitlements_hash: 'a'.repeat(64),
  seats: 50,
  quota: { storage_gb: 100 },
  kid: 'ignored-by-the-signer',
};

function keyPair(keyId: string): { signer: LicenseSigner; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    signer: { keyId, sign: (payload) => Promise.resolve(sign(null, payload, privateKey)) },
    publicKey: publicKey.export({ format: 'der', type: 'spki' }),
  };
}

describe('signed claims', () => {
  it('verifies with the public key of the signing key and returns the claims, the key id taken from the signer', async () => {
    const { signer, publicKey } = keyPair('kid-2026');
    const token = await signLicenseClaims(CLAIMS, signer);
    expect(verifyLicenseToken(token, new Map([['kid-2026', publicKey]]))).toEqual({ valid: true, claims: { ...CLAIMS, kid: 'kid-2026' } });
    expect(token.split('.')).toHaveLength(3);
  });

  it('is deterministic for the same claims and key', async () => {
    const { signer } = keyPair('kid-2026');
    expect(await signLicenseClaims(CLAIMS, signer)).toBe(await signLicenseClaims({ ...CLAIMS }, signer));
  });

  it('fails when any byte of the payload changes (AC-ST-SAS-003-8)', async () => {
    const { signer, publicKey } = keyPair('kid-2026');
    const keys = new Map([['kid-2026', publicKey]]);
    const [header, payload, signature] = (await signLicenseClaims(CLAIMS, signer)).split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...claims, seats: 5000 })).toString('base64url');
    expect(verifyLicenseToken(`${header}.${forged}.${signature}`, keys)).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
    const bytes = Buffer.from(payload, 'base64url');
    for (let index = 0; index < bytes.length; index += 7) {
      const flipped = Buffer.from(bytes);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      expect(verifyLicenseToken(`${header}.${flipped.toString('base64url')}.${signature}`, keys).valid).toBe(false);
    }
  });

  it('fails for a key that did not sign it, and for a key id it does not know', async () => {
    const { signer } = keyPair('kid-2026');
    const other = keyPair('kid-2026');
    const token = await signLicenseClaims(CLAIMS, signer);
    expect(verifyLicenseToken(token, new Map([['kid-2026', other.publicKey]]))).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLicenseToken(token, new Map([['kid-2025', other.publicKey]]))).toEqual({ valid: false, reason: 'UNKNOWN_KEY' });
    expect(verifyLicenseToken(token, new Map([['kid-2026', Buffer.from('not a key')]]))).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses the license of one tenant presented for another, and accepts it for its own', async () => {
    const { signer, publicKey } = keyPair('kid-2026');
    const keys = new Map([['kid-2026', publicKey]]);
    const token = await signLicenseClaims(CLAIMS, signer);
    expect(verifyLicenseToken(token, keys, CLAIMS.tenant_id).valid).toBe(true);
    expect(verifyLicenseToken(token, keys, '00000000-0000-4000-8000-00000000000b')).toEqual({ valid: false, reason: 'TENANT_MISMATCH' });
  });

  it('refuses a token that is not three parts, a header that names no algorithm or another one, and claims of another key id (AC-ST-SAS-003-8)', async () => {
    const { signer, publicKey } = keyPair('kid-2026');
    const keys = new Map([['kid-2026', publicKey]]);
    const [, payload, signature] = (await signLicenseClaims(CLAIMS, signer)).split('.') as [string, string, string];
    const header = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const malformed = { valid: false, reason: 'MALFORMED' };
    expect(verifyLicenseToken('a.b', keys)).toEqual(malformed);
    expect(verifyLicenseToken('', keys)).toEqual(malformed);
    expect(verifyLicenseToken(`${header({ alg: 'none', kid: 'kid-2026' })}.${payload}.${signature}`, keys)).toEqual(malformed);
    expect(verifyLicenseToken(`${header({ alg: 'HS256', kid: 'kid-2026' })}.${payload}.${signature}`, keys)).toEqual(malformed);
    expect(verifyLicenseToken(`${header({ alg: 'EdDSA' })}.${payload}.${signature}`, keys)).toEqual(malformed);
    expect(verifyLicenseToken(`${header({ alg: 'EdDSA', kid: 'kid-2025' })}.${payload}.${signature}`, keys)).toEqual(malformed);
    expect(verifyLicenseToken(`!!!.${payload}.${signature}`, keys)).toEqual(malformed);
    expect(verifyLicenseToken(`${header({ alg: 'EdDSA', kid: 'kid-2026' })}.${Buffer.from('null').toString('base64url')}.${signature}`, keys)).toEqual(malformed);
  });
});

describe('renewalWindow: the renewed revision is seamless and later than the one it replaces (ST-SAS-014, SAS 3.4)', () => {
  const CURRENT = { validUntil: UNTIL };
  const request = (validUntil: string, graceUntil: string) => ({ validUntil: at(validUntil), graceUntil: at(graceUntil) });

  it('starts at the moment of the renewal when the current revision still has time, so nothing is cut and nothing is left empty', () => {
    const verdict = renewalWindow(CURRENT, request('2028-10-01T00:00:00Z', '2028-10-31T00:00:00Z'), at('2027-08-01T00:00:00Z'));
    expect(verdict).toEqual({ ok: true, window: { validFrom: at('2027-08-01T00:00:00Z'), validUntil: at('2028-10-01T00:00:00Z'), graceUntil: at('2028-10-31T00:00:00Z') } });
  });

  it('starts at the end of the current revision when the renewal comes in its grace period, so the days since the end are covered', () => {
    const verdict = renewalWindow(CURRENT, request('2028-10-01T00:00:00Z', '2028-10-01T00:00:00Z'), at('2027-10-10T00:00:00Z'));
    expect(verdict).toMatchObject({ ok: true, window: { validFrom: UNTIL } });
  });

  it('refuses an end that is not later than the current end or not in the future, and a grace period that ends before the term', () => {
    expect(renewalWindow(CURRENT, request('2027-10-01T00:00:00Z', '2027-12-01T00:00:00Z'), at('2027-08-01T00:00:00Z'))).toEqual({ ok: false, field: 'valid_until' });
    expect(renewalWindow(CURRENT, request('2027-09-01T00:00:00Z', '2027-12-01T00:00:00Z'), at('2027-08-01T00:00:00Z'))).toEqual({ ok: false, field: 'valid_until' });
    expect(renewalWindow({ validUntil: at('2026-01-01T00:00:00Z') }, request('2027-05-01T00:00:00Z', '2027-06-01T00:00:00Z'), at('2027-08-01T00:00:00Z'))).toEqual({ ok: false, field: 'valid_until' });
    expect(renewalWindow(CURRENT, request('2028-10-01T00:00:00Z', '2028-09-30T00:00:00Z'), at('2027-08-01T00:00:00Z'))).toEqual({ ok: false, field: 'grace_until' });
  });
});
