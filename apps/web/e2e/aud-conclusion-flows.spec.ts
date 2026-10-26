import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AUD-04 and AUD-05 (the conclusion of an engagement, its findings and its recommendations) in a real browser against the real API and database (apps/api/test/e2e-stack): the coordinator
 * records the conclusion of an engagement that is ongoing with a document of DOC that is in force, which moves it to FOLLOW_UP; adds the recommendations, the financial ones never adding up to
 * more than the total of the conclusion (the screen shows the shortfall, and refuses the amount above it); adds a finding about a project of the engagement; what the authority wrote stays out
 * of the trail and the events; a reader sees the conclusion and the findings and has no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const SUMMARY = 'Kiểm toán phát hiện thanh toán vượt khối lượng được duyệt tại gói thầu thi công.';
const FINDING_WORDS = 'Thanh toán vượt khối lượng đã nghiệm thu tại hiện trường.';
const RECOMMENDATION_WORDS = 'Thu hồi khoản thanh toán vượt khối lượng nộp ngân sách.';
const TOTAL = '1.250.000.000';

interface Seeded {
  engagementId: string;
  code: string;
  projectCode: string;
  projectId: string;
  documentId: string;
}

/** A project of the unit, an engagement about it that is ONGOING, and the conclusion document of DOC that is in force (a received document with its number). */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('audOfficer');
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const stamp = `${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const projectId = randomUUID();
  const projectCode = `E2E-KLP-${stamp}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, projectCode, `Dự án cầu ${projectCode}`, unit, area?.id, officer],
  );
  const decisionId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', $3, $4, date '2026-01-15', 'EFFECTIVE', 'INTERNAL', $5, $5)`,
    [tenant, decisionId, `Quyết định kiểm toán ${stamp}`, `${stamp}/QD-KTNN`, officer],
  );
  const documentId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, document_number, number_year, created_by, updated_by)
     values ($1, $2, 'INCOMING', 'QD', $3, $4, date '2026-10-10', 'EFFECTIVE', 'INTERNAL', 88, 2026, $5, $5)`,
    [tenant, documentId, `Báo cáo kiểm toán ${stamp}`, `${stamp}/BC-KTNN`, officer],
  );
  const engagementId = randomUUID();
  const code = `E2E-KL-${stamp}`;
  await sql(
    `insert into machvon.audit_engagement
       (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on,
        classification, created_by, updated_by, version)
     values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'Kiểm toán nhà nước khu vực', $4, $5, date '2025-01-01', date '2025-12-31', $6, 'ONGOING', date '2026-10-01',
             'CONFIDENTIAL', $6, $6, 1)`,
    [tenant, engagementId, code, decisionId, `Kiểm toán việc đầu tư cầu ${stamp}`, officer],
  );
  await sql(`insert into machvon.audit_scope_item (tenant_id, id, engagement_id, scope_kind, project_id, added_by) values ($1, $2, $3, 'PROJECT', $4, $5)`, [
    tenant,
    randomUUID(),
    engagementId,
    projectId,
    officer,
  ]);
  return { engagementId, code, projectCode, projectId, documentId };
}

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function addRecommendation(page: Page, code: string, type: string, amount: string | undefined, description = RECOMMENDATION_WORDS): Promise<void> {
  await page.getByRole('button', { name: vi['aud.conclusion.recommendations.add.action'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(vi['aud.recommendation.dialog.code.label'], { exact: true }).fill(code);
  await dialog.getByLabel(vi['aud.recommendation.dialog.type.label'], { exact: true }).selectOption(type);
  if (amount !== undefined) await dialog.getByLabel(vi['aud.recommendation.dialog.amount.label'], { exact: true }).fill(amount);
  await dialog.getByLabel(vi['aud.recommendation.dialog.description.label'], { exact: true }).fill(description);
  await dialog.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
}

test.describe('AUD-04 and AUD-05: the conclusion of an engagement', () => {
  test('the coordinator records the conclusion, adds the recommendations within its total and a finding about the project (AC-ST-AUD-002-1, AC-ST-AUD-002-2, UAT-AC434, UI-AUD-04, UI-AUD-05)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audOfficer', `/aud/aud-04?engagement=${aim.engagementId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.conclusion.page.title'] })).toBeVisible();

    // The form asks for what is missing before it sends anything.
    const form = page.getByTestId('conclusion-form');
    await form.getByRole('button', { name: vi['aud.conclusion.form.submit.action'] }).click();
    await expect(form.getByText(vi['aud.formProblem.required']).first()).toBeVisible();

    await form.getByLabel(vi['aud.conclusion.form.kind.label'], { exact: true }).selectOption('AUDIT_REPORT');
    await form.getByLabel(vi['aud.conclusion.form.document.label'], { exact: true }).fill(aim.documentId);
    await form.getByLabel(vi['aud.conclusion.form.issuedOn.label'], { exact: true }).fill('2026-10-10');
    await form.getByLabel(vi['aud.conclusion.form.receivedOn.label'], { exact: true }).fill('2026-10-15');
    await form.getByLabel(vi['aud.conclusion.form.implementationDue.label'], { exact: true }).fill('2026-12-31');
    await form.getByLabel(vi['aud.conclusion.form.total.label'], { exact: true }).fill(TOTAL);
    await form.getByLabel(vi['aud.conclusion.form.summary.label'], { exact: true }).fill(SUMMARY);
    await form.getByRole('button', { name: vi['aud.conclusion.form.submit.action'] }).click();

    // The conclusion is recorded, the engagement is followed up, and the whole total is a shortfall.
    await expect(page.getByTestId('conclusion-card')).toContainText(vi['aud.conclusionKind.auditReport']);
    await expect(page.getByTestId('conclusion-card')).toContainText(vi['aud.conclusionStatus.received']);
    await expect(page.getByTestId('engagement-card')).toContainText(vi['aud.engagementStatus.followUp']);
    await expect(page.getByTestId('money-total')).toHaveText(TOTAL);
    await expect(page.getByTestId('money-shortfall')).toHaveText(TOTAL);
    const [engagement] = await sql<{ status: string; id: string }>('select status, id from machvon.audit_engagement where id = $1', [aim.engagementId]);
    expect(engagement?.status).toBe('FOLLOW_UP');
    const [conclusion] = await sql<{ id: string }>('select id from machvon.audit_conclusion where engagement_id = $1', [aim.engagementId]);

    // 800,000,000 and 400,000,000 leave 50,000,000, which the screen warns of before the extra one.
    await addRecommendation(page, 'KN-001', 'FINANCIAL_RECOVERY', '800.000.000');
    await expect(page.getByTestId('money-recommended')).toHaveText('800.000.000');
    await addRecommendation(page, 'KN-002', 'FINANCIAL_ADJUSTMENT', '400.000.000', 'Giảm trừ vào đợt thanh toán kế tiếp của hợp đồng.');
    await expect(page.getByTestId('money-recommended')).toHaveText('1.200.000.000');
    await expect(page.getByTestId('money-shortfall')).toHaveText('50.000.000');
    await expect(page.getByTestId('shortfall')).toHaveText(vi['aud.conclusion.shortfall.warning'].replace('{amount}', '50.000.000'));

    // A further 100,000,000 is refused before it is sent, and nothing was stored.
    await page.getByRole('button', { name: vi['aud.conclusion.recommendations.add.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['aud.recommendation.dialog.code.label'], { exact: true }).fill('KN-003');
    await dialog.getByLabel(vi['aud.recommendation.dialog.type.label'], { exact: true }).selectOption('FINANCIAL_RECOVERY');
    await expect(dialog).toContainText(vi['aud.recommendation.dialog.amount.remaining'].replace('{remaining}', '50.000.000'));
    await dialog.getByLabel(vi['aud.recommendation.dialog.amount.label'], { exact: true }).fill('100.000.000');
    await dialog.getByLabel(vi['aud.recommendation.dialog.description.label'], { exact: true }).fill(RECOMMENDATION_WORDS);
    await dialog.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(dialog.getByText(vi['aud.formProblem.exceeds'])).toBeVisible();
    await dialog.getByRole('button', { name: vi['aud.dialog.cancel.action'] }).click();
    const [count] = await sql<{ n: string; total: string }>(
      "select count(*)::text as n, coalesce(sum(amount_vnd), 0)::text as total from machvon.audit_recommendation where conclusion_id = $1",
      [conclusion?.id],
    );
    expect(count).toEqual({ n: '2', total: '1200000000' });

    // The server holds the same line when the screen is not asked: the amount that fits is stored, the next dong is refused, whoever sends it.
    await addRecommendation(page, 'KN-004', 'FINANCIAL_RECOVERY', '50.000.000');
    await expect(page.getByTestId('shortfall')).toHaveText(vi['aud.conclusion.shortfall.none']);
    const [stored] = await sql<{ total: string }>('select coalesce(sum(amount_vnd), 0)::text as total from machvon.audit_recommendation where conclusion_id = $1', [conclusion?.id]);
    expect(stored?.total).toBe('1250000000');

    // A finding about the project of the engagement, then the recommendation that answers it, are listed.
    await page.getByRole('link', { name: vi['aud.conclusion.findings.link'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.finding.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-findings')).toBeVisible();
    await page.getByRole('button', { name: vi['aud.finding.add.action'] }).click();
    const finding = page.getByRole('dialog');
    await finding.getByLabel(vi['aud.finding.dialog.code.label'], { exact: true }).fill('PH-001');
    await finding.getByLabel(vi['aud.finding.dialog.category.label'], { exact: true }).selectOption('FINANCIAL');
    await finding.getByLabel(vi['aud.finding.dialog.severity.label'], { exact: true }).selectOption('HIGH');
    await finding.getByLabel(vi['aud.finding.dialog.place.label'], { exact: true }).selectOption({ label: `${vi['aud.scopeKind.project']} · ${aim.projectCode}` });
    await finding.getByLabel(vi['aud.finding.dialog.amount.label'], { exact: true }).fill('300.000.000');
    await finding.getByLabel(vi['aud.finding.dialog.description.label'], { exact: true }).fill(FINDING_WORDS);
    await finding.getByLabel(vi['aud.finding.dialog.legalBasis.label'], { exact: true }).fill('Điều 12 Luật Đầu tư công');
    await finding.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    const row = page.locator('[data-finding-id]').filter({ hasText: 'PH-001' });
    await expect(row).toContainText(vi['aud.findingCategory.financial']);
    await expect(row).toContainText(aim.projectCode);
    await expect(row).toContainText('300.000.000');
    await expect(row).toContainText(vi['aud.findingSeverity.high']);
    await expect(row).toContainText('Điều 12 Luật Đầu tư công');

    // The trail and the events hold codes, ids and amounts, not what the authority wrote.
    const trail = await sql<{ action: string; diff: string }>(
      "select action, safe_diff::text as diff from machvon.audit_event where action in ('aud.conclusion_recorded', 'aud.finding_recorded', 'aud.recommendation_created') and (resource_id::text = $1 or safe_diff ->> 'conclusion_id' = $1)",
      [conclusion?.id],
    );
    expect(trail.map((entry) => entry.action).sort()).toEqual(['aud.conclusion_recorded', 'aud.finding_recorded', 'aud.recommendation_created', 'aud.recommendation_created', 'aud.recommendation_created'].sort());
    const events = await sql<{ type: string; payload: string }>(
      "select type, payload::text as payload from machvon.outbox_event where type like 'aud.%' and (aggregate_id::text = $1 or payload ->> 'conclusion_id' = $1)",
      [conclusion?.id],
    );
    expect(events.length).toBe(5);
    for (const text of [JSON.stringify(trail), JSON.stringify(events)]) for (const words of [SUMMARY, FINDING_WORDS, RECOMMENDATION_WORDS]) expect(text).not.toContain(words);
  });

  test('a reader sees the conclusion, its recommendations and its findings and has no button that records or adds (UI-AUD-04, UI-AUD-05)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audOfficer', `/aud/aud-04?engagement=${aim.engagementId}`);
    const form = page.getByTestId('conclusion-form');
    await form.getByLabel(vi['aud.conclusion.form.kind.label'], { exact: true }).selectOption('INSPECTION_CONCLUSION');
    await form.getByLabel(vi['aud.conclusion.form.document.label'], { exact: true }).fill(aim.documentId);
    await form.getByLabel(vi['aud.conclusion.form.issuedOn.label'], { exact: true }).fill('2026-10-10');
    await form.getByLabel(vi['aud.conclusion.form.receivedOn.label'], { exact: true }).fill('2026-10-15');
    await form.getByLabel(vi['aud.conclusion.form.total.label'], { exact: true }).fill('1.000.000');
    await form.getByLabel(vi['aud.conclusion.form.summary.label'], { exact: true }).fill(SUMMARY);
    await form.getByRole('button', { name: vi['aud.conclusion.form.submit.action'] }).click();
    await expect(page.getByTestId('conclusion-card')).toBeVisible();

    await open(page, 'audReader', `/aud/aud-04?engagement=${aim.engagementId}`);
    await expect(page.getByTestId('conclusion-card')).toContainText(vi['aud.conclusionKind.inspectionConclusion']);
    await expect(page.getByTestId('money-total')).toHaveText('1.000.000');
    await expect(page.getByRole('button', { name: vi['aud.conclusion.recommendations.add.action'] })).toHaveCount(0);
    await open(page, 'audReader', `/aud/aud-05?engagement=${aim.engagementId}`);
    await expect(page.getByTestId('no-findings')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['aud.finding.add.action'] })).toHaveCount(0);

    // An engagement that does not exist is told as an empty file, in the same words as one outside the scope of the reader.
    await open(page, 'audReader', `/aud/aud-04?engagement=${randomUUID()}`);
    await expect(page.getByText(vi['states.empty.title'])).toBeVisible();
  });

  test('a reader who may not record sees an engagement that awaits its conclusion without the form', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audReader', `/aud/aud-04?engagement=${aim.engagementId}`);
    await expect(page.getByTestId('conclusion-read-only')).toHaveText(vi['aud.conclusion.readOnly.note']);
    await expect(page.getByTestId('conclusion-form')).toHaveCount(0);
  });
});
