import fc from 'fast-check';
import type { DomainError } from '../src/errors.ts';
import {
  InvalidObjectKeyError,
  MAX_PRESIGN_TTL_SECONDS,
  OBJECT_KEY_ROOT,
  UPLOAD_PURPOSES,
  assertLinkable,
  objectKey,
  ownsObjectKey,
  parseObjectKey,
  signUrl,
  transitionScan,
  validateUpload,
  verifyUrl,
} from '../src/object-storage.ts';

const TENANT_A = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const TENANT_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const FILE_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef');
const NOW = new Date('2026-06-01T10:00:00Z');

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'latin1'));
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const PDF = ascii('%PDF-1.7\n%EOF');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);

describe('object keys', () => {
  it('start with tenants/{tenant}/ and carry the kind and the id', () => {
    expect(objectKey(TENANT_A, 'document', FILE_ID)).toBe(`${OBJECT_KEY_ROOT}/${TENANT_A}/document/${FILE_ID}`);
    expect(objectKey(TENANT_A.toUpperCase(), 'logo', 'brand.v2.png')).toBe(`tenants/${TENANT_A}/logo/brand.v2.png`);
  });

  it('parse back to their parts, and only in canonical form', () => {
    const key = objectKey(TENANT_A, 'document', FILE_ID);
    expect(parseObjectKey(key)).toEqual({ tenantId: TENANT_A, kind: 'document', id: FILE_ID });
    for (const bad of [
      '',
      `tenants/${TENANT_A}/document`,
      `tenants/${TENANT_A}/document/${FILE_ID}/extra`,
      `/tenants/${TENANT_A}/document/${FILE_ID}`,
      `tenants/${TENANT_A.toUpperCase()}/document/${FILE_ID}`,
      `t/${TENANT_A}/document/${FILE_ID}`,
      `tenants/${TENANT_A}/document/../${TENANT_B}`,
      `tenants/${TENANT_A}/document/%2e%2e`,
    ]) {
      expect(parseObjectKey(bad)).toBeUndefined();
    }
  });

  it('refuse a tenant that is not a UUID, a kind that is not a plain word and an id that could climb out of its folder', () => {
    expect(() => objectKey('not-a-tenant', 'document', FILE_ID)).toThrow(InvalidObjectKeyError);
    for (const kind of ['', 'Document', '../x', 'a/b', 'a b', '1abc']) expect(() => objectKey(TENANT_A, kind, FILE_ID)).toThrow(InvalidObjectKeyError);
    for (const id of ['', '..', '../x', 'a/b', 'a\\b', '%2e%2e%2f', 'a..b', '.hidden', 'a b', 'x\u0000y', 'x'.repeat(129)]) {
      expect(() => objectKey(TENANT_A, 'document', id)).toThrow(InvalidObjectKeyError);
    }
  });

  it('never name the offending value in the error', () => {
    try {
      objectKey(TENANT_A, 'document', '../secret-id');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-id');
    }
  });

  it('belong to exactly one tenant: a key built for A never resolves under B, whatever the id', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (id) => {
        let key: string;
        try {
          key = objectKey(TENANT_A, 'document', id);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidObjectKeyError);
          return;
        }
        expect(ownsObjectKey(TENANT_A, key)).toBe(true);
        expect(ownsObjectKey(TENANT_B, key)).toBe(false);
        expect(parseObjectKey(key)?.tenantId).toBe(TENANT_A);
      }),
      { numRuns: 500 },
    );
  });

  it('cannot be turned into another tenant key by a traversal string, an encoded slash or a second prefix', () => {
    const attacks = ['..', '../../' + TENANT_B, '..%2f' + TENANT_B, '%2e%2e/' + TENANT_B, `x/../../${TENANT_B}/document/y`, `${TENANT_B}/document/y`, '....//' + TENANT_B];
    for (const attack of attacks) {
      for (const candidate of [attack, `${attack}/y`]) {
        let key: string | undefined;
        try {
          key = objectKey(TENANT_A, 'document', candidate);
        } catch {
          key = undefined;
        }
        if (key !== undefined) expect(ownsObjectKey(TENANT_B, key)).toBe(false);
      }
      expect(ownsObjectKey(TENANT_B, `tenants/${TENANT_A}/document/${attack}`)).toBe(false);
    }
  });

  it('are not owned when the tenant itself is malformed', () => {
    expect(ownsObjectKey('nope', objectKey(TENANT_A, 'document', FILE_ID))).toBe(false);
  });
});

