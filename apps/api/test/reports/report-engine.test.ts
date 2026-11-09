import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { COMMITTEE_PACK_CODE, DIS_WEEKLY_CODE, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { REPORT_FORMS, registerPublicReportForms, rptModule } from '../../src/modules/reports';
import { ReportController } from '../../src/modules/reports/report.controller';
import { ReportReadsController } from '../../src/modules/reports/report-reads.controller';
import { REPORT_CLOCK } from '../../src/modules/reports/tokens';
import { readXlsxMap } from '../../src/modules/reports/xlsx-template';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PREPARER = 1;
const CHECKER = 2;
const APPROVER = 3;
const SENDER = 4; // delivers and records the answers
const READER = 5;
const EVERYTHING = 6; // holds every right of the engine: used to show that one person cannot do two steps
const UNIT_ADMIN = 7; // every right, over one unit tree only
const NOBODY = 8;
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const FAMILY = 0xb7;
const NOW = new Date('2027-10-15T03:00:00Z');
const FIGURES = ['home.read'];
const ALL = ['rpt.read', 'rpt.generate', 'rpt.check', 'rpt.approve', 'rpt.issue', 'rpt.deliver', 'rpt.answer', ...FIGURES];
const PERIOD = { kind: 'AS_OF', year: 2027, day: '2027-10-17' };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('the report engine over HTTP: generate, check, approve, issue, deliver (RPT-1 part 2, R17)', () => {
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
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  let first: { issueId: string; draftId: string } = { issueId: '', draftId: '' };
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string }>('select safe_diff, reason, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

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

  /** A frozen snapshot with one project whose line has 1000 from the Prime Minister, 250 added (billions) and `paid` paid by the Treasury. */
  async function snapshot(paid: string, options: { supersedes?: string } = {}): Promise<string> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    const snapshotId = randomUUID();
    const projectId = id(FAMILY, 500 + counter);
    const asOf = '2027-10-12';
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `RPT-${counter}`, unitId(DEPARTMENT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, date '2046-01-02' + $4::int, date '2046-01-02' + $4::int + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `RP-${counter}`, counter * 7, id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, supersedes_id, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, $5::date, $5::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $6, $7::timestamptz, $8, $6, $6)`,
        [TENANT_A, snapshotId, periodId, NOW.toISOString(), asOf, WORKER_MEMBERSHIP_ID, new Date(NOW.getTime() + counter * 1000).toISOString(), options.supersedes ?? null],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, $5::numeric, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(DEPARTMENT), paid],
      ],
    ]);
    return snapshotId;
  }

  const generate = (member: number, extra: Record<string, unknown> = {}, period: Record<string, unknown> = PERIOD): Promise<Reply> =>
    call('POST', '/report-engine/drafts', { member, body: { layout_code: DIS_WEEKLY_CODE, period, ...extra } });
  const step = (member: number, draftId: string, version: number, action: 'check' | 'approve' | 'issue'): Promise<Reply> => call('POST', `/report-engine/drafts/${draftId}/${action}`, { member, ifMatch: version });
  const draftOf = async (draftId: string, member = READER): Promise<Record<string, unknown>> => (await call('GET', `/report-engine/drafts/${draftId}`, { member })).json;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
      ]);
    }
    for (const n of [PREPARER, CHECKER, APPROVER, SENDER, READER, EVERYTHING, UNIT_ADMIN, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'RPT_PREPARER', ['rpt.read', 'rpt.generate', ...FIGURES], 30);
    await harness.seedRole(TENANT_A, 2, 'RPT_CHECKER', ['rpt.read', 'rpt.check'], 30);
    await harness.seedRole(TENANT_A, 3, 'RPT_APPROVER', ['rpt.read', 'rpt.approve', 'rpt.issue'], 30);
    await harness.seedRole(TENANT_A, 4, 'RPT_SENDER', ['rpt.read', 'rpt.deliver', 'rpt.answer'], 30);
    await harness.seedRole(TENANT_A, 5, 'RPT_READER', ['rpt.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'RPT_ALL', ALL, 50);
    await harness.seedRole(TENANT_B, 6, 'RPT_ALL', ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PREPARER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 3, kind: 'TENANT' },
      { n: 4, member: SENDER, role: 4, kind: 'TENANT' },
      { n: 5, member: READER, role: 5, kind: 'TENANT' },
      { n: 6, member: EVERYTHING, role: 6, kind: 'TENANT' },
      { n: 7, member: UNIT_ADMIN, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 6, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    registerPublicReportForms();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ReportController, ReportReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: REPORT_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module RPT and lists the generic forms of the public edition', async () => {
    for (const controller of [ReportController, ReportReadsController]) expect(rptModule.controllers).toContain(controller);
    const reply = await call('GET', '/report-engine/catalogue', { member: READER });
    expect(reply.status).toBe(200);
    const items = reply.json.items as Array<Record<string, unknown>>;
    // The public forms: the weekly report of DIS, the meeting pack of the committee (BAN-1) and the four forms for the Ministry of Finance (GOV-12).
    expect(items.map((item) => item.code)).toEqual([COMMITTEE_PACK_CODE, DIS_WEEKLY_CODE, 'MOF-DIS-MONTHLY', 'MOF-DIS-QUARTERLY', 'MOF-DIS-WEEKLY', 'MOF-DIS-YEARLY']);
    expect(items.find((item) => item.code === DIS_WEEKLY_CODE)).toMatchObject({ edition: 'public', status: 'READY', official: 'CONFIRMED', data_source: 'LIVE', registered: false, issuable: true, demo_mark: null, whole_tenant: true });
    expect(items.map((item) => item.code).filter((code) => !String(code).startsWith('MOF-DIS-'))).toEqual([COMMITTEE_PACK_CODE, DIS_WEEKLY_CODE]);
    expect(items[0]).toMatchObject({ edition: 'public', status: 'READY', official: 'CONFIRMED', data_source: 'LIVE', registered: false, issuable: true, demo_mark: null, whole_tenant: true });
    expect(reply.json).toMatchObject({ demo_mode: false, can_generate: false });
    // No enterprise form is in a public process (npm run edition:check holds the sources to it too).
    expect(REPORT_FORMS.list().every((form) => form.edition === 'public')).toBe(true);
  });

  it('refuses a caller without the right, and a right held over one unit only (a report is the document of the whole organisation)', async () => {
    expect((await call('GET', '/report-engine/catalogue', { member: NOBODY })).status).toBe(403);
    expect((await call('GET', '/report-engine/issues', { member: UNIT_ADMIN })).status).toBe(403);
    expect((await generate(UNIT_ADMIN)).status).toBe(403);
    expect((await generate(READER)).status).toBe(403);
    expect((await call('GET', '/report-engine/catalogue', { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(200);
  });

  it('fills the weekly report from the frozen snapshot through the register: the cell of each indicator holds the figure of the command center, and the report is a draft with a preview', async () => {
    const first = await snapshot('600000000000');
    const made = await generate(PREPARER);
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ outcome: 'CREATED', issue_id: null, revision: 1 });
    expect(made.json.package_sha256).toMatch(/^[0-9a-f]{64}$/);
    const draftId = made.json.draft_id as string;
    const draft = await draftOf(draftId);
    expect(draft).toMatchObject({ state: 'DRAFT', layout_code: DIS_WEEKLY_CODE, period_code: '2027-10-17', base_revision: 0, reason: null, form_status: 'READY', demo_mark: null, data_source: 'LIVE', version: 1, can_check: false, can_approve: false, demo_forms_off: false });
    expect(draft.snapshot).toMatchObject({ snapshot_id: first, revision: 1, cutoff: '2027-10-12' });
    const preview = draft.preview as { rows: Array<{ row: number; cells: Array<{ col: number; text: string }> }>; stamp: string | null };
    expect(preview.stamp).toBeNull();
    const textOf = (row: number, col: number): string | undefined => preview.rows.find((one) => one.row === row)?.cells.find((cell) => cell.col === col)?.text;
    // Row 6 is the first indicator (DISBURSEMENT_RATE_PM): 600 of 1000 billion is 60 percent; the Treasury amount is whole dong.
    expect(textOf(6, 3)).toBe('60,00');
    expect(textOf(8, 3)).toBe('600.000.000.000');
    // The same figures as the screen of the leader: the file and the screen cannot give two numbers for one indicator.
    const file = await call('GET', `/report-engine/drafts/${draftId}/files/XLSX`, { member: READER });
    expect(file.status).toBe(200);
    const bytes = Buffer.from(file.json.content_base64 as string, 'base64');
    expect(sha(bytes)).toBe(file.json.sha256);
    const map = (await readXlsxMap(new Uint8Array(bytes)))[0];
    expect(map?.cells.C6?.value).toBe(60);
    expect(map?.cells.C8?.value).toBe(600_000_000_000);
    expect((await audits(draftId, 'rpt.report_generated'))[0]?.safe_diff).toMatchObject({ layout_code: DIS_WEEKLY_CODE, data_source: 'LIVE', snapshot_id: first });
    expect((await events(draftId, 'rpt.report.generated.v1'))[0]?.payload).toMatchObject({ draft_id: draftId, layout_code: DIS_WEEKLY_CODE, package_sha256: made.json.package_sha256 });
    // Generating the same thing again is the same draft, not a second one.
    const again = await generate(PREPARER);
    expect(again.json).toMatchObject({ outcome: 'EXISTING', draft_id: draftId });
  });

  it('AC-ST-RPT-001-1 / UAT-RPT-001: keeps preparer, checker and approver three different people, in order, and the approver issues', async () => {
    const made = await generate(PREPARER);
    const draftId = made.json.draft_id as string;
    // Out of order: nobody approves or issues what was not checked.
    expect((await step(APPROVER, draftId, 1, 'approve')).status).toBe(409);
    expect((await step(APPROVER, draftId, 1, 'issue')).json).toMatchObject({ code: 'REPORT_STATE_INVALID' });
    // The preparer does not check their own work, and a stale version is a conflict.
    expect((await step(EVERYTHING, draftId, 1, 'check')).status).toBe(200);
    expect((await step(EVERYTHING, draftId, 1, 'check')).status).toBe(409);
    expect((await step(PREPARER, draftId, 2, 'approve')).status).toBe(403);
    // Whoever checked does not approve.
    expect((await step(EVERYTHING, draftId, 2, 'approve')).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    expect((await step(APPROVER, draftId, 2, 'approve')).status).toBe(200);
    // Only the approver issues.
    expect((await step(EVERYTHING, draftId, 3, 'issue')).json).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    const draft = await draftOf(draftId, APPROVER);
    expect(draft).toMatchObject({ state: 'APPROVED', can_issue: true, can_check: false });
    const issued = await step(APPROVER, draftId, 3, 'issue');
    expect(issued.json).toMatchObject({ status: 'ISSUED', resource_version: 1 });
    first = { issueId: issued.json.resource_id as string, draftId };
  });

  it('issues an immutable copy with its hash, signatories and snapshot, and refuses to change or delete it, in the database as well', async () => {
    const { issueId, draftId } = first;
    const issue = (await call('GET', `/report-engine/issues/${issueId}`, { member: READER })).json;
    expect(issue).toMatchObject({ revision: 1, supersedes_id: null, reason: null, is_current: true, current_revision: 1, form_status: 'READY', counts_as_accepted: true, demo_mark: null, layout_code: DIS_WEEKLY_CODE });
    expect(issue.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((issue.files as Array<{ name: string; format: string }>)[0]).toMatchObject({ format: 'XLSX' });
    expect(((issue.files as Array<{ name: string }>)[0] as { name: string }).name).toMatch(/^DIS-WEEKLY_2027-10-17_v01_[0-9a-f]{8}\.xlsx$/);
    expect((issue.chain as unknown[]).length).toBe(1);
    expect((await audits(issueId, 'rpt.report_issued'))[0]?.safe_diff).toMatchObject({ revision: 1, sha256: issue.sha256, counts_as_accepted: true });
    expect((await events(issueId, 'rpt.report.issued.v1'))[0]?.payload).toMatchObject({ issue_id: issueId, revision: 1, sha256: issue.sha256 });
    const file = await call('GET', `/report-engine/issues/${issueId}/files/XLSX`, { member: READER });
    expect(file.status).toBe(200);
    expect(sha(Buffer.from(file.json.content_base64 as string, 'base64'))).toBe((issue.files as Array<{ sha256: string }>)[0]?.sha256);
    expect((await call('GET', `/report-engine/issues/${issueId}/files/DOCX`, { member: READER })).status).toBe(404);
    // ENT-4b: the PDF of the same document is kept with its own hash, named by the file-name rule, checked on every read, and carries the layout hash of the copy.
    const pdf = await call('GET', `/report-engine/issues/${issueId}/files/PDF`, { member: READER });
    expect(pdf.status).toBe(200);
    expect(pdf.json.name).toMatch(/^DIS-WEEKLY_2027-10-17_v01_[0-9a-f]{8}.pdf$/);
    const pdfBytes = Buffer.from(pdf.json.content_base64 as string, 'base64');
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(sha(pdfBytes)).toBe(pdf.json.sha256);
    expect((issue.files as Array<{ format: string }>).map((one) => one.format)).toEqual(['XLSX', 'PDF']);
    expect(issue.layout_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('GET', `/report-engine/issues/${issueId}/files/ODS`, { member: READER })).status).toBe(422);
    // The package digest is still the digest of the workbook alone: the PDF is a rendition, not a second source.
    expect((issue.files as Array<{ sha256: string }>)[0]?.sha256).not.toBe(issue.sha256);
    // Insert-only: not even the owner of the database changes or removes an issued copy; an issued draft is frozen too.
    await expect(rows('update machvon.report_issue set reason = $1 where id = $2', ['x'.repeat(12), issueId])).rejects.toThrow(/never changes/);
    await expect(rows('delete from machvon.report_issue where id = $1', [issueId])).rejects.toThrow(/never changes/);
    await expect(rows(`update machvon.report_draft set reason = 'x' where id = $1`, [draftId])).rejects.toThrow(/never changes/);
    // Another tenant does not see it.
    expect((await call('GET', `/report-engine/issues/${issueId}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
  });

  it('AC-ST-RPT-001-2 / UAT-RPT-002: knows a repeat of the same bytes (DUPLICATE) and makes a correction a new revision that needs a reason and names the copy it replaces', async () => {
    // The head of the series is revision 1 from the test before: the same figures give the same bytes.
    const same = await generate(PREPARER);
    expect(same.json).toMatchObject({ outcome: 'DUPLICATE', draft_id: null, revision: 1 });
    const heads = (await call('GET', '/report-engine/issues?heads_only=true', { member: READER })).json.items as Array<Record<string, unknown>>;
    expect(heads).toHaveLength(1);
    // The data moved (a newer snapshot with other figures): other bytes need a reason, and 422 comes before anything is made.
    await snapshot('900000000000');
    const unexplained = await generate(PREPARER);
    expect(unexplained.status).toBe(422);
    expect(unexplained.json).toMatchObject({ code: 'VALIDATION_FAILED' });
    const made = await generate(PREPARER, { reason: 'The Treasury booked a late payment of the week' });
    expect(made.json).toMatchObject({ outcome: 'CREATED', revision: 2 });
    const draftId = made.json.draft_id as string;
    expect(await draftOf(draftId)).toMatchObject({ base_revision: 1, reason: 'The Treasury booked a late payment of the week' });
    expect((await step(CHECKER, draftId, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, draftId, 2, 'approve')).status).toBe(200);
    const issued = await step(APPROVER, draftId, 3, 'issue');
    expect(issued.json.status).toBe('ISSUED');
    const second = (await call('GET', `/report-engine/issues/${issued.json.resource_id as string}`, { member: READER })).json;
    expect(second).toMatchObject({ revision: 2, supersedes_id: first.issueId, reason: 'The Treasury booked a late payment of the week', is_current: true });
    expect((second.chain as Array<{ revision: number }>).map((link) => link.revision)).toEqual([1, 2]);
    const old = (await call('GET', `/report-engine/issues/${first.issueId}`, { member: READER })).json;
    expect(old).toMatchObject({ is_current: false, current_revision: 2 });
    // The snapshot revision travels with the copy (R17).
    expect(second.snapshot).toMatchObject({ revision: 1 });
  });

  it('refuses a draft made before the series moved: it names the current revision', async () => {
    await snapshot('950000000000');
    const stale = await generate(PREPARER, { reason: 'Another correction of the same week' });
    const staleId = stale.json.draft_id as string;
    expect((await step(CHECKER, staleId, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, staleId, 2, 'approve')).status).toBe(200);
    // While it waits, another correction of the same series is issued.
    await snapshot('960000000000');
    const rival = await generate(PREPARER, { reason: 'The rival correction of the same week' });
    const rivalId = rival.json.draft_id as string;
    expect((await step(CHECKER, rivalId, 1, 'check')).status).toBe(200);
    expect((await step(APPROVER, rivalId, 2, 'approve')).status).toBe(200);
    expect((await step(APPROVER, rivalId, 3, 'issue')).status).toBe(200);
    const refused = await step(APPROVER, staleId, 3, 'issue');
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'REPORT_OUT_OF_DATE', current_revision: 3 });
    const unchanged = await rows<{ n: string }>(`select count(*)::text as n from machvon.report_issue where layout_code = $1 and period_code = '2027-10-17'`, [DIS_WEEKLY_CODE]);
    expect(unchanged[0]?.n).toBe('3');
  });

  it('delivers a copy once, refuses a copy that a later revision replaced, and logs every delivery', async () => {
    const list = (await call('GET', '/report-engine/issues?layout_code=DIS-WEEKLY', { member: READER })).json.items as Array<{ id: string; revision: number }>;
    const byRevision = new Map(list.map((one) => [one.revision, one.id]));
    const old = byRevision.get(1) as string;
    const head = byRevision.get(3) as string;
    const target = { receiver: 'KBNN', channel: 'DOWNLOAD', reference: 'letter 12/BC' };
    // A copy a later revision replaced is out of date.
    const stale = await call('POST', `/report-engine/issues/${old}/deliveries`, { member: SENDER, body: target });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'REPORT_OUT_OF_DATE', current_revision: 3 });
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.report_delivery where issue_id = $1', [old]))[0]?.n).toBe('0');
    const done = await call('POST', `/report-engine/issues/${head}/deliveries`, { member: SENDER, body: target });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ receiver: 'KBNN', channel: 'DOWNLOAD', event: 'DELIVERED', revision: 3, counts_as_accepted: true, reference: 'letter 12/BC' });
    // The same bytes to the same receiver again: nothing new is written.
    const again = await call('POST', `/report-engine/issues/${head}/deliveries`, { member: SENDER, body: target });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'ALREADY_DELIVERED' });
    // Another receiver is another delivery; the channel of the group's adapter is not for a person to write.
    expect((await call('POST', `/report-engine/issues/${head}/deliveries`, { member: SENDER, body: { receiver: 'PVN', channel: 'EMAIL' } })).status).toBe(200);
    expect((await call('POST', `/report-engine/issues/${head}/deliveries`, { member: SENDER, body: { receiver: 'HPM', channel: 'HPM_PUSH' } })).status).toBe(422);
    expect((await call('POST', `/report-engine/issues/${head}/deliveries`, { member: SENDER, body: { receiver: 'bad receiver', channel: 'EMAIL' } })).status).toBe(422);
    expect((await call('POST', `/report-engine/issues/${head}/deliveries`, { member: READER, body: target })).status).toBe(403);
    const log = (await call('GET', '/report-engine/deliveries?layout_code=DIS-WEEKLY', { member: READER })).json;
    expect((log.items as Array<{ receiver: string }>).map((one) => one.receiver).sort()).toEqual(['KBNN', 'PVN']);
    expect((await audits(head, 'rpt.report_delivered')).length).toBe(2);
    expect((await events(head, 'rpt.report.delivered.v1')).length).toBe(2);
    // The receiver accepts: recorded once; a rejection needs words.
    expect((await call('POST', `/report-engine/issues/${head}/answers`, { member: SENDER, body: { receiver: 'KBNN', outcome: 'ACCEPTED', reference: 'receipt 7' } })).json).toMatchObject({ event: 'ACCEPTED', counts_as_accepted: true });
    expect((await call('POST', `/report-engine/issues/${head}/answers`, { member: SENDER, body: { receiver: 'KBNN', outcome: 'ACCEPTED' } })).status).toBe(409);
    expect((await call('POST', `/report-engine/issues/${head}/answers`, { member: SENDER, body: { receiver: 'PVN', outcome: 'REJECTED' } })).status).toBe(422);
    expect((await call('POST', `/report-engine/issues/${head}/answers`, { member: SENDER, body: { receiver: 'PVN', outcome: 'REJECTED', note: 'The weekly totals do not match ours' } })).json).toMatchObject({ event: 'REJECTED' });
    // An answer needs a delivery first.
    expect((await call('POST', `/report-engine/issues/${head}/answers`, { member: SENDER, body: { receiver: 'NOBODY', outcome: 'ACCEPTED' } })).status).toBe(409);
    // The database keeps the log append-only.
    await expect(rows(`update machvon.report_delivery set note = 'x' where issue_id = $1`, [head])).rejects.toThrow(/append-only/);
  });

  it('shows the heads of the series and the whole history, with the hash of each', async () => {
    const heads = (await call('GET', '/report-engine/issues?heads_only=true', { member: READER })).json.items as Array<{ revision: number; is_current: boolean; sha256: string }>;
    expect(heads.map((one) => [one.revision, one.is_current])).toEqual([[3, true]]);
    const all = (await call('GET', '/report-engine/issues', { member: READER })).json.items as Array<{ revision: number; sha256: string }>;
    expect(all.map((one) => one.revision).sort()).toEqual([1, 2, 3]);
    expect(new Set(all.map((one) => one.sha256)).size).toBe(3);
    expect((await call('GET', '/report-engine/issues?limit=0', { member: READER })).status).toBe(422);
    expect((await call('GET', '/report-engine/issues?demo=maybe', { member: READER })).status).toBe(422);
    expect((await call('GET', '/report-engine/drafts?state=BOGUS', { member: READER })).status).toBe(422);
  });

  it('refuses an unknown form, a period of the wrong kind and a malformed period', async () => {
    expect((await call('POST', '/report-engine/drafts', { member: PREPARER, body: { layout_code: 'NO-SUCH', period: PERIOD } })).status).toBe(404);
    expect((await generate(PREPARER, {}, { kind: 'MONTH', year: 2027, index: 10 })).status).toBe(422);
    expect((await generate(PREPARER, {}, { kind: 'AS_OF', year: 2026, day: '2027-10-17' })).status).toBe(422);
  });

  it('answers a tenant with no frozen snapshot with a form whose cells are empty and say so, never zeros', async () => {
    const made = await call('POST', '/report-engine/drafts', { member: B_ADMIN, tenantId: TENANT_B, body: { layout_code: DIS_WEEKLY_CODE, period: PERIOD } });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ outcome: 'CREATED', revision: 1 });
    const detail = (await call('GET', `/report-engine/drafts/${made.json.draft_id as string}`, { member: B_ADMIN, tenantId: TENANT_B })).json;
    expect(detail.issue_count).toBeGreaterThanOrEqual(8);
    expect(detail.snapshot).toBeNull();
    const preview = detail.preview as { rows: Array<{ row: number; cells: Array<{ col: number; text: string }> }> };
    expect(preview.rows.find((row) => row.row === 6)?.cells.find((cell) => cell.col === 3)?.text).toBe('');
    expect((detail.issues as Array<{ code: string }>).every((issue) => issue.code === 'NO_FIGURE')).toBe(true);
  });
});
