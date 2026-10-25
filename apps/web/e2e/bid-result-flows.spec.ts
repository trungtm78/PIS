import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * BID-18 (approve the result of the selection) in a real browser against the real API and database (apps/api/test/e2e-stack): the proposer submits the result of a package of 18 billion
 * and is refused 18.5 billion and a winner under a restriction; the authority, who did not submit it, approves it on the decision document, the package is awarded and the event the
 * contracts read is written; someone who only reads sees the results and no button. The decision is a person's: the screen says so and offers nothing a machine made.
 */

const OWNER_UNIT = 'CB-SKHDT-QLDA';
const BUDGET = '18000000000';

interface Seeded {
  packageId: string;
  code: string;
  winner: string;
  winnerName: string;
  barred: string;
  barredName: string;
  minutes: string;
  decision: string;
}

async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const proposer = membershipOf('resultProposer');
  const projectId = randomUUID();
  const packageId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${packageId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, `E2E-RST-${suffix}`, `Dự án kết quả lựa chọn ${suffix}`, stackInfo().units.A[OWNER_UNIT], area?.id, proposer],
  );
  const code = `GT-RST-${suffix}`;
  await sql(
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
     values ($1, $2, $3, $4, $7::numeric, 'OPEN_BIDDING', 1, 'APPROVED', $5, $6, 1)`,
    [tenant, packageId, projectId, code, `Gói thầu xây lắp ${suffix}`, proposer, BUDGET],
  );
  const profile = randomUUID();
  await sql(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'ATTACHMENT', 'E2E-PROFILE', 'Hồ sơ năng lực', 'INTERNAL', $3, $3)`, [tenant, profile, proposer]);
  const contractor = async (name: string, restricted: boolean): Promise<string> => {
    const id = randomUUID();
    await sql(`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, $3, $4, 'VERIFIED', $5)`, [
      tenant,
      id,
      String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)),
      name,
      profile,
    ]);
    if (restricted) {
      await sql(
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, decision_document_id, created_by, updated_by)
         values ($1, $2, $3, 'DEBARMENT', 'DECISION', date '2020-01-01', $4, $5, $5)`,
        [tenant, randomUUID(), id, profile, proposer],
      );
    }
    return id;
  };
  const winnerName = `Công ty trúng thầu ${suffix}`;
  const barredName = `Công ty bị cấm thầu ${suffix}`;
  const winner = await contractor(winnerName, false);
  const barred = await contractor(barredName, true);
  const minutes = randomUUID();
  const decision = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, effect_status, symbol, issued_on, created_by, updated_by) values
       ($1, $2, 'REFERENCE', 'BB-DG', $4, 'INTERNAL', 'EFFECTIVE', 'BB-01', date '2026-10-01', $6, $6),
       ($1, $3, 'REFERENCE', 'QD', $5, 'INTERNAL', 'EFFECTIVE', 'KQ-01', date '2026-10-20', $6, $6)`,
    [tenant, minutes, decision, `Biên bản đánh giá ${suffix}`, `Quyết định KQ-01 ${suffix}`, proposer],
  );
  return { packageId, code, winner, winnerName, barred, barredName, minutes, decision };
}

