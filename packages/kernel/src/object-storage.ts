import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';
import type { TenantContext } from './tenant-context.ts';

/** Every object of every tenant lives under `tenants/{tenant_id}/` (ST-KERNEL-024). */
export const OBJECT_KEY_ROOT = 'tenants';
/** A presigned URL never lives longer than five minutes. */
export const MAX_PRESIGN_TTL_SECONDS = 300;

const MIN_SECRET_BYTES = 16;
const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX_PATTERN = /^[0-9a-f]+$/;

/** A malformed object key is a programming error (a caller built or forwarded a key it should not), never a client-facing answer. */
export class InvalidObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidObjectKeyError';
  }
}

export interface ObjectKeyParts {
  tenantId: string;
  kind: string;
  id: string;
}

const validId = (id: string): boolean => ID_PATTERN.test(id) && !id.includes('..');

/**
 * Builds `tenants/{tenant_id}/{kind}/{id}`. The tenant must be a UUID (lower-cased), the kind a plain lower-case word and
 * the id a single path segment without `..`, so no value can climb out of its folder or name another tenant's prefix.
 * Error messages never echo the offending values.
 */
export function objectKey(tenantId: string, kind: string, id: string): string {
  const tenant = asUuid(tenantId);
  if (tenant === undefined) throw new InvalidObjectKeyError('object key requires a UUID tenant id');
  if (!KIND_PATTERN.test(kind)) throw new InvalidObjectKeyError('object key kind must be a lower-case word');
  if (!validId(id)) throw new InvalidObjectKeyError('object key id must be one plain path segment');
  return `${OBJECT_KEY_ROOT}/${tenant}/${kind}/${id}`;
}

/** The parts of a canonical object key, or undefined for anything else (another prefix, an extra segment, an upper-case tenant). */
export function parseObjectKey(key: string): ObjectKeyParts | undefined {
  const segments = key.split('/');
  if (segments.length !== 4 || segments[0] !== OBJECT_KEY_ROOT) return undefined;
  const [, tenantId, kind, id] = segments as [string, string, string, string];
  if (asUuid(tenantId) !== tenantId || !KIND_PATTERN.test(kind) || !validId(id)) return undefined;
  return { tenantId, kind, id };
}

/** Whether the key is a canonical key under the prefix of this tenant. */
export function ownsObjectKey(tenantId: string, key: string): boolean {
  const tenant = asUuid(tenantId);
  return tenant !== undefined && parseObjectKey(key)?.tenantId === tenant;
}

export type PresignMethod = 'GET' | 'PUT';

export interface PresignedGrant {
  method: PresignMethod;
  key: string;
  /** Unix time in seconds; the grant is refused from this second on. */
  expires: number;
  /** HMAC-SHA-256 over method, key and expiry, in hexadecimal. */
  signature: string;
}

export interface PresignInput {
  method: PresignMethod;
  key: string;
  ttlSeconds: number;
  now: Date;
  secret: Uint8Array | string;
}

function assertSecret(secret: Uint8Array | string): Buffer {
  const buffer = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (buffer.length < MIN_SECRET_BYTES) throw new Error(`presign secret must be at least ${MIN_SECRET_BYTES} bytes`);
  return buffer;
}

const signatureOf = (method: string, key: string, expires: number, secret: Buffer): string =>
  createHmac('sha256', secret).update(`${method}\n${key}\n${expires}`).digest('hex');

const secondsOf = (moment: Date): number => Math.floor(moment.getTime() / 1000);

/** Signs a time-limited grant for one method on one object key; a lifetime above 300 seconds (or below one) is refused. */
export function signUrl(input: PresignInput): PresignedGrant {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_PRESIGN_TTL_SECONDS) {
    throw new RangeError(`presigned URL lifetime must be 1 to ${MAX_PRESIGN_TTL_SECONDS} seconds`);
  }
  if (parseObjectKey(input.key) === undefined) throw new InvalidObjectKeyError('only a tenant object key can be signed');
  const secret = assertSecret(input.secret);
  const expires = secondsOf(input.now) + input.ttlSeconds;
  return { method: input.method, key: input.key, expires, signature: signatureOf(input.method, input.key, expires, secret) };
}

