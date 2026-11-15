import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StoredFile {
  bytes: Uint8Array;
  mime: string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/**
 * Where the bytes of document versions live (BR-DOC-16, BR-DOC-19). An object is written once: the same key with the
 * same bytes is accepted again, the same key with other bytes is refused, so a stored version never changes.
 * Downloads go through a short-lived signed URL; the port never serves a file by itself.
 */
export interface DocumentFilePort {
  /** Stores the bytes under the key; resolves when they are durable. Throws when the key holds other bytes. */
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** The stored file, or undefined when the key holds nothing. */
  get(key: string): Promise<StoredFile | undefined>;
  /** A URL that serves the object until `now + ttlSeconds`; throws when the key holds nothing. */
  signedUrl(key: string, ttlSeconds: number, now: Date): Promise<SignedUrl>;
}

/** Injection token of the file port. */
export const DOCUMENT_FILE_PORT = Symbol('DOCUMENT_FILE_PORT');

/** The in-memory adapter (MOCK): used until the object storage of the platform is bound (KERNEL-024). */
export class MockDocumentFilePort implements DocumentFilePort {
  private readonly files = new Map<string, StoredFile>();

  put(key: string, bytes: Uint8Array, mime: string): Promise<void> {
    const existing = this.files.get(key);
    if (existing !== undefined) {
      if (Buffer.from(existing.bytes).equals(Buffer.from(bytes)) && existing.mime === mime) return Promise.resolve();
      return Promise.reject(new Error('an object is written once'));
    }
    this.files.set(key, { bytes: new Uint8Array(bytes), mime });
    return Promise.resolve();
  }

  /** The keys that hold an object, in the order they were written: lets a test see what a failed call left behind. */
  keys(): string[] {
    return [...this.files.keys()];
  }

  get(key: string): Promise<StoredFile | undefined> {
    const file = this.files.get(key);
    return Promise.resolve(file === undefined ? undefined : { bytes: new Uint8Array(file.bytes), mime: file.mime });
  }

  signedUrl(key: string, ttlSeconds: number, now: Date): Promise<SignedUrl> {
    if (!this.files.has(key)) return Promise.reject(new Error('no such object'));
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) return Promise.reject(new RangeError('ttl must be a positive number of seconds'));
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    return Promise.resolve({ url: `mock://documents/${encodeURIComponent(key)}?expires=${Math.floor(expiresAt.getTime() / 1000)}`, expiresAt });
  }
}

/**
 * The adapter on a directory of the installation (the volume of uploaded objects): what DOC stores survives a restart of the process and is seen by every process that
 * mounts the same directory (the API and the workers), which the in-memory adapter cannot give. One file for the bytes and one for the mime type, under the SHA-256 of the
 * key (a key is a path of the product, never a path of the disk). Written once, through a temporary name, so a reader never sees half a file.
 * The signed URL keeps the form of the MOCK adapter until the object storage of the platform serves downloads (KERNEL-024).
 */
export class DirectoryDocumentFilePort implements DocumentFilePort {
  constructor(private readonly root: string) {}

  private pathOf(key: string): string {
    const name = createHash('sha256').update(key, 'utf8').digest('hex');
    return join(this.root, name.slice(0, 2), name);
  }

  async put(key: string, bytes: Uint8Array, mime: string): Promise<void> {
    const path = this.pathOf(key);
    const existing = await this.get(key);
    if (existing !== undefined) {
      if (Buffer.from(existing.bytes).equals(Buffer.from(bytes)) && existing.mime === mime) return;
      throw new Error('an object is written once');
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await writeFile(`${path}.mime`, mime, 'utf8');
    await rename(temporary, path);
  }

  async get(key: string): Promise<StoredFile | undefined> {
    const path = this.pathOf(key);
    try {
      const [bytes, mime] = await Promise.all([readFile(path), readFile(`${path}.mime`, 'utf8')]);
      return { bytes: new Uint8Array(bytes), mime };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async signedUrl(key: string, ttlSeconds: number, now: Date): Promise<SignedUrl> {
    if ((await this.get(key)) === undefined) throw new Error('no such object');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) throw new RangeError('ttl must be a positive number of seconds');
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    return { url: `mock://documents/${encodeURIComponent(key)}?expires=${Math.floor(expiresAt.getTime() / 1000)}`, expiresAt };
  }
}

/**
 * The file port of this process: the directory `doc-files` of the object root when the installation names one (`MACHVON_OBJECT_ROOT`), the in-memory adapter otherwise
 * (a development or test process, which keeps nothing).
 */
export function documentFilePortOfEnvironment(env: NodeJS.ProcessEnv): DocumentFilePort {
  const root = (env.MACHVON_OBJECT_ROOT ?? '').trim();
  return root === '' ? new MockDocumentFilePort() : new DirectoryDocumentFilePort(join(root, 'doc-files'));
}
