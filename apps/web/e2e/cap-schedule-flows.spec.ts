import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CAP-08 (monthly disbursement registration) in a real browser against the real API and database (apps/api/test/e2e-stack): the investor registers
 * 800 million for October, the Treasury's payment of 300 million is read beside it as a rate of 37,50 %, and the registration is never added to what
 * was paid; registering again makes the next revision and keeps the old one; a programme amount above the amount is refused before it is sent, a
 * locked month by the server; someone who may not register has no form; and a planner of one unit sees only the projects of that unit. What the
 * screen changed is looked up in the database.
 */

const TENANT = stackInfo().tenants.A;
const MILLION = 1_000_000;
const millions = (n: number): string => String(n * MILLION);
const unitOf = (code: string): string => stackInfo().units.A[code] as string;
/** The decision document the stack seeds in tenant A (apps/api/test/e2e-stack): 1. */
const DOCUMENT = '00000000-0000-4000-005d-000000000001';

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function seedProject(label: string, unit = 'CB-SKHDT-QLDA'): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = `E2E-SC-${label}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
    [TENANT, id, code, `Dự án thử ${label}`, unitOf(unit), area?.id, String(9100000 + (Number.parseInt(id.slice(0, 6), 16) % 800000)), membershipOf('owner')],
  );
  return { id, code };
}

interface Funded {
  projectId: string;
  projectCode: string;
  appropriationId: string;
  lineId: string;
}

/** A project with a line of a published plan, its balance and the ALLOCATE entry that explains it: the payments of the Treasury hang on that line. */
async function seedFunded(label: string, year: number): Promise<Funded> {
  const project = await seedProject(label);
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
    [TENANT, planId, `E2E-SC-${label}`, year, unitOf('CB-STC'), membershipOf('planSubmitter'), membershipOf('planApprover'), DOCUMENT, membershipOf('planPublisher')],
  );
  const versionId = randomUUID();
  const lineId = randomUUID();
  await sql(
    `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, decision_id, effective_at, created_by, updated_by)
     values ($1, $2, $3, $4, 1, 'PUBLISHED', $5, $6, '2026-01-15T00:00:00Z', $7, $7)`,
    [TENANT, versionId, project.id, year, planId, DOCUMENT, membershipOf('planSubmitter')],
  );
  await sql(
    `insert into machvon.allocation_line
       (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, created_by, updated_by)
     values ($1, $2, $3, $4, 'CURRENT_YEAR', $5, $6::numeric, 0, $7, $8, 'CENTRAL', 'PM_ASSIGNED', $9, $9)`,
    [TENANT, lineId, versionId, fund?.id, year, millions(1_000), appropriationId, project.id, membershipOf('planSubmitter')],
  );
  await sql('insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd, disbursed_vnd) values ($1, $2, $3, $4::numeric, 0, 0, 0)', [TENANT, randomUUID(), lineId, millions(1_000)]);
  await sql(
    `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
     values ($1, $2, $3, $4, $5, 'ALLOCATE', $6::numeric, $7, 'CAPITAL_PLAN', $8, $9)`,
    [TENANT, randomUUID(), appropriationId, lineId, project.id, millions(1_000), year, planId, membershipOf('planPublisher')],
  );
  return { projectId: project.id, projectCode: project.code, appropriationId, lineId };
}

/** What the Treasury paid: a DISBURSE entry of the ledger, posted in the given month of the year at midday in Vietnam. */
async function seedPayment(target: Funded, year: number, month: number, amount: string): Promise<void> {
  await sql(
    `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_at, posted_by)
     values ($1, $2, $3, $4, $5, 'DISBURSE', $6::numeric, $7, 'PAYMENT_REQUEST', $8, $9::timestamptz, $10)`,
    [TENANT, randomUUID(), target.appropriationId, target.lineId, target.projectId, amount, year, randomUUID(), `${year}-${String(month).padStart(2, '0')}-15T05:00:00Z`, membershipOf('planPublisher')],
  );
}

const rowsOf = (projectId: string) =>
  sql<{ revision: number; is_current: boolean; amount: string; month: number; bucket: string; budget_level: string; subset: string | null }>(
    'select revision, is_current, amount_vnd::text as amount, month, bucket, budget_level, ctmtqg_subset_vnd::text as subset from machvon.disbursement_schedule_line where project_id = $1 order by month, bucket, budget_level, revision',
    [projectId],
  );
const ledgerCount = async (): Promise<number> => Number((await sql<{ n: string }>('select count(*)::text as n from machvon.capital_ledger_entry'))[0]?.n);

const monthRow = (page: Page, month: number) => page.locator(`tr[data-month="${month}"]`);
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const setYear = async (page: Page, year: number): Promise<void> => {
  await field(page, vi['cap.schedule.year.label']).fill(String(year));
  await expect(page.getByTestId('grid')).toHaveAttribute('data-year', String(year));
};

test.describe('CAP-08 monthly disbursement registration', () => {
  test('the investor registers October, the Treasury paid 300 of 800 million (37,50 %), registering again makes the next revision, and the registration is never money paid (AC-ST-CAP-009-1)', async ({ page }) => {
    const year = 2051;
    const target = await seedFunded('REG', year);
    await open(page, 'scheduleInvestor', `/cap/cap-08?project=${target.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.schedule.page.title'] })).toBeVisible();
    await setYear(page, year);
    await expect(page.getByTestId('no-registration')).toHaveText(vi['cap.schedule.empty.notice']);
    await expect(page.getByTestId('promise')).toHaveText(vi['cap.schedule.note.promise.notice']);

    // The programme amount may not be above the amount: refused before anything is sent.
    const before = await ledgerCount();
    await field(page, vi['cap.schedule.month.field.label']).selectOption('10');
    await field(page, vi['cap.schedule.amount.label']).fill('800');
    await field(page, vi['cap.schedule.ctmtqg.label']).fill('801');
    await page.getByRole('button', { name: vi['cap.schedule.save.action'] }).click();
    await expect(page.getByText(vi['cap.schedule.ctmtqg.exceeds.error'])).toBeVisible();
    expect(await rowsOf(target.projectId)).toEqual([]);

    await field(page, vi['cap.schedule.ctmtqg.label']).fill('100');
    await page.getByRole('button', { name: vi['cap.schedule.save.action'] }).click();
    await expect(page.getByTestId('saved')).toHaveText('Đã đăng ký, phiên bản 1.');
    expect(await rowsOf(target.projectId)).toEqual([{ revision: 1, is_current: true, amount: millions(800), month: 10, bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', subset: millions(100) }]);
    await expect(monthRow(page, 10).getByTestId('registered').locator('.cap-money')).toHaveAttribute('data-vnd', millions(800));
    await expect(monthRow(page, 10).getByTestId('rate')).toHaveAttribute('data-rate', '0.0000');

    // The Treasury pays 300 million in October: 300 of 800 is 37,50 %, and the 800 stay registered.
    await seedPayment(target, year, 10, millions(300));
    await page.reload();
    await setYear(page, year);
    await expect(monthRow(page, 10).getByTestId('rate')).toHaveAttribute('data-rate', '0.3750');
    await expect(monthRow(page, 10).getByTestId('rate')).toHaveText(/37,50\s?%/);
    await expect(monthRow(page, 10).getByTestId('disbursed').locator('.cap-money')).toHaveAttribute('data-vnd', millions(300));
    await expect(monthRow(page, 10).getByTestId('registered').locator('.cap-money')).toHaveAttribute('data-vnd', millions(800));
    await expect(monthRow(page, 3).getByTestId('rate')).toHaveText(vi['cap.schedule.rate.none.label']);
    // A registration is a promise: it wrote nothing to the ledger (the one entry added is the payment seeded above) and the balance did not move.
    expect(await ledgerCount()).toBe(before + 1);
    expect((await sql<{ disbursed: string }>('select disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1', [target.lineId]))[0]?.disbursed).toBe('0');

    // Registering the month again shows what is registered, and the next save is revision 2: the old row stays but is no longer current.
    await field(page, vi['cap.schedule.month.field.label']).selectOption('10');
    await expect(page.getByTestId('current')).toContainText('800');
    await field(page, vi['cap.schedule.amount.label']).fill('900');
    await field(page, vi['cap.schedule.reason.label']).fill('Đã ký phụ lục hợp đồng');
    await page.getByRole('button', { name: vi['cap.schedule.save.action'] }).click();
    await expect(page.getByTestId('saved')).toHaveText('Đã đăng ký, phiên bản 2.');
    await expect(monthRow(page, 10).getByTestId('registered').locator('.cap-money')).toHaveAttribute('data-vnd', millions(900));
    expect((await rowsOf(target.projectId)).map((row) => [row.revision, row.is_current, row.amount])).toEqual([
      [1, false, millions(800)],
      [2, true, millions(900)],
    ]);
    await expect(sql("select 1 from machvon.audit_event where action = 'capital.schedule_registered' and reason = 'Đã ký phụ lục hợp đồng' and resource_id = (select id from machvon.disbursement_schedule_line where project_id = $1 and revision = 2)", [target.projectId])).resolves.toHaveLength(1);
    await expect(page.getByTestId('total-registered').locator('.cap-money')).toHaveAttribute('data-vnd', millions(900));
  });

  test('a locked month is refused by the server and nothing is written; the other months of the year still take a registration (AC-ST-CAP-009-2)', async ({ page }) => {
    const year = 2052;
    const target = await seedFunded('LOCK', year);
    const [calendar] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'CALENDAR' limit 1", [TENANT]);
    await sql(
      `insert into machvon.reporting_period
         (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, soft_closed_at, locked_at, locked_by, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'E2E-SCHEDULE', 'MONTH', $6, 'LOCKED', now(), now(), $7, $8, $7, $7)`,
      [TENANT, randomUUID(), `E2E-M-${year}-08`, `${year}-08-01`, `${year}-08-31`, year, membershipOf('owner'), calendar?.id],
    );
    await open(page, 'scheduleInvestor', `/cap/cap-08?project=${target.projectId}`);
    await setYear(page, year);
    await field(page, vi['cap.schedule.month.field.label']).selectOption('8');
    await field(page, vi['cap.schedule.amount.label']).fill('50');
    await page.getByRole('button', { name: vi['cap.schedule.save.action'] }).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.schedule.periodLocked.error']);
    expect(await rowsOf(target.projectId)).toEqual([]);
    await field(page, vi['cap.schedule.month.field.label']).selectOption('9');
    await page.getByRole('button', { name: vi['cap.schedule.save.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    expect((await rowsOf(target.projectId)).map((row) => row.month)).toEqual([9]);
  });

  test('someone who may not register sees the schedule and no form; a planner of one unit is offered the projects of that unit only', async ({ page }) => {
    const year = 2053;
    const inside = await seedFunded('IN', year);
    const outside = await seedProject('OUT', 'CB-SKHDT-VP');
    await open(page, 'planPlanner', `/cap/cap-08?project=${inside.projectId}`);
    await setYear(page, year);
    await expect(page.getByTestId('register-denied')).toHaveText(vi['cap.schedule.denied.notice']);
    await expect(page.getByRole('button', { name: vi['cap.schedule.save.action'] })).toHaveCount(0);

    await open(page, 'scheduleScoped', '/cap/cap-08');
    const options = field(page, vi['cap.schedule.project.label']).locator('option');
    await expect(options.filter({ hasText: inside.projectCode })).toHaveCount(1);
    await expect(options.filter({ hasText: outside.code })).toHaveCount(0);
    await open(page, 'scheduleScoped', `/cap/cap-08?project=${inside.projectId}`);
    await setYear(page, year);
    await field(page, vi['cap.schedule.month.field.label']).selectOption('2');
    await field(page, vi['cap.schedule.amount.label']).fill('10');
    await page.getByRole('button', { name: vi['cap.schedule.save.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    expect((await rowsOf(inside.projectId)).map((row) => row.month)).toEqual([2]);
    expect(await rowsOf(outside.id)).toEqual([]);
  });
});
