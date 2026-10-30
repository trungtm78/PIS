import { describe, expect, it } from '@jest/globals';
import { assertHostnameAllowed, certificateEndsAt, challengeAnswered, challengeEndsAt, challengeRecordName, dueForRecheck, hashOf, isReserved, needsRenewal, newChallenge, normalizeHostname, reservedUntil } from '../src/index.ts';

const NOW = new Date('2026-10-30T03:00:00Z');
const day = (n: number, from = NOW): Date => new Date(from.getTime() + n * 86_400_000);

describe('the hostname of a domain (ST-SAS-017)', () => {
  it('is compared in lower case without a trailing dot, and is a name of letters, digits and hyphens', () => {
    expect(normalizeHostname('  Cao-Bang.Example.VN. ')).toBe('cao-bang.example.vn');
    for (const bad of ['', 'localhost', 'a.b', '-x.example.vn', 'x-.example.vn', 'x_y.example.vn', 'x..example.vn', '192.168.0.1', 'example.123', `${'a'.repeat(64)}.example.vn`, 'ví-dụ.example.vn']) {
      expect(normalizeHostname(bad)).toBeUndefined();
    }
  });

  it('puts a platform subdomain under the platform domain, one label deep, and not on one of the names of the platform', () => {
    expect(assertHostnameAllowed('Cao-Bang.machvon.vn', 'PLATFORM_SUBDOMAIN', 'machvon.vn')).toBe('cao-bang.machvon.vn');
    for (const bad of ['cao-bang.example.vn', 'a.b.machvon.vn', 'machvon.vn']) {
      expect(() => assertHostnameAllowed(bad, 'PLATFORM_SUBDOMAIN', 'machvon.vn')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, detail: 'hostname' }));
    }
    for (const reserved of ['www.machvon.vn', 'api.machvon.vn', 'admin.machvon.vn', 'login.machvon.vn']) {
      expect(() => assertHostnameAllowed(reserved, 'PLATFORM_SUBDOMAIN', 'machvon.vn')).toThrow(expect.objectContaining({ code: 'DOMAIN_TAKEN', status: 409 }));
    }
  });

  it('keeps a custom domain out of the platform domain: a name of the platform is not one a tenant can prove', () => {
    expect(assertHostnameAllowed('portal.caobang.gov.vn', 'CUSTOM', 'machvon.vn')).toBe('portal.caobang.gov.vn');
    for (const taken of ['machvon.vn', 'portal.machvon.vn', 'a.b.machvon.vn']) {
      expect(() => assertHostnameAllowed(taken, 'CUSTOM', 'machvon.vn')).toThrow(expect.objectContaining({ code: 'DOMAIN_TAKEN', status: 409 }));
    }
    expect(() => assertHostnameAllowed('not a host', 'CUSTOM', 'machvon.vn')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'hostname' }));
  });
});

describe('the proof of a custom domain', () => {
  it('asks for a TXT record at _machvon-verify.<host> and keeps only the hash of the token', () => {
    expect(challengeRecordName('portal.caobang.gov.vn')).toBe('_machvon-verify.portal.caobang.gov.vn');
    const challenge = newChallenge();
    expect(challenge.value).toMatch(/^machvon-verify=[A-Za-z0-9_-]{32}$/);
    expect(challenge.hash).toBe(hashOf(challenge.value));
    expect(challenge.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(newChallenge().value).not.toBe(challenge.value);
  });

  it('is answered by a TXT value that holds the token, with the quotes and spaces that DNS tools add, and by nothing else', () => {
    const { value, hash } = newChallenge();
    expect(challengeAnswered([value], hash)).toBe(true);
    expect(challengeAnswered(['v=spf1 -all', ` "${value}" `], hash)).toBe(true);
    expect(challengeAnswered([], hash)).toBe(false);
    expect(challengeAnswered([`${value}x`, value.toUpperCase(), 'machvon-verify=other'], hash)).toBe(false);
  });

  it('lasts a week and ends there', () => {
    expect(challengeEndsAt(NOW)).toEqual(day(7));
  });
});

describe('the life of a domain', () => {
  it('holds a released hostname for 90 days', () => {
    expect(reservedUntil(NOW)).toEqual(day(90));
    expect(isReserved(NOW, day(89))).toBe(true);
    expect(isReserved(NOW, day(90))).toBe(false);
  });

  it('checks a verified domain again every week, and renews a certificate 14 days before it ends', () => {
    expect(dueForRecheck(null, NOW)).toBe(true);
    expect(dueForRecheck(day(-6), NOW)).toBe(false);
    expect(dueForRecheck(day(-7), NOW)).toBe(true);
    expect(certificateEndsAt(NOW)).toEqual(day(90));
    expect(needsRenewal(day(15), NOW)).toBe(false);
    expect(needsRenewal(day(14), NOW)).toBe(true);
    expect(needsRenewal(null, NOW)).toBe(false);
  });
});
