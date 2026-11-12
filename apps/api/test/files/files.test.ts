import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, MAX_PRESIGN_TTL_SECONDS, objectKey, parseObjectKey, signUrl } from '@machvon/kernel';
import type { ScanPort, TenantContext } from '@machvon/kernel';
import { FileService } from '../../src/modules/files/file.service';
import { filesModule } from '../../src/modules/files';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { objectStorageContract } from './object-storage.contract';
import { scanPortContract } from './scan-port.contract';

const TENANT_A = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const TENANT_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const MEMBER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef');
const START = new Date('2026-06-01T10:00:00Z');

const context = (tenantId: string): TenantContext => ({ tenantId, membershipId: MEMBER, scopeVersion: 1 });
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'utf8'));
const PDF = text('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);

async function temporaryRoot(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'machvon-files-test-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

objectStorageContract('file system (MOCK)', async () => {
  const { root, cleanup } = await temporaryRoot();
  return { storage: new FsObjectStorage(root), cleanup };
});

scanPortContract('mock scanner', () => new MockScanPort());

describe('the description of a stored object comes from the header of its file alone', () => {
  it('reads a header longer than one read chunk and describes the object like the write did', async () => {
    const { root, cleanup } = await temporaryRoot();
    try {
      const storage = new FsObjectStorage(root);
      const tenant = context(TENANT_A);
      const key = objectKey(TENANT_A, 'document', '3a7bd3e2-360c-4c5d-9e1a-7f1c5b5e0001');
      const contentType = `application/${'x'.repeat(9000)}`;
      const payload = Buffer.alloc(300_000, 7);
      const put = await storage.put(tenant, key, payload, { contentType });
      expect(await storage.head(tenant, key)).toEqual(put);
      expect(await storage.list(tenant, 'document')).toEqual([put]);
      expect(Buffer.from((await storage.get(tenant, key))?.bytes ?? []).equals(payload)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

async function refusal(work: Promise<unknown>): Promise<DomainError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('the shared upload pipeline (ST-KERNEL-024)', () => {
  const a = context(TENANT_A);
  const b = context(TENANT_B);
  let root: string;
  let cleanup: () => Promise<void>;
  let storage: FsObjectStorage;
  let scanner: MockScanPort;
  let now: Date;
  let service: FileService;

  beforeEach(async () => {
    ({ root, cleanup } = await temporaryRoot());
    storage = new FsObjectStorage(root);
    scanner = new MockScanPort();
    now = new Date(START);
    service = new FileService({ storage, scanner, urlSecret: SECRET, now: () => now });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('stores an accepted file under the tenant prefix and scans it before anyone can link it', async () => {
    const uploaded = await service.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
    expect(uploaded.scanStatus).toBe('CLEAN');
    expect(parseObjectKey(uploaded.key)).toMatchObject({ tenantId: TENANT_A, kind: 'document' });
    expect(scanner.scanned).toEqual([PDF.length]);
    const downloaded = await service.download(a, uploaded.key);
    expect(Buffer.from(downloaded.bytes).equals(Buffer.from(PDF))).toBe(true);
    expect(downloaded.object).toMatchObject({ contentType: 'application/pdf', scanStatus: 'CLEAN', size: PDF.length });
  });

  it('answers 404 to the tenant that asks for the file of another, as for a file that does not exist (AC-ST-KERNEL-024-2, UAT-NFR-TENANCY-04)', async () => {
    const ownedByB = await service.upload(b, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
    const missing = objectKey(TENANT_B, 'document', 'does-not-exist');
    const foreign = await refusal(service.download(a, ownedByB.key));
    const absent = await refusal(service.download(a, missing));
    expect(foreign).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404, detail: undefined });
    expect({ code: foreign.code, status: foreign.status, detail: foreign.detail }).toEqual({ code: absent.code, status: absent.status, detail: absent.detail });
    expect(await refusal(service.open(a, ownedByB.key))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await refusal(service.presignDownload(a, ownedByB.key))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await refusal(service.scan(a, ownedByB.key))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await service.download(b, ownedByB.key)).bytes).toHaveLength(PDF.length);
  });

  it('keeps an infected file, marks it INFECTED and refuses to link or serve it (422 FILE_NOT_CLEAN) (AC-ST-KERNEL-024-2)', async () => {
    const uploaded = await service.upload(a, { purpose: 'document', declaredType: 'text/plain', bytes: eicarBytes() });
    expect(uploaded.scanStatus).toBe('INFECTED');
    expect(await refusal(service.open(a, uploaded.key))).toMatchObject({ code: 'FILE_NOT_CLEAN', status: 422 });
    expect(await refusal(service.download(a, uploaded.key))).toMatchObject({ code: 'FILE_NOT_CLEAN', status: 422 });
    expect(await refusal(service.presignDownload(a, uploaded.key))).toMatchObject({ code: 'FILE_NOT_CLEAN', status: 422 });
    expect((await storage.head(a, uploaded.key))?.scanStatus).toBe('INFECTED');
  });

  it('refuses a file whose scan has not finished (409 SCAN_PENDING) until the scan says CLEAN', async () => {
    const key = objectKey(TENANT_A, 'document', 'pending.pdf');
    await storage.put(a, key, PDF, { contentType: 'application/pdf' });
    expect(await refusal(service.open(a, key))).toMatchObject({ code: 'SCAN_PENDING', status: 409 });
    expect(await refusal(service.download(a, key))).toMatchObject({ code: 'SCAN_PENDING', status: 409 });
    expect((await service.scan(a, key)).scanStatus).toBe('CLEAN');
    expect((await service.open(a, key)).scanStatus).toBe('CLEAN');
  });

  it('keeps the file PENDING when the scanner fails, and lets a retry finish the scan', async () => {
    let failures = 1;
    const flaky: ScanPort = {
      scan: (content) => {
        if (failures-- > 0) return Promise.reject(new Error('scanner down'));
        return new MockScanPort().scan(content);
      },
    };
    const flakyService = new FileService({ storage, scanner: flaky, urlSecret: SECRET, now: () => now });
    await expect(flakyService.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF })).rejects.toThrow('scanner down');
    const [pending] = await storage.list(a, 'document');
    expect(pending?.scanStatus).toBe('PENDING');
    expect(await refusal(flakyService.open(a, pending?.key ?? ''))).toMatchObject({ code: 'SCAN_PENDING' });
    expect((await flakyService.scan(a, pending?.key ?? '')).scanStatus).toBe('CLEAN');
  });

  it('gives the verdict only to the content that was scanned when the object is replaced during the scan', async () => {
    const key = objectKey(TENANT_A, 'document', 'race.pdf');
    await storage.put(a, key, PDF, { contentType: 'application/pdf' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow: ScanPort = {
      scan: async (content) => {
        started();
        await gate;
        return new MockScanPort().scan(content);
      },
    };
    const slowService = new FileService({ storage, scanner: slow, urlSecret: SECRET, now: () => now });
    const scanning = slowService.scan(a, key);
    await running;
    // The file is replaced by other bytes while the scanner still looks at the first ones.
    const replacement = text('%PDF-1.7 other bytes nobody has scanned');
    await storage.put(a, key, replacement, { contentType: 'application/pdf' });
    release();
    expect((await scanning).scanStatus).toBe('PENDING');
    expect(await refusal(slowService.download(a, key))).toMatchObject({ code: 'SCAN_PENDING', status: 409 });
    expect((await service.scan(a, key)).scanStatus).toBe('CLEAN');
    expect(Buffer.from((await service.download(a, key)).bytes).equals(Buffer.from(replacement))).toBe(true);
  });

  it('does not scan twice and never turns a verdict around', async () => {
    const uploaded = await service.upload(a, { purpose: 'document', declaredType: 'text/plain', bytes: eicarBytes() });
    expect((await service.scan(a, uploaded.key)).scanStatus).toBe('INFECTED');
    expect(scanner.scanned).toHaveLength(1);
  });

  it('refuses a script renamed .png, an SVG logo and an oversized PDF, and stores nothing for any of them (AC-ST-KERNEL-024-3)', async () => {
    const script = await refusal(service.upload(a, { purpose: 'logo', declaredType: 'image/png', bytes: text('#!/bin/sh\necho owned\n') }));
    const svg = await refusal(service.upload(a, { purpose: 'logo', declaredType: 'image/svg+xml', bytes: text('<svg xmlns="http://www.w3.org/2000/svg"/>') }));
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set(PDF);
    const oversized = await refusal(service.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: big }));
    expect([script, svg, oversized].map((error) => [error.code, error.status])).toEqual([
      ['FILE_TYPE_NOT_ALLOWED', 422],
      ['FILE_TYPE_NOT_ALLOWED', 422],
      ['PAYLOAD_TOO_LARGE', 413],
    ]);
    expect(await storage.list(a, 'logo')).toEqual([]);
    expect(await storage.list(a, 'document')).toEqual([]);
    expect(scanner.scanned).toEqual([]);
    // The same bytes under the right name are accepted, so the refusals above were for the right reason.
    expect((await service.upload(a, { purpose: 'logo', declaredType: 'image/png', bytes: PNG })).scanStatus).toBe('CLEAN');
  });

  describe('presigned downloads', () => {
    it('work for five minutes and are refused from the 300th second (AC-ST-KERNEL-024-2)', async () => {
      const { key } = await service.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
      const grant = await service.presignDownload(a, key);
      expect(grant.expires - Math.floor(START.getTime() / 1000)).toBe(MAX_PRESIGN_TTL_SECONDS);
      expect((await service.redeemDownload(grant)).bytes).toHaveLength(PDF.length);
      now = new Date(START.getTime() + 299_000);
      expect((await service.redeemDownload(grant)).object.key).toBe(key);
      now = new Date(START.getTime() + 300_000);
      expect(await refusal(service.redeemDownload(grant))).toMatchObject({ code: 'SIGNATURE_INVALID', status: 401 });
    });

    it('cannot be asked for longer than five minutes', async () => {
      const { key } = await service.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
      await expect(service.presignDownload(a, key, MAX_PRESIGN_TTL_SECONDS + 1)).rejects.toThrow(RangeError);
    });

    it('are refused when the key is swapped for the file of another tenant, the method is changed or the signature is cut', async () => {
      const mine = await service.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
      const theirs = await service.upload(b, { purpose: 'document', declaredType: 'application/pdf', bytes: text('%PDF-1.7 tenant B secret') });
      const grant = await service.presignDownload(a, mine.key);
      for (const forged of [
        { ...grant, key: theirs.key },
        { ...grant, method: 'PUT' as const },
        { ...grant, signature: grant.signature.slice(0, -2) },
        { ...grant, expires: grant.expires + 1000 },
      ]) {
        expect(await refusal(service.redeemDownload(forged))).toMatchObject({ code: 'SIGNATURE_INVALID', status: 401 });
      }
    });

    it('refuse a link that was signed for writing, and one signed by another secret', async () => {
      const { key } = await service.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
      const write = signUrl({ method: 'PUT', key, ttlSeconds: 60, now, secret: SECRET });
      expect(await refusal(service.redeemDownload(write))).toMatchObject({ code: 'SIGNATURE_INVALID' });
      const other = signUrl({ method: 'GET', key, ttlSeconds: 60, now, secret: Buffer.from('another-secret-another-secret-00') });
      expect(await refusal(service.redeemDownload(other))).toMatchObject({ code: 'SIGNATURE_INVALID' });
    });

    it('still refuse a file that became unavailable after the link was made', async () => {
      const { key } = await service.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
      const grant = await service.presignDownload(a, key);
      await storage.remove(a, key);
      expect(await refusal(service.redeemDownload(grant))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  it('is registered as the FILES module with a FileService that works against a folder from the environment', async () => {
    expect(filesModule.code).toBe('FILES');
    const provider = (filesModule.providers ?? [])[0] as { provide: unknown; useFactory(): FileService };
    expect(provider.provide).toBe(FileService);
    const previous = process.env.MACHVON_OBJECT_ROOT;
    process.env.MACHVON_OBJECT_ROOT = root;
    try {
      const built = provider.useFactory();
      const uploaded = await built.upload(a, { purpose: 'document', declaredType: 'application/pdf', bytes: PDF });
      expect(uploaded.scanStatus).toBe('CLEAN');
      expect((await storage.list(a, 'document')).map((object) => object.key)).toEqual([uploaded.key]);
    } finally {
      if (previous === undefined) delete process.env.MACHVON_OBJECT_ROOT;
      else process.env.MACHVON_OBJECT_ROOT = previous;
    }
  });
});
