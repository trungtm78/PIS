import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';

/**
 * Envelope encryption of the personal fields of the platform (ST-LND-002, NFR-PRIVACY-01/02, R-LND-04), kept apart from the database and from any one module.
 *
 * - A **master key** lives outside the database and is served by a {@link FieldKeyProvider} (the platform KMS in production; a key given to the process through its environment elsewhere). Nothing
 *   here ever writes a key to a file, a log or a message.
 * - The key of a field is derived from the master key for one tenant and one purpose (HKDF-SHA-256), so one tenant's data cannot be opened with the key of another, and the key that encrypts is not the
 *   key that makes the blind index.
 * - A value is sealed with AES-256-GCM under a fresh nonce, bound to where it lives (tenant, table, column, row) as additional authenticated data: a ciphertext copied to another row or column does not open.
 * - The first bytes of a ciphertext say the format and the id of the master key, so a key can be replaced and the old values still open until they are written again.
 */

export const FIELD_KEY_BYTES = 32;
const FORMAT = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 2;

/** Serves the master keys by id; the current one seals new values, any of them opens the values it sealed. */
export interface FieldKeyProvider {
  /** The id and the bytes of the master key that seals new values. */
  current(): { id: number; key: Buffer };
  /** The master key of an id, or undefined when this process does not hold it. */
  byId(id: number): Buffer | undefined;
}

/** Where a value lives: the additional data its ciphertext is bound to. */
export interface FieldPlace {
  tenantId: string;
  table: string;
  column: string;
  rowId: string;
}

const aadOf = (place: FieldPlace): Buffer => Buffer.from(`${place.tenantId}|${place.table}|${place.column}|${place.rowId}`, 'utf8');

const derive = (master: Buffer, tenantId: string, purpose: string): Buffer =>
  Buffer.from(hkdfSync('sha256', master, Buffer.from(tenantId, 'utf8'), Buffer.from(`machvon:field:v1:${purpose}`, 'utf8'), FIELD_KEY_BYTES));

/** A provider holding the given master keys; the highest id seals. For a process that was handed its keys, and for tests. */
export function staticKeyProvider(keys: ReadonlyMap<number, Buffer>): FieldKeyProvider {
  const ids = [...keys.keys()].sort((a, b) => a - b);
  const latest = ids[ids.length - 1];
  for (const [id, key] of keys) {
    if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error('the id of a master key is a whole number from 1 to 255');
    if (key.length !== FIELD_KEY_BYTES) throw new Error(`a master key is ${FIELD_KEY_BYTES} bytes`);
  }
  if (latest === undefined) throw new Error('no master key was given');
  return { current: () => ({ id: latest, key: keys.get(latest) as Buffer }), byId: (id) => keys.get(id) };
}

/**
 * The master keys of a process from its environment: `FIELD_ENCRYPTION_KEYS` is `id:base64` pairs separated by commas (`1:AAAA…,2:BBBB…`); the highest id seals. undefined when the variable is not set,
 * so that a process without keys says so instead of sealing with a made-up one. The keys are never logged.
 */
export function fieldKeysFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): FieldKeyProvider | undefined {
  const raw = env.FIELD_ENCRYPTION_KEYS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const keys = new Map<number, Buffer>();
  for (const part of raw.split(',')) {
    const [id, encoded] = part.trim().split(':');
    keys.set(Number(id), Buffer.from(encoded ?? '', 'base64'));
  }
  return staticKeyProvider(keys);
}

/** Seals and opens the personal fields of one process. */
export class FieldCipher {
  private readonly keys: FieldKeyProvider;

  constructor(keys: FieldKeyProvider) {
    this.keys = keys;
  }

