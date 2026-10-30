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
import { ctrModule } from '../../src/modules/ctr';
import { ContractorExportController, ContractorExportReadsController } from '../../src/modules/ctr/export.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import { adminStatement } from '../../../../packages/db/test/support/settled-payment';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(600_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const EXPORTER = 91; // exports over the whole tenant
const NARROW = 92; // exports over another project only
const NOBODY = 93;
const SECOND = 94; // exports over the whole tenant too
const FOREIGN = 95;
const NARROW_TOO = 96; // exports over the same other project as NARROW
const MEMBERS = [EXPORTER, NARROW, NOBODY, SECOND, NARROW_TOO];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface BatchRow {
  id: string;
  status: string;
  version: string;
  file_sha256: string;
  row_count: number;
  submitted_ref: string | null;
  file_object_key: string;
}

describe('the export of the records of the contractors over HTTP (ST-CTR-015, AC-ST-CTR-015-1, AC-ST-CTR-015-2, UAT-AC315, UAT-PLAN-18)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;
  let root = '';
  let contractId = '';
  let otherContractId = '';
  let today = '';
  let decision = '';
  let name = '';
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; key?: string; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const request = (overrides: Record<string, unknown> = {}) => ({ scope: 'BOTH', period_from: today, period_to: today, format: 'CSV', ...overrides });
  const exportOf = (member: number, overrides: Record<string, unknown> = {}) => call('POST', '/contractor-exports', { member, body: request(overrides) });
  const batchOf = async (id: string): Promise<BatchRow> =>
    (await rows<BatchRow>('select id, status, version::text as version, file_sha256, row_count, submitted_ref, file_object_key from machvon.contractor_export_batch where id = $1::uuid', [id]))[0] as BatchRow;
  const batches = () => rows<{ id: string }>('select id from machvon.contractor_export_batch');
  /** The file of a batch as the signed link hands it out. */
  async function fileOf(member: number, id: string): Promise<{ status: number; text: string; type: string | null }> {
    const link = await call('GET', `/contractor-exports/${id}/download`, { member });
    if (link.status !== 200) return { status: link.status, text: '', type: null };
    const response = await fetch(`${app.baseUrl}${link.json.url as string}`);
    // The bytes as they are: a text read would take the byte-order mark off, and the hash is of the bytes.
    return { status: response.status, text: Buffer.from(await response.arrayBuffer()).toString('utf8'), type: response.headers.get('content-type') };
  }

  async function seedRecords(contract: string, tag: string): Promise<void> {
    const approver = memberId(SECOND);
    const evaluator = memberId(EXPORTER);
    const evaluation = (period: string, status: string, revision = 1) =>
      adminStatement(
        fixtures,
        `insert into machvon.contractor_performance
           (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, revision, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, overall_score, rating, status, evaluated_by, approved_by, approved_at, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, $3, 'PERIODIC', $4, $5, 80, 70, 90, 60, 100, 80.50, 'GOOD', $6, $7, case when $6 in ('APPROVED','SUPERSEDED') then $8::uuid end, case when $6 in ('APPROVED','SUPERSEDED') then now() end, $7, $7)`,
        [TENANT_A, contract, fixtures.contractorId, `${tag}-${period}`, revision, status, evaluator, approver],
      );
    await evaluation('Q3', 'APPROVED');
    await evaluation('Q2', 'SUBMITTED');
    await evaluation('Q1', 'SUPERSEDED');
    const violation = (kind: string, status: string, text: string) =>
      adminStatement(
        fixtures,
        `insert into machvon.contractor_violation
           (tenant_id, id, contract_id, contractor_id, violation_kind, severity, occurred_on, description, penalty_kind, penalty_amount_vnd, decision_document_version_id, status, confirmed_by, confirmed_at, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, $3, $4, 'MAJOR', date '2026-09-01', $5, case when $6 = 'CONFIRMED' then 'LIQUIDATED_DAMAGES' else 'NONE' end, case when $6 = 'CONFIRMED' then 150000000 else 0 end,
                 case when $6 = 'CONFIRMED' then $9::uuid end, $6, case when $6 = 'CONFIRMED' then $7::uuid end, case when $6 = 'CONFIRMED' then now() end, $8, $8)`,
        [TENANT_A, contract, fixtures.contractorId, kind, text, status, approver, evaluator, decision],
      );
    await violation('DELAY', 'CONFIRMED', `${tag} confirmed`);
    await violation('QUALITY', 'RECORDED', `${tag} recorded`);
  }

  beforeAll(async () => {
    await fixtures.start();
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 901, 'CTR_EXPORTER', ['contractor.export'], 40);
    await adminStatement(fixtures, "update machvon.project set status = 'IMPLEMENTATION', project_group = 'B' where id = $1::uuid", [fixtures.projectId]);
    const other = await fixtures.world.publishedLine({ allocated: '1000000000' });
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: EXPORTER, role: 901, kind: 'TENANT' },
      { n: 2, member: NARROW, role: 901, kind: 'PROJECT', refs: [other.projectId] },
      { n: 3, member: SECOND, role: 901, kind: 'TENANT' },
      { n: 4, member: NARROW_TOO, role: 901, kind: 'PROJECT', refs: [other.projectId] },
    ]);
    contractId = (await fixtures.seedContract()).contractId;
    otherContractId = (await fixtures.seedContract({ projectId: other.projectId })).contractId;
    decision = (await fixtures.documentVersion()).id;
    name = (await rows<{ n: string }>('select legal_name as n from machvon.contractor where id = $1::uuid', [fixtures.contractorId]))[0]?.n as string;
    today = (await rows<{ d: string }>("select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as d"))[0]?.d as string;
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 901, 'CTR_EXPORTER', ['contractor.export'], 40);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 901, kind: 'TENANT' }]);
    root = await mkdtemp(join(tmpdir(), 'machvon-ctr-export-'));
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32), now: () => new Date() });
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ContractorExportController, ContractorExportReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 600_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([ContractorExportController, ContractorExportReadsController]));
  });

  it('AC-ST-CTR-015-1 UAT-AC315: a period with nothing in it is 422 EXPORT_EMPTY and makes no batch; the records are not exported before they are approved or confirmed', async () => {
    const empty = await exportOf(EXPORTER, { period_from: '2027-01-01', period_to: '2027-01-31' });
    expect([empty.status, empty.json.code]).toEqual([422, 'EXPORT_EMPTY']);
    const nothingYet = await exportOf(EXPORTER);
    expect([nothingYet.status, nothingYet.json.code]).toEqual([422, 'EXPORT_EMPTY']);
    expect(await batches()).toEqual([]);
  });

  describe('with an approved evaluation and a confirmed violation in the period', () => {
    beforeAll(async () => {
      await seedRecords(contractId, 'MAIN');
      await seedRecords(otherContractId, 'OTHER');
    });

    it('AC-ST-CTR-015-1 UAT-AC315: the second run with the same parameters returns the same batch and the same hash, and only the approved and the confirmed rows are in the file', async () => {
      const first = await exportOf(EXPORTER);
      expect(first).toMatchObject({ status: 200, json: { status: 'GENERATED', resource_version: 1 } });
      const second = await exportOf(EXPORTER);
      expect(second).toMatchObject({ status: 200, json: { status: 'GENERATED', resource_id: first.json.resource_id } });
      const id = first.json.resource_id as string;
      expect((await batches()).filter((batch) => batch.id === id)).toHaveLength(1);
      const batch = await batchOf(id);
      expect(batch).toMatchObject({ status: 'GENERATED', row_count: 4, version: '1' });
      const file = await fileOf(EXPORTER, id);
      expect(file).toMatchObject({ status: 200, type: expect.stringContaining('text/csv') });
      expect(createHash('sha256').update(Buffer.from(file.text, 'utf8')).digest('hex')).toBe(batch.file_sha256);
      const lines = file.text.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
      expect(lines).toHaveLength(5);
      expect(lines.filter((line) => line.startsWith('EVALUATION,'))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith('VIOLATION,'))).toHaveLength(2);
      expect(file.text).toContain(name);
      for (const excluded of ['-Q2', '-Q1', 'recorded', 'QUALITY']) expect(file.text).not.toContain(excluded);
      expect(file.text).toContain('MAIN-Q3');
      expect(file.text).toContain('80.50,GOOD');
      expect(file.text).toContain('LIQUIDATED_DAMAGES,150000000');
      // The trail has the figures of the batch and not a name or a tax number; the second run is on it as a repeat, and only the first is announced.
      const trail = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'ctr.contractor_export.generated' order by occurred_at, id", [id]);
      expect(trail.map((row) => row.safe_diff.repeated)).toEqual([false, true]);
      expect(trail[0]?.safe_diff).toMatchObject({ scope: 'BOTH', rows: 4, file_sha256: batch.file_sha256, format: 'CSV' });
      expect(JSON.stringify(trail)).not.toContain(name);
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [id]);
      expect(events.map((event) => event.type)).toEqual(['ctr.contractor_export.generated.v1']);
      expect(JSON.stringify(events)).not.toContain(name);
    });

    it('keeps the scopes and the formats apart: performance alone, violations alone and JSON are batches of their own, each with its own kind of row', async () => {
      const performance = await exportOf(EXPORTER, { scope: 'PERFORMANCE' });
      const violations = await exportOf(EXPORTER, { scope: 'VIOLATION' });
      const json = await exportOf(EXPORTER, { format: 'JSON' });
      const ids = [performance, violations, json].map((reply) => reply.json.resource_id as string);
      expect(new Set(ids).size).toBe(3);
      expect((await fileOf(EXPORTER, ids[0] as string)).text).not.toContain('VIOLATION,');
      expect((await fileOf(EXPORTER, ids[1] as string)).text).not.toContain('EVALUATION,');
      const jsonFile = await fileOf(EXPORTER, ids[2] as string);
      expect(jsonFile.type).toContain('application/json');
      expect((JSON.parse(jsonFile.text) as unknown[]).length).toBe(4);
    });

    it('exports only the contracts the caller holds the permission over: one scoped to another project gets that project, a stranger none, and a period that is backwards or too long is refused', async () => {
      const narrow = await exportOf(NARROW);
      expect(narrow.status).toBe(200);
      const file = await fileOf(NARROW, narrow.json.resource_id as string);
      expect(file.text).toContain('OTHER-Q3');
      expect(file.text).not.toContain('MAIN-Q3');
      expect((await batchOf(narrow.json.resource_id as string)).row_count).toBe(2);
      expect((await exportOf(NOBODY)).status).toBe(403);
      for (const [overrides, detail] of [
        [{ period_from: '2026-10-02', period_to: '2026-10-01' }, 'period_to'],
        [{ period_from: '2018-01-01', period_to: '2026-10-01' }, 'period_to'],
        [{ scope: 'ALL' }, 'scope'],
        [{ period_from: '2026-02-30' }, 'period_from'],
      ] as const) {
        const refused = await exportOf(EXPORTER, overrides);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', detail]);
      }
      const xlsx = await exportOf(EXPORTER, { format: 'XLSX' });
      expect([xlsx.status, xlsx.json.detail]).toEqual([422, 'format']);
      const foreign = await call('POST', '/contractor-exports', { member: FOREIGN, tenant: TENANT_B, body: request() });
      expect([foreign.status, foreign.json.code]).toEqual([422, 'EXPORT_EMPTY']);
    });

    it('hands a file to its maker and to whoever holds the permission over the whole tenant, never to a caller with a narrower scope, and not across tenants', async () => {
      const wide = (await exportOf(EXPORTER, { scope: 'VIOLATION', period_from: '2026-01-01' })).json.resource_id as string;
      expect((await fileOf(SECOND, wide)).status).toBe(200);
      expect((await fileOf(NARROW, wide)).status).toBe(404);
      const own = (await exportOf(NARROW, { scope: 'VIOLATION', period_from: '2026-01-01' })).json.resource_id as string;
      expect((await fileOf(NARROW, own)).status).toBe(200);
      const listOf = async (member: number) => ((await call('GET', '/contractor-exports', { member })).json.items as Array<{ id: string }>).map((item) => item.id);
      expect(await listOf(NARROW)).toContain(own);
      expect(await listOf(NARROW)).not.toContain(wide);
      expect(await listOf(SECOND)).toEqual(expect.arrayContaining([own, wide]));
      expect((await call('GET', `/contractor-exports/${wide}/download`, { member: FOREIGN, tenant: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/contractor-exports/${randomUUID()}/download`, { member: EXPORTER })).status).toBe(404);
      expect((await call('GET', '/contractor-exports', { member: NOBODY })).status).toBe(403);
    });

    it('gives the batch to everyone who asks for the same records, and writes a receipt only for one who may read the batch: a stranger of another project cannot mark it, a caller over the whole tenant can', async () => {
      const mine = await exportOf(NARROW, { scope: 'PERFORMANCE', period_from: '2026-03-01' });
      const same = await exportOf(NARROW_TOO, { scope: 'PERFORMANCE', period_from: '2026-03-01' });
      expect(same.json.resource_id).toBe(mine.json.resource_id);
      const id = mine.json.resource_id as string;
      const listOf = async (member: number) => ((await call('GET', '/contractor-exports', { member })).json.items as Array<{ id: string }>).map((item) => item.id);
      expect(await listOf(NARROW_TOO)).toContain(id);
      expect((await fileOf(NARROW_TOO, id)).status).toBe(200);
      // A wider caller asking for the same period gets other records, and the batch of the narrow ones is not theirs to mark... unless they hold the tenant.
      const wide = (await exportOf(EXPORTER, { scope: 'PERFORMANCE', period_from: '2026-03-01' })).json.resource_id as string;
      expect(wide).not.toBe(id);
      const stranger = await call('POST', `/contractor-exports/${wide}/mark-submitted`, { member: NARROW, body: { submitted_ref: 'FALSE-RECEIPT', submitted_on: today } });
      expect([stranger.status, stranger.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await batchOf(wide)).status).toBe('GENERATED');
      expect((await call('POST', `/contractor-exports/${id}/mark-submitted`, { member: NARROW_TOO, body: { submitted_ref: 'OWN-0001', submitted_on: today } })).status).toBe(200);
      expect((await call('POST', `/contractor-exports/${wide}/mark-submitted`, { member: SECOND, body: { submitted_ref: 'WIDE-0001', submitted_on: today } })).status).toBe(200);
    });

    it('revalidates the scope each time: someone who asked for a file of the whole tenant and was narrowed since no longer lists, downloads or marks it', async () => {
      const wide = (await exportOf(EXPORTER, { scope: 'VIOLATION', period_from: '2026-04-01' })).json.resource_id as string;
      expect((await fileOf(EXPORTER, wide)).status).toBe(200);
      // The member was granted the file when their scope was wide; their scope today names another project only.
      await adminStatement(fixtures, 'insert into machvon.contractor_export_access (tenant_id, batch_id, membership_id) values ($1, $2::uuid, $3::uuid)', [TENANT_A, wide, memberId(NARROW)]);
      expect((await fileOf(NARROW, wide)).status).toBe(404);
      const listed = ((await call('GET', '/contractor-exports', { member: NARROW })).json.items as Array<{ id: string }>).map((item) => item.id);
      expect(listed).not.toContain(wide);
      const marked = await call('POST', `/contractor-exports/${wide}/mark-submitted`, { member: NARROW, body: { submitted_ref: 'STALE-GRANT', submitted_on: today } });
      expect(marked.status).toBe(404);
      expect((await batchOf(wide)).status).toBe('GENERATED');
      expect((await rows<{ contract_ids: string[] }>('select contract_ids from machvon.contractor_export_batch where id = $1::uuid', [wide]))[0]?.contract_ids).toContain(contractId);
    });

    it('stores the file once, named by its hash: the same records asked for again, or by someone else, are one object and no copy is left', async () => {
      const first = (await exportOf(EXPORTER, { scope: 'PERFORMANCE', period_from: '2026-05-01' })).json.resource_id as string;
      await exportOf(SECOND, { scope: 'PERFORMANCE', period_from: '2026-05-01' });
      const batch = await batchOf(first);
      expect(batch.file_object_key.endsWith(`/contractor_export/${batch.file_sha256}`)).toBe(true);
      expect((await rows<{ id: string }>('select id from machvon.contractor_export_batch where file_sha256 = $1 and scope = $2', [batch.file_sha256, 'PERFORMANCE'])).filter((row) => row.id === first)).toHaveLength(1);
    });

    it('serves the file for a signed link only: a link that was altered, or that names another file, is 401 SIGNATURE_INVALID', async () => {
      const id = (await exportOf(EXPORTER)).json.resource_id as string;
      const link = (await call('GET', `/contractor-exports/${id}/download`, { member: EXPORTER })).json;
      expect(link).toMatchObject({ export_id: id, format: 'CSV', rows: 4 });
      const url = new URL(`${app.baseUrl}${link.url as string}`);
      const altered = new URL(url);
      altered.searchParams.set('signature', 'a'.repeat(64));
      expect((await fetch(altered)).status).toBe(401);
      const another = new URL(url.toString().replace(/files\/[0-9a-f]{64}/, `files/${'b'.repeat(64)}`));
      expect((await fetch(another)).status).toBe(401);
      const missing = new URL(url);
      missing.searchParams.delete('expires');
      expect((await fetch(missing)).status).toBe(401);
      expect((await fetch(url)).status).toBe(200);
    });

    it('AC-ST-CTR-015-2 UAT-PLAN-18: writes down the receipt of a submission by hand once, and the list says the adapter is PROPOSED and its API MISSING', async () => {
      const id = (await exportOf(EXPORTER)).json.resource_id as string;
      const done = await call('POST', `/contractor-exports/${id}/mark-submitted`, { member: EXPORTER, body: { submitted_ref: '  QG-2026-0001 ', submitted_on: today } });
      expect(done).toMatchObject({ status: 200, json: { status: 'SUBMITTED_EXTERNALLY', resource_version: 2, resource_id: id } });
      expect(await batchOf(id)).toMatchObject({ status: 'SUBMITTED_EXTERNALLY', submitted_ref: 'QG-2026-0001', version: '2' });
      const again = await call('POST', `/contractor-exports/${id}/mark-submitted`, { member: EXPORTER, body: { submitted_ref: 'OTHER', submitted_on: today } });
      expect([again.status, again.json.code]).toEqual([409, 'EXPORT_STATE_INVALID']);
      expect((await batchOf(id)).submitted_ref).toBe('QG-2026-0001');
      const listed = await call('GET', '/contractor-exports', { member: EXPORTER });
      expect(listed.json.adapter).toEqual({ state: 'PROPOSED', api: 'MISSING', cxn: 'CXN-EXE-01' });
      expect((listed.json.items as Array<{ id: string; status: string; submitted_ref: string }>).find((item) => item.id === id)).toMatchObject({ status: 'SUBMITTED_EXTERNALLY', submitted_ref: 'QG-2026-0001' });
      const trail = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'ctr.contractor_export.submitted'", [id]);
      expect(trail[0]?.safe_diff).toMatchObject({ submitted_ref: 'QG-2026-0001', submitted_on: today });
      expect((await eventsOf(id)).includes('ctr.contractor_export.submitted.v1')).toBe(true);
    });

    it('refuses a receipt that is not one: none, one that is too long, a day to come; one for a batch that is not there or is another tenant\'s, or by one with no right', async () => {
      const id = (await exportOf(EXPORTER, { scope: 'PERFORMANCE', period_from: '2026-01-01' })).json.resource_id as string;
      for (const [body, detail] of [
        [{ submitted_ref: '   ', submitted_on: today }, 'submitted_ref'],
        [{ submitted_ref: 'x'.repeat(101), submitted_on: today }, 'submitted_ref'],
        [{ submitted_ref: 'A', submitted_on: '2099-01-01' }, 'submitted_on'],
        [{ submitted_ref: 'A', submitted_on: '2026-02-30' }, 'submitted_on'],
      ] as const) {
        const refused = await call('POST', `/contractor-exports/${id}/mark-submitted`, { member: EXPORTER, body });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', detail]);
      }
      expect((await batchOf(id)).status).toBe('GENERATED');
      expect((await call('POST', `/contractor-exports/${randomUUID()}/mark-submitted`, { member: EXPORTER, body: { submitted_ref: 'A', submitted_on: today } })).status).toBe(404);
      expect((await call('POST', `/contractor-exports/${id}/mark-submitted`, { member: FOREIGN, tenant: TENANT_B, body: { submitted_ref: 'A', submitted_on: today } })).status).toBe(404);
      expect((await call('POST', `/contractor-exports/${id}/mark-submitted`, { member: NOBODY, body: { submitted_ref: 'A', submitted_on: today } })).status).toBe(403);
    });

    it('does not let a batch change, or a receipt change, or either be deleted', async () => {
      const id = (await exportOf(EXPORTER, { scope: 'VIOLATION', period_from: '2026-02-01' })).json.resource_id as string;
      await expect(rows("update machvon.contractor_export_batch set file_sha256 = repeat('0', 64) where id = $1::uuid", [id])).rejects.toThrow('what an export batch is never changes');
      await expect(rows("update machvon.contractor_export_batch set status = 'CONFIRMED' where id = $1::uuid", [id])).rejects.toThrow();
      await call('POST', `/contractor-exports/${id}/mark-submitted`, { member: EXPORTER, body: { submitted_ref: 'A', submitted_on: today } });
      await expect(rows("update machvon.contractor_export_batch set submitted_ref = 'B' where id = $1::uuid", [id])).rejects.toThrow('the receipt of a submission does not change');
      expect((await rows<{ privilege: string }>("select privilege_type as privilege from information_schema.role_table_grants where grantee = 'machvon_app' and table_name = 'contractor_export_batch' and privilege_type in ('DELETE', 'TRUNCATE')")).length).toBe(0);
    });
  });

  const eventsOf = async (aggregateId: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [aggregateId])).map((row) => row.type);
});
