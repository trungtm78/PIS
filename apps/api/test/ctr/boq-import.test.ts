import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { BoqController, BoqLineReadsController } from '../../src/modules/ctr/boq.controller';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from '../../src/modules/ctr/contract.controller';
import { ctrModule } from '../../src/modules/ctr';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedCtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import type { CtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { XLSX_TYPE, xlsxOf } from './xlsx-fixture';

const SIGNING_KEY = randomBytes(32);
const MAKER = 1; // creates a contract and manages its BOQ over the tenant
const DEPARTMENT_MANAGER = 2; // boq.manage and boq_line.read over the department
const ELSEWHERE_MANAGER = 3; // boq.manage over another branch, boq_line.read over the tenant
const READER = 4; // boq_line.read over the tenant
const NOBODY = 5;
const GUEST = 6; // a guest of one contract: boq_line.read on it
const REVISION_READER = 7; // contract_revision.read
const READER_ELSEWHERE = 8; // boq_line.read over another branch
const B_MAKER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x94;
const ABSENT = '00000000-0000-4000-8000-000000009499';
const HEADER = 'business_key,description,unit_code,quantity,unit_price,rounding_rule,retention_pct';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const csv = (rows: readonly string[], header = HEADER): Uint8Array => new TextEncoder().encode(`${header}\n${rows.join('\n')}\n`);

describe('importBoqLines and the reads of the BOQ (ST-CTR-002)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let world: CtrWorld;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function uploadFile(member: number, revisionId: string, version: number | string, bytes: Uint8Array, options: { type?: string; mode?: string | null; key?: string; tenantId?: string } = {}): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: options.type ?? 'text/csv' }), 'boq.csv');
    const mode = options.mode === undefined ? 'APPEND' : options.mode;
    const response = await fetch(`${app.baseUrl}/contract-revisions/${revisionId}/boq-lines${mode === null ? '' : `?mode=${mode}`}`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: tokenOf(member, options.tenantId), 'idempotency-key': options.key ?? `key-${randomUUID()}`, 'if-match': `"${version}"` },
      body: form,
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const line = (key: string, quantity = '3', unitPrice = '1234.5', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    business_key: key,
    description: `Item ${key}`,
    unit_code: 'M3',
    quantity,
    unit_price: unitPrice,
    ...extra,
  });
  const importLines = (member: number, revisionId: string, version: number | string, body: Record<string, unknown>, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/contract-revisions/${revisionId}/boq-lines`, { member, ifMatch: `"${version}"`, body, ...options });
  const replace = (member: number, revisionId: string, version: number | string, lines: unknown[], sha?: string): Promise<Reply> =>
    importLines(member, revisionId, version, { mode: 'REPLACE', lines, ...(sha === undefined ? {} : { file_sha256: sha }) });
  const append = (member: number, revisionId: string, version: number | string, lines: unknown[], sha?: string): Promise<Reply> =>
    importLines(member, revisionId, version, { mode: 'APPEND', lines, ...(sha === undefined ? {} : { file_sha256: sha }) });

  async function draft(value: string): Promise<{ id: string; revisionId: string }> {
    counter += 1;
    const made = await call('POST', '/contracts', {
      member: MAKER,
      body: {
        project_id: world.project,
        package_id: world.packageId,
        contractor_id: world.lead,
        code: `HD-B-${String(counter).padStart(3, '0')}`,
        title: 'Construction of the bridge',
        type: 'UNIT_PRICE',
        advance_category: 'CONSTRUCTION',
        contract_value_vnd: value,
        document_version_id: world.document,
      },
    });
    expect(made.status).toBe(200);
    const revision = await rows<{ id: string }>('select id from machvon.contract_revision where contract_id = $1', [made.json.resource_id]);
    return { id: made.json.resource_id as string, revisionId: revision[0]?.id ?? '' };
  }
  const boqRows = (revisionId: string) =>
    rows<{ business_key: string; amount_vnd: string; rounding_rule: string; retention_pct: string }>(
      'select business_key, amount_vnd::text as amount_vnd, rounding_rule, retention_pct::text as retention_pct from machvon.boq_line where contract_revision_id = $1 order by line_no',
      [revisionId],
    );
  const events = async (revisionId: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [revisionId])).map((event) => event.type);
  const auditActions = async (revisionId: string): Promise<string[]> => (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [revisionId])).map((event) => event.action);
  const counts = async (contractId: string): Promise<{ lines: number; items: number; imports: number }> => ({
    lines: Number((await rows<{ n: number }>('select count(*)::int as n from machvon.boq_line where contract_id = $1', [contractId]))[0]?.n),
    items: Number((await rows<{ n: number }>('select count(*)::int as n from machvon.boq_item where contract_id = $1', [contractId]))[0]?.n),
    imports: Number((await rows<{ n: number }>('select count(*)::int as n from machvon.boq_import where contract_id = $1', [contractId]))[0]?.n),
  });

  beforeAll(async () => {
    await harness.start();
    root = await mkdtemp(join(tmpdir(), 'machvon-boq-test-'));
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MAKER, DEPARTMENT_MANAGER, ELSEWHERE_MANAGER, READER, NOBODY, GUEST, REVISION_READER, READER_ELSEWHERE]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MAKER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'CONTRACT_MAKER', ['contract.create', 'contract.update', 'contract.read', 'boq.manage', 'boq_line.read', 'contract_revision.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'BOQ_MANAGER', ['boq.manage', 'boq_line.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'BOQ_MANAGER_ELSEWHERE', ['boq.manage'], 30);
    await harness.seedRole(TENANT_A, 4, 'BOQ_READER', ['boq_line.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'REVISION_READER', ['contract_revision.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'GUEST_BOQ', ['boq_line.read'], 10);
    await harness.seedRole(TENANT_A, 7, 'BOQ_READER_ELSEWHERE', ['boq_line.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'CONTRACT_MAKER', ['contract.create', 'contract.read', 'boq.manage', 'boq_line.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_MANAGER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: ELSEWHERE_MANAGER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: ELSEWHERE_MANAGER, role: 4, kind: 'TENANT' },
      { n: 5, member: READER, role: 4, kind: 'TENANT' },
      { n: 6, member: REVISION_READER, role: 5, kind: 'TENANT' },
      { n: 7, member: READER_ELSEWHERE, role: 7, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MAKER, role: 1, kind: 'TENANT' }]);
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, MAKER, DEPARTMENT, ROOT);
    await harness.owner(TENANT_A, [
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1 and tenant_id = $3", [memberId(GUEST), world.lead, TENANT_A]],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant(contextFor(TENANT_A, memberId(MAKER)), (tx) => applyBaseline(tx, BASELINE_PACK, memberId(MAKER)));
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ContractController, ContractReadsController, ContractRevisionReadsController, BoqController, BoqLineReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of the register with the two controllers of the BOQ', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([BoqController, BoqLineReadsController]));
  });

  describe('importBoqLines from lines', () => {
    it('rounds 3 x 1,234.5 to 3,704 half up and 3,703 down, and says whether the lines add up to the value of the revision (AC-ST-CTR-002-1)', async () => {
      const contract = await draft('3704');
      const half = await replace(MAKER, contract.revisionId, 1, [line('B01', '3', '1234.5', { rounding_rule: 'HALF_UP' })]);
      expect(half.status).toBe(200);
      expect(half.json).toMatchObject({
        status: 'DRAFT',
        resource_version: 2,
        resource_id: contract.revisionId,
        duplicate: false,
        lines_imported: 1,
        items_created: 1,
        retention_defaulted: 1,
        lines_total_vnd: '3704',
        revision_amount_vnd: '3704',
        difference_vnd: '0',
        balanced: true,
      });
      expect(await boqRows(contract.revisionId)).toEqual([{ business_key: 'B01', amount_vnd: '3704', rounding_rule: 'HALF_UP', retention_pct: '5.0000' }]);
      const down = await replace(MAKER, contract.revisionId, 2, [line('B01', '3', '1234.5', { rounding_rule: 'DOWN' })]);
      expect(down.json).toMatchObject({ resource_version: 3, lines_total_vnd: '3703', difference_vnd: '-1', balanced: false });
      expect(await boqRows(contract.revisionId)).toEqual([expect.objectContaining({ amount_vnd: '3703', rounding_rule: 'DOWN' })]);
      expect(await events(contract.revisionId)).toEqual(['ctr.boq.imported.v1', 'ctr.boq.imported.v1']);
      const payload = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 order by created_at limit 1', [contract.revisionId]);
      expect(payload[0]?.payload).toMatchObject({ contract_id: contract.id, revision_id: contract.revisionId, mode: 'REPLACE', lines_imported: 1, items_created: 1, lines_total_vnd: '3704', actor_id: memberId(MAKER) });
    });

    it('answers the first result for the same file and creates no second item, line or event (AC-ST-CTR-002-2)', async () => {
      const contract = await draft('100000');
      const sha = shaOf(Buffer.from('boq-a'));
      const first = await append(MAKER, contract.revisionId, 1, [line('B01', '1', '1000'), line('B02', '2', '500')], sha);
      const second = await append(MAKER, contract.revisionId, 2, [line('B01', '1', '1000'), line('B02', '2', '500')], sha);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(first.json).toMatchObject({ duplicate: false, resource_version: 2, lines_imported: 2 });
      expect(second.json).toMatchObject({ duplicate: true, resource_version: 2, import_id: first.json.import_id, lines_imported: 2, items_created: 2 });
      expect(await counts(contract.id)).toEqual({ lines: 2, items: 2, imports: 1 });
      expect(await events(contract.revisionId)).toEqual(['ctr.boq.imported.v1']);
      expect(await auditActions(contract.revisionId)).toEqual(['boq.imported', 'boq.import_repeated']);
    });

    it('replays the stored answer for the same key, and refuses the same key with other lines', async () => {
      const contract = await draft('100000');
      const key = `K-BOQ-${randomUUID()}`;
      const first = await replace(MAKER, contract.revisionId, 1, [line('B01', '1', '1000')]);
      const body = { mode: 'REPLACE', lines: [line('B01', '1', '1000')] };
      const replayed = await importLines(MAKER, contract.revisionId, 2, body, { key });
      const again = await importLines(MAKER, contract.revisionId, 2, body, { key });
      expect(again.json).toEqual(replayed.json);
      expect(first.status).toBe(200);
      const changed = await importLines(MAKER, contract.revisionId, 2, { ...body, lines: [line('B01', '2', '1000')] }, { key });
      expect([changed.status, changed.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('lists every fault of the file in one answer and writes nothing', async () => {
      const contract = await draft('100000');
      const refused = await replace(MAKER, contract.revisionId, 1, [line('B01', 'x'), line('B02', '1', '1', { unit_code: 'PARSEC' }), line('B03', '1', '1', { rounding_rule: 'CEIL' }), { ...line('B04'), note: 'x' }]);
      expect(refused.status).toBe(422);
      expect(refused.json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'lines', error_rows: 3 });
      expect(refused.json.errors).toEqual([
        { row: 1, field: 'quantity', reason: 'invalidNumber' },
        { row: 3, field: 'rounding_rule', reason: 'invalidRounding' },
        { row: 4, field: 'note', reason: 'notAllowed' },
      ]);
      // The faults that need master data are told once the rows themselves are well formed.
      const unit = await replace(MAKER, contract.revisionId, 1, [line('B01', '1', '1', { unit_code: 'PARSEC' })]);
      expect(unit.json).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ row: 1, field: 'unit_code', reason: 'unitUnknown' }] });
      expect(await counts(contract.id)).toEqual({ lines: 0, items: 0, imports: 0 });
    });

    it('takes only the three fields of the contract and refuses the rest, an empty import and a mode it does not know', async () => {
      const contract = await draft('100000');
      for (const extra of [{ status: 'ACTIVE' }, { tenant_id: TENANT_B }, { contract_revision_id: randomUUID() }]) {
        const reply = await importLines(MAKER, contract.revisionId, 1, { mode: 'REPLACE', lines: [line('B01')], ...extra });
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      expect((await replace(MAKER, contract.revisionId, 1, [])).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'lines' });
      expect((await importLines(MAKER, contract.revisionId, 1, { mode: 'MERGE', lines: [line('B01')] })).status).toBe(422);
      expect((await importLines(MAKER, contract.revisionId, 1, { lines: [line('B01')] })).status).toBe(400);
      expect((await importLines(MAKER, contract.revisionId, 1, { mode: 'APPEND', lines: [line('B01')], file_sha256: 'ABC' })).status).toBe(422);
      expect((await call('POST', `/contract-revisions/${contract.revisionId}/boq-lines`, { member: MAKER, body: { mode: 'APPEND', lines: [line('B01')] } })).status).toBeGreaterThanOrEqual(400);
      for (const method of ['PATCH', 'PUT', 'DELETE']) {
        const response = await fetch(`${app.baseUrl}/resources/boq_line/${randomUUID()}`, { method, headers: { [TENANT_HEADER]: tokenOf(MAKER), 'content-type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(404);
      }
      expect(await counts(contract.id)).toEqual({ lines: 0, items: 0, imports: 0 });
    });

    it('refuses lines that add up to more than the revision, a stale version, a contract in review and a revision that is not a draft', async () => {
      const contract = await draft('1000');
      const over = await replace(MAKER, contract.revisionId, 1, [line('B01', '1', '1001')]);
      expect(over.status).toBe(422);
      expect(over.json).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', lines_total_vnd: '1001', revision_amount_vnd: '1000', difference_vnd: '1' });
      expect(await replace(MAKER, contract.revisionId, 7, [line('B01', '1', '1000')])).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 1 } });
      expect((await call('POST', `/contract-revisions/${contract.revisionId}/boq-lines`, { member: MAKER, body: { mode: 'REPLACE', lines: [line('B01', '1', '1000')] } })).status).toBeGreaterThanOrEqual(400);
      await rows("update machvon.contract set status = 'IN_REVIEW' where id = $1", [contract.id]);
      expect(await replace(MAKER, contract.revisionId, 1, [line('B01', '1', '1000')])).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
      await rows("update machvon.contract set status = 'DRAFT' where id = $1", [contract.id]);
      await rows("update machvon.contract_revision set status = 'REJECTED' where id = $1", [contract.revisionId]);
      expect(await replace(MAKER, contract.revisionId, 1, [line('B01', '1', '1000')])).toMatchObject({ status: 422, json: { code: 'REVISION_NOT_DRAFT' } });
      expect(await counts(contract.id)).toEqual({ lines: 0, items: 0, imports: 0 });
    });

    it('lets one of two imports at the same version win and answers the other with the current version', async () => {
      const contract = await draft('100000');
      const [left, right] = await Promise.all([replace(MAKER, contract.revisionId, 1, [line('B01', '1', '1000')]), replace(MAKER, contract.revisionId, 1, [line('B02', '1', '2000')])]);
      expect([left.status, right.status].sort()).toEqual([200, 409]);
      const lost = left.status === 409 ? left : right;
      expect(lost.json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 2 });
      expect((await boqRows(contract.revisionId)).length).toBe(1);
      expect((await counts(contract.id)).imports).toBe(1);
    });
  });

  describe('importBoqLines from a file (AC-ST-CTR-002-3)', () => {
    it('reads a clean CSV file as the lines it holds, with the hash of the file, and imports it once', async () => {
      const contract = await draft('100000');
      const bytes = csv(['B01,Excavation,M3,3,1234.5,DOWN,7.5', 'B02,Concrete,M3,2,500,,']);
      const first = await uploadFile(MAKER, contract.revisionId, 1, bytes);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ duplicate: false, lines_imported: 2, lines_total_vnd: '4703', resource_version: 2 });
      expect(await boqRows(contract.revisionId)).toEqual([
        { business_key: 'B01', amount_vnd: '3703', rounding_rule: 'DOWN', retention_pct: '7.5000' },
        { business_key: 'B02', amount_vnd: '1000', rounding_rule: 'HALF_UP', retention_pct: '5.0000' },
      ]);
      const record = await rows<{ source_sha256: string; source_kind: string; source_object_key: string }>('select source_sha256, source_kind, source_object_key from machvon.boq_import where contract_id = $1', [contract.id]);
      expect(record).toEqual([{ source_sha256: shaOf(bytes), source_kind: 'FILE', source_object_key: expect.stringMatching(new RegExp(`^tenants/${TENANT_A}/import/`)) }]);
      const again = await uploadFile(MAKER, contract.revisionId, 2, bytes);
      expect(again.json).toMatchObject({ duplicate: true, import_id: first.json.import_id });
      expect(await counts(contract.id)).toEqual({ lines: 2, items: 2, imports: 1 });
    });

    it('imports a spreadsheet saved as XLSX the same way, and answers the first import for the same file (UAT-PLAN-15)', async () => {
      const contract = await draft('100000');
      const book = xlsxOf([
        ['business_key', 'description', 'unit_code', 'quantity', 'unit_price', 'rounding_rule'],
        ['B01', 'Excavation', 'M3', '3', '1234.5', 'HALF_UP'],
        ['B02', 'Concrete', 'M3', '2', '500', ''],
        ['B03', 'Finishing', 'M2', '10', '100', 'UP'],
      ]);
      const first = await uploadFile(MAKER, contract.revisionId, 1, book, { type: XLSX_TYPE, key: 'k-boq-1-0123456789' });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ duplicate: false, lines_imported: 3, items_created: 3, lines_total_vnd: '5704' });
      const second = await uploadFile(MAKER, contract.revisionId, 2, book, { type: XLSX_TYPE, key: 'k-boq-2-0123456789' });
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ duplicate: true, import_id: first.json.import_id, lines_imported: 3 });
      expect(await counts(contract.id)).toEqual({ lines: 3, items: 3, imports: 1 });
      expect(await boqRows(contract.revisionId)).toEqual([
        expect.objectContaining({ business_key: 'B01', amount_vnd: '3704' }),
        expect.objectContaining({ business_key: 'B02', amount_vnd: '1000' }),
        expect.objectContaining({ business_key: 'B03', amount_vnd: '1000', rounding_rule: 'UP' }),
      ]);
    });

    it('rejects an executable renamed boq.xlsx before the parser runs, and a file with a virus signature, writing nothing (AC-ST-CTR-002-3, UAT-PLAN-16)', async () => {
      const contract = await draft('100000');
      const executable = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]);
      const renamed = await uploadFile(MAKER, contract.revisionId, 1, executable, { type: XLSX_TYPE });
      expect([renamed.status, renamed.json.code]).toEqual([422, 'FILE_TYPE_NOT_ALLOWED']);
      const infected = await uploadFile(MAKER, contract.revisionId, 1, eicarBytes(), { type: 'text/csv' });
      expect([infected.status, infected.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
      expect(await counts(contract.id)).toEqual({ lines: 0, items: 0, imports: 0 });
      expect(await events(contract.revisionId)).toEqual([]);
    });

    it('rejects a file with a virus signature and a format it does not take before any row is read, and writes nothing (AC-ST-CTR-002-3)', async () => {
      const contract = await draft('100000');
      const infected = await uploadFile(MAKER, contract.revisionId, 1, eicarBytes());
      expect([infected.status, infected.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      const image = await uploadFile(MAKER, contract.revisionId, 1, png, { type: 'image/png' });
      expect([image.status, image.json.code]).toEqual([422, 'FILE_TYPE_NOT_ALLOWED']);
      const pdf = await uploadFile(MAKER, contract.revisionId, 1, new TextEncoder().encode('%PDF-1.7 not a table'), { type: 'application/pdf' });
      expect([pdf.status, pdf.json.code]).toEqual([422, 'FILE_TYPE_NOT_ALLOWED']);
      // A file whose name says CSV and whose bytes are binary is judged by its bytes.
      const disguised = await uploadFile(MAKER, contract.revisionId, 1, Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x02]), { type: 'text/csv' });
      expect(disguised.status).toBe(422);
      expect(await counts(contract.id)).toEqual({ lines: 0, items: 0, imports: 0 });
      expect(await events(contract.revisionId)).toEqual([]);
    });

    it('refuses a file without the mode, with a column that is not part of a BOQ or without a required one, and a body that is too large', async () => {
      const contract = await draft('100000');
      const ok = csv(['B01,Excavation,M3,1,1000,,']);
      expect(await uploadFile(MAKER, contract.revisionId, 1, ok, { mode: null })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'mode' } });
      expect(await uploadFile(MAKER, contract.revisionId, 1, ok, { mode: 'MERGE' })).toMatchObject({ status: 422, json: { detail: 'mode' } });
      const unknown = await uploadFile(MAKER, contract.revisionId, 1, csv(['B01,Excavation,M3,1,1000,secret'], 'business_key,description,unit_code,quantity,unit_price,tax_identifier'));
      expect(unknown.json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'file', errors: [{ row: 0, field: 'tax_identifier', reason: 'notAllowed' }] });
      const missing = await uploadFile(MAKER, contract.revisionId, 1, csv(['B01,Excavation,M3,1'], 'business_key,description,unit_code,quantity'));
      expect(missing.json).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ row: 0, field: 'unit_price', reason: 'required' }] });
      const badRow = await uploadFile(MAKER, contract.revisionId, 1, csv(['B01,Excavation,M3,one,1000,,']));
      expect(badRow.json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'lines', errors: [{ row: 1, field: 'quantity', reason: 'invalidNumber' }] });
      const huge = await uploadFile(MAKER, contract.revisionId, 1, new Uint8Array(11 * 1024 * 1024).fill(0x41));
      expect([huge.status, huge.json.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
      expect(await counts(contract.id)).toEqual({ lines: 0, items: 0, imports: 0 });
    });

    it('answers a file for a revision the caller may not manage as the JSON form does', async () => {
      const contract = await draft('100000');
      const ok = csv(['B01,Excavation,M3,1,1000,,']);
      expect((await uploadFile(READER, contract.revisionId, 1, ok)).status).toBe(403);
      expect((await uploadFile(ELSEWHERE_MANAGER, contract.revisionId, 1, ok)).json).toMatchObject({ code: 'SCOPE_DENIED' });
      expect((await uploadFile(B_MAKER, contract.revisionId, 1, ok, { tenantId: TENANT_B })).json).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await counts(contract.id)).toEqual({ lines: 0, items: 0, imports: 0 });
    });
  });

  describe('who may import', () => {
    it('judges the scope of the contract: the department and the tenant import, a reader and a stranger are refused, another branch is told it may not, another tenant finds nothing', async () => {
      const contract = await draft('100000');
      expect((await replace(DEPARTMENT_MANAGER, contract.revisionId, 1, [line('B01', '1', '1000')])).status).toBe(200);
      expect((await replace(READER, contract.revisionId, 2, [line('B01', '1', '1000')])).status).toBe(403);
      expect((await replace(NOBODY, contract.revisionId, 2, [line('B01', '1', '1000')])).status).toBe(403);
      expect(await replace(ELSEWHERE_MANAGER, contract.revisionId, 2, [line('B01', '1', '1000')])).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      const foreign = await importLines(B_MAKER, contract.revisionId, 2, { mode: 'REPLACE', lines: [line('B01', '1', '1000')] }, { tenantId: TENANT_B });
      expect(foreign).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await replace(MAKER, ABSENT, 1, [line('B01', '1', '1000')])).status).toBe(404);
      expect(await auditActions(contract.revisionId)).toContain('boq.imported');
    });
  });

  describe('reads', () => {
    let contract: { id: string; revisionId: string };
    let other: { id: string; revisionId: string };

    beforeAll(async () => {
      contract = await draft('7000');
      await replace(MAKER, contract.revisionId, 1, [line('B01', '1', '1000', { milestone_code: 'M-1', milestone_due_on: '2026-12-31' }), line('B02', '2', '1000'), line('B03', '1', '4000', { retention_pct: '10' })]);
      other = await draft('1000');
      await replace(MAKER, other.revisionId, 1, [line('C01', '1', '1000')]);
      await harness.seedGrants(TENANT_A, [{ n: 20, member: GUEST, role: 6, kind: 'CONTRACT', refs: [contract.id] }]);
    });

    it('lists the lines in the order of the revision with their figures, narrowed to one revision, and pages by cursor', async () => {
      const all = await call('GET', `/resources/boq_line?contract_revision_id=${contract.revisionId}&limit=200`, { member: MAKER });
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => [item.business_key, item.line_no, item.quantity, item.unit_price, item.amount_vnd, item.retention_pct])).toEqual([
        ['B01', 1, '1', '1000', '1000', '5.0000'],
        ['B02', 2, '2', '1000', '2000', '5.0000'],
        ['B03', 3, '1', '4000', '4000', '10.0000'],
      ]);
      expect(items[0]).toMatchObject({ contract_id: contract.id, contract_revision_id: contract.revisionId, revision: 1, revision_status: 'DRAFT', unit_code: 'M3', rounding_rule: 'HALF_UP', milestone_code: 'M-1', milestone_due_on: '2026-12-31', party_contractor_id: null });
      expect(items[0]).toHaveProperty('boq_item_id');
      expect(items[0]).not.toHaveProperty('created_by');
      expect(items[0]).not.toHaveProperty('party_id');
      const first = await call('GET', `/resources/boq_line?contract_id=${contract.id}&limit=2`, { member: MAKER });
      const next = await call('GET', `/resources/boq_line?contract_id=${contract.id}&limit=2&cursor=${first.json.next_cursor as string}`, { member: MAKER });
      expect([...(first.json.items as Array<{ business_key: string }>), ...(next.json.items as Array<{ business_key: string }>)].map((item) => item.business_key)).toEqual(['B01', 'B02', 'B03']);
      expect(next.json.next_cursor).toBeNull();
      const everything = await call('GET', '/resources/boq_line?limit=200', { member: MAKER });
      expect((everything.json.items as unknown[]).length).toBeGreaterThanOrEqual(4);
      expect((await call('GET', '/resources/boq_line?contract_id=nope', { member: MAKER })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id' });
      expect((await call('GET', '/resources/boq_line?contract_revision_id=nope', { member: MAKER })).json).toMatchObject({ detail: 'contract_revision_id' });
      expect((await call('GET', '/resources/boq_line?cursor=nope', { member: MAKER })).status).toBe(422);
    });

    it('reads one line by id, and the totals of the revision in the revision it belongs to', async () => {
      const list = await call('GET', `/resources/boq_line?contract_revision_id=${contract.revisionId}`, { member: DEPARTMENT_MANAGER });
      const lineId = (list.json.items as Array<{ id: string }>)[1]?.id ?? '';
      const one = await call('GET', `/resources/boq_line/${lineId}`, { member: DEPARTMENT_MANAGER });
      expect(one.json).toMatchObject({ id: lineId, business_key: 'B02', amount_vnd: '2000' });
      const revision = await call('GET', `/resources/contract_revision/${contract.revisionId}`, { member: REVISION_READER });
      expect(revision.json).toMatchObject({ amount_vnd: '7000', boq_total_vnd: '7000', boq_line_count: 3 });
      const empty = await call('GET', `/resources/contract_revision/${(await draft('5000')).revisionId}`, { member: REVISION_READER });
      expect(empty.json).toMatchObject({ amount_vnd: '5000', boq_total_vnd: '0', boq_line_count: 0 });
    });

    it('shows a line only inside the scope: the tenant reads all, another branch and another tenant find none, a stranger is refused', async () => {
      const list = await call('GET', `/resources/boq_line?contract_id=${contract.id}`, { member: MAKER });
      const lineId = (list.json.items as Array<{ id: string }>)[0]?.id ?? '';
      expect(((await call('GET', `/resources/boq_line?contract_id=${contract.id}`, { member: READER })).json.items as unknown[]).length).toBe(3);
      expect(((await call('GET', `/resources/boq_line?contract_id=${contract.id}`, { member: READER_ELSEWHERE })).json.items as unknown[]).length).toBe(0);
      expect((await call('GET', `/resources/boq_line/${lineId}`, { member: READER_ELSEWHERE })).json).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect((await call('GET', `/resources/boq_line/${lineId}`, { member: B_MAKER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/resources/boq_line/${randomUUID()}`, { member: MAKER })).json).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect((await call('GET', '/resources/boq_line', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/boq_line/${lineId}`, { member: NOBODY })).status).toBe(403);
    });

    it('shows a guest contractor the lines of its own contract and not the stable item, and the other contracts as absent', async () => {
      const mine = await call('GET', '/resources/boq_line?limit=200', { member: GUEST });
      expect(mine.status).toBe(200);
      const items = mine.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.business_key)).toEqual(['B01', 'B02', 'B03']);
      expect(items[0]).not.toHaveProperty('boq_item_id');
      const otherLine = await rows<{ id: string }>('select id from machvon.boq_line where contract_id = $1', [other.id]);
      expect((await call('GET', `/resources/boq_line/${otherLine[0]?.id}`, { member: GUEST })).json).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect((await call('GET', '/resources/contract_revision', { member: GUEST })).status).toBe(403);
      expect((await replace(GUEST, contract.revisionId, 2, [line('B01', '1', '1000')])).status).toBe(403);
    });
  });
});
