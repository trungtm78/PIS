import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { BASELINE_PACK, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, objectKey, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { ReportFileController } from '../../src/modules/dis/report-file.controller';
import { ReportController, ReportReadsController } from '../../src/modules/dis/report.controller';
import { ReportSubmitController } from '../../src/modules/dis/report-submit.controller';
import { DIS_CLOCK, DIS_METRICS } from '../../src/modules/dis/tokens';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const MAKER = 1; // report.create, report.edit, report.read and report_revision.read over the whole tenant
const READER = 2; // report.read and report_revision.read over the whole tenant
const ELSEWHERE_MAKER = 3; // the same rights over another branch, where the projects are not
const NOBODY = 4;
const NO_READ = 5; // may create and edit, may not read
const B_MAKER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x9d;
const AREA = id(FAMILY, 30);
const DECISION = id(FAMILY, 32);
const FUND_SOURCE = id(FAMILY, 31);

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

/** FX-DIS-001: six cells 100/200/30/70/0/20 million and CTMTQG 40 million in the year plan of the central budget. */
const FX_DIS_001 = [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
  { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
  { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
];

/** The weekly report draft over HTTP (ST-DIS-003, DIS-01, DIS-02, DIS-04, DIS-18): the maker starts it, enters the six cells, saves it; the reader finds it. */
describe('the weekly report draft over HTTP (ST-DIS-003)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  const now = new Date('2026-12-15T00:00:00Z');
  /** The clock of the module: the day of the tests, moved for the one that judges lateness. */
  let clockNow = now;
  const counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  let counter = 0;
  let weeks: string[] = [];
  let nextWeek = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // Projects and plans belong to other modules: the superuser seeds them with the foreign keys switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A project of the department with a plan version of 2027 in force from December 2026 that allocated 500,000,000 to the year plan of the central budget. */
  async function seedProject(options: { status?: string; unit?: number; allocate?: boolean } = {}): Promise<{ projectId: string; planId: string }> {
    counter += 1;
    const projectId = randomUUID();
    const planId = randomUUID();
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, $7, 1, 'B')`,
        [TENANT_A, projectId, `RP-${counter}`, `Project RP-${counter}`, unitId(options.unit ?? DEPARTMENT), AREA, options.status ?? 'IMPLEMENTATION'],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2027, 1, $4, 'PUBLISHED', timestamptz '2026-12-20T01:00:00Z')`,
        [TENANT_A, planId, projectId, DECISION],
      ],
    ];
    if (options.allocate !== false) {
      statements.push([
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level)
         values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', 2027, 500000000, 0, $4, 'CENTRAL')`,
        [TENANT_A, planId, FUND_SOURCE, projectId],
      ]);
    }
    await seedReplica(statements);
    return { projectId, planId };
  }

  /** The next week of the calendar of 2027 for a test of its own (a project has one report in a period). */
  const week = (): string => {
    const found = weeks[nextWeek];
    nextWeek += 1;
    if (found === undefined) throw new Error('the calendar of 2027 ran out of weeks');
    return found;
  };

  const draft = (projectId: string, periodId: string, planId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    project_id: projectId,
    period_id: periodId,
    plan_version_id: planId,
    report_type: 'WEEKLY',
    measurement_basis: 'YTD',
    funding_lines: FX_DIS_001,
    ...extra,
  });
  const create = (body: Record<string, unknown>, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', '/reports', { member, body, ...options });
  const save = (reportId: string, body: Record<string, unknown>, version: number, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/reports/${reportId}/revisions`, { member, body, ifMatch: `"${version}"`, ...options });
  const read = (reportId: string, member = READER, tenantId?: string): Promise<Reply> => call('GET', `/reports/${reportId}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const trail = (resourceId: string) => rows<{ action: string; classification: string; safe_diff: Record<string, unknown> }>('select action, classification, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  /** A period moves from OPEN to SOFT_CLOSED to LOCKED, one step at a time (the table says so). */
  const lockPeriod = async (periodId: string): Promise<void> => {
    await rows("update machvon.reporting_period set status = 'SOFT_CLOSED', soft_closed_at = now(), version = version + 1 where id = $1", [periodId]);
    await rows("update machvon.reporting_period set status = 'LOCKED', locked_at = now(), locked_by = $2, version = version + 1 where id = $1", [periodId, memberId(MAKER)]);
  };
  const state = async (reportId: string) => (await rows<{ status: string; version: string; revision: number }>('select status, version::text as version, revision from machvon.report_revision where id = $1', [reportId]))[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MAKER, READER, ELSEWHERE_MAKER, NOBODY, NO_READ]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MAKER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'DIS_MAKER', ['report.create', 'report.edit', 'report.submit', 'report.read', 'report_revision.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'DIS_READER', ['report.read', 'report_revision.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'DIS_WRITER', ['report.create', 'report.edit'], 25);
    await harness.seedRole(TENANT_B, 1, 'DIS_MAKER', ['report.create', 'report.edit', 'report.submit', 'report.read', 'report_revision.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: ELSEWHERE_MAKER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: NO_READ, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MAKER, role: 1, kind: 'TENANT' }]);
    await seedReplica([
      [
        "insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', 'NSTW', 'EFFECTIVE', $3, $3)",
        [TENANT_A, id(FAMILY, 33), memberId(MAKER)],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'FUND_SOURCE', 'NSTW', 1, 'Central budget', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
        [TENANT_A, FUND_SOURCE, id(FAMILY, 33), memberId(MAKER)],
      ],
    ]);
    // The calendar of the reporting periods is the one of the baseline, and the weeks of 2027 are generated as the manager does.
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, async (tx) => {
      await applyBaseline(tx, BASELINE_PACK, WORKER);
      await new DisPeriodStore().generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2027, periodType: 'WEEK' }, WORKER, now);
    });
    // A second calendar of the same weeks (the exclusion of the periods is per calendar): the tests of a project each need a week of their own, and one calendar of 2027 has 52.
    await rows(
      `insert into machvon.reporting_period
         (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       select tenant_id, gen_random_uuid(), 'X-' || code, calendar_version, start_date, end_date, deadline_at, 'EXTRA', period_type, fiscal_year, 'OPEN', calendar_version_id, created_by, updated_by
         from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and calendar_code = 'DEFAULT'`,
    );
    weeks = (await rows<{ id: string }>("select id from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' order by calendar_code, start_date")).map((row) => row.id);
    root = await mkdtemp(join(tmpdir(), 'machvon-dis-'));
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportController, ReportReadsController, ReportFileController, ReportSubmitController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: DIS_CLOCK, useValue: () => clockNow },
        { provide: DIS_METRICS, useValue: { increment: (name: string, labels?: Record<string, string>) => void counted.push({ name, labels }), gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('serves the controllers of the report in the module of DIS', () => {
    expect(disModule.controllers.slice(-4)).toEqual([ReportController, ReportReadsController, ReportFileController, ReportSubmitController]);
  });

  describe('post_reports', () => {
    it('AC-ST-DIS-003-1 / UAT-AC240 / FX-DIS-001: six cells of 100/200/30/70/0/20 million are 420 million (not 460), the CTMTQG of 40 million is shown apart, and the money is text', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId));
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      const found = await read(idOf(made));
      expect(found.status).toBe(200);
      expect(found.json).toMatchObject({
        id: idOf(made),
        revision: 1,
        status: 'DRAFT',
        is_current: false,
        version: 1,
        report_type: 'WEEKLY',
        measurement_basis: 'YTD',
        project: { id: projectId, status: 'IMPLEMENTATION' },
        period: { id: period, period_type: 'WEEK', fiscal_year: 2027 },
        plan_version: { id: planId, fiscal_year: 2027, revision: 1, status: 'PUBLISHED' },
        totals: { cumulative_vnd: '420000000', ctmtqg_vnd: '40000000', allocated_vnd: '500000000', next_month_vnd: '0', next_month_ctmtqg_vnd: '0' },
        needs_explanation: false,
      });
      expect(found.json.payload_hash).toMatch(/^[0-9a-f]{64}$/);
      const lines = found.json.funding_lines as Array<Record<string, unknown>>;
      expect(lines.map((entry) => [entry.bucket, entry.budget_level, entry.cumulative_vnd, entry.ctmtqg_subset_vnd, entry.allocated_vnd])).toEqual([
        ['CURRENT_YEAR', 'CENTRAL', '100000000', '40000000', '500000000'],
        ['CURRENT_YEAR', 'LOCAL', '200000000', null, '0'],
        ['CARRYOVER', 'CENTRAL', '30000000', null, '0'],
        ['CARRYOVER', 'LOCAL', '70000000', null, '0'],
        ['OTHER', 'CENTRAL', '0', null, '0'],
        ['OTHER', 'LOCAL', '20000000', null, '0'],
      ]);
      expect(lines.every((entry) => typeof entry.cumulative_vnd === 'string' && typeof entry.allocated_vnd === 'string')).toBe(true);
      expect((await trail(idOf(made)))[0]).toMatchObject({
        action: 'dis.report_created',
        classification: 'INTERNAL',
        safe_diff: { project_code: `RP-${counter}`, revision: 1, cumulative_vnd: '420000000', ctmtqg_vnd: '40000000', reopened: false },
      });
    });

    it('AC-ST-DIS-003-2 / UAT-AC02 / FX-DIS-006: a CTMTQG of 120 million against a cell of 100 million is 422 SUBSET_EXCEEDS_PARENT on the CTMTQG field, and nothing is written', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const lines = [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '120000000' }];
      const refused = await create(draft(projectId, period, planId, { funding_lines: lines }));
      expect(refused).toMatchObject({ status: 422, json: { code: 'SUBSET_EXCEEDS_PARENT', parent_vnd: '100000000', subset_vnd: '120000000' } });
      expect(JSON.stringify(refused.json)).toContain('funding_lines[0].ctmtqg_subset_vnd');
      expect(await rows('select id from machvon.report_revision where project_id = $1', [projectId])).toHaveLength(0);
    });

    it('AC-ST-DIS-003-3 / UAT-PLAN-67: a second draft of the project in the period is 409 DRAFT_EXISTS with the first, and no second draft is written', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const first = await create(draft(projectId, period, planId));
      const again = await create(draft(projectId, period, planId), MAKER);
      expect(again).toMatchObject({ status: 409, json: { code: 'DRAFT_EXISTS', report_id: idOf(first), revision: 1, report_status: 'DRAFT' } });
      expect(await rows('select id from machvon.report_revision where project_id = $1 and period_id = $2', [projectId, period])).toHaveLength(1);
      await rows("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [idOf(first), memberId(MAKER)]);
      expect(await create(draft(projectId, period, planId))).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_id: idOf(first) } });
    });

    it('finds the plan version itself when the request names none: the one in force at the end of the period is captured with the draft, and a client operation sent again finds the same report', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const operation = randomUUID();
      const body = draft(projectId, period, planId, { client_operation_id: operation });
      delete body.plan_version_id;
      const made = await create(body);
      expect(made.status).toBe(200);
      expect((await read(idOf(made))).json).toMatchObject({ plan_version: { id: planId, revision: 1 }, totals: { allocated_vnd: '500000000' } });
      expect(await create(body)).toMatchObject({ status: 200, json: { resource_id: idOf(made) } });
      // Naming the plan version of the period is the same request; naming another is not.
      expect(await create({ ...body, plan_version_id: planId })).toMatchObject({ status: 200, json: { resource_id: idOf(made) } });
      expect(await create({ ...body, plan_version_id: randomUUID() })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
      // A save of the draft names no plan version either.
      const lines = [{ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '9' }];
      const saved = await save(idOf(made), { project_id: projectId, period_id: period, measurement_basis: 'YTD', funding_lines: lines }, 1);
      expect(saved).toMatchObject({ status: 200, json: { resource_version: 2 } });
    });

    it('answers a replay of the same request with the first body and writes one report', async () => {
      const { projectId, planId } = await seedProject();
      const body = draft(projectId, week(), planId);
      const options = { key: 'report-replay-key-0001' };
      const first = await create(body, MAKER, options);
      const again = await create(body, MAKER, options);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(again.json).toEqual(first.json);
      expect(await rows('select id from machvon.report_revision where project_id = $1', [projectId])).toHaveLength(1);
    });

    it('recognises a client operation sent again by a phone that lost the answer: the same entries get the same report, other entries are 409 IDEMPOTENCY_CONFLICT', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const operation = randomUUID();
      const first = await create(draft(projectId, period, planId, { client_operation_id: operation }));
      expect(first.status).toBe(200);
      const again = await create(draft(projectId, period, planId, { client_operation_id: operation }));
      expect(again).toMatchObject({ status: 200, json: { resource_id: idOf(first), status: 'DRAFT', resource_version: 1 } });
      expect(await rows('select id from machvon.report_revision where project_id = $1', [projectId])).toHaveLength(1);
      const changed = [{ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '1' }];
      expect(await create(draft(projectId, period, planId, { client_operation_id: operation, funding_lines: changed }))).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect((await trail(idOf(first))).map((entry) => entry.action)).toEqual(['dis.report_created', 'dis.report_replayed']);
    });

    it('refuses a project that is not in a stage that reports (422 PROJECT_STAGE_INVALID), and a plan version that is not the one in force at the end of the period (422 PLAN_VERSION_NOT_EFFECTIVE)', async () => {
      const concept = await seedProject({ status: 'CONCEPT' });
      expect(await create(draft(concept.projectId, week(), concept.planId))).toMatchObject({ status: 422, json: { code: 'PROJECT_STAGE_INVALID', project_status: 'CONCEPT' } });
      const { projectId, planId } = await seedProject();
      // A plan version of another project, one that does not exist, and one that is in force only after the period are not the plan of the period.
      const other = await seedProject();
      expect(await create(draft(projectId, week(), other.planId))).toMatchObject({ status: 422, json: { code: 'PLAN_VERSION_NOT_EFFECTIVE', effective_plan_version_id: planId } });
      expect(await create(draft(projectId, week(), randomUUID()))).toMatchObject({ status: 422, json: { code: 'PLAN_VERSION_NOT_EFFECTIVE' } });
      const late = await seedProject();
      await rows("update machvon.plan_version set effective_at = timestamptz '2027-12-01T00:00:00Z' where id = $1", [late.planId]);
      expect(await create(draft(late.projectId, week(), late.planId))).toMatchObject({ status: 422, json: { code: 'PLAN_VERSION_NOT_EFFECTIVE' } });
      expect(await rows('select id from machvon.report_revision where project_id = any($1::uuid[])', [[concept.projectId, projectId, late.projectId]])).toHaveLength(0);
    });

    it('takes no report for a period that is locked (409 PERIOD_LOCKED), and not for a period that is not there (404)', async () => {
      const { projectId, planId } = await seedProject();
      const locked = week();
      await lockPeriod(locked);
      expect(await create(draft(projectId, locked, planId))).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
      expect(await create(draft(projectId, randomUUID(), planId))).toMatchObject({ status: 404 });
    });

    it('takes a draft in a locked period for the projects a reopening named while its window is open, and for no other project, and not after the window (UAT, DIS 3 F1)', async () => {
      const named = await seedProject();
      const stranger = await seedProject();
      const locked = week();
      await lockPeriod(locked);
      /** A request is born REQUESTED and is approved by another person: the table keeps both steps. */
      const reopen = async (projects: string[], decided: string, until: string): Promise<void> => {
        const reopenId = randomUUID();
        await rows(
          `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, scope_project_ids, reason, requested_by, requested_window_hours, status, created_by, updated_by)
           values ($1, $2, $3, 'PROJECTS', $4::uuid[], 'The investor sent the figures after the period was locked.', $5, 72, 'REQUESTED', $5, $5)`,
          [TENANT_A, reopenId, locked, projects, memberId(MAKER)],
        );
        await rows(
          "update machvon.period_reopen set status = 'APPROVED', approved_by = $2, decided_by = $2, decided_at = $3::timestamptz, decision_reason = 'The delay was justified.', window_until = $4::timestamptz, version = version + 1 where id = $1",
          [reopenId, memberId(READER), decided, until],
        );
      };
      await reopen([named.projectId], '2026-12-14T00:00:00Z', '2026-12-17T00:00:00Z');
      const made = await create(draft(named.projectId, locked, named.planId));
      expect(made.status).toBe(200);
      expect((await trail(idOf(made)))[0]).toMatchObject({ action: 'dis.report_created', safe_diff: { reopened: true } });
      expect(await create(draft(stranger.projectId, locked, stranger.planId))).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
      // The window ends on time, whether or not a job has stored the expiry.
      const late = await seedProject();
      await reopen([late.projectId], '2026-12-01T00:00:00Z', '2026-12-04T00:00:00Z');
      expect(await create(draft(late.projectId, locked, late.planId))).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
    });

    it('keeps a weekly report to a week and a monthly report to a month (422 VALIDATION_FAILED on the type)', async () => {
      const { projectId, planId } = await seedProject();
      const reply = await create(draft(projectId, week(), planId, { report_type: 'MONTHLY' }));
      expect(reply).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(JSON.stringify(reply.json)).toContain('report_type');
    });

    it('refuses money that is not whole dong, a cell named twice, a subset in the other sources, and volumes and a narrative that are not valid, naming the field', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const bad = (extra: Record<string, unknown>) => create(draft(projectId, period, planId, extra));
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '-1' }] }, 'funding_lines[0].cumulative_vnd'],
        [{ funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '1.5' }] }, 'funding_lines[0].cumulative_vnd'],
        [{ funding_lines: [{ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '10', ctmtqg_subset_vnd: '1' }] }, 'funding_lines[0].ctmtqg_subset_vnd'],
        [{ funding_lines: [{ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '1' }, { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '2' }] }, 'funding_lines[1].bucket'],
        [{ negative_delta_explanation: 'short' }, 'negative_delta_explanation'],
        [{ construction_vnd: '5' }, 'acceptance_vnd'],
        [{ narrative: { results: 'x'.repeat(4001) } }, 'narrative.results'],
      ];
      for (const [extra, field] of cases) {
        const reply = await bad(extra);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        expect(JSON.stringify(reply.json)).toContain(field);
      }
      expect((await bad({ status: 'ACCEPTED' })).status).toBe(400);
      expect(await rows('select id from machvon.report_revision where project_id = $1', [projectId])).toHaveLength(0);
    });

    it('is for the maker who acts on the project: a reader and a person without the right to read it are 403, another branch and another tenant are 404', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      expect((await create(draft(projectId, period, planId), READER)).status).toBe(403);
      expect((await create(draft(projectId, period, planId), NOBODY)).status).toBe(403);
      // A person who may create but not read the project does not see it, and is told so as anybody would be.
      expect((await create(draft(projectId, period, planId), NO_READ)).status).toBe(404);
      expect((await create(draft(projectId, period, planId), ELSEWHERE_MAKER)).status).toBe(404);
      expect((await create(draft(projectId, period, planId), B_MAKER, { tenantId: TENANT_B })).status).toBe(404);
      expect(await rows('select id from machvon.report_revision where project_id = $1', [projectId])).toHaveLength(0);
    });
  });

  describe('post_reports_id_revisions', () => {
    it('saves the entries of the draft under its version: the cells are replaced, the plan allocation stays, the version moves and a new hash is given', async () => {
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, week(), planId));
      const before = (await read(idOf(made))).json;
      const lines = [
        { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '150000000', ctmtqg_subset_vnd: '60000000', next_month_vnd: '10000000', next_month_ctmtqg_subset_vnd: '2000000' },
        { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '5' },
      ];
      const saved = await save(idOf(made), draft(projectId, before.period ? (before.period as { id: string }).id : '', planId, { funding_lines: lines, measurement_basis: 'PERIOD' }), 1);
      expect(saved).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2, resource_id: idOf(made) } });
      const after = (await read(idOf(made))).json;
      expect(after).toMatchObject({ version: 2, measurement_basis: 'PERIOD', totals: { cumulative_vnd: '150000005', ctmtqg_vnd: '60000000', allocated_vnd: '500000000', next_month_vnd: '10000000', next_month_ctmtqg_vnd: '2000000' } });
      expect(after.payload_hash).not.toBe(before.payload_hash);
      expect((after.funding_lines as Array<Record<string, unknown>>)[0]).toMatchObject({ allocated_vnd: '500000000', cumulative_vnd: '150000000' });
      expect((await trail(idOf(made))).map((entry) => entry.action)).toEqual(['dis.report_created', 'dis.report_saved']);
    });

    it('AC-ST-DIS-003-2: a save with a CTMTQG above its cell is 422 SUBSET_EXCEEDS_PARENT and the draft stays as it was', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId));
      const lines = [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '120000000' }];
      expect(await save(idOf(made), draft(projectId, period, planId, { funding_lines: lines }), 1)).toMatchObject({ status: 422, json: { code: 'SUBSET_EXCEEDS_PARENT' } });
      expect(await state(idOf(made))).toMatchObject({ status: 'DRAFT', version: '1' });
      expect((await read(idOf(made))).json.totals).toMatchObject({ cumulative_vnd: '420000000', ctmtqg_vnd: '40000000' });
    });

    it('refuses a stale version (409 VERSION_CONFLICT), a revision that was handed in (409 REVISION_IMMUTABLE), and another project, period or plan than the draft was made for (422)', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId));
      expect(await save(idOf(made), draft(projectId, period, planId), 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const other = await seedProject();
      for (const [extra, field] of [
        [{ project_id: other.projectId }, 'project_id'],
        [{ period_id: week() }, 'period_id'],
        [{ plan_version_id: other.planId }, 'plan_version_id'],
        [{ report_type: 'MONTHLY' }, 'report_type'],
      ] as Array<[Record<string, unknown>, string]>) {
        const reply = await save(idOf(made), draft(projectId, period, planId, extra), 1);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        expect(JSON.stringify(reply.json)).toContain(field);
      }
      await rows("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [idOf(made), memberId(MAKER)]);
      expect(await save(idOf(made), draft(projectId, period, planId), 1)).toMatchObject({ status: 409, json: { code: 'REVISION_IMMUTABLE', report_status: 'SUBMITTED' } });
    });

    it('takes no save once the period is locked (409 PERIOD_LOCKED)', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId));
      await lockPeriod(period);
      expect(await save(idOf(made), draft(projectId, period, planId), 1)).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
      expect(await state(idOf(made))).toMatchObject({ version: '1' });
    });

    it('is for the maker who acts on the project: a reader is 403, another branch, another tenant and a report that is not there are 404', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId));
      expect((await save(idOf(made), draft(projectId, period, planId), 1, READER)).status).toBe(403);
      expect((await save(idOf(made), draft(projectId, period, planId), 1, ELSEWHERE_MAKER)).status).toBe(404);
      expect((await save(idOf(made), draft(projectId, period, planId), 1, B_MAKER, { tenantId: TENANT_B })).status).toBe(404);
      expect((await save(randomUUID(), draft(projectId, period, planId), 1)).status).toBe(404);
      expect(await state(idOf(made))).toMatchObject({ version: '1' });
    });
  });

  describe('the reads', () => {
    it('shows what the period before had reached for each cell, and a fall as a negative delta that needs an explanation (BR-DIS-03)', async () => {
      const { projectId, planId } = await seedProject();
      const first = week();
      const second = week();
      const earlier = await create(draft(projectId, first, planId));
      await rows("update machvon.report_revision set status = 'ACCEPTED', is_current = true, submitted_by = $2, accepted_by = $3, submitted_at = now(), accepted_at = now() where id = $1", [idOf(earlier), memberId(MAKER), memberId(READER)]);
      const falling = [
        { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '90000000' },
        { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '250000000' },
      ];
      const made = await create(draft(projectId, second, planId, { funding_lines: falling }));
      const found = (await read(idOf(made))).json;
      const lines = found.funding_lines as Array<Record<string, unknown>>;
      expect(lines.map((entry) => [entry.bucket, entry.budget_level, entry.previous_cumulative_vnd, entry.delta_vnd])).toEqual([
        ['CURRENT_YEAR', 'CENTRAL', '100000000', '-10000000'],
        ['CURRENT_YEAR', 'LOCAL', '200000000', '50000000'],
        ['CARRYOVER', 'CENTRAL', '30000000', '-30000000'],
        ['CARRYOVER', 'LOCAL', '70000000', '-70000000'],
        ['OTHER', 'CENTRAL', '0', '0'],
        ['OTHER', 'LOCAL', '20000000', '-20000000'],
      ]);
      expect(found.needs_explanation).toBe(true);
    });

    it('gives the report to a reader of the project and to the resource read, and hides it from another branch, another tenant, and a person who may read nothing', async () => {
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, week(), planId));
      expect((await read(idOf(made), READER)).status).toBe(200);
      const resource = await call('GET', `/resources/report_revision/${idOf(made)}`, { member: READER });
      expect(resource).toMatchObject({ status: 200, json: { id: idOf(made), totals: { cumulative_vnd: '420000000' } } });
      for (const hidden of [await read(idOf(made), ELSEWHERE_MAKER), await read(idOf(made), MAKER, TENANT_B), await read(randomUUID(), READER)]) expect(hidden.status).toBe(404);
      expect((await read(idOf(made), NOBODY)).status).toBe(403);
      expect((await call('GET', `/resources/report_revision/${idOf(made)}`, { member: ELSEWHERE_MAKER })).status).toBe(404);
    });

    it('AC-ST-DIS-003-4 / UI-DIS-01: lists the reports newest first with their totals, a page at a time, and carries the figures of the filter apart from the figures of the whole scope', async () => {
      const { projectId, planId } = await seedProject();
      const made: Reply[] = [];
      for (const cumulative of ['100', '200', '300']) {
        made.push(await create(draft(projectId, week(), planId, { funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: cumulative, ctmtqg_subset_vnd: '10' }] })));
      }
      const page = await call('GET', `/resources/report_revision?project_id=${projectId}&limit=2`, { member: READER });
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([idOf(made[2] as Reply), idOf(made[1] as Reply)]);
      expect(items[0]).toMatchObject({ project: { id: projectId }, status: 'DRAFT', revision: 1, report_type: 'WEEKLY', cumulative_vnd: '300', ctmtqg_vnd: '10', version: 1, is_late: false });
      expect(typeof page.json.next_cursor).toBe('string');
      const second = await call('GET', `/resources/report_revision?project_id=${projectId}&limit=2&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((second.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([idOf(made[0] as Reply)]);
      expect(second.json.next_cursor).toBeNull();
      expect(page.json.summary).toMatchObject({
        is_filtered: true,
        filtered: { reports: 3, projects: 1, cumulative_vnd: '600', ctmtqg_vnd: '30' },
        filters: { project_id: projectId, fiscal_year: null, status: null },
      });
      const whole = (page.json.summary as { scope: { reports: number } }).scope;
      expect(whole.reports).toBeGreaterThan(3);
      const everything = await call('GET', '/resources/report_revision?limit=1', { member: READER });
      expect((everything.json.summary as Record<string, unknown>).is_filtered).toBe(false);
      expect((everything.json.summary as { filtered: unknown; scope: unknown }).filtered).toEqual((everything.json.summary as { scope: unknown }).scope);
    });

    it('filters by year, period, plan, project, status and type, and refuses a filter that is not one (422)', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId));
      const ids = async (query: string): Promise<string[]> => ((await call('GET', `/resources/report_revision?${query}`, { member: READER })).json.items as Array<{ id: string }>).map((item) => item.id);
      expect(await ids(`project_id=${projectId}&fiscal_year=2027&period_id=${period}&plan_version_id=${planId}&status=DRAFT&report_type=WEEKLY`)).toEqual([idOf(made)]);
      for (const miss of ['status=ACCEPTED', 'report_type=MONTHLY', 'fiscal_year=1999', `period_id=${randomUUID()}`, `plan_version_id=${randomUUID()}`, `plan_id=${randomUUID()}`]) expect(await ids(`project_id=${projectId}&${miss}`)).toEqual([]);
      const capitalPlan = randomUUID();
      await seedReplica([['update machvon.plan_version set capital_plan_id = $2 where id = $1', [planId, capitalPlan]]]);
      expect(await ids(`project_id=${projectId}&plan_id=${capitalPlan}`)).toEqual([idOf(made)]);
      for (const bad of ['fiscal_year=20x7', 'status=NOPE', 'report_type=DAILY', 'project_id=nope', 'plan_id=nope', 'limit=0', 'limit=500', 'cursor=!!!', `cursor=${Buffer.from(JSON.stringify(['not a time', randomUUID()])).toString('base64url')}`, 'period_id=']) {
        const reply = await call('GET', `/resources/report_revision?${bad}`, { member: READER });
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
    });

    it('lists only the reports of the projects in the scope of the caller, and none of another tenant', async () => {
      const { projectId, planId } = await seedProject();
      await create(draft(projectId, week(), planId));
      const elsewhere = await call('GET', `/resources/report_revision?project_id=${projectId}`, { member: ELSEWHERE_MAKER });
      expect(elsewhere.json.items).toEqual([]);
      expect(elsewhere.json.summary).toMatchObject({ filtered: { reports: 0, cumulative_vnd: '0' } });
      const other = await call('GET', '/resources/report_revision', { member: B_MAKER, tenantId: TENANT_B });
      expect(other.json.items).toEqual([]);
      expect((await call('GET', '/resources/report_revision', { member: NOBODY })).status).toBe(403);
    });
  });

  describe('the volumes, the registration for next month, the narrative and the files (ST-DIS-004)', () => {
    const PROGRESS = { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5' };
    const periodDates = async (periodId: string): Promise<{ start: string; end: string }> => {
      const [row] = await rows<{ start: string; end: string }>('select start_date::text as start, end_date::text as end from machvon.reporting_period where id = $1', [periodId]);
      return row as { start: string; end: string };
    };
    const started = async (extra: Record<string, unknown> = {}, options: { allocate?: boolean } = {}) => {
      const { projectId, planId } = await seedProject(options);
      const period = week();
      const made = await create(draft(projectId, period, planId, extra));
      return { projectId, planId, period, reportId: idOf(made), made };
    };
    interface Finding {
      code: string;
      field: string;
      values: Record<string, string | null>;
    }
    /** The report as the read answers it; `review` is null for a report that was handed in, which the one test of it checks as such. */
    interface Found {
      progress: Record<string, unknown> | null;
      narrative: Record<string, unknown> | null;
      attachments: Array<{ file_object_id: string; file_sha256: string; file_name: string; content_type: string; size_bytes: number; position: number }>;
      review: { blocking: boolean; errors: Finding[]; warnings: Finding[] };
      funding_lines: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
      needs_explanation: boolean;
    }
    const readReport = async (reportId: string): Promise<Found> => (await read(reportId)).json as unknown as Found;
    const pdf = (text = 'a voucher'): Uint8Array => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF`);
    const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    async function upload(member: number, bytes: Uint8Array, options: { type?: string; name?: string; tenantId?: string; raw?: boolean } = {}): Promise<Reply> {
      const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(member, options.tenantId), 'idempotency-key': `key-${randomUUID()}` };
      let payload: FormData | Buffer;
      if (options.raw === true) {
        headers['content-type'] = 'application/pdf';
        payload = Buffer.from(bytes);
      } else {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: options.type ?? 'application/pdf' }), options.name ?? 'voucher.pdf');
        payload = form;
      }
      const response = await fetch(`${app.baseUrl}/report-files`, { method: 'POST', headers, body: payload });
      return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
    }
    const ref = (door: Reply) => ({ file_object_id: door.json.file_object_id, file_sha256: door.json.file_sha256, file_name: door.json.file_name });
    const attached = async (reportId: string): Promise<Array<{ file_name: string; position: number }>> => ((await readReport(reportId)).attachments as Array<{ file_name: string; position: number }>).map((file) => ({ file_name: file.file_name, position: file.position }));

    it('AC-ST-DIS-004-1 / UAT-AC264: saves the four volumes and the percent with the date of the period and the basis of the report, reads them back, and keeps them when a save does not name them', async () => {
      const { projectId, planId, period, reportId } = await started();
      expect((await readReport(reportId)).progress).toBeNull();
      const saved = await save(reportId, draft(projectId, period, planId, PROGRESS), 1);
      expect(saved).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2 } });
      const dates = await periodDates(period);
      expect((await readReport(reportId)).progress).toEqual({ ...PROGRESS, physical_progress_pct: '37.50', as_of_date: dates.end, measurement_basis: 'YTD' });
      expect(await rows('select construction_value_vnd::text as c, acceptance_value_vnd::text as a, treasury_submitted_value_vnd::text as t, preparing_dossier_value_vnd::text as p, physical_progress_pct::text as pct, as_of_date::text as d, measurement_basis as b from machvon.progress_snapshot where report_revision_id = $1', [reportId])).toEqual([
        { c: '300000000', a: '200000000', t: '150000000', p: '50000000', pct: '37.50', d: dates.end, b: 'YTD' },
      ]);
      // A save of the six cells that leaves the volumes out keeps them; a new basis moves them with it.
      const again = await save(reportId, draft(projectId, period, planId, { measurement_basis: 'PERIOD' }), 2);
      expect(again.json.resource_version).toBe(3);
      expect((await readReport(reportId)).progress).toMatchObject({ construction_vnd: '300000000', measurement_basis: 'PERIOD' });
      const entries = await trail(reportId);
      const last = entries.filter((entry) => entry.action === 'dis.report_saved')[0];
      expect(last?.safe_diff).toMatchObject({ measurement_basis: 'YTD', construction_vnd: '300000000', physical_progress_pct: '37.50' });
      expect(JSON.stringify(entries)).not.toContain('Foundations');
    });

    it('wants the four volumes together and refuses a negative amount, a fraction and a percent out of range, naming the field, and writes nothing', async () => {
      const { projectId, planId, period, reportId } = await started();
      const bad = (extra: Record<string, unknown>) => save(reportId, draft(projectId, period, planId, extra), 1);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ construction_vnd: '5' }, 'acceptance_vnd'],
        [{ physical_progress_pct: '10' }, 'construction_vnd'],
        [{ ...PROGRESS, acceptance_vnd: '-1' }, 'acceptance_vnd'],
        [{ ...PROGRESS, treasury_submitted_vnd: '1.5' }, 'treasury_submitted_vnd'],
        [{ ...PROGRESS, physical_progress_pct: '100.5' }, 'physical_progress_pct'],
        [{ ...PROGRESS, physical_progress_pct: '-3' }, 'physical_progress_pct'],
      ];
      for (const [extra, field] of cases) {
        const reply = await bad(extra);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        expect(JSON.stringify(reply.json)).toContain(field);
      }
      expect(await rows('select 1 from machvon.progress_snapshot where report_revision_id = $1', [reportId])).toEqual([]);
      expect((await state(reportId))?.version).toBe('1');
    });

    it('AC-ST-DIS-004-2 / UI-DIS-06: tells every error and every warning at once: a volume of 203.8% of the capital allocated, a gap above 5% with the Treasury and no registration for next month are warnings and do not block; the missing volumes are an error', async () => {
      const { projectId, planId, period, reportId } = await started();
      const dates = await periodDates(period);
      await seedReplica([
        [
          `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, import_id)
           values ($1, gen_random_uuid(), $2, $3, 'TREASURY', 380000000, ($4::date + time '09:00') at time zone 'Asia/Ho_Chi_Minh', $5, gen_random_uuid())`,
          [TENANT_A, projectId, `EXT-${randomUUID()}`, dates.start, 'e'.repeat(64)],
        ],
      ]);
      const before = (await readReport(reportId)).review;
      expect(before.blocking).toBe(true);
      expect(before.errors).toEqual([{ code: 'VALIDATION_FAILED', field: 'progress', values: { missing: 'construction_vnd' } }]);
      expect(before.warnings.map((finding)  => finding.code)).toEqual(['TREASURY_GAP', 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT']);
      expect(before.warnings[0]).toEqual({ code: 'TREASURY_GAP', field: 'funding_lines', values: { reported_vnd: '420000000', treasury_vnd: '380000000', gap_pct: '10.5' } });
      expect(before.warnings[1]?.values).toEqual({ remaining_vnd: '80000000' });

      await save(reportId, draft(projectId, period, planId, { ...PROGRESS, construction_vnd: '1019000000' }), 1);
      const after = (await readReport(reportId)).review;
      expect(after.blocking).toBe(false);
      expect(after.errors).toEqual([]);
      expect(after.warnings.map((finding)  => finding.code)).toEqual(['VOLUME_EXCEEDS_ALLOCATION', 'TREASURY_GAP', 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT']);
      expect(after.warnings[0]).toEqual({ code: 'VOLUME_EXCEEDS_ALLOCATION', field: 'progress.construction_vnd', values: { construction_vnd: '1019000000', allocated_vnd: '500000000', ratio_pct: '203.8' } });
      // The warnings do not stop a save, and the reader sees the same review.
      expect((await read(reportId, READER)).json.review).toEqual(after);
    });

    it('treats the window of the Treasury by the basis of the report: payments of the period for PERIOD, of the year for YTD, of all time for PROJECT_TO_DATE', async () => {
      const { projectId, planId, period, reportId } = await started({ measurement_basis: 'PERIOD' });
      const dates = await periodDates(period);
      const paid = (amount: string, at: string): [string, unknown[]] => [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, import_id)
         values ($1, gen_random_uuid(), $2, $3, 'TREASURY', $4::numeric, ($5::date + time '09:00') at time zone 'Asia/Ho_Chi_Minh', $6, gen_random_uuid())`,
        [TENANT_A, projectId, `EXT-${randomUUID()}`, amount, at, 'f'.repeat(64)],
      ];
      // 420 million paid before the year began and 420 million in the period: only the second counts for the basis PERIOD, both for PROJECT_TO_DATE.
      await seedReplica([paid('420000000', '2026-12-30'), paid('420000000', dates.start)]);
      const gaps = async (): Promise<string[]> => ((await readReport(reportId)).review.warnings as Array<{ code: string }>).map((finding) => finding.code);
      expect(await gaps()).not.toContain('TREASURY_GAP');
      await save(reportId, draft(projectId, period, planId, { measurement_basis: 'PROJECT_TO_DATE' }), 1);
      expect(await gaps()).toContain('TREASURY_GAP');
      await save(reportId, draft(projectId, period, planId, { measurement_basis: 'YTD' }), 2);
      expect(await gaps()).not.toContain('TREASURY_GAP');
    });

    it('reviews a period that was locked as an error, a plan version that is no longer the one in force as an error, and a report that was handed in as no review at all', async () => {
      const { projectId, planId, period, reportId } = await started({}, {});
      await save(reportId, draft(projectId, period, planId, PROGRESS), 1);
      expect((await readReport(reportId)).review.errors).toEqual([]);
      await lockPeriod(period);
      expect((await readReport(reportId)).review.errors).toEqual([{ code: 'PERIOD_LOCKED', field: 'period', values: {} }]);
      await seedReplica([["update machvon.plan_version set effective_at = timestamptz '2028-01-01T00:00:00Z' where id = $1", [planId]]]);
      expect((await readReport(reportId)).review.errors.map((finding)  => finding.code)).toEqual(['PERIOD_LOCKED', 'PLAN_VERSION_NOT_EFFECTIVE']);
      await rows("update machvon.report_revision set status = 'SUBMITTED', submitted_by = $2, submitted_at = now() where id = $1", [reportId, memberId(MAKER)]);
      expect((await readReport(reportId)).review).toBeNull();
    });

    it('reviews a fall below the period before as an error until it is explained', async () => {
      const { projectId, planId } = await seedProject();
      const earlier = await create(draft(projectId, week(), planId));
      await rows("update machvon.report_revision set status = 'ACCEPTED', is_current = true, submitted_by = $2, accepted_by = $3, submitted_at = now(), accepted_at = now() where id = $1", [idOf(earlier), memberId(MAKER), memberId(READER)]);
      const second = week();
      const falling = { ...PROGRESS, funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '90000000' }] };
      const made = await create(draft(projectId, second, planId, falling));
      expect((await readReport(idOf(made))).review.errors).toEqual([{ code: 'NEGATIVE_DELTA_EXPLANATION_REQUIRED', field: 'negative_delta_explanation', values: {} }]);
      await save(idOf(made), draft(projectId, second, planId, { ...falling, negative_delta_explanation: 'The Treasury returned a payment.' }), 1);
      expect((await readReport(idOf(made))).review.errors).toEqual([]);
    });

    it('AC-ST-DIS-004-3 / UAT-AC264: keeps the registration for next month with its CTMTQG per cell, adds it up, and refuses a CTMTQG above the registration', async () => {
      const { projectId, planId, period, reportId } = await started({
        funding_lines: FX_DIS_001.map((line, index) => (index === 0 ? { ...line, next_month_vnd: '300000000', next_month_ctmtqg_subset_vnd: '100000000' } : line)),
      });
      const found = await readReport(reportId);
      expect(found.funding_lines[0]).toMatchObject({ next_month_vnd: '300000000', next_month_ctmtqg_subset_vnd: '100000000' });
      expect(found.totals).toMatchObject({ next_month_vnd: '300000000', next_month_ctmtqg_vnd: '100000000' });
      expect(found.review.warnings.map((finding)  => finding.code)).not.toContain('NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT');
      const bad = await save(reportId, draft(projectId, period, planId, { funding_lines: FX_DIS_001.map((line, index) => (index === 0 ? { ...line, next_month_vnd: '10', next_month_ctmtqg_subset_vnd: '11' } : line)) }), 1);
      expect([bad.status, bad.json.code]).toEqual([422, 'SUBSET_EXCEEDS_PARENT']);
      expect(JSON.stringify(bad.json)).toContain('funding_lines[0].next_month_ctmtqg_subset_vnd');
      expect((await readReport(reportId)).funding_lines[0]).toMatchObject({ next_month_vnd: '300000000' });
    });

    it('keeps the narrative as a whole, with the issues of the project, and takes it away with an empty one', async () => {
      const { projectId, planId, period, reportId } = await started();
      const issue = randomUUID();
      const strange = randomUUID();
      const issueRow = (n: string, forProject: string): [string, unknown[]] => [
        `insert into machvon.issue (tenant_id, id, project_id, category_version_id, severity, assignee_id, due_at, status, version, code, title, description, source_module, reported_by, opened_at, owner_unit_id, sla_policy_id, response_due_at)
         values ($1, $2, $3, $4, 'MEDIUM', $5, now() + interval '7 days', 'OPEN', 1, $6, 'An issue', 'It is an issue', 'MANUAL', $5, now(), $7, $4, now() + interval '1 day')`,
        [TENANT_A, n, forProject, FUND_SOURCE, memberId(MAKER), `VM-2027-${String(100000 + (counter += 1))}`, unitId(DEPARTMENT)],
      ];
      const otherProject = await seedProject();
      await seedReplica([issueRow(issue, projectId), issueRow(strange, otherProject.projectId)]);
      const narrative = { results: '  Foundations are poured.  ', solutions: 'A second shift.', linked_issue_ids: [issue] };
      expect((await save(reportId, draft(projectId, period, planId, { narrative }), 1)).status).toBe(200);
      expect((await readReport(reportId)).narrative).toEqual({ results: 'Foundations are poured.', causes: null, solutions: 'A second shift.', proposals: null, linked_issue_ids: [issue] });
      const entries = await trail(reportId);
      expect(entries.find((entry) => entry.action === 'dis.report_saved')?.safe_diff).toMatchObject({ narrative_sections: 2, linked_issues: 1 });
      expect(JSON.stringify(entries)).not.toContain('Foundations');
      const outside = await save(reportId, draft(projectId, period, planId, { narrative: { results: 'x', linked_issue_ids: [issue, strange] } }), 2);
      expect([outside.status, outside.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(JSON.stringify(outside.json)).toContain('narrative.linked_issue_ids[1]');
      const unknown = await save(reportId, draft(projectId, period, planId, { narrative: { linked_issue_ids: [randomUUID()] } }), 2);
      expect(unknown.json.code).toBe('VALIDATION_FAILED');
      // A save that leaves the narrative out keeps it; an empty one removes it.
      expect((await save(reportId, draft(projectId, period, planId), 2)).json.resource_version).toBe(3);
      expect((await readReport(reportId)).narrative).toMatchObject({ results: 'Foundations are poured.' });
      expect((await save(reportId, draft(projectId, period, planId, { narrative: {} }), 3)).status).toBe(200);
      expect((await readReport(reportId)).narrative).toBeNull();
    });

    it('refuses a narrative with a text that is too long, a text that is not a text and issues that are too many, naming the field', async () => {
      const { projectId, planId, period, reportId } = await started();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ narrative: { results: 'x'.repeat(4001) } }, 'narrative.results'],
        [{ narrative: { linked_issue_ids: ['nope'] } }, 'narrative.linked_issue_ids'],
        [{ narrative: { linked_issue_ids: Array.from({ length: 51 }, () => randomUUID()) } }, 'narrative.linked_issue_ids'],
      ];
      for (const [extra, field] of cases) {
        const reply = await save(reportId, draft(projectId, period, planId, extra), 1);
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        expect(JSON.stringify(reply.json)).toContain(field);
      }
    });

    describe('the files (AC-ST-DIS-004-4, TH04)', () => {
      it('takes a clean file through the upload door and shows what it kept, and leaves a trail of the hash and the size, never the name', async () => {
        const bytes = pdf();
        const door = await upload(MAKER, bytes, { name: 'Chứng từ 01.pdf' });
        expect(door).toMatchObject({ status: 200, json: { file_sha256: shaOf(bytes), file_name: 'Chứng từ 01.pdf', content_type: 'application/pdf', size_bytes: bytes.length } });
        expect(door.json.file_object_id).toMatch(/^[0-9a-f-]{36}$/);
        const entries = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'dis.report_file_uploaded' and resource_id::text = $1", [door.json.file_object_id as string]);
        expect(entries.map((entry) => entry.safe_diff)).toEqual([{ file_sha256: shaOf(bytes), size_bytes: bytes.length, content_type: 'application/pdf' }]);
        expect(JSON.stringify(entries)).not.toContain('Chứng');
      });

      it('refuses an infected file (422 FILE_NOT_CLEAN), a file that is not what it says (422 FILE_TYPE_NOT_ALLOWED) and one that is too large (413), and keeps none of them', async () => {
        const infected = new Uint8Array([...pdf(), ...eicarBytes()]);
        const before = (await readdir(root, { recursive: true })).length;
        expect(await upload(MAKER, infected)).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
        expect((await readdir(root, { recursive: true })).length).toBe(before);
        expect(await upload(MAKER, new TextEncoder().encode('MZ this is a program'))).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
        expect(await upload(MAKER, pdf(), { type: 'image/svg+xml' })).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
        const large = new Uint8Array(26 * 1024 * 1024);
        large.set(pdf());
        expect(await upload(MAKER, large)).toMatchObject({ status: 413, json: { code: 'PAYLOAD_TOO_LARGE' } });
        expect((await upload(MAKER, pdf(), { raw: true })).status).toBe(400);
        expect((await readdir(root, { recursive: true })).length).toBe(before);
      });

      it('is for the maker: a reader and a person with no right are refused (403)', async () => {
        expect((await upload(READER, pdf())).status).toBe(403);
        expect((await upload(NOBODY, pdf())).status).toBe(403);
      });

      it('attaches the files a person names as the whole list, in order, and keeps them when a save does not name them', async () => {
        const { projectId, planId, period, reportId } = await started();
        const [one, two] = [await upload(MAKER, pdf('one'), { name: 'one.pdf' }), await upload(MAKER, pdf('two'), { name: 'two.pdf' })];
        const saved = await save(reportId, draft(projectId, period, planId, { attachments: [ref(two), ref(one)] }), 1);
        expect(saved.status).toBe(200);
        expect(await attached(reportId)).toEqual([
          { file_name: 'two.pdf', position: 1 },
          { file_name: 'one.pdf', position: 2 },
        ]);
        const detail = await readReport(reportId);
        expect(detail.attachments[0]).toMatchObject({ file_object_id: two.json.file_object_id, file_sha256: two.json.file_sha256, content_type: 'application/pdf', size_bytes: (pdf('two') as Uint8Array).length });
        expect((await save(reportId, draft(projectId, period, planId), 2)).status).toBe(200);
        expect(await attached(reportId)).toHaveLength(2);
        expect((await save(reportId, draft(projectId, period, planId, { attachments: [ref(one)] }), 3)).status).toBe(200);
        expect(await attached(reportId)).toEqual([{ file_name: 'one.pdf', position: 1 }]);
        expect((await trail(reportId)).filter((entry) => entry.action === 'dis.report_saved').pop()?.safe_diff).toMatchObject({ attachments: 1 });
        expect((await save(reportId, draft(projectId, period, planId, { attachments: [] }), 4)).status).toBe(200);
        expect(await attached(reportId)).toEqual([]);
      });

      it('does not link a file with another hash (422 HASH_MISMATCH), one that does not exist or belongs to another tenant (422), one that is infected (422 FILE_NOT_CLEAN) or not yet scanned (409 SCAN_PENDING)', async () => {
        const { projectId, planId, period, reportId } = await started();
        const good = await upload(MAKER, pdf('good'));
        const link = (attachments: unknown[]) => save(reportId, draft(projectId, period, planId, { attachments }), 1);
        expect(await link([{ ...ref(good), file_sha256: 'a'.repeat(64) }])).toMatchObject({ status: 422, json: { code: 'HASH_MISMATCH' } });
        const missing = await link([{ ...ref(good), file_object_id: randomUUID() }]);
        expect([missing.status, missing.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        expect(JSON.stringify(missing.json)).toContain('attachments[0].file_object_id');
        // A file of another tenant is a file that does not exist.
        const foreign = await upload(B_MAKER, pdf('foreign'), { tenantId: TENANT_B });
        expect(foreign.status).toBe(200);
        const crossed = await link([ref(foreign)]);
        expect([crossed.status, crossed.json.code]).toEqual([422, 'VALIDATION_FAILED']);
        const tenantA = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
        const bad = new Uint8Array([...pdf('bad'), ...eicarBytes()]);
        const infectedKey = (await files.upload(tenantA, { purpose: 'document', declaredType: 'application/pdf', bytes: bad })).key;
        expect(await link([{ file_object_id: infectedKey.split('/').pop(), file_sha256: shaOf(bad), file_name: 'bad.pdf' }])).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
        const pendingId = randomUUID();
        const pending = pdf('pending');
        await new FsObjectStorage(root).put(tenantA, objectKey(TENANT_A, 'document', pendingId), pending, { contentType: 'application/pdf' });
        expect(await link([{ file_object_id: pendingId, file_sha256: shaOf(pending), file_name: 'pending.pdf' }])).toMatchObject({ status: 409, json: { code: 'SCAN_PENDING' } });
        expect(await attached(reportId)).toEqual([]);
        expect((await state(reportId))?.version).toBe('1');
      });

      it('refuses a list of more than 20 files, a file named twice, a name that is a path and a hash that is not one, naming the field', async () => {
        const { projectId, planId, period, reportId } = await started();
        const door = await upload(MAKER, pdf('x'));
        const cases: Array<[unknown[], string]> = [
          [Array.from({ length: 21 }, () => ref(door)), 'attachments'],
          [[ref(door), ref(door)], 'attachments[1].file_object_id'],
          [[{ ...ref(door), file_name: '../x.pdf' }], 'attachments[0].file_name'],
          [[{ ...ref(door), file_sha256: 'xyz' }], 'attachments.file_sha256'],
        ];
        for (const [attachments, field] of cases) {
          const reply = await save(reportId, draft(projectId, period, planId, { attachments }), 1);
          expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
          expect(JSON.stringify(reply.json)).toContain(field);
        }
      });

      it('answers a client operation sent again with the same volumes and files with the first report, and one with other volumes as a mistake of the client', async () => {
        const { projectId, planId, period } = await seedProject().then((seeded) => ({ ...seeded, period: week() }));
        const door = await upload(MAKER, pdf('replay'));
        const operation = randomUUID();
        const entered = { client_operation_id: operation, ...PROGRESS, attachments: [ref(door)], narrative: { results: 'Done' } };
        const first = await create(draft(projectId, period, planId, entered));
        expect(first.status).toBe(200);
        const again = await create(draft(projectId, period, planId, entered));
        expect(idOf(again)).toBe(idOf(first));
        const other = await create(draft(projectId, period, planId, { ...entered, construction_vnd: '1' }));
        expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
        const detail = await readReport(idOf(first));
        expect(detail).toMatchObject({ progress: { construction_vnd: '300000000' }, narrative: { results: 'Done' } });
        expect(detail.attachments).toHaveLength(1);
      });
    });
  });

  describe('post_reports_id_submit (ST-DIS-005)', () => {
    const PROGRESS = { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5' };
    const submit = (reportId: string, version: number | string, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> =>
      call('POST', `/reports/${reportId}/submit`, { member, ifMatch: `"${version}"`, body: {}, ...options });
    /** A draft of FX-DIS-001 with the volumes entered, saved twice so that it stands at version 3 (the screen of the story shows it so). */
    const ready = async (extra: Record<string, unknown> = {}, options: { project?: { projectId: string; planId: string }; period?: string } = {}) => {
      const { projectId, planId } = options.project ?? (await seedProject());
      const period = options.period ?? week();
      const made = await create(draft(projectId, period, planId, { ...PROGRESS, ...extra }));
      const reportId = idOf(made);
      await save(reportId, draft(projectId, period, planId, { ...PROGRESS, ...extra }), 1);
      await save(reportId, draft(projectId, period, planId, { ...PROGRESS, ...extra }), 2);
      return { projectId, planId, period, reportId };
    };
    const readReport = async (reportId: string): Promise<{ funding_lines: Array<Record<string, unknown>> }> => (await read(reportId)).json as unknown as { funding_lines: Array<Record<string, unknown>> };
    const events = (reportId: string) => rows<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1 and type = 'report.submitted.v1'", [reportId]);
    const sealed = async (reportId: string) =>
      (await rows<{ status: string; version: string; submitted_by: string | null; submitted_at: string | null; is_late: boolean; payload_hash: string; is_current: boolean; workflow_version_id: string | null }>(
        'select status, version::text as version, submitted_by, submitted_at::text as submitted_at, is_late, payload_hash, is_current, workflow_version_id from machvon.report_revision where id = $1',
        [reportId],
      ))[0];

    it('AC-ST-DIS-005-1 / UAT-AC01 / AC-ST-DIS-005-6: hands in FX-DIS-001 at version 3 once, however often the same key is sent: SUBMITTED, one audit row, one report.submitted.v1 with is_late and the hash, one count', async () => {
      const { reportId } = await ready();
      expect((await state(reportId))?.version).toBe('3');
      const key = `key-${randomUUID()}`;
      const first = await submit(reportId, 3, MAKER, { key });
      expect(first).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 4, resource_id: reportId, is_late: false, period_delta_vnd: null } });
      // Nothing is registered for next month while 80 million of the capital allocated is left: told with the answer, and it does not stop the send.
      expect(first.json.warnings).toEqual([{ code: 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT', field: 'funding_lines', values: { remaining_vnd: '80000000' } }]);
      const again = await submit(reportId, 3, MAKER, { key });
      expect(again.status).toBe(200);
      expect(again.json).toEqual(first.json);
      const row = await sealed(reportId);
      expect(row).toMatchObject({ status: 'SUBMITTED', version: '4', submitted_by: memberId(MAKER), is_late: false, is_current: false, workflow_version_id: null });
      expect(first.json.payload_hash).toBe(row?.payload_hash);
      expect(first.json.payload_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.json.submitted_at).toBe(now.toISOString());
      expect(Date.parse(row?.submitted_at ?? '')).toBe(now.getTime());
      const trailed = (await trail(reportId)).filter((entry) => entry.action === 'dis.report_submitted');
      expect(trailed).toHaveLength(1);
      expect(trailed[0]?.safe_diff).toMatchObject({ revision: 1, is_late: false, payload_hash: row?.payload_hash, cumulative_vnd: '420000000', ctmtqg_vnd: '40000000', period_delta_vnd: null, reopened: false, version: 4 });
      const emitted = await events(reportId);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({ report_id: reportId, revision: 1, report_type: 'WEEKLY', is_late: false, payload_hash: row?.payload_hash, submitted_at: now.toISOString(), cumulative_vnd: '420000000', ctmtqg_vnd: '40000000' });
      expect(counted).toEqual([{ name: 'dis_submit_total', labels: { late: 'false' } }]);
    });

    it('seals the hash of what the draft held, which the saves had sealed already, and lets nothing of it change afterwards (UAT-AC247)', async () => {
      const { projectId, planId, period, reportId } = await ready();
      const before = (await sealed(reportId))?.payload_hash;
      const handed = await submit(reportId, 3);
      expect(handed.json.payload_hash).toBe(before);
      expect(await save(reportId, draft(projectId, period, planId, PROGRESS), 4)).toMatchObject({ status: 409, json: { code: 'REVISION_IMMUTABLE' } });
      await expect(rows("update machvon.report_revision set submitted_at = now() - interval '1 day' where id = $1", [reportId])).rejects.toMatchObject({ constraint: 'report_revision_sealed_guard' });
      await expect(rows('update machvon.report_revision set is_late = true where id = $1', [reportId])).rejects.toMatchObject({ constraint: 'report_revision_sealed_guard' });
      await expect(rows("update machvon.report_revision set submitted_by = null, status = 'SUBMITTED' where id = $1", [reportId])).rejects.toBeDefined();
      expect((await sealed(reportId))?.is_late).toBe(false);
    });

    it('UAT-AC07: judges the lateness by the calendar of the period to the second: on time up to the deadline, late after it', async () => {
      const first = await ready();
      const second = await ready();
      const deadline = async (periodId: string): Promise<number> => Date.parse((await rows<{ at: string }>('select deadline_at::text as at from machvon.reporting_period where id = $1', [periodId]))[0]?.at ?? '');
      try {
        clockNow = new Date((await deadline(first.period)) - 1000);
        expect((await submit(first.reportId, 3)).json.is_late).toBe(false);
        clockNow = new Date((await deadline(second.period)) + 1000);
        const late = await submit(second.reportId, 3);
        expect(late.json.is_late).toBe(true);
        expect((await sealed(second.reportId))?.is_late).toBe(true);
        expect((await events(second.reportId))[0]?.payload.is_late).toBe(true);
        expect(counted.slice(-1)).toEqual([{ name: 'dis_submit_total', labels: { late: 'true' } }]);
      } finally {
        clockNow = now;
      }
    });

    it('AC-ST-DIS-005-2 / UAT-AC03: refuses a period that was locked with no reopening (409 PERIOD_LOCKED) and leaves the draft as it was; takes it for the project a reopening names', async () => {
      const locked = await ready();
      await lockPeriod(locked.period);
      const refused = await submit(locked.reportId, 3);
      expect([refused.status, refused.json.code]).toEqual([409, 'PERIOD_LOCKED']);
      expect(await sealed(locked.reportId)).toMatchObject({ status: 'DRAFT', version: '3', submitted_by: null });
      expect((await trail(locked.reportId)).filter((entry) => entry.action === 'dis.report_submitted')).toEqual([]);
      expect(await events(locked.reportId)).toEqual([]);
      const reopenId = randomUUID();
      await rows(
        `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, scope_project_ids, reason, requested_by, requested_window_hours, status, created_by, updated_by)
         values ($1, $2, $3, 'PROJECTS', $4::uuid[], 'The investor sent the figures after the period was locked.', $5, 72, 'REQUESTED', $5, $5)`,
        [TENANT_A, reopenId, locked.period, [locked.projectId], memberId(MAKER)],
      );
      await rows(
        "update machvon.period_reopen set status = 'APPROVED', approved_by = $2, decided_by = $2, decided_at = $3::timestamptz, decision_reason = 'The delay was justified.', window_until = $4::timestamptz, version = version + 1 where id = $1",
        [reopenId, memberId(READER), '2026-12-14T00:00:00Z', '2026-12-17T00:00:00Z'],
      );
      const taken = await submit(locked.reportId, 3);
      expect(taken.status).toBe(200);
      expect((await trail(locked.reportId)).find((entry) => entry.action === 'dis.report_submitted')?.safe_diff).toMatchObject({ reopened: true });
    });

    it('AC-ST-DIS-005-3 / UAT-AC248: of two makers at version 3 at once, one hands in (version 4) and the other is 409 VERSION_CONFLICT naming the version that won; one event', async () => {
      const { reportId } = await ready();
      const [one, other] = await Promise.all([submit(reportId, 3), submit(reportId, 3)]);
      const won = [one, other].filter((reply) => reply.status === 200);
      const lost = [one, other].filter((reply) => reply.status !== 200);
      expect(won).toHaveLength(1);
      expect(won[0]?.json).toMatchObject({ status: 'SUBMITTED', resource_version: 4 });
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 4 } });
      expect(await events(reportId)).toHaveLength(1);
      expect((await trail(reportId)).filter((entry) => entry.action === 'dis.report_submitted')).toHaveLength(1);
    });

    it('AC-ST-DIS-005-4 / UAT-AC249: answers the same key with the same answer, refuses the same key with another request (409 IDEMPOTENCY_CONFLICT) and a new key for a report that was handed in (409)', async () => {
      const { reportId } = await ready();
      const key = `key-${randomUUID()}`;
      const first = await submit(reportId, 3, MAKER, { key });
      expect((await submit(reportId, 3, MAKER, { key })).json).toEqual(first.json);
      const changed = await submit(reportId, 4, MAKER, { key });
      expect([changed.status, changed.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect(await submit(reportId, 4)).toMatchObject({ status: 409, json: { code: 'REVISION_IMMUTABLE' } });
      expect(await submit(reportId, 3)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 4 } });
      expect((await trail(reportId)).filter((entry) => entry.action === 'dis.report_submitted')).toHaveLength(1);
      expect(await events(reportId)).toHaveLength(1);
      expect((await state(reportId))?.version).toBe('4');
    });

    it('AC-ST-DIS-005-5 / UAT-AC250: refuses a cumulative that fell from 150 million to 120 million until it is explained (422), then hands it in with the warning and the change of -30 million', async () => {
      const { projectId, planId } = await seedProject();
      const cell = (amount: string) => [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: amount, next_month_vnd: '10' }];
      const earlier = await create(draft(projectId, week(), planId, { funding_lines: cell('150000000') }));
      await rows("update machvon.report_revision set status = 'ACCEPTED', is_current = true, submitted_by = $2, accepted_by = $3, submitted_at = now(), accepted_at = now() where id = $1", [idOf(earlier), memberId(MAKER), memberId(READER)]);
      const period = week();
      const made = await create(draft(projectId, period, planId, { ...PROGRESS, funding_lines: cell('120000000') }));
      const reportId = idOf(made);
      const refused = await submit(reportId, 1);
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'NEGATIVE_DELTA_EXPLANATION_REQUIRED', 'negative_delta_explanation']);
      expect((await sealed(reportId))?.status).toBe('DRAFT');
      await save(reportId, draft(projectId, period, planId, { ...PROGRESS, funding_lines: cell('120000000'), negative_delta_explanation: 'The Treasury returned a payment.' }), 1);
      const handed = await submit(reportId, 2);
      expect(handed).toMatchObject({ status: 200, json: { status: 'SUBMITTED', period_delta_vnd: '-30000000' } });
      expect(handed.json.warnings).toEqual([{ code: 'NEGATIVE_DELTA', field: 'negative_delta_explanation', values: { delta_vnd: '-30000000' } }]);
      expect((await trail(reportId)).find((entry) => entry.action === 'dis.report_submitted')?.safe_diff).toMatchObject({ period_delta_vnd: '-30000000', warnings: ['NEGATIVE_DELTA'] });
      // The explanation is kept as it was written, and the words are not in the trail.
      expect((await readReport(reportId)).funding_lines[0]).toMatchObject({ delta_vnd: '-30000000' });
      expect(JSON.stringify(await trail(reportId))).not.toContain('Treasury returned');
    });

    it('refuses a draft with errors with the first error as the problem and the codes of all of them, and changes nothing: no volumes, a plan version that is no longer in force', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const reportId = idOf(await create(draft(projectId, period, planId)));
      const noVolumes = await submit(reportId, 1);
      expect([noVolumes.status, noVolumes.json.code, noVolumes.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'progress']);
      expect(noVolumes.json.error_codes).toEqual(['VALIDATION_FAILED']);
      await save(reportId, draft(projectId, period, planId, PROGRESS), 1);
      await seedReplica([["update machvon.plan_version set effective_at = timestamptz '2028-01-01T00:00:00Z' where id = $1", [planId]]]);
      const stale = await submit(reportId, 2);
      expect([stale.status, stale.json.code]).toEqual([422, 'PLAN_VERSION_NOT_EFFECTIVE']);
      expect(await sealed(reportId)).toMatchObject({ status: 'DRAFT', version: '2' });
      expect(await events(reportId)).toEqual([]);
    });

    it('goes with the workflow of the review that is published for reports, when there is one', async () => {
      const { reportId } = await ready();
      const workflowId = randomUUID();
      await seedReplica([
        ["insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, created_by, definition_hash) values ($1, $2, 'DIS_REPORT_REVIEW', 1, '{}'::jsonb, 'Draft', $3, repeat('a', 64))", [TENANT_A, workflowId, memberId(MAKER)]],
        ["insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, created_by, definition_hash) values ($1, $2, 'DIS_REPORT_REVIEW', 2, '{}'::jsonb, 'Published', $3, repeat('b', 64))", [TENANT_A, randomUUID(), memberId(MAKER)]],
        // A notification workflow of the same business type with a higher revision is not the review of the report.
        ["insert into machvon.workflow_version (tenant_id, id, business_type, kind, event_type, revision, definition_json, status, created_by, definition_hash) values ($1, $2, 'DIS_REPORT_REVIEW', 'NOTIFICATION', 'report.submitted.v1', 3, '{}'::jsonb, 'Published', $3, repeat('c', 64))", [TENANT_A, randomUUID(), memberId(MAKER)]],
      ]);
      const newest = (await rows<{ id: string }>("select id from machvon.workflow_version where business_type = 'DIS_REPORT_REVIEW' and kind = 'APPROVAL' and status = 'Published'"))[0]?.id;
      expect((await submit(reportId, 3)).status).toBe(200);
      expect((await sealed(reportId))?.workflow_version_id).toBe(newest);
    });

    it('AC-ST-DIS-005-8 / UAT-AC265: is for the maker who acts on the project: a reader and a person with no right are 403, another branch and another tenant are 404 and learn nothing', async () => {
      const { reportId } = await ready();
      expect((await submit(reportId, 3, READER)).status).toBe(403);
      expect((await submit(reportId, 3, NOBODY)).status).toBe(403);
      expect((await submit(reportId, 3, ELSEWHERE_MAKER)).status).toBe(404);
      const other = await submit(reportId, 3, B_MAKER, { tenantId: TENANT_B });
      expect(other.status).toBe(404);
      const missing = await submit(randomUUID(), 3, B_MAKER, { tenantId: TENANT_B });
      expect(other.json.code).toBe(missing.json.code);
      expect(JSON.stringify(other.json)).not.toContain(reportId);
      expect((await call('GET', `/reports/${reportId}`, { member: B_MAKER, tenantId: TENANT_B })).status).toBe(404);
      expect(await sealed(reportId)).toMatchObject({ status: 'DRAFT', version: '3' });
    });

    it('AC-ST-DIS-005-7 / UAT-NFR-OPERABILITY-05: leaves one logical event under one key for the consumers to take once: the relay and the inbox of the kernel make the redelivery harmless', async () => {
      const { reportId } = await ready();
      await submit(reportId, 3);
      const rowsOf = await rows<{ event_key: string }>("select event_key from machvon.outbox_event where aggregate_id = $1 and type = 'report.submitted.v1'", [reportId]);
      expect(rowsOf.map((row) => row.event_key)).toEqual([`report_revision:${reportId}:submitted`]);
    });
  });
});
