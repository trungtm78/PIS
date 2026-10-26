import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AUD-08 and AUD-01 (the ledger of the money recovered and the overview of it) in a real browser against the real API and database (apps/api/test/e2e-stack): an accountant records a remittance
 * of the Treasury with its document in force, is refused a sum above what is left, and reverses a line with a reason, which writes a line against it and takes nothing away. A reader sees the
 * ledger, the rates with their numerators and denominators, and the overview, and has no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const REASON = 'Chứng từ của Kho bạc đã được nhập hai lần vào sổ.';

interface Seeded {
  engagementId: string;
  engagementCode: string;
  recommendationId: string;
  recommendationCode: string;
  evidenceId: string;
}

/** A followed-up engagement with one financial recommendation of 400,000,000 of which nothing is recovered yet, and a document in force that evidences a remittance. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('audOfficer');
  const stamp = `${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const documents = { decision: randomUUID(), evidence: randomUUID() };
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, document_number, number_year, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', $4, $5, date '2026-01-15', 'EFFECTIVE', 'INTERNAL', null, null, $8, $8),
            ($1, $3, 'REFERENCE', 'QD', $6, $7, date '2026-10-20', 'EFFECTIVE', 'INTERNAL', null, null, $8, $8)`,
    [tenant, documents.decision, documents.evidence, `Quyết định kiểm toán ${stamp}`, `${stamp}/QD`, `Chứng từ nộp ngân sách ${stamp}`, `${stamp}/CT`, officer],
  );
  const engagementId = randomUUID();
  const conclusionId = randomUUID();
  const recommendationId = randomUUID();
  const engagementCode = `E2E-TH-${stamp}`;
  const recommendationCode = `KN-TH-${stamp}`;
  await sql(
    `insert into machvon.audit_engagement
       (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on,
        classification, created_by, updated_by, version)
     values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'Kiểm toán nhà nước khu vực', $4, $5, date '2025-01-01', date '2025-12-31', $6, 'FOLLOW_UP', date '2026-10-01', 'CONFIDENTIAL', $6, $6, 3)`,
    [tenant, engagementId, engagementCode, documents.decision, `Kiểm toán thu hồi ${stamp}`, officer],
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
     values ($1, $2, $3, $4, 'FINANCIAL_RECOVERY', 'Thu hồi khoản thanh toán vượt khối lượng nộp ngân sách.', 400000000, 0, 'ASSIGNED', $5, date '2098-06-30', $6, $6, 2)`,
    [tenant, recommendationId, conclusionId, recommendationCode, unit, officer],
  );
  return { engagementId, engagementCode, recommendationId, recommendationCode, evidenceId: documents.evidence };
}

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const recovered = async (id: string): Promise<string> => ((await sql<{ recovered: string }>('select recovered_vnd::text as recovered from machvon.audit_recommendation where id = $1', [id]))[0] as { recovered: string }).recovered;

test.describe('AUD-08 and AUD-01: the money recovered', () => {
  test('an accountant records a remittance with its document, is refused more than what is left, and reverses a line with a reason that leaves a line against it (AC-ST-AUD-004-1, AC-ST-AUD-004-2, UI-AUD-08)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'audAccountant', `/aud/aud-08?engagement=${aim.engagementId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.recovery.page.title'] })).toBeVisible();
    await expect(page.getByTestId('total-amount')).toHaveText('400.000.000');
    await expect(page.getByTestId('total-recovered')).toHaveText('0');
    await expect(page.getByTestId('no-lines')).toHaveText(vi['aud.recovery.ledger.none']);

    // A sum above what is left on the recommendation is refused before it is sent.
    const row = page.locator('tr[data-recommendation-id]').filter({ hasText: aim.recommendationCode });
    await row.getByRole('button', { name: vi['aud.recovery.link.action'] }).click();
    const link = page.getByRole('dialog');
    await link.getByLabel(vi['aud.recovery.link.source.label'], { exact: true }).selectOption('TREASURY_REMITTANCE');
    await link.getByLabel(vi['aud.recovery.link.amount.label'], { exact: true }).fill('400.000.001');
    await link.getByLabel(vi['aud.recovery.link.evidence.label'], { exact: true }).fill(randomUUID());
    await link.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(link.getByText(vi['aud.formProblem.exceeds'])).toBeVisible();

    // A document that is not in force is refused in words by the server; the dialog and what was typed stay.
    await link.getByLabel(vi['aud.recovery.link.amount.label'], { exact: true }).fill('150.000.000');
    await link.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(link.getByTestId('refusal')).toHaveText(vi['aud.recoveryProblem.evidenceRequired']);
    expect(await recovered(aim.recommendationId)).toBe('0');

    await link.getByLabel(vi['aud.recovery.link.evidence.label'], { exact: true }).fill(aim.evidenceId);
    await link.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('total-recovered')).toHaveText('150.000.000');
    await expect(page.getByTestId('total-remaining')).toHaveText('250.000.000');
    await expect(page.getByTestId('rate-money')).toContainText('37,50%');
    await expect(page.locator('tr[data-link-id]')).toHaveCount(1);
    expect(await recovered(aim.recommendationId)).toBe('150000000');

    // The reversal leaves the line where it is and writes a line against it; the money goes back to what it was.
    await page.locator('tr[data-link-id]').getByRole('button', { name: vi['aud.recovery.reverse.action'] }).click();
    const reverse = page.getByRole('dialog');
    await reverse.getByLabel(vi['aud.recovery.reverse.reason.label'], { exact: true }).fill(REASON);
    await reverse.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('tr[data-link-id]')).toHaveCount(2);
    await expect(page.getByTestId('total-recovered')).toHaveText('0');
    await expect(page.locator('tr[data-link-id]').first()).toContainText(vi['aud.recovery.ledger.reversed']);
    const lines = await sql<{ amount: string }>('select amount_vnd::text as amount from machvon.audit_recovery_link where recommendation_id = $1 order by recorded_at, id', [aim.recommendationId]);
    expect(lines.map((line) => line.amount).sort()).toEqual(['-150000000', '150000000']);
    expect(await recovered(aim.recommendationId)).toBe('0');

    // The trail keeps ids and codes, not what the accountant wrote.
    const trail = await sql<{ diff: string }>("select safe_diff::text as diff from machvon.audit_event where action like 'aud.recovery_%' and resource_id::text = any(select id::text from machvon.audit_recovery_link where recommendation_id = $1)", [aim.recommendationId]);
    expect(trail.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(trail)).not.toContain(REASON);
  });

  test('a reader sees the ledger, the rates with their numerators and denominators, and the overview, and has no button that records or reverses (UI-AUD-08, UI-AUD-01)', async ({ page }) => {
    const aim = await seed();
    await sql(
      `insert into machvon.audit_recovery_link (tenant_id, id, recommendation_id, source_kind, source_id, amount_vnd, recorded_on, evidence_document_id, recorded_by)
       select tenant_id, gen_random_uuid(), id, 'TREASURY_REMITTANCE', null, 100000000, date '2026-10-21', $2::uuid, $3::uuid from machvon.audit_recommendation where id = $1`,
      [aim.recommendationId, aim.evidenceId, membershipOf('audOfficer')],
    );
    await open(page, 'audReader', `/aud/aud-08?engagement=${aim.engagementId}`);
    await expect(page.getByTestId('total-recovered')).toHaveText('100.000.000');
    await expect(page.getByTestId('rate-money')).toContainText('25,00%');
    await expect(page.getByTestId('rate-money')).toContainText('100.000.000');
    await expect(page.getByTestId('rate-money')).toContainText('400.000.000');
    await expect(page.locator('tr[data-link-id]')).toContainText(vi['aud.recoverySource.treasuryRemittance']);
    await expect(page.locator('[data-screen-id] button')).toHaveCount(0);

    await open(page, 'audReader', '/aud/aud-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.overview.page.title'] })).toBeVisible();
    await expect(page.getByTestId('tiles')).toBeVisible();
    const watched = page.locator('tr[data-engagement-id]').filter({ hasText: aim.engagementCode });
    await expect(watched).toContainText('100.000.000');
    await expect(watched.getByRole('link', { name: vi['aud.overview.watch.recovery.link'] })).toHaveAttribute('href', `/aud/aud-08?engagement=${aim.engagementId}`);
  });
});
