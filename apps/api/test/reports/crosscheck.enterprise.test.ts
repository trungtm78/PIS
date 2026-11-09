import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { crosscheckDefaults, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { enterpriseReportBundles, registerEnterpriseReportRules } from '@machvon/edition-enterprise/src/server.ts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { REPORT_FORMS, registerPublicReportForms } from '../../src/modules/reports';
import { ReportController } from '../../src/modules/reports/report.controller';
import { ReportCrosscheckController } from '../../src/modules/reports/report-crosscheck.controller';
import { ReportReadsController } from '../../src/modules/reports/report-reads.controller';
import { REPORT_CLOCK } from '../../src/modules/reports/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The comparison of the reports of one period and the gate on release (ENT-4a, CN.04) over HTTP and the database. The name of this file ends in `.enterprise.test.ts`: it names the enterprise forms. The demo forms run on
 * invented data, so the tenant approves a version of the rule that compares illustrative data too (otherwise the comparison says "skipped: illustrative" and the gate has nothing to stop). Three months of PVN against the
 * quarter of PVN must add up; the invented data is the same for every period, so the quarter does not equal three months: a real difference, with no figure touched by the test.
 */
jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PREPARER = 1;
const CHECKER = 2;
const APPROVER = 3;
const EXPLAINER = 4;
const READER = 5;
const ROOT = 1;
const NOW = new Date('2026-12-20T03:00:00Z');
const QUARTER = { kind: 'QUARTER', year: 2026, index: 4 };
const MONTHS = [10, 11, 12].map((index) => ({ kind: 'MONTH', year: 2026, index }));

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Finding {
  rule_id: string;
  severity: string;
  fingerprint: string;
  status: string;
  can_explain: boolean;
  blocks_release?: boolean;
}

describe('the comparison of the reports of one period and the gate on release (ENT-4a)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  const saved = process.env.DEMO_FORMS;

  const tokenOf = (member: number, tenant = TENANT_A): string => signTenantContext({ tenantId: tenant, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: number; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant ?? TENANT_A), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const generate = (code: string, period: Record<string, unknown>): Promise<Reply> => call('POST', '/report-engine/drafts', { member: PREPARER, body: { layout_code: code, period } });
  const step = (member: number, draftId: string, version: number, action: 'check' | 'approve' | 'issue'): Promise<Reply> => call('POST', `/report-engine/drafts/${draftId}/${action}`, { member, ifMatch: version });
  const crosscheck = (draftId?: string, member = READER): Promise<Reply> => call('GET', `/report-engine/crosscheck?kind=QUARTER&year=2026&index=4${draftId === undefined ? '' : `&draft_id=${draftId}`}`, { member });
  const explain = (fingerprint: string, member = EXPLAINER, reason = 'The Treasury corrected the three months after the quarter was filled.'): Promise<Reply> =>
    call('POST', '/report-engine/crosscheck/explanations', { member, body: { period: QUARTER, fingerprint, reason } });

  let quarterly = '';

  beforeAll(async () => {
    process.env.DEMO_FORMS = 'true';
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [PREPARER, CHECKER, APPROVER, EXPLAINER, READER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, READER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'RPT_PREPARER', ['rpt.read', 'rpt.generate', 'rpt.crosscheck.read', 'rpt.crosscheck.explain'], 30);
    await harness.seedRole(TENANT_A, 2, 'RPT_CHECKER', ['rpt.read', 'rpt.check'], 30);
    await harness.seedRole(TENANT_A, 3, 'RPT_APPROVER', ['rpt.read', 'rpt.approve', 'rpt.issue'], 30);
    await harness.seedRole(TENANT_A, 4, 'RPT_EXPLAINER', ['rpt.read', 'rpt.crosscheck.read', 'rpt.crosscheck.explain'], 30);
    await harness.seedRole(TENANT_A, 5, 'RPT_READER', ['rpt.read', 'rpt.crosscheck.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PREPARER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: EXPLAINER, role: 4, kind: 'TENANT' },
      { n: 5, member: READER, role: 5, kind: 'TENANT' },
    ]);
    // The tenant approved a version of the rule that also compares the invented data of the demo forms (maker, submitter and approver are three different people).
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, 'REPORT_CROSSCHECK', 'DEFAULT', 1, 'APPROVED', $2::jsonb, date '2020-01-01', 'Compare the demo data in the test', $3, $4, now(), $5, now())`,
        [TENANT_A, JSON.stringify({ ...crosscheckDefaults(), include_illustrative: true }), memberId(CHECKER), memberId(EXPLAINER), memberId(APPROVER)],
      ],
    ]);
    registerEnterpriseReportRules();
    registerPublicReportForms();
    for (const bundle of enterpriseReportBundles()) REPORT_FORMS.register(bundle);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ReportController, ReportReadsController, ReportCrosscheckController],
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

  it('records the figures of a draft of a form that plays a part, and none for a form that does not', async () => {
    for (const period of MONTHS) expect((await generate('PVN-MONTHLY', period)).status).toBe(200);
    expect((await generate('PLANT-PHU-MY', MONTHS[0] as Record<string, unknown>)).status).toBe(200);
    const sets = await rows<{ layout_code: string }>('select d.layout_code from machvon.report_figure_set f join machvon.report_draft d on d.tenant_id = f.tenant_id and d.id = f.draft_id order by d.layout_code');
    expect(sets.map((one) => one.layout_code)).toEqual(['PVN-MONTHLY', 'PVN-MONTHLY', 'PVN-MONTHLY']);
  });

  it('shows what is compared, the coverage and the findings with formula, source and time of every number', async () => {
    const made = await generate('PVN-QUARTERLY-F2', QUARTER);
    expect(made.status).toBe(200);
    quarterly = made.json.draft_id as string;
    const reply = await crosscheck(quarterly);
    expect(reply.status).toBe(200);
    const body = reply.json as { rule: { code: string; source: string }; coverage: { reports: number; comparisons: number; rules_run: number }; findings: Finding[]; reports: Array<{ role: string }>; gate: { passed: boolean; blocking_open: number } };
    expect(body.rule).toMatchObject({ code: 'DEFAULT', source: 'RULE' });
    expect(body.coverage.reports).toBe(4);
    expect(body.coverage.comparisons).toBeGreaterThan(0);
    const months = body.findings.filter((one) => one.rule_id === 'XR-01');
    expect(months.length).toBeGreaterThan(0);
    expect(months[0]).toMatchObject({ severity: 'BLOCKING', status: 'OPEN', blocks_release: true });
    const first = (reply.json.findings as Array<Record<string, unknown>>).find((one) => one.rule_id === 'XR-01') as { formula: string; terms: Array<{ source: string; as_of: string | null; layout_code: string }> };
    expect(first.formula.length).toBeGreaterThan(10);
    for (const term of first.terms) expect(term.source.length).toBeGreaterThan(5);
    expect(body.gate.passed).toBe(false);
  });

  it('refuses to issue the quarter while a blocking difference has no explanation, and records the refusal', async () => {
    expect((await step(CHECKER, quarterly, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, quarterly, 2, 'approve')).status).toBe(200);
    const refused = await step(APPROVER, quarterly, 3, 'issue');
    expect([refused.status, refused.json.code]).toEqual([409, 'REPORT_CROSSCHECK_BLOCKED']);
    expect(refused.json.blocking_count).toBeGreaterThan(0);
    expect(await rows('select 1 from machvon.report_issue')).toEqual([]);
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'rpt.report_issue_blocked'"))[0]?.n).toBe('1');
  });

  it('is read only with the permission over the whole tenant and never across tenants', async () => {
    expect((await call('GET', '/report-engine/crosscheck?kind=QUARTER&year=2026&index=4', { member: CHECKER })).status).toBe(403);
    expect((await call('GET', '/report-engine/crosscheck?kind=YEAR&year=2026&index=1', { member: READER })).status).toBe(422);
    expect((await call('GET', '/report-engine/crosscheck?kind=QUARTER&year=2026&index=5', { member: READER })).status).toBe(422);
    const other = await call('GET', '/report-engine/crosscheck?kind=QUARTER&year=2026&index=4', { member: READER, tenant: TENANT_B });
    expect((other.json.coverage as { reports: number }).reports).toBe(0);
    expect((other.json.findings as unknown[]).length).toBe(0);
  });

  it('is not explained by the person who prepared a report it is about, nor with a short reason, nor for figures that are not a finding', async () => {
    const findings = (await crosscheck(quarterly)).json.findings as Finding[];
    const blocking = findings.filter((one) => one.severity === 'BLOCKING')[0] as Finding;
    expect(blocking.can_explain).toBe(false);
    const self = await explain(blocking.fingerprint, PREPARER);
    expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    const short = await explain(blocking.fingerprint, EXPLAINER, 'too short');
    expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    const unknown = await explain('0'.repeat(64));
    expect([unknown.status, unknown.json.code]).toEqual([404, 'CROSSCHECK_FINDING_NOT_FOUND']);
    expect((await call('GET', '/report-engine/crosscheck?kind=QUARTER&year=2026&index=4', { member: READER })).json.can_explain).toBe(false);
  });

  it('lets someone else explain each blocking difference once, and a repeat gets the first', async () => {
    const findings = (await crosscheck(quarterly)).json.findings as Finding[];
    const blocking = findings.filter((one) => one.severity === 'BLOCKING');
    expect(blocking.length).toBeGreaterThan(0);
    for (const finding of blocking) {
      const made = await explain(finding.fingerprint);
      expect([made.status, made.json.outcome]).toEqual([200, 'CREATED']);
    }
    const again = await explain((blocking[0] as Finding).fingerprint, CHECKER);
    expect([again.status, again.json.outcome]).toEqual([200, 'EXISTING']);
    const after = (await crosscheck(quarterly)).json as { findings: Finding[]; gate: { passed: boolean; blocking_explained: number } };
    expect(after.findings.filter((one) => one.severity === 'BLOCKING').every((one) => one.status === 'EXPLAINED' && one.blocks_release === false)).toBe(true);
    expect(after.gate.passed).toBe(true);
    const listed = await call('GET', '/report-engine/crosscheck/explanations?period_code=2026-Q4', { member: READER });
    expect((listed.json.items as unknown[]).length).toBe(blocking.length);
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'rpt.crosscheck_explained'"))[0]?.n).toBe(String(blocking.length));
  });

  it('then issues the quarter, keeps the evidence with the copy, with the copy', async () => {
    const issued = await step(APPROVER, quarterly, 3, 'issue');
    expect([issued.status, issued.json.status]).toEqual([200, 'ISSUED']);
    const evidence = await rows<{ outcome: string; comparisons: number; blocking_explained: number; result_sha256: string }>('select outcome, comparisons, blocking_explained, result_sha256 from machvon.report_crosscheck_release');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ outcome: 'EXPLAINED' });
    expect((evidence[0] as { blocking_explained: number }).blocking_explained).toBeGreaterThan(0);
  });
});
