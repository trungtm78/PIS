import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_BYTES,
  assembledMatches,
  assertAttachmentLinkable,
  assertInit,
  assertLooksLike,
  attachmentSha256Of,
  chunkCountOf,
  chunkSizeAt,
  missingChunks,
} from '../src/sync-attachment';

const refusal = (run: () => unknown): { code: string; detail: string | undefined } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string };
    return { code: known.code, detail: known.detail };
  }
  throw new Error('it was allowed');
};
const HASH = 'a'.repeat(64);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

describe('the attachments a phone uploads in chunks (ST-MOB-009)', () => {
  it('cuts a file into chunks of a fixed size, the last one what is left, and a file of 12 MiB into 12', () => {
    expect(chunkCountOf(12 * ATTACHMENT_CHUNK_BYTES)).toBe(12);
    expect(chunkCountOf(12 * ATTACHMENT_CHUNK_BYTES + 1)).toBe(13);
    expect(chunkCountOf(1)).toBe(1);
    expect(chunkSizeAt(2 * ATTACHMENT_CHUNK_BYTES + 10, 0)).toBe(ATTACHMENT_CHUNK_BYTES);
    expect(chunkSizeAt(2 * ATTACHMENT_CHUNK_BYTES + 10, 2)).toBe(10);
    expect(chunkSizeAt(2 * ATTACHMENT_CHUNK_BYTES, 1)).toBe(ATTACHMENT_CHUNK_BYTES);
  });

  it('refuses a chunk that is not one of the file', () => {
    for (const bad of [-1, 3, 1.5, Number.NaN]) expect(refusal(() => chunkSizeAt(2 * ATTACHMENT_CHUNK_BYTES + 10, bad))).toEqual({ code: 'VALIDATION_FAILED', detail: 'chunk' });
  });

  it('knows which chunks are still to come, so an upload goes on from where it stopped', () => {
    const size = 12 * ATTACHMENT_CHUNK_BYTES;
    expect(missingChunks(size, [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(missingChunks(size, [0, 1, 2, 3, 4, 5, 2, 5])).toEqual([6, 7, 8, 9, 10, 11]);
    expect(missingChunks(size, Array.from({ length: 12 }, (_, index) => index))).toEqual([]);
  });

  it('takes a size from 1 byte to 50 MiB, a lower-case SHA-256 and a type the purpose accepts', () => {
    expect(assertInit({ sha256: HASH, size_bytes: 12, mime: ' IMAGE/JPEG ' })).toEqual({ sha256: HASH, sizeBytes: 12, mime: 'image/jpeg' });
    expect(refusal(() => assertInit({ sha256: HASH.toUpperCase(), size_bytes: 12, mime: 'image/jpeg' })).detail).toBe('sha256');
    expect(refusal(() => assertInit({ sha256: HASH, size_bytes: 0, mime: 'image/jpeg' })).detail).toBe('size_bytes');
    expect(refusal(() => assertInit({ sha256: HASH, size_bytes: 1.5, mime: 'image/jpeg' })).detail).toBe('size_bytes');
    expect(refusal(() => assertInit({ sha256: HASH, size_bytes: ATTACHMENT_MAX_BYTES + 1, mime: 'image/jpeg' }))).toEqual({ code: 'PAYLOAD_TOO_LARGE', detail: undefined });
    expect(refusal(() => assertInit({ sha256: HASH, size_bytes: 12, mime: 'image/svg+xml' }))).toEqual({ code: 'FILE_TYPE_NOT_ALLOWED', detail: undefined });
    expect(refusal(() => assertInit({ sha256: HASH, size_bytes: 12, mime: 7 })).code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('compares the put-together file with what was declared: the size and the SHA-256', () => {
    const declared = { sha256: attachmentSha256Of(JPEG), sizeBytes: JPEG.length, mime: 'image/jpeg' };
    expect(assembledMatches(JPEG, declared)).toBe(true);
    expect(assembledMatches(JPEG.slice(0, 7), declared)).toBe(false);
    expect(assembledMatches(Uint8Array.from([...JPEG.slice(0, 7), 0]), declared)).toBe(false);
    expect(assembledMatches(JPEG, { ...declared, sha256: HASH })).toBe(false);
  });

  it('judges the bytes against the declared type: a script renamed to .jpg is refused, a real photo is not', () => {
    expect(() => assertLooksLike(JPEG, 'image/jpeg')).not.toThrow();
    const script = Buffer.from('<script>alert(1)</script>');
    expect(refusal(() => assertLooksLike(script, 'image/jpeg'))).toEqual({ code: 'FILE_TYPE_NOT_ALLOWED', detail: undefined });
    expect(refusal(() => assertLooksLike(JPEG, 'application/pdf')).code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('links a file only once it is CLEAN', () => {
    expect(() => assertAttachmentLinkable('CLEAN')).not.toThrow();
    for (const status of ['UPLOADING', 'SCANNING', 'INFECTED']) expect(refusal(() => assertAttachmentLinkable(status))).toEqual({ code: 'ATTACHMENT_NOT_CLEAN', detail: undefined });
  });
});
