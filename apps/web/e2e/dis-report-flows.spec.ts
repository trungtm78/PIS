import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * DIS-01, DIS-02, DIS-04 and DIS-18 (the weekly report of the disbursement) in a real browser against the real API and database (apps/api/test/e2e-stack): a maker draws the draft of a project
 * for an open week, enters the six cells of FX-DIS-001 (100, 200, 30, 70, 0 and 20 million, and 40 million of the first as CTMTQG) and sees them add up to 420 million with the CTMTQG apart,
 * is refused a CTMTQG that is more than its cell, saves the draft and lands on DIS-18; a second draft of the same project and week is refused with a way to the first; a reader finds the report
 * in the list and cannot change it. What the screens changed is looked up in the database.
 */

const YEAR = 2041;
const PERIOD_ID = randomUUID();
const PERIOD_CODE = `${YEAR}-W01`;
const PROJECT_ID = randomUUID();
const PROJECT_CODE = 'E2E-RPT-001';
const PROJECT_NAME = 'Dự án cầu qua sông báo cáo tuần';
const PLAN_ID = randomUUID();

const CELLS: Array<{ key: string; amount: string }> = [
  { key: 'CURRENT_YEAR:CENTRAL', amount: '100.000.000' },
  { key: 'CURRENT_YEAR:LOCAL', amount: '200.000.000' },
  { key: 'CARRYOVER:CENTRAL', amount: '30.000.000' },
  { key: 'CARRYOVER:LOCAL', amount: '70.000.000' },
  { key: 'OTHER:CENTRAL', amount: '0' },
  { key: 'OTHER:LOCAL', amount: '20.000.000' },
];

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface ReportRow {
  id: string;
  status: string;
  revision: number;
  version: string;
  is_current: boolean;
}

const reportsOf = (): Promise<ReportRow[]> =>
  sql<ReportRow>('select id, status, revision, version::text as version, is_current from machvon.report_revision where project_id = $1 and period_id = $2 order by revision', [PROJECT_ID, PERIOD_ID]);

const linesOf = async (reportId: string): Promise<Array<{ cell: string; cumulative: string; ctmtqg: string | null }>> =>
  sql<{ cell: string; cumulative: string; ctmtqg: string | null }>(
    'select bucket || \':\' || budget_level as cell, disbursed_cumulative_vnd::text as cumulative, ctmtqg_subset_vnd::text as ctmtqg from machvon.funding_snapshot_line where report_revision_id = $1 order by bucket, budget_level',
    [reportId],
  );

const countOf = async (action: string, id: string): Promise<number> => (await sql<{ n: number }>('select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = $2', [id, action]))[0]?.n ?? 0;

const cell = (page: Page, key: string): Locator => page.locator(`[id="cell-${key}"]`);
const ctmtqg = (page: Page, key: string): Locator => page.locator(`[id="ctmtqg-${key}"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const tenantId = stackInfo().tenants.A;
  const owner = membershipOf('owner');
  const ownerUnit = stackInfo().units.A['CB-SKHDT-QLDA'];
  const [calendar] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'CALENDAR' limit 1", [tenantId]);
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantId]);
  await sql(
    `insert into machvon.reporting_period
       (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
     values ($1, $2, $3, 1, date '${YEAR}-01-04', date '${YEAR}-01-10', timestamptz '${YEAR}-01-10T03:00:00Z', 'E2E-REPORT', 'WEEK', ${YEAR}, 'OPEN', $4, $5, $5)`,
    [tenantId, PERIOD_ID, PERIOD_CODE, calendar?.id, owner],
  );
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
    [tenantId, PROJECT_ID, PROJECT_CODE, PROJECT_NAME, ownerUnit, area?.id],
  );
  // The plan belongs to the capital module and the decision to DOC: the superuser seeds it with the foreign keys switched off, as the tests of the API do.
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
       values ($1, $2, $3, ${YEAR}, 1, $4, 'PUBLISHED', timestamptz '${YEAR - 1}-12-20T01:00:00Z')`,
      [tenantId, PLAN_ID, PROJECT_ID, randomUUID()],
    );
    await client.query(
      `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level)
       values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', ${YEAR}, 500000000, 0, $4, 'CENTRAL')`,
      [tenantId, PLAN_ID, area?.id, PROJECT_ID],
    );
  } finally {
    await client.end();
  }
});

