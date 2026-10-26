import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { BASELINE_PACK, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { PeriodSnapshotController } from '../../src/modules/dis/period-snapshot.controller';
import { ReportDecisionController } from '../../src/modules/dis/report-decision.controller';
import { ReportSubmitController } from '../../src/modules/dis/report-submit.controller';
import { ReportController, ReportReadsController } from '../../src/modules/dis/report.controller';
import { DIS_CLOCK, DIS_METRICS } from '../../src/modules/dis/tokens';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const MAKER = 1; // makes and hands in the reports
const REVIEWER = 2; // accepts them
const BUILDER = 3; // builds and freezes over the whole tenant
const BUILD_ONLY = 4; // builds, does not freeze
const ELSEWHERE_BUILDER = 5; // builds over another branch, where the projects are not
const READER = 6; // reads the figures over the whole tenant
const ELSEWHERE_READER = 7; // reads the figures of another branch
const NOBODY = 8; // holds nothing of the figures
const B_BUILDER = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x9f;
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

const FX_DIS_001 = [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
  { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
  { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
];
const PROGRESS = { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5' };

interface Week {
  id: string;
  start: string;
  end: string;
}

/** The close and freeze of the figures of a period over HTTP (ST-DIS-009, DIS-21). */
describe('the period snapshot over HTTP (ST-DIS-009)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  /** The day of the tests: after the first weeks of 2027, so that a cutoff in them is not in the future. */
  const clockNow = new Date('2027-12-15T03:00:00Z');
  const counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  let counter = 0;
  let weeks: Week[] = [];
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
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  const plusDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  /** A project of the department (or of another branch) with a plan version of 2027 in force from December 2026 that allocated 500,000,000 to the year plan of the central budget. */
  async function seedProject(unit = DEPARTMENT): Promise<{ projectId: string; planId: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const planId = randomUUID();
    const code = `SN-${counter}`;
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, `Project ${code}`, unitId(unit), AREA],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2027, 1, $4, 'PUBLISHED', timestamptz '2026-12-20T01:00:00Z')`,
        [TENANT_A, planId, projectId, DECISION],
      ],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level, origin)
         values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', 2027, 500000000, 0, $4, 'CENTRAL', 'PM_ASSIGNED')`,
        [TENANT_A, planId, FUND_SOURCE, projectId],
      ],
    ]);
    return { projectId, planId, code };
  }

  const week = (): Week => {
    const found = weeks[nextWeek];
    nextWeek += 1;
    if (found === undefined) throw new Error('the calendar of 2027 ran out of weeks');
    return found;
  };

  const paid = (projectId: string, amount: string, at: string, refundOf: string | null = null, n: string = randomUUID()): [string, unknown[]] => [
    `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, reversal_of_id, import_id)
     values ($1, $2, $3, $4, 'TREASURY', $5::numeric, $6::timestamptz, $7, $8, $9, gen_random_uuid())`,
    [TENANT_A, n, projectId, `EXT-${n}`, amount, at, 'd'.repeat(64), refundOf === null ? 'PAYMENT' : 'REFUND', refundOf],
  ];

  const draft = (projectId: string, periodId: string, planId: string): Record<string, unknown> => ({
    project_id: projectId,
    period_id: periodId,
    plan_version_id: planId,
    report_type: 'WEEKLY',
    measurement_basis: 'YTD',
    funding_lines: FX_DIS_001,
    ...PROGRESS,
  });

  /** The report of a project in a week, handed in by the maker and accepted by the reviewer. */
  async function accepted(project: { projectId: string; planId: string }, period: Week): Promise<string> {
    const made = await call('POST', '/reports', { member: MAKER, body: draft(project.projectId, period.id, project.planId) });
    expect(made.status).toBe(200);
    expect(await call('POST', `/reports/${idOf(made)}/submit`, { member: MAKER, ifMatch: '"1"', body: {} })).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
    const decided = await call('POST', `/reports/${idOf(made)}/decision`, { member: REVIEWER, ifMatch: '"2"', body: { decision: 'approve', reason: 'The figures agree with the Treasury.', evidence_ids: [] } });
    expect(decided).toMatchObject({ status: 200, json: { status: 'ACCEPTED' } });
    return idOf(made);
  }

  const softClose = (periodId: string): Promise<unknown> => rows("update machvon.reporting_period set status = 'SOFT_CLOSED', soft_closed_at = now(), version = version + 1 where id = $1 and status = 'OPEN'", [periodId]);
  const build = (body: Record<string, unknown>, member = BUILDER, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', '/period-snapshots', { member, body, ...options });
  const closeBody = (period: Week, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ period_id: period.id, snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: period.end, ...extra });
  const freeze = (snapshotId: string, version: number, member = BUILDER, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', `/period-snapshots/${snapshotId}/freeze`, { member, body: {}, ifMatch: `"${version}"`, ...options });
  const lines = (snapshotId: string, member = READER, query = '', tenantId?: string): Promise<Reply> => call('GET', `/period-snapshots/${snapshotId}/lines${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const listed = (query: string, member = READER): Promise<Reply> => call('GET', `/period-snapshots${query}`, { member });
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const trail = (resourceId: string) => rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  const events = (snapshotId: string, type: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [snapshotId, type]);
  const cell = (reply: Reply, code: string, bucket: string, level: string) => items(reply).find((line) => line.project_code === code && line.bucket === bucket && line.budget_level === level);

  /** A week with a project that has its report accepted and 250 million paid net by the Treasury; the period is soft closed. */
  async function standard(unit = DEPARTMENT): Promise<{ period: Week; projectId: string; planId: string; code: string; reportId: string }> {
    const project = await seedProject(unit);
    const period = week();
    const first = randomUUID();
    await seedReplica([paid(project.projectId, '300000000', `${period.start}T09:00:00+07:00`, null, first), paid(project.projectId, '50000000', `${plusDays(period.start, 1)}T09:00:00+07:00`, first)]);
    const reportId = await accepted(project, period);
    await softClose(period.id);
    return { period, ...project, reportId };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MAKER, REVIEWER, BUILDER, BUILD_ONLY, ELSEWHERE_BUILDER, READER, ELSEWHERE_READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_BUILDER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'DIS_MAKER', ['report.create', 'report.edit', 'report.submit', 'report.read', 'report_revision.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'DIS_REVIEWER', ['report.review', 'report.read', 'report_revision.read'], 25);
    await harness.seedRole(TENANT_A, 3, 'DIS_SNAPSHOT_MANAGER', ['snapshot.build', 'snapshot.freeze', 'disbursement.read'], 30);
    await harness.seedRole(TENANT_A, 4, 'DIS_SNAPSHOT_BUILDER', ['snapshot.build', 'disbursement.read'], 25);
    await harness.seedRole(TENANT_A, 6, 'DIS_SNAPSHOT_PART_MANAGER', ['snapshot.build', 'snapshot.freeze', 'disbursement.read'], 25);
    await harness.seedRole(TENANT_A, 5, 'DIS_FIGURES_READER', ['disbursement.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'DIS_SNAPSHOT_MANAGER', ['snapshot.build', 'snapshot.freeze', 'disbursement.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: REVIEWER, role: 2, kind: 'TENANT' },
      { n: 3, member: BUILDER, role: 3, kind: 'TENANT' },
      { n: 4, member: BUILD_ONLY, role: 4, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE_BUILDER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 6, member: READER, role: 5, kind: 'TENANT' },
      { n: 7, member: ELSEWHERE_READER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_BUILDER, role: 1, kind: 'TENANT' }]);
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
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, async (tx) => {
      await applyBaseline(tx, BASELINE_PACK, WORKER);
      await new DisPeriodStore().generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2027, periodType: 'WEEK' }, WORKER, new Date('2026-12-15T00:00:00Z'));
    });
    weeks = (await rows<{ id: string; start: string; end: string }>("select id, start_date::text as start, end_date::text as end from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and start_date >= date '2027-01-04' order by start_date")).slice(0, 30);
    root = await mkdtemp(join(tmpdir(), 'machvon-dis-snapshot-'));
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportController, ReportReadsController, ReportSubmitController, ReportDecisionController, PeriodSnapshotController],
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

  it('serves the controller of the snapshot in the module of DIS', () => {
    expect(disModule.controllers).toContain(PeriodSnapshotController);
  });

  describe('buildPeriodSnapshot', () => {
    it('AC-ST-DIS-009-1 / UAT-AC244: builds the lines from the accepted report, the plan in force and the Treasury net of its refund, with the two rates and the formulas it was made with, and freezes nothing', async () => {
      const world = await standard();
      counted.length = 0;
      const built = await build(closeBody(world.period));
      expect(built).toMatchObject({ status: 200, json: { status: 'BUILDING', resource_version: 1 } });
      const snapshotId = idOf(built);
      const read = await lines(snapshotId, BUILDER, `?project_id=${world.projectId}`);
      expect(read.status).toBe(200);
      expect(read.json.snapshot).toMatchObject({ id: snapshotId, status: 'BUILDING', snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: world.period.end, definition_status: 'PROPOSED_PENDING_SIGNOFF', metric_set_version: 'DIS-METRICS-R1-PROPOSED', payload_sha256: null, frozen_at: null });
      expect(items(read)).toHaveLength(6);
      expect(cell(read, world.code, 'CURRENT_YEAR', 'CENTRAL')).toMatchObject({
        plan_pm_assigned_vnd: '500000000',
        plan_local_added_vnd: '0',
        plan_total_vnd: '500000000',
        disbursed_treasury_vnd: '250000000',
        disbursed_reported_vnd: '100000000',
        ctmtqg_subset_vnd: '40000000',
        rate_pm_pct: '50.0000',
        rate_total_pct: '50.0000',
        rate_null_reason: null,
        treasury_coverage: 'PARTIAL',
        report_revision_id: world.reportId,
        plan_version_id: world.planId,
      });
      expect(cell(read, world.code, 'CURRENT_YEAR', 'LOCAL')).toMatchObject({ disbursed_reported_vnd: '200000000', disbursed_treasury_vnd: null, rate_pm_pct: null });
      expect(counted).toContainEqual({ name: 'dis_snapshot_build_total', labels: { kind: 'PERIOD_CLOSE' } });
    });

    it('keeps one audit row of the build without any amount, raises one snapshot.built.v1 with the day of the cutoff and the state of the definitions', async () => {
      const world = await standard();
      const snapshotId = idOf(await build(closeBody(world.period)));
      const entry = (await trail(snapshotId)).find((row) => row.action === 'dis.snapshot_built');
      expect(entry?.safe_diff).toMatchObject({ period_code: expect.any(String), snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: world.period.end, definition_status: 'PROPOSED_PENDING_SIGNOFF', discarded_id: null });
      expect(JSON.stringify(entry?.safe_diff)).not.toContain('250000000');
      const raised = await events(snapshotId, 'snapshot.built.v1');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toMatchObject({ snapshot_id: snapshotId, period_id: world.period.id, as_of_date: world.period.end, treasury_cutoff_date: world.period.end, definition_status: 'PROPOSED_PENDING_SIGNOFF', actor_id: memberId(BUILDER) });
    });

    it('leaves a report that was handed in and is not accepted out of the figures and names it apart', async () => {
      const project = await seedProject();
      const period = week();
      const made = await call('POST', '/reports', { member: MAKER, body: draft(project.projectId, period.id, project.planId) });
      await call('POST', `/reports/${idOf(made)}/submit`, { member: MAKER, ifMatch: '"1"', body: {} });
      await softClose(period.id);
      const snapshotId = idOf(await build(closeBody(period)));
      const read = await lines(snapshotId, BUILDER, `?project_id=${project.projectId}`);
      expect(items(read).every((line) => line.report_revision_id === null && line.disbursed_reported_vnd === null)).toBe(true);
      const waiting = await listed(`?period_id=${period.id}`, READER);
      expect(waiting.json.pending_reports).toEqual([expect.objectContaining({ report_id: idOf(made), project_code: project.code, revision: 1, status: 'SUBMITTED' })]);
    });

    it('builds the close figures of a period only once it is not open (409 PERIOD_STATE_INVALID), while an ad hoc snapshot can be built on an open one', async () => {
      const project = await seedProject();
      const period = week();
      await accepted(project, period);
      expect(await build(closeBody(period))).toMatchObject({ status: 409, json: { code: 'PERIOD_STATE_INVALID', period_status: 'OPEN' } });
      expect(await build(closeBody(period, { snapshot_kind: 'ADHOC' }))).toMatchObject({ status: 200, json: { status: 'BUILDING' } });
      await softClose(period.id);
      expect(await build(closeBody(period))).toMatchObject({ status: 200 });
    });

    it('judges the cutoff: not a day, before the period began and after today are 422 on treasury_cutoff_date; a period that is not there is 404', async () => {
      const world = await standard();
      for (const cutoff of ['2027-02-30', '15/03/2027', 'yesterday', plusDays(world.period.start, -1), '2027-12-16']) {
        expect(await build(closeBody(world.period, { treasury_cutoff_date: cutoff }))).toMatchObject({ status: expect.any(Number), json: { code: expect.stringMatching(/VALIDATION_FAILED|INVALID_REQUEST/) } });
      }
      expect(await build(closeBody(world.period, { treasury_cutoff_date: '2027-02-30' }))).toMatchObject({ status: 422, json: { detail: 'treasury_cutoff_date' } });
      expect(await build(closeBody(world.period, { treasury_cutoff_date: plusDays(world.period.start, -1) }))).toMatchObject({ status: 422, json: { detail: 'treasury_cutoff_date' } });
      expect(await build(closeBody(world.period, { treasury_cutoff_date: '2027-12-16' }))).toMatchObject({ status: 422, json: { detail: 'treasury_cutoff_date' } });
      expect(await build({ period_id: randomUUID(), snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: world.period.end })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await build({ ...closeBody(world.period), as_of_at: '2027-12-16T00:00:00.000Z' })).toMatchObject({ status: 422, json: { detail: 'as_of_at' } });
    });

    it('is for the person who builds over the whole tenant: one without the permission is 403, one whose permission covers a part is 403 SCOPE_DENIED for every kind and discards no one else pending build', async () => {
      const world = await standard();
      expect(await build(closeBody(world.period), NOBODY)).toMatchObject({ status: 403 });
      expect(await build(closeBody(world.period), READER)).toMatchObject({ status: 403 });
      expect(await build(closeBody(world.period), ELSEWHERE_BUILDER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      const pending = idOf(await build(closeBody(world.period, { snapshot_kind: 'ADHOC' })));
      expect(await build(closeBody(world.period, { snapshot_kind: 'ADHOC' }), ELSEWHERE_BUILDER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await rows('select status from machvon.period_snapshot where id = $1', [pending])).toEqual([{ status: 'BUILDING' }]);
      expect(await build(closeBody(world.period), B_BUILDER, { tenantId: TENANT_B })).toMatchObject({ status: 404 });
    });

    it('answers the same key with the same answer and builds once, refuses the key with another request, and discards the build that was not frozen when a new one is made', async () => {
      const world = await standard();
      const key = `key-${randomUUID()}`;
      const one = await build(closeBody(world.period), BUILDER, { key });
      const again = await build(closeBody(world.period), BUILDER, { key });
      expect(again.json).toEqual(one.json);
      expect(await build(closeBody(world.period, { snapshot_kind: 'MNE' }), BUILDER, { key })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(await events(idOf(one), 'snapshot.built.v1')).toHaveLength(1);
      const next = await build(closeBody(world.period));
      expect(next.status).toBe(200);
      const [older] = await rows<{ status: string }>('select status from machvon.period_snapshot where id = $1', [idOf(one)]);
      expect(older?.status).toBe('FAILED');
      expect((await trail(idOf(next))).find((row) => row.action === 'dis.snapshot_built')?.safe_diff).toMatchObject({ discarded_id: idOf(one) });
    });
  });

  describe('freezePeriodSnapshot', () => {
    it('AC-ST-DIS-009-4 / UAT-AC251: freezes under the version shown with the hash, who and when, keeps one audit row and one snapshot.frozen.v1, and a second freeze is 409 SNAPSHOT_FROZEN', async () => {
      const world = await standard();
      const snapshotId = idOf(await build(closeBody(world.period)));
      counted.length = 0;
      expect(await call('POST', `/period-snapshots/${snapshotId}/freeze`, { member: BUILDER, body: {} })).toMatchObject({ status: 428 });
      expect(await freeze(snapshotId, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 1 } });
      const frozen = await freeze(snapshotId, 1);
      expect(frozen).toMatchObject({ status: 200, json: { status: 'FROZEN', resource_version: 2, resource_id: snapshotId } });
      const [row] = await rows<{ status: string; payload_sha256: string; frozen_by: string; frozen_at: Date; supersedes_id: string | null }>('select status, payload_sha256, frozen_by, frozen_at, supersedes_id from machvon.period_snapshot where id = $1', [snapshotId]);
      expect(row).toMatchObject({ status: 'FROZEN', frozen_by: memberId(BUILDER), supersedes_id: null });
      expect(row?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.frozen_at.toISOString()).toBe(clockNow.toISOString());
      expect(await freeze(snapshotId, 2)).toMatchObject({ status: 409, json: { code: 'SNAPSHOT_FROZEN' } });
      const entry = (await trail(snapshotId)).find((item) => item.action === 'dis.snapshot_frozen');
      expect(entry?.safe_diff).toMatchObject({ payload_sha256: row?.payload_sha256, supersedes_id: null, version: 2 });
      expect(await events(snapshotId, 'snapshot.frozen.v1')).toHaveLength(1);
      expect(counted).toContainEqual({ name: 'dis_snapshot_freeze_total', labels: { kind: 'PERIOD_CLOSE' } });
    });

    it('AC-ST-DIS-009-4: a newer snapshot of the same period and kind replaces the frozen one, which is SUPERSEDED with its hash unchanged and cannot be frozen again', async () => {
      const world = await standard();
      const first = idOf(await build(closeBody(world.period)));
      await freeze(first, 1);
      const [before] = await rows<{ payload_sha256: string }>('select payload_sha256 from machvon.period_snapshot where id = $1', [first]);
      const second = idOf(await build(closeBody(world.period)));
      expect(await freeze(second, 1)).toMatchObject({ status: 200, json: { status: 'FROZEN' } });
      expect(await rows<{ id: string; status: string; supersedes_id: string | null; payload_sha256: string }>('select id, status, supersedes_id, payload_sha256 from machvon.period_snapshot where id = any($1::uuid[]) order by created_at', [[first, second]])).toEqual([
        { id: first, status: 'SUPERSEDED', supersedes_id: null, payload_sha256: before?.payload_sha256 },
        { id: second, status: 'FROZEN', supersedes_id: first, payload_sha256: before?.payload_sha256 },
      ]);
      expect(await freeze(first, 3)).toMatchObject({ status: 409, json: { code: 'SNAPSHOT_FROZEN' } });
      expect((await trail(second)).find((item) => item.action === 'dis.snapshot_frozen')?.safe_diff).toMatchObject({ supersedes_id: first });
    });

    it('does not freeze a build that a newer one discarded (409 SNAPSHOT_NOT_BUILT), and is for the person who holds snapshot.freeze over the whole tenant (403 SCOPE_DENIED for one whose permission covers a part, the snapshots stay as they were)', async () => {
      const world = await standard();
      const old = idOf(await build(closeBody(world.period)));
      const next = idOf(await build(closeBody(world.period)));
      expect(await freeze(old, 2)).toMatchObject({ status: 409, json: { code: 'SNAPSHOT_NOT_BUILT' } });
      expect(await freeze(next, 1, BUILD_ONLY)).toMatchObject({ status: 403 });
      expect(await freeze(next, 1, READER)).toMatchObject({ status: 403 });
      expect(await freeze(next, 1, ELSEWHERE_BUILDER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await rows('select status, version::text as version from machvon.period_snapshot where id = $1', [next])).toEqual([{ status: 'BUILDING', version: '1' }]);
      expect(await freeze(next, 1, B_BUILDER, { tenantId: TENANT_B })).toMatchObject({ status: 404 });
      expect(await freeze(randomUUID(), 1)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await freeze(next, 1)).toMatchObject({ status: 200 });
    });

    it('keeps one freeze when two people freeze at once (409 VERSION_CONFLICT for the other)', async () => {
      const world = await standard();
      const snapshotId = idOf(await build(closeBody(world.period)));
      const [a, b] = await Promise.all([freeze(snapshotId, 1), freeze(snapshotId, 1)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await events(snapshotId, 'snapshot.frozen.v1')).toHaveLength(1);
    });
  });

  describe('listPeriodSnapshotLines', () => {
    it('shows each person the lines of the projects in their scope: the whole tenant, one branch, and nothing of another branch', async () => {
      const here = await standard(DEPARTMENT);
      const there = await seedProject(ELSEWHERE);
      const snapshotId = idOf(await build(closeBody(here.period)));
      const all = await lines(snapshotId, READER);
      expect(items(all).some((line) => line.project_code === here.code)).toBe(true);
      const elsewhere = await lines(snapshotId, ELSEWHERE_READER);
      expect(elsewhere.status).toBe(200);
      expect(items(elsewhere).some((line) => line.project_code === here.code)).toBe(false);
      expect(items(elsewhere).some((line) => line.project_code === there.code)).toBe(true);
      expect(items(await lines(snapshotId, ELSEWHERE_READER, `?project_id=${here.projectId}`))).toEqual([]);
      expect(await lines(snapshotId, NOBODY)).toMatchObject({ status: 403 });
    });

    it('AC-ST-DIS-009-6 / UAT-AC265: a person of another tenant reads nothing: 404 for the snapshot of tenant A, as for one that does not exist', async () => {
      const world = await standard();
      const snapshotId = idOf(await build(closeBody(world.period)));
      expect(await lines(snapshotId, B_BUILDER, '', TENANT_B)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await lines(randomUUID(), READER)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      const other = await call('GET', `/period-snapshots?period_id=${world.period.id}`, { member: B_BUILDER, tenantId: TENANT_B });
      expect(other.json.items).toEqual([]);
    });

    it('pages by cursor in the order of project and cell without a line twice or missing, and refuses a cursor it did not issue', async () => {
      const world = await standard();
      await standard();
      const snapshotId = idOf(await build(closeBody(world.period)));
      const everything = await lines(snapshotId, READER, '?limit=200');
      expect(everything).toMatchObject({ status: 200 });
      const whole = items(everything).map((line) => line.id);
      expect(whole.length).toBeGreaterThanOrEqual(12);
      const seen: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await lines(snapshotId, READER, `?limit=5${cursor === null ? '' : `&cursor=${cursor}`}`);
        expect(items(page).length).toBeLessThanOrEqual(5);
        seen.push(...items(page).map((line) => line.id));
        cursor = page.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(seen).toEqual(whole);
      expect(await lines(snapshotId, READER, '?cursor=not-a-cursor')).toMatchObject({ status: 422, json: { detail: 'cursor' } });
      expect(await lines(snapshotId, READER, '?limit=0')).toMatchObject({ status: 422, json: { detail: 'limit' } });
      expect(await lines(snapshotId, READER, '?project_id=nope')).toMatchObject({ status: 422, json: { detail: 'project_id' } });
    });
  });

  describe('listPeriodSnapshots', () => {
    it('AC-ST-DIS-009-7: lists the snapshots of a period newest first with status, cutoff, hash and the label of the definitions, and narrows by kind and status', async () => {
      const world = await standard();
      const first = idOf(await build(closeBody(world.period)));
      await freeze(first, 1);
      const adhoc = idOf(await build(closeBody(world.period, { snapshot_kind: 'ADHOC' })));
      const all = await listed(`?period_id=${world.period.id}`);
      expect(all.status).toBe(200);
      expect(items(all).map((row) => row.id)).toEqual([adhoc, first]);
      expect(items(all)[1]).toMatchObject({ status: 'FROZEN', snapshot_kind: 'PERIOD_CLOSE', treasury_cutoff_date: world.period.end, definition_status: 'PROPOSED_PENDING_SIGNOFF' });
      expect((items(all)[1]?.payload_sha256 as string).length).toBe(64);
      expect(items(await listed(`?period_id=${world.period.id}&snapshot_kind=ADHOC`)).map((row) => row.id)).toEqual([adhoc]);
      expect(items(await listed(`?period_id=${world.period.id}&status=FROZEN`)).map((row) => row.id)).toEqual([first]);
      expect(await listed('?snapshot_kind=WEEKLY')).toMatchObject({ status: 422, json: { detail: 'snapshot_kind' } });
      expect(await listed('?status=DONE')).toMatchObject({ status: 422, json: { detail: 'status' } });
      expect(await listed('?period_id=nope')).toMatchObject({ status: 422, json: { detail: 'period_id' } });
      expect(await listed(`?period_id=${world.period.id}`, NOBODY)).toMatchObject({ status: 403 });
    });
  });
});
