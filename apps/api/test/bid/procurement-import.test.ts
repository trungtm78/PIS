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
import { bidModule } from '../../src/modules/bid';
import { MilestoneController, MilestoneReadsController } from '../../src/modules/bid/milestone.controller';
import { ProcurementImportController } from '../../src/modules/bid/procurement-import.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PLANNER = 1; // bid.plan.manage, bid.import, bid.read over the tenant
const DEPARTMENT_PLANNER = 2; // the same over the unit tree of the department only
const ELSEWHERE_PLANNER = 3; // the same over another branch
const READER = 4; // bid.read over the tenant
const NOBODY = 5;
const B_PLANNER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x96;
const HEADER = 'package_code,external_code,milestone_kind,actual_at';
const PAST = '2026-09-01T03:00:00Z';

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
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode([HEADER, ...lines].join('\n'));

describe('the milestones of a package and the file of the national bidding system (ST-BID-005)', () => {
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
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string }>('select safe_diff, outcome, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  async function seedPackage(options: { status?: string; unit?: number; tenant?: string } = {}): Promise<{ projectId: string; packageId: string; code: string }> {
    const tenant = options.tenant ?? TENANT_A;
    counter += 1;
    const projectId = randomUUID();
    const packageId = randomUUID();
    const code = `GT-${String(counter).padStart(4, '0')}`;
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Procurement project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [tenant, projectId, `PRJ-${counter}-${projectId.slice(0, 4)}`, unitId(options.unit ?? DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      );
      await client.query(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
         values ($1, $2, $3, $4, 1000, 'OPEN_BIDDING', 1, $5, 'Construction package', $6, 1)`,
        [tenant, packageId, projectId, code, options.status ?? 'PLANNED', memberId(PLANNER)],
      );
    } finally {
      await client.end();
    }
    return { projectId, packageId, code };
  }

  const record = (member: number, packageId: string, version: number | string, body: Record<string, unknown>, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', `/procurement-packages/${packageId}/milestones`, { member, ifMatch: `"${version}"`, body, ...extra });

  /** A file put through the shared pipeline the way the upload door will: the answer names the key and the hash. */
  async function upload(bytes: Uint8Array, tenantId = TENANT_A): Promise<{ key: string; sha: string }> {
    const stored = await files.upload({ tenantId, membershipId: memberId(PLANNER), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const importFile = (member: number, file: { key: string; sha: string }, mode: 'DRY_RUN' | 'APPLY', options: { mapping?: string; sha?: string; key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/procurement-imports', {
      member,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      ...(options.key === undefined ? {} : { key: options.key }),
      body: { file_object_key: file.key, file_sha256: options.sha ?? file.sha, mode, ...(options.mapping === undefined ? {} : { mapping_version: options.mapping }) },
    });

  async function uploadDoor(member: number, bytes: Uint8Array, type = 'text/csv'): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'export.csv');
    const response = await fetch(`${app.baseUrl}/procurement-imports/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const milestoneRows = (packageId: string) =>
    rows<{ milestone_kind: string; source: string; import_batch_id: string | null }>('select milestone_kind, source, import_batch_id from machvon.procurement_milestone where package_id = $1::uuid order by milestone_kind', [packageId]);
  const batchRows = (sha: string) => rows<{ status: string; mode: string; rows_total: number; rows_ok: number; rows_error: number }>('select status, mode, rows_total, rows_ok, rows_error from machvon.procurement_import_batch where file_sha256 = $1', [sha]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-bid-import-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [PLANNER, DEPARTMENT_PLANNER, ELSEWHERE_PLANNER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_PLANNER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BID_PLANNER', ['bid.plan.manage', 'bid.import', 'bid.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'BID_READER', ['bid.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'BID_PLANNER', ['bid.plan.manage', 'bid.import', 'bid.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PLANNER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: ELSEWHERE_PLANNER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: READER, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_PLANNER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MilestoneController, MilestoneReadsController, ProcurementImportController],
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
    for (const controller of [MilestoneController, MilestoneReadsController, ProcurementImportController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('recordProcurementMilestone', () => {
    it('records the dates of a milestone for the planner of the project, audits it and tells the world with ids and dates only', async () => {
      const seeded = await seedPackage();
      const done = await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_OPENING', planned_at: '2026-09-10T03:00:00Z', actual_at: PAST });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'BID_OPENING', resource_version: 2, resource_id: seeded.packageId });
      const [audit] = await audits(seeded.packageId, 'bid.milestone_recorded');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PLANNER), safe_diff: { package_code: seeded.code, milestone_kind: 'BID_OPENING', source: 'MANUAL', previous: null, settled_difference: false } });
      const [event] = await events(seeded.packageId, 'bid.milestone.recorded.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, package_id: seeded.packageId, project_id: seeded.projectId, milestone_kind: 'BID_OPENING', source: 'MANUAL', version: 2, actor_id: memberId(PLANNER) });
      expect(await milestoneRows(seeded.packageId)).toEqual([{ milestone_kind: 'BID_OPENING', source: 'MANUAL', import_batch_id: null }]);
    });

    it('answers a repeated request with the first answer and records once', async () => {
      const seeded = await seedPackage();
      const key = `key-${randomUUID()}`;
      const first = await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_CLOSING', actual_at: PAST }, { key });
      const second = await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_CLOSING', actual_at: PAST }, { key });
      expect(second.status).toBe(200);
      expect(second.json).toEqual(first.json);
      expect(await events(seeded.packageId, 'bid.milestone.recorded.v1')).toHaveLength(1);
    });

    it('refuses a stale version with 409 VERSION_CONFLICT, a date out of order with 409 MILESTONE_ORDER_INVALID, and a package not in force with 409 PACKAGE_STATE_INVALID', async () => {
      const seeded = await seedPackage();
      await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_OPENING', actual_at: PAST });
      const stale = await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'EVALUATION_DONE', actual_at: PAST });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const order = await record(PLANNER, seeded.packageId, 2, { milestone_kind: 'INVITATION_PUBLISHED', actual_at: '2026-09-20T03:00:00Z' });
      expect([order.status, order.json.code]).toEqual([409, 'MILESTONE_ORDER_INVALID']);
      expect(order.json).toMatchObject({ earlier_kind: 'INVITATION_PUBLISHED', later_kind: 'BID_OPENING', field: 'actual_at' });
      const draft = await seedPackage({ status: 'DRAFT' });
      const state = await record(PLANNER, draft.packageId, 1, { milestone_kind: 'BID_OPENING', actual_at: PAST });
      expect([state.status, state.json.code]).toEqual([409, 'PACKAGE_STATE_INVALID']);
      expect(await milestoneRows(draft.packageId)).toEqual([]);
    });

    it('refuses a body that is not valid with 422 and a member the contract does not name with 400', async () => {
      const seeded = await seedPackage();
      for (const body of [{ milestone_kind: 'BID_OPENING' }, { milestone_kind: 'BID_OPENING', actual_at: '2026-09-10' }, { milestone_kind: 'BID_OPENING', actual_at: '2099-01-01T00:00:00Z' }]) {
        const refused = await record(PLANNER, seeded.packageId, 1, body);
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const extra = await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_OPENING', actual_at: PAST, source: 'IMPORT' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const unknownKind = await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'SIGNING', actual_at: PAST });
      expect([unknownKind.status, unknownKind.json.code, unknownKind.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'milestone_kind']);
    });

    it('lets the unit tree of the project in, turns the other branch and the package of another tenant away as if it did not exist, and refuses a reader with 403', async () => {
      const seeded = await seedPackage();
      expect((await record(DEPARTMENT_PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_CLOSING', actual_at: PAST })).status).toBe(200);
      expect((await record(ELSEWHERE_PLANNER, seeded.packageId, 2, { milestone_kind: 'BID_OPENING', actual_at: PAST })).status).toBe(404);
      expect((await record(READER, seeded.packageId, 2, { milestone_kind: 'BID_OPENING', actual_at: PAST })).status).toBe(403);
      expect((await record(NOBODY, seeded.packageId, 2, { milestone_kind: 'BID_OPENING', actual_at: PAST })).status).toBe(403);
      expect((await record(B_PLANNER, seeded.packageId, 2, { milestone_kind: 'BID_OPENING', actual_at: PAST }, { tenantId: TENANT_B })).status).toBe(404);
      expect((await record(PLANNER, randomUUID(), 1, { milestone_kind: 'BID_OPENING', actual_at: PAST })).status).toBe(404);
    });
  });

  describe('importProcurementFile (AC-ST-BID-005-1, UAT-AC454)', () => {
    it('AC-ST-BID-005-1, UAT-AC454: a dry run says rows_ok=2 rows_error=1 PACKAGE_NOT_FOUND and writes nothing; the apply writes 2 IMPORT milestones with IN_SYNC links; the same file again is 409 IMPORT_FILE_ALREADY_APPLIED; no connection leaves the machine', async () => {
      const one = await seedPackage();
      const two = await seedPackage();
      const file = await upload(csv(`${one.code},TBMT-${one.code},BID_OPENING,2026-09-01`, `${two.code},TBMT-${two.code},RESULT_PUBLISHED,2026-09-15`, 'GT-NOT-THERE,TBMT-X,BID_OPENING,2026-09-01'));
      // Every connection the process opens while the commands run is recorded: the national bidding system has no client in the product, so none may leave this machine.
      const connect = jest.spyOn(net.Socket.prototype, 'connect');
      const seen: unknown[][] = [];
      try {
        const dry = await importFile(PLANNER, file, 'DRY_RUN');
        expect(dry.status).toBe(200);
        expect(dry.json).toMatchObject({ status: 'DRY_RUN', mode: 'DRY_RUN', rows_total: 3, rows_ok: 2, rows_error: 1, already_applied: false, adapter: { connector_code: 'PROCUREMENT_FILE', status: 'PROPOSED' } });
        const dryRows = dry.json.rows as Array<Record<string, unknown>>;
        expect(dryRows.map((row) => [row.line, row.status, row.code ?? row.outcome])).toEqual([
          [2, 'VALID', 'CREATE'],
          [3, 'VALID', 'CREATE'],
          [4, 'ERROR', 'PACKAGE_NOT_FOUND'],
        ]);
        expect(await batchRows(file.sha)).toEqual([]);
        expect(await milestoneRows(one.packageId)).toEqual([]);

        const applied = await importFile(PLANNER, file, 'APPLY');
        expect(applied.status).toBe(200);
        expect(applied.json).toMatchObject({ status: 'APPLIED', mode: 'APPLY', rows_total: 3, rows_ok: 2, rows_error: 1, milestones_written: 2, adapter: { status: 'PROPOSED' } });
        expect((applied.json.errors as Array<Record<string, unknown>>).map((error) => [error.line, error.code])).toEqual([[4, 'PACKAGE_NOT_FOUND']]);
        const batchId = applied.json.resource_id as string;
        expect(await milestoneRows(one.packageId)).toEqual([{ milestone_kind: 'BID_OPENING', source: 'IMPORT', import_batch_id: batchId }]);
        expect(await milestoneRows(two.packageId)).toEqual([{ milestone_kind: 'RESULT_PUBLISHED', source: 'IMPORT', import_batch_id: batchId }]);
        expect(await batchRows(file.sha)).toEqual([{ status: 'APPLIED', mode: 'APPLY', rows_total: 3, rows_ok: 2, rows_error: 1 }]);
        const links = await call('GET', `/procurement-external-links?project_id=${one.projectId}`, { member: PLANNER });
        expect(links.status).toBe(200);
        expect((links.json.items as Array<Record<string, unknown>>).map((link) => [link.package_code, link.external_code, link.diff_status])).toEqual([[one.code, `TBMT-${one.code}`, 'IN_SYNC']]);
        expect((links.json.items as Array<{ batch: Record<string, unknown> }>)[0]?.batch).toMatchObject({ id: batchId, adapter_status: 'PROPOSED', file_sha256: file.sha });

        const again = await importFile(PLANNER, file, 'APPLY');
        expect([again.status, again.json.code]).toEqual([409, 'IMPORT_FILE_ALREADY_APPLIED']);
        expect((await importFile(PLANNER, file, 'DRY_RUN')).json).toMatchObject({ already_applied: true });
        expect(await milestoneRows(one.packageId)).toHaveLength(1);
        expect(await batchRows(file.sha)).toHaveLength(1);

        // Audit, event of the batch and one event for each milestone the file wrote.
        const [audit] = await audits(batchId, 'bid.procurement_import_applied');
        expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PLANNER), safe_diff: { connector_code: 'PROCUREMENT_FILE', adapter_status: 'PROPOSED', file_sha256: file.sha, milestones_written: 2 } });
        const [event] = await events(batchId, 'bid.import.applied.v1');
        expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, batch_id: batchId, file_sha256: file.sha, adapter_status: 'PROPOSED', rows_total: 3, rows_ok: 2, rows_error: 1 });
        expect((await events(one.packageId, 'bid.milestone.recorded.v1'))[0]?.payload).toMatchObject({ milestone_kind: 'BID_OPENING', source: 'IMPORT', package_id: one.packageId });
      } finally {
        seen.push(...(connect.mock.calls as unknown[][]));
        connect.mockRestore();
      }
      const outgoing = seen.map(hostOf).filter((host): host is string => host !== undefined);
      expect(seen.length).toBeGreaterThan(0);
      expect(outgoing.filter((host) => !['127.0.0.1', '::1', 'localhost'].includes(host))).toEqual([]);
    });

    it('lets the planner of a unit tree dry-run the file for the packages of their units, turns the apply away with 403 SCOPE_DENIED, and shows the packages of other branches as not found', async () => {
      const mine = await seedPackage();
      const other = await seedPackage({ unit: ELSEWHERE });
      const file = await upload(csv(`${mine.code},TBMT-A-${mine.code},BID_OPENING,2026-09-01`, `${other.code},TBMT-B-${other.code},BID_OPENING,2026-09-01`));
      const dry = await importFile(DEPARTMENT_PLANNER, file, 'DRY_RUN');
      expect(dry.status).toBe(200);
      expect((dry.json.rows as Array<Record<string, unknown>>).map((row) => row.code ?? row.outcome)).toEqual(['CREATE', 'PACKAGE_NOT_FOUND']);
      const apply = await importFile(DEPARTMENT_PLANNER, file, 'APPLY');
      expect([apply.status, apply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await milestoneRows(mine.packageId)).toEqual([]);
      expect((await importFile(READER, file, 'DRY_RUN')).status).toBe(403);
      expect((await importFile(NOBODY, file, 'APPLY')).status).toBe(403);
    });

    it('keeps a date the planner recorded and opens a difference with an owner; settling it by hand puts the link in step', async () => {
      const seeded = await seedPackage();
      const recorded = await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_OPENING', actual_at: '2026-09-01T02:00:00Z' });
      expect(recorded.status).toBe(200);
      const file = await upload(csv(`${seeded.code},TBMT-${seeded.code},BID_OPENING,2026-09-05`));
      const applied = await importFile(PLANNER, file, 'APPLY');
      expect(applied.json).toMatchObject({ status: 'APPLIED', milestones_written: 0, counts: { differencesOpened: 1 } });
      const links = (await call('GET', `/procurement-external-links?project_id=${seeded.projectId}&diff_status=DIFFERENT`, { member: READER })).json.items as Array<Record<string, unknown>>;
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ diff_status: 'DIFFERENT', diff: { milestones: { BID_OPENING: { register: '2026-09-01T02:00:00.000Z', file: '2026-09-04T17:00:00.000Z' } } } });
      expect((links[0]?.diff_owner as Record<string, unknown>).membership_id).toBe(memberId(PLANNER));
      const settled = await record(PLANNER, seeded.packageId, 2, { milestone_kind: 'BID_OPENING', actual_at: '2026-09-05T03:00:00Z' });
      expect(settled.status).toBe(200);
      expect((await audits(seeded.packageId, 'bid.milestone_recorded')).some((audit) => audit.safe_diff.settled_difference === true)).toBe(true);
      expect(((await call('GET', `/procurement-external-links?project_id=${seeded.projectId}&diff_status=DIFFERENT`, { member: READER })).json.items as unknown[]).length).toBe(0);
    });

    it('refuses what cannot be read before it writes anything: a hash that is not the file, another layout, a file without the columns and a file none of whose rows can be taken', async () => {
      const seeded = await seedPackage();
      const file = await upload(csv(`${seeded.code},TBMT-${seeded.code},BID_OPENING,2026-09-01`));
      const mismatch = await importFile(PLANNER, file, 'DRY_RUN', { sha: 'a'.repeat(64) });
      expect([mismatch.status, mismatch.json.code]).toEqual([422, 'HASH_MISMATCH']);
      const layout = await importFile(PLANNER, file, 'DRY_RUN', { mapping: 'OTHER-1' });
      expect([layout.status, layout.json.code, layout.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'mapping_version']);
      const unreadable = await upload(new TextEncoder().encode('name,code\nA,1'));
      const schema = await importFile(PLANNER, unreadable, 'APPLY');
      expect([schema.status, schema.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
      const hopeless = await upload(csv('GT-NOBODY,TBMT-N,BID_OPENING,2026-09-01', `${seeded.code},TBMT-N2,SIGNING,2026-09-01`));
      const refused = await importFile(PLANNER, hopeless, 'APPLY');
      expect([refused.status, refused.json.code]).toEqual([422, 'IMPORT_HAS_ERRORS']);
      expect((refused.json.errors as Array<Record<string, unknown>>).map((error) => [error.line, error.code])).toEqual([
        [2, 'PACKAGE_NOT_FOUND'],
        [3, 'MILESTONE_KIND_INVALID'],
      ]);
      expect(await batchRows(hopeless.sha)).toEqual([]);
      // The file of another tenant is not found by its key.
      const foreign = await importFile(B_PLANNER, file, 'DRY_RUN', { tenantId: TENANT_B });
      expect(foreign.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('uploadProcurementFile', () => {
    it('stores a clean file with the layout of the adapter and answers its columns and rows', async () => {
      const seeded = await seedPackage();
      const bytes = csv(`${seeded.code},TBMT-${seeded.code},BID_OPENING,2026-09-01`);
      const done = await uploadDoor(PLANNER, bytes);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ file_sha256: shaOf(bytes), size_bytes: bytes.length, format: 'CSV', columns: HEADER.split(','), row_count: 1 });
      expect(String(done.json.file_object_key)).toContain(TENANT_A);
      expect(await audits(TENANT_A, 'bid.procurement_file_uploaded')).not.toHaveLength(0);
    });

    it('refuses a file with a virus with 422 FILE_NOT_CLEAN and one without the columns with 422 IMPORT_SCHEMA_INVALID, and a reader with 403', async () => {
      const infected = await uploadDoor(PLANNER, eicarBytes());
      expect([infected.status, infected.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
      const schema = await uploadDoor(PLANNER, new TextEncoder().encode('name,code\nA,1'));
      expect([schema.status, schema.json.code]).toEqual([422, 'IMPORT_SCHEMA_INVALID']);
      expect((await uploadDoor(READER, csv('GT-1,T-1,BID_OPENING,2026-09-01'))).status).toBe(403);
    });
  });

  describe('listProcurementMilestones and listProcurementExternalLinks', () => {
    it('list the milestones and the links of the packages in the scope of the reader, by package and the order of the milestones', async () => {
      const seeded = await seedPackage();
      await record(PLANNER, seeded.packageId, 1, { milestone_kind: 'BID_OPENING', actual_at: PAST });
      await record(PLANNER, seeded.packageId, 2, { milestone_kind: 'INVITATION_PUBLISHED', actual_at: '2026-08-01T00:00:00Z' });
      const all = await call('GET', `/procurement-milestones?package_id=${seeded.packageId}`, { member: READER });
      expect(all.status).toBe(200);
      expect((all.json.items as Array<Record<string, unknown>>).map((item) => [item.milestone_kind, item.source, item.actual_at])).toEqual([
        ['INVITATION_PUBLISHED', 'MANUAL', '2026-08-01T00:00:00.000Z'],
        ['BID_OPENING', 'MANUAL', '2026-09-01T03:00:00.000Z'],
      ]);
      expect(typeof all.json.as_of).toBe('string');
      expect(((await call('GET', `/procurement-milestones?project_id=${seeded.projectId}`, { member: DEPARTMENT_PLANNER })).json.items as unknown[]).length).toBe(2);
      expect(((await call('GET', `/procurement-milestones?project_id=${seeded.projectId}`, { member: ELSEWHERE_PLANNER })).json.items as unknown[]).length).toBe(0);
      expect(((await call('GET', `/procurement-milestones?project_id=${seeded.projectId}`, { member: B_PLANNER, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
      expect((await call('GET', '/procurement-milestones', { member: NOBODY })).status).toBe(403);
      expect(((await call('GET', `/procurement-external-links?project_id=${seeded.projectId}`, { member: READER })).json.items as unknown[]).length).toBe(0);
    });

    it('refuses an id that is not an id and a status that is not one with 422', async () => {
      for (const url of ['/procurement-milestones?project_id=nope', '/procurement-milestones?package_id=nope', '/procurement-external-links?project_id=nope', '/procurement-external-links?diff_status=WRONG']) {
        const refused = await call('GET', url, { member: READER });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
    });
  });
});
