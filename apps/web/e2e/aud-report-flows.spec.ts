import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AUD-10 (the report of the results of the recommendations that DOC issues, and the closure of the engagement) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): a person asks DOC to issue the report as of a day, the figures are frozen with it and its hash is shown; what DOC answers (the stack has no DOC drafter, so the
 * answers are written to the outbox as DOC writes them) moves the report through the real relay and consumer of AUD: rejected with its reason, a new revision, issued with the person who
 * signed it. The engagement cannot be closed while a recommendation is open or while no report was issued, and then is closed. A reader sees the reports and has no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const TEMPLATE_CODE = 'AUD-BC-KET-QUA-THUC-HIEN-KIEN-NGHI';
const PLACE = 'Cao Bằng';

interface Seeded {
  engagementId: string;
  engagementCode: string;
  conclusionId: string;
  recommendations: string[];
  reportDocumentId: string;
}

/** The template DOC issues the report with: a platform pack is loaded when a tenant is provisioned, which this stack does not do, so the library gets the one row the request looks for. */
async function ensureTemplate(): Promise<void> {
  const tenant = stackInfo().tenants.A;
  const [found] = await sql<{ n: string }>('select count(*) as n from machvon.document_template where template_code = $1', [TEMPLATE_CODE]);
  if (Number(found?.n) > 0) return;
  const [profile] = await sql<{ id: string }>("select id from machvon.document_layout_profile where tenant_id = $1 and status = 'PUBLISHED' limit 1", [tenant]);
  if (profile === undefined) throw new Error('the stack has no published layout profile');
  await sql(
    `insert into machvon.document_template
       (tenant_id, id, template_code, revision, group_code, doc_type_code, title, source_module, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text, content_sha256, effective_from, status, created_by, updated_by)
     values ($1, $2, $3, 1, 'AUDIT_FOLLOWUP', 'BC', 'Báo cáo kết quả thực hiện kiến nghị', 'AUD', $4, '{"blocks": []}'::jsonb, '{"required": []}'::jsonb, 'Luật Thanh tra 84/2025 [CXN-AUD-01]', 'CHƯA XÁC NHẬN PHÁP LÝ', repeat('a', 64), date '2026-01-01', 'DRAFT', $5, $5)`,
    [tenant, randomUUID(), TEMPLATE_CODE, profile.id, membershipOf('owner')],
  );
}

/** An engagement being followed up, its conclusion, one recommendation closed and recovered in full and one still in progress, and the document DOC will issue. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('audOfficer');
  const stamp = `${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const documents = { decision: randomUUID(), conclusion: randomUUID(), report: randomUUID() };
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', $5, $6, date '2026-01-15', 'EFFECTIVE', 'INTERNAL', $4, $4),
            ($1, $3, 'REFERENCE', 'BC', $7, $8, date '2026-10-10', 'EFFECTIVE', 'INTERNAL', $4, $4),
            ($1, $9, 'REFERENCE', 'BC', $10, $11, date '2026-10-26', 'EFFECTIVE', 'INTERNAL', $4, $4)`,
    [tenant, documents.decision, documents.conclusion, officer, `Quyết định kiểm toán ${stamp}`, `${stamp}/QD`, `Kết luận kiểm toán ${stamp}`, `${stamp}/KL`, documents.report, `Báo cáo kết quả ${stamp}`, `${stamp}/BC`],
  );
  const engagementId = randomUUID();
  const conclusionId = randomUUID();
  const engagementCode = `E2E-BC-${stamp}`;
  await sql(
    `insert into machvon.audit_engagement
       (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on,
        classification, created_by, updated_by, version)
     values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'Kiểm toán nhà nước khu vực', $4, $5, date '2025-01-01', date '2025-12-31', $6, 'FOLLOW_UP', date '2026-10-01', 'CONFIDENTIAL', $6, $6, 3)`,
    [tenant, engagementId, engagementCode, documents.decision, `Kiểm toán báo cáo ${stamp}`, officer],
  );
  await sql("insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, organization_unit_id, added_by) values ($1, gen_random_uuid(), $2, 'UNIT', $3, $4)", [tenant, engagementId, unit, officer]);
  await sql(
    `insert into machvon.audit_conclusion
       (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, implementation_due_on, summary, total_financial_vnd, status, created_by, updated_by, version)
     values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', date '2099-12-31', 'Kiểm toán phát hiện thanh toán vượt khối lượng được duyệt.', 1000000000, 'RECEIVED', $5, $5, 1)`,
    [tenant, conclusionId, engagementId, documents.conclusion, officer],
  );
  const recommendations = [randomUUID(), randomUUID()];
  for (const [index, recommendationId] of recommendations.entries()) {
    await sql(
      `insert into machvon.audit_recommendation
         (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, recovered_vnd, status, owner_unit_id, due_on, created_by, updated_by, version)
       values ($1, $2, $3, $4, 'FINANCIAL_RECOVERY', 'Thu hồi khoản thanh toán vượt khối lượng nộp ngân sách.', 400000000, 0, 'OPEN', null, null, $5, $5, 1)`,
      [tenant, recommendationId, conclusionId, `KN-BC-${stamp}-${index + 1}`, officer],
    );
    await sql("update machvon.audit_recommendation set status = 'ASSIGNED', owner_unit_id = $2, due_on = date '2098-06-30' where id = $1", [recommendationId, unit]);
    await sql("update machvon.audit_recommendation set status = 'IN_PROGRESS' where id = $1", [recommendationId]);
  }
  await sql(
    `insert into machvon.audit_recovery_link (tenant_id, id, recommendation_id, source_kind, source_id, amount_vnd, recorded_on, recorded_by)
     values ($1, gen_random_uuid(), $2, 'PAY_RECOVERY', gen_random_uuid(), 400000000, current_date, $3)`,
    [tenant, recommendations[0], officer],
  );
  await closeRecommendation(recommendations[0] as string);
  return { engagementId, engagementCode, conclusionId, recommendations, reportDocumentId: documents.report };
}

/** The last steps of a recommendation as the system would take them: reported by one person and closed by another. */
async function closeRecommendation(recommendationId: string): Promise<void> {
  await sql("update machvon.audit_recommendation set status = 'PENDING_VERIFICATION', submitted_by = $2 where id = $1", [recommendationId, membershipOf('audOwner')]);
  await sql("update machvon.audit_recommendation set status = 'CLOSED', verified_by = $2, verified_at = now() where id = $1", [recommendationId, membershipOf('audVerifier')]);
}

