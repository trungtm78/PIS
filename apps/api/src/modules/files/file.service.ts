import { randomUUID } from 'node:crypto';
import { DomainError, MAX_PRESIGN_TTL_SECONDS, assertLinkable, objectKey, parseObjectKey, signUrl, validateUpload, verifyUrl } from '@machvon/kernel';
import type { ObjectStoragePort, PresignedGrant, ScanPort, ScanStatus, StoredObject, TenantContext, UploadPurpose } from '@machvon/kernel';

/** The internal caller of a redeemed presigned URL: the bearer of the link acts for the tenant that signed it, as no one in particular. */
const LINK_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000000';

export interface FileServiceOptions {
  storage: ObjectStoragePort;
  scanner: ScanPort;
  /** Signing key of presigned URLs, at least 16 bytes. */
  urlSecret: Uint8Array | string;
  now?: () => Date;
}

export interface UploadInput {
  purpose: UploadPurpose;
  declaredType: string;
  bytes: Uint8Array;
}

export interface UploadResult {
  key: string;
  scanStatus: ScanStatus;
}

const notFound = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

/**
 * The one storage service of the kernel (ST-KERNEL-024): every module that takes files goes through it. An upload is
 * judged by its bytes before anything is stored (422 FILE_TYPE_NOT_ALLOWED, 413 PAYLOAD_TOO_LARGE), stored privately under
 * the tenant prefix as PENDING, scanned, and can be linked or downloaded only once it is CLEAN. A key of another tenant
 * answers 404 exactly as a key that does not exist.
 */
export class FileService {
  private readonly storage: ObjectStoragePort;
  private readonly scanner: ScanPort;
  private readonly urlSecret: Uint8Array | string;
  private readonly now: () => Date;

  constructor(options: FileServiceOptions) {
    this.storage = options.storage;
    this.scanner = options.scanner;
    this.urlSecret = options.urlSecret;
    this.now = options.now ?? (() => new Date());
  }

  async upload(tenant: TenantContext, input: UploadInput): Promise<UploadResult> {
    const verdict = validateUpload(input);
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const key = objectKey(tenant.tenantId, input.purpose, randomUUID());
    await this.storage.put(tenant, key, input.bytes, { contentType: verdict.contentType });
    const scanned = await this.scan(tenant, key);
    return { key, scanStatus: scanned.scanStatus };
  }

  /** Scans a PENDING object and records the verdict; a file that was scanned already keeps its verdict. */
  async scan(tenant: TenantContext, key: string): Promise<StoredObject> {
    const stored = await this.storage.get(tenant, key);
    if (stored === undefined) throw notFound();
    if (stored.object.scanStatus !== 'PENDING') return stored.object;
    const verdict = await this.scanner.scan(stored.bytes);
    // The verdict belongs to the bytes that were scanned: if the object was replaced meanwhile it stays PENDING for the next scan.
    return (await this.storage.setScanStatus(tenant, key, verdict, stored.object.sha256)) ?? stored.object;
  }

  /** The object a module may link or serve: it exists for this tenant and is CLEAN. */
  async open(tenant: TenantContext, key: string): Promise<StoredObject> {
    const object = await this.storage.head(tenant, key);
    if (object === undefined) throw notFound();
    assertLinkable(object.scanStatus);
    return object;
  }

  async download(tenant: TenantContext, key: string): Promise<{ object: StoredObject; bytes: Uint8Array }> {
    await this.open(tenant, key);
    const stored = await this.storage.get(tenant, key);
    if (stored === undefined) throw notFound();
    assertLinkable(stored.object.scanStatus);
    return stored;
  }

  /**
   * Stores a file the platform made itself for this tenant (the files of an export): it is not an upload and is not scanned, it is CLEAN as soon as it is stored. Returns the key.
   */
  async storeGenerated(tenant: TenantContext, kind: string, id: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const key = objectKey(tenant.tenantId, kind, id);
    const stored = await this.storage.put(tenant, key, bytes, { contentType });
    await this.storage.setScanStatus(tenant, key, 'CLEAN', stored.sha256);
    return key;
  }

