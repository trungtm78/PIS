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
import { REPORT_FORMS, registerPublicReportForms } from '../../src/modules/reports';
import { ReportController } from '../../src/modules/reports/report.controller';
import { ReportReadsController } from '../../src/modules/reports/report-reads.controller';
import { REPORT_CLOCK } from '../../src/modules/reports/tokens';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The six demo forms read the frozen enterprise period snapshot when the period has one (ENT-3a, R21), and keep their invented data and the demo stamp when it has none. The name ends in `.enterprise.test.ts`: it is one of
 * the few sources that may name the enterprise package.
 */
jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PREPARER = 1;
const READER = 2;
const ROOT = 1;
const NOW = new Date('2026-11-08T03:00:00Z');
const MONTH = { kind: 'MONTH', year: 2026, index: 10 };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the demo forms stand on the frozen enterprise snapshot of the period (ENT-3a)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let projectId = '';
  const saved = process.env.DEMO_FORMS;
  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rowsOf = <R extends object>(sql: string): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, []]]);
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

  /** A frozen enterprise snapshot of October 2026 with one project: plan in force 1,000 and 100 disbursed so far this year. */
  async function freezeSnapshot(revision: number, ytd: string): Promise<string> {
    const periodId = randomUUID();
    const snapshotId = randomUUID();
    const figure = (kind: string, grain: string, ordinal: number, amount: string | null): [string, unknown[]] => [
      `insert into machvon.period_snapshot_figure (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, null_reason, basis)
       values ($1, gen_random_uuid(), $2, $3, $4, 'EQUITY', 'ALL', 'DISBURSED', $5, $6, 2026, $7, $8::numeric, $9, 'PLAN_DECISION')`,
      [TENANT_A, snapshotId, projectId, unitId(ROOT), kind, grain, ordinal, amount, amount === null ? 'NO_DATA' : null],
    ];
    await seed([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, '2026-10-01', '2026-10-31', '2026-11-03T00:00:00Z', 'ENTERPRISE', 'MONTH', 2026, 'LOCKED', now(), now(), $4, $5, $4, $4)
         on conflict do nothing`,
        [TENANT_A, periodId, `SNAP-${revision}-${periodId.slice(0, 4)}`, memberId(PREPARER), randomUUID()],
      ],
    ]);
    const [period] = await harness.owner<{ id: string }>(TENANT_A, [[`select id from machvon.reporting_period where calendar_code = 'ENTERPRISE' and start_date = '2026-10-01' order by created_at limit 1`]]);
    await seed([[`update machvon.period_snapshot set status = 'SUPERSEDED' where snapshot_kind = 'ENTERPRISE_CLOSE' and status = 'FROZEN'`, []]]);
    await seed([
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, taxonomy_pack, taxonomy_version, hash_schema, revision, created_by, updated_by)
         values ($1, $2, $3, 'ENTERPRISE_CLOSE', '2026-11-05T03:00:00Z', '2026-10-31', '2026-10-31', 'FROZEN', 'ENT-SNAPSHOT-R1', 'PROPOSED_PENDING_SIGNOFF', 3, $4, $5, now(), 'ENTERPRISE', 1, 2, $6, $7, $7)`,
        [TENANT_A, snapshotId, (period as { id: string }).id, 'c'.repeat(64), memberId(READER), revision, memberId(PREPARER)],
      ],
      figure('PLAN_IN_FORCE', 'YEAR', 0, '1000'),
      figure('CUMULATIVE_YTD', 'MONTH', 10, ytd),
      figure('TMDT_IN_FORCE', 'YEAR', 0, '9000'),
    ]);
    return snapshotId;
  }

  beforeAll(async () => {
    process.env.DEMO_FORMS = 'true';
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [PREPARER, READER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'RPT_PREPARER', ['rpt.read', 'rpt.generate'], 30);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: PREPARER, role: 1, kind: 'TENANT' }]);
    projectId = randomUUID();
    await seed([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'SNAP-PRJ-1', 'Snapshot project', $3, $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, unitId(ROOT), id(0x50, 91)],
      ],
    ]);
    registerEnterpriseReportRules();
    registerPublicReportForms();
    REPORT_FORMS.registerProvider(new EnterpriseSnapshotProvider());
    for (const bundle of enterpriseReportBundles()) REPORT_FORMS.register(bundle);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ReportController, ReportReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: REPORT_CLOCK, useValue: () => NOW },
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

  it('keeps the illustrative data and the demo stamp when the period has no frozen snapshot', async () => {
    const made = await generate();
    expect(made.status).toBe(200);
    const draft = (await call('GET', `/report-engine/drafts/${made.json.draft_id as string}`, { member: PREPARER })).json;
    expect(draft).toMatchObject({ form_status: 'DEMO', demo_mark: DEMO_MARK, data_source: 'ILLUSTRATIVE', snapshot: null });
    expect((draft.preview as { stamp: string }).stamp).toBe(DEMO_MARK);
  });

  it('fills the form from the frozen snapshot, names its id and revision, lists its project, and still carries the demo stamp', async () => {
    const snapshotId = await freezeSnapshot(1, '100');
    const made = await generate('The first snapshot of the month was frozen');
    expect(made.status).toBe(200);
    const draft = (await call('GET', `/report-engine/drafts/${made.json.draft_id as string}`, { member: PREPARER })).json;
    expect(draft).toMatchObject({ form_status: 'DEMO', demo_mark: DEMO_MARK, data_source: 'LIVE', snapshot: { snapshot_id: snapshotId, revision: 1 } });
    const preview = draft.preview as { stamp: string; rows: Array<{ cells: Array<{ text: string }> }> };
    expect(preview.stamp).toBe(DEMO_MARK);
    const text = JSON.stringify(preview.rows);
    expect(text).toContain('SNAP-PRJ-1');
    expect(text).not.toContain('(minh họa)');
  });

  it('a newer revision of the snapshot gives another copy that names the new revision (the reopened period is a new copy, not an edit)', async () => {
    const newer = await freezeSnapshot(2, '250');
    const made = await generate('The month was reopened and frozen again');
    expect(made.status).toBe(200);
    const draft = (await call('GET', `/report-engine/drafts/${made.json.draft_id as string}`, { member: PREPARER })).json;
    expect(draft).toMatchObject({ data_source: 'LIVE', snapshot: { snapshot_id: newer, revision: 2 } });
  });
  it('lays the words of the unit, accepted for the period, out in the Word document, and a draft or a handed-in report adds nothing (CN.02, CN.03)', async () => {
    const reportId = randomUUID();
    const planId = randomUUID();
    const periodRow = (await rowsOf<{ id: string }>("select id from machvon.reporting_period where calendar_code = 'ENTERPRISE' and start_date = '2026-10-01' order by created_at limit 1"))[0] as { id: string };
    await seed([
      [
        `insert into machvon.report_revision (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, created_by, updated_by, submitted_by, submitted_at)
         values ($1, $2, $3, $4, $5, 1, 'SUBMITTED', false, 1, $6, 'MONTHLY', 'YTD', $7, $7, $7, now())`,
        [TENANT_A, reportId, projectId, periodRow.id, planId, 'd'.repeat(64), memberId(PREPARER)],
      ],
      [
        `insert into machvon.report_narrative (tenant_id, id, report_revision_id, created_by, updated_by, pack_code, pack_version, pack_fields, cause_codes, directive_refs)
         values ($1, gen_random_uuid(), $2, $3, $3, 'ENTERPRISE', 1, $4::jsonb, ARRAY[]::text[], '[]'::jsonb)`,
        [TENANT_A, reportId, memberId(PREPARER), JSON.stringify({ status: 'The works of the project follow the schedule', difficulties: 'The site is not yet handed over' })],
      ],
    ]);
    const wordsOf = async (reason: string): Promise<string> => {
      const made = await generate(reason);
      expect(made.status).toBe(200);
      const draft = (await call('GET', `/report-engine/drafts/${made.json.draft_id as string}`, { member: PREPARER })).json;
      return JSON.stringify((draft.preview as { narrative: unknown }).narrative);
    };
    // Handed in is not accepted: the form carries nothing of it.
    expect(await wordsOf('The report of the unit was handed in')).not.toContain('The works of the project follow the schedule');
    await seed([[`update machvon.report_revision set status = 'ACCEPTED', is_current = true, accepted_by = $2, accepted_at = now() where id = $1`, [reportId, memberId(READER)]]]);
    const accepted = await wordsOf('The unit approver accepted the report of the project');
    expect(accepted).toContain('The works of the project follow the schedule');
    expect(accepted).toContain('The site is not yet handed over');
    expect(accepted).toContain('SNAP-PRJ-1');
  });
});