test.afterAll(async () => {
  // The rows of this flow leave nothing behind for the other flows (the calendar of DIS-14, the register of PRJ-01).
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query('delete from machvon.report_revision where project_id = $1', [PROJECT_ID]);
    await client.query('delete from machvon.allocation_line where plan_version_id = $1', [PLAN_ID]);
    await client.query('delete from machvon.plan_version where id = $1', [PLAN_ID]);
    await client.query('delete from machvon.reporting_period where id = $1', [PERIOD_ID]);
    await client.query('delete from machvon.project where id = $1', [PROJECT_ID]);
  } finally {
    await client.end();
  }
});

test.describe('DIS-01, DIS-02, DIS-04, DIS-18 weekly report of the disbursement', () => {
  test('a maker draws the draft of a project for an open week, enters FX-DIS-001, is refused a CTMTQG above its cell, and saves (AC-ST-DIS-003-1, AC-ST-DIS-003-2, UAT-AC240)', async ({ page }) => {
    await open(page, 'reportMaker', '/dis/dis-02');
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.reportCreate.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['dis.reportCreate.submit.action'] }).click();
    await expect(page.getByText(vi['dis.reportCreate.period.required'])).toBeVisible();
    expect(await reportsOf()).toEqual([]);

    await page.getByLabel(vi['dis.reportCreate.year.label'], { exact: true }).selectOption(String(YEAR));
    await page.getByLabel(vi['dis.reportCreate.period.label'], { exact: true }).selectOption(PERIOD_ID);
    await page.getByLabel(vi['dis.reportCreate.project.label'], { exact: true }).selectOption(PROJECT_ID);
    await page.getByRole('button', { name: vi['dis.reportCreate.submit.action'] }).click();
    await expect(page).toHaveURL(/\/dis\/dis-04\?report=/);
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.reportEdit.page.title'] })).toBeVisible();
    const [drawn] = await reportsOf();
    expect(drawn).toMatchObject({ status: 'DRAFT', revision: 1 });
    const reportId = drawn?.id ?? '';
    expect(await countOf('dis.report_created', reportId)).toBe(1);
    // The plan allocated 500 million to the year plan of the central budget, and nothing to the others.
    await expect(page.getByTestId('allocated-CURRENT_YEAR:CENTRAL')).toHaveText('500.000.000');
    await expect(page.getByTestId('allocated-OTHER:LOCAL')).toHaveText('0');

    for (const { key, amount } of CELLS) await cell(page, key).fill(amount);
    await ctmtqg(page, 'CURRENT_YEAR:CENTRAL').fill('120.000.000');
    await page.getByRole('button', { name: vi['dis.reportEdit.save.action'] }).click();
    await expect(page.getByText(vi['dis.reportProblem.cell.exceeds'])).toBeVisible();
    await expect(ctmtqg(page, 'CURRENT_YEAR:CENTRAL')).toHaveAttribute('aria-invalid', 'true');
    // The draft was drawn with its six cells at nothing, and the refused save changed none of them.
    expect((await linesOf(reportId)).map((line) => line.cumulative)).toEqual(['0', '0', '0', '0', '0', '0']);
    expect(await countOf('dis.report_saved', reportId)).toBe(0);

    await ctmtqg(page, 'CURRENT_YEAR:CENTRAL').fill('40.000.000');
    await expect(page.getByTestId('total-cumulative')).toHaveText('420.000.000');
    await expect(page.getByTestId('total-ctmtqg')).toHaveText('40.000.000');
    await page.getByRole('button', { name: vi['dis.reportEdit.save.action'] }).click();
    await expect(page).toHaveURL(/\/dis\/dis-18\?report=/);
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.reportSaved.page.title'] })).toBeFocused();
    await expect(page.getByTestId('saved-code')).toHaveText(`${PROJECT_CODE}/${PERIOD_CODE}/r1`);
    await expect(page.getByTestId('saved-total')).toHaveText(vi['dis.reportSaved.total.value'].replace('{amount}', '420.000.000').replace('{ctmtqg}', '40.000.000'));

    expect(await linesOf(reportId)).toEqual([
      { cell: 'CARRYOVER:CENTRAL', cumulative: '30000000', ctmtqg: null },
      { cell: 'CARRYOVER:LOCAL', cumulative: '70000000', ctmtqg: null },
      { cell: 'CURRENT_YEAR:CENTRAL', cumulative: '100000000', ctmtqg: '40000000' },
      { cell: 'CURRENT_YEAR:LOCAL', cumulative: '200000000', ctmtqg: null },
      { cell: 'OTHER:CENTRAL', cumulative: '0', ctmtqg: null },
      { cell: 'OTHER:LOCAL', cumulative: '20000000', ctmtqg: null },
    ]);
    expect((await reportsOf())[0]).toMatchObject({ status: 'DRAFT', version: '2' });
    expect(await countOf('dis.report_saved', reportId)).toBe(1);

    // The saved draft opens again with the cells as they were saved.
    await page.getByRole('link', { name: vi['dis.reportSaved.continue.link'] }).click();
    await expect(cell(page, 'CURRENT_YEAR:LOCAL')).toHaveValue('200.000.000');
    await expect(ctmtqg(page, 'CURRENT_YEAR:CENTRAL')).toHaveValue('40.000.000');
  });

  test('a second draft of the same project and week is refused, with a way to the first (AC-ST-DIS-003-3, UAT-PLAN-67)', async ({ page }) => {
    const [first] = await reportsOf();
    await open(page, 'reportMaker', '/dis/dis-02');
    await page.getByLabel(vi['dis.reportCreate.year.label'], { exact: true }).selectOption(String(YEAR));
    await page.getByLabel(vi['dis.reportCreate.period.label'], { exact: true }).selectOption(PERIOD_ID);
    await page.getByLabel(vi['dis.reportCreate.project.label'], { exact: true }).selectOption(PROJECT_ID);
    await page.getByRole('button', { name: vi['dis.reportCreate.submit.action'] }).click();
    const refusal = page.getByTestId('refusal');
    await expect(refusal).toContainText(vi['dis.reportProblem.draftExists']);
    await expect(refusal.getByRole('link', { name: vi['dis.reportCreate.existing.link'] })).toHaveAttribute('href', `/dis/dis-04?report=${first?.id}`);
    expect(await reportsOf()).toHaveLength(1);
  });

  test('a reader finds the report in the list with its figures and cannot change it or start another (AC-ST-DIS-003-4, UI-DIS-01)', async ({ page }) => {
    const [report] = await reportsOf();
    await open(page, 'reportReader', '/dis/dis-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.reports.page.title'] })).toBeVisible();
    await expect(page.getByRole('link', { name: vi['dis.reports.create.action'] })).toHaveCount(0);
    const row = page.getByRole('row').filter({ hasText: PROJECT_CODE });
    await expect(row).toContainText(PERIOD_CODE);
    await expect(row).toContainText(vi['dis.reportStatus.draft']);
    await expect(row).toContainText('420.000.000');
    await expect(row).toContainText('40.000.000');
    await expect(page.getByTestId('kpi-filtered-money')).toContainText('420.000.000');

    await row.getByRole('link', { name: vi['dis.reports.open.action'].replace('{code}', PROJECT_CODE) }).click();
    await expect(page).toHaveURL(new RegExp(`/dis/dis-04\\?report=${report?.id}`));
    await expect(page.getByTestId('readonly-note')).toBeVisible();
    await expect(cell(page, 'CURRENT_YEAR:CENTRAL')).toBeDisabled();
    await expect(page.getByRole('button', { name: vi['dis.reportEdit.save.action'] })).toHaveCount(0);
  });

  test('a maker sees the list with the button that starts a report', async ({ page }) => {
    await open(page, 'reportMaker', '/dis/dis-01');
    await expect(page.getByRole('link', { name: vi['dis.reports.create.action'] })).toHaveAttribute('href', '/dis/dis-02');
  });
});