  /** The bytes of a stored file of this tenant as they are, for the platform to serve what it made (404 when there is none, as for a foreign key). */
  async readStored(tenant: TenantContext, key: string): Promise<{ object: StoredObject; bytes: Uint8Array }> {
    const stored = await this.storage.get(tenant, key);
    if (stored === undefined) throw notFound();
    return stored;
  }

  /** The files of one kind of this tenant, sorted by key (the attachments an export copies). */
  listKind(tenant: TenantContext, kind: string): Promise<StoredObject[]> {
    return this.storage.list(tenant, kind);
  }

  /**
   * Removes a stored file of this tenant for good: the purge of an expired inbox payload (ST-ADM-017). False when the tenant has no such
   * file, which is how a file of another tenant looks too. Only a job that has checked the legal hold may call it.
   */
  remove(tenant: TenantContext, key: string): Promise<boolean> {
    return this.storage.remove(tenant, key);
  }

  /** A link to download one CLEAN file, valid for at most five minutes. */
  async presignDownload(tenant: TenantContext, key: string, ttlSeconds: number = MAX_PRESIGN_TTL_SECONDS): Promise<PresignedGrant> {
    await this.open(tenant, key);
    return signUrl({ method: 'GET', key, ttlSeconds, now: this.now(), secret: this.urlSecret });
  }

  /**
   * Serves a presigned link. A forged, altered, replayed-after-expiry or foreign link all answer the same 401
   * SIGNATURE_INVALID; the scan state is checked again at the moment of the download.
   */
  async redeemDownload(grant: PresignedGrant): Promise<{ object: StoredObject; bytes: Uint8Array }> {
    if (grant.method !== 'GET' || verifyUrl(grant, this.urlSecret, this.now()) !== 'OK') throw new DomainError('SIGNATURE_INVALID', 401);
    const parts = parseObjectKey(grant.key);
    if (parts === undefined) throw new DomainError('SIGNATURE_INVALID', 401);
    return this.download({ tenantId: parts.tenantId, membershipId: LINK_MEMBERSHIP_ID, scopeVersion: 0 }, grant.key);
  }

  /** A link to send one chunk of a file to one key, valid for at most five minutes (ST-MOB-009). */
  presignUpload(key: string, ttlSeconds: number = MAX_PRESIGN_TTL_SECONDS): PresignedGrant {
    return signUrl({ method: 'PUT', key, ttlSeconds, now: this.now(), secret: this.urlSecret });
  }

  /**
   * Checks a link to send a chunk: a forged, altered, expired or foreign link all answer the same 401 SIGNATURE_INVALID. Returns the tenant the key names, which is the tenant the chunk is kept for: the link names no
   * person, the member who asked for it was judged when it was issued.
   */
  redeemUpload(grant: PresignedGrant): { tenantId: string; kind: string; id: string } {
    if (grant.method !== 'PUT' || verifyUrl(grant, this.urlSecret, this.now()) !== 'OK') throw new DomainError('SIGNATURE_INVALID', 401);
    const parts = parseObjectKey(grant.key);
    if (parts === undefined) throw new DomainError('SIGNATURE_INVALID', 401);
    return parts;
  }

  /** Keeps a chunk (or any bytes that are not yet a file anyone may open) under the tenant prefix; it is never served. */
  async storePart(tenantId: string, key: string, bytes: Uint8Array): Promise<void> {
    await this.storage.put({ tenantId, membershipId: LINK_MEMBERSHIP_ID, scopeVersion: 0 }, key, bytes, { contentType: 'application/octet-stream' });
  }

  /** Gives back the bytes of a part, or undefined when there is none. */
  async readPart(tenantId: string, key: string): Promise<Uint8Array | undefined> {
    return (await this.storage.get({ tenantId, membershipId: LINK_MEMBERSHIP_ID, scopeVersion: 0 }, key))?.bytes;
  }

  /** Stores a file put together from parts under its key, as PENDING, and has it scanned: the verdict is returned and recorded on the object. */
  async storeAndScan(tenant: TenantContext, key: string, bytes: Uint8Array, contentType: string): Promise<ScanStatus> {
    await this.storage.put(tenant, key, bytes, { contentType });
    return (await this.scan(tenant, key)).scanStatus;
  }
}