export type PresignVerdict = 'OK' | 'EXPIRED' | 'INVALID';

/**
 * Checks a grant in constant time. The signature is judged first, so a tampered grant is INVALID even when it is also
 * old; only a genuine grant can be EXPIRED. A grant is valid up to the second before its expiry.
 */
export function verifyUrl(grant: PresignedGrant, secret: Uint8Array | string, now: Date): PresignVerdict {
  const key = assertSecret(secret);
  if (!Number.isSafeInteger(grant.expires) || !HEX_PATTERN.test(grant.signature)) return 'INVALID';
  const expected = Buffer.from(signatureOf(grant.method, grant.key, grant.expires, key), 'hex');
  const given = Buffer.from(grant.signature, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'INVALID';
  return secondsOf(now) >= grant.expires ? 'EXPIRED' : 'OK';
}

export type UploadPurpose = 'document' | 'logo' | 'import' | 'audit_export' | 'report_export';

interface TypeRule {
  /** Whether the first bytes are a signature of this type. */
  matches(bytes: Uint8Array): boolean;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));
const OOXML_PREFIX = 'application/vnd.openxmlformats-officedocument.';

// Office files are zip containers: the signature proves the container, and the declared type must still be an Office type
// the purpose allows; scanning is what looks inside.
const zipContainer: TypeRule = { matches: (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) };

const LEADING_BYTES: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xef, 0xbb, 0xbf]);

function plainText(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  // Markup (HTML, SVG, XML) is script-capable once served; it is not a document. An HTML parser skips space, tab, line feed,
  // form feed and carriage return (and a UTF-8 byte order mark) before the first tag; so does this check, and vertical tab too.
  const first = bytes.find((value) => !LEADING_BYTES.has(value));
  return first !== 0x3c;
}

