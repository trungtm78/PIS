import { randomUUID } from 'node:crypto';
import { ADMIN, APPROVER, INVESTORS, MneApp, PREPARER, READER, REVIEWER, SCOPED_PREPARER, TENANT_A, TENANT_B, unitId } from './mne-app';
import { etag, flowOf } from './mne-flow';

jest.setTimeout(120_000);

const app = new MneApp();
const flow = flowOf(app);

const correct = async (id: string, body: Record<string, unknown>, member = PREPARER, version?: number) =>
  flow.call('POST', `/mne-reports/${id}/corrections`, member, { body, ifMatch: etag(version ?? (await flow.versionOf(id))) });
const generate = async (id: string, body: Record<string, unknown> = { target_system: 'NATIONAL_PIM_SYSTEM', formats: ['CSV'] }) =>
  flow.call('POST', `/mne-reports/${id}/export-packages`, REVIEWER, { body, ifMatch: etag(await flow.versionOf(id)) });
const statusOf = async (id: string): Promise<string> => (await flow.rowOf(id)).status as string;
const packages = async (id: string) =>
  app.harness.owner<{ id: string; file_sha256: string; status: string }>(TENANT_A, [['select id, file_sha256, status from machvon.mne_export_package where mne_report_id = $1::uuid order by created_at', [id]]]);

