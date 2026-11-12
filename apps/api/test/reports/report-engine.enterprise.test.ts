import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, MasterStore, TenantDatabase } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DEMO_MARK, REPORT_FORM_CATALOGUE, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { enterpriseReportBundles, registerEnterpriseReportRules } from '@machvon/edition-enterprise/src/server.ts';
import { hidePublicOnlyReportForms } from '../../src/editions/load-enterprise';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { REPORT_FORMS, registerPublicReportForms } from '../../src/modules/reports';
import { ReportController } from '../../src/modules/reports/report.controller';
import { ReportReadsController } from '../../src/modules/reports/report-reads.controller';
import { REPORT_CLOCK } from '../../src/modules/reports/tokens';
import { readDocxHeaderFooter } from '../../src/modules/reports/docx-render';
import { readXlsxMarks } from '../../src/modules/reports/xlsx-template';
import { AuthzHarness, TENANT_A, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The six demo forms of the enterprise edition through the report engine (RPT-1 part 2, R18). The name of this file ends in `.enterprise.test.ts`: it is one of the few sources that may name the enterprise package.
 * A DEMO form can be generated and issued only while demo forms are on, carries the demo mark in its files, and is never recorded as accepted by a receiver.
 */
jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PREPARER = 1;
const CHECKER = 2;
const APPROVER = 3;
const SENDER = 4;
const ROOT = 1;
const NOW = new Date('2026-11-08T03:00:00Z');
const MONTH = { kind: 'MONTH', year: 2026, index: 10 };
const QUARTER = { kind: 'QUARTER', year: 2026, index: 3 };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the demo forms of the enterprise edition over HTTP (RPT-1 part 2, R18)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
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
  const periodOf = (code: string) => (REPORT_FORM_CATALOGUE.find((entry) => entry.code === code)?.period === 'QUARTER' ? QUARTER : MONTH);
  const generate = (code: string, extra: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/report-engine/drafts', { member: PREPARER, body: { layout_code: code, period: periodOf(code), ...extra } });
  const step = (member: number, draftId: string, version: number, action: 'check' | 'approve' | 'issue'): Promise<Reply> => call('POST', `/report-engine/drafts/${draftId}/${action}`, { member, ifMatch: version });

  async function approvedDraft(code: string, extra: Record<string, unknown> = {}): Promise<string> {
    const made = await generate(code, extra);
    expect(made.status).toBe(200);
    const draftId = made.json.draft_id as string;
    expect((await step(CHECKER, draftId, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, draftId, 2, 'approve')).status).toBe(200);
    return draftId;
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [PREPARER, CHECKER, APPROVER, SENDER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'RPT_PREPARER', ['rpt.read', 'rpt.generate'], 30);
    await harness.seedRole(TENANT_A, 2, 'RPT_CHECKER', ['rpt.read', 'rpt.check'], 30);
    await harness.seedRole(TENANT_A, 3, 'RPT_APPROVER', ['rpt.read', 'rpt.approve', 'rpt.issue'], 30);
    await harness.seedRole(TENANT_A, 4, 'RPT_SENDER', ['rpt.read', 'rpt.deliver', 'rpt.answer'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PREPARER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: SENDER, role: 4, kind: 'TENANT' },
    ]);
    registerEnterpriseReportRules();
    registerPublicReportForms();
    for (const bundle of enterpriseReportBundles()) REPORT_FORMS.register(bundle);
    // The same call the enterprise loader makes (apps/api/src/editions/load-enterprise.ts), so the catalogue under test is the one of the real process.
    hidePublicOnlyReportForms();
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

  it('lists the six demo forms with their mark, official acceptance pending, and not issuable while demo forms are off', async () => {
    delete process.env.DEMO_FORMS;
    const reply = await call('GET', '/report-engine/catalogue', { member: SENDER });
    expect(reply.status).toBe(200);
    const items = reply.json.items as Array<Record<string, unknown>>;
    // The layouts a tenant configures without code (ENT-4b, codes CFG_*) may be demo too; they are not among the six forms of the catalogue.
    const demo = items.filter((item) => item.status === 'DEMO' && !String(item.code).startsWith('CFG_'));
    expect(demo.map((item) => item.code).sort()).toEqual(REPORT_FORM_CATALOGUE.map((entry) => entry.code).sort());
    for (const item of demo) expect(item).toMatchObject({ edition: 'enterprise', official: 'PENDING_EXTERNAL', data_source: 'ILLUSTRATIVE', demo_mark: DEMO_MARK, issuable: false, form_ref: null });
    expect(reply.json.demo_mode).toBe(false);
    expect(items.find((item) => item.code === 'DIS-WEEKLY')).toMatchObject({ edition: 'public', issuable: true });
    // DEMO-09: the forms of the public edition for the Ministry of Finance and the request to the offices of a province are not in the catalogue of the enterprise.
    expect(items.filter((item) => String(item.code).startsWith('MOF-') || item.code === 'CFG_AGENCY_REQUEST')).toEqual([]);
    process.env.DEMO_FORMS = 'true';
    const on = await call('GET', '/report-engine/catalogue', { member: SENDER });
    expect(on.json.demo_mode).toBe(true);
    expect((on.json.items as Array<Record<string, unknown>>).filter((item) => item.status === 'DEMO').every((item) => item.issuable === true)).toBe(true);
  });

  it('refuses to generate a demo form while demo forms are off, however it is switched off', async () => {
    for (const value of [undefined, 'false']) {
      if (value === undefined) delete process.env.DEMO_FORMS;
      else process.env.DEMO_FORMS = value;
      const refused = await generate('PVN-MONTHLY');
      expect([refused.status, refused.json.code]).toEqual([409, 'TEMPLATE_UNCONFIRMED']);
    }
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.report_draft'))[0]?.n).toBe('0');
  });

  describe('the managed report catalogue (MD.03)', () => {
    const masters = new MasterStore();
    const DECISION = id(0x70, 1);
    const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>): Promise<T> => (harness.tenants as TenantDatabase).withTenant(contextFor(TENANT_A, memberId(member)), work);

    /** An entry in force: proposed by the preparer, approved by the checker, published by the approver. */
    async function publish(masterType: string, key: string, attributes: Record<string, unknown>): Promise<void> {
      const content = { label: key, attributes, parentRecordId: null, validFrom: '2024-01-01', validUntil: null, legalBasis: null };
      const created = await as(PREPARER, (tx) => masters.propose(tx, { masterType, businessKey: key, content, reason: 'Entry of the report catalogue' }, memberId(PREPARER)));
      const submitted = await as(PREPARER, (tx) => masters.submit(tx, created.changeRequestId, 1, memberId(PREPARER)));
      await as(CHECKER, (tx) => masters.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)));
      const record = await as(APPROVER, (tx) => masters.findRecord(tx, created.recordId));
      await as(APPROVER, (tx) => masters.publish(tx, created.recordId, record?.version ?? 0, DECISION, memberId(APPROVER)));
    }

    it('registers a form under the agency the tenant catalogue gives it (the code keeps the receiver of the forms it does not mention)', async () => {
      process.env.DEMO_FORMS = 'true';
      await rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, DECISION, memberId(PREPARER)]);
      await publish('REPORTING_PERIOD_KIND', 'MONTH', { grain: 'MONTH', months: 1, entry_deadline_working_days: 5 });
      await publish('REPORT_TYPE', 'PLANT_PHU_MY', { period_kind_key: 'MONTH', audience: 'INTERNAL', form_code: 'PLANT-PHU-MY' });
      await publish('RECEIVING_AGENCY', 'NMD_PM_2', { agency_kind: 'INTERNAL_MEETING', channel: 'FILE', report_type_keys: ['PLANT_PHU_MY'], receiver_code: 'NMD-PM-2' });
      expect((await generate('PLANT-PHU-MY')).status).toBe(200);
      expect((await rows<{ receiver: string }>(`select receiver from machvon.report_layout where code = 'PLANT-PHU-MY'`))[0]?.receiver).toBe('NMD-PM-2');
      // The catalogue the screens read says the same: the managed receiver where the tenant gave one, the one of the code elsewhere.
      const listed = (await call('GET', '/report-engine/catalogue', { member: SENDER })).json.items as Array<{ code: string; receiver: string }>;
      expect(listed.find((one) => one.code === 'PLANT-PHU-MY')?.receiver).toBe('NMD-PM-2');
      expect(listed.find((one) => one.code === 'PVN-MONTHLY')?.receiver).toBe('PVN');
    });
  });

  it('generates each of the six forms while demo forms are on: the mark is in the print header and footer, the properties and the first cell, and the Word narrative carries it too', async () => {
    process.env.DEMO_FORMS = 'true';
    for (const entry of REPORT_FORM_CATALOGUE) {
      const made = await generate(entry.code);
      expect([entry.code, made.status]).toEqual([entry.code, 200]);
      const draftId = made.json.draft_id as string;
      const draft = (await call('GET', `/report-engine/drafts/${draftId}`, { member: SENDER })).json;
      expect(draft).toMatchObject({ form_status: 'DEMO', demo_mark: DEMO_MARK, data_source: 'ILLUSTRATIVE', demo_forms_off: false });
      expect((draft.preview as { stamp: string }).stamp).toBe(DEMO_MARK);
      const file = await call('GET', `/report-engine/drafts/${draftId}/files/XLSX`, { member: SENDER });
      const marks = await readXlsxMarks(new Uint8Array(Buffer.from(file.json.content_base64 as string, 'base64')));
      expect(marks.subject).toContain(DEMO_MARK);
      expect(marks.sheets[0]?.oddHeader).toContain(DEMO_MARK);
      expect(marks.sheets[0]?.oddFooter).toContain(DEMO_MARK);
      const docx = await call('GET', `/report-engine/drafts/${draftId}/files/DOCX`, { member: SENDER });
      const hasNarrative = ['PVN-QUARTERLY-F2', 'COMMITTEE-PERIODIC', 'INVEST-STEERING', 'PLANT-PHU-MY', 'PVN-MONTHLY', 'HPM-MONTHLY'].includes(entry.code);
      expect(docx.status).toBe(hasNarrative ? 200 : 404);
      if (hasNarrative) {
        const text = readDocxHeaderFooter(new Uint8Array(Buffer.from(docx.json.content_base64 as string, 'base64')));
        expect([...text.headers, ...text.footers].join(' ')).toContain(DEMO_MARK);
      }
      // The PDF is made for every form, with the demo mark drawn on its pages; the narrative adds the Word file.
      expect((draft.files as Array<{ format: string }>).map((one) => one.format)).toEqual(hasNarrative ? ['XLSX', 'DOCX', 'PDF'] : ['XLSX', 'PDF']);
      const pdf = await call('GET', `/report-engine/drafts/${draftId}/files/PDF`, { member: SENDER });
      expect(pdf.status).toBe(200);
      expect(Buffer.from(pdf.json.content_base64 as string, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
  });

  it('AC-ST-RPT-001-3 / UAT-RPT-003: issues a demo copy with its mark, never counts it as accepted, delivers it, and refuses the receiver acceptance of it, in the database as well', async () => {
    process.env.DEMO_FORMS = 'true';
    const draftId = await approvedDraft('HPM-MONTHLY');
    const issued = await step(APPROVER, draftId, 3, 'issue');
    expect(issued.json.status).toBe('ISSUED');
    const issueId = issued.json.resource_id as string;
    const copy = (await call('GET', `/report-engine/issues/${issueId}`, { member: SENDER })).json;
    expect(copy).toMatchObject({ form_status: 'DEMO', demo_mark: DEMO_MARK, counts_as_accepted: false, can_answer: false, data_source: 'ILLUSTRATIVE' });
    expect((await call('GET', '/report-engine/issues?demo=true', { member: SENDER })).json.items as unknown[]).toHaveLength(1);
    expect((await call('GET', '/report-engine/issues?demo=false', { member: SENDER })).json.items as unknown[]).toHaveLength(0);
    const delivered = await call('POST', `/report-engine/issues/${issueId}/deliveries`, { member: SENDER, body: { receiver: 'HPM', channel: 'MANUAL' } });
    expect(delivered.json).toMatchObject({ event: 'DELIVERED', counts_as_accepted: false });
    const accepted = await call('POST', `/report-engine/issues/${issueId}/answers`, { member: SENDER, body: { receiver: 'HPM', outcome: 'ACCEPTED' } });
    expect([accepted.status, accepted.json.code]).toEqual([409, 'TEMPLATE_UNCONFIRMED']);
    // Even a caller that skips the application cannot write the acceptance of a demo copy.
    await expect(
      rows(
        `insert into machvon.report_delivery (tenant_id, issue_id, layout_code, period_code, revision, sha256, receiver, channel, event, counts_as_accepted, recorded_by)
         select tenant_id, id, layout_code, period_code, revision, sha256, 'HPM', 'MANUAL', 'ACCEPTED', true, issued_by from machvon.report_issue where id = $1`,
        [issueId],
      ),
    ).rejects.toThrow(/never accepted/);
    // A rejection is a fact a demo copy can have.
    const rejected = await call('POST', `/report-engine/issues/${issueId}/answers`, { member: SENDER, body: { receiver: 'HPM', outcome: 'REJECTED', note: 'The demo form is not the official one' } });
    expect(rejected.json).toMatchObject({ event: 'REJECTED', counts_as_accepted: false });
    expect(await rows<{ event: string }>(`select event from machvon.report_delivery where issue_id = $1 and event = 'ACCEPTED'`, [issueId])).toEqual([]);
  });

  it('does not issue a draft of a demo form that was switched off after the draft was made', async () => {
    process.env.DEMO_FORMS = 'true';
    const draftId = await approvedDraft('INVEST-STEERING');
    process.env.DEMO_FORMS = 'false';
    const detail = (await call('GET', `/report-engine/drafts/${draftId}`, { member: APPROVER })).json;
    expect(detail).toMatchObject({ state: 'APPROVED', can_issue: false, demo_forms_off: true });
    const refused = await step(APPROVER, draftId, 3, 'issue');
    expect([refused.status, refused.json.code]).toEqual([409, 'TEMPLATE_UNCONFIRMED']);
    expect((await rows<{ n: string }>(`select count(*)::text as n from machvon.report_issue where layout_code = 'INVEST-STEERING'`))[0]?.n).toBe('0');
    process.env.DEMO_FORMS = 'true';
    expect((await step(APPROVER, draftId, 3, 'issue')).json.status).toBe('ISSUED');
  });

  it('keeps a typo of the environment variable from switching demo forms on', async () => {
    process.env.DEMO_FORMS = 'yes';
    const refused = await generate('PLANT-PHU-MY');
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('VALIDATION_FAILED');
  });

  it('logs a delivery or an answer of a form of the code only under a receiver of the tenant catalogue (MD.03)', async () => {
    process.env.DEMO_FORMS = 'true';
    const made = await generate('HPM-MONTHLY', { period: { kind: 'MONTH', year: 2026, index: 9 } });
    const draftId = made.json.draft_id as string;
    expect((await step(CHECKER, draftId, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, draftId, 2, 'approve')).status).toBe(200);
    const issueId = (await step(APPROVER, draftId, 3, 'issue')).json.resource_id as string;
    const refused = await call('POST', `/report-engine/issues/${issueId}/deliveries`, { member: SENDER, body: { receiver: 'NOBODY', channel: 'MANUAL' } });
    expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    const answered = await call('POST', `/report-engine/issues/${issueId}/answers`, { member: SENDER, body: { receiver: 'NOBODY', outcome: 'REJECTED', note: 'The receiver is not in the catalogue' } });
    expect([answered.status, answered.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await call('POST', `/report-engine/issues/${issueId}/deliveries`, { member: SENDER, body: { receiver: 'HPM', channel: 'MANUAL' } })).status).toBe(200);
    expect((await call('POST', `/report-engine/issues/${issueId}/deliveries`, { member: SENDER, body: { receiver: 'NMD-PM-2', channel: 'MANUAL' } })).status).toBe(200);
  });
});
