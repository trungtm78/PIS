import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';
import { UPLOAD_PURPOSES, validateUpload } from './object-storage.ts';

/**
 * The attachments a phone uploads in chunks (ST-MOB-009, MOB 5 BR-MOB-03): the file is cut into chunks of a fixed size, each sent to a link that is signed for that chunk and lives a few minutes, in any order and as
 * often as needed, so an interrupted upload goes on from the chunk it stopped at. When all are there the server puts them together, compares the size and the SHA-256 with what the phone declared, judges the file by its
 * bytes (a script renamed to .jpg is refused), has it scanned, and the file may be linked to a record only when the scan says CLEAN. The rules below are pure.
 */
export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
export const ATTACHMENT_MAX_BYTES = UPLOAD_PURPOSES.sync_attachment.maxBytes;
export const ATTACHMENT_MIME_TYPES: readonly string[] = UPLOAD_PURPOSES.sync_attachment.allowed;
export type AttachmentStatus = 'UPLOADING' | 'SCANNING' | 'CLEAN' | 'INFECTED';

const SHA256 = /^[0-9a-f]{64}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface AttachmentInit {
  sha256: string;
  sizeBytes: number;
  mime: string;
}

/** What may be started: a size of 1 byte to the maximum, a SHA-256 in lower-case hexadecimal, and a type the purpose accepts. */
export function assertInit(input: { sha256: unknown; size_bytes: unknown; mime: unknown }): AttachmentInit {
  if (typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) throw invalid('sha256');
  if (typeof input.size_bytes !== 'number' || !Number.isInteger(input.size_bytes) || input.size_bytes < 1) throw invalid('size_bytes');
  if (input.size_bytes > ATTACHMENT_MAX_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
  if (typeof input.mime !== 'string' || !ATTACHMENT_MIME_TYPES.includes(input.mime.trim().toLowerCase())) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422);
  return { sha256: input.sha256, sizeBytes: input.size_bytes, mime: input.mime.trim().toLowerCase() };
}

export const chunkCountOf = (sizeBytes: number, chunkBytes: number = ATTACHMENT_CHUNK_BYTES): number => Math.ceil(sizeBytes / chunkBytes);

/** The exact size chunk `index` must have: a full chunk, except the last, which is what is left. */
export function chunkSizeAt(sizeBytes: number, index: number, chunkBytes: number = ATTACHMENT_CHUNK_BYTES): number {
  const count = chunkCountOf(sizeBytes, chunkBytes);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw invalid('chunk');
  return index === count - 1 ? sizeBytes - chunkBytes * (count - 1) : chunkBytes;
}

/** The chunks not yet received, in order. */
export function missingChunks(sizeBytes: number, received: readonly number[], chunkBytes: number = ATTACHMENT_CHUNK_BYTES): number[] {
  const have = new Set(received);
  return Array.from({ length: chunkCountOf(sizeBytes, chunkBytes) }, (_, index) => index).filter((index) => !have.has(index));
}

export const attachmentSha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Whether the put-together file is what the phone declared: the size, and the SHA-256 (compared in constant time). */
export function assembledMatches(bytes: Uint8Array, declared: AttachmentInit): boolean {
  if (bytes.length !== declared.sizeBytes) return false;
  const given = Buffer.from(attachmentSha256Of(bytes), 'hex');
  const expected = Buffer.from(declared.sha256, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The file judged by its bytes against the type it was declared as (422 FILE_TYPE_NOT_ALLOWED): a script renamed to .jpg is refused whatever the phone said. */
export function assertLooksLike(bytes: Uint8Array, mime: string): void {
  const verdict = validateUpload({ declaredType: mime, bytes, purpose: 'sync_attachment' });
  if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
}

/** A file is linked to a record only once the scan has said it is CLEAN (BR-MOB-03). */
export function assertAttachmentLinkable(status: string): void {
  if (status !== 'CLEAN') throw new DomainError('ATTACHMENT_NOT_CLEAN', 409);
}
