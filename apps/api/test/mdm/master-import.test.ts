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
import { MasterDataController } from '../../src/modules/mdm/master-data.controller';
import { MasterImportController, MasterImportReadsController } from '../../src/modules/mdm/master-import.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const DECISION_DOCUMENT = id(0x70, 1);
const IMPORTER = 1; // master.import and master.read
const CHECKER = 2; // master.review and master.read
const PUBLISHER = 3; // master.publish and master.read
const READER = 4; // master.read
const NOBODY = 5;
const OTHER_TENANT_IMPORTER = 1; // of tenant B
const MAPPING = { key: 'code', label: 'name', valid_from: 'from', parent_key: 'parent', attributes: { category: 'category', relation: 'relation' } };
const HEADER = 'code,name,from,parent,category,relation';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const csv = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${HEADER}\n${lines.join('\n')}\n`);
let counter = 0;
const fileOf = (broken = false): { prefix: string; bytes: Uint8Array } => {
  counter += 1;
  const prefix = `IMP${counter}`;
  return {
    prefix,
    bytes: csv([
      `${prefix}-1,Ngân sách A,2024-01-01,,NSTW,ADDITIVE`,
      `${prefix}-2,Ngân sách B,2024-01-01,${prefix}-1,NSTW,ADDITIVE`,
      `${prefix}-3,Chương trình,2024-01-01,${broken ? '' : `${prefix}-2`},CTMTQG,SUBSET_OF`,
    ]),
  };
};

describe('master data bulk import commands and reads (ST-MDM-006)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function upload(member: number, bytes: Uint8Array, options: { type?: string; tenantId?: string; key?: string; name?: string } = {}): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: options.type ?? 'text/csv' }), options.name ?? 'catalogue.csv');
    const response = await fetch(`${app.baseUrl}/master-imports/files`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: tokenOf(member, options.tenantId), 'idempotency-key': options.key ?? `key-${randomUUID()}` },
      body: form,
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function stage(member: number, bytes: Uint8Array, mode = 'ATOMIC'): Promise<Reply> {
    const uploaded = await upload(member, bytes);
    expect(uploaded.status).toBe(200);
    return call('POST', '/master-imports', { member, body: { master_type: 'FUND_SOURCE', file_object_key: uploaded.json.file_object_key, file_sha256: uploaded.json.file_sha256, mapping: MAPPING, mode } });
  }
  const apply = (member: number, batchId: string, version: number): Promise<Reply> => call('POST', `/master-imports/${batchId}/apply`, { member, ifMatch: `"${version}"` });
  const decide = (member: number, batchId: string, version: number, decision = 'approve'): Promise<Reply> =>
    call('POST', `/master-imports/${batchId}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason: 'Checked against the decision' } });
  const publish = (member: number, batchId: string, version: number): Promise<Reply> =>
    call('POST', `/master-imports/${batchId}/publish`, { member, ifMatch: `"${version}"`, body: { decision_document_id: DECISION_DOCUMENT } });

  beforeAll(async () => {
    await harness.start();
    root = await mkdtemp(join(tmpdir(), 'machvon-import-test-'));
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      await harness.owner(tenant, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`,
          [tenant, DECISION_DOCUMENT, memberId(1)],
        ],
        ["insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'FUND_SOURCE', 'TENANT_ONLY', $2)", [tenant, memberId(1)]],
      ]);
    }
    for (const n of [IMPORTER, CHECKER, PUBLISHER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_IMPORTER, 1);
    await harness.seedRole(TENANT_A, 1, 'IMPORTER', ['master.import', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_CHECKER', ['master.review', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'DATA_PUBLISHER', ['master.publish', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'DATA_READER', ['master.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'IMPORTER', ['master.import', 'master.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: IMPORTER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: PUBLISHER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_IMPORTER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MasterImportController, MasterImportReadsController, MasterDataController],
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

  describe('uploadMasterImportFile', () => {
    it('stores a clean file for the tenant and tells its columns, its rows and its hash; the same key and file answers the same', async () => {
      const { bytes } = fileOf();
      const key = `key-${randomUUID()}`;
      const first = await upload(IMPORTER, bytes, { key });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ file_sha256: shaOf(bytes), size_bytes: bytes.length, format: 'CSV', columns: HEADER.split(','), row_count: 3 });
      expect(first.json.file_object_key).toMatch(new RegExp(`^tenants/${TENANT_A}/import/`));
      expect((await upload(IMPORTER, bytes, { key })).json.file_object_key).toBe(first.json.file_object_key);
      expect(Number((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'master.import_file_uploaded'"))[0]?.n)).toBeGreaterThanOrEqual(1);
    });

    it('refuses what is not a catalogue file: a type that is not allowed, an infected file, a file that is not a table, an empty one', async () => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      expect([(await upload(IMPORTER, png, { type: 'image/png' })).status, (await upload(IMPORTER, png, { type: 'image/png' })).json.code]).toEqual([422, 'FILE_TYPE_NOT_ALLOWED']);
      const infected = await upload(IMPORTER, eicarBytes());
      expect([infected.status, infected.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
      const unreadable = await upload(IMPORTER, new TextEncoder().encode('a,a\n1,2\n'));
      expect([unreadable.status, unreadable.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await upload(IMPORTER, new Uint8Array())).status).toBe(422);
    });

    it('refuses a file above the limit before reading it, and a caller without master.import', async () => {
      const big = new TextEncoder().encode(`${HEADER}\n${'x'.repeat(11 * 1024 * 1024)}`);
      expect((await upload(IMPORTER, big)).status).toBe(413);
      expect((await upload(READER, fileOf().bytes)).status).toBe(403);
      expect((await upload(NOBODY, fileOf().bytes)).status).toBe(403);
    });
  });

  describe('stage, apply, review and publish', () => {
    it('stages a file with a row error, refuses to apply it, and after the fix puts the whole file in force on one decision (AC-ST-MDM-006-1)', async () => {
      const broken = fileOf(true);
      const staged = await stage(IMPORTER, broken.bytes);
      expect(staged.status).toBe(200);
      expect(staged.json).toMatchObject({ status: 'VALIDATED', resource_version: 1 });
      const batch = await call('GET', `/master-imports/${idOf(staged)}`, { member: READER });
      expect(batch.status).toBe(200);
      expect(batch.json).toMatchObject({ status: 'VALIDATED', total_rows: 3, error_rows: 1, errors: [{ row: 4, field: 'parent_key', code: 'INVALID_VALUE' }], changes: {} });
      const rejected = await apply(IMPORTER, idOf(staged), 1);
      expect([rejected.status, rejected.json.code]).toEqual([422, 'IMPORT_HAS_ERRORS']);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.master_record where business_key like $1', [`${broken.prefix}-%`]))[0]?.n)).toBe(0);

      const fixed = fileOf();
      const second = await stage(IMPORTER, fixed.bytes);
      const applied = await apply(IMPORTER, idOf(second), 1);
      expect(applied.json).toMatchObject({ status: 'IN_REVIEW', resource_version: 2 });
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.master_record where business_key like $1', [`${fixed.prefix}-%`]))[0]?.n)).toBe(3);
      // Who applied the batch decides and publishes none of it.
      expect((await decide(IMPORTER, idOf(second), versionOf(applied))).status).toBe(403);
      expect((await publish(PUBLISHER, idOf(second), versionOf(applied))).json.code).toBe('CHANGE_NOT_APPROVED');
      const approved = await decide(CHECKER, idOf(second), versionOf(applied));
      expect(approved.status).toBe(200);
      expect((await decide(CHECKER, idOf(second), versionOf(approved))).json.code).toBe('STAGE_TRANSITION_DENIED');
      const published = await publish(PUBLISHER, idOf(second), versionOf(approved));
      expect(published.json).toMatchObject({ status: 'APPLIED' });
      const records = await rows<{ business_key: string; status: string }>('select business_key, status from machvon.master_record where business_key like $1 order by business_key', [`${fixed.prefix}-%`]);
      expect(records.map((row) => row.status)).toEqual(['EFFECTIVE', 'EFFECTIVE', 'EFFECTIVE']);
      const actions = await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [idOf(second)]);
      expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(['master.import_staged', 'master.import_applied', 'master.import_approved', 'master.import_published']));
      const events = await rows<{ type: string; n: string }>(
        `select type, count(*)::text as n from machvon.outbox_event where type in ('master.import_submitted.v1', 'master.import_applied.v1', 'master.published.v1') and
         (aggregate_id = $1 or aggregate_id in (select id from machvon.master_record where business_key like $2)) group by type order by type`,
        [idOf(second), `${fixed.prefix}-%`],
      );
      expect(events).toEqual([
        { type: 'master.import_applied.v1', n: '1' },
        { type: 'master.import_submitted.v1', n: '1' },
        { type: 'master.published.v1', n: '3' },
      ]);
      // The same file is never applied again (AC-ST-MDM-006-2).
      const again = await stage(IMPORTER, fixed.bytes);
      expect([again.status, again.json.code]).toEqual([409, 'IMPORT_FILE_ALREADY_APPLIED']);
      const listed = await call('GET', '/master-imports?status=APPLIED', { member: READER });
      expect((listed.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toContain(idOf(second));
      expect((listed.json.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty('errors');
    });

    it('rejects a batch as a whole, and refuses a return, which a batch does not have', async () => {
      const file = fileOf();
      const staged = await stage(IMPORTER, file.bytes);
      const applied = await apply(IMPORTER, idOf(staged), 1);
      const returned = await decide(CHECKER, idOf(staged), versionOf(applied), 'return');
      expect([returned.status, returned.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const rejected = await decide(CHECKER, idOf(staged), versionOf(applied), 'reject');
      expect(rejected.json).toMatchObject({ status: 'CANCELLED' });
      expect(await rows('select status from machvon.master_record where business_key like $1', [`${file.prefix}-%`])).toEqual([{ status: 'DRAFT' }, { status: 'DRAFT' }, { status: 'DRAFT' }]);
    });

    it('tells who applied the batch in its view, and refuses a file with nothing to apply (Codex findings 3 and 4)', async () => {
      const staged = await stage(IMPORTER, fileOf().bytes);
      const before = await call('GET', `/master-imports/${idOf(staged)}`, { member: READER });
      expect(before.json).toMatchObject({ created_by: memberId(IMPORTER), applied_by: null });
      await apply(IMPORTER, idOf(staged), 1);
      const after = await call('GET', `/master-imports/${idOf(staged)}`, { member: READER });
      expect(after.json).toMatchObject({ status: 'IN_REVIEW', applied_by: memberId(IMPORTER) });
      expect(((await call('GET', '/master-imports?status=IN_REVIEW', { member: READER })).json.items as Array<Record<string, unknown>>).find((item) => item.id === idOf(staged))).toMatchObject({ applied_by: memberId(IMPORTER) });

      const empty = await stage(IMPORTER, csv([]));
      expect(empty.status).toBe(200);
      expect((await call('GET', `/master-imports/${idOf(empty)}`, { member: READER })).json).toMatchObject({ status: 'VALIDATED', total_rows: 0, error_rows: 0 });
      const refused = await apply(IMPORTER, idOf(empty), 1);
      expect([refused.status, refused.json.code]).toEqual([422, 'IMPORT_EMPTY']);
    });

    it('refuses the individual decision and publication of a change request that the batch owns, and the batch still goes through (Codex finding 1)', async () => {
      const file = fileOf();
      const staged = await stage(IMPORTER, file.bytes);
      const applied = await apply(IMPORTER, idOf(staged), 1);
      const change = (await rows<{ id: string; version: string; master_record_id: string }>('select id, version::text as version, master_record_id from machvon.master_change_request where import_batch_id = $1 order by id limit 1', [idOf(staged)]))[0];
      const denied = await call('POST', `/master-change-requests/${change?.id}/decision`, { member: CHECKER, ifMatch: `"${change?.version}"`, body: { decision: 'approve', reason: 'Checked against the decision' } });
      expect([denied.status, denied.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect(await rows('select status from machvon.master_change_request where id = $1', [change?.id])).toEqual([{ status: 'IN_REVIEW' }]);

      const approved = await decide(CHECKER, idOf(staged), versionOf(applied));
      expect(approved.status).toBe(200);
      const record = (await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [change?.master_record_id]))[0];
      const alone = await call('POST', `/master-records/${change?.master_record_id}/publish`, { member: PUBLISHER, ifMatch: `"${record?.version}"`, body: { decision_document_id: DECISION_DOCUMENT } });
      expect([alone.status, alone.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect((await rows<{ status: string }>('select status from machvon.master_record where business_key like $1', [`${file.prefix}-%`])).map((row) => row.status)).toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
      expect((await publish(PUBLISHER, idOf(staged), versionOf(approved))).json).toMatchObject({ status: 'APPLIED' });
    });

    it('answers a stale version with 409 VERSION_CONFLICT and one that does not exist with 404', async () => {
      const staged = await stage(IMPORTER, fileOf().bytes);
      expect((await apply(IMPORTER, idOf(staged), 7)).json.code).toBe('VERSION_CONFLICT');
      expect((await apply(IMPORTER, id(0x7e, 1), 1)).status).toBe(404);
    });

    it('refuses a caller without the right permission for each step, and a file that does not match its hash', async () => {
      const staged = await stage(IMPORTER, fileOf().bytes);
      expect((await apply(READER, idOf(staged), 1)).status).toBe(403);
      expect((await apply(CHECKER, idOf(staged), 1)).status).toBe(403);
      const applied = await apply(IMPORTER, idOf(staged), 1);
      expect((await decide(PUBLISHER, idOf(staged), versionOf(applied))).status).toBe(403);
      expect((await publish(CHECKER, idOf(staged), versionOf(applied))).status).toBe(403);
      const uploaded = await upload(IMPORTER, fileOf().bytes);
      const wrongHash = await call('POST', '/master-imports', {
        member: IMPORTER,
        body: { master_type: 'FUND_SOURCE', file_object_key: uploaded.json.file_object_key, file_sha256: 'a'.repeat(64), mapping: MAPPING, mode: 'ATOMIC' },
      });
      expect([wrongHash.status, wrongHash.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const badMode = await call('POST', '/master-imports', {
        member: IMPORTER,
        body: { master_type: 'FUND_SOURCE', file_object_key: uploaded.json.file_object_key, file_sha256: uploaded.json.file_sha256, mapping: MAPPING, mode: 'EVERYTHING' },
      });
      expect(badMode.status).toBe(422);
    });
  });

  describe('another tenant', () => {
    it('cannot read, stage from or apply the batches and files of this tenant', async () => {
      const file = fileOf();
      const uploaded = await upload(IMPORTER, file.bytes);
      const staged = await stage(IMPORTER, file.bytes);
      expect((await call('GET', `/master-imports/${idOf(staged)}`, { member: OTHER_TENANT_IMPORTER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/master-imports', { member: OTHER_TENANT_IMPORTER, tenantId: TENANT_B })).json.items).toEqual([]);
      const foreign = await call('POST', '/master-imports', {
        member: OTHER_TENANT_IMPORTER,
        tenantId: TENANT_B,
        body: { master_type: 'FUND_SOURCE', file_object_key: uploaded.json.file_object_key, file_sha256: uploaded.json.file_sha256, mapping: MAPPING, mode: 'ATOMIC' },
      });
      expect(foreign.status).toBe(404);
      expect((await call('POST', `/master-imports/${idOf(staged)}/apply`, { member: OTHER_TENANT_IMPORTER, tenantId: TENANT_B, ifMatch: '"1"' })).status).toBe(404);
    });
  });
});