describe('presigned URLs', () => {
  const key = objectKey(TENANT_A, 'document', FILE_ID);
  const grantAt = (ttlSeconds = MAX_PRESIGN_TTL_SECONDS, method: 'GET' | 'PUT' = 'GET') => signUrl({ method, key, ttlSeconds, now: NOW, secret: SECRET });

  it('expire after at most 300 seconds', () => {
    expect(MAX_PRESIGN_TTL_SECONDS).toBe(300);
    expect(grantAt().expires).toBe(Math.floor(NOW.getTime() / 1000) + 300);
    for (const ttl of [0, -1, 301, 3600, 1.5, Number.NaN]) expect(() => grantAt(ttl)).toThrow(RangeError);
  });

  it('verify until the second before the expiry and are refused from the expiry on', () => {
    const grant = grantAt();
    const second = (offset: number): Date => new Date(NOW.getTime() + offset * 1000);
    expect(verifyUrl(grant, SECRET, NOW)).toBe('OK');
    expect(verifyUrl(grant, SECRET, second(299))).toBe('OK');
    expect(verifyUrl(grant, SECRET, new Date(NOW.getTime() + 299_999))).toBe('OK');
    expect(verifyUrl(grant, SECRET, second(300))).toBe('EXPIRED');
    expect(verifyUrl(grant, SECRET, second(301))).toBe('EXPIRED');
    expect(verifyUrl(grant, SECRET, second(86_400))).toBe('EXPIRED');
  });

  it('are refused when the key, the method, the expiry or the signature is changed', () => {
    const grant = grantAt();
    expect(verifyUrl({ ...grant, key: objectKey(TENANT_B, 'document', FILE_ID) }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl({ ...grant, key: objectKey(TENANT_A, 'document', 'other') }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl({ ...grant, method: 'PUT' }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl({ ...grant, expires: grant.expires + 3600 }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl({ ...grant, signature: `${grant.signature.slice(0, -1)}${grant.signature.endsWith('0') ? '1' : '0'}` }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl({ ...grant, signature: grant.signature.slice(2) }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl({ ...grant, signature: 'zz'.repeat(32) }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl(grant, Buffer.from('another-secret-another-secret-0000'), NOW)).toBe('INVALID');
  });

  it('report a tampered grant as invalid even after it has expired, and an expired grant as expired only when it is genuine', () => {
    const grant = grantAt();
    const later = new Date(NOW.getTime() + 600_000);
    expect(verifyUrl({ ...grant, key: objectKey(TENANT_B, 'document', FILE_ID) }, SECRET, later)).toBe('INVALID');
    expect(verifyUrl(grant, SECRET, later)).toBe('EXPIRED');
  });

  it('cannot be replayed for another method of the same key', () => {
    const read = grantAt(300, 'GET');
    const write = grantAt(300, 'PUT');
    expect(read.signature).not.toBe(write.signature);
    expect(verifyUrl({ ...read, method: 'PUT' }, SECRET, NOW)).toBe('INVALID');
  });

  it('refuse a key that is not a tenant object key, a short secret and a grant with garbage members', () => {
    expect(() => signUrl({ method: 'GET', key: 'tenants/../x', ttlSeconds: 60, now: NOW, secret: SECRET })).toThrow(InvalidObjectKeyError);
    expect(() => signUrl({ method: 'GET', key, ttlSeconds: 60, now: NOW, secret: Buffer.from('short') })).toThrow(/secret/);
    expect(verifyUrl({ method: 'GET', key: 'x', expires: 1, signature: 'ab' }, SECRET, NOW)).toBe('INVALID');
    expect(verifyUrl({ method: 'GET', key, expires: Number.NaN, signature: 'ab' }, SECRET, NOW)).toBe('INVALID');
    expect(() => verifyUrl(grantAt(), Buffer.from('short'), NOW)).toThrow(/secret/);
  });
});

describe('upload validation', () => {
  const verdict = (declaredType: string, content: Uint8Array, purpose: keyof typeof UPLOAD_PURPOSES = 'document') => validateUpload({ declaredType, bytes: content, purpose });

  it('accepts a file whose bytes are what the declared type says', () => {
    expect(verdict('application/pdf', PDF)).toEqual({ ok: true, contentType: 'application/pdf' });
    expect(verdict('image/png', PNG, 'logo')).toEqual({ ok: true, contentType: 'image/png' });
    expect(verdict('IMAGE/JPEG; charset=binary', JPEG, 'logo')).toEqual({ ok: true, contentType: 'image/jpeg' });
    expect(verdict('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP, 'import')).toEqual({
      ok: true,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(verdict('text/csv', ascii('a,b\n1,2\n'), 'import')).toEqual({ ok: true, contentType: 'text/csv' });
    expect(verdict('text/csv', Uint8Array.from(Buffer.from('tên,số\nAn,1\n', 'utf8')), 'import')).toEqual({ ok: true, contentType: 'text/csv' });
  });

  it('refuses a script renamed .png: the bytes are not a PNG (AC-ST-KERNEL-024-3)', () => {
    expect(verdict('image/png', ascii('#!/bin/sh\nrm -rf /\n'), 'logo')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('image/png', ascii('<script>alert(1)</script>'), 'logo')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
  });

  it('refuses an SVG logo, whatever it is declared as: it can carry script', () => {
    const svg = ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(verdict('image/svg+xml', svg, 'logo')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('image/png', svg, 'logo')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('text/plain', svg, 'import')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
  });

  it('refuses a PNG declared as a PDF and a PDF declared as a PNG', () => {
    expect(verdict('application/pdf', PNG)).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('image/png', PDF, 'logo')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
  });

  it('refuses a type the purpose does not allow, an unknown type and an empty file', () => {
    expect(verdict('application/pdf', PDF, 'logo')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('application/x-msdownload', ascii('MZ'))).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('application/pdf', new Uint8Array())).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('', PDF)).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
  });

  it('refuses text that contains NUL bytes, is not UTF-8 or looks like markup', () => {
    expect(verdict('text/csv', bytes(0x61, 0x00, 0x62), 'import')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('text/csv', bytes(0xff, 0xfe, 0xfd), 'import')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('text/csv', ascii('  <html><body>x</body></html>'), 'import')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
  });

  it.each([`\f`, `\v`, `\f\f \t`, `\ufeff\f`])('refuses markup behind the leading whitespace %j of an HTML parser', (lead) => {
    const spaces = lead.replace('\ufeff', '');
    const html = ascii(`${spaces}<!DOCTYPE html><html><body>x</body></html>`);
    const withBom = lead.startsWith('\ufeff') ? Uint8Array.from([0xef, 0xbb, 0xbf, ...html]) : html;
    expect(verdict('text/plain', withBom, 'document')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict('text/csv', withBom, 'import')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    // The same text without the markup is a plain document, so the refusal is for the right reason.
    expect(verdict('text/plain', ascii(`${spaces}hello`), 'document').ok).toBe(true);
  });

  it('answers an oversized file with 413 PAYLOAD_TOO_LARGE before it looks at the bytes', () => {
    const limit = UPLOAD_PURPOSES.document.maxBytes;
    const big = new Uint8Array(limit + 1);
    big.set(PDF);
    expect(verdict('application/pdf', big)).toEqual({ ok: false, code: 'PAYLOAD_TOO_LARGE', status: 413 });
    expect(verdict('application/x-unknown', big)).toEqual({ ok: false, code: 'PAYLOAD_TOO_LARGE', status: 413 });
    const exact = new Uint8Array(limit);
    exact.set(PDF);
    expect(verdict('application/pdf', exact).ok).toBe(true);
    expect(UPLOAD_PURPOSES.logo.maxBytes).toBeLessThan(limit);
  });

  it('takes the sealed audit export as CSV or plain text (JSON lines) and nothing else (ST-ADM-016)', () => {
    expect(verdict('text/csv', ascii('record_type,seq\nEVENT,1\n'), 'audit_export')).toEqual({ ok: true, contentType: 'text/csv' });
    expect(verdict('text/plain', ascii('{"record_type":"MANIFEST"}\n'), 'audit_export')).toEqual({ ok: true, contentType: 'text/plain' });
    expect(verdict('application/pdf', PDF, 'audit_export')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(UPLOAD_PURPOSES.audit_export.maxBytes).toBeGreaterThan(UPLOAD_PURPOSES.document.maxBytes);
  });

  it('takes the export of a frozen snapshot as CSV, a workbook or a PDF and nothing else (ST-DIS-016)', () => {
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    expect(verdict('text/csv', ascii('key,label,value\n'), 'report_export')).toEqual({ ok: true, contentType: 'text/csv' });
    expect(verdict(xlsx, ZIP, 'report_export')).toEqual({ ok: true, contentType: xlsx });
    expect(verdict('application/pdf', PDF, 'report_export')).toEqual({ ok: true, contentType: 'application/pdf' });
    expect(verdict('text/plain', ascii('x'), 'report_export')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
    expect(verdict(xlsx, PDF, 'report_export')).toEqual({ ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 });
  });

  it('refuses a purpose it does not know', () => {
    expect(() => validateUpload({ declaredType: 'application/pdf', bytes: PDF, purpose: 'nothing' as never })).toThrow(/purpose/);
  });

  it('never accepts bytes that match no allowed signature, whatever type is declared (property)', () => {
    const declared = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv', 'text/plain', 'application/zip'];
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), fc.constantFrom(...declared), (content, type) => {
        const result = validateUpload({ declaredType: type, bytes: content, purpose: 'document' });
        if (result.ok) {
          // An accepted file really has the signature of what it was declared as.
          const head = Buffer.from(content.slice(0, 8)).toString('latin1');
          if (type === 'application/pdf') expect(head.startsWith('%PDF-')).toBe(true);
          if (type === 'image/png') expect([...content.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
          if (type === 'image/jpeg') expect([...content.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
          if (type.startsWith('text/')) expect(content.includes(0)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('scan state machine', () => {
  it('moves from PENDING to CLEAN or INFECTED and nowhere after that', () => {
    expect(transitionScan('PENDING', 'CLEAN')).toBe('CLEAN');
    expect(transitionScan('PENDING', 'INFECTED')).toBe('INFECTED');
    for (const [from, to] of [
      ['CLEAN', 'INFECTED'],
      ['INFECTED', 'CLEAN'],
      ['CLEAN', 'PENDING'],
      ['INFECTED', 'PENDING'],
      ['PENDING', 'PENDING'],
      ['CLEAN', 'CLEAN'],
    ] as const) {
      expect(() => transitionScan(from, to)).toThrow(/scan/);
    }
  });

  it('lets only a CLEAN file be linked or downloaded; the others get the registered refusal', () => {
    expect(() => assertLinkable('CLEAN')).not.toThrow();
    const refusal = (status: string): DomainError => {
      try {
        assertLinkable(status);
      } catch (error) {
        return error as DomainError;
      }
      throw new Error('should have thrown');
    };
    expect(refusal('PENDING')).toMatchObject({ code: 'SCAN_PENDING', status: 409 });
    expect(refusal('INFECTED')).toMatchObject({ code: 'FILE_NOT_CLEAN', status: 422 });
    expect(refusal('')).toMatchObject({ code: 'FILE_NOT_SCANNED', status: 422 });
    expect(refusal('anything')).toMatchObject({ code: 'FILE_NOT_SCANNED', status: 422 });
  });
});
