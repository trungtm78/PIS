import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AUD-06 and AUD-07 (the recommendations given to owners and followed to their end) in a real browser against the real API and database (apps/api/test/e2e-stack): a leader gives a recommendation to
 * a unit with a day inside the deadline of the conclusion; the owner plans an action, completes it with a document in force and reports the work; a verifier who had no hand in it closes it. A
 * financial recommendation recovered in part is explained by the owner and closed once the authority accepted the explanation. A reader sees the board and has no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const REASON = 'Khối lượng đã được giám sát xác nhận tại hiện trường theo biên bản.';
const COMMENT = 'Đã kiểm tra hồ sơ chấn chỉnh quy trình tại đơn vị.';

interface Seeded {
  engagementId: string;
  conclusionId: string;
  processId: string;
  processCode: string;
  financialId: string;
  financialCode: string;
  evidenceId: string;
  explanationId: string;
  authorityId: string;
  unitName: string;
}

/** An engagement that is followed up, its conclusion (due in 2099), a process recommendation, and a financial one of 400,000,000 recovered to 300,000,000 and assigned already. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('audOfficer');
  const stamp = `${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const [unitRow] = await sql<{ name: string }>('select name from machvon.organization_unit where id = $1', [unit]);
  const documents = { decision: randomUUID(), evidence: randomUUID(), explanation: randomUUID(), authority: randomUUID() };
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, document_number, number_year, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', $6, $7, date '2026-01-15', 'EFFECTIVE', 'INTERNAL', null, null, $10, $10),
            ($1, $3, 'REFERENCE', 'QD', $8, $9, date '2026-10-20', 'EFFECTIVE', 'INTERNAL', null, null, $10, $10),
            ($1, $4, 'REFERENCE', 'QD', $11, $12, date '2026-10-21', 'EFFECTIVE', 'INTERNAL', null, null, $10, $10),
            ($1, $5, 'INCOMING', 'QD', $13, $14, date '2026-10-22', 'EFFECTIVE', 'INTERNAL', 91, 2026, $10, $10)`,
    [
      tenant,
      documents.decision,
      documents.evidence,
      documents.explanation,
      documents.authority,
      `Quyết định kiểm toán ${stamp}`,
      `${stamp}/QD`,
      `Biên bản chấn chỉnh ${stamp}`,
      `${stamp}/BB`,
      officer,
      `Công văn giải trình ${stamp}`,
      `${stamp}/GT`,
      `Ý kiến của cơ quan ${stamp}`,
      `${stamp}/YK`,
    ],
  );
  const engagementId = randomUUID();
  const conclusionId = randomUUID();
  const [processId, financialId] = [randomUUID(), randomUUID()];
  const processCode = `KN-P-${stamp}`;
  const financialCode = `KN-F-${stamp}`;
  await sql(
    `insert into machvon.audit_engagement
       (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on,
        classification, created_by, updated_by, version)
     values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'Kiểm toán nhà nước khu vực', $4, $5, date '2025-01-01', date '2025-12-31', $6, 'FOLLOW_UP', date '2026-10-01', 'CONFIDENTIAL', $6, $6, 3)`,
    [tenant, engagementId, `E2E-KN-${stamp}`, documents.decision, `Kiểm toán việc đầu tư cầu ${stamp}`, officer],
  );
  await sql(
    `insert into machvon.audit_conclusion
       (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, implementation_due_on, summary, total_financial_vnd, status, created_by, updated_by, version)
     values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', date '2099-12-31', 'Kiểm toán phát hiện thanh toán vượt khối lượng được duyệt.', 1000000000, 'RECEIVED', $5, $5, 1)`,
    [tenant, conclusionId, engagementId, documents.evidence, officer],
  );
  await sql(
    `insert into machvon.audit_recommendation
       (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, recovered_vnd, status, owner_unit_id, due_on, created_by, updated_by, version)
     values ($1, $2, $3, $4, 'PROCESS_CORRECTION', 'Chấn chỉnh quy trình thanh toán theo khối lượng nghiệm thu.', null, 0, 'OPEN', null, null, $7, $7, 1),
            ($1, $5, $3, $6, 'FINANCIAL_RECOVERY', 'Thu hồi khoản thanh toán vượt khối lượng nộp ngân sách.', 400000000, 300000000, 'ASSIGNED', $8, date '2098-06-30', $7, $7, 2)`,
    [tenant, processId, conclusionId, processCode, financialId, financialCode, officer, unit],
  );
  return { engagementId, conclusionId, processId, processCode, financialId, financialCode, evidenceId: documents.evidence, explanationId: documents.explanation, authorityId: documents.authority, unitName: unitRow?.name ?? '' };
}

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const card = (page: Page, code: string) => page.locator('article.aud-card').filter({ hasText: code });
const status = async (id: string): Promise<string> => ((await sql<{ status: string }>('select status from machvon.audit_recommendation where id = $1', [id]))[0] as { status: string }).status;

test.describe('AUD-06 and AUD-07: the recommendations of an engagement', () => {
  test('a leader gives a recommendation to a unit, the owner does the work and reports it, a verifier who had no hand in it closes it (AC-ST-AUD-003-1, AC-ST-AUD-003-2, UAT-AC435, UAT-AC436, UI-AUD-06, UI-AUD-07)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audLeader', `/aud/aud-06?engagement=${aim.engagementId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.remediation.list.title'] })).toBeVisible();
    const row = page.locator('tr[data-recommendation-id]').filter({ hasText: aim.processCode });
    await expect(row).toContainText(vi['aud.recommendationStatus.open']);

    // The day must be inside the deadline of the conclusion (2099-12-31): a day after it is refused before it is sent.
    await row.getByRole('button', { name: vi['aud.remediation.assign.action'] }).click();
    const assign = page.getByRole('dialog');
    await assign.getByLabel(vi['aud.remediation.assign.unit.label'], { exact: true }).selectOption(stackInfo().units.A[UNIT_CODE] as string);
    await assign.getByLabel(vi['aud.remediation.assign.due.label'], { exact: true }).fill('2100-01-01');
    await assign.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(assign.getByText(vi['aud.formProblem.afterDeadline'])).toBeVisible();
    await assign.getByLabel(vi['aud.remediation.assign.due.label'], { exact: true }).fill('2098-06-30');
    await assign.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(row).toContainText(vi['aud.recommendationStatus.assigned']);
    await expect(row).toContainText('2098-06-30');
    expect(await status(aim.processId)).toBe('ASSIGNED');

    // The owner plans an action, completes it with a document in force, and reports the work.
    await open(page, 'audOwner', `/aud/aud-07?engagement=${aim.engagementId}`);
    await expect(card(page, aim.processCode)).toBeVisible();
    await expect(page.locator('[data-column="ASSIGNED"]').locator('article', { hasText: aim.processCode })).toBeVisible();
    await card(page, aim.processCode).getByRole('button', { name: vi['aud.remediation.plan.action'] }).click();
    const plan = page.getByRole('dialog');
    await plan.getByLabel(vi['aud.remediation.plan.code.label'], { exact: true }).fill('HD-01');
    await plan.getByLabel(vi['aud.remediation.plan.plannedOn.label'], { exact: true }).fill('2026-11-15');
    await plan.getByLabel(vi['aud.remediation.plan.description.label'], { exact: true }).fill('Chấn chỉnh quy trình thanh toán theo khối lượng.');
    await plan.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.locator('[data-column="IN_PROGRESS"]').locator('article', { hasText: aim.processCode })).toBeVisible();

    await card(page, aim.processCode).getByRole('button', { name: vi['aud.remediation.complete.action'] }).click();
    const complete = page.getByRole('dialog');
    await complete.getByLabel(vi['aud.remediation.complete.completedOn.label'], { exact: true }).fill('2026-10-24');
    await complete.getByLabel(vi['aud.remediation.complete.evidence.label'], { exact: true }).fill(randomUUID());
    await complete.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(complete.getByTestId('refusal')).toHaveText(vi['aud.remediationProblem.evidenceRequired']);
    await complete.getByLabel(vi['aud.remediation.complete.evidence.label'], { exact: true }).fill(aim.evidenceId);
    await complete.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(card(page, aim.processCode)).toContainText(vi['aud.actionStatus.done']);
    await expect(card(page, aim.processCode)).toContainText(vi['aud.remediation.card.evidence.shown']);

    await card(page, aim.processCode).getByRole('button', { name: vi['aud.remediation.submit.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.locator('[data-column="PENDING_VERIFICATION"]').locator('article', { hasText: aim.processCode })).toBeVisible();
    // The owner cannot verify their own work: the button is not there.
    await expect(card(page, aim.processCode).getByRole('button', { name: vi['aud.remediation.verify.action'] })).toHaveCount(0);
    const [submitted] = await sql<{ submitted_by: string }>('select submitted_by from machvon.audit_recommendation where id = $1', [aim.processId]);
    expect(submitted?.submitted_by).toBe(membershipOf('audOwner'));

    // A verifier who had no hand in the work closes it.
    await open(page, 'audVerifier', `/aud/aud-07?engagement=${aim.engagementId}`);
    await card(page, aim.processCode).getByRole('button', { name: vi['aud.remediation.verify.action'] }).click();
    const verify = page.getByRole('dialog');
    await verify.getByLabel(vi['aud.remediation.verify.decision.label'], { exact: true }).selectOption('RETURN');
    await verify.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(verify.getByText(vi['aud.formProblem.required'])).toBeVisible();
    await verify.getByLabel(vi['aud.remediation.verify.decision.label'], { exact: true }).selectOption('CLOSE');
    await verify.getByLabel(vi['aud.remediation.verify.comment.label'], { exact: true }).fill(COMMENT);
    await verify.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.locator('[data-column="CLOSED"]').locator('article', { hasText: aim.processCode })).toBeVisible();
    const [closed] = await sql<{ status: string; verified_by: string }>('select status, verified_by from machvon.audit_recommendation where id = $1', [aim.processId]);
    expect(closed).toEqual({ status: 'CLOSED', verified_by: membershipOf('audVerifier') });

    // The trail and the events keep codes and ids, not what the verifier wrote.
    const trail = await sql<{ diff: string }>("select safe_diff::text as diff from machvon.audit_event where action like 'aud.recommendation_%' and resource_id = $1", [aim.processId]);
    const events = await sql<{ payload: string }>("select payload::text as payload from machvon.outbox_event where type like 'aud.%' and aggregate_id::text = $1", [aim.processId]);
    expect(trail.length).toBeGreaterThanOrEqual(3);
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const text of [JSON.stringify(trail), JSON.stringify(events)]) expect(text).not.toContain(COMMENT);
  });

  test('the owner explains a financial recommendation recovered in part; the authority accepts the explanation and the verifier closes it on what was recovered (AC-ST-AUD-003-3, UAT-AC441)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audOwner', `/aud/aud-07?engagement=${aim.engagementId}`);
    await expect(card(page, aim.financialCode)).toContainText('300.000.000 / 400.000.000');
    await card(page, aim.financialCode).getByRole('button', { name: vi['aud.remediation.dispute.action'] }).click();
    const dispute = page.getByRole('dialog');
    await dispute.getByLabel(vi['aud.remediation.dispute.reason.label'], { exact: true }).fill(REASON);
    await dispute.getByLabel(vi['aud.remediation.dispute.document.label'], { exact: true }).fill(aim.explanationId);
    await dispute.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.locator('[data-column="DISPUTED"]').locator('article', { hasText: aim.financialCode })).toBeVisible();
    await expect(card(page, aim.financialCode).getByTestId('dispute-note')).toContainText(REASON);
    expect(await status(aim.financialId)).toBe('DISPUTED');

    // The authority's answer needs a document of the authority in force; a document that is not one is refused in words.
    await open(page, 'audVerifier', `/aud/aud-07?engagement=${aim.engagementId}`);
    await card(page, aim.financialCode).getByRole('button', { name: vi['aud.remediation.decision.action'] }).click();
    const decision = page.getByRole('dialog');
    await decision.getByLabel(vi['aud.remediation.decision.outcome.label'], { exact: true }).selectOption('ACCEPTED_BY_AUTHORITY');
    await decision.getByLabel(vi['aud.remediation.decision.document.label'], { exact: true }).fill(randomUUID());
    await decision.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(decision.getByTestId('refusal')).toHaveText(vi['aud.remediationProblem.decisionNotEffective']);
    await decision.getByLabel(vi['aud.remediation.decision.document.label'], { exact: true }).fill(aim.authorityId);
    await decision.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.locator('[data-column="PENDING_VERIFICATION"]').locator('article', { hasText: aim.financialCode })).toBeVisible();
    await expect(card(page, aim.financialCode)).toContainText(vi['aud.disputeOutcome.accepted']);

    await card(page, aim.financialCode).getByRole('button', { name: vi['aud.remediation.verify.action'] }).click();
    const verify = page.getByRole('dialog');
    await verify.getByLabel(vi['aud.remediation.verify.decision.label'], { exact: true }).selectOption('CLOSE');
    await verify.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.locator('[data-column="CLOSED"]').locator('article', { hasText: aim.financialCode })).toBeVisible();
    const [closed] = await sql<{ status: string; recovered: string; outcome: string; verified_by: string }>(
      'select status, recovered_vnd::text as recovered, dispute_outcome as outcome, verified_by from machvon.audit_recommendation where id = $1',
      [aim.financialId],
    );
    expect(closed).toEqual({ status: 'CLOSED', recovered: '300000000', outcome: 'ACCEPTED_BY_AUTHORITY', verified_by: membershipOf('audVerifier') });
  });

  test('a reader sees the board and the table and has no button that assigns, plans, reports, disputes or verifies (UI-AUD-06, UI-AUD-07)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audReader', `/aud/aud-07?engagement=${aim.engagementId}`);
    await expect(card(page, aim.financialCode)).toBeVisible();
    await expect(page.locator('article.aud-card button')).toHaveCount(0);
    await open(page, 'audReader', `/aud/aud-06?engagement=${aim.engagementId}`);
    const row = page.locator('tr[data-recommendation-id]').filter({ hasText: aim.processCode });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.locator('tr[data-recommendation-id]').filter({ hasText: aim.financialCode })).toContainText(aim.unitName);
  });
});
