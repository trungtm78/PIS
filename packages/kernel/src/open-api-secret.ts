import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The secrets of INT-1: the client credentials of a machine account and the password of a BI login. A secret is made here from random bytes, shown to the person once, and kept only as a hash: the client secret as
 * the SHA-256 of a 256-bit random value (a hash of a high-entropy value needs no slow function), the password of the login as the SCRAM-SHA-256 verifier PostgreSQL itself stores, so the clear password never
 * reaches the database either. Nothing here logs; callers must not.
 */

export const CLIENT_ID_PREFIX = 'mvc_';
export const CLIENT_SECRET_PREFIX = 'mvs_';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const CLIENT_ID = /^mvc_[a-z2-7]{26}$/;
const CLIENT_SECRET = /^mvs_[A-Za-z0-9_-]{43}$/;

function base32(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export interface GeneratedClientCredentials {
  /** The public identifier of the credential; not a secret. */
  clientId: string;
  /** The secret, shown once. */
  clientSecret: string;
  /** What is stored: the SHA-256 of the secret, hex. */
  secretHash: string;
  /** The first characters of the secret, safe to show in a list so a person can tell two credentials apart. */
  secretHint: string;
}

export const isClientId = (value: unknown): value is string => typeof value === 'string' && CLIENT_ID.test(value);
export const isClientSecretShape = (value: unknown): value is string => typeof value === 'string' && CLIENT_SECRET.test(value);

/** The hash that is stored for a secret. */
export const hashClientSecret = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

/** Makes a client id and a secret from the given random source (the default is the system's). */
export function generateClientCredentials(random: (size: number) => Uint8Array = randomBytes): GeneratedClientCredentials {
  const clientId = `${CLIENT_ID_PREFIX}${base32(random(17), 26)}`;
  const clientSecret = `${CLIENT_SECRET_PREFIX}${Buffer.from(random(32)).toString('base64url')}`;
  return { clientId, clientSecret, secretHash: hashClientSecret(clientSecret), secretHint: clientSecret.slice(0, CLIENT_SECRET_PREFIX.length + 4) };
}

/**
 * Whether a presented secret is the one a hash was made from, in constant time. A presented value of the wrong shape is refused before it is hashed, so the work of a refusal does not depend on the value.
 */
export function verifyClientSecret(presented: unknown, storedHash: string): boolean {
  if (!isClientSecretShape(presented) || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const left = Buffer.from(hashClientSecret(presented), 'hex');
  const right = Buffer.from(storedHash, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The password of a BI login, as a SCRAM-SHA-256 verifier.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SCRAM_ITERATIONS = 4096;
const SCRAM_VERIFIER = /^SCRAM-SHA-256\$\d{4,7}:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/** A password of 24 random characters, shown once. */
export function generateBiPassword(random: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(18)).toString('base64url');
}

/** The verifier PostgreSQL stores for a password (RFC 5802 as PostgreSQL writes it): `ALTER ROLE ... PASSWORD '<verifier>'` accepts it as it is, so the clear password is never sent to the server. */
export function scramVerifierOf(password: string, salt: Uint8Array = randomBytes(16), iterations: number = SCRAM_ITERATIONS): string {
  const saltedPassword = pbkdf2Sync(Buffer.from(password.normalize('NFKC'), 'utf8'), Buffer.from(salt), iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${Buffer.from(salt).toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export const isScramVerifier = (value: unknown): value is string => typeof value === 'string' && value.length <= 300 && SCRAM_VERIFIER.test(value);
