import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { BASELINE_PACK, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, readTabularFile, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { ReportDecisionController } from '../../src/modules/dis/report-decision.controller';
import { RegistrationConsumer } from '../../src/modules/dis/registration.consumer';
import { ReportNarrativeController } from '../../src/modules/dis/narrative.controller';
import { ReportImportController } from '../../src/modules/dis/report-import.controller';
import { ReportLifecycleController } from '../../src/modules/dis/report-lifecycle.controller';
import { ReportController, ReportReadsController } from '../../src/modules/dis/report.controller';
import { ReportSubmitController } from '../../src/modules/dis/report-submit.controller';
import { DIS_CLOCK, DIS_METRICS } from '../../src/modules/dis/tokens';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, grantId, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const MAKER = 1; // makes and hands in the reports, answers a return with a correction, and also holds report.review (so that the maker-checker rule is what stops the self-approval)
const REVIEWER = 2; // report.review over the whole tenant
const READER = 3; // report.read only
const ELSEWHERE_REVIEWER = 4; // report.review over another branch, where the projects are not
const OTHER_MAKER = 5; // the maker rights over the whole tenant, without report.review
const ELSEWHERE_IMPORTER = 6; // report.import over another branch, where the projects are not
const B_MAKER = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x9e;
const AREA = id(FAMILY, 30);
const DECISION = id(FAMILY, 32);
const FUND_SOURCE = id(FAMILY, 31);
const DUE = '2027-01-10T03:00:00.000Z';

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

/** The decision of a reviewer on a weekly report and the chain of corrections over HTTP (ST-DIS-006, DIS-07, DIS-08, DIS-11). */
describe('the decision on a weekly report and its corrections over HTTP (ST-DIS-006)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  const now = new Date('2026-12-15T00:00:00Z');
  /** The clock of the module: the day of the tests, moved for the ones that judge the window of a restore. */
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
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A project of the department with a plan version of 2027 in force from December 2026 that allocated 500,000,000 to the year plan of the central budget. */
  async function seedProject(): Promise<{ projectId: string; planId: string }> {
    counter += 1;
    const projectId = randomUUID();
    const planId = randomUUID();
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `DC-${counter}`, `Project DC-${counter}`, unitId(DEPARTMENT), AREA],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2027, 1, $4, 'PUBLISHED', timestamptz '2026-12-20T01:00:00Z')`,
        [TENANT_A, planId, projectId, DECISION],
      ],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level)
         values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', 2027, 500000000, 0, $4, 'CENTRAL')`,
        [TENANT_A, planId, FUND_SOURCE, projectId],
      ],
    ]);
    return { projectId, planId };
  }

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
    ...PROGRESS,
    ...extra,
  });
  const create = (body: Record<string, unknown>, member = MAKER): Promise<Reply> => call('POST', '/reports', { member, body });
  const save = (reportId: string, body: Record<string, unknown>, version: number, member = MAKER): Promise<Reply> => call('POST', `/reports/${reportId}/revisions`, { member, body, ifMatch: `"${version}"` });
  const submit = (reportId: string, version: number, member = MAKER): Promise<Reply> => call('POST', `/reports/${reportId}/submit`, { member, ifMatch: `"${version}"`, body: {} });
  const read = (reportId: string, member = READER, tenantId?: string): Promise<Reply> => call('GET', `/reports/${reportId}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const decide = (reportId: string, version: number, body: Record<string, unknown>, member = REVIEWER, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/reports/${reportId}/decision`, { member, body, ifMatch: `"${version}"`, ...options });
  const correct = (reportId: string, version: number, body: Record<string, unknown>, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> =>
    call('POST', `/reports/${reportId}/corrections`, { member, body, ifMatch: `"${version}"`, ...options });
  const approve = (reportId: string, version: number, member = REVIEWER): Promise<Reply> => decide(reportId, version, { decision: 'approve', reason: 'The figures agree with the Treasury.', evidence_ids: [] }, member);
  const giveBack = (reportId: string, version: number, extra: Record<string, unknown> = {}): Promise<Reply> =>
    decide(reportId, version, { decision: 'return', reason: 'The CTMTQG cell is wrong.', evidence_ids: [], return_items: ['Fix the CTMTQG cell', 'Explain the fall'], due_at: DUE, ...extra });
  const trail = (resourceId: string) => rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  const events = (reportId: string, type: string) => rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [reportId, type]);
  const state = async (reportId: string) =>
    (await rows<{ status: string; version: string; revision: number; is_current: boolean; payload_hash: string; supersedes_id: string | null; amendment_reason: string | null; accepted_by: string | null; submitted_by: string | null }>(
      'select status, version::text as version, revision, is_current, payload_hash, supersedes_id, amendment_reason, accepted_by, submitted_by from machvon.report_revision where id = $1',
      [reportId],
    ))[0];
  const lockPeriod = async (periodId: string): Promise<void> => {
    await rows("update machvon.reporting_period set status = 'SOFT_CLOSED', soft_closed_at = now(), version = version + 1 where id = $1", [periodId]);
    await rows("update machvon.reporting_period set status = 'LOCKED', locked_at = now(), locked_by = $2, version = version + 1 where id = $1", [periodId, memberId(MAKER)]);
  };

  /** A report of a project in a week of its own, handed in by the maker: SUBMITTED at version 2. */
  async function submitted(options: { project?: { projectId: string; planId: string }; period?: string; extra?: Record<string, unknown> } = {}): Promise<{ reportId: string; projectId: string; planId: string; period: string }> {
    const { projectId, planId } = options.project ?? (await seedProject());
    const period = options.period ?? week();
    const made = await create(draft(projectId, period, planId, options.extra));
    expect(made.status).toBe(200);
    const sent = await submit(idOf(made), 1);
    expect(sent).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 2 } });
    return { reportId: idOf(made), projectId, planId, period };
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
    for (const n of [MAKER, REVIEWER, READER, ELSEWHERE_REVIEWER, OTHER_MAKER, ELSEWHERE_IMPORTER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MAKER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'DIS_MAKER_REVIEWER', ['report.create', 'report.edit', 'report.submit', 'report.correct', 'report.review', 'report.withdraw', 'report.import', 'report.read', 'report_revision.read'], 30);
    await harness.seedRole(TENANT_A, 5, 'DIS_IMPORTER', ['report.import', 'report.read'], 25);
    await harness.seedRole(TENANT_A, 2, 'DIS_REVIEWER', ['report.review', 'report.read', 'report_revision.read'], 25);
    await harness.seedRole(TENANT_A, 3, 'DIS_READER', ['report.read', 'report_revision.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'DIS_MAKER', ['report.create', 'report.edit', 'report.submit', 'report.correct', 'report.withdraw', 'report.read', 'report_revision.read'], 30);
    await harness.seedRole(TENANT_B, 1, 'DIS_MAKER_REVIEWER', ['report.create', 'report.edit', 'report.submit', 'report.correct', 'report.review', 'report.withdraw', 'report.import', 'report.read', 'report_revision.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: REVIEWER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE_REVIEWER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 5, member: OTHER_MAKER, role: 4, kind: 'TENANT' },
      { n: 6, member: ELSEWHERE_IMPORTER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
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
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, async (tx) => {
      await applyBaseline(tx, BASELINE_PACK, WORKER);
      await new DisPeriodStore().generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2027, periodType: 'WEEK' }, WORKER, now);
    });
    await rows(
      `insert into machvon.reporting_period
         (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       select tenant_id, gen_random_uuid(), 'X-' || code, calendar_version, start_date, end_date, deadline_at, 'EXTRA', period_type, fiscal_year, 'OPEN', calendar_version_id, created_by, updated_by
         from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and calendar_code = 'DEFAULT'`,
    );
    weeks = (await rows<{ id: string }>("select id from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' order by calendar_code, start_date")).map((row) => row.id);
    root = await mkdtemp(join(tmpdir(), 'machvon-dis-decision-'));
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportController, ReportReadsController, ReportSubmitController, ReportDecisionController, ReportLifecycleController, ReportImportController, ReportNarrativeController],
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

  it('serves the controller of the decision in the module of DIS', () => {
    expect(disModule.controllers).toContain(ReportDecisionController);
    expect(disModule.controllers).toContain(ReportLifecycleController);
    expect(disModule.controllers).toContain(ReportImportController);
  });

  describe('IAM-2: the limit of a role grant to report periods', () => {
    const bump = (member: number): Promise<unknown> => rows('update machvon.membership set scope_version = scope_version + 1 where id = $1', [memberId(member)]);

    it('refuses a decision on a report of another period (403 PERIOD_SCOPE_DENIED), also when another grant of the reviewer reaches elsewhere without a limit, and allows it once the limit is lifted', async () => {
      const { reportId } = await submitted();
      await rows("insert into machvon.role_grant_period_scope (tenant_id, id, role_grant_id, period_codes, reason, set_by) values ($1, gen_random_uuid(), $2, '{2026}', 'The reviewer covers 2026 only.', $3)", [TENANT_A, grantId(2), memberId(MAKER)]);
      // A second grant of the same permission, without a limit, over a unit that does not hold the project: it must not carry the report of the department.
      await harness.seedGrants(TENANT_A, [{ n: 90, member: REVIEWER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] }]);
      await bump(REVIEWER);
      try {
        expect(await approve(reportId, 2)).toMatchObject({ status: 403, json: { code: 'PERIOD_SCOPE_DENIED' } });
        expect(await state(reportId)).toMatchObject({ status: 'SUBMITTED', accepted_by: null });
        await rows("update machvon.role_grant_period_scope set status = 'Lifted', lifted_by = $2, lifted_at = now(), lift_reason = 'Lifted for the test of the decision.' where role_grant_id = $1 and status = 'Active'", [grantId(2), memberId(MAKER)]);
        await bump(REVIEWER);
        expect(await approve(reportId, 2)).toMatchObject({ status: 200, json: { status: 'ACCEPTED' } });
      } finally {
        await rows("update machvon.role_grant set status = 'Revoked', revoked_at = now() where id = $1", [grantId(90)]);
        await bump(REVIEWER);
      }
    });
  });

  describe('post_reports_id_decision', () => {
    it('AC-ST-DIS-006-1 / UAT-AC05: the maker who also holds report.review is 403 SELF_APPROVAL_DENIED with the attempt on the trail and the report still SUBMITTED; the reviewer gets ACCEPTED, and accepted_by differs from submitted_by', async () => {
      const { reportId } = await submitted();
      const own = await approve(reportId, 2, MAKER);
      expect(own).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await state(reportId)).toMatchObject({ status: 'SUBMITTED', version: '2', is_current: false, accepted_by: null });
      expect(await rows("select actor_id from machvon.audit_event where action = 'command.denied:post_reports_id_decision' and outcome = 'DENIED'")).toEqual(expect.arrayContaining([{ actor_id: memberId(MAKER) }]));
      const accepted = await approve(reportId, 2);
      expect(accepted).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: 3, resource_id: reportId } });
      const row = await state(reportId);
      expect(row).toMatchObject({ status: 'ACCEPTED', is_current: true, accepted_by: memberId(REVIEWER), submitted_by: memberId(MAKER) });
      expect(row?.accepted_by).not.toBe(row?.submitted_by);
      const found = await read(reportId);
      expect(found.json).toMatchObject({ status: 'ACCEPTED', is_current: true, accepted_by: memberId(REVIEWER), submitted_by: memberId(MAKER), supersedes_id: null });
      expect(found.json.decisions).toEqual([expect.objectContaining({ decision: 'ACCEPTED', reason: 'The figures agree with the Treasury.', decided_by: memberId(REVIEWER), return_items: [], due_at: null })]);
    });

    it('keeps the audit row without the words of the reason, raises one report.accepted.v1 with the version of the report, and counts the decision after it was committed', async () => {
      const { reportId } = await submitted();
      counted.length = 0;
      await approve(reportId, 2);
      const entry = (await trail(reportId)).find((row) => row.action === 'dis.report_accepted');
      expect(entry?.safe_diff).toMatchObject({ decision: 'ACCEPTED', previous_status: 'SUBMITTED', revision: 1, evidence_count: 0, items_count: 0, version: 3 });
      expect(JSON.stringify(entry?.safe_diff)).not.toContain('Treasury');
      const raised = await events(reportId, 'report.accepted.v1');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toMatchObject({ report_id: reportId, revision: 1, decision: 'ACCEPTED', superseded_report_id: null, submitted_by: memberId(MAKER), cumulative_vnd: '420000000' });
      expect(counted).toContainEqual({ name: 'dis_report_decision_total', labels: { decision: 'ACCEPTED' } });
    });

    it('AC-ST-DIS-006-3 / UAT-AC260: a return without its items is 422 on return_items, then with the items and the day it is RETURNED and the notification event names them', async () => {
      const { reportId } = await submitted();
      const without = await decide(reportId, 2, { decision: 'return', reason: 'The CTMTQG cell is wrong.', evidence_ids: [] });
      expect(without).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'return_items' } });
      expect(await state(reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
      const returned = await giveBack(reportId, 2);
      expect(returned).toMatchObject({ status: 200, json: { status: 'RETURNED', resource_version: 3 } });
      const raised = await events(reportId, 'report.returned.v1');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toMatchObject({ decision: 'RETURNED', return_items: ['Fix the CTMTQG cell', 'Explain the fall'], due_at: DUE, submitted_by: memberId(MAKER) });
      const found = await read(reportId);
      expect(found.json).toMatchObject({ status: 'RETURNED', returned_reason: 'The CTMTQG cell is wrong.' });
      expect(found.json.decisions).toEqual([expect.objectContaining({ decision: 'RETURNED', return_items: ['Fix the CTMTQG cell', 'Explain the fall'], due_at: DUE })]);
      expect(JSON.stringify((await trail(reportId)).find((row) => row.action === 'dis.report_returned')?.safe_diff)).not.toContain('Fix the CTMTQG cell');
    });

    it('asks for an amendment of an accepted report, with a reason, leaving it the current one; a report that was not accepted cannot be asked to be amended', async () => {
      const { reportId } = await submitted();
      expect(await decide(reportId, 2, { decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] })).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID' } });
      await approve(reportId, 2);
      const asked = await decide(reportId, 3, { decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] });
      expect(asked).toMatchObject({ status: 200, json: { status: 'AMENDMENT_REQUESTED', resource_version: 4 } });
      expect(await state(reportId)).toMatchObject({ status: 'AMENDMENT_REQUESTED', is_current: true });
      expect((await events(reportId, 'report.returned.v1'))[0]?.payload).toMatchObject({ decision: 'AMENDMENT_REQUESTED', return_items: [], due_at: null });
    });

    it('judges the request before the report: a decision that is not one, a missing reason, evidence that is not an id are 422 on their field, and a rejection is not a decision of the state machine', async () => {
      const { reportId } = await submitted();
      const base = { decision: 'approve', reason: 'The figures agree.', evidence_ids: [] };
      for (const [body, detail] of [
        [{ ...base, decision: 'reject' }, 'decision'],
        [{ ...base, reason: '   ' }, 'reason'],
        [{ ...base, evidence_ids: ['nope'] }, 'evidence_ids'],
        [{ ...base, return_items: ['Fix the cell'] }, 'return_items'],
        [{ ...base, decision: 'return', return_items: ['Fix the cell'], due_at: '2026-12-01T00:00:00.000Z' }, 'due_at'],
      ] as const) {
        expect(await decide(reportId, 2, body)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail } });
      }
      expect(await state(reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
    });

    it('answers the same key with the same answer and changes nothing, refuses the key with another request, and keeps one decision for two reviewers at once (409 VERSION_CONFLICT)', async () => {
      const key = `key-${randomUUID()}`;
      const other = await submitted();
      const one = await decide(other.reportId, 2, { decision: 'approve', reason: 'The figures agree.', evidence_ids: [] }, REVIEWER, { key });
      const again = await decide(other.reportId, 2, { decision: 'approve', reason: 'The figures agree.', evidence_ids: [] }, REVIEWER, { key });
      expect(again).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: 3 } });
      expect(again.json).toEqual(one.json);
      expect(await decide(other.reportId, 2, { decision: 'return', reason: 'Another request.', evidence_ids: [], return_items: ['Fix the cell'], due_at: DUE }, REVIEWER, { key })).toMatchObject({
        status: 409,
        json: { code: 'IDEMPOTENCY_CONFLICT' },
      });
      expect(await events(other.reportId, 'report.accepted.v1')).toHaveLength(1);
      const race = await submitted();
      const [a, b] = await Promise.all([approve(race.reportId, 2), approve(race.reportId, 2)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a, b].find((reply) => reply.status === 409)?.json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 3 });
      expect(await events(race.reportId, 'report.accepted.v1')).toHaveLength(1);
    });

    it('does not decide on a report twice, nor on a draft (409 REPORT_STATE_INVALID naming the status)', async () => {
      const { reportId } = await submitted();
      await giveBack(reportId, 2);
      expect(await approve(reportId, 3)).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'RETURNED' } });
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, week(), planId));
      expect(await approve(idOf(made), 1)).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'DRAFT' } });
    });

    it('is for the reviewer who acts on the project: a reader and a maker without the right are 403, another branch and another tenant are 404 and learn nothing', async () => {
      const { reportId } = await submitted();
      expect((await approve(reportId, 2, READER)).status).toBe(403);
      expect((await approve(reportId, 2, OTHER_MAKER)).status).toBe(403);
      expect((await approve(reportId, 2, ELSEWHERE_REVIEWER)).status).toBe(404);
      expect((await call('POST', `/reports/${reportId}/decision`, { member: B_MAKER, tenantId: TENANT_B, body: { decision: 'approve', reason: 'Other tenant.', evidence_ids: [] }, ifMatch: '"2"' })).status).toBe(404);
      expect((await approve(randomUUID(), 2)).status).toBe(404);
      expect(await state(reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
    });
  });

  describe('post_reports_id_corrections', () => {
    it('AC-ST-DIS-006-2 / UAT-AC247: a submitted revision is not edited (409 REVISION_IMMUTABLE); after the return a correction without its reason is 422 CORRECTION_REASON_REQUIRED, then rev2 is a DRAFT that points at rev1, is handed in, and rev1 keeps its payload_hash', async () => {
      const { reportId, projectId, planId, period } = await submitted();
      const before = await state(reportId);
      expect(await save(reportId, draft(projectId, period, planId), 2)).toMatchObject({ status: 409, json: { code: 'REVISION_IMMUTABLE' } });
      await giveBack(reportId, 2);
      const missing = await correct(reportId, 3, {});
      expect(missing).toMatchObject({ status: 422, json: { code: 'CORRECTION_REASON_REQUIRED', detail: 'amendment_reason' } });
      expect(await correct(reportId, 3, { amendment_reason: 'too short' })).toMatchObject({ status: 422, json: { code: 'CORRECTION_REASON_REQUIRED' } });
      const made = await correct(reportId, 3, { amendment_reason: 'The Treasury corrected a payment of March.' });
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      const second = idOf(made);
      expect(second).not.toBe(reportId);
      expect(await state(second)).toMatchObject({ status: 'DRAFT', revision: 2, supersedes_id: reportId, amendment_reason: 'The Treasury corrected a payment of March.', is_current: false });
      const found = await read(second);
      expect(found.json).toMatchObject({ revision: 2, supersedes_id: reportId, amendment_reason: 'The Treasury corrected a payment of March.', totals: { cumulative_vnd: '420000000', ctmtqg_vnd: '40000000' } });
      expect(found.json.progress).toMatchObject({ construction_vnd: '300000000' });
      expect(await submit(second, 1)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
      expect((await state(reportId))?.payload_hash).toBe(before?.payload_hash);
      const raised = await events(second, 'report.correction_started.v1');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toMatchObject({ report_id: second, supersedes_id: reportId, revision: 2 });
      expect((await trail(second)).find((row) => row.action === 'dis.report_correction_started')?.safe_diff).toMatchObject({ revision: 2, supersedes_id: reportId, supersedes_status: 'RETURNED' });
    });

    it('carries the cells it names in place of the same cells and keeps the others (the registration for next month of a cell it names too, when it does not name it), takes new volumes and a new explanation, and does not touch the revision it corrects', async () => {
      const registered = FX_DIS_001.map((line) => (line.bucket === 'CURRENT_YEAR' && line.budget_level === 'LOCAL' ? { ...line, next_month_vnd: '5000000' } : line));
      const { reportId } = await submitted({ extra: { funding_lines: registered } });
      await approve(reportId, 2);
      await decide(reportId, 3, { decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] });
      const made = await correct(reportId, 4, {
        amendment_reason: 'The Treasury corrected a payment of March.',
        funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '250000000' }],
        progress: { ...PROGRESS, construction_vnd: '310000000' },
      });
      expect(made.status).toBe(200);
      const found = (await read(idOf(made))).json;
      const lines = found.funding_lines as Array<Record<string, unknown>>;
      expect(lines.map((line) => [line.bucket, line.budget_level, line.cumulative_vnd])).toEqual([
        ['CURRENT_YEAR', 'CENTRAL', '100000000'],
        ['CURRENT_YEAR', 'LOCAL', '250000000'],
        ['CARRYOVER', 'CENTRAL', '30000000'],
        ['CARRYOVER', 'LOCAL', '70000000'],
        ['OTHER', 'CENTRAL', '0'],
        ['OTHER', 'LOCAL', '20000000'],
      ]);
      expect(found.progress).toMatchObject({ construction_vnd: '310000000' });
      expect(lines[1]).toMatchObject({ cumulative_vnd: '250000000', next_month_vnd: '5000000' });
      const old = (await read(reportId)).json;
      expect((old.funding_lines as Array<Record<string, unknown>>)[1]).toMatchObject({ cumulative_vnd: '200000000' });
      expect(old).toMatchObject({ status: 'AMENDMENT_REQUESTED', is_current: true });
    });

    it('BR-DIS-02 / AC-ST-DIS-006-4: accepting the corrected revision makes the one before SUPERSEDED and itself the current one, and the page of the history reads both', async () => {
      const { reportId } = await submitted();
      await approve(reportId, 2);
      await decide(reportId, 3, { decision: 'request_amendment', reason: 'The Treasury corrected a payment.', evidence_ids: [] });
      const second = idOf(await correct(reportId, 4, { amendment_reason: 'The Treasury corrected a payment of March.' }));
      await submit(second, 1);
      expect(await approve(second, 2)).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: 3 } });
      expect(await state(reportId)).toMatchObject({ status: 'SUPERSEDED', is_current: false });
      expect(await state(second)).toMatchObject({ status: 'ACCEPTED', is_current: true });
      expect((await events(second, 'report.accepted.v1'))[0]?.payload).toMatchObject({ superseded_report_id: reportId });
      const history = await call('GET', `/resources/report_revision?period_id=${(await rows<{ period_id: string }>('select period_id from machvon.report_revision where id = $1', [second]))[0]?.period_id}`, { member: READER });
      expect(history.status).toBe(200);
      expect((history.json.items as Array<Record<string, unknown>>).map((row) => [row.revision, row.status])).toEqual(expect.arrayContaining([[1, 'SUPERSEDED'], [2, 'ACCEPTED']]));
    });

    it('lets one correction at a time start from a period (409 REVISION_PENDING_EXISTS naming it), and one only from a report that was accepted, returned or asked to be amended (409 REPORT_STATE_INVALID)', async () => {
      const { reportId } = await submitted();
      expect(await correct(reportId, 2, { amendment_reason: 'The Treasury corrected a payment.' })).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'SUBMITTED' } });
      await giveBack(reportId, 2);
      const made = await correct(reportId, 3, { amendment_reason: 'The Treasury corrected a payment.' });
      expect(made.status).toBe(200);
      expect(await correct(reportId, 3, { amendment_reason: 'The Treasury corrected a payment again.' })).toMatchObject({
        status: 409,
        json: { code: 'REVISION_PENDING_EXISTS', report_id: idOf(made), revision: 2, report_status: 'DRAFT' },
      });
      const [a, b] = await (async () => {
        const racing = await submitted();
        await giveBack(racing.reportId, 2);
        return Promise.all([correct(racing.reportId, 3, { amendment_reason: 'The Treasury corrected a payment.' }), correct(racing.reportId, 3, { amendment_reason: 'The Treasury corrected a payment.' })]);
      })();
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it('takes nothing for a locked period unless an approved reopening names the project (409 PERIOD_LOCKED, the report as it was)', async () => {
      const { reportId, period } = await submitted();
      await giveBack(reportId, 2);
      await lockPeriod(period);
      expect(await correct(reportId, 3, { amendment_reason: 'The Treasury corrected a payment.' })).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
      expect(await state(reportId)).toMatchObject({ status: 'RETURNED', version: '3' });
      expect(await rows('select id from machvon.report_revision where supersedes_id = $1', [reportId])).toEqual([]);
    });

    it('is for the maker who acts on the project: a reader and a reviewer without the maker right are 403, another tenant is 404, and the key answers once', async () => {
      const { reportId } = await submitted();
      await giveBack(reportId, 2);
      const body = { amendment_reason: 'The Treasury corrected a payment of March.' };
      expect((await correct(reportId, 3, body, READER)).status).toBe(403);
      expect((await correct(reportId, 3, body, REVIEWER)).status).toBe(403);
      expect((await correct(reportId, 3, body, MAKER, { tenantId: TENANT_B })).status).toBe(404);
      const key = `key-${randomUUID()}`;
      const first = await correct(reportId, 3, body, OTHER_MAKER, { key });
      const again = await correct(reportId, 3, body, OTHER_MAKER, { key });
      expect(first.status).toBe(200);
      expect(again.json).toEqual(first.json);
      expect(await rows('select id from machvon.report_revision where supersedes_id = $1', [reportId])).toHaveLength(1);
    });
  });

  describe('withdrawReport', () => {
    const withdraw = (reportId: string, version: number, body: Record<string, unknown>, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> =>
      call('POST', `/reports/${reportId}/withdrawal`, { member, body, ifMatch: `"${version}"`, ...options });
    const REASON_OK = 'The wrong period was reported by mistake.';

    it('AC-ST-DIS-007-3 / UAT-AC259: a reason under 20 characters is 422 on reason, then a valid one makes the report WITHDRAWN, with the audit row, one event and the count after commit', async () => {
      const { reportId } = await submitted();
      counted.length = 0;
      expect(await withdraw(reportId, 2, { reason: 'too short a reason' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'reason' } });
      // A request with no reason at all is not one the schema takes.
      expect(await withdraw(reportId, 2, {})).toMatchObject({ status: 400, json: { code: 'INVALID_REQUEST' } });
      expect(await state(reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
      const done = await withdraw(reportId, 2, { reason: `  ${REASON_OK}  ` });
      expect(done).toMatchObject({ status: 200, json: { status: 'WITHDRAWN', resource_version: 3, resource_id: reportId } });
      expect(await state(reportId)).toMatchObject({ status: 'WITHDRAWN', is_current: false });
      const found = (await read(reportId)).json;
      expect(found).toMatchObject({ status: 'WITHDRAWN', withdrawn_by: memberId(MAKER), withdrawn_reason: REASON_OK });
      const raised = await events(reportId, 'report.withdrawn.v1');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toMatchObject({ report_id: reportId, revision: 1, reason: REASON_OK, submitted_by: memberId(MAKER), cumulative_vnd: '420000000' });
      const entry = (await trail(reportId)).find((row) => row.action === 'dis.report_withdrawn');
      expect(entry?.safe_diff).toMatchObject({ previous_status: 'SUBMITTED', reason_length: REASON_OK.length, revision: 1, version: 3 });
      expect(JSON.stringify(entry?.safe_diff)).not.toContain('wrong period');
      expect(counted).toContainEqual({ name: 'dis_report_withdrawal_total', labels: {} });
    });

    it('AC-ST-DIS-007-3: a report under review, a draft and a report that was decided on are 409 REPORT_STATE_INVALID, a locked period is 409 PERIOD_LOCKED, and nothing changes', async () => {
      const reviewing = await submitted();
      await rows("update machvon.report_revision set status = 'UNDER_REVIEW' where id = $1", [reviewing.reportId]);
      expect(await withdraw(reviewing.reportId, 2, { reason: REASON_OK })).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'UNDER_REVIEW' } });
      const accepted = await submitted();
      await approve(accepted.reportId, 2);
      expect(await withdraw(accepted.reportId, 3, { reason: REASON_OK })).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'ACCEPTED' } });
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, week(), planId));
      expect(await withdraw(idOf(made), 1, { reason: REASON_OK })).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID', report_status: 'DRAFT' } });
      const locked = await submitted();
      await lockPeriod(locked.period);
      expect(await withdraw(locked.reportId, 2, { reason: REASON_OK })).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
      expect(await state(locked.reportId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
      expect(await events(locked.reportId, 'report.withdrawn.v1')).toEqual([]);
    });

    it('lets the maker report the period again: a correction of the withdrawn report is the next revision, a draft', async () => {
      const { reportId } = await submitted();
      await withdraw(reportId, 2, { reason: REASON_OK });
      const made = await correct(reportId, 3, { amendment_reason: 'The right period is reported now.' });
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
      expect(await state(idOf(made))).toMatchObject({ revision: 2, status: 'DRAFT', supersedes_id: reportId });
    });

    it('is for the maker who may withdraw on the project: a reviewer and a reader are 403, another tenant is 404; the key answers once', async () => {
      const { reportId } = await submitted();
      expect((await withdraw(reportId, 2, { reason: REASON_OK }, REVIEWER)).status).toBe(403);
      expect((await withdraw(reportId, 2, { reason: REASON_OK }, READER)).status).toBe(403);
      expect((await withdraw(reportId, 2, { reason: REASON_OK }, MAKER, { tenantId: TENANT_B })).status).toBe(404);
      expect((await withdraw(reportId, 7, { reason: REASON_OK })).json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 2 });
      const key = `key-${randomUUID()}`;
      const first = await withdraw(reportId, 2, { reason: REASON_OK }, OTHER_MAKER, { key });
      const again = await withdraw(reportId, 2, { reason: REASON_OK }, OTHER_MAKER, { key });
      expect(first.status).toBe(200);
      expect(again.json).toEqual(first.json);
      expect(await events(reportId, 'report.withdrawn.v1')).toHaveLength(1);
    });
  });

  describe('deleteDraftReport and restoreDraftReport', () => {
    const remove = (reportId: string, version: number, body: Record<string, unknown> = { reason: 'Started in the wrong week.' }, member = MAKER): Promise<Reply> =>
      call('POST', `/reports/${reportId}/draft-deletion`, { member, body, ifMatch: `"${version}"` });
    const restore = (reportId: string, version: number, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', `/reports/${reportId}/draft-restore`, { member, body: {}, ifMatch: `"${version}"`, ...options });
    const listOf = async (query: string, member = MAKER): Promise<string[]> => ((await call('GET', `/resources/report_revision?${query}`, { member })).json.items as Array<{ id: string }>).map((row) => row.id);
    const aDraft = async () => {
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, week(), planId));
      return { reportId: idOf(made), projectId };
    };

    it('AC-ST-DIS-007-1 / UAT-AC259: deletes a draft with a reason, lists it apart while it can be restored, restores it, and a report that was handed in is 409 REPORT_NOT_EDITABLE', async () => {
      const { reportId, projectId } = await aDraft();
      // The list of the drafts that can be restored runs on the clock of the database, so the deletion is dated by the real day.
      clockNow = new Date();
      const deleted = await remove(reportId, 1);
      expect(deleted).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2, resource_id: reportId } });
      expect(await listOf(`project_id=${projectId}`)).toEqual([]);
      expect(await listOf(`project_id=${projectId}&deleted=true`)).toEqual([reportId]);
      const found = (await read(reportId)).json;
      expect(found).toMatchObject({ deleted: true, deleted_reason: 'Started in the wrong week.', version: 2 });
      expect(found.deleted_at).toBe(clockNow.toISOString());
      expect((await trail(reportId)).find((row) => row.action === 'dis.report_draft_deleted')?.safe_diff).toMatchObject({ reason_length: 'Started in the wrong week.'.length, version: 2 });
      expect(await restore(reportId, 2)).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 3 } });
      expect(await listOf(`project_id=${projectId}`)).toEqual([reportId]);
      expect(await listOf(`project_id=${projectId}&deleted=true`)).toEqual([]);
      expect((await read(reportId)).json).toMatchObject({ deleted: false, deleted_at: null });
      const handedIn = await submitted();
      expect(await remove(handedIn.reportId, 2)).toMatchObject({ status: 409, json: { code: 'REPORT_NOT_EDITABLE', report_status: 'SUBMITTED' } });
      expect(await remove(reportId, 3, { reason: 'no' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'reason' } });
      expect(await remove(reportId, 3, { reason: '     ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'reason' } });
      clockNow = now;
    });

    it('AC-ST-DIS-007-2 / UAT-PLAN-68: after 30 days the restore is 422 RESTORE_WINDOW_EXPIRED and the draft stays deleted; on the last day it is restored', async () => {
      const first = await aDraft();
      const second = await aDraft();
      const deletedAt = clockNow;
      await remove(first.reportId, 1);
      await remove(second.reportId, 1);
      try {
        clockNow = new Date(deletedAt.getTime() + 30 * 86_400_000);
        expect(await restore(second.reportId, 2)).toMatchObject({ status: 200, json: { resource_version: 3 } });
        clockNow = new Date(deletedAt.getTime() + 30 * 86_400_000 + 1000);
        expect(await restore(first.reportId, 2)).toMatchObject({ status: 422, json: { code: 'RESTORE_WINDOW_EXPIRED' } });
        expect(await state(first.reportId)).toMatchObject({ status: 'DRAFT', version: '2' });
        expect((await read(first.reportId)).json).toMatchObject({ deleted: true });
      } finally {
        clockNow = now;
      }
    });

    it('AC-ST-DIS-007-2: the restore judges the permission of the caller now: a person who may only read or review is 403 wherever they sit, another tenant is 404, a stale version is 409', async () => {
      const { reportId } = await aDraft();
      await remove(reportId, 1);
      expect((await restore(reportId, 2, READER)).status).toBe(403);
      expect((await restore(reportId, 2, REVIEWER)).status).toBe(403);
      expect((await restore(reportId, 2, ELSEWHERE_REVIEWER)).status).toBe(403);
      expect((await restore(reportId, 2, MAKER, { tenantId: TENANT_B })).status).toBe(404);
      expect((await restore(reportId, 9)).json).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 2 });
      expect(await restore(randomUUID(), 1)).toMatchObject({ status: 404 });
      expect((await read(reportId)).json).toMatchObject({ deleted: true });
    });

    it('does not restore what was not deleted (409 REPORT_STATE_INVALID), and does not delete a draft twice (409 REPORT_NOT_EDITABLE)', async () => {
      const { reportId } = await aDraft();
      expect(await restore(reportId, 1)).toMatchObject({ status: 409, json: { code: 'REPORT_STATE_INVALID' } });
      await remove(reportId, 1);
      expect(await remove(reportId, 2)).toMatchObject({ status: 409, json: { code: 'REPORT_NOT_EDITABLE' } });
      expect(await save(reportId, draft(randomUUID(), randomUUID(), randomUUID()), 2)).toMatchObject({ status: 409, json: { code: 'REVISION_IMMUTABLE' } });
    });

    it('answers the same key with the same answer and changes nothing twice', async () => {
      const { reportId } = await aDraft();
      const key = `key-${randomUUID()}`;
      const first = await call('POST', `/reports/${reportId}/draft-deletion`, { member: MAKER, body: { reason: 'Started in the wrong week.' }, ifMatch: '"1"', key });
      const again = await call('POST', `/reports/${reportId}/draft-deletion`, { member: MAKER, body: { reason: 'Started in the wrong week.' }, ifMatch: '"1"', key });
      expect(first.status).toBe(200);
      expect(again.json).toEqual(first.json);
      expect((await trail(reportId)).filter((row) => row.action === 'dis.report_draft_deleted')).toHaveLength(1);
    });
  });

  describe('the bulk import of weekly reports (ST-DIS-008)', () => {
    const HEADER = 'project_code,cy_central,cy_central_ctmtqg,cy_local,cy_local_ctmtqg,co_central,co_central_ctmtqg,co_local,co_local_ctmtqg,other_central,other_local,total_cumulative_vnd,construction_vnd,acceptance_vnd,treasury_submitted_vnd,preparing_dossier_vnd,physical_progress_pct,negative_delta_explanation';
    /** FX-DIS-001 for a project: 100/200/30/70/0/20 million, CTMTQG 40 million, 420 million in all. */
    const line = (code: string, over: Record<string, string> = {}): string => {
      const row: Record<string, string> = { project_code: code, cy_central: '100000000', cy_central_ctmtqg: '40000000', cy_local: '200000000', cy_local_ctmtqg: '', co_central: '30000000', co_central_ctmtqg: '', co_local: '70000000', co_local_ctmtqg: '', other_central: '0', other_local: '20000000', total_cumulative_vnd: '420000000', construction_vnd: '', acceptance_vnd: '', treasury_submitted_vnd: '', preparing_dossier_vnd: '', physical_progress_pct: '', negative_delta_explanation: '', ...over };
      return HEADER.split(',').map((column) => row[column] as string).join(',');
    };
    const workbook = (lines: readonly string[], header = HEADER): Uint8Array => new TextEncoder().encode(`${header}\n${lines.join('\n')}\n`);

    async function upload(member: number, bytes: Uint8Array, options: { type?: string; tenantId?: string; name?: string } = {}): Promise<Reply> {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: options.type ?? 'text/csv' }), options.name ?? 'weekly.csv');
      const response = await fetch(`${app.baseUrl}/report-imports/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member, options.tenantId), 'idempotency-key': `key-${randomUUID()}` }, body: form });
      return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
    }
    const createImport = (period: string, stored: Reply, member = MAKER, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> =>
      call('POST', '/report-imports', { member, body: { period_id: period, file_object_key: stored.json.file_object_key, file_sha256: stored.json.file_sha256, mapping_version: 'DIS-WEEKLY-1', ...extra }, ...options });
    const applyImport = (importId: string, version: number, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', `/report-imports/${importId}/apply`, { member, body: {}, ifMatch: `"${version}"`, ...options });
    const batch = (importId: string, member = MAKER): Promise<Reply> => call('GET', `/report-imports/${importId}`, { member });
    const projectsFor = async (count: number): Promise<string[]> => {
      const codes: string[] = [];
      for (let n = 0; n < count; n += 1) {
        const { projectId } = await seedProject();
        codes.push((await rows<{ code: string }>('select code from machvon.project where id = $1', [projectId]))[0]?.code as string);
      }
      return codes;
    };
    const draftsOf = (periodId: string) => rows<{ id: string; status: string; source_kind: string; import_batch_id: string | null; project_id: string }>('select id, status, source_kind, import_batch_id, project_id from machvon.report_revision where period_id = $1 order by created_at', [periodId]);

    it('AC-ST-DIS-008-1 / UAT-AC258: a workbook of 20 rows with an unknown project (row 5) and a CTMTQG above its cell (row 9) is a dry run with 2 error rows; apply is 422 IMPORT_HAS_ERRORS; the corrected file creates 20 drafts of source IMPORT; applying it again is 409 IMPORT_FILE_ALREADY_APPLIED', async () => {
      const period = week();
      const codes = await projectsFor(20);
      const bad = codes.map((code, index) => (index === 3 ? line('NO-SUCH-PROJECT') : index === 7 ? line(code, { cy_central_ctmtqg: '150000000' }) : line(code)));
      const stored = await upload(MAKER, workbook(bad));
      expect(stored).toMatchObject({ status: 200, json: { format: 'CSV', row_count: 20 } });
      expect((stored.json.columns as string[]).slice(0, 3)).toEqual(['project_code', 'cy_central', 'cy_central_ctmtqg']);
      const dry = await createImport(period, stored);
      expect(dry).toMatchObject({ status: 200, json: { status: 'DRY_RUN', resource_version: 1 } });
      const view = (await batch(idOf(dry))).json;
      expect(view).toMatchObject({ status: 'DRY_RUN', total_rows: 20, valid_rows: 18, error_rows: 2, mapping_version: 'DIS-WEEKLY-1', drafts_created: 0, applied_at: null });
      expect(view.errors).toEqual([
        { line: 5, project_code: 'NO-SUCH-PROJECT', field: 'project_code', code: 'PROJECT_NOT_FOUND' },
        { line: 9, project_code: codes[7], field: 'cy_central_ctmtqg', code: 'SUBSET_EXCEEDS_PARENT' },
      ]);
      expect(await applyImport(idOf(dry), 1)).toMatchObject({ status: 422, json: { code: 'IMPORT_HAS_ERRORS', error_rows: 2 } });
      expect(await draftsOf(period)).toEqual([]);

      const good = await upload(MAKER, workbook(codes.map((code) => line(code))));
      const validated = await createImport(period, good);
      expect(validated).toMatchObject({ status: 200, json: { status: 'VALIDATED' } });
      expect(await applyImport(idOf(validated), 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT', current_version: 1 } });
      const applied = await applyImport(idOf(validated), 1);
      expect(applied).toMatchObject({ status: 200, json: { status: 'APPLIED', resource_version: 2, resource_id: idOf(validated) } });
      const drafts = await draftsOf(period);
      expect(drafts).toHaveLength(20);
      expect(drafts.every((draft) => draft.status === 'DRAFT' && draft.source_kind === 'IMPORT' && draft.import_batch_id === idOf(validated))).toBe(true);
      expect((await batch(idOf(validated))).json).toMatchObject({ status: 'APPLIED', drafts_created: 20, drafts_updated: 0, applied_by: memberId(MAKER) });
      expect(await applyImport(idOf(validated), 2)).toMatchObject({ status: 409, json: { code: 'IMPORT_FILE_ALREADY_APPLIED' } });
      expect(await createImport(period, good)).toMatchObject({ status: 409, json: { code: 'IMPORT_FILE_ALREADY_APPLIED' } });
      expect(await draftsOf(period)).toHaveLength(20);
      // The report of a project is the one the file said: six cells and the CTMTQG apart.
      const found = (await read(drafts[0]?.id as string)).json;
      expect(found).toMatchObject({ status: 'DRAFT', totals: { cumulative_vnd: '420000000', ctmtqg_vnd: '40000000' } });
    });

    it('AC-ST-DIS-008-2 / DQ01: a project named twice, an amount that is not the total and a project that is not there go to the error report; the rows that are in order are counted apart; sending the same file again adds nothing', async () => {
      const period = week();
      const [one, two, three] = await projectsFor(3);
      const file = workbook([line(one as string), line(two as string), line(two as string, { cy_local: '1', total_cumulative_vnd: '220000001' }), line(three as string, { total_cumulative_vnd: '419999999' }), line('ORPHAN-1')]);
      const stored = await upload(MAKER, file);
      const dry = await createImport(period, stored);
      const view = (await batch(idOf(dry))).json;
      expect(view).toMatchObject({ status: 'DRY_RUN', total_rows: 5, valid_rows: 1, error_rows: 4 });
      expect((view.errors as Array<{ line: number; code: string }>).map((entry) => [entry.line, entry.code])).toEqual([
        [3, 'PROJECT_DUPLICATE_IN_FILE'],
        [4, 'PROJECT_DUPLICATE_IN_FILE'],
        [5, 'TOTAL_MISMATCH'],
        [6, 'PROJECT_NOT_FOUND'],
      ]);
      expect(await applyImport(idOf(dry), 1)).toMatchObject({ status: 422, json: { code: 'IMPORT_HAS_ERRORS' } });
      // Sending the file again is another dry run of the same file: still nothing to apply, and no draft anywhere.
      const again = await createImport(period, stored);
      expect(idOf(again)).not.toBe(idOf(dry));
      expect(await draftsOf(period)).toEqual([]);
    });

    it('judges again at the apply: a project that was reported on since the dry run is 422 IMPORT_HAS_ERRORS and a period that was locked is 409 PERIOD_LOCKED, with nothing written', async () => {
      const period = week();
      const [one, two] = await projectsFor(2);
      const validated = await createImport(period, await upload(MAKER, workbook([line(one as string), line(two as string)])));
      expect(validated.json.status).toBe('VALIDATED');
      const { projectId, planId } = { projectId: (await rows<{ id: string }>('select id from machvon.project where code = $1', [two]))[0]?.id as string, planId: (await rows<{ id: string }>('select p.id from machvon.plan_version p join machvon.project j on j.id = p.project_id where j.code = $1', [two]))[0]?.id as string };
      const made = await create(draft(projectId, period, planId));
      await submit(idOf(made), 1);
      expect(await applyImport(idOf(validated), 1)).toMatchObject({ status: 422, json: { code: 'IMPORT_HAS_ERRORS', error_rows: 1 } });
      expect(await draftsOf(period)).toHaveLength(1);
      const locked = week();
      const [three] = await projectsFor(1);
      const second = await createImport(locked, await upload(MAKER, workbook([line(three as string)])));
      await lockPeriod(locked);
      expect(await applyImport(idOf(second), 1)).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
      expect(await draftsOf(locked)).toEqual([]);
    });

    it('brings up to date the draft a project has, keeping what the import does not carry, and counts it apart; the key answers once', async () => {
      const period = week();
      const [code] = await projectsFor(1);
      const projectId = (await rows<{ id: string }>('select id from machvon.project where code = $1', [code]))[0]?.id as string;
      const planId = (await rows<{ id: string }>('select p.id from machvon.plan_version p where p.project_id = $1', [projectId]))[0]?.id as string;
      const made = await create(draft(projectId, period, planId, { narrative: { results: 'The deck was poured.' } }));
      const validated = await createImport(period, await upload(MAKER, workbook([line(code as string, { cy_local: '250000000', total_cumulative_vnd: '470000000' })])));
      const key = `key-${randomUUID()}`;
      const done = await applyImport(idOf(validated), 1, MAKER, { key });
      expect(done).toMatchObject({ status: 200, json: { status: 'APPLIED' } });
      expect((await applyImport(idOf(validated), 1, MAKER, { key })).json).toEqual(done.json);
      expect((await batch(idOf(validated))).json).toMatchObject({ drafts_created: 0, drafts_updated: 1 });
      expect(await draftsOf(period)).toEqual([{ id: idOf(made), status: 'DRAFT', source_kind: 'IMPORT', import_batch_id: idOf(validated), project_id: projectId }]);
      const found = (await read(idOf(made))).json;
      expect(found).toMatchObject({ totals: { cumulative_vnd: '470000000' }, narrative: { results: 'The deck was poured.' } });
      expect((await trail(idOf(validated))).map((entry) => entry.action)).toEqual(['dis.report_import_validated', 'dis.report_import_applied']);
      expect(await events(idOf(validated), 'report.import_applied.v1')).toHaveLength(1);
    });

    it('refuses the file before it is judged: a layout that is not known (422 MAPPING_VERSION_UNKNOWN), a column the layout needs (422 IMPORT_SCHEMA_INVALID), bytes that are not the file named (422), a period that is not a week or not there', async () => {
      const period = week();
      const [code] = await projectsFor(1);
      const stored = await upload(MAKER, workbook([line(code as string)]));
      expect(await createImport(period, stored, MAKER, { mapping_version: 'DIS-WEEKLY-9' })).toMatchObject({ status: 422, json: { code: 'MAPPING_VERSION_UNKNOWN' } });
      const lacking = await upload(MAKER, workbook([`${code},1`], 'project_code,cy_central'));
      expect(await createImport(period, lacking)).toMatchObject({ status: 422, json: { code: 'IMPORT_SCHEMA_INVALID' } });
      expect(await createImport(period, stored, MAKER, { file_sha256: 'f'.repeat(64) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'file_sha256' } });
      expect(await createImport(randomUUID(), stored)).toMatchObject({ status: 404 });
      const month = (await rows<{ id: string }>("select id from machvon.reporting_period where period_type = 'MONTH' limit 1"))[0]?.id ?? (await rows<{ id: string }>("select id from machvon.reporting_period where period_type <> 'WEEK' limit 1"))[0]?.id;
      if (month !== undefined) expect(await createImport(month, stored)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'period_id' } });
      expect(await upload(MAKER, eicarBytes())).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
      expect(await upload(MAKER, new TextEncoder().encode('%PDF-1.4 not a table'), { type: 'application/pdf', name: 'weekly.pdf' })).toMatchObject({ status: 422 });
    });

    it('is for the person who may import on the project: a reader is 403 everywhere, another branch finds no project, another tenant finds no batch', async () => {
      const period = week();
      const [code] = await projectsFor(1);
      const file = workbook([line(code as string)]);
      expect((await upload(READER, file)).status).toBe(403);
      const stored = await upload(MAKER, file);
      expect((await createImport(period, stored, READER)).status).toBe(403);
      const dry = await createImport(period, stored, ELSEWHERE_IMPORTER);
      expect(dry).toMatchObject({ status: 200, json: { status: 'DRY_RUN' } });
      expect((await batch(idOf(dry), ELSEWHERE_IMPORTER)).json.errors).toEqual([{ line: 2, project_code: code, field: 'project_code', code: 'PROJECT_NOT_FOUND' }]);
      // A batch is its maker's alone: its faults name projects of their scope, so another holder of the right finds none.
      expect((await batch(idOf(dry), MAKER)).status).toBe(404);
      expect((await applyImport(idOf(dry), 1, MAKER)).status).toBe(404);
      const validated = await createImport(period, stored);
      expect((await applyImport(idOf(validated), 1, READER)).status).toBe(403);
      expect((await batch(idOf(validated), READER)).status).toBe(403);
      expect((await call('GET', `/report-imports/${idOf(validated)}`, { member: B_MAKER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/report-imports/${randomUUID()}`, { member: MAKER })).status).toBe(404);
    });
  });

  describe('web and mobile file the same report, and a phone that replays its queue (ST-DIS-017)', () => {
    const NEXT_MONTH: Record<string, { next_month_vnd: string; next_month_ctmtqg_subset_vnd?: string }> = {
      'CURRENT_YEAR/CENTRAL': { next_month_vnd: '100000000', next_month_ctmtqg_subset_vnd: '20000000' },
      'CURRENT_YEAR/LOCAL': { next_month_vnd: '120000000' },
      'CARRYOVER/CENTRAL': { next_month_vnd: '50000000' },
      'CARRYOVER/LOCAL': { next_month_vnd: '30000000' },
    };
    const withRegistration = FX_DIS_001.map((line) => ({ ...line, ...(NEXT_MONTH[`${line.bucket}/${line.budget_level}`] ?? {}) }));
    const consumer = (): RegistrationConsumer => new RegistrationConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: SIGNING_KEY } });
    const deliver = async (reportId: string): Promise<string> => {
      const [event] = await rows<{ id: string; payload: Record<string, unknown> }>("select id, payload from machvon.outbox_event where aggregate_id = $1 and type = 'report.accepted.v1'", [reportId]);
      return consumer().handle({
        id: event?.id as string,
        tenantId: TENANT_A,
        tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, SIGNING_KEY),
        type: 'report.accepted.v1',
        payload: event?.payload as Record<string, unknown>,
      });
    };
    /** A week of October 2027: the registration it carries is for November. */
    const octoberWeek = async (): Promise<string> =>
      (await rows<{ id: string }>("select id from machvon.reporting_period where period_type = 'WEEK' and calendar_code = 'DEFAULT' and fiscal_year = 2027 and end_date between date '2027-10-17' and date '2027-10-31' order by end_date limit 1"))[0]?.id as string;
    const fileOnWeb = async (period: string) => {
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, period, planId, { funding_lines: withRegistration }));
      expect(made.status).toBe(200);
      expect(await submit(idOf(made), 1)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
      return { projectId, reportId: idOf(made) };
    };
    /** The phone files the same report from its queue: every command carries the local id, and the draft is saved before it is handed in. */
    const fileOnPhone = async (period: string) => {
      const { projectId, planId } = await seedProject();
      const operation = randomUUID();
      const made = await create(draft(projectId, period, planId, { client_operation_id: operation, funding_lines: FX_DIS_001 }));
      expect(made.status).toBe(200);
      const saved = await save(idOf(made), draft(projectId, period, planId, { client_operation_id: operation, funding_lines: withRegistration }), 1);
      expect(saved.status).toBe(200);
      expect(await submit(idOf(made), 2)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
      return { projectId, reportId: idOf(made), operation };
    };

    it('AC-ST-DIS-017-1 / UAT-AC264: the web and the phone file a report each for different projects with the same structure and total 420 million, and 300 million registered for next month become the REGISTERED rows of November once both are accepted', async () => {
      const period = await octoberWeek();
      const web = await fileOnWeb(period);
      const phone = await fileOnPhone(period);
      const shape = (value: unknown): unknown => (Array.isArray(value) ? value.map(shape) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])])) : typeof value);
      const [onWeb, onPhone] = [await read(web.reportId), await read(phone.reportId)];
      for (const found of [onWeb, onPhone]) {
        expect(found.json).toMatchObject({ status: 'SUBMITTED', totals: { cumulative_vnd: '420000000', next_month_vnd: '300000000' } });
      }
      // The same payload structure: every member that the one has, the other has, with the same kind of value.
      expect(shape(onWeb.json)).toEqual(shape(onPhone.json));
      expect((await approve(web.reportId, 2)).status).toBe(200);
      expect((await approve(phone.reportId, 3)).status).toBe(200);
      expect(await deliver(web.reportId)).toBe('processed');
      expect(await deliver(phone.reportId)).toBe('processed');
      for (const filed of [web, phone]) {
        const registered = await rows<{ plan_year: number; month: number; amount_vnd: string; source_report_revision_id: string }>(
          "select plan_year, month, amount_vnd::text as amount_vnd, source_report_revision_id from machvon.disbursement_schedule_line where project_id = $1 and kind = 'REGISTERED' and is_current order by bucket, budget_level",
          [filed.projectId],
        );
        expect(registered.map((row) => [row.plan_year, row.month])).toEqual([[2027, 11], [2027, 11], [2027, 11], [2027, 11]]);
        expect(registered.reduce((sum, row) => sum + BigInt(row.amount_vnd), 0n)).toBe(300_000_000n);
        expect(new Set(registered.map((row) => row.source_report_revision_id))).toEqual(new Set([filed.reportId]));
      }
    });

    it('AC-ST-DIS-017-2 / MOB01: a draft made offline and sent twice after the reconnect is one revision, and a queued save that was written against a version the server has moved past is a conflict the user resolves, not a silent overwrite of money', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const operation = randomUUID();
      const body = draft(projectId, period, planId, { client_operation_id: operation });
      const first = await create(body);
      const again = await create(body);
      expect(again).toMatchObject({ status: 200, json: { resource_id: idOf(first), resource_version: 1 } });
      expect(await rows('select id from machvon.report_revision where project_id = $1', [projectId])).toHaveLength(1);
      // Two devices of one person, or the phone and the web, wrote against version 1: the first save wins the version, the second finds it moved.
      const forWeb = FX_DIS_001.map((line) => (line.bucket === 'CURRENT_YEAR' && line.budget_level === 'CENTRAL' ? { ...line, cumulative_vnd: '110000000' } : line));
      const forPhone = FX_DIS_001.map((line) => (line.bucket === 'CURRENT_YEAR' && line.budget_level === 'CENTRAL' ? { ...line, cumulative_vnd: '120000000' } : line));
      expect((await save(idOf(first), draft(projectId, period, planId, { funding_lines: forWeb }), 1)).status).toBe(200);
      const stale = await save(idOf(first), draft(projectId, period, planId, { funding_lines: forPhone }), 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      // The conflict leaves the server as the web wrote it; the phone reads it and puts its figure to the user.
      const found = (await read(idOf(first))).json.funding_lines as Array<Record<string, unknown>>;
      expect(found.find((line) => line.bucket === 'CURRENT_YEAR' && line.budget_level === 'CENTRAL')?.cumulative_vnd).toBe('110000000');
      expect((await state(idOf(first)))?.version).toBe('2');
    });

    it('AC-ST-DIS-017-3 / MOB02: a command that was queued under one tenant and sent under another reaches nothing: the report is not found and is not changed', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId, { client_operation_id: randomUUID() }));
      const before = await state(idOf(made));
      const foreign = await call('POST', `/reports/${idOf(made)}/revisions`, { member: B_MAKER, tenantId: TENANT_B, body: draft(projectId, period, planId, { funding_lines: FX_DIS_001 }), ifMatch: '"1"' });
      expect(foreign.status).toBe(404);
      expect((await call('POST', `/reports/${idOf(made)}/submit`, { member: B_MAKER, tenantId: TENANT_B, body: {}, ifMatch: '"1"' })).status).toBe(404);
      expect(await state(idOf(made))).toEqual(before);
    });
  });
  describe('the structured narrative of a period (ENT-3b: DL.01, CN.02)', () => {
    const CAUSE = 'SITE_HANDOVER';
    const block = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ enterprise: { status: 'Works continue.', schedule: 'Milestone 3 is late.', cause_codes: [CAUSE], ...extra } });
    const context = (reportId: string, member = MAKER): Promise<Reply> => call('GET', `/reports/${reportId}/narrative-context`, { member });
    const inherit = (reportId: string, version: number, body: Record<string, unknown> = {}, member = MAKER): Promise<Reply> => call('POST', `/reports/${reportId}/narrative-inheritance`, { member, body, ifMatch: `"${version}"` });
    const csv = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join('\n')}\n`);
    async function upload(bytes: Uint8Array): Promise<Reply> {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'text/csv' }), 'narratives.csv');
      const response = await fetch(`${app.baseUrl}/report-imports/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(MAKER), 'idempotency-key': `key-${randomUUID()}` }, body: form });
      return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
    }

    beforeAll(async () => {
      await seedReplica([
        [
          "insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, current_version_id, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $4, 'EFFECTIVE', $3, $5, $5)",
          [TENANT_A, id(FAMILY, 60), id(FAMILY, 61), CAUSE, memberId(MAKER)],
        ],
        [
          `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
           values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, 'Site handover', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $5, $5)`,
          [TENANT_A, id(FAMILY, 61), id(FAMILY, 60), CAUSE, memberId(MAKER)],
        ],
      ]);
    });

    it('keeps the eight fields and the standard causes with the draft and gives them back in the detail', async () => {
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, week(), planId, { narrative: block({ difficulties: 'Compensation is not agreed.', next_plan: 'Hand over the site.' }) }));
      expect(made.status).toBe(200);
      const found = await read(idOf(made));
      expect(found.json.narrative).toMatchObject({ enterprise: { status: 'Works continue.', schedule: 'Milestone 3 is late.', difficulties: 'Compensation is not agreed.', next_plan: 'Hand over the site.', disbursement: null, cause_codes: [CAUSE], directive_refs: [], inheritance: null } });
      const audit = (await trail(idOf(made))).find((row) => row.action === 'dis.report_created');
      expect(audit?.safe_diff).toMatchObject({ enterprise_fields: 4, enterprise_causes: 1, enterprise_directives: 0 });
      expect(JSON.stringify(audit?.safe_diff)).not.toContain('Works continue');
    });

    it('refuses a cause that is not on the list and a directive the register does not show, and writes nothing', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const unknown = await create(draft(projectId, period, planId, { narrative: block({ cause_codes: ['NOT_ON_THE_LIST'] }) }));
      expect(unknown).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(JSON.stringify(unknown.json)).toContain('narrative.enterprise.cause_codes[0]');
      const directive = await create(draft(projectId, period, planId, { narrative: block({ directive_refs: [{ id: randomUUID(), code: 'CD-1', status_at_end: 'DONE' }] }) }));
      expect(directive).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(JSON.stringify(directive.json)).toContain('narrative.enterprise.directive_refs[0].id');
      expect(await rows('select id from machvon.report_revision where project_id = $1', [projectId])).toHaveLength(0);
    });

    it('gives the context of a report: the fields, the standard causes, the rules and the previous period that can be inherited', async () => {
      const { projectId, planId } = await seedProject();
      const made = await create(draft(projectId, week(), planId, { narrative: block() }));
      const found = await context(idOf(made));
      expect(found.status).toBe(200);
      expect(found.json).toMatchObject({ report_id: idOf(made), causes: [{ code: CAUSE, label: 'Site handover' }], previous: null, inheritance: null, unchanged_inherited: [], directives: { items: [] }, verdict: { blocking: [], warnings: [] } });
      expect(found.json.fields).toEqual(['status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals']);
      expect(found.json.mandatory).toContain('NARRATIVE_STATUS');
      expect((await context(idOf(made), READER)).status).toBe(200);
      expect((await call('GET', `/reports/${idOf(made)}/narrative-context`, { member: B_MAKER, tenantId: TENANT_B })).status).toBe(404);
    });

    it('copies the words of the previous period into the empty fields with a trace, never over what was written, and says when there is nothing to copy', async () => {
      const { projectId, planId } = await seedProject();
      const first = await submitted({ project: { projectId, planId }, extra: { narrative: block({ proposals: 'Ask the group for support.' }) } });
      const next = await create(draft(projectId, week(), planId, { narrative: { enterprise: { status: 'New status of this period.' } } }));
      expect(next.status).toBe(200);
      const before = await context(idOf(next));
      expect(before.json.previous).toMatchObject({ report_id: first.reportId, fields: ['status', 'schedule', 'proposals'], cause_codes: [CAUSE] });
      const copied = await inherit(idOf(next), 1);
      expect(copied).toMatchObject({ status: 200, json: { resource_version: 2 } });
      const detail = await read(idOf(next));
      expect(detail.json.narrative).toMatchObject({ enterprise: { status: 'New status of this period.', schedule: 'Milestone 3 is late.', proposals: 'Ask the group for support.', cause_codes: [CAUSE], inheritance: { from_report_id: first.reportId, fields: ['schedule', 'proposals'], unchanged_fields: ['schedule', 'proposals'] } } });
      expect((await trail(idOf(next))).some((row) => row.action === 'dis.report_narrative_inherited')).toBe(true);
      // The words that were copied and then rewritten stop counting as inherited, and a second copy has nothing left to fill.
      const period = (detail.json.period as { id: string }).id;
      const rewritten = await save(idOf(next), draft(projectId, period, planId, { narrative: { enterprise: { status: 'New status of this period.', schedule: 'Rewritten.', proposals: 'Ask the group for support.', cause_codes: [CAUSE] } } }), 2);
      expect(rewritten.status).toBe(200);
      expect((await context(idOf(next))).json).toMatchObject({ inheritance: { from_report_id: first.reportId }, unchanged_inherited: ['proposals'] });
      expect(await inherit(idOf(next), 3)).toMatchObject({ status: 409, json: { code: 'NARRATIVE_NOTHING_TO_INHERIT' } });
    });

    it('does not copy from a project with no report handed in, and not into a report that was handed in', async () => {
      const { projectId, planId } = await seedProject();
      const only = await create(draft(projectId, week(), planId, { narrative: block() }));
      expect(await inherit(idOf(only), 1)).toMatchObject({ status: 409, json: { code: 'NARRATIVE_NOTHING_TO_INHERIT' } });
      const sent = await submitted();
      expect(await inherit(sent.reportId, 2)).toMatchObject({ status: 409, json: { code: 'REVISION_IMMUTABLE' } });
    });

    it('UAT-DIS-ENT3B-1: the author inherits the previous period into the empty fields only and the source period is recorded; a second time has nothing to inherit; a submitted report, a locked period and a stale version are 409; the template is 403 without the import right', async () => {
      const { projectId, planId } = await seedProject();
      const first = await submitted({ project: { projectId, planId }, extra: { narrative: block({ proposals: 'Ask the group for support.' }) } });
      // A draft of the next period with one field written and the others empty.
      const next = await create(draft(projectId, week(), planId, { narrative: { enterprise: { status: 'New status of this period.' } } }));
      expect(next.status).toBe(200);
      // Step 1: only the empty fields are filled, the written one is unchanged, and the period it came from is recorded.
      const copied = await inherit(idOf(next), 1);
      expect(copied).toMatchObject({ status: 200, json: { resource_version: 2 } });
      const detail = await read(idOf(next));
      expect(detail.json.narrative).toMatchObject({ enterprise: { status: 'New status of this period.', schedule: 'Milestone 3 is late.', proposals: 'Ask the group for support.', inheritance: { from_report_id: first.reportId, fields: ['schedule', 'proposals'] } } });
      expect((await context(idOf(next))).json).toMatchObject({ inheritance: { from_report_id: first.reportId, from_period_id: first.period } });
      const periodCode = (await rows<{ code: string }>('select code from machvon.reporting_period where id = $1', [first.period]))[0]?.code;
      expect((await trail(idOf(next))).find((row) => row.action === 'dis.report_narrative_inherited')?.safe_diff).toMatchObject({ from_report_id: first.reportId, from_period_code: periodCode, copied_fields: ['schedule', 'proposals', 'causes'] });
      // Step 2: nothing is left to copy. The registry of the design (error_codes.json) gives this code 409; the text of the case says 422, the product follows the registry.
      expect(await inherit(idOf(next), 2)).toMatchObject({ status: 409, json: { code: 'NARRATIVE_NOTHING_TO_INHERIT' } });
      // Step 3: a report that was handed in, a period that is locked and a version that moved.
      expect(await inherit(first.reportId, 2)).toMatchObject({ status: 409, json: { code: 'REVISION_IMMUTABLE' } });
      const lockedPeriod = week();
      const inLocked = await create(draft(projectId, lockedPeriod, planId, { narrative: { enterprise: { status: 'Written before the lock.' } } }));
      expect(inLocked.status).toBe(200);
      await lockPeriod(lockedPeriod);
      expect(await inherit(idOf(inLocked), 1)).toMatchObject({ status: 409, json: { code: 'PERIOD_LOCKED' } });
      const stale = await create(draft(projectId, week(), planId, { narrative: { enterprise: { status: 'A third draft.' } } }));
      expect(await inherit(idOf(stale), 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await state(idOf(stale)))?.version).toBe('1');
      // Step 4: the template is for who may import (the maker does), not for a reader.
      expect((await call('GET', `/report-narrative-template?period_id=${week()}`, { member: MAKER })).status).toBe(200);
      expect((await call('GET', `/report-narrative-template?period_id=${week()}`, { member: READER })).status).toBe(403);
    });

    it('serves the Excel template prefilled with the projects that have a draft, and the file is read back by the import: dry run, fault by line, then apply once', async () => {
      const { projectId, planId } = await seedProject();
      const period = week();
      const made = await create(draft(projectId, period, planId));
      const code = (await rows<{ code: string }>('select code from machvon.project where id = $1', [projectId]))[0]?.code as string;
      const template = await call('GET', `/report-narrative-template?period_id=${period}`, { member: MAKER });
      expect(template.status).toBe(200);
      expect(template.json).toMatchObject({ mapping_version: 'ENT-NARRATIVE-1', causes: [{ code: CAUSE, label: 'Site handover' }] });
      expect(template.json.columns).toEqual(['project_code', 'status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals', 'cause_codes']);
      const table = readTabularFile(new Uint8Array(Buffer.from(template.json.content_base64 as string, 'base64')));
      expect(table.headers.slice(0, 2)).toEqual(['project_code', 'status']);
      expect(table.rows.map((row) => row[0])).toContain(code);

      const startImport = (stored: Reply): Promise<Reply> => call('POST', '/report-imports', { member: MAKER, body: { period_id: period, file_object_key: stored.json.file_object_key, file_sha256: stored.json.file_sha256, mapping_version: 'ENT-NARRATIVE-1' } });
      const bad = await startImport(await upload(csv(['project_code,status,cause_codes', `${code},From the file,NOT_ON_THE_LIST`, 'NO-SUCH,x,'])));
      const failed = await call('GET', `/report-imports/${idOf(bad)}`, { member: MAKER });
      expect(failed.json).toMatchObject({ status: 'DRY_RUN', error_rows: 2 });
      expect((failed.json.errors as Array<{ line: number; code: string }>).map((one) => `${one.line}:${one.code}`)).toEqual(['2:CAUSE_CODE_UNKNOWN', '3:PROJECT_NOT_FOUND']);
      expect(await call('POST', `/report-imports/${idOf(bad)}/apply`, { member: MAKER, body: {}, ifMatch: '"1"' })).toMatchObject({ status: 422, json: { code: 'IMPORT_HAS_ERRORS' } });

      const good = await startImport(await upload(csv(['project_code,status,schedule,disbursement,next_plan,cause_codes', `${code},From the file,On time,Half of the plan,Finish the roof,${CAUSE}`])));
      expect((await call('GET', `/report-imports/${idOf(good)}`, { member: MAKER })).json).toMatchObject({ status: 'VALIDATED', valid_rows: 1, error_rows: 0 });
      const before = await state(idOf(made));
      const applied = await call('POST', `/report-imports/${idOf(good)}/apply`, { member: MAKER, body: {}, ifMatch: '"1"' });
      expect(applied).toMatchObject({ status: 200, json: { status: 'APPLIED' } });
      const after = await state(idOf(made));
      expect(Number(after?.version)).toBe(Number(before?.version) + 1);
      expect(after?.payload_hash).not.toBe(before?.payload_hash);
      expect((await read(idOf(made))).json.narrative).toMatchObject({ enterprise: { status: 'From the file', schedule: 'On time', disbursement: 'Half of the plan', next_plan: 'Finish the roof', cause_codes: [CAUSE] } });
      expect(await call('POST', `/report-imports/${idOf(good)}/apply`, { member: MAKER, body: {}, ifMatch: '"2"' })).toMatchObject({ status: 409, json: { code: 'IMPORT_FILE_ALREADY_APPLIED' } });
    });
  });

});
