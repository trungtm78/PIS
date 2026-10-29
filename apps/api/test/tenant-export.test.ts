import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomBytes, randomUUID } from 'node:crypto';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, seedSystemRoles } from '@machvon/db';
import { bytesSha256, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { ExportManifest } from '@machvon/kernel';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { DOCUMENT_FILE_PORT } from '../src/modules/doc/file-port';
import type { DocumentFilePort } from '../src/modules/doc/file-port';
import { FileService } from '../src/modules/files/file.service';
import { eicarBytes } from '../src/modules/files/mock-scan';
import { TenantExportJob } from '../src/modules/sas/tenant-export.job';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const ADMIN = '00000000-0000-4000-8000-0000000000f1';
const REASON = 'The province asked for its data at the end of the contract.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
  bytes: Buffer;
}

describe('the export of the data of a tenant and its offboarding over HTTP (ST-SAS-016)', () => {
  const harness = new ProvisioningHarness();
  let app: RunningApp;
  let counter = 0;

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => harness.admin(async (client) => (await client.query(text, params)).rows as T[]);

  async function send(context: { tenantId: string; membershipId: string }, claims: Record<string, unknown>, method: string, path: string, options: { payload?: unknown; ifMatch?: number | string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: signTenantContext({ ...context, scopeVersion: 1 }, SIGNING_KEY),
      [CLAIMS_HEADER]: JSON.stringify(claims),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = typeof options.ifMatch === 'number' ? `"${options.ifMatch}"` : options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      // A file is not JSON.
    }
    return { status: response.status, json, bytes };
  }

  const asMember = (tenantId: string, membershipId: string, method: string, path: string, options: { payload?: unknown; ifMatch?: number | string } = {}) => send({ tenantId, membershipId }, { aud: 'tenant' }, method, path, options);
  const asAdmin = (method: string, path: string, options: { payload?: unknown; ifMatch?: number | string; roles?: string[] } = {}) =>
    send({ tenantId: PLATFORM_TENANT_ID, membershipId: ADMIN }, { aud: 'control', roles: options.roles ?? ['SystemAdmin'] }, method, path, options);

  async function seedMember(owner: Client, tenantId: string, unitId: string, roleCode: string): Promise<string> {
    counter += 1;
    const membershipId = `00000000-0000-4000-8000-${(0xe100 + counter).toString(16).padStart(12, '0')}`;
    const userId = randomUUID();
    await owner.query("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Member', 'Active')", [userId, `sub-${userId}`, `${userId}@example.test`]);
    await owner.query("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now())", [tenantId, membershipId, userId, unitId]);
    const role = await owner.query<{ id: string }>('select id from machvon.role_definition where code = $1', [roleCode]);
    await owner.query(
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
      [tenantId, randomUUID(), membershipId, role.rows[0]?.id, ADMIN],
    );
    return membershipId;
  }

  /** An Active tenant with an owner, an ordinary member, one unit and one project-less set of rows to export. */
  async function tenant(): Promise<{ tenantId: string; owner: string; member: string }> {
    const created = await harness.request();
    const tenantId = created.tenantId;
    await harness.registry.transition(tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantId, 'Provisioning', 'Active');
    await harness.tenants.withTenant({ tenantId, membershipId: ADMIN, scopeVersion: 1 }, (tx) => seedSystemRoles(tx, ADMIN));
    const client = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
    await client.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      const unitId = randomUUID();
      await client.query("insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'U1', 'Unit 1', date '2026-01-01', '/u1/', 0)", [tenantId, unitId]);
      return { tenantId, owner: await seedMember(client, tenantId, unitId, 'TENANT_OWNER'), member: await seedMember(client, tenantId, unitId, 'MEMBER') };
    } finally {
      await client.end();
    }
  }

  const worker = (tenantId: string, now = new Date(), options: { maxBytes?: number; maxReferences?: number } = {}) =>
    new TenantExportJob(harness.tenants, app.get<FileService>(FileService), new AuditWriter(harness.tenants), app.get<DocumentFilePort>(DOCUMENT_FILE_PORT), options).run({ tenantId, membershipId: ADMIN, scopeVersion: 1 }, now);
  /** A download is recorded once its response has gone out whole, a moment after the client has the bytes. */
  async function until(check: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the download was never recorded');
  }
  const exportsOf = async (t: { tenantId: string; owner: string }): Promise<Array<Record<string, unknown>>> => (await asMember(t.tenantId, t.owner, 'GET', `/tenants/${t.tenantId}/exports`)).json.items as Array<Record<string, unknown>>;
  const ask = (t: { tenantId: string; owner: string }, payload: Record<string, unknown> = {}, ifMatch: number | string = 0) =>
    asMember(t.tenantId, t.owner, 'POST', `/tenants/${t.tenantId}/export`, { payload: { scope: 'FULL', reason: REASON, ...payload }, ifMatch });
  /** Asks for the link of a file and, if it is given, follows it; the answer is the link's refusal or the bytes. */
  const file = async (t: { tenantId: string; owner: string }, exportId: string, path: string): Promise<Reply> => {
    const link = await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/file?path=${encodeURIComponent(path)}`);
    if (link.status !== 200) return link;
    expect(link.json).toMatchObject({ export_id: exportId, path });
    const response = await fetch(`${app.baseUrl}${link.json.url as string}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const entry = link.json as { bytes: number; sha256: string };
    if (response.status === 200) expect({ bytes: bytes.length, sha256: bytesSha256(bytes) }).toEqual({ bytes: entry.bytes, sha256: entry.sha256 });
    return { status: response.status, json: {}, bytes };
  };

  beforeAll(async () => {
    await harness.start();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          control: { database: harness.control, registry: harness.registry },
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('AC-ST-SAS-016-1 UAT-AC39: an Active tenant exports its data: the manifest lists every table and file with a sha256 that matches 100% of the files, the row counts agree with the tables, and the link lasts 72 hours', async () => {
    const t = await tenant();
    // A file of the tenant that the antivirus passed travels with its tables.
    const attachment = Buffer.from('%PDF-1.4 a document of the province');
    await app.get<FileService>(FileService).storeGenerated({ tenantId: t.tenantId, membershipId: t.owner, scopeVersion: 1 }, 'logo', 'logo-1.png', attachment, 'image/png');
    const asked = await ask(t);
    expect(asked.status).toBe(202);
    expect(asked.json).toMatchObject({ status: 'REQUESTED' });
    const exportId = asked.json.resource_id as string;
    expect((await exportsOf(t))[0]).toMatchObject({ id: exportId, status: 'Requested', scope: 'FULL', encrypted: false });
    // Not made yet: nothing to read.
    expect((await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).status).toBe(409);

    const before = Date.now();
    await worker(t.tenantId);
    const [made] = await exportsOf(t);
    expect(made).toMatchObject({ id: exportId, status: 'Ready', encrypted: false });
    const ttl = new Date(made?.expires_at as string).getTime() - new Date(made?.ready_at as string).getTime();
    expect(ttl).toBe(72 * 3_600_000);
    expect(new Date(made?.ready_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const manifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).json as unknown as ExportManifest;
    expect(manifest).toMatchObject({ schema_version: 1, job_id: exportId, tenant_id: t.tenantId, scope: 'FULL' });
    expect(manifest.files.length).toBeGreaterThan(20);
    expect(manifest.files.map((entry) => entry.path)).toEqual(expect.arrayContaining(['tables/organization_unit.jsonl', 'tables/membership.jsonl', 'attachments/logo/logo-1.png']));
    // Every file downloads, and its bytes are what the manifest says, 100%.
    let matched = 0;
    for (const entry of manifest.files) {
      const reply = await file(t, exportId, entry.path);
      expect(reply.status).toBe(200);
      if (reply.bytes.length === entry.bytes && bytesSha256(reply.bytes) === entry.sha256) matched += 1;
    }
    expect(matched).toBe(manifest.files.length);
    expect((await file(t, exportId, 'attachments/logo/logo-1.png')).bytes.equals(attachment)).toBe(true);
    // The rows of a table agree with the table: the file holds one line per row, and the manifest counts them.
    const units = (await file(t, exportId, 'tables/organization_unit.jsonl')).bytes.toString('utf8').trim().split('\n');
    expect(manifest.row_counts.organization_unit).toBe(1);
    expect(units).toHaveLength(1);
    expect(JSON.parse(units[0] as string)).toMatchObject({ tenant_id: t.tenantId, code: 'U1' });
    const counted = await admin<{ n: string }>("select count(*)::text as n from machvon.membership where tenant_id = $1", [t.tenantId]);
    expect(manifest.row_counts.membership).toBe(Number(counted[0]?.n));
    // Nothing of another tenant, and nothing that holds a secret or the machinery of the platform.
    expect(manifest.files.map((entry) => entry.path)).not.toContain('tables/idempotency_record.jsonl');
    expect(manifest.files.map((entry) => entry.path)).not.toContain('tables/user_session.jsonl');
    for (const entry of manifest.files.filter((candidate) => candidate.table !== undefined)) {
      const text = (await file(t, exportId, entry.path)).bytes.toString('utf8');
      expect(text.includes(`"tenant_id":"${t.tenantId}"`) || text === '').toBe(true);
      expect(new RegExp(`"tenant_id":"(?!${t.tenantId})`).test(text)).toBe(false);
    }
    // Every file and the manifest itself downloaded: the export is Delivered.
    expect((await exportsOf(t))[0]).toMatchObject({ id: exportId, status: 'Ready' });
    expect((await file(t, exportId, 'manifest.json')).status).toBe(200);
    await until(async () => (await exportsOf(t))[0]?.status === 'Delivered');
    expect((await exportsOf(t))[0]).toMatchObject({ id: exportId, status: 'Delivered' });
  }, 120_000);

  it('follows the files that rows refer to into the store that holds them: a signed version of a document is in the export, one nobody can read is named in the manifest, and the export is not made smaller by it', async () => {
    const t = await tenant();
    const documents = app.get<DocumentFilePort>(DOCUMENT_FILE_PORT);
    const kept = `tenants/${t.tenantId}/documents/${randomUUID()}-abc.pdf`;
    const lost = `tenants/${t.tenantId}/sigreport/${randomUUID()}.pdf`;
    const bytes = Buffer.from('%PDF-1.7 the signed version');
    await documents.put(kept, bytes, 'application/pdf');
    // Rows that refer to them: the reason of an audit row is a text column the export carries.
    const audit = new AuditWriter(harness.tenants);
    for (const key of [kept, lost, `tenants/${randomUUID()}/documents/of-another-tenant.pdf`]) {
      await harness.tenants.withTenant({ tenantId: t.tenantId, membershipId: t.owner, scopeVersion: 1 }, (tx) =>
        audit.recordInTx(tx, t.owner, { action: 'test.reference', resourceType: 'test', resourceId: randomUUID(), reason: key, diff: {}, correlationId: randomUUID(), requestId: randomUUID() }),
      );
    }
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    const manifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).json as unknown as ExportManifest;
    const path = `attachments/documents/${kept.split('/').pop() as string}`;
    expect(manifest.files.map((entry) => entry.path)).toContain(path);
    expect((await file(t, exportId, path)).bytes.equals(bytes)).toBe(true);
    expect(manifest.missing_files).toEqual([lost]);
  }, 120_000);

  it('does not carry into the export a file the antivirus has not passed, though a row refers to it, and names it in the manifest; a document with a long name does not fail the export', async () => {
    const t = await tenant();
    const files = app.get<FileService>(FileService);
    const owner = { tenantId: t.tenantId, membershipId: t.owner, scopeVersion: 1 };
    // An infected upload (the antivirus says so) and a document named the way the document module names them: <uuid>-<sha256>.pdf.
    const pendingKey = (await files.upload(owner, { purpose: 'logo', declaredType: 'image/png', bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(eicarBytes())]) })).key;
    const long = `tenants/${t.tenantId}/documents/${randomUUID()}-${'a'.repeat(64)}.pdf`;
    await app.get<DocumentFilePort>(DOCUMENT_FILE_PORT).put(long, Buffer.from('%PDF-1.7 long name'), 'application/pdf');
    const audit = new AuditWriter(harness.tenants);
    for (const key of [pendingKey, long]) {
      await harness.tenants.withTenant(owner, (tx) => audit.recordInTx(tx, t.owner, { action: 'test.reference', resourceType: 'test', resourceId: randomUUID(), reason: key, diff: {}, correlationId: randomUUID(), requestId: randomUUID() }));
    }
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    expect((await exportsOf(t))[0]).toMatchObject({ id: exportId, status: 'Ready' });
    const manifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).json as unknown as ExportManifest;
    expect(manifest.files.map((entry) => entry.path)).toContain(`attachments/documents/${long.split('/').pop() as string}`);
    expect(manifest.withheld_files).toEqual([pendingKey]);
    expect(manifest.files.filter((entry) => entry.path.startsWith('attachments/logo/'))).toEqual([]);
    expect(manifest.missing_files).toEqual([]);
  }, 120_000);

  it('does not count a HEAD request on a link as a download, and counts a GET once it has gone out whole', async () => {
    const t = await tenant();
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    const manifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).json as unknown as ExportManifest;
    for (const path of ['manifest.json', ...manifest.files.map((entry) => entry.path)]) {
      const link = await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/file?path=${encodeURIComponent(path)}`);
      expect((await fetch(`${app.baseUrl}${link.json.url as string}`, { method: 'HEAD' })).status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await exportsOf(t))[0]).toMatchObject({ id: exportId, status: 'Ready', files_downloaded: [] });
    expect((await file(t, exportId, 'manifest.json')).status).toBe(200);
    await until(async () => ((await exportsOf(t))[0]?.files_downloaded as string[]).length === 1);
    expect((await exportsOf(t))[0]).toMatchObject({ status: 'Ready', files_downloaded: ['manifest.json'] });
  }, 120_000);

  it('names the tables of the tenant that it could not read, and does not write them as empty files', async () => {
    const t = await tenant();
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    const manifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).json as unknown as ExportManifest;
    expect(manifest.unreadable_tables).toEqual(expect.arrayContaining(['tenant_theme_draft', 'tenant_theme_review']));
    expect(manifest.files.map((entry) => entry.path)).not.toContain('tables/tenant_theme_draft.jsonl');
  }, 120_000);

  it('leaves the files of the audit trail out of a business-data export, takes them in a full one, and starts the 72 hours when the export is ready, after its snapshot', async () => {
    const t = await tenant();
    const owner = { tenantId: t.tenantId, membershipId: t.owner, scopeVersion: 1 };
    await app.get<FileService>(FileService).storeGenerated(owner, 'audit_export', 'trail-1.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
    await app.get<FileService>(FileService).storeGenerated(owner, 'report_export', 'report-1.csv', Buffer.from('c,d\n3,4\n'), 'text/csv');
    const business = (await ask(t, { scope: 'BUSINESS_DATA_ONLY' })).json.resource_id as string;
    await worker(t.tenantId);
    const businessFiles = ((await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${business}/manifest`)).json as unknown as ExportManifest).files.map((entry) => entry.path);
    expect(businessFiles).toContain('attachments/report_export/report-1.csv');
    expect(businessFiles).not.toContain('attachments/audit_export/trail-1.csv');
    // The first export is Ready; a second may be asked for, and holds the trail.
    const full = (await ask(t, { scope: 'FULL' }, 1)).json.resource_id as string;
    await worker(t.tenantId);
    const fullManifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${full}/manifest`)).json as unknown as ExportManifest;
    expect(fullManifest.files.map((entry) => entry.path)).toContain('attachments/audit_export/trail-1.csv');
    const [made] = (await admin<{ snapshot_at: Date; ready_at: Date; expires_at: Date }>('select snapshot_at, ready_at, expires_at from machvon.tenant_export_job where id = $1', [full]));
    expect(made?.ready_at.getTime()).toBeGreaterThanOrEqual(made?.snapshot_at.getTime() ?? Infinity);
    expect((made?.expires_at.getTime() ?? 0) - (made?.ready_at.getTime() ?? 0)).toBe(72 * 3_600_000);
  }, 120_000);

  it('counts the backlog of a tenant on its own, before the worker drains it', async () => {
    const t = await tenant();
    const job = new TenantExportJob(harness.tenants, app.get<FileService>(FileService), new AuditWriter(harness.tenants), app.get<DocumentFilePort>(DOCUMENT_FILE_PORT));
    const ctx = { tenantId: t.tenantId, membershipId: ADMIN, scopeVersion: 1 };
    expect(await job.pending(ctx)).toBe(0);
    await ask(t);
    expect(await job.pending(ctx)).toBe(1);
    expect((await job.run(ctx, new Date())).pending).toBe(0);
    expect(await job.pending(ctx)).toBe(0);
  });

  it('ends an export as Failed when the rows refer to more files than it follows, instead of leaving files out of an export that looks whole', async () => {
    const t = await tenant();
    const audit = new AuditWriter(harness.tenants);
    for (let n = 0; n < 3; n += 1) {
      await harness.tenants.withTenant({ tenantId: t.tenantId, membershipId: t.owner, scopeVersion: 1 }, (tx) =>
        audit.recordInTx(tx, t.owner, { action: 'test.reference', resourceType: 'test', resourceId: randomUUID(), reason: `tenants/${t.tenantId}/documents/${randomUUID()}.pdf`, diff: {}, correlationId: randomUUID(), requestId: randomUUID() }),
      );
    }
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId, new Date(), { maxReferences: 2 });
    expect((await exportsOf(t))[0]).toMatchObject({ id: exportId, status: 'Failed', error_code: 'TooManyReferences' });
  }, 120_000);

  it('stops an export that would be larger than the limit while it reads the table, not after it holds all of it, and ends it as Failed', async () => {
    const t = await tenant();
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId, new Date(), { maxBytes: 100 });
    expect((await exportsOf(t))[0]).toMatchObject({ id: exportId, status: 'Failed', error_code: 'ExportTooLarge' });
    // Nothing of it can be read, and the owner can ask again.
    expect((await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).status).toBe(409);
    expect((await ask(t, {}, 1)).status).toBe(202);
  });

  it('encrypts every file for the customer when they give a public key, and the manifest carries what they need to open them', async () => {
    const t = await tenant();
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const asked = await ask(t, { encryption_public_key_pem: pair.publicKey, scope: 'BUSINESS_DATA_ONLY' });
    expect(asked.status).toBe(202);
    const exportId = asked.json.resource_id as string;
    await worker(t.tenantId);
    const manifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).json as unknown as ExportManifest;
    expect(manifest.scope).toBe('BUSINESS_DATA_ONLY');
    expect(manifest.encryption_key_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files.every((entry) => entry.path.endsWith('.enc') && entry.encryption !== undefined)).toBe(true);
    // A business-data export leaves out who may do what and what was done.
    expect(manifest.files.map((entry) => entry.path)).not.toContain('tables/audit_event.jsonl.enc');
    const entry = manifest.files.find((candidate) => candidate.table === 'organization_unit');
    expect(entry).toBeDefined();
    const stored = (await file(t, exportId, entry?.path as string)).bytes;
    expect(bytesSha256(stored)).toBe(entry?.sha256);
    const fileKey = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(entry?.encryption?.wrapped_key as string, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', fileKey, stored.subarray(0, 12));
    decipher.setAuthTag(stored.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]);
    expect(bytesSha256(plain)).toBe(entry?.encryption?.plaintext_sha256);
    expect(JSON.parse(plain.toString('utf8').trim())).toMatchObject({ code: 'U1' });
    expect((await ask(await tenant(), { encryption_public_key_pem: 'not a key' })).status).toBe(422);
  }, 120_000);

  it('asks for one export at a time, on the version of the list of exports the caller saw, and refuses a request that names no version', async () => {
    const t = await tenant();
    expect((await ask(t, {}, 0)).status).toBe(202);
    const again = await ask(t, {}, 1);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'EXPORT_ALREADY_RUNNING' });
    const stale = await ask(t, {}, 0);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'VERSION_CONFLICT' });
    const unversioned = await asMember(t.tenantId, t.owner, 'POST', `/tenants/${t.tenantId}/export`, { payload: { scope: 'FULL', reason: REASON } });
    expect(unversioned.status).toBe(428);
    expect((await asMember(t.tenantId, t.owner, 'GET', `/tenants/${t.tenantId}/exports`)).json.exports_version).toBe(1);
    await worker(t.tenantId);
    expect((await ask(t, {}, 1)).status).toBe(202);
  });

  it('is for the tenant\'s own people with the right to export: an ordinary member, and the owner of another tenant, get nothing', async () => {
    const t = await tenant();
    const other = await tenant();
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    expect((await asMember(t.tenantId, t.member, 'POST', `/tenants/${t.tenantId}/export`, { payload: { scope: 'FULL', reason: REASON }, ifMatch: 1 })).status).toBe(403);
    expect((await asMember(t.tenantId, t.member, 'GET', `/tenants/${t.tenantId}/exports`)).status).toBe(403);
    expect((await asMember(t.tenantId, t.member, 'GET', `/tenant-exports/${exportId}/manifest`)).status).toBe(403);
    // The path names the tenant: the owner of another tenant, or the owner naming another tenant, finds nothing.
    expect((await asMember(other.tenantId, other.owner, 'GET', `/tenants/${t.tenantId}/exports`)).status).toBe(404);
    expect((await asMember(other.tenantId, other.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).status).toBe(404);
    expect((await asMember(other.tenantId, other.owner, 'POST', `/tenants/${t.tenantId}/export`, { payload: { scope: 'FULL', reason: REASON }, ifMatch: 0 })).status).toBe(404);
    expect((await asMember(other.tenantId, other.owner, 'GET', `/tenants/${other.tenantId}/exports`)).json.items).toEqual([]);
    // A control token never reaches the tenant's data.
    expect((await asAdmin('GET', `/tenants/${t.tenantId}/exports`)).status).toBe(403);
  });

  it('serves nothing once the 72 hours are over, nor a path the manifest does not list', async () => {
    const t = await tenant();
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    expect((await file(t, exportId, 'tables/not_a_table.jsonl')).status).toBe(404);
    expect((await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/file`)).status).toBe(422);
    await admin('alter table machvon.tenant_export_job disable trigger tenant_export_job_guard');
    await admin("update machvon.tenant_export_job set expires_at = now() - interval '1 minute' where id = $1", [exportId]);
    await admin('alter table machvon.tenant_export_job enable trigger tenant_export_job_guard');
    const expired = await file(t, exportId, 'manifest.json');
    expect(expired.status).toBe(422);
    expect(expired.json).toMatchObject({ code: 'EXPORT_EXPIRED' });
    expect((await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).status).toBe(422);
    await worker(t.tenantId);
    expect((await exportsOf(t))[0]).toMatchObject({ status: 'Expired' });
  });

  it('AC-ST-SAS-016-2 UAT-AC172: archiving an Offboarding tenant is 409 EXPORT_NOT_CONFIRMED until an export is Delivered, then it is Archived and its people are out', async () => {
    const t = await tenant();
    const state = async () => (await asAdmin('GET', `/system/tenants/${t.tenantId}/exports`)).json;
    expect(await state()).toMatchObject({ tenant_status: 'Active', legal_holds_active: 0, export_delivered: false, items: [] });
    const version = (await state()).tenant_version as number;
    const started = await asAdmin('POST', `/system/tenants/${t.tenantId}/offboard`, { payload: { contract_end_date: '2026-12-31', export_window_days: 90, reason: 'The contract ends and will not be renewed.' }, ifMatch: version });
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ tenant_id: t.tenantId, status: 'Offboarding' });
    expect(await state()).toMatchObject({ tenant_status: 'Offboarding', contract_end_date: '2026-12-31', export_window_days: 90, export_delivered: false });
    expect(typeof (await state()).export_window_ends_at).toBe('string');

    const early = await asAdmin('POST', `/system/tenants/${t.tenantId}/archive`, { payload: { reason: 'The export is not delivered yet.' }, ifMatch: started.json.version as number });
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ code: 'EXPORT_NOT_CONFIRMED' });
    expect((await state()).tenant_status).toBe('Offboarding');

    // The tenant exports while it is leaving, and downloads everything: the export is Delivered.
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    const manifest = (await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/manifest`)).json as unknown as ExportManifest;
    for (const entry of [{ path: 'manifest.json' }, ...manifest.files]) expect((await file(t, exportId, entry.path)).status).toBe(200);
    await until(async () => (await state()).export_delivered === true);
    expect(await state()).toMatchObject({ export_delivered: true, items: [{ id: exportId, status: 'Delivered' }] });

    const archived = await asAdmin('POST', `/system/tenants/${t.tenantId}/archive`, { payload: { reason: 'The export was delivered.' }, ifMatch: started.json.version as number });
    expect(archived.status).toBe(200);
    expect(archived.json).toMatchObject({ tenant_id: t.tenantId, status: 'Archived' });
    expect((await state()).tenant_status).toBe('Archived');
    const again = await asAdmin('POST', `/system/tenants/${t.tenantId}/archive`, { payload: { reason: 'Archiving it a second time.' }, ifMatch: archived.json.version as number });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'TENANT_STATE_INVALID' });
  }, 120_000);

  it('brings an Offboarding tenant back with resumeTenant inside the window, and refuses to offboard one that is not Active or Suspended', async () => {
    const t = await tenant();
    const version = ((await asAdmin('GET', `/system/tenants/${t.tenantId}/exports`)).json.tenant_version as number) ?? 0;
    const started = await asAdmin('POST', `/system/tenants/${t.tenantId}/offboard`, { payload: { contract_end_date: '2030-12-31', export_window_days: 30, reason: 'The contract may be renewed.' }, ifMatch: version });
    expect(started.status).toBe(202);
    const resumed = await asAdmin('POST', `/system/tenants/${t.tenantId}/resume`, { payload: { reason: 'The contract was renewed.' }, ifMatch: started.json.version as number });
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ status: 'Active' });
    const bad = await asAdmin('POST', `/system/tenants/${t.tenantId}/offboard`, { payload: { contract_end_date: '2030-12-31', export_window_days: 10, reason: 'The window is too short.' }, ifMatch: resumed.json.version as number });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // A tenant that is not Active or Suspended (here: one that is still being provisioned) is not offboarded.
    const created = await harness.request();
    const state = (await asAdmin('GET', `/system/tenants/${created.tenantId}/exports`)).json;
    expect(state.tenant_status).not.toBe('Active');
    const refused = await asAdmin('POST', `/system/tenants/${created.tenantId}/offboard`, { payload: { contract_end_date: '2030-12-31', export_window_days: 90, reason: 'It was never in service.' }, ifMatch: state.tenant_version as number });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'TENANT_STATE_INVALID' });
  });

  it('serves a file only through its signed link: a forged, altered, foreign or replayed-after-expiry link is 401, and the link of an export that has ended is 422', async () => {
    const t = await tenant();
    const exportId = (await ask(t)).json.resource_id as string;
    await worker(t.tenantId);
    const link = await asMember(t.tenantId, t.owner, 'GET', `/tenant-exports/${exportId}/file?path=manifest.json`);
    expect(link.status).toBe(200);
    const url = new URL(`${app.baseUrl}${link.json.url as string}`);
    const fetchWith = async (change: (params: URLSearchParams) => void): Promise<number> => {
      const copy = new URL(url);
      change(copy.searchParams);
      return (await fetch(copy)).status;
    };
    expect(await fetchWith((params) => params.set('signature', 'A'.repeat(43)))).toBe(401);
    expect(await fetchWith((params) => params.set('path', 'tables/organization_unit.jsonl'))).toBe(401);
    expect(await fetchWith((params) => params.set('tenant', randomUUID()))).toBe(401);
    expect(await fetchWith((params) => params.set('expires', '1'))).toBe(401);
    expect(await fetchWith((params) => params.delete('signature'))).toBe(401);
    expect(await fetchWith(() => undefined)).toBe(200);
    // Nothing the policy guard needs is asked of the bearer of a link, and nothing of the tenant leaks into a refusal.
    const forged = await fetch(`${app.baseUrl}/tenant-exports/${randomUUID()}/content?tenant=${t.tenantId}&path=manifest.json&expires=${Math.floor(Date.now() / 1000) + 60}&signature=${'B'.repeat(43)}`);
    expect(forged.status).toBe(401);
    await admin('alter table machvon.tenant_export_job disable trigger tenant_export_job_guard');
    await admin("update machvon.tenant_export_job set expires_at = now() - interval '1 minute' where id = $1", [exportId]);
    await admin('alter table machvon.tenant_export_job enable trigger tenant_export_job_guard');
    expect(await fetchWith(() => undefined)).toBe(422);
  });

  it('keeps the lifecycle for the System Admin: the Support Operator, the Billing Operator and every member of a tenant are refused', async () => {
    const t = await tenant();
    const version = (await asAdmin('GET', `/system/tenants/${t.tenantId}/exports`)).json.tenant_version as number;
    const body = { contract_end_date: '2030-12-31', export_window_days: 90, reason: 'The contract ends and will not be renewed.' };
    for (const roles of [['SupportOperator'], ['BillingOperator'], ['PlatformOperator']]) {
      expect((await asAdmin('POST', `/system/tenants/${t.tenantId}/offboard`, { payload: body, ifMatch: version, roles })).status).toBe(403);
      expect((await asAdmin('POST', `/system/tenants/${t.tenantId}/archive`, { payload: { reason: 'Not mine to archive.' }, ifMatch: version, roles })).status).toBe(403);
    }
    expect((await asAdmin('GET', `/system/tenants/${t.tenantId}/exports`, { roles: ['SupportOperator'] })).status).toBe(403);
    expect((await asAdmin('GET', `/system/tenants/${t.tenantId}/exports`, { roles: ['PlatformOperator'] })).status).toBe(200);
    expect((await asMember(t.tenantId, t.owner, 'POST', `/system/tenants/${t.tenantId}/offboard`, { payload: body, ifMatch: version })).status).toBe(403);
    expect((await asAdmin('GET', `/system/tenants/${randomUUID()}/exports`)).status).toBe(404);
  });
});
