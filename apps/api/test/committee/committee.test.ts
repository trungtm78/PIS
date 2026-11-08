import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, SYSTEM_ROLES, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { COMMITTEE_PACK_CODE, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { banModule } from '../../src/modules/committee';
import { COMMITTEE_CLOCK } from '../../src/modules/committee/tokens';
import { CommitteeController } from '../../src/modules/committee/committee.controller';
import { CommitteeReadsController } from '../../src/modules/committee/committee-reads.controller';
import { REPORT_FORMS, registerPublicReportForms } from '../../src/modules/reports';
import { ReportController } from '../../src/modules/reports/report.controller';
import { ReportReadsController } from '../../src/modules/reports/report-reads.controller';
import { REPORT_CLOCK } from '../../src/modules/reports/tokens';
import { readXlsxMap } from '../../src/modules/reports/xlsx-template';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const HEAD = 1;
const MEMBER = 2;
const SECRETARIAT = 3;
const AUDITOR = 4;
const NOBODY = 5;
const UNIT_SCOPED = 6; // every committee right, over one unit tree only
const CANDIDATE = 7; // a person who may be appointed
const SECURITY = 8;
const RPT_ONLY = 9; // every right of the report engine, none of the committee
const B_HEAD = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0xba;
const NOW = new Date('2027-10-15T03:00:00Z');
const TODAY = '2027-10-15';
const SNAPSHOT_DAY = '2027-10-12';
const BILLION = 1_000_000_000n;

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

const roleOf = (code: string): { permissions: string[]; rank: number } => {
  const role = SYSTEM_ROLES.find((one) => one.code === code);
  if (role === undefined) throw new Error(`no system role ${code}`);
  return { permissions: [...role.permissions], rank: role.rank };
};

describe('the committee workspace over HTTP (BAN-1): province-wide read, audited views, attention list, alerts, roster, meeting pack', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; classification: string }>('select safe_diff, classification from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);
  const views = (screen: string, member: number, tenant = TENANT_A) => rows<{ screen: string; classification: string; assurance_level: string; committee_role: string | null; record_count: number | null; filters: Record<string, unknown>; feed_basis: string | null }>('select screen, classification, assurance_level, committee_role, record_count, filters, feed_basis from machvon.committee_view_audit where screen = $1 and membership_id = $2 order by viewed_at, id', [screen, memberId(member)], tenant);

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

  const master = (n: number, type: string, code: string, label: string): [string, unknown[]] => [
    `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
     values ($1, $2, $2, $3, $4, 1, $5, '{}', '2020-01-01', 'EFFECTIVE', 'TENANT', now(), $6, $6)`,
    [TENANT_A, id(FAMILY, 100 + n), type, code, label, WORKER_MEMBERSHIP_ID],
  ];
  const sector = (n: number): string => id(FAMILY, 100 + n);

  const ids = { p1: id(FAMILY, 201), p2: id(FAMILY, 202), p3: id(FAMILY, 203) };
  let snapshotId = '';

  /** A frozen snapshot of the day with the three projects; and one of the year before with the line of the first. */
  async function seedProvince(): Promise<void> {
    const periodOpen = id(FAMILY, 300);
    const periodPrior = id(FAMILY, 301);
    const sCurrent = id(FAMILY, 310);
    const sPrior = id(FAMILY, 311);
    const sPriorEnd = id(FAMILY, 312);
    snapshotId = sCurrent;
    const project = (projectId: string, code: string, sectorN: number, status: string): [string, unknown[]] => [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, sector_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $3, $4, $5, $6, 'INTERNAL', 1000000000000, $7, 1, 'B')`,
      [TENANT_A, projectId, code, unitId(DEPARTMENT), id(FAMILY, 104), sector(sectorN), status],
    ];
    const snapshot = (snapshotRow: string, periodId: string, day: string, frozen: string): [string, unknown[]] => [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, $5::date, $5::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $6, $7::timestamptz, $6, $6)`,
      [TENANT_A, snapshotRow, periodId, `${day}T03:00:00Z`, day, WORKER_MEMBERSHIP_ID, frozen],
    ];
    const line = (snapshotRow: string, projectId: string, plan: bigint, paid: bigint, eac: bigint | null): [string, unknown[]] => [
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, forecast_eac_vnd, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, 'CURRENT_YEAR', 'CENTRAL', $6::numeric, 0, $6::numeric, $7::numeric, $8::numeric, 'COMPLETE')`,
      [TENANT_A, snapshotRow, projectId, unitId(DEPARTMENT), id(FAMILY, 105), (plan * BILLION).toString(), (paid * BILLION).toString(), eac === null ? null : (eac * BILLION).toString()],
    ];
    const period = (periodId: string, code: string, start: string, end: string, year: number): [string, unknown[]] => [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $5::date, now(), 'DEFAULT', 'WEEK', $6, 'OPEN', $7, $8, $8)`,
      [TENANT_A, periodId, code, start, end, year, id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
    ];
    await seedReplica([
      master(1, 'SECTOR', 'TRANSPORT', 'Transport'),
      master(2, 'SECTOR', 'EDUCATION', 'Education'),
      master(4, 'AREA', 'D1', 'District one'),
      master(5, 'FUND_SOURCE', 'NSTW', 'Central budget'),
      project(ids.p1, 'BAN-P1', 1, 'IMPLEMENTATION'),
      project(ids.p2, 'BAN-P2', 2, 'IMPLEMENTATION'),
      project(ids.p3, 'BAN-P3', 2, 'IMPLEMENTATION'),
      period(periodOpen, 'BAN-RP-2027', '2027-10-04', '2027-10-17', 2027),
      period(periodPrior, 'BAN-RP-2026', '2026-10-05', '2026-10-18', 2026),
      snapshot(sCurrent, periodOpen, SNAPSHOT_DAY, '2027-10-12T05:00:00Z'),
      snapshot(sPrior, periodPrior, '2026-10-12', '2026-10-12T05:00:00Z'),
      snapshot(sPriorEnd, periodPrior, '2026-12-20', '2026-12-20T05:00:00Z'),
      line(sCurrent, ids.p1, 1000n, 900n, null),
      line(sCurrent, ids.p2, 1000n, 200n, null),
      line(sCurrent, ids.p3, 500n, 450n, 600n),
      line(sPrior, ids.p1, 1000n, 800n, null),
      line(sPriorEnd, ids.p1, 1000n, 900n, null),
      // The second project is behind its baseline by 75 days; the third has a procurement workflow idle for 56 days.
      [
        `insert into machvon.project_baseline (tenant_id, id, project_id, version, kind, basis, total_investment_vnd, bac_vnd, planned_start, planned_finish, taken_by)
         values ($1, $2, $3, 0, 'V0', 'BASELINE', 1000000000000, 1000000000000, '2026-01-01', '2027-08-01', $4)`,
        [TENANT_A, id(FAMILY, 320), ids.p2, WORKER_MEMBERSHIP_ID],
      ],
      [`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status) values ($1, $2, $3, 'BAN-PKG', 1000, 'OPEN_BIDDING', 1, 'PLANNED')`, [TENANT_A, id(FAMILY, 330), ids.p3]],
      [
        `insert into machvon.package_workflow (tenant_id, id, package_id, method, definition_code, definition_rule_version, definition_hash, definition, status, current_step_code, current_visit, started_by, last_activity_on)
         values ($1, $2, $3, 'OPEN_BIDDING', 'OPEN_BIDDING', 0, repeat('b', 64), '{}'::jsonb, 'IN_PROGRESS', 'TENDER', 1, $4, '2027-08-20')`,
        [TENANT_A, id(FAMILY, 331), id(FAMILY, 330), WORKER_MEMBERSHIP_ID],
      ],
      // An overdue directive of the department: 14 days past its day, so escalated by the default policy (7 days).
      [
        `insert into machvon.steering_meeting (tenant_id, id, code, meeting_year, seq, meeting_date, meeting_type, title, unit_id, created_by)
         values ($1, $2, 'BAN-GB-2027-1', 2027, 1, '2027-09-20', 'WEEKLY', 'Weekly steering meeting', $3, $4)`,
        [TENANT_A, id(FAMILY, 340), unitId(DEPARTMENT), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.directive (tenant_id, id, meeting_id, seq, code, scope_kind, project_id, scope_unit_id, directive_text, assignee_unit_id, original_due_on, due_on, status, created_by)
         values ($1, $2, $3, 1, 'BAN-CD-1', 'PROJECT', $4, $5, 'Finish the site clearance', $5, '2027-10-01', '2027-10-01', 'OPEN', $6)`,
        [TENANT_A, id(FAMILY, 341), id(FAMILY, 340), ids.p2, unitId(DEPARTMENT), WORKER_MEMBERSHIP_ID],
      ],
    ]);
    counter += 1;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [HEAD, MEMBER, SECRETARIAT, AUDITOR, NOBODY, UNIT_SCOPED, CANDIDATE, SECURITY, RPT_ONLY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_HEAD, ROOT);
    // The roles are the real system roles of the platform, so the test proves what they are worth.
    const head = roleOf('COMMITTEE_HEAD');
    const member = roleOf('COMMITTEE_MEMBER');
    const secretariat = roleOf('COMMITTEE_SECRETARIAT');
    const auditor = roleOf('AUDITOR');
    const security = roleOf('SECURITY_ADMIN');
    await harness.seedRole(TENANT_A, 1, 'COMMITTEE_HEAD', head.permissions, head.rank);
    await harness.seedRole(TENANT_A, 2, 'COMMITTEE_MEMBER', member.permissions, member.rank);
    await harness.seedRole(TENANT_A, 3, 'COMMITTEE_SECRETARIAT', secretariat.permissions, secretariat.rank);
    await harness.seedRole(TENANT_A, 4, 'AUDITOR', auditor.permissions, auditor.rank);
    await harness.seedRole(TENANT_A, 5, 'SECURITY_ADMIN', security.permissions.filter((permission) => permission.startsWith('committee.')), security.rank);
    await harness.seedRole(TENANT_A, 6, 'COMMITTEE_UNIT_SCOPED', [...head.permissions, ...secretariat.permissions], 50);
    await harness.seedRole(TENANT_A, 7, 'RPT_ONLY', ['rpt.read', 'rpt.generate', 'rpt.check', 'rpt.approve', 'rpt.issue', 'rpt.deliver'], 40);
    await harness.seedRole(TENANT_B, 1, 'COMMITTEE_HEAD', head.permissions, head.rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: HEAD, role: 1, kind: 'TENANT' },
      { n: 2, member: MEMBER, role: 2, kind: 'TENANT' },
      { n: 3, member: SECRETARIAT, role: 3, kind: 'TENANT' },
      { n: 4, member: AUDITOR, role: 4, kind: 'TENANT' },
      { n: 5, member: SECURITY, role: 5, kind: 'TENANT' },
      { n: 6, member: UNIT_SCOPED, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 7, member: RPT_ONLY, role: 7, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_HEAD, role: 1, kind: 'TENANT' }]);
    await seedProvince();
    const tenants = harness.tenants as TenantDatabase;
    registerPublicReportForms();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CommitteeController, CommitteeReadsController, ReportController, ReportReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: COMMITTEE_CLOCK, useValue: () => NOW },
        { provide: REPORT_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module BAN with its two controllers', () => {
    for (const controller of [CommitteeController, CommitteeReadsController]) expect(banModule.controllers).toContain(controller);
    expect(REPORT_FORMS.get(COMMITTEE_PACK_CODE)?.layout.status).toBe('READY');
  });

  it('refuses a caller without the right and a right held over one unit only: the workspace is province-wide', async () => {
    for (const url of ['/committee/workspace', '/committee/attention', '/committee/directive-tracker', '/committee/meeting-pack', '/committee/alerts', '/committee/roster']) {
      expect((await call('GET', url, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', url, { member: UNIT_SCOPED })).status).toBe(403);
    }
    expect((await call('POST', '/committee/alerts/evaluate', { member: UNIT_SCOPED })).status).toBe(403);
    // A refused view leaves no audit row of a view and no answer.
    expect(await rows('select 1 from machvon.committee_view_audit where membership_id in ($1, $2)', [memberId(NOBODY), memberId(UNIT_SCOPED)])).toHaveLength(0);
  });

  it('gives the head the figures of the whole province by sector, with plan, disbursed, rate, last year, the curve and the year end band, each with its formula behind the i', async () => {
    const reply = await call('GET', '/committee/workspace', { member: HEAD });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const json = reply.json as Record<string, any>;
    expect(json.as_of).toBe(SNAPSHOT_DAY);
    expect(json.feed).toMatchObject({ basis: 'DIS_SNAPSHOT', reference: snapshotId, empty: false, projects: 3 });
    // 900 + 200 + 450 of 2500 billion: 62 percent; the curve says 83.87 on the 12th of October.
    expect(json.province).toMatchObject({ plan_vnd: (2500n * BILLION).toString(), disbursed_vnd: (1550n * BILLION).toString(), rate_pct: '62.00', expected_pct: '83.87', gap_points: '-21.87', rag: 'RED' });
    // Last year: the first project had 800 by the same day and every other line had none; the whole of last year was 900.
    expect(json.province.last_year_vnd).toBe((800n * BILLION).toString());
    expect(json.province.outlook.methods.map((one: { method: string }) => one.method)).toEqual(['RUN_RATE', 'CURVE', 'LAST_YEAR']);
    expect(json.province.outlook.thin).toBe(false);
    const bySector = new Map<string, Record<string, any>>((json.by_sector as Array<Record<string, any>>).map((row) => [row.key, row]));
    expect(bySector.get('EDUCATION')).toMatchObject({ label: 'Education', plan_vnd: (1500n * BILLION).toString(), disbursed_vnd: (650n * BILLION).toString(), rate_pct: '43.33', projects: 2 });
    expect(bySector.get('TRANSPORT')).toMatchObject({ rate_pct: '90.00', rag: 'GREEN' });
    expect((json.by_investor as unknown[]).length).toBe(1);
    expect((json.by_district as Array<Record<string, any>>)[0]).toMatchObject({ key: 'D1', label: 'District one' });
    expect((json.by_fund_source as Array<Record<string, any>>)[0]).toMatchObject({ key: 'NSTW' });
    // The i of every figure: formula, source, as-of and the version of the definition; nothing is a bare number.
    const figures = new Map<string, Record<string, any>>((json.figures as Array<Record<string, any>>).map((figure) => [figure.metric_code, figure]));
    expect([...figures.keys()].sort()).toEqual(['COMMITTEE_ATTENTION_PROJECTS', 'COMMITTEE_DIRECTIVES_OVERDUE', 'COMMITTEE_DISBURSED', 'COMMITTEE_DISBURSED_LAST_YEAR', 'COMMITTEE_DISBURSEMENT_RATE', 'COMMITTEE_GAP_VS_CURVE', 'COMMITTEE_OUTLOOK_HIGH', 'COMMITTEE_OUTLOOK_LOW', 'COMMITTEE_PLAN_TOTAL', 'COMMITTEE_UNITS_NOT_REPORTING'].sort());
    expect(figures.get('COMMITTEE_DISBURSEMENT_RATE')).toMatchObject({ value: '62.00', display_value: '62.00', unit: 'PERCENT' });
    expect(figures.get('COMMITTEE_DISBURSEMENT_RATE')?.kpi).toMatchObject({ asOf: SNAPSHOT_DAY, unverified: true, origin: 'DEFAULT' });
    for (const figure of figures.values()) {
      expect(figure.kpi.formula.length).toBeGreaterThan(10);
      expect(figure.kpi.source.length).toBeGreaterThan(10);
      expect(figure.flags).toContain('UNVERIFIED_DEFINITION');
    }
    expect(json.policy).toMatchObject({ code: 'DEFAULT', source: 'DEFAULT', unverified: true, expected_pct: '83.87' });
    // No label of simulation anywhere: the answer carries none.
    expect(JSON.stringify(json).toLowerCase()).not.toMatch(/simulat|mo phong|mô phỏng/);
  });

  it('writes the audit row of every view in the same transaction: who, which screen, which filters and which feed, and no figure', async () => {
    const before = (await views('WORKSPACE', HEAD)).length;
    await call('GET', '/committee/workspace', { member: HEAD });
    await call('GET', '/committee/workspace?sector_code=EDUCATION', { member: HEAD });
    const written = await views('WORKSPACE', HEAD);
    expect(written.length).toBe(before + 2);
    const last = written[written.length - 1];
    expect(last).toMatchObject({ screen: 'WORKSPACE', classification: 'CONFIDENTIAL', assurance_level: 'UNKNOWN', feed_basis: 'DIS_SNAPSHOT' });
    expect(last?.filters).toMatchObject({ sector_code: 'EDUCATION' });
    expect(JSON.stringify(last)).not.toMatch(/billion|000000000/);
    // A filter narrows the figures and the audit says which filter was used.
    const filtered = await call('GET', '/committee/workspace?sector_code=EDUCATION', { member: MEMBER });
    expect((filtered.json.province as Record<string, unknown>).plan_vnd).toBe((1500n * BILLION).toString());
    expect((await views('WORKSPACE', MEMBER))[0]).toMatchObject({ screen: 'WORKSPACE' });
    expect((await call('GET', '/committee/workspace?investor_unit_id=not-a-uuid', { member: HEAD })).status).toBe(422);
    expect((await call('GET', '/committee/workspace?as_of=2999-01-01', { member: HEAD })).status).toBe(422);
  });

  it('ranks the projects that need the head by impact with the reasons and the money at stake, from the real tables', async () => {
    const reply = await call('GET', '/committee/attention', { member: HEAD });
    expect(reply.status).toBe(200);
    const items = reply.json.items as Array<Record<string, any>>;
    const byCode = new Map<string, Record<string, any>>(items.map((item) => [item.code, item]));
    expect([...byCode.keys()].sort()).toEqual(['BAN-P2', 'BAN-P3']);
    expect(byCode.get('BAN-P2')?.signals.map((signal: { reason: string }) => signal.reason).sort()).toEqual(['DELAYED', 'DISBURSEMENT_FAR_BELOW_PLAN']);
    expect(byCode.get('BAN-P2')?.signals.find((signal: { reason: string }) => signal.reason === 'DELAYED')).toMatchObject({ value: '75', threshold: 30, unit: 'DAYS' });
    expect(byCode.get('BAN-P3')?.signals.map((signal: { reason: string }) => signal.reason).sort()).toEqual(['OVER_BUDGET_RISK', 'STALLED_PROCEDURE']);
    expect(byCode.get('BAN-P3')?.signals.find((signal: { reason: string }) => signal.reason === 'STALLED_PROCEDURE')).toMatchObject({ value: '56' });
    expect(byCode.get('BAN-P2')?.exposure_vnd).toBe((800n * BILLION).toString());
    expect(items[0]?.code).toBe('BAN-P2');
    expect(items.map((item) => item.rank)).toEqual([1, 2]);
    expect(reply.json.total).toBe(2);
    const reasonOnly = await call('GET', '/committee/attention?reason=STALLED_PROCEDURE', { member: HEAD });
    expect((reasonOnly.json.items as Array<Record<string, any>>).map((item) => item.code)).toEqual(['BAN-P3']);
    expect((await call('GET', '/committee/attention?reason=NOPE', { member: HEAD })).status).toBe(422);
    expect((await views('ATTENTION', HEAD)).length).toBeGreaterThanOrEqual(2);
  });

  it('records what the head decided about a project: deferred projects leave the list until their day, a directive is linked, and every decision is audited with an event', async () => {
    // Without a right to decide, no decision.
    expect((await call('POST', '/committee/attention/decisions', { member: MEMBER, body: { project_id: ids.p3, decision: 'ACKNOWLEDGED', note: 'Seen by a member' } })).status).toBe(403);
    expect((await call('POST', '/committee/attention/decisions', { member: HEAD, body: { project_id: ids.p3, decision: 'DEFERRED', note: 'Waiting for the tender result' } })).status).toBe(422);
    const deferred = await call('POST', '/committee/attention/decisions', { member: HEAD, body: { project_id: ids.p3, decision: 'DEFERRED', note: 'Waiting for the tender result', defer_until: '2027-11-15' } });
    expect(deferred.status).toBe(200);
    expect((await call('GET', '/committee/attention', { member: HEAD })).json.items).toHaveLength(1);
    const withDeferred = await call('GET', '/committee/attention?include_deferred=true', { member: HEAD });
    const p3 = (withDeferred.json.items as Array<Record<string, any>>).find((item) => item.code === 'BAN-P3');
    expect(p3?.decision).toMatchObject({ decision: 'DEFERRED', defer_until: '2027-11-15', note: 'Waiting for the tender result' });
    expect(p3?.decision.reasons.sort()).toEqual(['OVER_BUDGET_RISK', 'STALLED_PROCEDURE']);
    const resource = deferred.json.resource_id as string;
    expect((await audits(resource, 'committee.attention_decided'))[0]?.safe_diff).toMatchObject({ project_id: ids.p3, decision: 'DEFERRED' });
    expect((await events(resource, 'committee.attention_decided.v1'))[0]?.payload).toMatchObject({ project_id: ids.p3, decision: 'DEFERRED' });
    // A directive that is about another project cannot be linked; the right one can.
    expect((await call('POST', '/committee/attention/decisions', { member: HEAD, body: { project_id: ids.p3, decision: 'DIRECTED', directive_id: id(FAMILY, 341) } })).status).toBe(422);
    const directed = await call('POST', '/committee/attention/decisions', { member: HEAD, body: { project_id: ids.p2, decision: 'DIRECTED', directive_id: id(FAMILY, 341) } });
    expect(directed.status).toBe(200);
    const p2 = ((await call('GET', '/committee/attention', { member: HEAD })).json.items as Array<Record<string, any>>).find((item) => item.code === 'BAN-P2');
    expect(p2?.decision).toMatchObject({ decision: 'DIRECTED', directive_id: id(FAMILY, 341) });
    // The log is append-only at the database.
    await expect(rows('update machvon.committee_attention_decision set note = $1', ['x'])).rejects.toThrow(/append-only/);
    await expect(rows('delete from machvon.committee_attention_decision')).rejects.toThrow(/append-only/);
    // The same key gives the same answer and does not write a second row.
    const key = `decision-${randomUUID()}`;
    const first = await call('POST', '/committee/attention/decisions', { member: HEAD, key, body: { project_id: ids.p1, decision: 'ACKNOWLEDGED', note: 'Looks fine, seen' } });
    const second = await call('POST', '/committee/attention/decisions', { member: HEAD, key, body: { project_id: ids.p1, decision: 'ACKNOWLEDGED', note: 'Looks fine, seen' } });
    expect(second.json.resource_id).toBe(first.json.resource_id);
    expect(await rows('select 1 from machvon.committee_attention_decision where project_id = $1', [ids.p1])).toHaveLength(1);
  });

  it('tracks the overdue and escalated directives per unit with the clock of the directive policy', async () => {
    const reply = await call('GET', '/committee/directive-tracker', { member: MEMBER });
    expect(reply.status).toBe(200);
    expect(reply.json.units).toEqual([{ unit_id: unitId(DEPARTMENT), unit_name: expect.any(String), open: 1, overdue: 1, escalated: 1, oldest_overdue_days: 14 }]);
    expect(reply.json.totals).toEqual({ open: 1, overdue: 1, escalated: 1 });
    expect((reply.json.directives as Array<Record<string, unknown>>)[0]).toMatchObject({ code: 'BAN-CD-1', phase: 'ESCALATED', overdue_days: 14, project_code: 'BAN-P2' });
    expect(reply.json.escalate_after_days).toBe(7);
  });

  it('raises the four alerts of the committee with owner, expected action and consequence, keeps them while the condition holds, resolves them when it stops, and the head acknowledges with a note', async () => {
    expect((await call('POST', '/committee/alerts/evaluate', { member: HEAD })).status).toBe(403);
    const first = await call('POST', '/committee/alerts/evaluate', { member: SECRETARIAT });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'EVALUATED', opened: 4, kept: 0, resolved: 0, as_of: SNAPSHOT_DAY });
    const alerts = first.json.alerts as Array<Record<string, any>>;
    const byType = new Map(alerts.map((alert) => [alert.alert_type, alert]));
    expect([...byType.keys()].sort()).toEqual(['COMMITTEE_DIRECTIVE_OVERDUE', 'COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE_SECTOR_BEHIND', 'COMMITTEE_UNIT_NOT_REPORTING']);
    expect(byType.get('COMMITTEE_PROVINCE_BEHIND')).toMatchObject({ severity: 'URGENT', value: '62.00', threshold: '83.87', owner: 'COMMITTEE_HEAD' });
    expect(byType.get('COMMITTEE_SECTOR_BEHIND')).toMatchObject({ subject_key: 'EDUCATION', severity: 'ACTION', value: '43.33' });
    expect(byType.get('COMMITTEE_UNIT_NOT_REPORTING')).toMatchObject({ severity: 'URGENT', detail: { reason: 'NEVER_REPORTED', expected: 3, received: 0 } });
    expect(byType.get('COMMITTEE_DIRECTIVE_OVERDUE')).toMatchObject({ severity: 'URGENT', value: '1' });
    for (const alert of alerts) {
      expect(String(alert.expected_action).length).toBeGreaterThan(10);
      expect(String(alert.consequence).length).toBeGreaterThan(10);
      expect(alert.response_hours).toBeGreaterThan(0);
    }
    const province = byType.get('COMMITTEE_PROVINCE_BEHIND') as Record<string, any>;
    expect((await events(province.id, 'committee.alert_raised.v1'))[0]?.payload).toMatchObject({ alert_type: 'COMMITTEE_PROVINCE_BEHIND', severity: 'URGENT' });
    // Evaluating again keeps the rows open and opens nothing.
    const again = await call('POST', '/committee/alerts/evaluate', { member: SECRETARIAT });
    expect(again.json).toMatchObject({ opened: 0, kept: 4, resolved: 0 });
    expect(await rows(`select 1 from machvon.committee_alert where status <> 'RESOLVED'`)).toHaveLength(4);
    // The head acknowledges with a note (If-Match), once.
    expect((await call('POST', `/committee/alerts/${province.id}/acknowledgement`, { member: MEMBER, ifMatch: 1, body: { note: 'Read by a member' } })).status).toBe(403);
    const current = (await call('GET', '/committee/alerts', { member: HEAD })).json.alerts as Array<Record<string, any>>;
    const version = current.find((alert) => alert.id === province.id)?.version as number;
    const acknowledged = await call('POST', `/committee/alerts/${province.id}/acknowledgement`, { member: HEAD, ifMatch: version, body: { note: 'Called the Finance Department for a recovery plan' } });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.json.status).toBe('ACKNOWLEDGED');
    expect((await call('POST', `/committee/alerts/${province.id}/acknowledgement`, { member: HEAD, ifMatch: version, body: { note: 'Again' } })).status).toBe(409);
    expect((await audits(province.id as string, 'committee.alert_acknowledged'))[0]?.safe_diff).toMatchObject({ alert_type: 'COMMITTEE_PROVINCE_BEHIND' });
    // The province catches up: the condition stops and the evaluation closes the alerts that no longer hold.
    await seedReplica([[`update machvon.period_snapshot_line set disbursed_treasury_vnd = plan_total_vnd where snapshot_id = $1`, [snapshotId]]]);
    const healed = await call('POST', '/committee/alerts/evaluate', { member: SECRETARIAT });
    expect(healed.json).toMatchObject({ opened: 0, resolved: 3 });
    expect((healed.json.alerts as Array<Record<string, any>>).map((alert) => alert.alert_type).sort()).toEqual(['COMMITTEE_DIRECTIVE_OVERDUE', 'COMMITTEE_UNIT_NOT_REPORTING'].sort());
    expect((await events(province.id as string, 'committee.alert_resolved.v1'))).toHaveLength(1);
    await expect(rows(`update machvon.committee_alert set severity = 'WATCH' where id = $1`, [province.id])).rejects.toThrow(/final/);
    await seedReplica([[`update machvon.period_snapshot_line set disbursed_treasury_vnd = case project_id when $2 then 900000000000 when $3 then 200000000000 else 450000000000 end where snapshot_id = $1`, [snapshotId, ids.p1, ids.p2]]]);
  });

  it('keeps the roster: one head, nobody appoints themselves, an ended place is final, and the audit holds who did what', async () => {
    expect((await call('POST', '/committee/roster', { member: HEAD, body: { code: 'BAN57', name: 'Provincial steering committee' } })).status).toBe(403);
    const made = await call('POST', '/committee/roster', { member: SECRETARIAT, body: { code: 'BAN57', name: 'Provincial steering committee', legal_basis: 'Decision of the provincial people committee' } });
    expect(made.status).toBe(200);
    const committeeId = made.json.resource_id as string;
    expect((await call('POST', '/committee/roster', { member: SECRETARIAT, body: { code: 'BAN57', name: 'Again' } })).status).toBe(409);
    const place = { committee_id: committeeId, membership_id: memberId(HEAD), committee_role: 'HEAD', agency_code: 'PA05', agency_name: 'Provincial police', decision_ref: 'Decision 01', valid_from: '2027-01-01', mfa_required: true };
    expect((await call('POST', '/committee/roster/members', { member: HEAD, body: place })).status).toBe(403);
    expect((await call('POST', '/committee/roster/members', { member: SECRETARIAT, body: { ...place, membership_id: memberId(SECRETARIAT) } })).status).toBe(422);
    const appointed = await call('POST', '/committee/roster/members', { member: SECRETARIAT, body: place });
    expect(appointed.status).toBe(200);
    expect((await audits(appointed.json.resource_id as string, 'committee.member_appointed'))[0]).toMatchObject({ classification: 'PERSONAL' });
    expect((await call('POST', '/committee/roster/members', { member: SECRETARIAT, body: { ...place, membership_id: memberId(CANDIDATE) } })).status).toBe(409);
    expect((await call('POST', '/committee/roster/members', { member: SECRETARIAT, body: { ...place, committee_role: 'MEMBER', membership_id: memberId(HEAD) } })).status).toBe(409);
    const deputy = await call('POST', '/committee/roster/members', { member: SECRETARIAT, body: { ...place, committee_role: 'DEPUTY', membership_id: memberId(CANDIDATE), agency_code: 'FIN' } });
    expect(deputy.status).toBe(200);
    const roster = (await call('GET', '/committee/roster', { member: MEMBER })).json as Record<string, any>;
    expect(roster.classification).toBe('PERSONAL');
    const members = roster.committees[0].members as Array<Record<string, any>>;
    expect(members.map((one) => one.committee_role)).toEqual(['HEAD', 'DEPUTY']);
    expect(members[0]).toMatchObject({ agency_code: 'PA05', mfa_required: true, status: 'ACTIVE', role_granted: true });
    // The deputy holds no grant of the member role in this tenant, and the roster says so.
    expect(members[1]).toMatchObject({ role_granted: false });
    const endId = deputy.json.resource_id as string;
    expect((await call('POST', `/committee/roster/members/${endId}/ending`, { member: SECRETARIAT, ifMatch: 1, body: { reason: 'no' } })).status).toBe(422);
    const ended = await call('POST', `/committee/roster/members/${endId}/ending`, { member: SECRETARIAT, ifMatch: 1, body: { reason: 'Moved to another assignment' } });
    expect(ended.status).toBe(200);
    expect((await call('POST', `/committee/roster/members/${endId}/ending`, { member: SECRETARIAT, ifMatch: 2, body: { reason: 'Ended twice' } })).status).toBe(409);
    expect((await call('POST', `/committee/roster/members/${endId}/ending`, { member: SECRETARIAT, ifMatch: 1, body: { reason: 'Stale version' } })).status).toBe(409);
    await expect(rows(`update machvon.committee_member set committee_role = 'MEMBER' where id = $1`, [endId])).rejects.toThrow(/final/);
    await expect(rows('delete from machvon.committee_member where id = $1', [endId])).rejects.toThrow(/never removed/);
    // The head of the committee is now seen in the audit of views with the committee role.
    await call('GET', '/committee/alerts', { member: HEAD });
    expect((await views('ALERTS', HEAD)).pop()).toMatchObject({ committee_role: 'HEAD' });
  });

  it('shows the audit of views only to the security administrator and the auditor, and audits that read too', async () => {
    expect((await call('GET', '/committee/view-audit', { member: HEAD })).status).toBe(403);
    expect((await call('GET', '/committee/view-audit', { member: SECRETARIAT })).status).toBe(403);
    const reply = await call('GET', '/committee/view-audit?screen=WORKSPACE&limit=2', { member: AUDITOR });
    expect(reply.status).toBe(200);
    const page = reply.json.rows as Array<Record<string, any>>;
    expect(page).toHaveLength(2);
    expect(page.every((row) => row.screen === 'WORKSPACE' && typeof row.membership_id === 'string' && row.membership_id !== '')).toBe(true);
    expect(reply.json.next).toEqual(expect.any(String));
    const next = await call('GET', `/committee/view-audit?screen=WORKSPACE&limit=2&before=${encodeURIComponent(reply.json.next as string)}`, { member: SECURITY });
    expect(next.status).toBe(200);
    expect((next.json.rows as Array<Record<string, any>>).every((row) => !page.some((one) => one.id === row.id))).toBe(true);
    expect((await views('VIEW_AUDIT', AUDITOR)).length).toBe(1);
    await expect(rows('update machvon.committee_view_audit set screen = $1', ['ALERTS'])).rejects.toThrow(/append-only/);
    await expect(rows('delete from machvon.committee_view_audit')).rejects.toThrow(/append-only/);
    expect((await call('GET', '/committee/view-audit?screen=NOPE', { member: AUDITOR })).status).toBe(422);
  });

  it('makes the meeting pack through the report engine: the figures of the file are the figures of the screen, three people issue it, and no mark of simulation is printed', async () => {
    const generated = await call('POST', '/report-engine/drafts', { member: SECRETARIAT, body: { layout_code: COMMITTEE_PACK_CODE, period: { kind: 'AS_OF', year: 2027, day: TODAY } } });
    expect(generated.status).toBe(200);
    const draftId = generated.json.draft_id as string;
    const file = await call('GET', `/report-engine/drafts/${draftId}/files/XLSX`, { member: MEMBER });
    expect(file.status).toBe(200);
    const map = (await readXlsxMap(new Uint8Array(Buffer.from(file.json.content_base64 as string, 'base64'))))[0];
    const values = Object.values(map?.cells ?? {}).map((cell) => cell.value);
    // The plan, the disbursed amount and the rate of the screen are cells of the file.
    expect(values).toContain(2_500_000_000_000);
    expect(values).toContain(1_550_000_000_000);
    expect(values).toContain(62);
    const texts = values.filter((value): value is string => typeof value === 'string');
    expect(texts.some((text) => /education/i.test(text))).toBe(true);
    expect(texts.join(' ').toLowerCase()).not.toMatch(/simulat|mo phong/);
    const pack = await call('GET', '/committee/meeting-pack', { member: HEAD });
    expect(pack.status).toBe(200);
    expect(pack.json).toMatchObject({ layout_code: COMMITTEE_PACK_CODE, as_of: SNAPSHOT_DAY });
    expect((pack.json.generation as Record<string, any>).recent_drafts[0]).toMatchObject({ id: draftId, status: 'DRAFT' });
    expect((await views('MEETING_PACK', HEAD)).length).toBe(1);
    // A member checks, the head approves, the secretariat issues: three different people, the engine keeps the order.
    const v1 = (await call('GET', `/report-engine/drafts/${draftId}`, { member: MEMBER })).json.version as number;
    expect((await call('POST', `/report-engine/drafts/${draftId}/check`, { member: MEMBER, ifMatch: v1 })).status).toBe(200);
    expect((await call('POST', `/report-engine/drafts/${draftId}/approve`, { member: HEAD, ifMatch: v1 + 1 })).status).toBe(200);
    const issued = await call('POST', `/report-engine/drafts/${draftId}/issue`, { member: SECRETARIAT, ifMatch: v1 + 2 });
    expect(issued.status).toBe(200);
    expect(issued.json).toMatchObject({ outcome: 'NEW' });
  });

  it('does not hand the meeting pack to a holder of the report permissions alone: not to generate, not to list, not to read, not to step', async () => {
    const attempt = await call('POST', '/report-engine/drafts', { member: RPT_ONLY, body: { layout_code: COMMITTEE_PACK_CODE, period: { kind: 'AS_OF', year: 2027, day: TODAY } } });
    expect(attempt.status).toBe(403);
    const made = (await rows<{ id: string }>('select id from machvon.report_draft where layout_code = $1 order by created_at', [COMMITTEE_PACK_CODE]))[0]?.id as string;
    const issued = (await rows<{ id: string }>('select id from machvon.report_issue where layout_code = $1', [COMMITTEE_PACK_CODE]))[0]?.id as string;
    expect(made).toEqual(expect.any(String));
    expect((await call('GET', `/report-engine/drafts/${made}`, { member: RPT_ONLY })).status).toBe(403);
    expect((await call('GET', `/report-engine/drafts/${made}/files/XLSX`, { member: RPT_ONLY })).status).toBe(403);
    expect((await call('GET', `/report-engine/issues/${issued}`, { member: RPT_ONLY })).status).toBe(403);
    expect((await call('GET', `/report-engine/issues/${issued}/files/XLSX`, { member: RPT_ONLY })).status).toBe(403);
    expect((await call('POST', `/report-engine/issues/${issued}/deliveries`, { member: RPT_ONLY, body: { receiver: 'MOF', channel: 'MANUAL' } })).status).toBe(403);
    expect(((await call('GET', '/report-engine/drafts', { member: RPT_ONLY })).json.items as unknown[]).filter((item) => (item as { layout_code: string }).layout_code === COMMITTEE_PACK_CODE)).toHaveLength(0);
    expect(((await call('GET', '/report-engine/issues', { member: RPT_ONLY })).json.items as unknown[]).filter((item) => (item as { layout_code: string }).layout_code === COMMITTEE_PACK_CODE)).toHaveLength(0);
    // The committee sees its own pack through the same endpoints.
    expect(((await call('GET', '/report-engine/issues', { member: MEMBER })).json.items as unknown[]).length).toBeGreaterThan(0);
  });

  it('prepares the pack for the day that was asked for, and keeps an unknown amount of last year unknown', async () => {
    const later = await call('GET', '/committee/meeting-pack?as_of=2027-10-14', { member: HEAD });
    expect(later.status).toBe(200);
    expect(later.json.as_of).toBe(SNAPSHOT_DAY);
    expect((later.json.generation as Record<string, any>).period).toMatchObject({ kind: 'AS_OF', year: 2027, day: '2027-10-14' });
    // A line of last year that exists with no amount is unknown, not zero: the figure is withheld and the coverage is named.
    await seedReplica([
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
          values ($1, gen_random_uuid(), $2, $3, $4, $5, 'CURRENT_YEAR', 'CENTRAL', 500000000000, 0, 500000000000, null, 'NONE')`,
        [TENANT_A, id(FAMILY, 311), ids.p3, unitId(DEPARTMENT), id(FAMILY, 105)],
      ],
    ]);
    const workspace = (await call('GET', '/committee/workspace', { member: HEAD })).json as Record<string, any>;
    expect(workspace.province.last_year_vnd).toBeNull();
    expect(workspace.province.last_year_coverage).toEqual({ known: 2, total: 3 });
  });

  it('pages the audit of views without skipping rows that share a millisecond', async () => {
    await rows(
      `insert into machvon.committee_view_audit (tenant_id, membership_id, screen, classification, viewed_at)
        select nullif(current_setting('app.tenant_id', true), '')::uuid, $1, 'ALERTS', 'CONFIDENTIAL', timestamptz '2999-01-01 00:00:00.000000+00' + (n || ' microseconds')::interval from generate_series(100, 400, 100) n`,
      [memberId(HEAD)],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page += 1) {
      const reply = await call('GET', `/committee/view-audit?screen=ALERTS&limit=1${cursor === null ? '' : `&before=${encodeURIComponent(cursor)}`}`, { member: AUDITOR });
      for (const row of reply.json.rows as Array<{ id: string; viewed_at: string }>) seen.push(row.id);
      cursor = reply.json.next as string | null;
      if (cursor === null) break;
    }
    const stored = await rows<{ id: string }>(`select id from machvon.committee_view_audit where screen = 'ALERTS' order by viewed_at desc, id desc`);
    expect(seen).toEqual(stored.map((row) => row.id));
  });

  it('never lets one tenant see or change the committee of another', async () => {
    const other = await call('GET', '/committee/workspace', { member: B_HEAD, tenantId: TENANT_B });
    expect(other.status).toBe(200);
    expect(other.json.feed).toMatchObject({ empty: true, projects: 0, reference: null });
    expect((other.json.province as Record<string, unknown>).plan_vnd).toBe('0');
    expect((other.json.province as Record<string, unknown>).rate_pct).toBeNull();
    expect(other.json.attention).toEqual([]);
    expect(((other.json.figures as Array<Record<string, any>>).find((figure) => figure.metric_code === 'COMMITTEE_DISBURSEMENT_RATE') ?? {}).value).toBeNull();
    expect(await rows('select 1 from machvon.committee_view_audit', [], TENANT_B)).toHaveLength(1);
    const roster = await call('GET', '/committee/roster', { member: B_HEAD, tenantId: TENANT_B });
    expect(roster.json.committees).toEqual([]);
    const foreignAlert = (await rows<{ id: string }>('select id from machvon.committee_alert limit 1'))[0]?.id as string;
    expect((await call('POST', `/committee/alerts/${foreignAlert}/acknowledgement`, { member: B_HEAD, tenantId: TENANT_B, ifMatch: 1, body: { note: 'Foreign attempt' } })).status).toBe(404);
    expect((await call('POST', '/committee/attention/decisions', { member: B_HEAD, tenantId: TENANT_B, body: { project_id: ids.p1, decision: 'ACKNOWLEDGED', note: 'Foreign project' } })).status).toBe(404);
  });
});
