import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantContext } from '@machvon/kernel';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';

const TENANT_A = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const TENANT_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const context = (tenantId: string): TenantContext => ({ tenantId, membershipId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', scopeVersion: 1 });

describe('FileService.remove (the purge of an expired inbox payload, ST-ADM-017)', () => {
  it('removes a stored file for good, once, and not a file of another tenant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machvon-files-remove-'));
    try {
      const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: Buffer.from('0123456789abcdef0123456789abcdef') });
      const stored = await files.upload(context(TENANT_A), { purpose: 'audit_export', declaredType: 'text/plain', bytes: Uint8Array.from(Buffer.from('{"record_type":"MANIFEST"}\n')) });
      await expect(files.remove(context(TENANT_B), stored.key)).resolves.toBe(false);
      await expect(files.open(context(TENANT_A), stored.key)).resolves.toMatchObject({ key: stored.key });
      await expect(files.remove(context(TENANT_A), stored.key)).resolves.toBe(true);
      await expect(files.open(context(TENANT_A), stored.key)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await expect(files.remove(context(TENANT_A), stored.key)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
