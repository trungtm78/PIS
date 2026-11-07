import { createHash } from 'node:crypto';

/** The sha256 of the bytes of an output file, as 64 lower-case hexadecimal characters: what an issued copy records and what a later reader checks the stored file against. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
