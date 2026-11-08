import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client, Pool } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, OutboxRelay, TenantDatabase } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { EgpConnectionController, EgpImportController, EgpMappingController } from '../../src/modules/bid/egp.controller';
import { EgpObligationController, EgpObligationReadsController, EgpReconciliationController, EgpReconciliationReadsController } from '../../src/modules/bid/egp-posting.controller';
import { BID_EGP_MILESTONE_CONSUMER, EGP_MAPPING_DECIDED_EVENT, EgpMilestoneConsumer } from '../../src/modules/bid/egp-milestone.consumer';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // every EGP permission, and the contractor export
const PREPARER = 2; // prepares and cancels
const SUBMITTER = 3; // submits, records receipts and rejections
const RECONCILER = 4; // runs the reconciliation and settles items
const READER = 5; // bid.read
const NOBODY = 6;
const UNIT_ADMIN = 7; // every EGP permission over the department only
const CHECKER = 8; // approves mappings
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x9a;
const WORKER = '00000000-0000-4000-8000-000000000000';
const ALL = ['bid.read', 'bid.import', 'bid.egp.admin', 'bid.egp.preview', 'bid.egp.map', 'bid.egp.map.approve', 'bid.egp.post.prepare', 'bid.egp.post.submit', 'bid.egp.reconcile', 'contractor.export'];
const KHLCNT_HEADER = 'plan_code,package_external_code,package_name,estimated_price,selection_method,approved_on,decision_no,project_code,package_code';
const TBMT_HEADER = 'notice_code,notice_version,notice_kind,package_external_code,plan_code,published_at,bid_closing_at,bid_opening_at,estimated_price,bid_security_amount,project_code,package_code';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const hostOf = (args: unknown[]): string | undefined => {
  const first = args[0];
  if (typeof first === 'object' && first !== null) return (first as { host?: string }).host;
  return typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : undefined;
};

