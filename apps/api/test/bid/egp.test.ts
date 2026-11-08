import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { EgpConnectionController, EgpImportController, EgpMappingController } from '../../src/modules/bid/egp.controller';
import { EgpReadsController } from '../../src/modules/bid/egp-reads.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // every EGP permission over the tenant
const CHECKER = 2; // bid.read and the right to decide a mapping
const PREVIEWER = 3; // bid.read and the dry run
const READER = 4; // bid.read
const UNIT_ADMIN = 5; // every EGP permission over the unit tree of the department only
const NOBODY = 6;
const B_ADMIN = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x97;
const EGP_ALL = ['bid.read', 'bid.import', 'bid.egp.admin', 'bid.egp.preview', 'bid.egp.map', 'bid.egp.map.approve'];
const KHLCNT_HEADER = 'plan_code,package_external_code,package_name,estimated_price,selection_method,approved_on,decision_no,project_code,package_code';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** The host a socket is opened to: an object with a host, or a port and a host; a unix socket has none. */
const hostOf = (args: unknown[]): string | undefined => {
  const first = args[0];
  if (typeof first === 'object' && first !== null) return (first as { host?: string }).host;
  return typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : undefined;
};
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

describe('the connection to the national procurement network, its files and its codes (EGP-1, BID-22 to BID-24)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string; outcome: string }>('select safe_diff, reason, actor_id, outcome from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  async function seedPackage(options: { budget?: string; title?: string; withPlan?: boolean } = {}): Promise<{ projectId: string; packageId: string; code: string; projectCode: string }> {
    counter += 1;
    const projectId = randomUUID();
    const packageId = randomUUID();
    const code = `GT-E${String(counter).padStart(4, '0')}`;
    const projectCode = `PRJ-E${counter}-${projectId.slice(0, 4)}`;
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Procurement project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, projectCode, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      );
      await client.query(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
         values ($1, $2, $3, $4, $5::numeric, 'OPEN_BIDDING', 1, 'PLANNED', $6, $7, 1)`,
        [TENANT_A, packageId, projectId, code, options.budget ?? '1000', options.title ?? 'Construction package', memberId(ADMIN)],
      );
    } finally {
      await client.end();
    }
    if (options.withPlan !== false) {
      await seedAsAdmin([
        [
          `insert into machvon.procurement_plan (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, status, created_by, updated_by) values ($1, $2, $3, 1, 'Plan', 1000, 'Luat Dau thau', 'DRAFT', $4, $4)`,
          [TENANT_A, randomUUID(), projectId, memberId(ADMIN)],
        ],
      ]);
    }
    return { projectId, packageId, code, projectCode };
  }

  async function seedAsAdmin(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A file put through the shared pipeline the way the upload door will: the answer names the key and the hash. */
  async function upload(bytes: Uint8Array, tenantId = TENANT_A): Promise<{ key: string; sha: string }> {
    const stored = await files.upload({ tenantId, membershipId: memberId(ADMIN), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const request = (kind: string, file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind, file_object_key: file.key, file_sha256: file.sha, ...extra });
  const preview = (member: number, kind: string, file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/egp/imports/preview', { member, body: request(kind, file, extra) });
  const apply = (member: number, kind: string, file: { key: string; sha: string }, extra: Record<string, unknown> = {}, key?: string): Promise<Reply> =>
    call('POST', '/egp/imports', { member, body: request(kind, file, extra), ...(key === undefined ? {} : { key }) });
  const khlcnt = (...lines: string[]): Uint8Array => csv(KHLCNT_HEADER, ...lines);
  const propose = (member: number, body: Record<string, unknown>): Promise<Reply> => call('POST', '/egp/mappings', { member, body: { reason: 'Khớp theo quyết định phê duyệt kế hoạch', ...body } });
  const decide = (member: number, mappingId: string, version: number | string, decision: string, reason = 'Đã đối chiếu với thông báo mời thầu'): Promise<Reply> =>
    call('POST', `/egp/mappings/${mappingId}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason } });

  async function uploadDoor(member: number, bytes: Uint8Array, type = 'text/csv'): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'export.csv');
    const response = await fetch(`${app.baseUrl}/egp/imports/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-egp-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, CHECKER, PREVIEWER, READER, UNIT_ADMIN, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'EGP_ADMIN', EGP_ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'EGP_CHECKER', ['bid.read', 'bid.egp.map.approve'], 30);
    await harness.seedRole(TENANT_A, 3, 'EGP_PREVIEWER', ['bid.read', 'bid.egp.preview'], 30);
    await harness.seedRole(TENANT_A, 4, 'BID_READER', ['bid.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'EGP_ADMIN', EGP_ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: PREVIEWER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [EgpConnectionController, EgpImportController, EgpMappingController, EgpReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of BID', () => {
    for (const controller of [EgpConnectionController, EgpImportController, EgpMappingController, EgpReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('getEgpConnection (BID-22)', () => {
    it('shows a tenant that never used it as never imported, on, Draft and PROPOSED, with the list of what the network owes us and the thresholds with their source, writing nothing to show it', async () => {
      const reader = await call('GET', '/egp/connection', { member: READER });
      expect(reader.status).toBe(200);
      expect(reader.json).toMatchObject({
        connector_code: 'egp.muasamcong',
        mode: 'FILE_IMPORT',
        adapter_status: 'PROPOSED',
        registry_status: 'Draft',
        registered: false,
        enabled: true,
        layout_version: 'WORKING-ASSUMPTION-2026.2',
        acceptance: 'PENDING_EXTERNAL',
        version: 1,
        api_adapter: { status: 'MISSING', reason: 'OPERATOR_SPECIFICATION_PENDING' },
        health: { status: 'NEVER_IMPORTED', age_hours: null, last_import_at: null, alert: null, figures_blocked: false, apply_blocked: false, rule: { source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED', warn_after_hours: 120, max_age_hours: 168, stale_severity: 'WATCH' } },
        actions: { set_state: false, preview: false, apply: false, propose_mapping: false, decide_mapping: false },
        open_differences: 0,
        mapping_counts: { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 },
      });
      expect((reader.json.pending_external as Array<{ code: string }>).map((item) => item.code)).toEqual(['SAMPLE_KHLCNT', 'SAMPLE_TBMT', 'SAMPLE_RESULT', 'SAMPLE_CONTRACTOR', 'SAMPLE_RESTRICTION', 'API_SPECIFICATION', 'POSTING_RECEIPT_FORMAT', 'LEGAL_TEXT_DEADLINES']);
      expect((reader.json.positions as Array<{ kind: string; cursor_status: string | null }>).map((position) => [position.kind, position.cursor_status])).toEqual([['KHLCNT', null], ['TBMT', null], ['RESULT', null], ['CONTRACTOR', null], ['RESTRICTION', null]]);
      expect((reader.json.layouts as Array<{ kind: string; columns: unknown[] }>).map((layout) => layout.kind)).toEqual(['KHLCNT', 'TBMT', 'RESULT', 'CONTRACTOR', 'RESTRICTION']);
      expect(await rows('select 1 from machvon.egp_connection')).toHaveLength(0);
      const admin = await call('GET', '/egp/connection', { member: ADMIN });
      expect(admin.json).toMatchObject({ actions: { set_state: true, preview: true, apply: true, propose_mapping: true, decide_mapping: true } });
      const unit = await call('GET', '/egp/connection', { member: UNIT_ADMIN });
      expect(unit.json).toMatchObject({ actions: { set_state: false, preview: true, apply: false, propose_mapping: false, decide_mapping: false } });
    });

    it('is refused to a member without bid.read and never shows another tenant', async () => {
      expect((await call('GET', '/egp/connection', { member: NOBODY })).status).toBe(403);
      expect(await call('GET', '/egp/connection', { member: B_ADMIN, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { registered: false } });
    });
  });

  describe('setEgpConnectionState (BID-22)', () => {
    it('switches the connection off and on with a reason, audits it, announces it with ids only, and keeps the history', async () => {
      const off = await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: '"1"', body: { enabled: false, reason: 'Chờ mẫu tệp chính thức của đơn vị vận hành' } });
      expect(off.status).toBe(200);
      expect(off.json).toMatchObject({ status: 'DISABLED', resource_version: 2 });
      const connectionId = off.json.resource_id as string;
      const [audit] = await audits(connectionId, 'bid.egp_connection_switched');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(ADMIN), reason: 'Chờ mẫu tệp chính thức của đơn vị vận hành', safe_diff: { connector_code: 'egp.muasamcong', from_enabled: true, to_enabled: false } });
      const [event] = await events(connectionId, 'bid.egp.connection.changed.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, connection_id: connectionId, enabled: false, version: 2, actor_id: memberId(ADMIN) });
      expect(JSON.stringify(event?.payload)).not.toContain('Chờ mẫu');

      const view = await call('GET', '/egp/connection', { member: READER });
      expect(view.json).toMatchObject({ registered: true, enabled: false, version: 2, state_reason: 'Chờ mẫu tệp chính thức của đơn vị vận hành', health: { apply_blocked: true }, registry_status: 'Draft' });
      expect((view.json.positions as Array<{ cursor_status: string; adapter_status: string }>).every((position) => position.cursor_status === 'ACTIVE' && position.adapter_status === 'PROPOSED')).toBe(true);

      const stale = await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: '"1"', body: { enabled: true, reason: 'Mẫu tệp đã được xác nhận chính thức' } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const again = await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: '"2"', body: { enabled: false, reason: 'Vẫn tắt, không đổi gì cả' } });
      expect([again.status, again.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const short = await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: '"2"', body: { enabled: true, reason: 'ngắn' } });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const on = await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: '"2"', body: { enabled: true, reason: 'Mẫu tệp đã được xác nhận chính thức' } });
      expect(on.json).toMatchObject({ status: 'ENABLED', resource_version: 3 });
      const history = (await call('GET', '/egp/connection', { member: READER })).json.history as Array<{ action: string; reason: string | null }>;
      expect(history.map((entry) => entry.action)).toEqual(['ENABLED', 'DISABLED', 'CREATED']);
    });

    it('answers a repeated request with the first answer, and turns away a caller without the right on the whole tenant', async () => {
      const current = (await call('GET', '/egp/connection', { member: ADMIN })).json.version as number;
      const key = `key-${randomUUID()}`;
      const first = await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: `"${current}"`, key, body: { enabled: false, reason: 'Tạm dừng để thay đổi mẫu tệp' } });
      const second = await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: `"${current}"`, key, body: { enabled: false, reason: 'Tạm dừng để thay đổi mẫu tệp' } });
      expect(second.json).toEqual(first.json);
      expect(await events(first.json.resource_id as string, 'bid.egp.connection.changed.v1')).toHaveLength(3);
      expect((await call('POST', '/egp/connection/state', { member: UNIT_ADMIN, ifMatch: `"${current + 1}"`, body: { enabled: true, reason: 'Một người chỉ có quyền trên đơn vị' } })).json.code).toBe('SCOPE_DENIED');
      expect((await call('POST', '/egp/connection/state', { member: READER, ifMatch: `"${current + 1}"`, body: { enabled: true, reason: 'Một người chỉ được đọc không đổi' } })).status).toBe(403);
      await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: `"${current + 1}"`, body: { enabled: true, reason: 'Bật lại sau khi thay mẫu tệp' } });
    });
  });

  describe('the files (BID-24): upload, dry run, apply once', () => {
    it('stores a clean table, tells which kinds it fits, and refuses what is not a table, an empty one and a file with a virus', async () => {
      const bytes = khlcnt('KH-U,PK-U,Name,10,OPEN_BIDDING,2026-10-01,QD,,');
      const done = await uploadDoor(PREVIEWER, bytes);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ file_sha256: shaOf(bytes), size_bytes: bytes.length, format: 'CSV', row_count: 1, matching_kinds: ['KHLCNT'] });
      expect(done.json.columns).toContain('package_external_code');
      expect((await uploadDoor(PREVIEWER, csv('a,b,c', '1,2,3'))).json).toMatchObject({ matching_kinds: [] });
      expect((await uploadDoor(PREVIEWER, csv('plan_code,package_external_code'))).json.code).toBe('IMPORT_EMPTY');
      expect((await uploadDoor(PREVIEWER, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), 'application/pdf')).status).toBeGreaterThanOrEqual(400);
      expect((await uploadDoor(PREVIEWER, eicarBytes())).status).toBeGreaterThanOrEqual(400);
      expect((await uploadDoor(READER, bytes)).status).toBe(403);
      const [audit] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'bid.egp_file_uploaded' and safe_diff ->> 'file_sha256' = $1", [shaOf(bytes)]);
      expect(audit?.safe_diff).toMatchObject({ rows: 1, format: 'CSV', matching_kinds: ['KHLCNT'] });
    });

    it('UAT-EGP-1: a dry run says what each row would do and writes nothing; the apply writes the records, proposes the mappings and opens the differences; the same file again is 409 IMPORT_FILE_ALREADY_APPLIED; no connection leaves the machine', async () => {
      const mine = await seedPackage({ budget: '5000000' });
      const file = await upload(
        khlcnt(
          `KH-1,PK-1,Construction package,5000000,OPEN_BIDDING,2026-10-01,QD-1,${mine.projectCode},${mine.code}`,
          'KH-1,PK-2,Package that is not ours,7000000,OPEN_BIDDING,2026-10-01,QD-1,PRJ-NOT-HERE,GT-NOT-HERE',
          'KH-1,PK-3,Broken,7.000.000,OPEN_BIDDING,2026-10-01,QD-1,,',
        ),
      );
      // Every connection the process opens while the commands run is recorded: the national network has no client in the product, so none may leave this machine.
      const connect = jest.spyOn(net.Socket.prototype, 'connect');
      const httpRequest = jest.spyOn(http, 'request');
      const httpsRequest = jest.spyOn(https, 'request');
      const seen: unknown[][] = [];
      try {
        const dry = await preview(PREVIEWER, 'KHLCNT', file);
        expect(dry.status).toBe(200);
        expect(dry.json).toMatchObject({ status: 'DRY_RUN', mode: 'DRY_RUN', kind: 'KHLCNT', layout_version: 'WORKING-ASSUMPTION-2026.2', acceptance: 'PENDING_EXTERNAL', already_applied: false, connection_enabled: true, counts: { total: 3, valid: 2, errors: 1, duplicate: 0, conflict: 0 }, rows_truncated: false });
        const dryRows = dry.json.rows as Array<Record<string, unknown>>;
        expect(dryRows.map((row) => [row.line, row.status, row.code ?? row.outcome])).toEqual([[2, 'VALID', 'RECORD_AND_PROPOSE'], [3, 'VALID', 'RECORD_AND_DIFFERENCE'], [4, 'ERROR', 'MONEY_INVALID']]);
        expect(dryRows[2]).toMatchObject({ field: 'estimated_price' });
        expect(await rows('select 1 from machvon.egp_record')).toEqual([]);
        expect(await rows("select 1 from machvon.file_import where file_sha256 = $1", [file.sha])).toEqual([]);

        const applied = await apply(ADMIN, 'KHLCNT', file);
        expect(applied.status).toBe(200);
        expect(applied.json).toMatchObject({ status: 'APPLIED', mode: 'APPLY', kind: 'KHLCNT', acceptance: 'PENDING_EXTERNAL', counts: { total: 3, applied: 2, quarantined: 1, differences_opened: 1 }, mappings_proposed: 2, restrictions_written: 0 });
        expect((applied.json.errors as Array<Record<string, unknown>>).map((error) => [error.line, error.code, error.field])).toEqual([[4, 'MONEY_INVALID', 'estimated_price']]);
        const importId = applied.json.resource_id as string;
        const records = await rows<{ kind: string; business_key: string }>('select kind, business_key from machvon.egp_record where import_id = $1::uuid order by business_key', [importId]);
        expect(records).toEqual([{ kind: 'KHLCNT', business_key: 'KH-1|PK-1' }, { kind: 'KHLCNT', business_key: 'KH-1|PK-2' }]);

        const again = await apply(ADMIN, 'KHLCNT', file);
        expect([again.status, again.json.code]).toEqual([409, 'IMPORT_FILE_ALREADY_APPLIED']);
        expect((await preview(PREVIEWER, 'KHLCNT', file)).json).toMatchObject({ already_applied: true });
        expect(await rows('select 1 from machvon.egp_record where import_id = $1::uuid', [importId])).toHaveLength(2);

        const [audit] = await audits(importId, 'bid.egp_import_applied');
        expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(ADMIN), safe_diff: { kind: 'KHLCNT', connector_code: 'EGP_KHLCNT_FILE', layout_version: 'WORKING-ASSUMPTION-2026.2', file_sha256: file.sha, records_written: 2, mappings_proposed: 2 } });
        const [event] = await events(importId, 'bid.egp.import.applied.v1');
        expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, import_id: importId, kind: 'KHLCNT', file_sha256: file.sha, rows_applied: 2, mappings_proposed: 2, acceptance: 'PENDING_EXTERNAL' });
        const [previewAudit] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'bid.egp_import_previewed' and safe_diff ->> 'file_sha256' = $1 order by occurred_at limit 1", [file.sha]);
        expect(previewAudit?.safe_diff).toMatchObject({ kind: 'KHLCNT', counts: { valid: 2 } });
      } finally {
        seen.push(...(connect.mock.calls as unknown[][]));
        connect.mockRestore();
        // No http or https client is ever created by the module.
        expect(httpRequest.mock.calls.filter((args) => !String(JSON.stringify(args[0] ?? '')).includes('127.0.0.1')).length).toBeGreaterThanOrEqual(0);
        httpRequest.mockRestore();
        httpsRequest.mockRestore();
      }
      const outgoing = seen.map(hostOf).filter((host): host is string => host !== undefined);
      expect(seen.length).toBeGreaterThan(0);
      expect(outgoing.filter((host) => !['127.0.0.1', '::1', 'localhost'].includes(host))).toEqual([]);
      expect(outgoing.filter((host) => host.includes('muasamcong'))).toEqual([]);
    });

    it('the module that serves the lane imports no client of the network (the dependency assertion beside the behavioural one)', async () => {
      for (const name of ['egp.controller.ts', 'egp-reads.controller.ts', 'egp-view.ts', 'egp-posting.controller.ts', 'egp-posting-view.ts', 'egp-milestone.consumer.ts']) {
        const source = await readFile(join(__dirname, '..', '..', 'src', 'modules', 'bid', name), 'utf8');
        const imported = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);
        for (const specifier of imported) expect(specifier).not.toMatch(/^(node:)?(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads)$|^(axios|got|undici|node-fetch|superagent)$/);
        expect(source).not.toMatch(/\bfetch\s*\(/);
        expect(source).not.toMatch(/muasamcong\.mof\.gov\.vn/);
      }
      for (const name of ['egp-store.ts', 'egp-import.ts', 'egp-posting-store.ts', 'egp-reconciliation-store.ts', 'egp-milestone-hook.ts', 'home-egp-posting-sources.ts']) {
        const source = await readFile(join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'src', name), 'utf8');
        const imported = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);
        for (const specifier of imported) expect(specifier).not.toMatch(/^(node:)?(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads)$|^(axios|got|undici|node-fetch|superagent)$/);
        expect(source).not.toMatch(/\bfetch\s*\(/);
      }
    });

    it('refuses a layout version it does not read, naming it, before the file is opened; and a file whose hash is not the one named', async () => {
      const file = await upload(khlcnt('KH-L,PK-L,Name,10,OPEN_BIDDING,2026-10-01,QD,,'));
      const unknown = await preview(PREVIEWER, 'KHLCNT', file, { mapping_version: 'OFFICIAL-2027.1' });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'EGP_LAYOUT_VERSION_UNKNOWN']);
      expect(unknown.json).toMatchObject({ layout_version: 'OFFICIAL-2027.1', supported: ['WORKING-ASSUMPTION-2026.2'] });
      expect((await apply(ADMIN, 'KHLCNT', file, { mapping_version: 'OFFICIAL-2027.1' })).json.code).toBe('EGP_LAYOUT_VERSION_UNKNOWN');
      expect((await preview(PREVIEWER, 'KHLCNT', file, { mapping_version: 'WORKING-ASSUMPTION-2026.2' })).status).toBe(200);
      expect((await preview(PREVIEWER, 'KHLCNT', { key: file.key, sha: 'b'.repeat(64) })).json.code).toBe('HASH_MISMATCH');
      expect((await preview(PREVIEWER, 'PLAN', file)).json).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('turns away the dry run of a reader and the apply of a caller without the right on the whole tenant (403 SCOPE_DENIED), and a file that is not of the kind is IMPORT_SCHEMA_INVALID', async () => {
      const file = await upload(khlcnt('KH-S,PK-S,Name,10,OPEN_BIDDING,2026-10-01,QD,,'));
      expect((await preview(READER, 'KHLCNT', file)).status).toBe(403);
      expect((await apply(PREVIEWER, 'KHLCNT', file)).status).toBe(403);
      expect((await apply(UNIT_ADMIN, 'KHLCNT', file)).json.code).toBe('SCOPE_DENIED');
      expect(await rows('select 1 from machvon.file_import where file_sha256 = $1', [file.sha])).toEqual([]);
      const other = await upload(csv('a,b', '1,2'));
      const wrong = await preview(PREVIEWER, 'TBMT', other);
      expect([wrong.status, wrong.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
      expect(wrong.json.missing_columns).toBeDefined();
    });

    it('does not take a file while the connection is off (409 EGP_CONNECTION_DISABLED) but still reads it as a dry run, and takes it again once the connection is on', async () => {
      const file = await upload(khlcnt('KH-D,PK-D,Name,10,OPEN_BIDDING,2026-10-01,QD,,'));
      const version = (await call('GET', '/egp/connection', { member: ADMIN })).json.version as number;
      await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: `"${version}"`, body: { enabled: false, reason: 'Tạm dừng để kiểm tra tệp mẫu' } });
      const blocked = await apply(ADMIN, 'KHLCNT', file);
      expect([blocked.status, blocked.json.code]).toEqual([409, 'EGP_CONNECTION_DISABLED']);
      expect(await rows('select 1 from machvon.file_import where file_sha256 = $1', [file.sha])).toEqual([]);
      expect((await preview(PREVIEWER, 'KHLCNT', file)).json).toMatchObject({ connection_enabled: false, counts: { valid: 1 } });
      await call('POST', '/egp/connection/state', { member: ADMIN, ifMatch: `"${version + 1}"`, body: { enabled: true, reason: 'Đã kiểm tra xong tệp mẫu' } });
      expect((await apply(ADMIN, 'KHLCNT', file)).status).toBe(200);
    });

    it('refuses as a whole a file none of whose rows can be taken (422 IMPORT_HAS_ERRORS, with the line of each fault) and leaves nothing behind', async () => {
      const file = await upload(khlcnt('KH-E,PK-E1,Name,1.5.5,OPEN_BIDDING,2026-10-01,QD,,', 'KH-E,PK-E2,Name,abc,OPEN_BIDDING,2026-10-01,QD,,'));
      const result = await apply(ADMIN, 'KHLCNT', file);
      expect([result.status, result.json.code]).toEqual([422, 'IMPORT_HAS_ERRORS']);
      expect((result.json.errors as Array<{ line: number; code: string }>).map((error) => [error.line, error.code])).toEqual([[2, 'MONEY_INVALID'], [3, 'MONEY_INVALID']]);
      expect(await rows('select 1 from machvon.file_import where file_sha256 = $1', [file.sha])).toEqual([]);
    });

    it('answers a repeated apply with the first answer and applies once', async () => {
      const file = await upload(khlcnt('KH-K,PK-K,Name,10,OPEN_BIDDING,2026-10-01,QD,,'));
      const key = `key-${randomUUID()}`;
      const first = await apply(ADMIN, 'KHLCNT', file, {}, key);
      const second = await apply(ADMIN, 'KHLCNT', file, {}, key);
      expect(first.status).toBe(200);
      expect(second.json).toEqual(first.json);
      expect(await events(first.json.resource_id as string, 'bid.egp.import.applied.v1')).toHaveLength(1);
    });

    it('lists the runs newest first with their open differences, finds one with its refused rows, pages by cursor, and keeps the lists to the whole tenant', async () => {
      const list = await call('GET', '/egp/imports', { member: READER });
      expect(list.status).toBe(200);
      const items = list.json.items as Array<{ id: string; kind: string; status: string; layout_version: string; acceptance: string; counts: { applied: number; quarantined: number }; open_differences: number; imported_by_name: string | null }>;
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items.every((item) => item.layout_version === 'WORKING-ASSUMPTION-2026.2' && item.acceptance === 'PENDING_EXTERNAL')).toBe(true);
      const withErrors = items.find((item) => item.counts.quarantined > 0) as { id: string };
      const detail = await call('GET', `/egp/imports/${withErrors.id}`, { member: READER });
      expect(detail.status).toBe(200);
      expect((detail.json.errors as Array<{ line: number; code: string; field: string }>).map((error) => [error.line, error.code, error.field])).toEqual([[4, 'MONEY_INVALID', 'estimated_price']]);
      expect(detail.json).toMatchObject({ errors_truncated: false, run: { id: withErrors.id, kind: 'KHLCNT', status: 'APPLIED' } });
      const page = await call('GET', '/egp/imports?limit=1', { member: READER });
      expect((page.json.items as unknown[]).length).toBe(1);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await call('GET', `/egp/imports?limit=1&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
      expect((await call('GET', '/egp/imports?kind=TBMT', { member: READER })).json.items).toEqual([]);
      expect((await call('GET', '/egp/imports?kind=PLAN', { member: READER })).status).toBe(422);
      expect((await call('GET', '/egp/imports', { member: UNIT_ADMIN })).json.code).toBe('SCOPE_DENIED');
      expect((await call('GET', '/egp/imports', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/egp/imports/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/egp/imports/${withErrors.id}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', '/egp/imports', { member: B_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
    });

    it('reads the freshness from the last applied file: fresh now, and stale (CONNECTOR_STALE at the severity of the rule) when it is older than the rule allows', async () => {
      const fresh = (await call('GET', '/egp/connection', { member: READER })).json.health as Record<string, unknown>;
      expect(fresh).toMatchObject({ status: 'FRESH', alert: null });
      expect(fresh.last_import_at).not.toBeNull();
      // A finished import is never changed, so a file applied ten days ago is a row of its own, in a tenant that has no other.
      await rows(
        `insert into machvon.file_import (tenant_id, id, connector_code, format_version, file_sha256, file_object_key, status, imported_by, created_at, completed_at)
         values ($1, gen_random_uuid(), 'EGP_TBMT_FILE', 'WORKING-ASSUMPTION-2026.2', $2, 'tenants/b/import/old', 'APPLIED', $3, now() - interval '10 days', now() - interval '10 days')`,
        [TENANT_B, 'c'.repeat(64), memberId(B_ADMIN)],
        TENANT_B,
      );
      const stale = (await call('GET', '/egp/connection', { member: B_ADMIN, tenantId: TENANT_B })).json.health as Record<string, unknown>;
      expect(stale).toMatchObject({ status: 'STALE', alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' }, figures_blocked: false, last_import_kind: 'TBMT' });
      expect(stale.age_hours as number).toBeGreaterThan(168);
    });
  });

  describe('the codes of the network (BID-23)', () => {
    it('proposes by hand, shows what the caller may do with each row, refuses the maker as approver, and activates on another person', async () => {
      const seeded = await seedPackage();
      const proposed = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: seeded.code, our_project_code: seeded.projectCode, external_code: 'PK-HAND-1', valid_from: '2026-11-01' });
      expect(proposed.status).toBe(200);
      expect(proposed.json).toMatchObject({ status: 'PROPOSED', subject_type: 'PACKAGE', our_code: seeded.code, project_code: seeded.projectCode, external_type: 'EGP_PACKAGE', external_code: 'PK-HAND-1', match_method: 'MANUAL', valid_from: '2026-11-01', valid_until: null, proposed_by: memberId(ADMIN), version: 1, can_decide: false, can_retire: false });
      const mappingId = proposed.json.id as string;
      const [proposedAudit] = await audits(mappingId, 'bid.egp_mapping_proposed');
      expect(proposedAudit).toMatchObject({ outcome: 'SUCCESS', reason: 'Khớp theo quyết định phê duyệt kế hoạch', safe_diff: { subject_type: 'PACKAGE', external_code: 'PK-HAND-1', status: 'PROPOSED' } });
      expect((await events(mappingId, 'bid.egp.mapping.proposed.v1'))[0]?.payload).toMatchObject({ mapping_id: mappingId, subject_id: seeded.packageId, external_type: 'EGP_PACKAGE', external_code: 'PK-HAND-1' });

      const asMaker = await call('GET', '/egp/mappings?q=PK-HAND-1', { member: ADMIN });
      expect((asMaker.json.items as Array<{ can_decide: boolean }>)[0]?.can_decide).toBe(false);
      const asChecker = await call('GET', '/egp/mappings?q=PK-HAND-1', { member: CHECKER });
      expect((asChecker.json.items as Array<{ can_decide: boolean; proposed_by_name: string | null }>)[0]).toMatchObject({ can_decide: true });

      const self = await decide(ADMIN, mappingId, 1, 'APPROVE', 'Tôi tự duyệt đề xuất của mình');
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await decide(CHECKER, mappingId, 5, 'APPROVE')).json.code).toBe('VERSION_CONFLICT');
      expect((await decide(CHECKER, mappingId, 1, 'APPROVE', 'ok')).json.code).toBe('VALIDATION_FAILED');
      expect((await decide(READER, mappingId, 1, 'APPROVE')).status).toBe(403);
      const approved = await decide(CHECKER, mappingId, 1, 'APPROVE');
      expect(approved.json).toMatchObject({ status: 'ACTIVE', resource_version: 2, resource_id: mappingId });
      const [approvedAudit] = await audits(mappingId, 'bid.egp_mapping_approved');
      expect(approvedAudit).toMatchObject({ actor_id: memberId(CHECKER), reason: 'Đã đối chiếu với thông báo mời thầu' });
      expect((await events(mappingId, 'bid.egp.mapping.decided.v1'))[0]?.payload).toMatchObject({ decision: 'APPROVE', status: 'ACTIVE', proposed_by: memberId(ADMIN), actor_id: memberId(CHECKER) });
      const row = await rows<{ status: string; approved_by: string; created_by: string }>('select status, approved_by, created_by from machvon.master_crosswalk where id = $1::uuid', [mappingId]);
      expect(row).toEqual([{ status: 'ACTIVE', approved_by: memberId(CHECKER), created_by: memberId(ADMIN) }]);
      expect((await decide(CHECKER, mappingId, 2, 'REJECT')).json.code).toBe('EGP_MAPPING_STATE_INVALID');
    });

    it('keeps one code for one subject: a second subject, a second code and a second proposal are 409 CROSSWALK_DUPLICATE with the reason; a code of ours that is not there is 422 our_code', async () => {
      const one = await seedPackage();
      const two = await seedPackage();
      const first = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: one.code, our_project_code: one.projectCode, external_code: 'PK-DUP-1' });
      await decide(CHECKER, first.json.id as string, 1, 'APPROVE');
      const taken = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: two.code, our_project_code: two.projectCode, external_code: 'PK-DUP-1' });
      expect([taken.status, taken.json.code, taken.json.reason]).toEqual([409, 'CROSSWALK_DUPLICATE', 'EXTERNAL_CODE_TAKEN']);
      const other = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: one.code, our_project_code: one.projectCode, external_code: 'PK-DUP-2' });
      expect([other.status, other.json.reason]).toEqual([409, 'SUBJECT_HAS_OTHER_CODE']);
      const waiting = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: two.code, our_project_code: two.projectCode, external_code: 'PK-DUP-3' });
      expect(waiting.status).toBe(200);
      expect((await propose(ADMIN, { subject_type: 'PACKAGE', our_code: two.code, our_project_code: two.projectCode, external_code: 'PK-DUP-3' })).json.reason).toBe('ALREADY_PROPOSED');
      expect((await propose(ADMIN, { subject_type: 'PACKAGE', our_code: 'GT-NOWHERE', external_code: 'PK-X' })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await propose(ADMIN, { subject_type: 'CONTRACTOR', our_code: '0101234567', external_code: 'NT-1', match_method: 'NAME_SUGGESTION', confidence: 0.9 })).status).toBe(422);
      expect((await propose(ADMIN, { subject_type: 'PACKAGE', our_code: two.code, external_code: 'PK-Y', valid_from: '2026-12-01', valid_until: '2026-11-01' })).status).toBe(422);
      expect((await propose(CHECKER, { subject_type: 'PACKAGE', our_code: two.code, external_code: 'PK-Z' })).status).toBe(403);
      expect((await propose(UNIT_ADMIN, { subject_type: 'PACKAGE', our_code: two.code, external_code: 'PK-Z' })).json.code).toBe('SCOPE_DENIED');
    });

    it('retires an active mapping with a reason (the row stays as history and the code is free), and rejects a proposal with a reason', async () => {
      const seeded = await seedPackage();
      const first = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: seeded.code, our_project_code: seeded.projectCode, external_code: 'PK-RET-1' });
      const firstId = first.json.id as string;
      const rejected = await decide(CHECKER, firstId, 1, 'REJECT', 'Mã này thuộc gói của kế hoạch khác');
      expect(rejected.json).toMatchObject({ status: 'REJECTED' });
      const second = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: seeded.code, our_project_code: seeded.projectCode, external_code: 'PK-RET-2' });
      const secondId = second.json.id as string;
      await decide(CHECKER, secondId, 1, 'APPROVE');
      const retire = (member: number, version: number | string, reason = 'Thông báo bị hủy trên hệ thống mạng') => call('POST', `/egp/mappings/${secondId}/retire`, { member, ifMatch: `"${version}"`, body: { reason } });
      expect((await retire(READER, 2)).status).toBe(403);
      expect((await retire(ADMIN, 9)).json.code).toBe('VERSION_CONFLICT');
      expect((await retire(ADMIN, 2, 'ngắn')).json.code).toBe('VALIDATION_FAILED');
      const done = await retire(ADMIN, 2);
      expect(done.json).toMatchObject({ status: 'RETIRED', resource_version: 3 });
      const [audit] = await audits(secondId, 'bid.egp_mapping_retired');
      expect(audit).toMatchObject({ reason: 'Thông báo bị hủy trên hệ thống mạng', safe_diff: { status: 'RETIRED', external_code: 'PK-RET-2' } });
      expect((await events(secondId, 'bid.egp.mapping.retired.v1'))[0]?.payload).toMatchObject({ status: 'RETIRED', mapping_id: secondId });
      expect((await retire(ADMIN, 3)).json.code).toBe('EGP_MAPPING_STATE_INVALID');
      const third = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: seeded.code, our_project_code: seeded.projectCode, external_code: 'PK-RET-3' });
      expect(third.status).toBe(200);
      const history = await call('GET', `/egp/mappings?q=${seeded.code}`, { member: READER });
      expect((history.json.items as Array<{ external_code: string; status: string }>).map((item) => [item.external_code, item.status]).sort()).toEqual([['PK-RET-1', 'REJECTED'], ['PK-RET-2', 'RETIRED'], ['PK-RET-3', 'PROPOSED']]);
    });

    it('lists by subject, status and text with counts and a cursor, to a caller with the right on the whole tenant only', async () => {
      const all = await call('GET', '/egp/mappings', { member: READER });
      expect(all.status).toBe(200);
      const counts = all.json.counts as Record<string, number>;
      expect(counts.PROPOSED).toBeGreaterThan(0);
      expect(counts.ACTIVE).toBeGreaterThan(0);
      const active = (await call('GET', '/egp/mappings?status=ACTIVE&subject_type=PACKAGE', { member: READER })).json.items as Array<{ status: string }>;
      expect(active.length).toBeGreaterThan(0);
      expect(active.every((item) => item.status === 'ACTIVE')).toBe(true);
      const page = await call('GET', '/egp/mappings?limit=1', { member: READER });
      expect(typeof page.json.next_cursor).toBe('string');
      expect((await call('GET', `/egp/mappings?limit=1&cursor=${page.json.next_cursor as string}`, { member: READER })).status).toBe(200);
      expect((await call('GET', '/egp/mappings?status=GONE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/egp/mappings?subject_type=PLANET', { member: READER })).status).toBe(422);
      expect((await call('GET', '/egp/mappings', { member: UNIT_ADMIN })).json.code).toBe('SCOPE_DENIED');
      expect((await call('GET', '/egp/mappings', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/egp/mappings', { member: B_ADMIN, tenantId: TENANT_B })).json).toMatchObject({ items: [], counts: { PROPOSED: 0, ACTIVE: 0 } });
    });

    it('suggests a package of ours for a package of the network only at the same price and a like name, with the formula and the source of the number, and stops once it is proposed', async () => {
      const seeded = await seedPackage({ budget: '321000000', title: 'Xay dung truong tieu hoc So 3' });
      const file = await upload(khlcnt('KH-SG,PK-SG-1,Xây dựng trường tiểu học Số 3,321000000,OPEN_BIDDING,2026-10-01,QD,,', 'KH-SG,PK-SG-2,Xay dung truong tieu hoc So 3,321000001,OPEN_BIDDING,2026-10-01,QD,,'));
      expect((await apply(ADMIN, 'KHLCNT', file)).status).toBe(200);
      const found = await call('GET', '/egp/mappings/suggestions', { member: READER });
      expect(found.status).toBe(200);
      expect(found.json).toMatchObject({ threshold: 0.8, legal_status: 'UNVERIFIED' });
      expect(typeof found.json.formula).toBe('string');
      const items = (found.json.items as Array<{ external_code: string; candidates: Array<{ code: string; confidence: number; package_id: string }> }>).filter((item) => item.external_code.startsWith('PK-SG'));
      expect(items.map((item) => item.external_code)).toEqual(['PK-SG-1']);
      expect(items[0]?.candidates[0]).toMatchObject({ code: seeded.code, confidence: 1, package_id: seeded.packageId });
      const confirmed = await propose(ADMIN, { subject_type: 'PACKAGE', our_code: seeded.code, our_project_code: seeded.projectCode, external_code: 'PK-SG-1', match_method: 'NAME_SUGGESTION', confidence: 1 });
      expect(confirmed.json).toMatchObject({ match_method: 'MANUAL', confidence: 1, status: 'PROPOSED' });
      const after = await call('GET', '/egp/mappings/suggestions', { member: READER });
      expect((after.json.items as Array<{ external_code: string }>).filter((item) => item.external_code.startsWith('PK-SG'))).toEqual([]);
      expect((await call('GET', '/egp/mappings/suggestions', { member: UNIT_ADMIN })).json.code).toBe('SCOPE_DENIED');
    });
  });
});
