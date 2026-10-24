import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { NationalCodeFileController } from '../../src/modules/prj/national-code-file.controller';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(120_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // project.national_code.manage
const READER = 2; // project.read
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(['internal_code,national_project_code', ...lines].join('\n'));

describe('the upload door of the national code reconciliation file (ST-PRJ-004)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;

  async function upload(member: number, bytes: Uint8Array, options: { type?: string; key?: string } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: options.type ?? 'text/csv' }), 'national_codes.csv');
    const response = await fetch(`${app.baseUrl}/project-national-code-imports/files`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY), 'idempotency-key': options.key ?? `key-${randomUUID()}` },
      body: form,
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-national-code-file-'));
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [ADMIN, READER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'CODE_ADMIN', ['project.read', 'project.national_code.manage'], 40);
    await harness.seedRole(TENANT_A, 2, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [NationalCodeFileController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('AC-ST-PRJ-004-2: stores a clean file for the tenant and tells its columns, its rows and its hash; the same key and file answers the same', async () => {
    const bytes = csv('DA-001,7000001', 'DA-002,7000002', 'DA-003,7000001');
    const key = `key-${randomUUID()}`;
    const first = await upload(ADMIN, bytes, { key });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ file_sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, format: 'CSV', columns: ['internal_code', 'national_project_code'], row_count: 3 });
    expect(first.json.file_object_key).toMatch(new RegExp(`^tenants/${TENANT_A}/import/`));
    expect((await upload(ADMIN, bytes, { key })).json.file_object_key).toBe(first.json.file_object_key);
    const audit = await harness.owner<{ safe_diff: Record<string, unknown> }>(TENANT_A, [["select safe_diff from machvon.audit_event where action = 'project.national_code_file_uploaded'", []]]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.safe_diff).toMatchObject({ rows: 3, format: 'CSV' });
  });

  it('AC-ST-PRJ-004-2: refuses what is not the file: a type that is not allowed, an infected file, one without the columns, an empty one', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const refusedType = await upload(ADMIN, png, { type: 'image/png' });
    expect([refusedType.status, refusedType.json.code]).toEqual([422, 'FILE_TYPE_NOT_ALLOWED']);
    const infected = await upload(ADMIN, eicarBytes());
    expect([infected.status, infected.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
    // The table reader parses the sender's bytes, so it must come after the scan: an infected file that is no table is infected, not a bad layout.
    const infectedSheet = await upload(ADMIN, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, ...eicarBytes()]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect([infectedSheet.status, infectedSheet.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
    const layout = await upload(ADMIN, new TextEncoder().encode('name,code\nA,1\n'));
    expect([layout.status, layout.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
    const empty = await upload(ADMIN, csv());
    expect([empty.status, empty.json.code]).toEqual([422, 'IMPORT_EMPTY']);
  });

  it('refuses a file above the limit before reading it, and a caller without project.national_code.manage', async () => {
    const big = new TextEncoder().encode(`internal_code,national_project_code\n${'x'.repeat(11 * 1024 * 1024)}`);
    expect((await upload(ADMIN, big)).status).toBe(413);
    expect((await upload(READER, csv('DA-001,7000001'))).status).toBe(403);
  });
});
