import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { DEMO_MARK, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { enterpriseReportBundles, registerEnterpriseReportRules } from '@machvon/edition-enterprise/src/server.ts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { EnterpriseSnapshotProvider } from '../../src/editions/enterprise/snapshot-provider';
import { EnterpriseSnapshotController } from '../../src/modules/fnd/enterprise-snapshot.controller';
import { FND_CLOCK, FUNDING_PACK_CODE } from '../../src/modules/fnd/tokens';
import { PeriodReopenController } from '../../src/modules/dis/period-reopen.controller';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { REPORT_FORMS, registerPublicReportForms } from '../../src/modules/reports';
import { ReportController } from '../../src/modules/reports/report.controller';
import { ReportReadsController } from '../../src/modules/reports/report-reads.controller';
import { REPORT_CLOCK } from '../../src/modules/reports/tokens';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * ENT-3a end to end, DL.03 and BC.01 on the data side: the enterprise snapshot is built and frozen with the commands of the product from the accepted figures, a DEMO form is generated from the frozen snapshot, checked, approved and
 * issued, the reopening of the period is asked and decided by two people, the next revision of the snapshot is built and frozen, and the form of the new revision is issued as revision 2 while revision 1 stays what it was.
 * The name ends in `.enterprise.test.ts`: it is one of the few sources that may name the enterprise package.
 */
jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const BUILDER = 1;
const FREEZER = 2;
const PREPARER = 3;
const CHECKER = 4;
const APPROVER = 5;
const MAKER = 6; // asks for the reopening
const DECIDER = 7; // decides it
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0x9b;
const T0 = new Date('2026-11-08T03:00:00Z');
const MONTH = { kind: 'MONTH', year: 2026, index: 10 };
const hours = (n: number): Date => new Date(T0.getTime() + n * 3_600_000);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('from the frozen enterprise snapshot to the issued form, and a revision after the reopening (ENT-3a)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let clock = T0;
  let periodId = '';
  let projectId = '';
  let firstSnapshot = '';
  let secondSnapshot = '';
  let firstIssue = '';
  let firstIssueSha = '';
  const saved = process.env.DEMO_FORMS;
  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const step = (member: number, draftId: string, version: number, action: 'check' | 'approve' | 'issue'): Promise<Reply> => call('POST', `/report-engine/drafts/${draftId}/${action}`, { member, ifMatch: version });
  const generate = (reason?: string): Promise<Reply> => call('POST', '/report-engine/drafts', { member: PREPARER, body: { layout_code: 'PVN-MONTHLY', period: MONTH, ...(reason === undefined ? {} : { reason }) } });

  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** The accepted actuals of January to October, as the figure store leaves them after a preparer and a checker (the batches are covered by the tests of FND-1): the figure in October, zeros before it. */
  const actual = (amount: string, revision: number): Promise<void> =>
    seed([
      // A correction supersedes the figures in force: there is one current row per cell.
      ...(revision === 1 ? [] : ([[`update machvon.plan_figure_revision set status = 'SUPERSEDED' where project_id = $1::uuid and status = 'ACCEPTED'`, [projectId]]] as Array<[string, unknown[]]>)),
      [
        `insert into machvon.plan_figure_revision (tenant_id, id, batch_id, project_id, taxonomy_pack, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, amount_vnd, basis, as_of_date, revision, status, prepared_by, approved_by, approved_at, updated_by)
         select $1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, 'ENTERPRISE', 'EQUITY', 'ALL', 'DISBURSED', 'ACTUAL', 'MONTH', 2026, m::smallint, case when m = 10 then $4::numeric else 0 end, 'REPORTED', '2026-11-03'::date, $5::int, 'ACCEPTED', $6::uuid, $7::uuid, now(), $6::uuid from generate_series(1, 10) as m`,
        [TENANT_A, randomUUID(), projectId, amount, revision, memberId(BUILDER), memberId(FREEZER)],
      ],
    ]);

  beforeAll(async () => {
    process.env.DEMO_FORMS = 'true';
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
    ]);
    for (const n of [BUILDER, FREEZER, PREPARER, CHECKER, APPROVER, MAKER, DECIDER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'ENT_BUILDER', ['funding.snapshot.build', 'funding.snapshot.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'ENT_FREEZER', ['funding.snapshot.freeze', 'funding.snapshot.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'RPT_PREPARER', ['rpt.read', 'rpt.generate'], 30);
    await harness.seedRole(TENANT_A, 4, 'RPT_CHECKER', ['rpt.read', 'rpt.check'], 30);
    await harness.seedRole(TENANT_A, 5, 'RPT_APPROVER', ['rpt.read', 'rpt.approve', 'rpt.issue'], 30);
    await harness.seedRole(TENANT_A, 6, 'REOPEN_MAKER', ['period.reopen.request'], 30);
    await harness.seedRole(TENANT_A, 7, 'REOPEN_DECIDER', ['period.reopen.approve'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: BUILDER, role: 1, kind: 'TENANT' },
      { n: 2, member: FREEZER, role: 2, kind: 'TENANT' },
      { n: 3, member: PREPARER, role: 3, kind: 'TENANT' },
      { n: 4, member: CHECKER, role: 4, kind: 'TENANT' },
      { n: 5, member: APPROVER, role: 5, kind: 'TENANT' },
      { n: 6, member: MAKER, role: 6, kind: 'TENANT' },
      { n: 7, member: DECIDER, role: 7, kind: 'TENANT' },
    ]);
    projectId = randomUUID();
    periodId = randomUUID();
    const versionId = randomUUID();
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PUB-PRJ-1', 'Publication project', $3, $4, $5, 'INTERNAL', 9000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      ],
      [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', '2026-01-10T03:00:00Z'::timestamptz)`, [TENANT_A, versionId, projectId, randomUUID()]],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, budget_level, taxonomy_pack) values ($1, $2, $3, $4, 'EQUITY', 2026, 1000, 0, 'ALL', 'ENTERPRISE')`,
        [TENANT_A, randomUUID(), versionId, randomUUID()],
      ],
      [
        `insert into machvon.reporting_period
           (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
         values ($1, $2, 'ENT-PUB-2026-10', 1, '2026-10-01', '2026-10-31', '2026-11-03T00:00:00Z', 'ENTERPRISE', 'MONTH', 2026, 'LOCKED', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z', $3, $4, $5, $5)`,
        [TENANT_A, periodId, memberId(FREEZER), randomUUID(), memberId(BUILDER)],
      ],
    ]);
    await actual('100', 1);
    registerEnterpriseReportRules();
    registerPublicReportForms();
    REPORT_FORMS.registerProvider(new EnterpriseSnapshotProvider());
    for (const bundle of enterpriseReportBundles()) REPORT_FORMS.register(bundle);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [EnterpriseSnapshotController, PeriodReopenController, ReportController, ReportReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FUNDING_PACK_CODE, useValue: 'ENTERPRISE' },
        { provide: FND_CLOCK, useValue: () => clock },
        { provide: DIS_CLOCK, useValue: () => clock },
        { provide: REPORT_CLOCK, useValue: () => clock },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.DEMO_FORMS;
    else process.env.DEMO_FORMS = saved;
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('builds and freezes revision 1 with two people, and the stored rows reproduce the hash', async () => {
    const built = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId } });
    expect(built.status).toBe(200);
    firstSnapshot = built.json.resource_id as string;
    clock = hours(1);
    const frozen = await call('POST', `/enterprise-snapshots/${firstSnapshot}/freeze`, { member: FREEZER, ifMatch: 1 });
    expect(frozen.json).toMatchObject({ status: 'FROZEN' });
    const detail = await call('GET', `/enterprise-snapshots/${firstSnapshot}?measure=DISBURSED`, { member: FREEZER });
    expect(detail.json).toMatchObject({ hash_verified: true, snapshot: { status: 'FROZEN', revision: 1 } });
    const totals = detail.json.totals as { money: Array<{ code: string; value_vnd: string | null }> };
    expect(totals.money.find((one) => one.code === 'CUMULATIVE_YTD')?.value_vnd).toBe('100');
  });

  it('generates the form from the frozen snapshot, keeps the demo stamp, and publishes it through check, approval and issue', async () => {
    clock = hours(2);
    const made = await generate();
    expect(made.status).toBe(200);
    const draftId = made.json.draft_id as string;
    const draft = (await call('GET', `/report-engine/drafts/${draftId}`, { member: PREPARER })).json;
    expect(draft).toMatchObject({ form_status: 'DEMO', demo_mark: DEMO_MARK, data_source: 'LIVE', snapshot: { snapshot_id: firstSnapshot, revision: 1 } });
    expect((draft.preview as { stamp: string }).stamp).toBe(DEMO_MARK);
    expect(JSON.stringify((draft.preview as { rows: unknown }).rows)).toContain('PUB-PRJ-1');
    expect((await step(CHECKER, draftId, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, draftId, 2, 'approve')).status).toBe(200);
    const issued = await step(APPROVER, draftId, 3, 'issue');
    expect(issued.json.status).toBe('ISSUED');
    firstIssue = issued.json.resource_id as string;
    const copy = (await call('GET', `/report-engine/issues/${firstIssue}`, { member: APPROVER })).json;
    expect(copy).toMatchObject({ revision: 1, form_status: 'DEMO', demo_mark: DEMO_MARK, data_source: 'LIVE', counts_as_accepted: false, is_current: true, snapshot: { snapshot_id: firstSnapshot, revision: 1 } });
    firstIssueSha = copy.sha256 as string;
    // The same figures are the same copy: a second generation changes nothing.
    const again = await generate();
    expect(again.json).toMatchObject({ outcome: 'DUPLICATE', issue_id: firstIssue, revision: 1 });
  });

  it('refuses a second snapshot of the published period until the reopening is approved by somebody other than the requester', async () => {
    clock = hours(3);
    await actual('250', 2);
    const refused = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId } });
    expect([refused.status, refused.json.code]).toEqual([409, 'SNAPSHOT_FROZEN']);
    const asked = await call('POST', `/reporting-periods/${periodId}/reopen-requests`, { member: MAKER, body: { scope_kind: 'PERIOD', reason: 'The figure of October was corrected by the accounts', window_hours: 72 } });
    expect(asked.status).toBe(200);
    const reopenId = asked.json.resource_id as string;
    const own = await call('POST', `/period-reopens/${reopenId}/decision`, { member: MAKER, ifMatch: 1, body: { decision: 'approve', reason: 'I approve my own request' } });
    expect(own.status).toBe(403);
    // A request that is only asked for does not open the period for a new snapshot.
    expect((await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId } })).json.code).toBe('SNAPSHOT_FROZEN');
    clock = hours(4);
    const decided = await call('POST', `/period-reopens/${reopenId}/decision`, { member: DECIDER, ifMatch: 1, body: { decision: 'approve', reason: 'The vouchers are documented' } });
    expect(decided.status).toBe(200);
  });

  it('builds and freezes revision 2 with the lineage, and revision 1 keeps its hash', async () => {
    clock = hours(5);
    const built = await call('POST', '/enterprise-snapshots', { member: BUILDER, body: { period_id: periodId } });
    expect(built.status).toBe(200);
    secondSnapshot = built.json.resource_id as string;
    clock = hours(6);
    const frozen = await call('POST', `/enterprise-snapshots/${secondSnapshot}/freeze`, { member: FREEZER, ifMatch: 1 });
    expect(frozen.json).toMatchObject({ status: 'FROZEN' });
    const second = await call('GET', `/enterprise-snapshots/${secondSnapshot}?measure=DISBURSED`, { member: FREEZER });
    expect(second.json).toMatchObject({ hash_verified: true, snapshot: { status: 'FROZEN', revision: 2 } });
    expect(((second.json.totals as { money: Array<{ code: string; value_vnd: string | null }> }).money.find((one) => one.code === 'CUMULATIVE_YTD') as { value_vnd: string | null }).value_vnd).toBe('250');
    const first = await call('GET', `/enterprise-snapshots/${firstSnapshot}?measure=DISBURSED`, { member: FREEZER });
    expect(first.json).toMatchObject({ hash_verified: true, snapshot: { status: 'SUPERSEDED', revision: 1 } });
  });

  it('publishes the form of revision 2 as the next issued revision, and the first copy stays as it was', async () => {
    clock = hours(7);
    // The figures changed, so the new copy needs a reason (R17); without it nothing is made.
    expect((await generate()).status).toBeGreaterThanOrEqual(400);
    const made = await generate('The snapshot of October was reopened and frozen again');
    expect(made.status).toBe(200);
    const draftId = made.json.draft_id as string;
    const draft = (await call('GET', `/report-engine/drafts/${draftId}`, { member: PREPARER })).json;
    expect(draft).toMatchObject({ data_source: 'LIVE', base_revision: 1, snapshot: { snapshot_id: secondSnapshot, revision: 2 } });
    expect((await step(CHECKER, draftId, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, draftId, 2, 'approve')).status).toBe(200);
    const issued = await step(APPROVER, draftId, 3, 'issue');
    expect(issued.json.status).toBe('ISSUED');
    const second = (await call('GET', `/report-engine/issues/${issued.json.resource_id as string}`, { member: APPROVER })).json;
    expect(second).toMatchObject({ revision: 2, is_current: true, current_revision: 2, snapshot: { snapshot_id: secondSnapshot, revision: 2 } });
    const first = (await call('GET', `/report-engine/issues/${firstIssue}`, { member: APPROVER })).json;
    expect(first).toMatchObject({ revision: 1, is_current: false, current_revision: 2, sha256: firstIssueSha, snapshot: { snapshot_id: firstSnapshot, revision: 1 } });
    expect(await rows('select 1 from machvon.report_issue where layout_code = $1', ['PVN-MONTHLY'])).toHaveLength(2);
  });
});
