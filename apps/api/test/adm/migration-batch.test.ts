import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AdmMigrationJob } from '../../src/modules/adm/migration.job';
import { MigrationBatchReadsController, MigrationBatchesController } from '../../src/modules/adm/migration-batch.controller';
import { admModule } from '../../src/modules/adm';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { asNumber, asObject, asObjects, asString } from '../support/json';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const REGISTRAR = 1; // adm.migration.manage and adm.migration.read
const APPROVER = 2; // adm.migration.approve and adm.migration.read
const READER = 3; // adm.migration.read
const NOBODY = 4;
const UNIT_ONLY = 5; // adm.migration.manage on one unit, not the tenant
const B_REGISTRAR = 6; // of tenant B
const WORKER = 7; // the membership the job runs as

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const csv = (lines: readonly string[], header = 'business_key,amount,name'): Uint8Array => new TextEncoder().encode(`${header}\n${lines.join('\n')}\n`);

describe('conversion batches: register, dry run, apply and roll back (ST-ADM-020, ADM 3.10, BR-ADM-12, UAT-AC143, UAT-NFR-OPERABILITY-06)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let tenants: TenantDatabase;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const context = (tenantId = TENANT_A) => ({ tenantId, membershipId: memberId(WORKER), scopeVersion: 1 });
  const job = (store: FileService = files) => new AdmMigrationJob(tenants, new AuditWriter(tenants), store);
  const entityOf = (): string => `ACCOUNT${(counter += 1)}`;

  /** A file goes up like any import file (the shared pipeline stores and scans it); the batch is registered with the id it was given. */
  async function stored(bytes: Uint8Array, tenantId = TENANT_A): Promise<string> {
    const { key, scanStatus } = await files.upload({ tenantId, membershipId: memberId(WORKER), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(scanStatus).toBe('CLEAN');
    return key.split('/').pop() as string;
  }
  /** The file goes up the way the screen sends it: as a form, through the guard of the import files. */
  async function upload(member: number, bytes: Uint8Array, options: { type?: string; tenantId?: string; name?: string } = {}): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: options.type ?? 'text/csv' }), options.name ?? 'conversion.csv');
    const response = await fetch(`${app.baseUrl}/migration-batches/files`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: tokenOf(member, options.tenantId), 'idempotency-key': `key-${randomUUID()}` },
      body: form,
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const register = async (member: number, bytes: Uint8Array, entity: string, over: Record<string, unknown> = {}, tenantId = TENANT_A): Promise<Reply> =>
    call('POST', '/migration-batches', {
      member,
      tenantId,
      body: { source_system: 'LEGACY-ERP', target_entity: entity, file_id: await stored(bytes, tenantId), mapping_version: 'GENERIC-1', ...over },
    });
  const batchOf = async (id: string): Promise<Record<string, unknown>> => (await call('GET', `/migration-batches/${id}`, { member: READER })).json;
  const act = (
    member: number,
    id: string,
    action: 'dry-run' | 'apply' | 'rollback',
    version: number,
    reason = 'The conversion was agreed with the owner of the data.',
    tenantId = TENANT_A,
  ): Promise<Reply> => call('POST', `/migration-batches/${id}/${action}`, { member, tenantId, ifMatch: `"${version}"`, body: { reason } });
  /** Registers, dry-runs (the job) and returns the batch. */
  async function dryRun(bytes: Uint8Array, entity: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const registered = await register(REGISTRAR, bytes, entity, over);
    expect(registered.status).toBe(201);
    const asked = await act(REGISTRAR, asString(registered.json.resource_id), 'dry-run', asNumber(registered.json.resource_version));
    expect(asked.status).toBe(202);
    await job().run(context());
    return batchOf(asString(registered.json.resource_id));
  }
  const live = async (entity: string): Promise<Array<{ business_key: string; state: string; amount: string | null }>> =>
    rows('select business_key, state, amount::text as amount from machvon.migration_row where target_entity = $1 order by business_key', [entity]);

  beforeAll(async () => {
    await harness.start();
    root = await mkdtemp(join(tmpdir(), 'machvon-migration-'));
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [REGISTRAR, APPROVER, READER, NOBODY, UNIT_ONLY, WORKER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, B_REGISTRAR, 1);
    await harness.seedRole(TENANT_A, 1, 'MIGRATION_REGISTRAR', ['adm.migration.manage', 'adm.migration.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'MIGRATION_APPROVER', ['adm.migration.approve', 'adm.migration.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'MIGRATION_READER', ['adm.migration.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'MIGRATION_UNIT', ['adm.migration.manage'], 20);
    await harness.seedRole(TENANT_B, 1, 'MIGRATION_REGISTRAR', ['adm.migration.manage', 'adm.migration.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: REGISTRAR, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: UNIT_ONLY, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_REGISTRAR, role: 1, kind: 'TENANT' }]);
    tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [MigrationBatchesController, MigrationBatchReadsController],
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

  it('is registered in the module of ADM', () => {
    for (const controller of [MigrationBatchesController, MigrationBatchReadsController]) expect(admModule.controllers).toContain(controller);
  });

  it('takes the file of a registrar through the upload of the module: stored and scanned, read as a table, and registered by the id it answers with', async () => {
    const bytes = csv(['U1,10,a', 'U2,20,b']);
    const uploaded = await upload(REGISTRAR, bytes);
    expect([uploaded.status, uploaded.json.format, uploaded.json.columns, uploaded.json.row_count, uploaded.json.size_bytes]).toEqual([
      200,
      'CSV',
      ['business_key', 'amount', 'name'],
      2,
      bytes.length,
    ]);
    expect(uploaded.json.file_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const registered = await call('POST', '/migration-batches', {
      member: REGISTRAR,
      body: { source_system: 'LEGACY-ERP', target_entity: entityOf(), file_id: uploaded.json.file_id, mapping_version: 'GENERIC-1' },
    });
    expect(registered.status).toBe(201);
    expect((await batchOf(asString(registered.json.resource_id))).file_sha256).toBe(uploaded.json.file_sha256);
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'adm.migration_batch.file_uploaded'"))[0]?.n).not.toBe('0');
  });

  it('refuses what is not a conversion file: a type that is not allowed, an infected file, a file that is not a table, a caller without the right', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(await upload(REGISTRAR, png, { type: 'image/png' })).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
    expect(await upload(REGISTRAR, eicarBytes())).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
    expect((await upload(REGISTRAR, new TextEncoder().encode('a,a\n1,2\n'))).status).toBe(422);
    expect((await upload(REGISTRAR, new Uint8Array())).status).toBe(422);
    expect((await upload(READER, csv(['U1,1,a']))).status).toBe(403);
    expect((await upload(APPROVER, csv(['U1,1,a']))).status).toBe(403);
    expect((await upload(UNIT_ONLY, csv(['U1,1,a']))).status).toBe(403);
    expect((await upload(NOBODY, csv(['U1,1,a']))).status).toBe(403);
  });

  it('registers a 120-row file with 2 bad rows once, lists the errors of rows 17 and 42 in the dry run, writes nothing, and lets another approver apply it with the control totals matching (UAT-AC143)', async () => {
    const entity = entityOf();
    const lines = Array.from({ length: 120 }, (_, index) => `K${index + 1},${(index + 1) * 1000},name ${index + 1}`);
    lines[16] = ',500,no key';
    lines[41] = 'K42,12.5,bad amount';
    const bytes = csv(lines);
    const registered = await register(REGISTRAR, bytes, entity);
    expect([registered.status, registered.json.status]).toEqual([201, 'Uploaded']);
    const id = registered.json.resource_id as string;
    // The same file for the same entity is not registered twice; another entity may take it.
    expect(await register(REGISTRAR, bytes, entity)).toMatchObject({ status: 409, json: { code: 'MIGRATION_FILE_ALREADY_REGISTERED' } });
    const duplicate = await call('POST', '/migration-batches', {
      member: REGISTRAR,
      body: {
        source_system: 'LEGACY-ERP',
        target_entity: entity,
        file_id: (await rows<{ file_storage_key: string }>('select file_storage_key from machvon.migration_batch where id = $1', [id]))[0]!.file_storage_key.split('/').pop(),
        mapping_version: 'GENERIC-1',
      },
    });
    expect(duplicate).toMatchObject({ status: 409, json: { code: 'MIGRATION_FILE_ALREADY_REGISTERED' } });
    const asked = await act(REGISTRAR, id, 'dry-run', asNumber(registered.json.resource_version));
    expect([asked.status, asked.json.status]).toEqual([202, 'Validating']);
    expect(await job().run(context())).toMatchObject({ dryRuns: 1, failed: 0 });
    const failed = await batchOf(id);
    expect(failed).toMatchObject({ status: 'DryRunFailed', row_count: 120, error_count: 2, dry_run_report_ref: `migration_batch_error:${id}` });
    expect(asObjects(failed.errors).map((error) => [error.row_number, error.line_number, error.field, error.code])).toEqual([
      [17, 18, 'business_key', 'KEY_MISSING'],
      [42, 43, 'amount', 'AMOUNT_INVALID'],
    ]);
    expect(asObject(failed.control_totals).expected).toEqual({
      rows: 118,
      amount: String(Array.from({ length: 120 }, (_, i) => (i + 1) * 1000).reduce((sum, amount, i) => (i === 16 || i === 41 ? sum : sum + amount), 0)),
    });
    expect(await live(entity)).toEqual([]);
    // A failed dry run cannot be applied (409 MIGRATION_STATE_INVALID), by anybody.
    expect(await act(APPROVER, id, 'apply', asNumber(failed.version))).toMatchObject({ status: 409, json: { code: 'MIGRATION_STATE_INVALID' } });

    // The file is mended, registered (another file, another hash), dry-run clean, and applied.
    const mended = csv(lines.map((line, index) => (index === 16 ? 'K17,500,mended' : index === 41 ? 'K42,42000,mended' : line)));
    const clean = await dryRun(mended, entity);
    expect(clean).toMatchObject({ status: 'DryRunPassed', row_count: 120, error_count: 0, errors: [] });
    expect(await live(entity)).toEqual([]);
    // The one who registered it cannot apply it; somebody with the right to approve can.
    expect(await act(REGISTRAR, asString(clean.id), 'apply', asNumber(clean.version))).toMatchObject({ status: 403 });
    expect((await act(APPROVER, asString(clean.id), 'apply', asNumber(clean.version) - 1)).json.code).toBe('VERSION_CONFLICT');
    const applying = await act(APPROVER, asString(clean.id), 'apply', asNumber(clean.version));
    expect([applying.status, applying.json.status]).toEqual([202, 'Applying']);
    expect(await job().run(context())).toMatchObject({ applied: 1, failed: 0 });
    const applied = await batchOf(asString(clean.id));
    const total = Array.from({ length: 120 }, (_, i) => (i === 16 ? 500 : i === 41 ? 42000 : (i + 1) * 1000)).reduce((sum, amount) => sum + amount, 0);
    expect(applied).toMatchObject({
      status: 'Applied',
      rows_applied: 120,
      approved_by: memberId(APPROVER),
      control_totals: { expected: { rows: 120, amount: String(total) }, actual: { rows: 120, amount: String(total) }, matched: true },
    });
    expect(await live(entity)).toHaveLength(120);
    expect((await live(entity))[0]).toMatchObject({ state: 'VALID' });
    expect((await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at', [clean.id])).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['adm.migration_batch.registered', 'adm.migration_batch.dry_run', 'adm.migration_batch.apply_approved', 'adm.migration_batch.applied']),
    );
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.outbox_event where type = 'adm.migration_batch.applied.v1' and aggregate_id = $1", [clean.id]))[0]?.n).toBe('1');
    // An applied batch is applied once (409 MIGRATION_FILE_ALREADY_APPLIED), and cannot be dry-run again.
    expect(await act(APPROVER, asString(clean.id), 'apply', asNumber(applied.version))).toMatchObject({ status: 409, json: { code: 'MIGRATION_FILE_ALREADY_APPLIED' } });
    expect(await act(REGISTRAR, asString(clean.id), 'dry-run', asNumber(applied.version))).toMatchObject({ status: 409, json: { code: 'MIGRATION_FILE_ALREADY_APPLIED' } });
  });

  it('imports the same file twice with no new rows: the second pass finds the batch applied, and a lot that is written again does not double (UAT-NFR-OPERABILITY-06)', async () => {
    const entity = entityOf();
    const clean = await dryRun(csv(['A,10,a', 'B,20,b', 'C,30,c']), entity);
    expect((await act(APPROVER, asString(clean.id), 'apply', asNumber(clean.version))).status).toBe(202);
    expect(await job().run(context())).toMatchObject({ applied: 1 });
    expect(await live(entity)).toHaveLength(3);
    // The worker told twice: the batch is Applied already, nothing is written.
    const before = await rows<{ version: string }>('select version::text as version from machvon.migration_row where target_entity = $1 order by business_key', [entity]);
    expect(await job().run(context())).toEqual({ dryRuns: 0, applied: 0, failed: 0, alreadyImported: 0 });
    const store = new (await import('@machvon/db')).AdmMigrationStore();
    const again = await tenants.withTenant(context(), (tx) => store.finishApply(tx, asString(clean.id)));
    expect(again.outcome).toBe('ALREADY_IMPORTED');
    expect(await live(entity)).toHaveLength(3);
    expect(await rows<{ version: string }>('select version::text as version from machvon.migration_row where target_entity = $1 order by business_key', [entity])).toEqual(before);
    // A lot that is run again upserts: same rows, same total.
    const written = await tenants.withTenant(context(), (tx) => store.writeLot(tx, asString(clean.id), []));
    expect(written).toBeUndefined();
  });

  it('upserts by the business key across batches of one entity, and a later batch takes over the rows it names', async () => {
    const entity = entityOf();
    const first = await dryRun(csv(['A,10,old', 'B,20,old']), entity);
    await act(APPROVER, asString(first.id), 'apply', asNumber(first.version));
    await job().run(context());
    const second = await dryRun(csv(['B,25,new', 'C,30,new']), entity);
    await act(APPROVER, asString(second.id), 'apply', asNumber(second.version));
    await job().run(context());
    expect(await live(entity)).toEqual([
      { business_key: 'A', state: 'VALID', amount: '10' },
      { business_key: 'B', state: 'VALID', amount: '25' },
      { business_key: 'C', state: 'VALID', amount: '30' },
    ]);
    expect(asObject((await batchOf(asString(second.id))).control_totals).actual).toEqual({ rows: 2, amount: '55' });
    // The first batch lost row B to the second: its own figures are not what is in the table now, and it can still be rolled back (it marks its own rows).
    const rolled = await act(APPROVER, asString(first.id), 'rollback', asNumber((await batchOf(asString(first.id))).version));
    expect([rolled.status, rolled.json.status]).toEqual([202, 'RolledBack']);
    expect((await live(entity)).map((row) => [row.business_key, row.state])).toEqual([
      ['A', 'INVALID'],
      ['B', 'VALID'],
      ['C', 'VALID'],
    ]);
  });

  it('stops a batch whose written rows do not add up to the file (Failed CONTROL_TOTALS_MISMATCH), and goes on from the rows it wrote when it is dry-run and applied again', async () => {
    const entity = entityOf();
    const clean = await dryRun(csv(['A,10,a', 'B,20,b', 'C,30,c']), entity);
    expect((await act(APPROVER, asString(clean.id), 'apply', asNumber(clean.version))).status).toBe(202);
    // Somebody changes an amount the batch is about to write: the sums differ from what the file said.
    const store = new (await import('@machvon/db')).AdmMigrationStore();
    await tenants.withTenant(context(), (tx) => store.writeLot(tx, asString(clean.id), [{ rowNumber: 1, lineNumber: 2, businessKey: 'A', amount: '10', payload: {}, refs: [] }]));
    await rows("update machvon.migration_row set amount = 11 where target_entity = $1 and business_key = 'A'", [entity]);
    const pass = await tenants.withTenant(context(), (tx) => store.finishApply(tx, asString(clean.id)));
    expect(pass.outcome).toBe('FAILED');
    const failed = await batchOf(asString(clean.id));
    expect(failed).toMatchObject({
      status: 'Failed',
      failure_code: 'CONTROL_TOTALS_MISMATCH',
      control_totals: { matched: false, expected: { rows: 3, amount: '60' }, actual: { rows: 1, amount: '11' } },
    });
    // It is dry-run again and applied again: the rows are upserted, the figures agree.
    expect((await act(REGISTRAR, asString(clean.id), 'dry-run', asNumber(failed.version))).status).toBe(202);
    await job().run(context());
    const passed = await batchOf(asString(clean.id));
    expect(passed.status).toBe('DryRunPassed');
    expect((await act(APPROVER, asString(clean.id), 'apply', asNumber(passed.version))).status).toBe(202);
    expect(await job().run(context())).toMatchObject({ applied: 1 });
    expect(await batchOf(asString(clean.id))).toMatchObject({ status: 'Applied', control_totals: { matched: true, actual: { rows: 3, amount: '60' } } });
  });

  it('stops a batch whose file cannot be read (Failed, DryRunFailed for a dry run) with the code, and the others go on', async () => {
    const entity = entityOf();
    const registered = await register(REGISTRAR, csv(['A,1,a']), entity);
    // The file is not the one that was registered any more.
    await rows('update machvon.migration_batch set file_storage_key = (select file_storage_key from machvon.migration_batch where target_entity <> $2 order by created_at limit 1) where id = $1', [
      registered.json.resource_id,
      entity,
    ]);
    expect((await act(REGISTRAR, asString(registered.json.resource_id), 'dry-run', asNumber(registered.json.resource_version))).status).toBe(202);
    const other = await dryRun(csv(['Z,1,z']), entityOf());
    expect(other.status).toBe('DryRunPassed');
    expect(await batchOf(asString(registered.json.resource_id))).toMatchObject({ status: 'DryRunFailed', failure_code: 'VALIDATION_FAILED' });
  });

  it('checks the rows that refer to rows migrated before, and refuses to roll back a batch that others were built on (409 MIGRATION_DEPENDENTS_EXIST)', async () => {
    const parent = await dryRun(csv(['P1,100,p1', 'P2,200,p2']), 'PARENT');
    // An unknown parent fails the dry run before anything was migrated.
    const orphan = await dryRun(csv(['C1,1,P1', 'C2,2,P9'], 'business_key,amount,parent_key'), entityOf(), { mapping_version: 'GENERIC-CHILD-1' });
    expect(orphan).toMatchObject({ status: 'DryRunFailed', error_count: 2 });
    await act(APPROVER, asString(parent.id), 'apply', asNumber(parent.version));
    await job().run(context());
    const child = await dryRun(csv(['C1,1,P1', 'C2,2,P2'], 'business_key,amount,parent_key'), 'CHILD', { mapping_version: 'GENERIC-CHILD-1' });
    expect(child).toMatchObject({ status: 'DryRunPassed', error_count: 0 });
    await act(APPROVER, asString(child.id), 'apply', asNumber(child.version));
    await job().run(context());
    const applied = await batchOf(asString(parent.id));
    expect(await act(APPROVER, asString(parent.id), 'rollback', asNumber(applied.version))).toMatchObject({ status: 409, json: { code: 'MIGRATION_DEPENDENTS_EXIST' } });
    expect((await batchOf(asString(parent.id))).status).toBe('Applied');
    // The batch that nothing is built on goes first; then the parent can go.
    const childRolled = await act(APPROVER, asString(child.id), 'rollback', asNumber((await batchOf(asString(child.id))).version), 'The rows of the child were loaded under the wrong mapping.');
    expect([childRolled.status, childRolled.json.status]).toEqual([202, 'RolledBack']);
    const parentRolled = await act(APPROVER, asString(parent.id), 'rollback', asNumber(applied.version), 'The parents were loaded from an old extract.');
    expect([parentRolled.status, parentRolled.json.status]).toEqual([202, 'RolledBack']);
    expect((await live('PARENT')).every((row) => row.state === 'INVALID')).toBe(true);
    const stored = await batchOf(asString(parent.id));
    expect(stored).toMatchObject({ status: 'RolledBack', rolled_back_by: memberId(APPROVER), rollback_reason: 'The parents were loaded from an old extract.' });
    expect((await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1 and action = 'adm.migration_batch.rolled_back'", [parent.id])).length).toBe(1);
    // Rolled back rows are no parents for the next file.
    expect(await dryRun(csv(['C9,1,P1'], 'business_key,amount,parent_key'), entityOf(), { mapping_version: 'GENERIC-CHILD-1' })).toMatchObject({ status: 'DryRunFailed' });
  });

  it('asks the references again as the lots are written: a child whose parent was rolled back after its dry run is not written (Failed), and a rollback waits for the lot that holds its parents', async () => {
    const parentRows = csv(['P7,100,p7']);
    const parent = await dryRun(parentRows, 'PARENT');
    await act(APPROVER, asString(parent.id), 'apply', asNumber(parent.version));
    await job().run(context());
    const childEntity = entityOf();
    const child = await dryRun(csv(['C7,1,P7'], 'business_key,amount,parent_key'), childEntity, { mapping_version: 'GENERIC-CHILD-1' });
    expect(child.status).toBe('DryRunPassed');
    // Nothing is built on the parent yet, so the parent can be rolled back although the child passed its dry run...
    expect((await act(APPROVER, asString(parent.id), 'rollback', asNumber((await batchOf(asString(parent.id))).version), 'The parents were loaded from an old extract.')).status).toBe(202);
    expect((await act(APPROVER, asString(child.id), 'apply', asNumber(child.version))).status).toBe(202);
    // ...and the child is not written under a parent that no longer stands.
    expect(await job().run(context())).toMatchObject({ applied: 0, failed: 1 });
    expect(await batchOf(asString(child.id))).toMatchObject({ status: 'Failed', failure_code: 'VALIDATION_FAILED', rows_applied: 0 });
    expect(await live(childEntity)).toEqual([]);
  });

  it('holds the parents before it asks who depends on them: a lot of a child that finishes while a rollback waits is seen by the rollback (409 MIGRATION_DEPENDENTS_EXIST)', async () => {
    const parent = await dryRun(csv(['P8,1,p8']), 'PARENT');
    await act(APPROVER, asString(parent.id), 'apply', asNumber(parent.version));
    await job().run(context());
    const child = await dryRun(csv(['C8,1,P8'], 'business_key,amount,parent_key'), entityOf(), { mapping_version: 'GENERIC-CHILD-1' });
    expect((await act(APPROVER, asString(child.id), 'apply', asNumber(child.version))).status).toBe(202);
    const store = new (await import('@machvon/db')).AdmMigrationStore();
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holding = new Promise<void>((resolve) => (held = resolve));
    // The lot of the child is written and not yet committed: it holds the parent rows it refers to.
    const lot = tenants.withTenant(context(), async (tx) => {
      await store.writeLot(tx, asString(child.id), [{ rowNumber: 1, lineNumber: 2, businessKey: 'C8', amount: '1', payload: {}, refs: [{ entity: 'PARENT', key: 'P8' }] }]);
      held();
      await gate;
    });
    await holding;
    const parentNow = await batchOf(asString(parent.id));
    const rolling = tenants
      .withTenant(context(), (tx) => store.rollback(tx, asString(parent.id), asNumber(parentNow.version), 'The parents were loaded from an old extract.', memberId(APPROVER)))
      .then(
        () => 'rolled back',
        (error: unknown) => error,
      );
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await lot;
    expect(await rolling).toMatchObject({ code: 'MIGRATION_DEPENDENTS_EXIST' });
    expect((await batchOf(asString(parent.id))).status).toBe('Applied');
    expect((await live('PARENT')).filter((row) => row.business_key === 'P8').map((row) => row.state)).toEqual(['VALID']);
  });

  it('refuses what the state does not allow: a rollback of a batch that is not applied, a dry run while one runs, a reason that is too short, and a version that is not the one read', async () => {
    const entity = entityOf();
    const registered = await register(REGISTRAR, csv(['A,1,a']), entity);
    const id = registered.json.resource_id as string;
    expect(await act(APPROVER, id, 'rollback', 1)).toMatchObject({ status: 409, json: { code: 'MIGRATION_STATE_INVALID' } });
    expect(await act(APPROVER, id, 'apply', 1)).toMatchObject({ status: 409, json: { code: 'MIGRATION_STATE_INVALID' } });
    expect((await act(REGISTRAR, id, 'dry-run', 9)).json.code).toBe('VERSION_CONFLICT');
    expect((await act(REGISTRAR, id, 'dry-run', 1)).status).toBe(202);
    expect(await act(REGISTRAR, id, 'dry-run', 2)).toMatchObject({ status: 409, json: { code: 'MIGRATION_STATE_INVALID' } });
    await job().run(context());
    const passed = await batchOf(id);
    await act(APPROVER, id, 'apply', asNumber(passed.version));
    await job().run(context());
    expect((await act(APPROVER, id, 'rollback', asNumber((await batchOf(id)).version), 'short')).json.detail).toBe('reason');
  });

  it('refuses a registration that names no known mapping, no entity, no source, no file or a file that is not there (422, 404)', async () => {
    const bytes = csv(['A,1,a']);
    expect((await register(REGISTRAR, bytes, entityOf(), { mapping_version: 'NO-SUCH' })).json.detail).toBe('mapping_version');
    expect((await register(REGISTRAR, bytes, 'lower', {})).json.detail).toBe('target_entity');
    expect((await register(REGISTRAR, bytes, entityOf(), { source_system: ' ' })).json.detail).toBe('source_system');
    expect(
      (await call('POST', '/migration-batches', { member: REGISTRAR, body: { source_system: 'ERP', target_entity: entityOf(), file_id: randomUUID(), mapping_version: 'GENERIC-1' } })).status,
    ).toBe(404);
    expect((await call('POST', '/migration-batches', { member: REGISTRAR, body: { source_system: 'ERP', target_entity: entityOf(), file_id: 'x', mapping_version: 'GENERIC-1' } })).json.detail).toBe(
      'file_id',
    );
  });

  it('is for those who may: registering and dry-running need manage, applying and rolling back need approve, reading needs read; all on the whole tenant', async () => {
    const entity = entityOf();
    const bytes = csv(['A,1,a']);
    expect((await register(READER, bytes, entity)).status).toBe(403);
    expect((await register(NOBODY, bytes, entity)).status).toBe(403);
    expect((await register(UNIT_ONLY, bytes, entity)).status).toBe(403);
    expect((await register(APPROVER, bytes, entity)).status).toBe(403);
    const registered = await register(REGISTRAR, bytes, entity);
    const id = registered.json.resource_id as string;
    expect((await act(APPROVER, id, 'dry-run', 1)).status).toBe(403);
    expect((await act(READER, id, 'apply', 1)).status).toBe(403);
    expect((await act(REGISTRAR, id, 'rollback', 1)).status).toBe(403);
    expect((await call('GET', '/migration-batches', { member: NOBODY })).status).toBe(403);
    expect((await call('GET', '/migration-batches', { member: UNIT_ONLY })).status).toBe(403);
    expect((await call('GET', `/migration-batches/${id}`, { member: NOBODY })).status).toBe(403);
  });

  it('lists the batches newest first, by state and entity, a page at a time; another tenant sees none of it', async () => {
    const entity = entityOf();
    const first = await register(REGISTRAR, csv(['L1,1,a']), entity);
    const second = await register(REGISTRAR, csv(['L2,1,a']), entity);
    const listed = await call('GET', `/migration-batches?target_entity=${entity}&limit=1`, { member: READER });
    expect(asObjects(listed.json.items).map((item) => item.id)).toEqual([second.json.resource_id]);
    const next = await call('GET', `/migration-batches?target_entity=${entity}&limit=1&cursor=${listed.json.next_cursor}`, { member: READER });
    expect(asObjects(next.json.items).map((item) => item.id)).toEqual([first.json.resource_id]);
    expect(next.json.next_cursor).toBeNull();
    expect((await call('GET', `/migration-batches?target_entity=${entity}&status=Applied`, { member: READER })).json.items).toEqual([]);
    expect((await call('GET', '/migration-batches?status=Nope', { member: READER })).status).toBe(422);
    expect((await call('GET', `/migration-batches?target_entity=${entity}`, { member: B_REGISTRAR, tenantId: TENANT_B })).json.items).toEqual([]);
    expect((await call('GET', `/migration-batches/${first.json.resource_id}`, { member: B_REGISTRAR, tenantId: TENANT_B })).status).toBe(404);
    expect((await act(B_REGISTRAR, asString(first.json.resource_id), 'dry-run', 1, undefined, TENANT_B)).status).toBe(404);
    // The same file registered for the same entity in another tenant is another batch.
    expect((await register(B_REGISTRAR, csv(['L1,1,a']), entity, {}, TENANT_B)).status).toBe(201);
  });

  it('is kept for good: the table refuses to change what was registered, to skip a state, to delete, and the rows are marked, never deleted', async () => {
    const entity = entityOf();
    const registered = await register(REGISTRAR, csv(['G1,1,a']), entity);
    const id = registered.json.resource_id as string;
    const asApp = (sql: string, params: unknown[] = []) => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(REGISTRAR), scopeVersion: 1 }, (tx) => tx.query(sql, params));
    await expect(asApp("update machvon.migration_batch set status = 'Applied' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp("update machvon.migration_batch set target_entity = 'OTHER' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp('delete from machvon.migration_batch where id = $1', [id])).rejects.toBeDefined();
    await expect(asApp("update machvon.migration_batch set status = 'Applying' where id = $1", [id])).rejects.toBeDefined();
    const clean = await dryRun(csv(['G2,1,a']), entityOf());
    await act(APPROVER, asString(clean.id), 'apply', asNumber(clean.version));
    await job().run(context());
    await expect(asApp("update machvon.migration_batch set control_totals = '{}'::jsonb where id = $1", [clean.id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp("update machvon.migration_row set business_key = 'X' where migrated_batch_id = $1", [clean.id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp('delete from machvon.migration_row where migrated_batch_id = $1', [clean.id])).rejects.toBeDefined();
    // The checks of the table: an applied batch has an approver other than who registered it, and totals.
    await expect(rows('update machvon.migration_batch set approved_by = created_by where id = $1', [clean.id])).rejects.toMatchObject({ code: '23514' });
  });
});