describe('the duties of posting to the national procurement network, the reconciliation and the milestones (EGP-2, BID-32, BID-33)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let relayPool: Pool;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string; outcome: string }>('select safe_diff, reason, actor_id, outcome from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

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

  async function seedPackage(options: { budget?: string; status?: string } = {}): Promise<{ projectId: string; packageId: string; code: string; projectCode: string }> {
    counter += 1;
    const projectId = randomUUID();
    const packageId = randomUUID();
    const code = `GT-P${String(counter).padStart(4, '0')}`;
    const projectCode = `PRJ-P${counter}-${projectId.slice(0, 4)}`;
    await seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Procurement project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, projectCode, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      ],
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
         values ($1, $2, $3, $4, $5::numeric, 'OPEN_BIDDING', 1, $6, 'Construction package', $7, 1)`,
        [TENANT_A, packageId, projectId, code, options.budget ?? '1000000000', options.status ?? 'APPROVED', memberId(ADMIN)],
      ],
    ]);
    return { projectId, packageId, code, projectCode };
  }

  async function seedApprovedPlan(projectId: string, approvedAt: string): Promise<string> {
    const planId = randomUUID();
    await seedAsAdmin([
      [
        `insert into machvon.procurement_plan (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, decision_document_id, status, submitted_by, submitted_at, approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, 1, 'Plan', 1000, 'Luat Dau thau', $4, 'APPROVED', $5, $7::timestamptz, $6, $7::timestamptz, $8, $8)`,
        [TENANT_A, planId, projectId, randomUUID(), memberId(CHECKER), memberId(SUBMITTER), approvedAt, memberId(ADMIN)],
      ],
    ]);
    return planId;
  }

  async function upload(bytes: Uint8Array): Promise<{ key: string; sha: string }> {
    const stored = await files.upload({ tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const importFile = async (kind: string, bytes: Uint8Array): Promise<Reply> => {
    const file = await upload(bytes);
    return call('POST', '/egp/imports', { member: ADMIN, body: { kind, file_object_key: file.key, file_sha256: file.sha } });
  };

  /** Approves the mappings of a package the file proposed (a person other than the loader). */
  async function approveMappings(subjectId: string): Promise<void> {
    const proposed = await rows<{ id: string; version: string }>("select id, version::text as version from machvon.master_crosswalk where subject_id = $1 and status = 'PROPOSED' order by id", [subjectId]);
    for (const mapping of proposed) {
      const decided = await call('POST', `/egp/mappings/${mapping.id}/decision`, { member: CHECKER, ifMatch: mapping.version, body: { decision: 'APPROVE', reason: 'Đã đối chiếu với thông báo mời thầu' } });
      expect(decided.status).toBe(200);
    }
  }

  async function openNotice(packageCode: string, projectCode: string, triggeredOn = day(-3)): Promise<Record<string, unknown>> {
    const opened = await call('POST', '/egp/obligations', { member: PREPARER, body: { kind: 'NOTICE', our_code: packageCode, our_project_code: projectCode, triggered_on: triggeredOn } });
    expect(opened.status).toBe(200);
    return opened.json;
  }

  const prepareFields = { package_code: 'GT-0001', published_at: '2026-11-02', bid_closing_at: '2026-11-20' };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-egp2-'));
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, PREPARER, SUBMITTER, RECONCILER, READER, NOBODY, UNIT_ADMIN, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'EGP_ADMIN', ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'EGP_PREPARER', ['bid.read', 'bid.egp.post.prepare'], 30);
    await harness.seedRole(TENANT_A, 3, 'EGP_SUBMITTER', ['bid.read', 'bid.egp.post.submit'], 30);
    await harness.seedRole(TENANT_A, 4, 'EGP_RECONCILER', ['bid.read', 'bid.egp.reconcile'], 30);
    await harness.seedRole(TENANT_A, 5, 'BID_READER', ['bid.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'EGP_CHECKER', ['bid.read', 'bid.egp.map.approve'], 30);
    await harness.seedRole(TENANT_B, 1, 'EGP_ADMIN', ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: PREPARER, role: 2, kind: 'TENANT' },
      { n: 3, member: SUBMITTER, role: 3, kind: 'TENANT' },
      { n: 4, member: RECONCILER, role: 4, kind: 'TENANT' },
      { n: 5, member: READER, role: 5, kind: 'TENANT' },
      { n: 6, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 7, member: CHECKER, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    // Tenant A has the published working calendar of two years; tenant B has none.
    const years = [new Date().getUTCFullYear() - 1, new Date().getUTCFullYear(), new Date().getUTCFullYear() + 1];
    await harness.owner(
      TENANT_A,
      years.map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(ADMIN)],
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
      controllers: [EgpConnectionController, EgpImportController, EgpMappingController, EgpObligationController, EgpObligationReadsController, EgpReconciliationController, EgpReconciliationReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await relayPool?.end();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of BID', () => {
    for (const controller of [EgpObligationController, EgpObligationReadsController, EgpReconciliationController, EgpReconciliationReadsController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('who may read and who may act', () => {
    it('answers a reader with the board and no action, a caller with no right 403, and a grant on one department only 403 SCOPE_DENIED, on every read and command', async () => {
      const reader = await call('GET', '/egp/obligations', { member: READER });
      expect(reader.status).toBe(200);
      expect(reader.json).toMatchObject({ acceptance: 'PENDING_EXTERNAL', adapter_status: 'PROPOSED', actions: { sweep: false, open: false, prepare: false, submit: false }, severity_rule: { urgent_within_hours: 24, source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED' } });
      expect((reader.json.on_time as Record<string, unknown>).rate_bp).toBeNull();
      expect(String((reader.json.on_time as Record<string, unknown>).formula)).toContain('/');
      const list = await call('GET', '/egp/reconciliation/items', { member: READER });
      expect(list.json).toMatchObject({ actions: { run: false, resolve: false }, due_rule: { days: 10, unverified: true, legal_status: 'UNVERIFIED' }, acceptance: 'PENDING_EXTERNAL', counts: { open: 0 } });
      expect(String(list.json.formula)).toContain('egp_record');
      for (const [method, url] of [['GET', '/egp/obligations'], ['GET', '/egp/reconciliation/items'], ['POST', '/egp/obligations/sweep'], ['POST', '/egp/reconciliation/run']] as const) {
        expect((await call(method, url, { member: NOBODY })).status).toBe(403);
        const scoped = await call(method, url, { member: UNIT_ADMIN });
        expect([scoped.status, scoped.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      for (const [url, member] of [['/egp/obligations/sweep', READER], ['/egp/obligations/sweep', RECONCILER], ['/egp/reconciliation/run', PREPARER], ['/egp/reconciliation/run', READER]] as const) {
        expect((await call('POST', url, { member, body: {} })).status).toBe(403);
      }
      expect((await call('GET', `/egp/obligations/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect((await call('GET', '/egp/obligations?group=NOPE', { member: READER })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('GET', '/egp/reconciliation/items?subject_type=PROJECT', { member: READER })).json.code).toBe('VALIDATION_FAILED');
    });

    it('does not show a tenant the obligations of another, and refuses a foreign id as it refuses one that is not there', async () => {
      const subject = await seedPackage();
      const opened = await openNotice(subject.code, subject.projectCode);
      const foreign = await call('GET', `/egp/obligations/${opened.id as string}`, { member: B_ADMIN, tenantId: TENANT_B });
      expect(foreign.status).toBe(404);
      expect((await call('GET', '/egp/obligations', { member: B_ADMIN, tenantId: TENANT_B })).json).toMatchObject({ items: [], counts: { total: 0 } });
      const attempt = await call('POST', `/egp/obligations/${opened.id as string}/cancel`, { member: B_ADMIN, tenantId: TENANT_B, ifMatch: 1, body: { reason: 'Một người của tổ chức khác muốn hủy bài đăng' } });
      expect(attempt.status).toBe(404);
    });
  });

  describe('opening: by the facts of the register and by hand', () => {
    it('sweeps the plan that was approved after the cutover day, once however often it runs, with the audit row and the event of each duty; and refuses a cutover day that is not a day', async () => {
      const subject = await seedPackage();
      const planId = await seedApprovedPlan(subject.projectId, new Date(Date.now() - 2 * 86_400_000).toISOString());
      const old = await seedPackage();
      const oldPlan = await seedApprovedPlan(old.projectId, new Date(Date.now() - 200 * 86_400_000).toISOString());
      expect((await call('POST', '/egp/obligations/sweep', { member: PREPARER, body: { since_on: day(1) } })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('POST', '/egp/obligations/sweep', { member: PREPARER, body: { since_on: '2026-02-30' } })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('POST', '/egp/obligations/sweep', { member: PREPARER, body: { kinds: ['NOPE'] } })).json.code).toBe('VALIDATION_FAILED');
      const swept = await call('POST', '/egp/obligations/sweep', { member: PREPARER, body: { since_on: day(-30), kinds: ['PLAN'] } });
      expect(swept.status).toBe(200);
      expect(swept.json).toMatchObject({ opened: 1, existing: 0, outcomes: [{ fact: 'PLAN_APPROVED', kind: 'PLAN', opened: 1, truncated: false }] });
      const [obligation] = await rows<{ id: string; owner_id: string; state: string; rule_version: number; legal_status: string }>('select id, owner_id, state, rule_version, legal_status from machvon.egp_posting_obligation where source_ref = $1', [planId]);
      expect(obligation).toMatchObject({ owner_id: memberId(PREPARER), state: 'DUE', rule_version: 0, legal_status: 'UNVERIFIED' });
      expect(await rows('select 1 from machvon.egp_posting_obligation where source_ref = $1', [oldPlan])).toEqual([]);
      const again = await call('POST', '/egp/obligations/sweep', { member: PREPARER, body: { since_on: day(-30), kinds: ['PLAN'] } });
      expect(again.json).toMatchObject({ opened: 0, existing: 1 });
      const [sweepAudit] = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'bid.egp_obligations_swept' and actor_id = $1 order by occurred_at desc limit 1", [memberId(PREPARER)]);
      expect(sweepAudit?.safe_diff).toMatchObject({ opened: 0, existing: 1, since_on: day(-30) });
      const [audit] = await audits((obligation as { id: string }).id, 'bid.egp_obligation_opened');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(PREPARER), safe_diff: { kind: 'PLAN', subject_id: planId, state: 'DUE', origin: 'SWEEP', legal_status: 'UNVERIFIED' } });
      const [event] = await events((obligation as { id: string }).id, 'bid.egp.obligation.opened.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, kind: 'PLAN', subject_id: planId, state: 'DUE' });
      expect(JSON.stringify(event?.payload)).not.toContain('Plan');
    });

    it('opens by hand for a notice, resolving the package by its code, refusing a code that names nothing, two packages or a day in the future, and answering the same opening once', async () => {
      const subject = await seedPackage();
      const key = `key-${randomUUID()}`;
      const body = { kind: 'NOTICE', our_code: subject.code, our_project_code: subject.projectCode, triggered_on: day(-3) };
      const first = await call('POST', '/egp/obligations', { member: PREPARER, body, key });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ kind: 'NOTICE', subject_type: 'NOTICE', subject_id: subject.packageId, subject_code: subject.code, state: 'DUE', legal_status: 'UNVERIFIED', rule_version: 0, owner_name: expect.any(String), actions: { prepare: true, submit: false, receipt: false, reject: false, cancel: true } });
      expect((first.json.clock as Record<string, unknown>).status).toBe('ON_TIME');
      const replay = await call('POST', '/egp/obligations', { member: PREPARER, body, key });
      expect(replay.json.id).toBe(first.json.id);
      const same = await call('POST', '/egp/obligations', { member: PREPARER, body });
      expect(same.json.id).toBe(first.json.id);
      expect(await audits(first.json.id as string, 'bid.egp_obligation_opened')).toHaveLength(1);
      // A repeat is answered with the duty that is there and leaves its own mark in the trail, and no second event.
      expect(await audits(first.json.id as string, 'bid.egp_obligation_open_repeated')).toHaveLength(1);
      expect(await events(first.json.id as string, 'bid.egp.obligation.opened.v1')).toHaveLength(1);
      expect((await call('POST', '/egp/obligations', { member: PREPARER, body: { ...body, our_code: 'GT-NOT-HERE' } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await call('POST', '/egp/obligations', { member: PREPARER, body: { ...body, triggered_on: day(2) } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await call('POST', '/egp/obligations', { member: PREPARER, body: { ...body, kind: 'NOPE' } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await call('POST', '/egp/obligations', { member: PREPARER, body: { ...body, owner_id: randomUUID() } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      const noCalendar = await call('POST', '/egp/obligations', { member: B_ADMIN, tenantId: TENANT_B, body });
      expect(noCalendar.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('the life of a duty: prepare, submit by another person, receipt', () => {
    it('UAT-PLAN-141: moves along the states with the audit row and the event of each move, refuses the same person twice and a stale version, takes the receipt once, and shows the figure "posted on time"', async () => {
      const subject = await seedPackage();
      const opened = await openNotice(subject.code, subject.projectCode, day(-1));
      const obligationId = opened.id as string;
      // Prepare: the fields the kind needs, all of them.
      expect((await call('POST', `/egp/obligations/${obligationId}/prepare`, { member: PREPARER, ifMatch: 1, body: { fields: { package_code: 'GT-1' } } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await call('POST', `/egp/obligations/${obligationId}/prepare`, { member: PREPARER, ifMatch: 1, body: {} })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      const detail = await call('GET', `/egp/obligations/${obligationId}`, { member: READER });
      expect(detail.json).toMatchObject({ required_fields: ['package_code', 'published_at', 'bid_closing_at'], suggested_fields: {}, deadline_rule: { source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED', params: { due_in: 5, due_unit: 'WORKING_DAYS' } } });
      expect(String((detail.json.deadline_rule as Record<string, unknown>).formula)).toContain('due_in');
      expect(((detail.json.obligation as Record<string, unknown>).obligation as string).length).toBeGreaterThan(3);
      const prepared = await call('POST', `/egp/obligations/${obligationId}/prepare`, { member: PREPARER, ifMatch: 1, body: { fields: prepareFields } });
      expect([prepared.status, prepared.json.status, prepared.json.resource_version]).toEqual([200, 'PREPARED', 2]);
      const [preparedAudit] = await audits(obligationId, 'bid.egp_obligation_prepared');
      expect(preparedAudit).toMatchObject({ actor_id: memberId(PREPARER), safe_diff: { state: 'PREPARED', from_state: 'DUE' } });
      expect(preparedAudit?.safe_diff.packet_sha256).toMatch(/^[0-9a-f]{64}$/);
      // Submit: not the person who prepared (403), not without the right (403), not with a stale version (409).
      expect((await call('POST', `/egp/obligations/${obligationId}/submit`, { member: PREPARER, ifMatch: 2 })).status).toBe(403);
      expect((await call('POST', `/egp/obligations/${obligationId}/submit`, { member: ADMIN, ifMatch: 2 })).status).toBe(200);
      const [submittedAudit] = await audits(obligationId, 'bid.egp_obligation_submitted');
      expect(submittedAudit).toMatchObject({ actor_id: memberId(ADMIN), safe_diff: { state: 'SUBMITTED', prepared_by: memberId(PREPARER), in_time: true } });
      // The same duty again from the same preparer: refused by the state, and the maker-checker rule was judged before.
      expect((await call('POST', `/egp/obligations/${obligationId}/submit`, { member: SUBMITTER, ifMatch: 2 })).json.code).toBe('VERSION_CONFLICT');
      expect((await call('POST', `/egp/obligations/${obligationId}/submit`, { member: SUBMITTER, ifMatch: 3 })).json.code).toBe('EGP_OBLIGATION_STATE_INVALID');
      // The receipt: the reference the network gave, once.
      expect((await call('POST', `/egp/obligations/${obligationId}/receipt`, { member: PREPARER, ifMatch: 3, body: { receipt_ref: 'BN-1' } })).status).toBe(403);
      expect((await call('POST', `/egp/obligations/${obligationId}/receipt`, { member: SUBMITTER, ifMatch: 3, body: { receipt_ref: '' } })).json.code).toBe('VALIDATION_FAILED');
      expect((await call('POST', `/egp/obligations/${obligationId}/receipt`, { member: SUBMITTER, ifMatch: 3, body: { receipt_ref: 'BN-1', receipted_at: 'not a time' } })).json.code).toBe('VALIDATION_FAILED');
      const ref = `BN-${randomUUID().slice(0, 8)}`;
      const receipted = await call('POST', `/egp/obligations/${obligationId}/receipt`, { member: SUBMITTER, ifMatch: 3, body: { receipt_ref: ref } });
      expect([receipted.status, receipted.json.status, receipted.json.resource_version]).toEqual([200, 'RECEIPTED', 4]);
      const [receiptAudit] = await audits(obligationId, 'bid.egp_obligation_receipted');
      expect(receiptAudit).toMatchObject({ actor_id: memberId(SUBMITTER), safe_diff: { receipt_ref: ref, state: 'RECEIPTED' } });
      const [receiptEvent] = await events(obligationId, 'bid.egp.obligation.receipted.v1');
      expect(receiptEvent?.payload).toMatchObject({ obligation_id: obligationId, state: 'RECEIPTED', receipt_ref: ref });
      const after = await call('GET', `/egp/obligations/${obligationId}`, { member: READER });
      expect(after.json.obligation).toMatchObject({ state: 'RECEIPTED', receipt_ref: ref, receipt_recorded_by_name: expect.any(String), alert: null, severity: null, clock: { status: 'MET' }, actions: { prepare: false, submit: false, receipt: false, reject: false, cancel: false } });
      expect((after.json.history as Array<Record<string, unknown>>).map((entry) => entry.action)).toEqual(['OPENED', 'PREPARED', 'SUBMITTED', 'RECEIPTED']);
      // A reference stands for one posting.
      const other = await seedPackage();
      const second = await openNotice(other.code, other.projectCode, day(-1));
      await call('POST', `/egp/obligations/${second.id as string}/prepare`, { member: PREPARER, ifMatch: 1, body: { fields: prepareFields } });
      await call('POST', `/egp/obligations/${second.id as string}/submit`, { member: SUBMITTER, ifMatch: 2 });
      const duplicate = await call('POST', `/egp/obligations/${second.id as string}/receipt`, { member: SUBMITTER, ifMatch: 3, body: { receipt_ref: ref } });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'EGP_RECEIPT_DUPLICATE']);
      expect(await rows('select 1 from machvon.egp_posting_receipt where receipt_ref = $1', [ref])).toHaveLength(1);
      const board = await call('GET', '/egp/obligations?group=CLOSED', { member: READER });
      const onTime = board.json.on_time as Record<string, number | null>;
      expect(onTime.met).toBeGreaterThanOrEqual(1);
      expect(onTime.rate_bp).not.toBeNull();
      expect((board.json.items as Array<Record<string, unknown>>).every((item) => ['RECEIPTED', 'CANCELLED'].includes(item.state as string))).toBe(true);
    });

    it('records a rejection that puts the clock back, prepares again, and cancels with a sentence', async () => {
      const subject = await seedPackage();
      const opened = await openNotice(subject.code, subject.projectCode, day(-1));
      const id1 = opened.id as string;
      await call('POST', `/egp/obligations/${id1}/prepare`, { member: PREPARER, ifMatch: 1, body: { fields: prepareFields } });
      await call('POST', `/egp/obligations/${id1}/submit`, { member: SUBMITTER, ifMatch: 2 });
      expect((await call('POST', `/egp/obligations/${id1}/reject`, { member: SUBMITTER, ifMatch: 3, body: { reason: 'Sai' } })).json.code).toBe('VALIDATION_FAILED');
      const rejected = await call('POST', `/egp/obligations/${id1}/reject`, { member: SUBMITTER, ifMatch: 3, body: { reason: 'Hệ thống mạng từ chối vì thiếu ngày đóng thầu' } });
      expect(rejected.json.status).toBe('REJECTED');
      const [rejectAudit] = await audits(id1, 'bid.egp_obligation_rejected');
      expect(rejectAudit).toMatchObject({ reason: 'Hệ thống mạng từ chối vì thiếu ngày đóng thầu', safe_diff: { state: 'REJECTED' } });
      const shown = await call('GET', `/egp/obligations/${id1}`, { member: READER });
      expect(shown.json.obligation).toMatchObject({ state: 'REJECTED', rejection_reason: 'Hệ thống mạng từ chối vì thiếu ngày đóng thầu', submitted_by_name: expect.any(String), actions: { prepare: false } });
      expect((await call('POST', `/egp/obligations/${id1}/prepare`, { member: SUBMITTER, ifMatch: 4, body: { fields: prepareFields } })).status).toBe(403);
      expect((await call('POST', `/egp/obligations/${id1}/prepare`, { member: PREPARER, ifMatch: 4, body: { fields: prepareFields } })).json.status).toBe('PREPARED');
      expect((await call('POST', `/egp/obligations/${id1}/cancel`, { member: PREPARER, ifMatch: 5, body: { reason: 'Ngắn' } })).json.code).toBe('VALIDATION_FAILED');
      const cancelled = await call('POST', `/egp/obligations/${id1}/cancel`, { member: PREPARER, ifMatch: 5, body: { reason: 'Gói thầu đã bị hủy nên không còn gì để đăng' } });
      expect(cancelled.json.status).toBe('CANCELLED');
      const [cancelAudit] = await audits(id1, 'bid.egp_obligation_cancelled');
      expect(cancelAudit).toMatchObject({ reason: 'Gói thầu đã bị hủy nên không còn gì để đăng', safe_diff: { state: 'CANCELLED', from_state: 'PREPARED' } });
      expect((await call('POST', `/egp/obligations/${id1}/reject`, { member: SUBMITTER, ifMatch: 6, body: { reason: 'Không còn gì để từ chối nữa' } })).json.code).toBe('EGP_OBLIGATION_STATE_INVALID');
    });

    it('refuses the person who prepared a posting as the one who submits it, whatever right they hold', async () => {
      const subject = await seedPackage();
      const opened = await openNotice(subject.code, subject.projectCode, day(-1));
      const id = opened.id as string;
      await call('POST', `/egp/obligations/${id}/prepare`, { member: ADMIN, ifMatch: 1, body: { fields: prepareFields } });
      const own = await call('POST', `/egp/obligations/${id}/submit`, { member: ADMIN, ifMatch: 2 });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await call('GET', `/egp/obligations/${id}`, { member: READER })).json.obligation).toMatchObject({ state: 'PREPARED', actions: { submit: false } });
      expect((await call('POST', `/egp/obligations/${id}/submit`, { member: SUBMITTER, ifMatch: 2 })).status).toBe(200);
    });

    it('lists by state and clock with a cursor, mine only, and the alert and severity that the time left gives', async () => {
      const late = await seedPackage();
      const lateOpened = await openNotice(late.code, late.projectCode, day(-30));
      expect(lateOpened).toMatchObject({ alert: 'EGP_POSTING_OVERDUE', severity: 'URGENT', clock: { status: 'OVERDUE' } });
      const overdue = await call('GET', '/egp/obligations?clock=OVERDUE&group=OPEN', { member: READER });
      expect((overdue.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toContain(lateOpened.id);
      expect((overdue.json.counts as Record<string, number>).overdue).toBeGreaterThanOrEqual(1);
      const mine = await call('GET', '/egp/obligations?mine=true&limit=1', { member: PREPARER });
      expect((mine.json.items as unknown[]).length).toBe(1);
      expect(mine.json.next_cursor).not.toBeNull();
      const next = await call('GET', `/egp/obligations?mine=true&limit=1&cursor=${encodeURIComponent(mine.json.next_cursor as string)}`, { member: PREPARER });
      expect(((next.json.items as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id).not.toBe(((mine.json.items as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id);
      expect(((await call('GET', '/egp/obligations?mine=true', { member: SUBMITTER })).json.items as unknown[]).length).toBe(0);
    });
  });

  describe('the contractor export of CTR-24 is the packet of an evaluation or a violation', () => {
    it('takes a batch only from someone who may read its file, only of the right scope, and its receipt is the receipt of the batch', async () => {
      counter += 1;
      const tax = String(1_500_000_000 + counter);
      const contractorId = randomUUID();
      const batchId = randomUUID();
      const sha = createHash('sha256').update(batchId).digest('hex');
      await seedAsAdmin([
        [`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by) values ($1, $2, $3, 'Công ty An Phát', 'VERIFIED', $4, $5)`, [TENANT_A, contractorId, tax, randomUUID(), memberId(ADMIN)]],
        [
          `insert into machvon.contractor_export_batch (tenant_id, id, scope, period_from, period_to, format, file_sha256, file_object_key, row_count, contract_ids, status, created_by, version)
           values ($1, $2, 'VIOLATION', date '2026-01-01', date '2026-10-31', 'CSV', $3, 'k', 3, '{}'::uuid[], 'GENERATED', $4, 1)`,
          [TENANT_A, batchId, sha, memberId(ADMIN)],
        ],
      ]);
      const opened = await call('POST', '/egp/obligations', { member: PREPARER, body: { kind: 'VIOLATION', our_code: tax, triggered_on: day(-2) } });
      expect(opened.json).toMatchObject({ kind: 'VIOLATION', subject_type: 'CONTRACTOR', subject_id: contractorId, subject_code: tax });
      const violationId = opened.json.id as string;
      // Someone who may not read the file does not find the batch; a field set is not a batch.
      expect((await call('POST', `/egp/obligations/${violationId}/prepare`, { member: PREPARER, ifMatch: 1, body: { export_batch_id: batchId } })).status).toBe(404);
      expect((await call('POST', `/egp/obligations/${violationId}/prepare`, { member: ADMIN, ifMatch: 1, body: { export_batch_id: batchId, fields: { a: 'b' } } })).json.code).toBe('VALIDATION_FAILED');
      const prepared = await call('POST', `/egp/obligations/${violationId}/prepare`, { member: ADMIN, ifMatch: 1, body: { export_batch_id: batchId } });
      expect(prepared.status).toBe(200);
      const detail = await call('GET', `/egp/obligations/${violationId}`, { member: READER });
      expect(detail.json.obligation).toMatchObject({ export_batch_id: batchId, export_batch_status: 'GENERATED', packet_sha256: sha, packet: { export_file_sha256: sha, rows: 3, scope: 'VIOLATION' } });
      await call('POST', `/egp/obligations/${violationId}/submit`, { member: SUBMITTER, ifMatch: 2 });
      const ref = `NATDB-${randomUUID().slice(0, 8)}`;
      expect((await call('POST', `/egp/obligations/${violationId}/receipt`, { member: SUBMITTER, ifMatch: 3, body: { receipt_ref: ref } })).status).toBe(200);
      const [batch] = await rows<{ status: string; submitted_ref: string; submitted_by: string }>('select status, submitted_ref, submitted_by from machvon.contractor_export_batch where id = $1', [batchId]);
      expect(batch).toMatchObject({ status: 'SUBMITTED_EXTERNALLY', submitted_ref: ref, submitted_by: memberId(SUBMITTER) });
      const [audit] = await audits(batchId, 'ctr.contractor_export.submitted');
      expect(audit?.safe_diff).toMatchObject({ submitted_ref: ref, via_obligation_id: violationId });
      expect((await call('GET', `/egp/obligations/${violationId}`, { member: READER })).json.obligation).toMatchObject({ export_batch_status: 'SUBMITTED_EXTERNALLY' });
      // A notice cannot take a batch, and a batch of the other scope cannot be the packet of this kind.
      const subject = await seedPackage();
      const notice = await openNotice(subject.code, subject.projectCode);
      expect((await call('POST', `/egp/obligations/${notice.id as string}/prepare`, { member: ADMIN, ifMatch: 1, body: { export_batch_id: batchId } })).json.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('the reconciliation of the fields', () => {
    async function mapped(budget: string, theirPrice: string): Promise<{ packageId: string; code: string; external: string }> {
      const subject = await seedPackage({ budget });
      const external = `PK-RC-${randomUUID().slice(0, 6)}`;
      const loaded = await importFile('KHLCNT', csv(KHLCNT_HEADER, `PL-${external},${external},Construction package,${theirPrice},OPEN_BIDDING,2026-10-20,12/QD,${subject.projectCode},${subject.code}`));
      expect(loaded.status).toBe(200);
      await approveMappings(subject.packageId);
      return { packageId: subject.packageId, code: subject.code, external };
    }

    it('UAT-PLAN-142: opens an item for each field that differs with an owner who is not a maker, once however often it runs, and the people who made the record cannot settle it', async () => {
      const one = await mapped('1000000000', '1200000000');
      const run = await call('POST', '/egp/reconciliation/run', { member: RECONCILER, body: { subject_type: 'PACKAGE' } });
      expect(run.status).toBe(200);
      expect(run.json).toMatchObject({ opened: expect.any(Number), no_owner: 0 });
      const item = (run.json.items as Array<Record<string, unknown>>).find((entry) => entry.subject_id === one.packageId) as Record<string, unknown>;
      expect(item).toMatchObject({ subject_code: one.code, external_code: one.external, field: 'estimated_price', difference_kind: 'VALUE_MISMATCH', ours: '1000000000', theirs: '1200000000', delta: '200000000', state: 'OPEN', owner_id: memberId(RECONCILER), overdue: false, is_maker: false, actions: { resolve: true } });
      const itemId = item.id as string;
      const [opened] = await audits(itemId, 'bid.egp_reconciliation_opened');
      expect(opened).toMatchObject({ actor_id: memberId(RECONCILER), safe_diff: { field: 'estimated_price', difference_kind: 'VALUE_MISMATCH', owner_id: memberId(RECONCILER) } });
      expect(JSON.stringify(opened?.safe_diff)).not.toContain('1200000000');
      expect(await events(itemId, 'bid.egp.reconciliation.opened.v1')).toHaveLength(1);
      const again = await call('POST', '/egp/reconciliation/run', { member: RECONCILER, body: { subject_type: 'PACKAGE' } });
      expect((again.json.items as Array<Record<string, unknown>>).filter((entry) => entry.subject_id === one.packageId)).toEqual([]);
      expect(again.json).toMatchObject({ opened: 0 });
      expect((again.json.unchanged as number) >= 1).toBe(true);
      // The people who made the record (the maker of the package and the loader of the file are the same administrator here) do not settle it.
      const own = await call('POST', `/egp/reconciliation/items/${itemId}/resolution`, { member: ADMIN, ifMatch: 1, body: { kind: 'ACCEPT_EXTERNAL', reason: 'Số trên mạng là đúng theo thông báo' } });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await call('POST', `/egp/reconciliation/items/${itemId}/resolution`, { member: PREPARER, ifMatch: 1, body: { kind: 'ACCEPT_EXTERNAL', reason: 'Số trên mạng là đúng theo thông báo' } })).status).toBe(403);
      const worklist = await call('GET', '/egp/reconciliation/items?state=OPEN&mine=true', { member: RECONCILER });
      expect((worklist.json.items as Array<Record<string, unknown>>).map((entry) => entry.id)).toContain(itemId);
      expect(worklist.json).toMatchObject({ actions: { run: true, resolve: true } });
    });

    it('settles with each of the four resolutions, judges the reason, the evidence and the review day, audits it and announces it, and a settled difference does not come back', async () => {
      const one = await mapped('2000000000', '2100000000');
      const run = await call('POST', '/egp/reconciliation/run', { member: RECONCILER, body: {} });
      const item = (run.json.items as Array<Record<string, unknown>>).find((entry) => entry.subject_id === one.packageId) as Record<string, unknown>;
      const itemId = item.id as string;
      const resolve = (body: Record<string, unknown>, version: number | string = 1) => call('POST', `/egp/reconciliation/items/${itemId}/resolution`, { member: RECONCILER, ifMatch: version, body });
      expect((await resolve({ kind: 'ACCEPT_EXTERNAL', reason: 'ngắn' })).json.code).toBe('VALIDATION_FAILED');
      expect((await resolve({ kind: 'NOPE', reason: 'Số trên mạng là đúng theo thông báo' })).json.code).toBe('VALIDATION_FAILED');
      expect((await resolve({ kind: 'DISPUTE', reason: 'Số trên mạng sai so với quyết định phê duyệt' })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await resolve({ kind: 'WAIVE', reason: 'Để lại đến khi có biên bản của chủ đầu tư', review_on: day(-1) })).json.code).toBe('VALIDATION_FAILED');
      expect((await resolve({ kind: 'WAIVE', reason: 'Để lại đến khi có biên bản của chủ đầu tư', review_on: day(400) })).json.code).toBe('VALIDATION_FAILED');
      expect((await resolve({ kind: 'ACCEPT_EXTERNAL', reason: 'Số trên mạng là đúng theo thông báo' }, 9)).json.code).toBe('VERSION_CONFLICT');
      const done = await resolve({ kind: 'DISPUTE', reason: 'Số trên mạng sai so với quyết định phê duyệt', evidence_ref: 'CV-77/SKHDT ngày 05/11/2026' });
      expect([done.status, done.json.status, done.json.resource_version]).toEqual([200, 'RESOLVED', 2]);
      const [audit] = await audits(itemId, 'bid.egp_reconciliation_resolved');
      expect(audit).toMatchObject({ actor_id: memberId(RECONCILER), reason: 'Số trên mạng sai so với quyết định phê duyệt', safe_diff: { resolution: 'DISPUTE', follow_up: 'ESCALATE_TO_OPERATOR', field: 'estimated_price', evidence_ref: 'CV-77/SKHDT ngày 05/11/2026' } });
      const [event] = await events(itemId, 'bid.egp.reconciliation.resolved.v1');
      expect(event?.payload).toMatchObject({ item_id: itemId, resolution: 'DISPUTE', follow_up: 'ESCALATE_TO_OPERATOR', state: 'RESOLVED' });
      expect((await resolve({ kind: 'ACCEPT_EXTERNAL', reason: 'Đổi ý sau khi đã khiếu nại với đơn vị vận hành' }, 2)).json.code).toBe('EGP_RECONCILIATION_STATE_INVALID');
      const settled = await call('GET', '/egp/reconciliation/items?state=RESOLVED', { member: READER });
      const row = (settled.json.items as Array<Record<string, unknown>>).find((entry) => entry.id === itemId);
      expect(row).toMatchObject({ state: 'RESOLVED', resolution: { kind: 'DISPUTE', follow_up: 'ESCALATE_TO_OPERATOR', evidence_ref: 'CV-77/SKHDT ngày 05/11/2026' } });
      expect((settled.json.counts as Record<string, Record<string, number>>).by_resolution.DISPUTE).toBeGreaterThanOrEqual(1);
      const next = await call('POST', '/egp/reconciliation/run', { member: RECONCILER, body: { subject_type: 'PACKAGE' } });
      expect((next.json.items as Array<Record<string, unknown>>).filter((entry) => entry.subject_id === one.packageId)).toEqual([]);
      expect((next.json.settled_already as number) >= 1).toBe(true);
    });
  });

  describe('the dates of the notice and the result become the milestones of the package', () => {
    const relay = async (): Promise<string[]> => {
      const outcomes: string[] = [];
      const consumer = new EgpMilestoneConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: SIGNING_KEY } });
      // The relay takes a batch at a time: it runs until nothing is left to deliver.
      for (let pass = 0; pass < 8; pass += 1) {
        const result = await new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void outcomes.push(await consumer.handle(delivery)), { signingKey: SIGNING_KEY }).runOnce();
        if (result.published === 0) break;
      }
      return outcomes;
    };

    it('serves the events of the notice and the result under its own name', () => {
      expect(new EgpMilestoneConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: SIGNING_KEY } }).name).toBe(BID_EGP_MILESTONE_CONSUMER);
      expect(BID_EGP_MILESTONE_CONSUMER).toBe('bid-egp-milestone');
      expect(EGP_MAPPING_DECIDED_EVENT).toBe('bid.egp.mapping.decided.v1');
    });

    it('fills the milestones when the mapping of the notice and the result is approved, with the audit row and the event of each, and a second delivery of the same event changes nothing', async () => {
      const subject = await seedPackage();
      const notice = `TB-${randomUUID().slice(0, 6)}`;
      const external = `PK-M-${randomUUID().slice(0, 6)}`;
      expect((await importFile('TBMT', csv(TBMT_HEADER, `${notice},0,INVITATION,${external},PL-M,2026-10-05,2026-10-25,2026-10-26,4000000000,,${subject.projectCode},${subject.code}`))).status).toBe(200);
      await approveMappings(subject.packageId);
      const outcomes = await relay();
      expect(outcomes).toContain('processed');
      const held = await rows<{ milestone_kind: string; day: string; source: string; import_batch_id: string | null; id: string }>(
        `select id, milestone_kind, to_char(actual_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as day, source, import_batch_id from machvon.procurement_milestone where package_id = $1 order by milestone_kind`,
        [subject.packageId],
      );
      expect(held.map((row) => [row.milestone_kind, row.day, row.source])).toEqual([
        ['BID_CLOSING', '2026-10-25', 'IMPORT'],
        ['BID_OPENING', '2026-10-26', 'IMPORT'],
        ['INVITATION_PUBLISHED', '2026-10-05', 'IMPORT'],
      ]);
      expect(held.every((row) => row.import_batch_id !== null)).toBe(true);
      const [audit] = await audits((held[0] as { id: string }).id, 'bid.egp_milestone_filled');
      expect(audit).toMatchObject({ actor_id: WORKER, safe_diff: { package_id: subject.packageId, source: 'IMPORT', external_type: 'EGP_NOTICE', external_code: notice, acted_by: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
      const [event] = await events((held[0] as { id: string }).id, 'bid.egp.milestone.filled.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, package_id: subject.packageId, milestone_kind: 'BID_CLOSING' });
      // The same event delivered again is a duplicate of the inbox, and a pass over the same records changes nothing.
      const [decided] = await rows<{ id: string; event_key: string }>("select id, event_key from machvon.outbox_event where type = 'bid.egp.mapping.decided.v1' and payload ->> 'subject_type' = 'NOTICE' order by created_at desc limit 1");
      expect(decided).toBeDefined();
      await rows("update machvon.outbox_event set status = 'PENDING', published_at = null, next_attempt_at = now() where id = $1", [(decided as { id: string }).id]);
      const redelivered = await relay();
      expect(redelivered).toContain('duplicate');
      expect(await rows('select 1 from machvon.procurement_milestone where package_id = $1', [subject.packageId])).toHaveLength(3);
      expect(await audits((held[0] as { id: string }).id, 'bid.egp_milestone_filled')).toHaveLength(1);
    });
  });

  describe('no connection leaves the machine', () => {
    it('opens, prepares, submits, receipts and reconciles with every socket recorded: each is to this server, none to the national network', async () => {
      const connect = jest.spyOn(net.Socket.prototype, 'connect');
      const httpRequest = jest.spyOn(http, 'request');
      const httpsRequest = jest.spyOn(https, 'request');
      try {
        const subject = await seedPackage();
        const opened = await openNotice(subject.code, subject.projectCode, day(-1));
        const obligationId = opened.id as string;
        await call('POST', `/egp/obligations/${obligationId}/prepare`, { member: PREPARER, ifMatch: 1, body: { fields: prepareFields } });
        await call('POST', `/egp/obligations/${obligationId}/submit`, { member: SUBMITTER, ifMatch: 2 });
        await call('POST', `/egp/obligations/${obligationId}/receipt`, { member: SUBMITTER, ifMatch: 3, body: { receipt_ref: `BN-${randomUUID().slice(0, 8)}` } });
        await call('POST', '/egp/obligations/sweep', { member: PREPARER, body: {} });
        await call('POST', '/egp/reconciliation/run', { member: RECONCILER, body: {} });
        await call('GET', '/egp/obligations', { member: READER });
        await call('GET', '/egp/reconciliation/items', { member: READER });
        const hosts = (connect.mock.calls as unknown[][]).map(hostOf).filter((host): host is string => host !== undefined);
        expect(connect.mock.calls.length).toBeGreaterThan(0);
        expect(hosts.filter((host) => !['127.0.0.1', '::1', 'localhost'].includes(host))).toEqual([]);
        expect(hosts.filter((host) => host.includes('muasamcong'))).toEqual([]);
        expect(httpRequest.mock.calls.filter((args) => String(JSON.stringify(args[0] ?? '')).includes('muasamcong'))).toEqual([]);
        expect(httpsRequest.mock.calls.filter((args) => String(JSON.stringify(args[0] ?? '')).includes('muasamcong'))).toEqual([]);
      } finally {
        connect.mockRestore();
        httpRequest.mockRestore();
        httpsRequest.mockRestore();
      }
    });

    it('the files that serve the outbound side import no client of the network and call no fetch', async () => {
      for (const name of ['egp-posting.controller.ts', 'egp-posting-view.ts', 'egp-milestone.consumer.ts']) {
        const source = await readFile(join(__dirname, '..', '..', 'src', 'modules', 'bid', name), 'utf8');
        for (const specifier of [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string)) expect(specifier).not.toMatch(/^(node:)?(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads)$|^(axios|got|undici|node-fetch|superagent)$/);
        expect(source).not.toMatch(/\bfetch\s*\(/);
        expect(source).not.toMatch(/muasamcong\.mof\.gov\.vn/);
      }
      for (const name of ['egp-posting-store.ts', 'egp-reconciliation-store.ts', 'egp-milestone-hook.ts', 'home-egp-posting-sources.ts']) {
        const source = await readFile(join(__dirname, '..', '..', '..', '..', 'packages', 'db', 'src', name), 'utf8');
        for (const specifier of [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string)) expect(specifier).not.toMatch(/^(node:)?(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads)$|^(axios|got|undici|node-fetch|superagent)$/);
        expect(source).not.toMatch(/\bfetch\s*\(/);
      }
    });
  });
});