/** What DOC writes to the outbox when it answers: the relay of the stack delivers it to the consumer of AUD. */
async function emit(type: string, payload: Record<string, unknown>): Promise<void> {
  const tenant = stackInfo().tenants.A;
  await sql(
    `insert into machvon.outbox_event (tenant_id, id, aggregate_id, type, schema_version, payload, created_at, aggregate_type, aggregate_version, event_key, correlation_id)
     values ($1, gen_random_uuid(), $2, $3, 1, $4::jsonb, now(), 'outgoing_document', 1, $5, $6)`,
    [tenant, randomUUID(), type, JSON.stringify({ tenant_id: tenant, ...payload }), `e2e-aud-report:${randomUUID()}`, randomUUID()],
  );
}

interface ReportRow {
  id: string;
  revision: number;
  status: string;
  payload_sha256: string;
  reject_code: string | null;
  approved_by: string | null;
  report_document_id: string | null;
  totals: Record<string, unknown>;
}

const reportsOf = (engagementId: string): Promise<ReportRow[]> =>
  sql<ReportRow>(
    'select id, revision, status, payload_sha256, reject_code, approved_by, report_document_id, totals_json as totals from machvon.audit_follow_up_report where engagement_id = $1 order by revision',
    [engagementId],
  );

async function waitForStatus(engagementId: string, revision: number, status: string): Promise<ReportRow> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const found = (await reportsOf(engagementId)).find((row) => row.revision === revision && row.status === status);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the report r${revision} of ${engagementId} did not become ${status}`);
}

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const refOf = (reportId: string, revision: number): string => `AUD:audit_follow_up_report:${reportId}:r${revision}`;

test.describe('AUD-10: the report of the results and the closure', () => {
  test.beforeAll(ensureTemplate);

  test('a person asks DOC to issue the report, DOC rejects it, a new revision is asked for and DOC issues it with the person who signed it (AC-ST-AUD-005-1, AC-ST-AUD-005-2, UAT-AC440, UI-AUD-10)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audReporter', `/aud/aud-10?engagement=${aim.engagementId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.report.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-reports')).toHaveText(vi['aud.report.list.none']);

    // The place of issue is asked for before anything is sent.
    await page.getByRole('button', { name: vi['aud.report.request.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(dialog.getByText(vi['aud.formProblem.required'])).toBeVisible();
    await dialog.getByLabel(vi['aud.report.request.place.label'], { exact: true }).fill(PLACE);
    await dialog.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The figures were frozen with the report: one recommendation closed and recovered in full, one in progress.
    const first = await waitForStatus(aim.engagementId, 1, 'ISSUE_REQUESTED');
    expect(first.totals).toMatchObject({ total: 2, closed: 1, in_progress: 1, amount: '800000000', recovered: '400000000', remaining: '400000000' });
    const row = page.locator('tr[data-report-id]').filter({ hasText: vi['aud.reportStatus.issueRequested'] });
    await expect(row).toContainText(first.payload_sha256.slice(0, 12));
    await expect(row.getByTestId('figures-counts')).toHaveText(vi['aud.report.figures.counts'].replace('{closed}', '1').replace('{inProgress}', '1').replace('{open}', '0').replace('{disputed}', '0').replace('{total}', '2'));
    await expect(row.getByTestId('figures-money')).toContainText('800.000.000');
    await expect(row.getByTestId('report-rate-money')).toContainText('50,00%');
    const requested = await sql<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1 and type = 'aud.report.issue_requested.v1'", [first.id]);
    expect(requested[0]?.payload).toMatchObject({ source_module: 'AUD', source_ref: refOf(first.id, 1), payload_sha256: first.payload_sha256, template_code: TEMPLATE_CODE });
    // The trail keeps the hash and the counts, not the words of the engagement.
    const trail = await sql<{ diff: string }>("select safe_diff::text as diff from machvon.audit_event where resource_id = $1 and action = 'aud.report_requested'", [first.id]);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.diff).toContain(first.payload_sha256);

    // The same day cannot be asked for twice while the first waits for DOC.
    await page.getByRole('button', { name: vi['aud.report.request.action'] }).click();
    const again = page.getByRole('dialog');
    await again.getByLabel(vi['aud.report.request.place.label'], { exact: true }).fill(PLACE);
    await again.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(again.getByTestId('refusal')).toHaveText(vi['aud.reportProblem.exists']);
    await again.getByRole('button', { name: vi['aud.dialog.cancel.action'] }).click();

    // DOC rejects it (answers with the reference and the hash it was asked for): the report is REJECTED with the reason in words.
    await emit('doc.rejected.v1', { source_module: 'AUD', source_ref: refOf(first.id, 1), payload_sha256: first.payload_sha256, reject_code: 'TEMPLATE_NOT_EFFECTIVE' });
    const rejected = await waitForStatus(aim.engagementId, 1, 'REJECTED');
    expect(rejected.reject_code).toBe('TEMPLATE_NOT_EFFECTIVE');
    await page.reload();
    await expect(page.getByTestId('reject-reason')).toHaveText(vi['aud.reportReject.templateNotEffective']);

    // A new revision of the same day is accepted; DOC issues it, and the report keeps the document and the person who signed it.
    await page.getByRole('button', { name: vi['aud.report.request.action'] }).click();
    const next = page.getByRole('dialog');
    await next.getByLabel(vi['aud.report.request.place.label'], { exact: true }).fill(PLACE);
    await next.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    const second = await waitForStatus(aim.engagementId, 2, 'ISSUE_REQUESTED');
    expect(second.id).not.toBe(first.id);
    await emit('doc.issued.v1', {
      document_id: aim.reportDocumentId,
      actor_id: membershipOf('audVerifier'),
      occurred_at: new Date().toISOString(),
      source_module: 'AUD',
      source_ref: refOf(second.id, 2),
      payload_sha256: second.payload_sha256,
    });
    const issued = await waitForStatus(aim.engagementId, 2, 'ISSUED');
    expect(issued).toMatchObject({ report_document_id: aim.reportDocumentId, approved_by: membershipOf('audVerifier') });
    await page.reload();
    const issuedRow = page.locator('tr[data-report-id]').filter({ hasText: vi['aud.reportStatus.issued'] });
    await expect(issuedRow).toBeVisible();
    await expect(issuedRow.getByTestId('approver')).toContainText(vi['aud.report.people.approved'].replace('{name}', ''));
    // DOC saying the same again changes nothing.
    await emit('doc.issued.v1', { document_id: aim.reportDocumentId, actor_id: membershipOf('audVerifier'), source_module: 'AUD', source_ref: refOf(second.id, 2), payload_sha256: second.payload_sha256 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await reportsOf(aim.engagementId)).map((report) => [report.revision, report.status])).toEqual([
      [1, 'REJECTED'],
      [2, 'ISSUED'],
    ]);
  });

  test('a hash that is not the one frozen is kept out, and the report stays where it was (AC-ST-AUD-005-1)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audReporter', `/aud/aud-10?engagement=${aim.engagementId}`);
    await page.getByRole('button', { name: vi['aud.report.request.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['aud.report.request.place.label'], { exact: true }).fill(PLACE);
    await dialog.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    const requested = await waitForStatus(aim.engagementId, 1, 'ISSUE_REQUESTED');
    await emit('doc.issued.v1', { document_id: aim.reportDocumentId, actor_id: membershipOf('audVerifier'), source_module: 'AUD', source_ref: refOf(requested.id, 1), payload_sha256: 'f'.repeat(64) });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const trail = await sql("select 1 from machvon.audit_event where resource_id = $1 and action = 'aud.report_exception'", [requested.id]);
      if (trail.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect((await reportsOf(aim.engagementId))[0]?.status).toBe('ISSUE_REQUESTED');
    expect(await sql("select 1 from machvon.audit_event where resource_id = $1 and action = 'aud.report_exception'", [requested.id])).toHaveLength(1);
  });

  test('the engagement is not closed while a recommendation is open or no report was issued, and is closed once both are met (AC-ST-AUD-005-1, UAT-AC440)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audReporter', `/aud/aud-10?engagement=${aim.engagementId}`);
    await page.getByRole('button', { name: vi['aud.report.request.action'] }).click();
    const request = page.getByRole('dialog');
    await request.getByLabel(vi['aud.report.request.place.label'], { exact: true }).fill(PLACE);
    await request.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    const requested = await waitForStatus(aim.engagementId, 1, 'ISSUE_REQUESTED');
    await emit('doc.issued.v1', { document_id: aim.reportDocumentId, actor_id: membershipOf('audVerifier'), source_module: 'AUD', source_ref: refOf(requested.id, 1), payload_sha256: requested.payload_sha256 });
    await waitForStatus(aim.engagementId, 1, 'ISSUED');

    // The report is issued but one recommendation is still in progress.
    await open(page, 'audCloser', `/aud/aud-10?engagement=${aim.engagementId}`);
    await page.getByRole('button', { name: vi['aud.closure.action'] }).click();
    const closing = page.getByRole('dialog');
    await closing.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(closing.getByTestId('refusal')).toHaveText(vi['aud.reportProblem.openRecommendations'].replace('{count}', '1'));
    await closing.getByRole('button', { name: vi['aud.dialog.cancel.action'] }).click();
    expect((await sql<{ status: string }>('select status from machvon.audit_engagement where id = $1', [aim.engagementId]))[0]?.status).toBe('FOLLOW_UP');

    // The last recommendation is closed: the engagement closes, the hold (none here) is not in the way, and the screen says when.
    await closeRecommendation(aim.recommendations[1] as string);
    await page.reload();
    await page.getByRole('button', { name: vi['aud.closure.action'] }).click();
    const done = page.getByRole('dialog');
    await done.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('closed-on')).not.toHaveText('—');
    await expect(page.getByRole('button', { name: vi['aud.closure.action'] })).toHaveCount(0);
    const [engagement] = await sql<{ status: string; closed_on: string | null }>('select status, closed_on::text as closed_on from machvon.audit_engagement where id = $1', [aim.engagementId]);
    expect(engagement?.status).toBe('CLOSED');
    expect(engagement?.closed_on).not.toBeNull();
  });

  test('without a report that DOC issued the engagement is not closed (422 FOLLOW_UP_REPORT_MISSING, UAT-AC440)', async ({ page }) => {
    const aim = await seed();
    await closeRecommendation(aim.recommendations[1] as string);
    await open(page, 'audCloser', `/aud/aud-10?engagement=${aim.engagementId}`);
    await page.getByRole('button', { name: vi['aud.closure.action'] }).click();
    const closing = page.getByRole('dialog');
    await closing.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(closing.getByTestId('refusal')).toHaveText(vi['aud.reportProblem.reportMissing']);
    expect((await sql<{ status: string }>('select status from machvon.audit_engagement where id = $1', [aim.engagementId]))[0]?.status).toBe('FOLLOW_UP');
  });

  test('a reader sees the reports and the engagement and has no button that asks for a report or closes (UI-AUD-10)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audReader', `/aud/aud-10?engagement=${aim.engagementId}`);
    await expect(page.getByTestId('report-engagement')).toContainText(aim.engagementCode);
    await expect(page.getByTestId('no-reports')).toBeVisible();
    await expect(page.locator('[data-screen-id] button')).toHaveCount(0);
  });
});