describe('the correction of an issued report (ST-MNE-007, MNE F3)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);
  afterEach(() => flow.clean());

  it('UAT-AC294: refuses a correction without its reason, starts revision 2 as a draft that supersedes the filed revision 1, and supersedes it only when DOC issues the new one', async () => {
    const { id } = await flow.issuedReport();
    await generate(id);
    const [first] = await packages(id);
    const [pkg] = await packages(id);
    expect(pkg).toBeDefined();
    // The filing: the report is SUBMITTED_EXTERNAL when its correction starts.
    const receipt = await flow.call('POST', `/mne-export-packages/${first?.id as string}/submission-receipt`, REVIEWER, {
      body: { receipt_reference: 'QG-2026-000777', submitted_at: new Date().toISOString() },
      ifMatch: etag(1),
    });
    expect(receipt.status).toBe(200);
    expect(await statusOf(id)).toBe('SUBMITTED_EXTERNAL');

    const without = await correct(id, { correction_reason: 'short' });
    expect([without.status, without.json.code, without.json.detail]).toEqual([422, 'CORRECTION_REASON_REQUIRED', 'correction_reason']);
    expect((await flow.call('POST', `/mne-reports/${id}/corrections`, PREPARER, { body: {}, ifMatch: etag(await flow.versionOf(id)) })).json.code).toBe('CORRECTION_REASON_REQUIRED');

    const started = await correct(id, { correction_reason: '  The plan figure of the second quarter was entered wrongly.  ' });
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
    const next = started.json.resource_id as string;
    expect(next).not.toBe(id);
    expect(await flow.rowOf(next)).toMatchObject({ revision: 2, status: 'DRAFT', supersedes_id: id, correction_reason: 'The plan figure of the second quarter was entered wrongly.', payload_sha256: null, doc_document_id: null, period_label: 'H1-2026' });
    // The new revision starts from the cells of the old one, and the old one is what it was.
    const shown = await flow.call('GET', `/mne-reports/${next}`, READER);
    expect(shown.json).toMatchObject({ revision: 2, supersedes_id: id, correction_reason: 'The plan figure of the second quarter was entered wrongly.' });
    expect((shown.json.fields as Array<{ key: string; value: unknown }>).find((field) => field.key === 'assessment')?.value).toBe('Giải ngân đúng tiến độ.');
    expect(await statusOf(id)).toBe('SUBMITTED_EXTERNAL');
    expect((shown.json.history as Array<{ revision: number; status: string; current: boolean }>).map((entry) => [entry.revision, entry.status, entry.current])).toEqual([
      [1, 'SUBMITTED_EXTERNAL', false],
      [2, 'DRAFT', true],
    ]);

    // Revision 2 is written, handed in, approved and issued like any report; only DOC's answer supersedes revision 1.
    expect((await flow.call('POST', `/mne-reports/${next}/revisions`, PREPARER, { body: { narrative: { assessment: 'Đã sửa số liệu kế hoạch quý II.' } }, ifMatch: etag(1) })).status).toBe(200);
    expect((await flow.call('POST', `/mne-reports/${next}/submit`, PREPARER, { ifMatch: etag(2) })).status).toBe(200);
    expect(await statusOf(id)).toBe('SUBMITTED_EXTERNAL');
    const sha2 = await flow.approveAndIssue(next, '00000000-0000-4000-8000-0000000000d2');
    expect(await statusOf(next)).toBe('ISSUED');
    expect(await statusOf(id)).toBe('SUPERSEDED');
    expect(sha2).toMatch(/^[0-9a-f]{64}$/);
    const trail = await app.harness.owner(TENANT_A, [["select action from machvon.audit_event where resource_id::text = $1 order by occurred_at", [id]]]);
    expect(trail.map((entry) => (entry as { action: string }).action)).toContain('mne.report_superseded');

    // What was issued stays downloadable, and the new revision gives a package of its own content.
    const old = await flow.call('GET', `/mne-reports/${id}`, REVIEWER);
    expect((old.json.packages as Array<{ download: unknown }>)[0]?.download).not.toBeNull();
    expect(old.json).toMatchObject({ status: 'SUPERSEDED' });
    await generate(next);
    const [made] = await packages(next);
    expect(made?.file_sha256).not.toBe(first?.file_sha256);
    // A superseded report is no longer exported.
    const again = await generate(id);
    expect([again.status, again.json.code]).toEqual([409, 'REPORT_NOT_ISSUED']);
  });

  it('does not make the correction of a report of the calendar another obligation', async () => {
    const formId = await flow.publishedForm('TT44-M02');
    const rule = await flow.call('POST', '/mne-obligation-rules', ADMIN, {
      body: { rule_code: 'OVERALL_SEMIANNUAL', form_id: formId, reporting_role: 'INVESTOR', recipient: 'Department of Finance', frequency: 'SEMIANNUAL', due_rule_json: { period: 'H1', month: 7, day: 10 }, legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]', effective_from: '2026-01-01' },
    });
    expect((await flow.call('POST', `/mne-obligation-rules/${rule.json.resource_id as string}/publish`, APPROVER, { ifMatch: etag(1) })).status).toBe(200);
    const { snapshotId } = await flow.frozenSnapshot();
    const made = await flow.call('POST', '/mne-reports', PREPARER, { body: { form_id: formId, report_year: 2026, period_label: 'H1-2026', scope_unit_id: unitId(INVESTORS[0]), snapshot_id: snapshotId, obligation_rule_id: rule.json.resource_id } });
    const id = made.json.resource_id as string;
    await flow.call('POST', `/mne-reports/${id}/revisions`, PREPARER, { body: { narrative: { assessment: 'Đạt kế hoạch.' } }, ifMatch: etag(1) });
    await flow.call('POST', `/mne-reports/${id}/submit`, PREPARER, { ifMatch: etag(2) });
    await flow.approveAndIssue(id);
    const calendar = async () => ((await flow.call('GET', '/mne-obligations?report_year=2026&limit=200', READER)).json.items as Array<{ mne_report_id: string; status: string }>).filter((item) => item.mne_report_id === id || item.status === 'DRAFT');
    expect((await calendar()).map((item) => item.status)).toEqual(['ISSUED']);
    const started = await correct(id, { correction_reason: 'The plan figure was entered wrongly.' });
    expect(started.status).toBe(200);
    // The correction is a draft of the same obligation: the calendar still has one entry, and it is the report that was issued.
    const listed = (await flow.call('GET', '/mne-obligations?report_year=2026&limit=200', READER)).json.items as Array<{ mne_report_id: string; status: string; period_label: string }>;
    expect(listed.filter((item) => item.period_label === 'H1-2026')).toEqual([expect.objectContaining({ mne_report_id: id, status: 'ISSUED' })]);
    // Not filed: the calendar says so with no day, and counts the days late to today (the deadline of the rule is long past).
    expect(listed.find((item) => item.period_label === 'H1-2026')).toMatchObject({ filed_on: null, is_late: true, days_late: expect.any(Number) });
  });

  it('keeps an obligation that was never filed open after its report is superseded, and settles it once with the first filing', async () => {
    const { id } = await flow.issuedReport();
    const started = await correct(id, { correction_reason: 'The plan figure was entered wrongly.' });
    const next = started.json.resource_id as string;
    await flow.call('POST', `/mne-reports/${next}/submit`, PREPARER, { ifMatch: etag(await flow.versionOf(next)) });
    await flow.approveAndIssue(next, '00000000-0000-4000-8000-0000000000d2');
    // Due on 2026-06-30 and never filed: superseded, it is still open, late by today and counting.
    expect(await flow.rowOf(id)).toMatchObject({ status: 'SUPERSEDED', filed_on: null });
    const open = (await flow.call('GET', `/mne-reports/${id}`, READER)).json;
    expect(open.is_late).toBe(true);
    expect(open.days_late).toBeGreaterThan(0);
    // The filing of the correction is within the day it was due (the due date is moved ahead for the test): the obligation was filed on time, on that day.
    await app.harness.owner(TENANT_A, [[`update machvon.mne_report set due_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date + 3 where id = any($1::uuid[])`, [[id, next]]]]);
    await generate(next);
    const [pkg] = await packages(next);
    const filed = await flow.call('POST', `/mne-export-packages/${pkg?.id as string}/submission-receipt`, REVIEWER, { body: { receipt_reference: 'QG-2026-000888', submitted_at: new Date().toISOString() }, ifMatch: etag(1) });
    expect(filed.status).toBe(200);
    expect(await flow.rowOf(next)).toMatchObject({ status: 'SUBMITTED_EXTERNAL', is_late: false });
    const settled = await flow.rowOf(id);
    expect(settled).toMatchObject({ status: 'SUPERSEDED', is_late: false });
    expect(settled.filed_on).not.toBeNull();
    expect((await flow.call('GET', `/mne-reports/${id}`, READER)).json).toMatchObject({ is_late: false, days_late: 0 });
    // A later filing of the same revision, after the due date, does not change how late the obligation was.
    await app.harness.owner(TENANT_A, [[`update machvon.mne_report set due_date = '2026-06-30' where id = any($1::uuid[])`, [[id, next]]]]);
    await generate(next, { target_system: 'RECIPIENT_AGENCY', formats: ['CSV'] });
    const second = (await packages(next)).find((entry) => entry.id !== pkg?.id);
    expect((await flow.call('POST', `/mne-export-packages/${second?.id as string}/submission-receipt`, REVIEWER, { body: { receipt_reference: 'QG-2026-000889', submitted_at: new Date().toISOString() }, ifMatch: etag(1) })).status).toBe(200);
    expect(await flow.rowOf(id)).toMatchObject({ status: 'SUPERSEDED', is_late: false, filed_on: settled.filed_on });
  });

  it('keeps the files that expired before the report was superseded downloadable', async () => {
    const { id } = await flow.issuedReport();
    await generate(id);
    await app.harness.owner(TENANT_A, [[`update machvon.mne_export_package set status = 'EXPIRED', expired_at = now() where mne_report_id = $1::uuid`, [id]]]);
    const asIssued = (await flow.call('GET', `/mne-reports/${id}`, REVIEWER)).json.packages as Array<{ status: string; download: unknown }>;
    // While the report is in force an expired file is made again, not offered.
    expect(asIssued[0]).toMatchObject({ status: 'EXPIRED', download: null });
    const started = await correct(id, { correction_reason: 'The plan figure was entered wrongly.' });
    const next = started.json.resource_id as string;
    await flow.call('POST', `/mne-reports/${next}/submit`, PREPARER, { ifMatch: etag(await flow.versionOf(next)) });
    await flow.approveAndIssue(next, '00000000-0000-4000-8000-0000000000d2');
    const afterwards = (await flow.call('GET', `/mne-reports/${id}`, REVIEWER)).json.packages as Array<{ status: string; download: unknown }>;
    expect(afterwards[0]).toMatchObject({ status: 'EXPIRED' });
    expect(afterwards[0]?.download).not.toBeNull();
  });

  it('lets DOC take back the document of a revision after it was superseded: the recall is kept and its files give no link any more', async () => {
    const { id, sha256 } = await flow.issuedReport();
    await generate(id);
    const started = await correct(id, { correction_reason: 'The plan figure was entered wrongly.' });
    const next = started.json.resource_id as string;
    await flow.call('POST', `/mne-reports/${next}/submit`, PREPARER, { ifMatch: etag(await flow.versionOf(next)) });
    await flow.approveAndIssue(next, '00000000-0000-4000-8000-0000000000d2');
    expect(await statusOf(id)).toBe('SUPERSEDED');
    const before = await flow.call('GET', `/mne-reports/${id}`, REVIEWER);
    expect((before.json.packages as Array<{ download: unknown }>)[0]?.download).not.toBeNull();
    const recalled = flow.delivery('doc.recalled.v1', { tenant_id: TENANT_A, source_module: 'MNE', source_ref: `MNE:mne_report:${id}:r1`, payload_sha256: sha256, occurred_at: new Date().toISOString() });
    expect(await flow.consumer().handle(recalled)).toBe('processed');
    expect(await flow.rowOf(id)).toMatchObject({ status: 'SUPERSEDED' });
    expect((await flow.rowOf(id)).recalled_at).not.toBeNull();
    const after = await flow.call('GET', `/mne-reports/${id}`, REVIEWER);
    expect(after.json.recalled_at).not.toBeNull();
    expect((after.json.packages as Array<{ download: unknown }>)[0]?.download).toBeNull();
  });

  it('refuses a second correction of the same report (409 CORRECTION_ALREADY_OPEN, naming the first), and a report that is not issued', async () => {
    const { id } = await flow.issuedReport();
    const first = await correct(id, { correction_reason: 'The first reason for a correction.' });
    expect(first.status).toBe(200);
    const second = await correct(id, { correction_reason: 'Another reason for the same report.' });
    expect([second.status, second.json.code]).toEqual([409, 'CORRECTION_ALREADY_OPEN']);
    expect(JSON.stringify(second.json)).toContain(first.json.resource_id as string);
    expect(await app.harness.owner(TENANT_A, [['select count(*)::text as n from machvon.mne_report where supersedes_id = $1::uuid', [id]]])).toEqual([{ n: '1' }]);
    // The correction itself is a draft, and a draft is edited, not corrected.
    const draft = await correct(first.json.resource_id as string, { correction_reason: 'A reason for a draft revision.' });
    expect([draft.status, draft.json.code]).toEqual([409, 'REPORT_NOT_ISSUED']);
  });

  it('starts from another frozen snapshot when one is named, which fills the locked cells again, and refuses one that is not usable', async () => {
    const { id } = await flow.issuedReport();
    const bigger = await flow.frozenSnapshot({ paid: '900000000000' });
    const started = await correct(id, { correction_reason: 'The Treasury figures were corrected.', snapshot_id: bigger.snapshotId });
    expect(started.status).toBe(200);
    const shown = await flow.call('GET', `/mne-reports/${started.json.resource_id as string}`, READER);
    const fields = Object.fromEntries((shown.json.fields as Array<{ key: string; value: unknown }>).map((field) => [field.key, field.value]));
    expect([fields.rate_pm, fields.rate_total]).toEqual(['90.0000', '72.0000']);
    expect(shown.json).toMatchObject({ snapshot: { id: bigger.snapshotId } });
    const late = await flow.issuedReport({ formCode: 'TT44-M03' });
    const unknown = await correct(late.id, { correction_reason: 'A snapshot that does not exist.', snapshot_id: randomUUID() });
    expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'snapshot_id']);
  });

  it('keeps the rights apart and the tenants: only who prepares corrects, in the units of the grant, and another tenant finds nothing', async () => {
    const { id } = await flow.issuedReport();
    expect((await correct(id, { correction_reason: 'A reason that is long enough.' }, READER)).status).toBe(403);
    expect((await correct(id, { correction_reason: 'A reason that is long enough.' }, REVIEWER)).status).toBe(403);
    expect((await flow.call('POST', `/mne-reports/${id}/corrections`, ADMIN, { tenantId: TENANT_B, body: { correction_reason: 'A reason that is long enough.' }, ifMatch: etag(1) })).status).toBe(403);
    const scoped = await correct(id, { correction_reason: 'A reason that is long enough.' }, SCOPED_PREPARER);
    expect(scoped.status).toBe(200);
    const stale = await flow.issuedReport({ formCode: 'TT44-M04' });
    const conflict = await correct(stale.id, { correction_reason: 'A reason that is long enough.' }, PREPARER, 99);
    expect([conflict.status, conflict.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    expect((await flow.call('POST', `/mne-reports/${randomUUID()}/corrections`, PREPARER, { body: { correction_reason: 'A reason that is long enough.' }, ifMatch: etag(1) })).status).toBe(404);
  });

  it('is kept by the table: a report is superseded by one revision, and a revision keeps what it supersedes', async () => {
    const { id } = await flow.issuedReport();
    const started = await correct(id, { correction_reason: 'The first reason for a correction.' });
    const next = started.json.resource_id as string;
    await expect(
      app.harness.owner(TENANT_A, [
        [
          `insert into machvon.mne_report (tenant_id, id, form_id, report_year, period_label, scope_unit_id, due_date, revision, status, payload_json, supersedes_id, correction_reason, created_by, updated_by)
           select tenant_id, gen_random_uuid(), form_id, report_year, period_label, scope_unit_id, due_date, 3, 'DRAFT', '{}'::jsonb, id, 'Another one that is long enough', created_by, updated_by from machvon.mne_report where id = $1::uuid`,
          [id],
        ],
      ]),
    ).rejects.toThrow(/mne_report_supersedes_uq/);
    await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_report set supersedes_id = null where id = $1::uuid`, [next]]])).rejects.toThrow(/keeps its form, unit, project, period and revision/);
  });
});