  /** Seals a value: format, id of the master key, nonce, tag and the ciphertext. The same value sealed twice gives two different ciphertexts. */
  seal(place: FieldPlace, value: string): Buffer {
    const { id, key } = this.keys.current();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', derive(key, place.tenantId, 'encrypt'), nonce);
    cipher.setAAD(aadOf(place));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT, id]), nonce, cipher.getAuthTag(), body]);
  }

  /** Opens a value sealed for this place; 500-class failure (a defect or tampering, never a caller's fault) when it does not open. */
  open(place: FieldPlace, sealed: Buffer): string {
    if (sealed.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES || sealed[0] !== FORMAT) throw new Error('a sealed field is not in a format this process opens');
    const master = this.keys.byId(sealed[1] as number);
    if (master === undefined) throw new Error('the master key that sealed a field is not held by this process');
    const nonce = sealed.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
    const tag = sealed.subarray(HEADER_BYTES + NONCE_BYTES, HEADER_BYTES + NONCE_BYTES + TAG_BYTES);
    const body = sealed.subarray(HEADER_BYTES + NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', derive(master, place.tenantId, 'encrypt'), nonce);
    decipher.setAAD(aadOf(place));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('a sealed field does not open here: it was changed, or it was copied from another place');
    }
  }

  /**
   * The blind index of a value in a scope (a tenant and, say, a project): HMAC-SHA-256 under a key of its own, in hexadecimal. The same value in the same scope always gives the same index, so a
   * duplicate is found with an equality, and nothing about the value can be had from it. The index uses the key that is current when it is made, so a rotation of the master key needs the
   * indexes made again.
   */
  blindIndex(tenantId: string, scope: string, value: string): string {
    const { key } = this.keys.current();
    return createHmac('sha256', derive(key, tenantId, 'blind-index'))
      .update(`${scope}|${value}`, 'utf8')
      .digest('hex');
  }

  /** Whether two blind indexes are equal, without telling where they differ. */
  static sameIndex(a: string, b: string): boolean {
    return a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }
}

// ---- what is shown instead of a value ---------------------------------------------------------------------------------------------

const MASK = '*';

/** The name with the first letter of each word and the rest hidden: `Nguyễn Văn An` is `N***** V** A*`. */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => {
      const letters = [...word];
      return (letters[0] ?? '') + MASK.repeat(Math.max(letters.length - 1, 0));
    })
    .join(' ');
}

/** A number with all but the last `shown` characters hidden; a number no longer than `shown` is hidden whole. */
export function maskTail(value: string, shown: number): string {
  const letters = [...value];
  return letters.length <= shown ? MASK.repeat(letters.length) : MASK.repeat(letters.length - shown) + letters.slice(-shown).join('');
}

/** The identity number as it is shown: the last four characters. */
export const maskNationalId = (value: string): string => maskTail(value, 4);

/** The telephone number as it is shown: the last three digits. */
export const maskPhone = (value: string): string => maskTail(value, 3);

/** The address as it is shown: only its last part (the district or the province), the street and the number hidden. */
export function maskAddress(value: string): string {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const last = parts[parts.length - 1];
  return parts.length <= 1 || last === undefined ? MASK.repeat(3) : `${MASK.repeat(3)}, ${last}`;
}

// ---- what is accepted as an identity number or a telephone number ----------------------------------------------------------------

/** An identity number as the platform keeps it: nine digits (the old card) or twelve (the citizen card), spaces and dashes taken away; a refusal otherwise (422 `VALIDATION_FAILED`, `national_id`). */
export function normalizeNationalId(value: string): string {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^(\d{9}|\d{12})$/.test(digits)) throw new DomainError('VALIDATION_FAILED', 422, 'national_id');
  return digits;
}

/** A telephone number as the platform keeps it: digits only, the leading +84 written as 0; 9 to 11 digits, a refusal otherwise (422 `VALIDATION_FAILED`, `phone`). */
export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s.()-]/g, '');
  const local = compact.startsWith('+84') ? `0${compact.slice(3)}` : compact;
  if (!/^\d{9,11}$/.test(local)) throw new DomainError('VALIDATION_FAILED', 422, 'phone');
  return local;
}