const TYPE_RULES: Readonly<Record<string, TypeRule>> = {
  'application/pdf': { matches: (bytes) => startsWith(bytes, ascii('%PDF-')) },
  'image/png': { matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/jpeg': { matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  'image/webp': { matches: (bytes) => startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8) },
  [`${OOXML_PREFIX}wordprocessingml.document`]: zipContainer,
  [`${OOXML_PREFIX}spreadsheetml.sheet`]: zipContainer,
  [`${OOXML_PREFIX}presentationml.presentation`]: zipContainer,
  'text/csv': { matches: plainText },
  'text/plain': { matches: plainText },
};

const MEBIBYTE = 1024 * 1024;
const IMAGES = ['image/png', 'image/jpeg', 'image/webp'];
const SPREADSHEET = `${OOXML_PREFIX}spreadsheetml.sheet`;

/** What each purpose of an upload accepts. SVG is in none of them: it can carry script. */
export const UPLOAD_PURPOSES: Readonly<Record<UploadPurpose, { allowed: readonly string[]; maxBytes: number }>> = {
  document: {
    allowed: ['application/pdf', ...IMAGES, `${OOXML_PREFIX}wordprocessingml.document`, SPREADSHEET, `${OOXML_PREFIX}presentationml.presentation`, 'text/csv', 'text/plain'],
    maxBytes: 25 * MEBIBYTE,
  },
  logo: { allowed: IMAGES, maxBytes: 2 * MEBIBYTE },
  import: { allowed: [SPREADSHEET, 'text/csv'], maxBytes: 25 * MEBIBYTE },
  // The sealed export of the audit trail (ST-ADM-016): CSV, or JSON lines which travel as plain text.
  audit_export: { allowed: ['text/csv', 'text/plain'], maxBytes: 64 * MEBIBYTE },
  // The export of a frozen snapshot (ST-DIS-016): CSV, a workbook, or a PDF.
  report_export: { allowed: ['text/csv', SPREADSHEET, 'application/pdf'], maxBytes: 64 * MEBIBYTE },
};

export type UploadVerdict = { ok: true; contentType: string } | { ok: false; code: 'FILE_TYPE_NOT_ALLOWED' | 'PAYLOAD_TOO_LARGE'; status: 422 | 413 };

const NOT_ALLOWED: UploadVerdict = { ok: false, code: 'FILE_TYPE_NOT_ALLOWED', status: 422 };
const TOO_LARGE: UploadVerdict = { ok: false, code: 'PAYLOAD_TOO_LARGE', status: 413 };

/**
 * Judges an upload by what it is, not by what it says it is: the size first (413), then the declared type against the
 * purpose's allow-list and against the signature of the bytes (422 FILE_TYPE_NOT_ALLOWED). Parameters of the declared
 * type (`; charset=...`) and its case are ignored.
 */
export function validateUpload(input: { declaredType: string; bytes: Uint8Array; purpose: UploadPurpose }): UploadVerdict {
  const rules = UPLOAD_PURPOSES[input.purpose] as { allowed: readonly string[]; maxBytes: number } | undefined;
  if (rules === undefined) throw new Error('unknown upload purpose');
  if (input.bytes.length > rules.maxBytes) return TOO_LARGE;
  const contentType = (input.declaredType.split(';')[0] ?? '').trim().toLowerCase();
  if (!rules.allowed.includes(contentType)) return NOT_ALLOWED;
  return TYPE_RULES[contentType]?.matches(input.bytes) === true ? { ok: true, contentType } : NOT_ALLOWED;
}

export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED';

/** PENDING becomes CLEAN or INFECTED once; a verdict is final, so an infected file can never be cleaned by a second scan. */
export function transitionScan(from: ScanStatus, to: ScanStatus): ScanStatus {
  if (from === 'PENDING' && (to === 'CLEAN' || to === 'INFECTED')) return to;
  throw new Error(`illegal scan transition ${from} to ${to}`);
}

/**
 * The guard in front of every link and download: only a CLEAN file passes. A pending scan answers 409 SCAN_PENDING, an
 * infected file 422 FILE_NOT_CLEAN, and a status that is not known 422 FILE_NOT_SCANNED (fail closed).
 */
export function assertLinkable(status: string): asserts status is 'CLEAN' {
  if (status === 'CLEAN') return;
  if (status === 'PENDING') throw new DomainError('SCAN_PENDING', 409);
  if (status === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
  throw new DomainError('FILE_NOT_SCANNED', 422);
}

/** The result of a virus scan; the scanner never returns PENDING. */
export type ScanVerdict = 'CLEAN' | 'INFECTED';

/** Antivirus port. The MOCK adapter recognises the EICAR test string; the real one is deployed inside Vietnam (TK-KERNEL-024-3). */
export interface ScanPort {
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
  sha256: string;
  scanStatus: ScanStatus;
  createdAt: Date;
}

/**
 * Object storage under the tenant prefix. A key that does not belong to the calling tenant behaves exactly like a key
 * that does not exist (`undefined`, `false`, no entry in a listing), so a foreign object cannot be told from a missing
 * one. Writing with a foreign or malformed key is a programming error and throws InvalidObjectKeyError.
 */
export interface ObjectStoragePort {
  put(tenant: TenantContext, key: string, bytes: Uint8Array, meta: { contentType: string }): Promise<StoredObject>;
  head(tenant: TenantContext, key: string): Promise<StoredObject | undefined>;
  get(tenant: TenantContext, key: string): Promise<{ object: StoredObject; bytes: Uint8Array } | undefined>;
  /**
   * Applies a scan verdict through the state machine; undefined when the object does not exist for this tenant.
   * `expectedSha256` names the content the verdict was reached on: when the object holds other bytes by now (it was replaced
   * during the scan) the verdict is not applied and the object is returned as it is, still PENDING. Without it the verdict
   * applies to whatever is stored.
   */
  setScanStatus(tenant: TenantContext, key: string, status: ScanStatus, expectedSha256?: string): Promise<StoredObject | undefined>;
  remove(tenant: TenantContext, key: string): Promise<boolean>;
  /** The objects of one kind of this tenant, sorted by key. */
  list(tenant: TenantContext, kind: string): Promise<StoredObject[]>;
}
