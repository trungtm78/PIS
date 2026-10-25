import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CAP-11 (the closing of a fiscal year) in a real browser against the real API and database (apps/api/test/e2e-stack): the officer soft-closes a year and locks it, and the 800 million
 * of the line that was neither carried over nor committed nor disbursed lapses as one LAPSE entry of the closing; a locked year is shown with the red banner; the officer who locked
 * it is refused its reopening and another officer reopens it for a window with a reason; a year with a plan waiting for a decision cannot be closed; a reader sees the years and
 * nothing to do. What the screen changed is looked up in the database.
 */

const TENANT = stackInfo().tenants.A;
const MILLION = 1_000_000;
const millions = (n: number): string => String(n * MILLION);
const unitOf = (code: string): string => stackInfo().units.A[code] as string;
/** The decision document the stack seeds in tenant A (apps/api/test/e2e-stack): 1. */
const DOCUMENT = '00000000-0000-4000-005d-000000000001';

async function open(page: Page, user: string, year: number): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.goto(`/cap/cap-11?devUser=${user}&year=${year}`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForSelector('.cap-year');
}

interface Funded {
  lineId: string;
  balanceId: string;
  appropriationId: string;
  projectId: string;
}

/** A project with a line of 1,000 million in a published plan of the year, 100 committed and 100 disbursed, with the ALLOCATE entry that explains it. */
async function seedFunded(label: string, year: number): Promise<Funded> {
  const projectId = randomUUID();
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
    [TENANT, projectId, `E2E-FY-${label}`, `Dự án khóa năm ${label}`, unitOf('CB-SKHDT-QLDA'), area?.id, String(9400000 + (Number.parseInt(projectId.slice(0, 6), 16) % 500000)), membershipOf('owner')],
  );
  const [fund] = await sql<{ id: string }>(
    "select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.tenant_id = $1 and v.master_type = 'FUND_SOURCE' and r.business_key = 'NSTW' and v.status = 'EFFECTIVE' limit 1",
    [TENANT],
  );
  const appropriationId = randomUUID();
  await sql(
    `insert into machvon.appropriation
       (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
     values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, $5::numeric, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
    [TENANT, appropriationId, fund?.id, year, millions(10_000), DOCUMENT, membershipOf('planApprover'), membershipOf('owner')],
  );
  const planId = randomUUID();
  await sql(
    `insert into machvon.capital_plan
       (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, submitted_by, approved_by, decision_document_id, effective_at, published_at, published_by, created_by, updated_by)
     values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, 1, 'PUBLISHED', $6, $7, $8, '2026-01-15T00:00:00Z', '2026-01-15T00:00:00Z', $9, $6, $6)`,
    [TENANT, planId, `E2E-FY-${label}`, year, unitOf('CB-STC'), membershipOf('planSubmitter'), membershipOf('planApprover'), DOCUMENT, membershipOf('planPublisher')],
  );
  const versionId = randomUUID();
  const lineId = randomUUID();
  await sql(
    `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, decision_id, effective_at, created_by, updated_by)
     values ($1, $2, $3, $4, 1, 'PUBLISHED', $5, $6, '2026-01-15T00:00:00Z', $7, $7)`,
    [TENANT, versionId, projectId, year, planId, DOCUMENT, membershipOf('planSubmitter')],
  );
  await sql(
    `insert into machvon.allocation_line
       (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, created_by, updated_by)
     values ($1, $2, $3, $4, 'CURRENT_YEAR', $5, $6::numeric, 0, $7, $8, 'CENTRAL', 'PM_ASSIGNED', $9, $9)`,
    [TENANT, lineId, versionId, fund?.id, year, millions(1_000), appropriationId, projectId, membershipOf('planSubmitter')],
  );
  const balanceId = randomUUID();
  await sql('insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd, disbursed_vnd) values ($1, $2, $3, $4::numeric, 0, $5::numeric, $6::numeric)', [
    TENANT,
    balanceId,
    lineId,
    millions(1_000),
    millions(100),
    millions(100),
  ]);
  await sql(
    `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
     values ($1, $2, $3, $4, $5, 'ALLOCATE', $6::numeric, $7, 'CAPITAL_PLAN', $8, $9)`,
    [TENANT, randomUUID(), appropriationId, lineId, projectId, millions(1_000), year, planId, membershipOf('planPublisher')],
  );
  return { lineId, balanceId, appropriationId, projectId };
}

const dialog = (page: Page) => page.getByRole('form', { name: vi['cap.year.dialog.aria'] });
const controlOf = async (year: number) =>
  (
    await sql<{ status: string; version: string; locked_by: string | null; reopen_approved_by: string | null; reopened_until: string | null; close_reason: string | null }>(
      'select status, version::text as version, locked_by, reopen_approved_by, reopened_until::text as reopened_until, close_reason from machvon.fiscal_year_control where plan_year = $1::integer',
      [year],
    )
  )[0];

async function close(page: Page, action: string, confirm: string, reason: string): Promise<void> {
  await page.getByRole('button', { name: action }).click();
  await dialog(page).getByLabel(vi['cap.year.field.reason'], { exact: true }).fill(reason);
  await dialog(page).getByRole('button', { name: confirm }).click();
}

test.describe('CAP-11: the closing of a fiscal year', () => {
  test('the officer soft-closes the year and locks it: the capital that was not carried over lapses and the year shows the red banner (AC-ST-CAP-008-1, UAT-AC230)', async ({ page }) => {
    const year = 2041;
    const target = await seedFunded('A', year);
    await open(page, 'yearCloser', year);
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.year.page.title'] })).toBeVisible();
    await expect(page.getByTestId('year-state')).toHaveAttribute('data-status', 'OPEN');

    await close(page, vi['cap.year.softClose.action'], vi['cap.year.dialog.confirm.softClose'], 'Hết năm, bắt đầu kỳ chỉnh lý');
    await expect(page.getByText(vi['cap.year.done.softClosed'].replace('{year}', String(year)))).toBeVisible();
    await expect(page.getByTestId('year-state')).toHaveAttribute('data-status', 'SOFT_CLOSED');
    await expect(page.getByTestId('year-soft')).toBeVisible();
    expect(await controlOf(year)).toMatchObject({ status: 'SOFT_CLOSED', version: '2' });

    await close(page, vi['cap.year.lock.action'], vi['cap.year.dialog.confirm.lock'], 'Hết kỳ chỉnh lý của năm');
    await expect(page.getByText(vi['cap.year.done.locked'].replace('{year}', String(year)))).toBeVisible();
    await expect(page.getByTestId('year-state')).toHaveAttribute('data-status', 'LOCKED');
    await expect(page.getByTestId('year-locked')).toHaveText(vi['cap.year.locked.banner'].replace('{year}', String(year)));
    expect(await controlOf(year)).toMatchObject({ status: 'LOCKED', version: '3', locked_by: membershipOf('yearCloser'), close_reason: 'Hết kỳ chỉnh lý của năm' });

    // 1,000 allocated, 100 committed and 100 disbursed: 800 million lapses, and what is committed and disbursed stays.
    const [balance] = await sql<{ allocated: string }>('select allocated_vnd::text as allocated from machvon.allocation_balance where id = $1::uuid', [target.balanceId]);
    expect(balance?.allocated).toBe(millions(200));
    const lapses = await sql<{ amount: string; kind: string }>("select amount_vnd::text as amount, source_ref_kind as kind from machvon.capital_ledger_entry where entry_type = 'LAPSE' and allocation_line_id = $1::uuid", [target.lineId]);
    expect(lapses).toEqual([{ amount: millions(800), kind: 'YEAR_CLOSE' }]);
    // The officer who closed holds no right to reopen: the screen offers the locked year nothing.
    await expect(page.getByRole('button', { name: vi['cap.year.reopen.action'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['cap.year.lock.action'] })).toHaveCount(0);
  });

  test('the person who locked the year is refused its reopening, and another officer reopens it for the window with a reason', async ({ page }) => {
    const year = 2043;
    await seedFunded('B', year);
    await open(page, 'yearSolo', year);
    await close(page, vi['cap.year.lock.action'], vi['cap.year.dialog.confirm.lock'], 'Khóa thẳng năm không qua kỳ chỉnh lý');
    await expect(page.getByTestId('year-locked')).toBeVisible();

    // The same person holds the right to reopen, and the server refuses them.
    await page.getByRole('button', { name: vi['cap.year.reopen.action'] }).click();
    await dialog(page).getByLabel(vi['cap.year.field.reason'], { exact: true }).fill('Kiểm toán phát hiện sai sót khi phân bổ vốn');
    await dialog(page).getByRole('button', { name: vi['cap.year.dialog.confirm.reopen'] }).click();
    await expect(page.getByText(vi['cap.year.problem.selfApproval'])).toBeVisible();
    expect((await controlOf(year))?.status).toBe('LOCKED');

    // Another officer: the reason and the window are checked before anything is sent.
    await open(page, 'yearReopener', year);
    await page.getByRole('button', { name: vi['cap.year.reopen.action'] }).click();
    await dialog(page).getByLabel(vi['cap.year.field.reason'], { exact: true }).fill('ngắn quá');
    await dialog(page).getByLabel(vi['cap.year.field.hours'], { exact: true }).fill('200');
    await dialog(page).getByRole('button', { name: vi['cap.year.dialog.confirm.reopen'] }).click();
    await expect(dialog(page).getByText(vi['cap.year.fieldError.reopenReason'])).toBeVisible();
    await expect(dialog(page).getByText(vi['cap.year.fieldError.hours'])).toBeVisible();
    await dialog(page).getByLabel(vi['cap.year.field.reason'], { exact: true }).fill('Kiểm toán phát hiện sai sót khi phân bổ vốn');
    await dialog(page).getByLabel(vi['cap.year.field.hours'], { exact: true }).fill('24');
    await dialog(page).getByRole('button', { name: vi['cap.year.dialog.confirm.reopen'] }).click();
    await expect(page.getByText(vi['cap.year.done.reopened'].replace('{year}', String(year)))).toBeVisible();
    await expect(page.getByTestId('year-state')).toHaveAttribute('data-status', 'OPEN');
    await expect(page.getByTestId('year-locked')).toHaveCount(0);
    const control = await controlOf(year);
    expect(control).toMatchObject({ status: 'OPEN', reopen_approved_by: membershipOf('yearReopener') });
    expect(Date.parse(control?.reopened_until as string)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  test('a year with a plan waiting for a decision cannot be closed, and the screen says how many (AC-ST-CAP-008-2, UAT-PLAN-62)', async ({ page }) => {
    const year = 2045;
    await sql(
      `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, submitted_by, created_by, updated_by)
       values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, 1, 'IN_REVIEW', $6, $6, $6)`,
      [TENANT, randomUUID(), `E2E-FY-REVIEW-${year}`, year, unitOf('CB-STC'), membershipOf('planSubmitter')],
    );
    await open(page, 'yearCloser', year);
    await close(page, vi['cap.year.lock.action'], vi['cap.year.dialog.confirm.lock'], 'Hết kỳ chỉnh lý của năm');
    await expect(page.getByText(vi['cap.year.problem.plansPending'].replace('{count}', '1'))).toBeVisible();
    expect((await controlOf(year))?.status).not.toBe('LOCKED');
    await expect(page.getByTestId('year-state')).toHaveAttribute('data-status', 'OPEN');
  });

  test('a reader sees the years and nothing to do', async ({ page }) => {
    const year = 2047;
    await seedFunded('C', year);
    await open(page, 'yearCloser', year);
    await close(page, vi['cap.year.softClose.action'], vi['cap.year.dialog.confirm.softClose'], 'Hết năm, bắt đầu kỳ chỉnh lý');
    await expect(page.getByTestId('year-state')).toHaveAttribute('data-status', 'SOFT_CLOSED');
    await open(page, 'yearReader', year);
    await expect(page.getByTestId('year-state')).toHaveAttribute('data-status', 'SOFT_CLOSED');
    await expect(page.locator('tr[data-year="2047"]')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['cap.year.softClose.action'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['cap.year.lock.action'] })).toHaveCount(0);
  });
});
