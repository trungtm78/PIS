import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * DIS-03, DIS-05 and DIS-06 (the volumes, the registration for next month, the review with the notes and the files of the weekly report) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): a maker enters the four volumes and the basis, the six cells and the registration of 300 million with 100 million of CTMTQG, sees the review tell a volume of 203.8% of
 * the capital allocated as a warning that does not block and the missing volumes as an error that does, writes the notes, attaches a clean file and is refused an infected one and one that is not
 * what it says. A reader sees the review and has nothing to type in. What the screens changed is looked up in the database.
 */

const YEAR = 2042;
const PERIOD_ID = randomUUID();
const PERIOD_CODE = `${YEAR}-W01`;
const PROJECT_ID = randomUUID();
const PROJECT_CODE = 'E2E-RPT-002';
const PLAN_ID = randomUUID();
// The standard antivirus test string, assembled from parts so that this file is not itself flagged by the antivirus of a developer machine.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const reportOf = async (): Promise<{ id: string; status: string; version: string }> => {
  const [row] = await sql<{ id: string; status: string; version: string }>('select id, status, version::text as version from machvon.report_revision where project_id = $1 and period_id = $2', [PROJECT_ID, PERIOD_ID]);
  return row as { id: string; status: string; version: string };
};

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
     values ($1, $2, $3, 1, date '${YEAR}-01-04', date '${YEAR}-01-10', timestamptz '${YEAR}-01-10T03:00:00Z', 'E2E-REPORT-2', 'WEEK', ${YEAR}, 'OPEN', $4, $5, $5)`,
    [tenantId, PERIOD_ID, PERIOD_CODE, calendar?.id, owner],
  );
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
     values ($1, $2, $3, 'Dự án đường vào thôn báo cáo bước', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
    [tenantId, PROJECT_ID, PROJECT_CODE, ownerUnit, area?.id],
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
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const table of ['report_attachment', 'report_narrative', 'progress_snapshot', 'funding_snapshot_line']) {
      await client.query(`delete from machvon.${table} where report_revision_id in (select id from machvon.report_revision where project_id = $1)`, [PROJECT_ID]);
    }
    await client.query('delete from machvon.report_revision where project_id = $1', [PROJECT_ID]);
    await client.query('delete from machvon.allocation_line where plan_version_id = $1', [PLAN_ID]);
    await client.query('delete from machvon.plan_version where id = $1', [PLAN_ID]);
    await client.query('delete from machvon.reporting_period where id = $1', [PERIOD_ID]);
    await client.query('delete from machvon.project where id = $1', [PROJECT_ID]);
  } finally {
    await client.end();
  }
});

test.describe('DIS-03, DIS-05, DIS-06 volumes, registration and review of the weekly report', () => {
  test('a maker draws the draft and enters the volumes with the basis of the year to date marked as awaiting the sign-off (AC-ST-DIS-004-1, UAT-AC264)', async ({ page }) => {
    await open(page, 'reportMaker', '/dis/dis-02');
    await page.getByLabel(vi['dis.reportCreate.year.label'], { exact: true }).selectOption(String(YEAR));
    await page.getByLabel(vi['dis.reportCreate.period.label'], { exact: true }).selectOption(PERIOD_ID);
    await page.getByLabel(vi['dis.reportCreate.project.label'], { exact: true }).selectOption(PROJECT_ID);
    await page.getByRole('button', { name: vi['dis.reportCreate.submit.action'] }).click();
    await expect(page).toHaveURL(/\/dis\/dis-04\?report=/);
    const report = await reportOf();

    await page.getByRole('link', { name: vi['dis.reportSteps.progress.link'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.progress.page.title'] })).toBeVisible();
    await expect(page.getByTestId('basis-pending')).toHaveText(vi['dis.progress.basis.pending']);
    await page.getByRole('button', { name: vi['dis.progress.save.action'] }).click();
    await expect(page.getByText(vi['dis.progress.problem.required'])).toHaveCount(4);
    expect(await sql('select 1 from machvon.progress_snapshot where report_revision_id = $1', [report.id])).toEqual([]);

    await page.locator('#volume-construction').fill('1.019.000.000');
    await page.locator('#volume-acceptance').fill('200.000.000');
    await page.locator('#volume-treasury').fill('150.000.000');
    await page.locator('#volume-preparing').fill('50.000.000');
    await page.locator('#volume-percent').fill('37,5');
    await page.getByRole('button', { name: vi['dis.progress.save.action'] }).click();
    await expect(page).toHaveURL(/\/dis\/dis-18\?report=/);
    const [stored] = await sql<{ c: string; a: string; t: string; p: string; pct: string; d: string; b: string }>(
      `select construction_value_vnd::text as c, acceptance_value_vnd::text as a, treasury_submitted_value_vnd::text as t, preparing_dossier_value_vnd::text as p,
              physical_progress_pct::text as pct, as_of_date::text as d, measurement_basis as b from machvon.progress_snapshot where report_revision_id = $1`,
      [report.id],
    );
    expect(stored).toEqual({ c: '1019000000', a: '200000000', t: '150000000', p: '50000000', pct: '37.50', d: `${YEAR}-01-10`, b: 'YTD' });
    expect((await reportOf()).version).toBe('2');
  });

  test('the same maker enters the six cells, then registers 300 million for next month with 100 million of CTMTQG, and the cells keep what the volumes saved (AC-ST-DIS-004-3)', async ({ page }) => {
    const report = await reportOf();
    await open(page, 'reportMaker', `/dis/dis-04?report=${report.id}`);
    const cells: Array<[string, string]> = [
      ['CURRENT_YEAR:CENTRAL', '100.000.000'],
      ['CURRENT_YEAR:LOCAL', '200.000.000'],
      ['CARRYOVER:CENTRAL', '30.000.000'],
      ['CARRYOVER:LOCAL', '70.000.000'],
      ['OTHER:CENTRAL', '0'],
      ['OTHER:LOCAL', '20.000.000'],
    ];
    for (const [key, amount] of cells) await page.locator(`[id="cell-${key}"]`).fill(amount);
    await page.locator('[id="ctmtqg-CURRENT_YEAR:CENTRAL"]').fill('40.000.000');
    await page.getByRole('button', { name: vi['dis.reportEdit.save.action'] }).click();
    await expect(page).toHaveURL(/\/dis\/dis-18\?report=/);

    await open(page, 'reportMaker', `/dis/dis-05?report=${report.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.registration.page.title'] })).toBeVisible();
    await expect(page.getByTestId('registration-month')).toHaveText(vi['dis.registration.month.text'].replace('{month}', '2').replace('{year}', String(YEAR)));
    await expect(page.getByTestId('allocated-CURRENT_YEAR:CENTRAL')).toHaveText('500.000.000');
    await expect(page.getByTestId('reached-CURRENT_YEAR:CENTRAL')).toHaveText('100.000.000');
    await expect(page.getByTestId('remaining-CURRENT_YEAR:CENTRAL')).toHaveText('400.000.000');
    await page.locator('[id="next-CURRENT_YEAR:CENTRAL"]').fill('300.000.000');
    await page.locator('[id="next-ctmtqg-CURRENT_YEAR:CENTRAL"]').fill('400.000.000');
    await page.getByRole('button', { name: vi['dis.registration.save.action'] }).click();
    await expect(page.getByText(vi['dis.reportProblem.cell.exceeds'])).toBeVisible();
    await page.locator('[id="next-ctmtqg-CURRENT_YEAR:CENTRAL"]').fill('100.000.000');
    await expect(page.getByTestId('total-registered')).toHaveText('300.000.000');
    await expect(page.getByTestId('total-registered-ctmtqg')).toHaveText('100.000.000');
    await page.getByRole('button', { name: vi['dis.registration.save.action'] }).click();
    await expect(page).toHaveURL(/\/dis\/dis-18\?report=/);

    const lines = await sql<{ cell: string; cumulative: string; ctmtqg: string | null; next: string; next_ctmtqg: string | null }>(
      `select bucket || ':' || budget_level as cell, disbursed_cumulative_vnd::text as cumulative, ctmtqg_subset_vnd::text as ctmtqg, next_month_registered_vnd::text as next,
              next_month_ctmtqg_subset_vnd::text as next_ctmtqg from machvon.funding_snapshot_line where report_revision_id = $1 and bucket = 'CURRENT_YEAR' and budget_level = 'CENTRAL'`,
      [report.id],
    );
    expect(lines).toEqual([{ cell: 'CURRENT_YEAR:CENTRAL', cumulative: '100000000', ctmtqg: '40000000', next: '300000000', next_ctmtqg: '100000000' }]);
    // The volumes entered on DIS-03 are still there after the saves of the other steps.
    expect((await sql<{ c: string }>('select construction_value_vnd::text as c from machvon.progress_snapshot where report_revision_id = $1', [report.id]))[0]?.c).toBe('1019000000');
  });

  test('the review tells the volume of 203.8% as a warning that does not block, writes the notes and attaches a clean file, and refuses an infected file and one that is not what it says (AC-ST-DIS-004-2, AC-ST-DIS-004-4, TH04)', async ({ page }) => {
    const report = await reportOf();
    await open(page, 'reportMaker', `/dis/dis-06?report=${report.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.review.page.title'] })).toBeVisible();
    await expect(page.getByTestId('review-status')).toHaveText(vi['dis.review.status.ready']);
    await expect(page.getByTestId('review-errors-none')).toBeVisible();
    const warning = page.getByTestId('review-warnings').locator('li[data-code="VOLUME_EXCEEDS_ALLOCATION"]');
    await expect(warning).toContainText('203.8%');
    await expect(warning.getByRole('link', { name: vi['dis.review.fix.link'] })).toHaveAttribute('href', `/dis/dis-03?report=${report.id}`);
    await expect(page.getByTestId('diff-none')).toBeVisible();

    await page.getByLabel(vi['dis.review.notes.results.label']).fill('Móng cầu đã đổ xong.');
    await page.getByLabel(vi['dis.review.notes.proposals.label']).fill('Đề nghị giải ngân đợt tiếp theo.');
    await page.getByRole('button', { name: vi['dis.review.notes.save.action'] }).click();
    await expect.poll(async () => (await sql('select 1 from machvon.report_narrative where report_revision_id = $1', [report.id])).length).toBe(1);
    const [narrative] = await sql<{ results_text: string; proposals_text: string; causes_text: string | null }>('select results_text, proposals_text, causes_text from machvon.report_narrative where report_revision_id = $1', [report.id]);
    expect(narrative).toEqual({ results_text: 'Móng cầu đã đổ xong.', proposals_text: 'Đề nghị giải ngân đợt tiếp theo.', causes_text: null });

    const picker = page.getByLabel(vi['dis.review.files.pick.label']);
    await picker.setInputFiles({ name: 'chung-tu-01.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% voucher\n%%EOF') });
    await expect(page.getByRole('list', { name: vi['dis.review.files.list.aria'] }).getByText('chung-tu-01.pdf', { exact: true })).toBeVisible();
    await expect(page.getByText(vi['dis.review.files.clean.status'])).toBeVisible();
    const attached = await sql<{ file_name: string; content_type: string; size_bytes: string; position: number }>('select file_name, content_type, size_bytes::text as size_bytes, position from machvon.report_attachment where report_revision_id = $1', [report.id]);
    expect(attached).toEqual([{ file_name: 'chung-tu-01.pdf', content_type: 'application/pdf', size_bytes: String('%PDF-1.4\n% voucher\n%%EOF'.length), position: 1 }]);

    await picker.setInputFiles({ name: 'doc-hai.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n${EICAR}\n%%EOF`) });
    await expect(page.getByTestId('files-refusal')).toHaveText(vi['dis.reportProblem.fileInfected']);
    await picker.setInputFiles({ name: 'chuong-trinh.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ this is a program') });
    await expect(page.getByTestId('files-refusal')).toHaveText(vi['dis.reportProblem.fileType']);
    expect(await sql('select 1 from machvon.report_attachment where report_revision_id = $1', [report.id])).toHaveLength(1);

    await page.getByRole('button', { name: vi['dis.review.files.remove.action'].replace('{name}', 'chung-tu-01.pdf') }).click();
    await expect(page.getByTestId('files-none')).toBeVisible();
    expect(await sql('select 1 from machvon.report_attachment where report_revision_id = $1', [report.id])).toEqual([]);
  });

  test('a reader sees the review and the files and has nothing to type in or to attach', async ({ page }) => {
    const report = await reportOf();
    await open(page, 'reportReader', `/dis/dis-06?report=${report.id}`);
    await expect(page.getByTestId('review-status')).toBeVisible();
    await expect(page.getByLabel(vi['dis.review.notes.results.label'])).toBeDisabled();
    await expect(page.getByLabel(vi['dis.review.files.pick.label'])).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['dis.review.notes.save.action'] })).toHaveCount(0);
    await open(page, 'reportReader', `/dis/dis-03?report=${report.id}`);
    await expect(page.getByTestId('readonly-note')).toHaveText(vi['dis.progress.denied.note']);
    await expect(page.locator('#volume-construction')).toBeDisabled();
  });
});
