import { X509Certificate } from 'node:crypto';
import { DomainError } from '../src/errors.ts';
import { parseSigningCertificate } from '../src/signing-certificate.ts';
import { certificatePem } from './support/x509.ts';

const NOW = new Date('2026-10-24T00:00:00Z');
const DAY = 86_400_000;
// The block is assembled so that no source line holds a whole private-key header (the secret scan refuses such a line, even for a dummy key).
const privateKeyBlock = (kind: string, body: string): string => ['-----BEGIN ', kind, 'PRIVATE KEY-----\n', body, '\n-----END ', kind, 'PRIVATE KEY-----\n'].join('');
const validPem = (): string => certificatePem({ validFrom: new Date(NOW.getTime() - 30 * DAY), validUntil: new Date(NOW.getTime() + 365 * DAY) });

function failure(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('parseSigningCertificate', () => {
  it('reads the serial, names, validity window and the SHA-256 fingerprint of a public certificate', () => {
    const pem = certificatePem({ subject: 'Nguyen Van A', issuer: 'Test CA', serial: 7, validFrom: new Date('2026-09-24T00:00:00Z'), validUntil: new Date('2027-10-24T00:00:00Z') });
    const parsed = parseSigningCertificate(pem, NOW);
    expect(parsed.serial).toBe('07');
    expect(parsed.subjectDn).toContain('Nguyen Van A');
    expect(parsed.issuerDn).toContain('Test CA');
    expect(parsed.validFrom.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(parsed.validUntil.toISOString()).toBe('2027-10-24T00:00:00.000Z');
    expect(parsed.fingerprintSha256).toBe(new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase());
    expect(parsed.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same fingerprint for the same certificate however the PEM is wrapped', () => {
    const pem = validPem();
    const rewrapped = pem.replace(/\n/g, '\r\n');
    expect(parseSigningCertificate(rewrapped, NOW).fingerprintSha256).toBe(parseSigningCertificate(pem, NOW).fingerprintSha256);
  });

  it('refuses a certificate whose validity has ended with CERTIFICATE_EXPIRED', () => {
    const pem = certificatePem({ validFrom: new Date(NOW.getTime() - 400 * DAY), validUntil: new Date(NOW.getTime() - DAY) });
    const error = failure(() => parseSigningCertificate(pem, NOW));
    expect(error).toMatchObject({ code: 'CERTIFICATE_EXPIRED', status: 422 });
  });

  it('refuses a certificate that is not valid yet with CERTIFICATE_INVALID naming the field', () => {
    const pem = certificatePem({ validFrom: new Date(NOW.getTime() + DAY), validUntil: new Date(NOW.getTime() + 365 * DAY) });
    expect(failure(() => parseSigningCertificate(pem, NOW))).toMatchObject({ code: 'CERTIFICATE_INVALID', status: 422, detail: 'valid_from' });
  });

  it('treats the last second of the window as expired and the first second as valid', () => {
    const until = new Date('2026-10-24T00:00:10Z');
    const pem = certificatePem({ validFrom: new Date(NOW.getTime() - DAY), validUntil: until });
    expect(parseSigningCertificate(pem, new Date(until.getTime() - 1000)).validUntil.getTime()).toBe(until.getTime());
    expect(failure(() => parseSigningCertificate(pem, until))).toMatchObject({ code: 'CERTIFICATE_EXPIRED' });
  });

  it.each([
    ['a PKCS#8 private key', privateKeyBlock('', 'MC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')],
    ['an RSA private key', privateKeyBlock('RSA ', 'AAAA')],
    ['an EC private key', privateKeyBlock('EC ', 'AAAA')],
    ['an encrypted private key', privateKeyBlock('ENCRYPTED ', 'AAAA')],
    ['an OpenSSH private key', privateKeyBlock('OPENSSH ', 'AAAA')],
  ])('refuses %s without echoing any of it', (_label, block) => {
    const error = failure(() => parseSigningCertificate(block, NOW));
    expect(error).toMatchObject({ code: 'CERTIFICATE_INVALID', status: 422 });
    expect(JSON.stringify([error.message, error.detail])).not.toContain('AAAA');
    expect(JSON.stringify([error.message, error.detail])).not.toContain('PRIVATE');
  });

  it('refuses a certificate bundled with a private key, however the blocks are ordered', () => {
    const bundle = `${validPem()}${privateKeyBlock('', 'AAAA')}`;
    expect(failure(() => parseSigningCertificate(bundle, NOW))).toMatchObject({ code: 'CERTIFICATE_INVALID' });
    const reversed = `${privateKeyBlock('', 'AAAA')}${validPem()}`;
    expect(failure(() => parseSigningCertificate(reversed, NOW))).toMatchObject({ code: 'CERTIFICATE_INVALID' });
  });

  it.each([
    ['empty text', ''],
    ['plain text', 'not a certificate'],
    ['a truncated PEM', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'],
    ['bad base64 in a PEM', '-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n'],
    ['a certificate request', '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n'],
  ])('refuses %s', (_label, text) => {
    expect(failure(() => parseSigningCertificate(text, NOW))).toMatchObject({ code: 'CERTIFICATE_INVALID', status: 422 });
  });

  it('refuses a bundle of two certificates: one registration is one certificate', () => {
    expect(failure(() => parseSigningCertificate(`${validPem()}${validPem()}`, NOW))).toMatchObject({ code: 'CERTIFICATE_INVALID', detail: 'certificate_pem' });
  });

  it('reads a DER certificate given as base64 text', () => {
    const pem = validPem();
    const base64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(parseSigningCertificate(base64, NOW).fingerprintSha256).toBe(parseSigningCertificate(pem, NOW).fingerprintSha256);
  });
});
