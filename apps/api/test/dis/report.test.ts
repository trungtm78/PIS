import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { BASELINE_PACK, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { ReportController, ReportReadsController } from '../../src/modules/dis/report.controller';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
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
  const now = new Date('2026-12-15T00:00:00Z');
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
    await harness.seedRole(TENANT_A, 1, 'DIS_MAKER', ['report.create', 'report.edit', 'report.read', 'report_revision.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'DIS_READER', ['report.read', 'report_revision.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'DIS_WRITER', ['report.create', 'report.edit'], 25);
    await harness.seedRole(TENANT_B, 1, 'DIS_MAKER', ['report.create', 'report.edit', 'report.read', 'report_revision.read'], 30);
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
    weeks = (await rows<{ id: string }>("select id from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' order by start_date")).map((row) => row.id);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportController, ReportReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => now },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('serves the controllers of the report in the module of DIS', () => {
    expect(disModule.controllers.slice(-2)).toEqual([ReportController, ReportReadsController]);
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

    it('refuses money that is not whole dong, a cell named twice, a subset in the other sources, and the members that belong to the next story, naming the field', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const bad = (extra: Record<string, unknown>) => create(draft(projectId, period, planId, extra));
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '-1' }] }, 'funding_lines[0].cumulative_vnd'],
        [{ funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '1.5' }] }, 'funding_lines[0].cumulative_vnd'],
        [{ funding_lines: [{ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '10', ctmtqg_subset_vnd: '1' }] }, 'funding_lines[0].ctmtqg_subset_vnd'],
        [{ funding_lines: [{ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '1' }, { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '2' }] }, 'funding_lines[1].bucket'],
        [{ negative_delta_explanation: 'short' }, 'negative_delta_explanation'],
        [{ construction_vnd: '5' }, 'construction_vnd'],
        [{ narrative: {} }, 'narrative'],
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
});
