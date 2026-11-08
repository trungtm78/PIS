import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { ebsModule } from '../../src/editions/enterprise';
import { EbsImportController, EbsReadsController, EbsReconciliationController } from '../../src/editions/enterprise/ebs.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The file import and the reconciliation of Oracle EBS through the application the enterprise edition mounts (ENT-2, R18). The name of this file ends in `.enterprise.test.ts`: it is one of the few sources that may name the
 * enterprise package. The layout of the file is a working assumption, so everything the tests read says PENDING_EXTERNAL.
 */
jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // every EBS permission over the tenant
const RECONCILER = 2; // ebs.read, ebs.reconcile
const PREVIEWER = 3; // ebs.read, ebs.import.preview
const READER = 4; // ebs.read
const UNIT_ADMIN = 5; // every EBS permission over the unit tree of the department only
const NOBODY = 6;
const OWNER = 7; // ebs.read, ebs.reconcile: the person the differences are given to
const B_ADMIN = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x97;
const EBS_ALL = ['ebs.read', 'ebs.admin', 'ebs.import', 'ebs.import.preview', 'ebs.reconcile'];
const HEADER = 'project_code,period,extract_date,disbursed_vnd,committed_vnd';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const hostOf = (args: unknown[]): string | undefined => {
  const first = args[0];
  if (typeof first === 'object' && first !== null) return (first as { host?: string }).host;
  return typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : undefined;
};