async function open(page: Page, user: string, seeded: Seeded): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/bid/bid-18?package=${seeded.packageId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const resultOf = async (packageId: string) => {
  const [row] = await sql<{ id: string; status: string; award_price_vnd: string | null; decision_document_id: string | null; approved_by: string | null }>(
    'select id, status, award_price_vnd::text, decision_document_id, approved_by from machvon.procurement_result where package_id = $1 order by created_at desc limit 1',
    [packageId],
  );
  return row;
};
const packageStatus = async (packageId: string) => (await sql<{ status: string }>('select status from machvon.procurement_package where id = $1', [packageId]))[0]?.status;

test.describe('BID-18: approve the result of the selection', () => {
  test('the proposer submits the result at the price of the package or below, a person with the authority approves it, and the package is awarded (AC-ST-BID-006-1, UAT-AC455, UI-BID-18)', async ({ page }) => {
    const seeded = await seed();
    await open(page, 'resultProposer', seeded);
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.results.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-ai')).toHaveText(vi['bid.results.noAi.notice']);
    await expect(page.getByTestId('no-results')).toHaveText(vi['bid.results.none.notice']);

    await page.getByRole('button', { name: vi['bid.results.submit.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: vi['bid.results.submit.action'] }).click();
    await expect(dialog.getByText(vi['bid.results.problem.required']).first()).toBeVisible();
    await dialog.locator('#result-outcome').selectOption('AWARDED');
    await dialog.locator('#result-winner').selectOption({ label: seeded.winnerName });
    await dialog.locator('#result-minutes').fill(seeded.minutes);
    // 18.5 billion against a package of 18: the server refuses, in words, and nothing is stored.
    await dialog.locator('#result-price').fill('18500000000');
    await dialog.getByRole('button', { name: vi['bid.results.submit.action'] }).click();
    await expect(dialog.getByTestId('refusal')).toHaveText(vi['bid.results.error.priceExceeds']);
    expect(await resultOf(seeded.packageId)).toBeUndefined();

    await dialog.locator('#result-price').fill('17650000000');
    await dialog.getByRole('button', { name: vi['bid.results.submit.action'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['bid.results.status.submitted']);
    await expect(page.getByTestId('winner')).toHaveText(seeded.winnerName);
    await expect(page.getByTestId('price')).toContainText('17.650.000.000');
    await expect(page.locator('[data-decide]')).toHaveCount(0);
    expect(await resultOf(seeded.packageId)).toMatchObject({ status: 'SUBMITTED', award_price_vnd: '17650000000' });

    // The authority approves it on the decision document; the proposer's own result is not theirs to decide.
    await open(page, 'resultAuthority', seeded);
    await page.locator('[data-decide]').click();
    const decide = page.getByRole('dialog');
    await decide.getByRole('button', { name: vi['bid.results.decide.approve'] }).click();
    await expect(decide.getByText(vi['bid.results.problem.required'])).toBeVisible();
    await decide.locator('input[data-decision="APPROVE"]').check();
    await decide.locator('#result-document').fill(seeded.decision);
    await decide.locator('#result-comment').fill('KQ-01');
    await decide.getByRole('button', { name: vi['bid.results.decide.approve'] }).click();
    await expect(page.getByTestId('status')).toHaveText(vi['bid.results.status.approved']);
    await expect(page.locator('[data-decide]')).toHaveCount(0);
    expect(await resultOf(seeded.packageId)).toMatchObject({ status: 'APPROVED', decision_document_id: seeded.decision, approved_by: membershipOf('resultAuthority') });
    expect(await packageStatus(seeded.packageId)).toBe('AWARDED');
    const result = await resultOf(seeded.packageId);
    const events = await sql<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'bid.result.approved.v1'", [result?.id]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ package_id: seeded.packageId, contractor_id: seeded.winner, award_price_vnd: '17650000000', decision_document_id: seeded.decision });
  });

  test('a winner under a restriction is refused (AC-ST-BID-006-2, UAT-AC446, UI-BID-18)', async ({ page }) => {
    const seeded = await seed();
    await open(page, 'resultProposer', seeded);
    await page.getByRole('button', { name: vi['bid.results.submit.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#result-outcome').selectOption('AWARDED');
    await dialog.locator('#result-winner').selectOption({ label: seeded.barredName });
    await dialog.locator('#result-price').fill('17000000000');
    await dialog.locator('#result-minutes').fill(seeded.minutes);
    await dialog.getByRole('button', { name: vi['bid.results.submit.action'] }).click();
    await expect(dialog.getByTestId('refusal')).toHaveText(vi['bid.results.error.restricted']);
    expect(await resultOf(seeded.packageId)).toBeUndefined();
    expect(await packageStatus(seeded.packageId)).toBe('APPROVED');
  });

  test('someone who only reads sees the results and no button (UI-BID-18)', async ({ page }) => {
    const seeded = await seed();
    await sql(
      `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, evaluation_minutes_document_id, outcome, status, submitted_by, submitted_at, created_by, updated_by, version)
       values ($1, $2, $3, $4, 17000000000, $5, 'AWARDED', 'SUBMITTED', $6, now(), $6, $6, 1)`,
      [stackInfo().tenants.A, randomUUID(), seeded.packageId, seeded.winner, seeded.minutes, membershipOf('resultProposer')],
    );
    await open(page, 'resultReader', seeded);
    await expect(page.getByTestId('status')).toHaveText(vi['bid.results.status.submitted']);
    await expect(page.locator('[data-decide]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['bid.results.submit.action'] })).toHaveCount(0);
  });
});
