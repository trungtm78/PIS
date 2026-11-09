/**
 * The receipt of a web push (YCK.01, NOT-30). A service worker has no session, so what it sends back when it shows a notification or the person taps it
 * must carry its own authority: the push message carries an opaque token, a capability bound to one tenant, one notification and one device and valid for
 * 48 hours. The token is `base64url(version | expiry | tenant | notification | device | HMAC-SHA256)`: 85 bytes, no name, no amount, nothing that can be
 * read back as a fact about the record. It cannot be forged without the key, cannot be moved to another notification, device or tenant, and ends by itself.
 * The key is a secret of the deployment (`MACHVON_WEBPUSH_RECEIPT_KEY`, or a file, or a vault reference); several keys may be listed while one is
 * rotated: the first signs, all verify.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RECEIPT_TTL_SECONDS = 48 * 3600;
const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAC_BYTES = 32;
const BODY_BYTES = 1 + 4 + 16 * 3;
/** The size of a token in characters: the worker and the controller refuse anything else before doing any work. */
export const RECEIPT_TOKEN_LENGTH = Math.ceil(((BODY_BYTES + MAC_BYTES) * 4) / 3);
export const MIN_RECEIPT_KEY_CHARACTERS = 32;

export interface ReceiptScope {
  tenantId: string;
  notificationId: string;
  deviceId: string;
}

const uuidBytes = (value: string): Buffer => Buffer.from(value.replace(/-/g, ''), 'hex');
const uuidOf = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const macOf = (key: string, body: Buffer): Buffer => createHmac('sha256', Buffer.from(key, 'utf8')).update('machvon.webpush.receipt.v1').update(body).digest();

/** True when the three identifiers can be written in a token (they are UUIDs: a notification with another kind of id carries no receipt). */
export const receiptable = (scope: ReceiptScope): boolean => UUID.test(scope.tenantId) && UUID.test(scope.notificationId) && UUID.test(scope.deviceId);

/** The token for a push, or undefined when the identifiers cannot be written in one. */
export function mintReceipt(key: string, scope: ReceiptScope, nowSeconds: number): string | undefined {
  if (!receiptable(scope)) return undefined;
  const body = Buffer.alloc(BODY_BYTES);
  body.writeUInt8(VERSION, 0);
  body.writeUInt32BE(nowSeconds + RECEIPT_TTL_SECONDS, 1);
  uuidBytes(scope.tenantId).copy(body, 5);
  uuidBytes(scope.notificationId).copy(body, 21);
  uuidBytes(scope.deviceId).copy(body, 37);
  return Buffer.concat([body, macOf(key, body)]).toString('base64url');
}

export interface VerifiedReceipt extends ReceiptScope {
  expiresAtSeconds: number;
}

export type ReceiptRefusal = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED';

/** The scope a token carries, or why it is refused. Every key is tried; the comparison does not depend on where the bytes differ. */
export function verifyReceipt(keys: readonly string[], token: string, nowSeconds: number): { ok: true; receipt: VerifiedReceipt } | { ok: false; reason: ReceiptRefusal } {
  if (token.length !== RECEIPT_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'MALFORMED' };
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== BODY_BYTES + MAC_BYTES || raw.readUInt8(0) !== VERSION) return { ok: false, reason: 'MALFORMED' };
  const body = raw.subarray(0, BODY_BYTES);
  const mac = raw.subarray(BODY_BYTES);
  let valid = false;
  for (const key of keys) valid = timingSafeEqual(macOf(key, body), mac) || valid;
  if (!valid) return { ok: false, reason: 'BAD_SIGNATURE' };
  const expiresAtSeconds = body.readUInt32BE(1);
  if (expiresAtSeconds <= nowSeconds) return { ok: false, reason: 'EXPIRED' };
  return {
    ok: true,
    receipt: { tenantId: uuidOf(body.subarray(5, 21)), notificationId: uuidOf(body.subarray(21, 37)), deviceId: uuidOf(body.subarray(37, 53)), expiresAtSeconds },
  };
}

/** The shape of a token the worker may post: the right length and alphabet, nothing else is checked there (the server decides). */
export const looksLikeReceipt = (value: unknown): value is string => typeof value === 'string' && value.length === RECEIPT_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