describe('the file import and the reconciliation of Oracle EBS (ENT-2, EBS-01, EBS-02)', () => {
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
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string }>('select safe_diff, reason, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

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

  /** A project of ours with the money the Treasury paid and the contracts that commit it. */
  async function seedProject(options: { paid?: string[]; refund?: string; contracts?: string[] } = {}): Promise<{ projectId: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const code = `EBS-P${String(counter).padStart(3, '0')}`;
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Plant project', $4, $5, $6, 'INTERNAL', 1000000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      ],
    ];
    const transaction = (amount: string, at: string, refundOf: string | null, n: string): [string, unknown[]] => [
      `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, reversal_of_id, import_id)
       values ($1, $2, $3, $4, 'TREASURY', $5::numeric, $6::timestamptz, $7, $8, $9, gen_random_uuid())`,
      [TENANT_A, n, projectId, `EXT-${n}`, amount, at, 'd'.repeat(64), refundOf === null ? 'PAYMENT' : 'REFUND', refundOf],
    ];
    const first = randomUUID();
    (options.paid ?? []).forEach((amount, index) => statements.push(transaction(amount, `2026-10-0${index + 1}T08:00:00+07:00`, null, index === 0 ? first : randomUUID())));
    if (options.refund !== undefined) statements.push(transaction(options.refund, '2026-10-20T08:00:00+07:00', first, randomUUID()));
    (options.contracts ?? []).forEach((value, index) => {
      statements.push([
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, false, $7::numeric, $8, $8, date '2026-01-01', date '2026-01-02')`,
        [TENANT_A, randomUUID(), projectId, randomUUID(), randomUUID(), `${code}-C${index + 1}`, value, memberId(ADMIN)],
      ]);
    });
    await seedAsAdmin(statements);
    return { projectId, code };
  }

  /** A file put through the shared pipeline the way the upload door will: the answer names the key and the hash. */
  async function upload(bytes: Uint8Array, tenantId = TENANT_A): Promise<{ key: string; sha: string }> {
    const stored = await files.upload({ tenantId, membershipId: memberId(ADMIN), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const request = (file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ file_object_key: file.key, file_sha256: file.sha, ...extra });
  const preview = (member: number, file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/ebs/imports/preview', { member, body: request(file, extra) });
  const apply = (member: number, file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/ebs/imports', { member, body: request(file, extra) });
  const file = (...lines: string[]): Uint8Array => csv(HEADER, ...lines);
  const reconcile = (member: number, body: Record<string, unknown> = {}, tenantId = TENANT_A): Promise<Reply> => call('POST', '/ebs/reconciliations', { member, tenantId, body });
  const itemsOf = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const resolve = (member: number, itemId: string, version: number | string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/ebs/differences/${itemId}/resolution`, { member, ifMatch: `"${version}"`, body });

  async function uploadDoor(member: number, bytes: Uint8Array, type = 'text/csv'): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'ebs.csv');
    const response = await fetch(`${app.baseUrl}/ebs/imports/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-ebs-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, RECONCILER, PREVIEWER, READER, UNIT_ADMIN, NOBODY, OWNER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'EBS_ADMIN', EBS_ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'EBS_RECONCILER', ['ebs.read', 'ebs.reconcile'], 30);
    await harness.seedRole(TENANT_A, 3, 'EBS_PREVIEWER', ['ebs.read', 'ebs.import.preview'], 30);
    await harness.seedRole(TENANT_A, 4, 'EBS_READER', ['ebs.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'EBS_ADMIN', EBS_ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: RECONCILER, role: 2, kind: 'TENANT' },
      { n: 3, member: PREVIEWER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 6, member: OWNER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    // Tenant A has the published working calendar of three years; tenant B has none.
    const year = new Date().getUTCFullYear();
    await harness.owner(
      TENANT_A,
      [year - 1, year, year + 1].map((value): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, value, memberId(ADMIN)],
      ]),
    );
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [EbsReadsController, EbsImportController, EbsReconciliationController],
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

  it('is a module of the enterprise edition only, with its controllers', () => {
    expect(ebsModule.editions).toEqual(['enterprise']);
    for (const controller of [EbsReadsController, EbsImportController, EbsReconciliationController]) expect(ebsModule.controllers).toContain(controller);
  });

  describe('getEbsConnection (EBS-01)', () => {
    it('shows a tenant that never imported as never imported, on, Draft and PENDING-EXTERNAL, with what the customer owes us and the numbers with their source, writing nothing to show it', async () => {
      const reader = await call('GET', '/ebs/connection', { member: READER });
      expect(reader.status).toBe(200);
      expect(reader.json).toMatchObject({
        connector_code: 'ebs.ledger',
        mode: 'FILE_IMPORT',
        adapter_status: 'PROPOSED',
        registry_status: 'Draft',
        registered: false,
        enabled: true,
        layout_version: 'WORKING-ASSUMPTION-2026.1',
        supported_layouts: ['WORKING-ASSUMPTION-2026.1'],
        acceptance: 'PENDING_EXTERNAL',
        version: 1,
        api_adapter: { status: 'MISSING', reason: 'EBS_ACCESS_PENDING' },
        health: { status: 'NEVER_IMPORTED', age_hours: null, last_import_at: null, alert: null, figures_blocked: false, apply_blocked: false, rule: { source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED', warn_after_hours: 120, max_age_hours: 168, stale_severity: 'WATCH' } },
        columns: ['project_code', 'period', 'extract_date', 'disbursed_vnd', 'committed_vnd'],
        record_counts: { records: 0, projects: 0, periods: 0 },
        item_counts: { open: 0, resolved: 0, overdue: 0, reviews_due: 0 },
        due_rule: { source: 'DEFAULT', unverified: true, due_in_working_days: 5 },
        actions: { may_switch: false, may_preview: false, may_import: false, may_reconcile: false },
      });
      expect((reader.json.pending_external as Array<{ code: string }>).map((item) => item.code)).toEqual(['EBS_EXTRACT']);
      expect((reader.json.positions as Array<{ connector_code: string; cursor_status: string | null }>).map((position) => [position.connector_code, position.cursor_status])).toEqual([['EBS_LEDGER_FILE', null]]);
      expect(await rows('select 1 from machvon.ent_connection')).toHaveLength(0);
      const admin = await call('GET', '/ebs/connection', { member: ADMIN });
      expect(admin.json).toMatchObject({ actions: { may_switch: true, may_preview: true, may_import: true, may_reconcile: true } });
      const unit = await call('GET', '/ebs/connection', { member: UNIT_ADMIN });
      expect(unit.json).toMatchObject({ actions: { may_switch: false, may_preview: true, may_import: false, may_reconcile: false } });
    });

    it('is refused to a member without ebs.read and never shows another tenant', async () => {
      expect((await call('GET', '/ebs/connection', { member: NOBODY })).status).toBe(403);
      expect(await call('GET', '/ebs/connection', { member: B_ADMIN, tenantId: TENANT_B })).toMatchObject({ status: 200, json: { registered: false } });
    });
  });

  describe('uploadEbsFile (EBS-01): the door', () => {
    it('stores a clean file and tells whether it has the columns of the layout, and which it lacks', async () => {
      const good = await uploadDoor(PREVIEWER, file('P1,2026-10,2026-11-02,10,20'));
      expect(good.status).toBe(200);
      expect(good.json).toMatchObject({ format: 'CSV', row_count: 1, matches_layout: true, missing_columns: [] });
      expect(good.json.columns).toEqual(['project_code', 'period', 'extract_date', 'disbursed_vnd', 'committed_vnd']);
      const bad = await uploadDoor(PREVIEWER, csv('project_code,amount', 'P1,5'));
      expect(bad.status).toBe(200);
      expect(bad.json).toMatchObject({ matches_layout: false, missing_columns: ['period', 'extract_date', 'disbursed_vnd', 'committed_vnd'] });
      const empty = await uploadDoor(PREVIEWER, csv(HEADER));
      expect(empty.status).toBe(422);
      expect(empty.json.code).toBe('IMPORT_EMPTY');
    });

    it('refuses an infected file, a file of another type and a caller without the right to preview', async () => {
      expect((await uploadDoor(PREVIEWER, eicarBytes())).status).toBe(422);
      expect((await uploadDoor(PREVIEWER, new TextEncoder().encode('%PDF-1.4'), 'application/pdf')).status).toBe(422);
      expect((await uploadDoor(READER, file('P1,2026-10,2026-11-02,10,20'))).status).toBe(403);
    });
  });

  describe('previewEbsFile and importEbsFile (EBS-01): dry run, then apply', () => {
    it('reads the file as the apply will and writes nothing: valid rows with what the apply would do, the faults row by row, the duplicate and the conflict', async () => {
      const known = await seedProject();
      const bytes = file(`${known.code},2026-10,2026-11-02,1500000.00,9000000`, 'UNKNOWN-1,2026-10,2026-11-02,5,5', `${known.code},2026-13,2026-11-02,1,1`, `${known.code},2026-10,2026-11-02,1500000,9000000`, `${known.code},2026-10,2026-11-02,1,1`);
      const door = await upload(bytes);
      const dry = await preview(PREVIEWER, door);
      expect(dry.status).toBe(200);
      expect(dry.json).toMatchObject({ status: 'DRY_RUN', mode: 'DRY_RUN', layout_version: 'WORKING-ASSUMPTION-2026.1', acceptance: 'PENDING_EXTERNAL', already_applied: false, connection_enabled: true, counts: { total: 5, valid: 2, errors: 3, duplicate: 0, conflict: 0 } });
      const byLine = Object.fromEntries((dry.json.rows as Array<{ line: number; status: string; code: string | null; field: string | null; outcome: string | null }>).map((row) => [row.line, row]));
      expect(byLine[2]).toMatchObject({ status: 'VALID', outcome: 'RECORD' });
      expect(byLine[3]).toMatchObject({ status: 'VALID', outcome: 'RECORD_PROJECT_UNKNOWN' });
      expect(byLine[4]).toMatchObject({ status: 'ERROR', code: 'PERIOD_INVALID', field: 'period' });
      expect(byLine[5]).toMatchObject({ status: 'ERROR', code: 'ROW_DUPLICATE' });
      expect(byLine[6]).toMatchObject({ status: 'ERROR', code: 'ROW_CONFLICT' });
      expect(await rows('select 1 from machvon.ebs_record')).toHaveLength(0);
      expect(await rows('select 1 from machvon.file_import')).toHaveLength(0);
      expect(await rows('select 1 from machvon.ent_connection')).toHaveLength(0);
    });

    it('refuses a layout version it does not read before the file is opened, naming the ones it does', async () => {
      const door = await upload(file('P1,2026-10,2026-11-02,10,20'));
      const refused = await preview(PREVIEWER, door, { mapping_version: 'EBS-2027.1' });
      expect(refused.status).toBe(422);
      expect(refused.json).toMatchObject({ code: 'EBS_LAYOUT_VERSION_UNKNOWN', supported: ['WORKING-ASSUMPTION-2026.1'] });
      expect((await apply(ADMIN, door, { mapping_version: 'EBS-2027.1' })).json.code).toBe('EBS_LAYOUT_VERSION_UNKNOWN');
    });

    it('refuses a file that is not the one whose hash is named, and a file that is not a table of the layout', async () => {
      const door = await upload(file('P1,2026-10,2026-11-02,10,20'));
      expect((await preview(PREVIEWER, { key: door.key, sha: 'a'.repeat(64) })).json.code).toBe('HASH_MISMATCH');
      const lacking = await upload(csv('project_code,period', 'P1,2026-10'));
      const refused = await preview(PREVIEWER, lacking);
      expect(refused.status).toBe(422);
      expect(refused.json.code).toBe('IMPORT_SCHEMA_INVALID');
    });

    it('applies once per hash: keeps what the file said as append-only records, audits and announces it, and refuses the same file again', async () => {
      const known = await seedProject();
      const bytes = file(`${known.code},2026-09,2026-10-02,100,200`, `${known.code},2026-10,2026-11-02,300.50,400`, 'UNKNOWN-2,2026-10,2026-11-02,5,5', `${known.code},2026-10,bad-day,1,1`);
      const door = await upload(bytes);
      const done = await apply(ADMIN, door);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'APPLIED', mode: 'APPLY', acceptance: 'PENDING_EXTERNAL', counts: { total: 4, applied: 3, quarantined: 1 }, unknown_projects: 1 });
      expect((done.json.errors as Array<{ line: number; code: string; field: string }>).map((error) => [error.line, error.code, error.field])).toEqual([[5, 'DATE_INVALID', 'extract_date']]);
      const importId = done.json.resource_id as string;
      const stored = await rows<{ project_code: string; period: string; disbursed_vnd: string; layout_version: string; applied_by: string }>('select project_code, period, disbursed_vnd::text, layout_version, applied_by from machvon.ebs_record where import_id = $1 order by period, project_code', [importId]);
      expect(stored).toHaveLength(3);
      expect(stored.find((row) => row.project_code === 'UNKNOWN-2')).toMatchObject({ layout_version: 'WORKING-ASSUMPTION-2026.1', applied_by: memberId(ADMIN) });
      expect(stored.find((row) => row.period === '2026-10' && row.project_code === known.code)?.disbursed_vnd).toBe('300.50');
      const [audit] = await audits(importId, 'ebs.import_applied');
      expect(audit).toMatchObject({ actor_id: memberId(ADMIN), safe_diff: { connector_code: 'EBS_LEDGER_FILE', acceptance: 'PENDING_EXTERNAL', records_written: 3, unknown_projects: 1, file_sha256: door.sha } });
      const [event] = await events(importId, 'ebs.import.applied.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, import_id: importId, rows_applied: 3, rows_quarantined: 1, unknown_projects: 1, actor_id: memberId(ADMIN) });
      expect(await rows('select 1 from machvon.integration_connector where connector_code = $1', ['ebs.ledger'])).toHaveLength(1);
      expect((await rows<{ status: string; last_file_sha256: string | null }>("select status, last_file_sha256 from machvon.integration_cursor where connector_code = 'EBS_LEDGER_FILE'"))[0]).toMatchObject({ status: 'ACTIVE', last_file_sha256: door.sha });
      const again = await apply(ADMIN, door);
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('IMPORT_FILE_ALREADY_APPLIED');
      const view = await call('GET', '/ebs/connection', { member: READER });
      expect(view.json).toMatchObject({ registered: true, record_counts: { records: expect.any(Number) }, health: { status: 'FRESH' } });
      expect((view.json.last_runs as Array<{ status: string; counts: { applied: number } }>)[0]).toMatchObject({ status: 'APPLIED', counts: { applied: 3 } });
    });

    it('refuses a file none of whose rows can be taken, as a whole, with the line of each fault', async () => {
      const door = await upload(file('P1,2026-99,2026-11-02,10,20', 'P2,2026-10,2026-11-02,abc,1'));
      const refused = await apply(ADMIN, door);
      expect(refused.status).toBe(422);
      expect(refused.json.code).toBe('IMPORT_HAS_ERRORS');
      expect((refused.json.errors as Array<{ line: number; code: string }>).map((error) => [error.line, error.code])).toEqual([[2, 'PERIOD_INVALID'], [3, 'AMOUNT_INVALID']]);
    });

    it('is for the holder of the right on the whole tenant: a previewer and a unit administrator cannot apply', async () => {
      const door = await upload(file('P9,2026-10,2026-11-02,1,1'));
      expect((await apply(PREVIEWER, door)).status).toBe(403);
      expect((await apply(UNIT_ADMIN, door)).status).toBe(403);
      expect((await preview(UNIT_ADMIN, door)).status).toBe(200);
    });
  });

  describe('the state of the connection (EBS-01)', () => {
    it('switches it off and on with a reason, keeps the history, lets the dry run through and refuses the apply while it is off', async () => {
      const version = (await call('GET', '/ebs/connection', { member: ADMIN })).json.version as number;
      for (const member of [RECONCILER, UNIT_ADMIN, READER]) expect((await call('POST', '/ebs/connection/state', { member, ifMatch: `"${version}"`, body: { enabled: false, reason: 'No right to do this at all' } })).status).toBe(403);
      const off = await call('POST', '/ebs/connection/state', { member: ADMIN, ifMatch: `"${version}"`, body: { enabled: false, reason: 'The extract is being redesigned in EBS' } });
      expect(off.status).toBe(200);
      const [audit] = await audits(off.json.resource_id as string, 'ebs.connection_switched');
      expect(audit).toMatchObject({ reason: 'The extract is being redesigned in EBS', safe_diff: { connector_code: 'ebs.ledger', from_enabled: true, to_enabled: false } });
      const door = await upload(file('P10,2026-10,2026-11-03,1,1'));
      expect((await preview(PREVIEWER, door)).json).toMatchObject({ status: 'DRY_RUN', connection_enabled: false });
      const blocked = await apply(ADMIN, door);
      expect(blocked.status).toBe(409);
      expect(blocked.json.code).toBe('EBS_CONNECTION_DISABLED');
      expect((await call('GET', '/ebs/connection', { member: READER })).json).toMatchObject({ enabled: false, health: { apply_blocked: true, alert: null } });
      expect((await call('POST', '/ebs/connection/state', { member: ADMIN, ifMatch: `"${off.json.resource_version as number}"`, body: { enabled: false, reason: 'The extract is being redesigned in EBS' } })).status).toBe(422);
      const on = await call('POST', '/ebs/connection/state', { member: ADMIN, ifMatch: `"${off.json.resource_version as number}"`, body: { enabled: true, reason: 'The new extract is ready and tested' } });
      expect(on.status).toBe(200);
      expect((await apply(ADMIN, door)).status).toBe(200);
    });
  });

  describe('reconcileEbs and the differences (EBS-02)', () => {
    it('compares our figures with the statement by project code, opens an item for each difference with an owner who is not a maker, and says nothing of what agrees', async () => {
      // Ours: 600 paid in October less a refund of 100 (so 500 net) and 9 000 committed by two contracts. EBS says 700 paid and 9 000 committed.
      const project = await seedProject({ paid: ['600', '200'], refund: '100', contracts: ['4000', '5000'] });
      const agreeing = await seedProject({ paid: ['50'], contracts: ['70'] });
      const door = await upload(file(`${project.code},2026-10,2026-11-05,700,9000`, `${agreeing.code},2026-10,2026-11-05,50,70`, 'GHOST-1,2026-10,2026-11-05,25,'));
      expect((await apply(ADMIN, door)).status).toBe(200);
      // The first read of ours by a reader of the log is refused below the tenant; the run is the right of a reconciler.
      expect((await reconcile(READER)).status).toBe(403);
      expect((await reconcile(UNIT_ADMIN)).status).toBe(403);
      const run = await reconcile(RECONCILER, { period: '2026-10', owner_id: memberId(OWNER) });
      expect(run.status).toBe(200);
      expect(run.json).toMatchObject({ status: 'RECONCILED', examined: expect.any(Number), opened: 2, no_owner: 0 });
      const mine = itemsOf(run).filter((item) => item.project_code === project.code);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ measure: 'DISBURSED_VND', difference_kind: 'AMOUNT_MISMATCH', ours: '600', theirs: '700', delta: '100', state: 'OPEN', owner_id: memberId(OWNER), acceptance: 'PENDING_EXTERNAL', overdue: false });
      // The committed figure agrees to the dong, so no item is opened for it; a project we do not hold has the statement of EBS as a missing figure of ours.
      expect(itemsOf(run).filter((item) => item.project_code === agreeing.code)).toHaveLength(0);
      const ghost = itemsOf(run).filter((item) => item.project_code === 'GHOST-1');
      expect(ghost.map((item) => [item.measure, item.difference_kind, item.ours, item.theirs, item.project_id])).toEqual([['DISBURSED_VND', 'MISSING_OURS', null, '25', null]]);
      const item = mine[0] as Record<string, unknown>;
      // The owner is not one of the people who loaded the file or ran the comparison.
      const stored = await rows<{ owner_id: string; maker_ids: string[]; due_at: string }>('select owner_id, maker_ids, due_at::text from machvon.ebs_reconciliation_item where id = $1', [item.id]);
      expect(stored[0]?.maker_ids.sort()).toEqual([memberId(ADMIN), memberId(RECONCILER)].sort());
      expect(stored[0]?.maker_ids).not.toContain(stored[0]?.owner_id);
      expect(Date.parse(stored[0]?.due_at ?? '')).toBeGreaterThan(Date.now());
      const [audit] = await audits(item.id as string, 'ebs.reconciliation_run');
      expect(audit).toBeUndefined();
      const [runAudit] = await audits(TENANT_A, 'ebs.reconciliation_run');
      expect(runAudit).toMatchObject({ actor_id: memberId(RECONCILER), safe_diff: { period: '2026-10', opened: 2 } });
      expect(await events(item.id as string, 'ebs.reconciliation.run.v1')).toHaveLength(1);
      // The same figures again open nothing new.
      const again = await reconcile(RECONCILER, { period: '2026-10', owner_id: memberId(OWNER) });
      expect(again.json).toMatchObject({ opened: 0, unchanged: 2, refreshed: 0 });
      expect(await rows("select 1 from machvon.ebs_reconciliation_item where project_code = $1 and state = 'OPEN'", [project.code])).toHaveLength(1);
    });

    it('gives the items to the first holder of the right who is not a maker when the person asked for is one', async () => {
      const project = await seedProject({ paid: ['10'], contracts: ['20'] });
      const door = await upload(file(`${project.code},2026-08,2026-09-03,11,20`));
      expect((await apply(ADMIN, door)).status).toBe(200);
      const run = await reconcile(RECONCILER, { period: '2026-08', owner_id: memberId(RECONCILER) });
      expect(run.status).toBe(200);
      expect(run.json).toMatchObject({ opened: 1, no_owner: 0 });
      expect(itemsOf(run)[0]).toMatchObject({ owner_id: memberId(OWNER) });
    });

    it('lists the differences by due time with their owner, the filters and the counts, and only to a grant on the whole tenant', async () => {
      const listed = await call('GET', '/ebs/differences?state=OPEN', { member: ADMIN });
      expect(listed.status).toBe(200);
      const items = listed.json.items as Array<{ due_at: string; project_code: string; owner_name: string | null }>;
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items.map((item) => item.due_at)).toEqual([...items.map((item) => item.due_at)].sort());
      expect(listed.json.counts).toMatchObject({ open: items.length, resolved: 0, overdue: 0 });
      const ghost = await call('GET', '/ebs/differences?project_code=GHOST-1&period=2026-10', { member: READER });
      expect((ghost.json.items as unknown[]).length).toBe(1);
      const mine = await call('GET', `/ebs/differences?owner_id=${memberId(OWNER)}`, { member: ADMIN });
      expect((mine.json.items as Array<{ owner_id: string }>).every((item) => item.owner_id === memberId(OWNER))).toBe(true);
      const paged = await call('GET', '/ebs/differences?limit=2', { member: ADMIN });
      expect((paged.json.items as unknown[]).length).toBe(2);
      expect(paged.json.next_cursor).not.toBeNull();
      expect((await call('GET', `/ebs/differences?limit=2&cursor=${paged.json.next_cursor as string}`, { member: ADMIN })).status).toBe(200);
      for (const query of ['state=NOPE', 'owner_id=nope', 'period=2026-M10', 'overdue=maybe', 'limit=0']) expect((await call('GET', `/ebs/differences?${query}`, { member: ADMIN })).status).toBe(422);
      expect((await call('GET', '/ebs/differences', { member: UNIT_ADMIN })).status).toBe(403);
      expect((await call('GET', '/ebs/differences', { member: NOBODY })).status).toBe(403);
    });

    it('is explained and closed by its owner and nobody else: not by a maker, not by another reconciler, with the evidence or the day each kind needs', async () => {
      const [target] = (await call('GET', '/ebs/differences?project_code=GHOST-1', { member: ADMIN })).json.items as Array<{ id: string; version: number }>;
      const id_ = (target as { id: string }).id;
      const version = (target as { version: number }).version;
      // The administrator made the figures: not the owner, so the answer is a refusal of scope.
      expect((await resolve(ADMIN, id_, version, { kind: 'WAIVED', reason: 'We accept the difference of this ghost', review_on: '2999-01-01' })).status).toBe(403);
      expect((await resolve(RECONCILER, id_, version, { kind: 'EBS_WRONG', reason: 'EBS booked it on the wrong project', evidence_ref: 'TICKET-1' })).status).toBe(403);
      expect((await resolve(OWNER, id_, 99, { kind: 'EBS_WRONG', reason: 'EBS booked it on the wrong project', evidence_ref: 'TICKET-1' })).json.code).toBe('VERSION_CONFLICT');
      expect((await resolve(OWNER, id_, version, { kind: 'EBS_WRONG', reason: 'short' })).status).toBe(422);
      expect((await resolve(OWNER, id_, version, { kind: 'EBS_WRONG', reason: 'EBS booked it on the wrong project' })).status).toBe(422);
      expect((await resolve(OWNER, id_, version, { kind: 'TIMING', reason: 'The payment will be booked next month' })).status).toBe(422);
      expect((await resolve(OWNER, id_, version, { kind: 'TIMING', reason: 'The payment will be booked next month', review_on: '2000-01-01' })).status).toBe(422);
      const tomorrow = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      const done = await resolve(OWNER, id_, version, { kind: 'TIMING', reason: 'The payment will be booked next month', review_on: tomorrow });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'RESOLVED', resource_id: id_ });
      const [audit] = await audits(id_, 'ebs.difference_resolved');
      expect(audit).toMatchObject({ actor_id: memberId(OWNER), reason: 'The payment will be booked next month', safe_diff: { resolution_kind: 'TIMING', review_on: tomorrow, state: 'RESOLVED' } });
      expect(await events(id_, 'ebs.difference.resolved.v1')).toHaveLength(1);
      const stored = await call('GET', '/ebs/differences?state=RESOLVED', { member: ADMIN });
      expect((stored.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ state: 'RESOLVED', resolution: { kind: 'TIMING', resolved_by: memberId(OWNER), review_on: tomorrow }, actions: { may_resolve: false } });
      // A settled item is final; the same figures do not open it again.
      expect((await resolve(OWNER, id_, (done.json.resource_version as number) + 0, { kind: 'WAIVED', reason: 'Settled once is settled', review_on: tomorrow })).json.code).toBe('EBS_ITEM_STATE_INVALID');
      const rerun = await reconcile(RECONCILER, { period: '2026-10', owner_id: memberId(OWNER) });
      expect(rerun.json).toMatchObject({ opened: 0, settled_already: 1 });
    });

    it('hands an item to another person who is not a maker, keeping its due time, and refuses to hand it to a maker', async () => {
      const [target] = (await call('GET', '/ebs/differences?state=OPEN&limit=1', { member: ADMIN })).json.items as Array<{ id: string; version: number; due_at: string; owner_id: string }>;
      const row = target as { id: string; version: number; due_at: string; owner_id: string };
      const toMaker = await call('POST', `/ebs/differences/${row.id}/owner`, { member: ADMIN, ifMatch: `"${row.version}"`, body: { owner_id: memberId(ADMIN) } });
      expect(toMaker.status).toBe(403);
      expect(toMaker.json.code).toBe('SELF_APPROVAL_DENIED');
      const stranger = await call('POST', `/ebs/differences/${row.id}/owner`, { member: ADMIN, ifMatch: `"${row.version}"`, body: { owner_id: memberId(NOBODY) } });
      expect(stranger.status).toBe(200);
      const handed = await call('POST', `/ebs/differences/${row.id}/owner`, { member: RECONCILER, ifMatch: `"${stranger.json.resource_version as number}"`, body: { owner_id: memberId(READER) } });
      expect(handed.status).toBe(200);
      const after = await call('GET', `/ebs/differences?owner_id=${memberId(READER)}`, { member: ADMIN });
      expect((after.json.items as Array<{ due_at: string }>)[0]?.due_at).toBe(row.due_at);
      expect((await call('POST', `/ebs/differences/${row.id}/owner`, { member: PREVIEWER, ifMatch: `"1"`, body: { owner_id: memberId(OWNER) } })).status).toBe(403);
    });

    it('refreshes an open item when a later extract moves a figure, and opens another when a settled difference reaches the day it is looked at again', async () => {
      const project = await seedProject({ paid: ['1000'] });
      const first = await upload(file(`${project.code},2026-07,2026-08-02,1200,`));
      expect((await apply(ADMIN, first)).status).toBe(200);
      const opened = await reconcile(RECONCILER, { period: '2026-07', owner_id: memberId(OWNER) });
      const item = itemsOf(opened).find((candidate) => candidate.project_code === project.code) as Record<string, unknown>;
      expect(item).toMatchObject({ delta: '200', theirs: '1200' });
      const second = await upload(file(`${project.code},2026-07,2026-08-09,1300,`));
      expect((await apply(ADMIN, second)).status).toBe(200);
      const refreshed = await reconcile(RECONCILER, { period: '2026-07', owner_id: memberId(OWNER) });
      expect(refreshed.json).toMatchObject({ opened: 0, refreshed: 1 });
      const now = await call('GET', `/ebs/differences?project_code=${project.code}`, { member: ADMIN });
      expect(now.json.items as unknown[]).toHaveLength(1);
      expect((now.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: item.id, theirs: '1300', delta: '300' });
    });

    it('needs the published calendar to give the items a due time, and a period written as YYYY-MM', async () => {
      expect((await reconcile(B_ADMIN, {}, TENANT_B)).status).toBe(422);
      expect((await reconcile(RECONCILER, { period: '2026-M10' })).status).toBe(422);
    });
  });

  describe('another tenant (isolation)', () => {
    it('answers 404 to a member of tenant B for a difference of tenant A, as for an id that does not exist, and shows no foreign data', async () => {
      const [target] = (await call('GET', '/ebs/differences?state=OPEN&limit=1', { member: ADMIN })).json.items as Array<{ id: string }>;
      const foreignId = (target as { id: string }).id;
      for (const path of [`/ebs/differences/${foreignId}/resolution`, `/ebs/differences/${foreignId}/owner`]) {
        const foreign = await call('POST', path, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: path.endsWith('owner') ? { owner_id: memberId(B_ADMIN) } : { kind: 'WAIVED', reason: 'A foreign attempt to settle', review_on: '2999-01-01' } });
        const missing = await call('POST', path.replace(foreignId, randomUUID()), { member: B_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: path.endsWith('owner') ? { owner_id: memberId(B_ADMIN) } : { kind: 'WAIVED', reason: 'A foreign attempt to settle', review_on: '2999-01-01' } });
        expect(foreign.status).toBe(404);
        expect({ ...foreign.json, correlationId: 'x', correlation_id: 'x' }).toEqual({ ...missing.json, correlationId: 'x', correlation_id: 'x' });
      }
      const listed = await call('GET', '/ebs/differences', { member: B_ADMIN, tenantId: TENANT_B });
      expect(listed.json.items).toEqual([]);
      expect(JSON.stringify(listed.json)).not.toContain(foreignId);
      // A file of tenant A in the object store is not found for tenant B.
      const door = await upload(file('P1,2026-10,2026-11-02,1,1'));
      expect((await call('POST', '/ebs/imports/preview', { member: B_ADMIN, tenantId: TENANT_B, body: request(door) })).status).toBe(404);
    });
  });

  describe('no call goes to Oracle EBS', () => {
    it('opens no connection but the ones to this test server through a dry run, an apply and a reconciliation', async () => {
      const targets: string[] = [];
      const original = net.Socket.prototype.connect;
      const spy = jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
        targets.push(hostOf(args) ?? 'unix');
        return (original as (...parameters: unknown[]) => net.Socket).apply(this, args);
      });
      try {
        const project = await seedProject({ paid: ['5'] });
        const door = await upload(file(`${project.code},2026-06,2026-07-02,6,`));
        await preview(PREVIEWER, door);
        await apply(ADMIN, door);
        await reconcile(RECONCILER, { period: '2026-06', owner_id: memberId(OWNER) });
      } finally {
        spy.mockRestore();
      }
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) expect(['127.0.0.1', 'localhost', '::1']).toContain(target);
    });
  });

  describe('the database holds the rules too', () => {
    it('refuses what the commands refuse: a record that is changed or deleted, an item given to or settled by one of its makers, a settled item changed, an item without its evidence', async () => {
      const attempt = (sql: string, params: unknown[] = []): Promise<unknown> => rows(sql, params);
      await expect(attempt('update machvon.ebs_record set disbursed_vnd = 1')).rejects.toThrow();
      await expect(attempt('delete from machvon.ebs_record')).rejects.toThrow();
      await expect(attempt('update machvon.ebs_reconciliation_item set owner_id = maker_ids[1] where state = $1', ['OPEN'])).rejects.toThrow();
      await expect(attempt(`update machvon.ebs_reconciliation_item set state = 'RESOLVED', resolution_kind = 'EBS_WRONG', resolved_by = maker_ids[1], resolved_at = now(), reason = 'Settled by a maker of the figures', evidence_ref = 'X' where state = 'OPEN'`)).rejects.toThrow();
      await expect(attempt(`update machvon.ebs_reconciliation_item set state = 'RESOLVED', resolution_kind = 'EBS_WRONG', resolved_by = owner_id, resolved_at = now(), reason = 'No evidence is given here at all' where state = 'OPEN'`)).rejects.toThrow();
      await expect(attempt(`update machvon.ebs_reconciliation_item set project_code = 'OTHER' where true`)).rejects.toThrow();
      await expect(attempt(`update machvon.ebs_reconciliation_item set theirs = theirs + 1 where state = 'RESOLVED'`)).rejects.toThrow();
    });
  });
});
