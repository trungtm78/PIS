import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * BID-17 (the milestones of the choice of a contractor) and BID-19 (the links to the national bidding network and the reconciliation) in a real browser against the real API
 * and database (apps/api/test/e2e-stack): the planner records the milestones of a package and is told by the server when the dates break the order; the planner uploads the
 * file exported from the national bidding system, reads the dry run row by row (nothing is written), applies it once, and the database holds the milestones with the source
 * IMPORT and the links in step; the same file again is told as loaded. The browser makes no request outside this machine: the adapter is a proposal and calls nothing.
 * Someone who may only read sees the milestones and the links and no button.
 */

const OWNER_UNIT = 'CB-SKHDT-QLDA';

interface Seeded {
  projectId: string;
  packageId: string;
  code: string;
}

async function seedPackage(status = 'PLANNED'): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const packageId = randomUUID();
  const suffix = `${Date.now().toString(36).toUpperCase()}-${packageId.slice(0, 4).toUpperCase()}`;
  const planner = membershipOf('procurementPlanner');
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, `E2E-BID-${suffix}`, `Dự án đấu thầu ${suffix}`, stackInfo().units.A[OWNER_UNIT], area?.id, planner],
  );
  const code = `GT-${suffix}`;
  await sql(
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
     values ($1, $2, $3, $4, 1000000000, 'OPEN_BIDDING', 1, $5, $6, $7, 1)`,
    [tenant, packageId, projectId, code, status, `Gói xây lắp ${suffix}`, planner],
  );
  return { projectId, packageId, code };
}

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const milestoneRows = (packageId: string) =>
  sql<{ milestone_kind: string; source: string; actual_at: string | null }>(
    "select milestone_kind, source, to_char(actual_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as actual_at from machvon.procurement_milestone where package_id = $1 order by milestone_kind",
    [packageId],
  );

test.describe('BID-17 and BID-19: the milestones of the choice of a contractor and the national bidding file', () => {
  test('the planner records the milestones of a package, is refused a date out of order, and the database holds the milestones with the source MANUAL (UI-BID-17)', async ({ page }) => {
    const seeded = await seedPackage();
    await open(page, 'procurementPlanner', '/bid/bid-17');
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.milestones.page.title'] })).toBeVisible();
    const row = page.locator(`tr[data-package-id="${seeded.packageId}"]`);
    await expect(row.getByTestId('no-milestones')).toHaveText(vi['bid.milestones.none.text']);

    const record = async (kind: string, actual: string): Promise<void> => {
      await row.getByRole('button', { name: vi['bid.milestones.record.aria'].replace('{code}', seeded.code) }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(vi['bid.milestone.field.kind'], { exact: true }).selectOption(kind);
      await dialog.getByLabel(vi['bid.milestone.field.actual'], { exact: true }).fill(actual);
      await dialog.getByRole('button', { name: vi['bid.milestone.dialog.submit'] }).click();
    };

    await record('BID_OPENING', '2026-09-10T09:00');
    await expect(row.locator('[data-kind="BID_OPENING"]').getByTestId('actual')).toContainText('2026-09-10');
    await expect(row.locator('[data-kind="BID_OPENING"]').getByTestId('source')).toHaveText(vi['bid.milestone.source.manual']);

    // The closing of the bid cannot come after its opening: the server names the two milestones.
    await row.getByRole('button', { name: vi['bid.milestones.record.aria'].replace('{code}', seeded.code) }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['bid.milestone.field.kind'], { exact: true }).selectOption('BID_CLOSING');
    await dialog.getByLabel(vi['bid.milestone.field.actual'], { exact: true }).fill('2026-09-11T09:00');
    await dialog.getByRole('button', { name: vi['bid.milestone.dialog.submit'] }).click();
    await expect(dialog.getByTestId('refusal')).toHaveText(vi['bid.milestone.problem.order'].replace('{earlier}', vi['bid.milestone.closing.label']).replace('{later}', vi['bid.milestone.opening.label']));
    await dialog.getByLabel(vi['bid.milestone.field.actual'], { exact: true }).fill('2026-09-09T09:00');
    await dialog.getByRole('button', { name: vi['bid.milestone.dialog.submit'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(row.locator('li')).toHaveCount(2);
    expect(await milestoneRows(seeded.packageId)).toEqual([
      { milestone_kind: 'BID_CLOSING', source: 'MANUAL', actual_at: '2026-09-09T02:00:00Z' },
      { milestone_kind: 'BID_OPENING', source: 'MANUAL', actual_at: '2026-09-10T02:00:00Z' },
    ]);
    const [audit] = await sql<{ n: number }>("select count(*)::int as n from machvon.audit_event where action = 'bid.milestone_recorded' and resource_id = $1", [seeded.packageId]);
    expect(audit?.n).toBe(2);
  });

  test('the planner uploads the file, reads the dry run, applies it once, and the links are in step; the same file again is told as loaded (AC-ST-BID-005-1, UAT-AC454, UI-BID-19)', async ({ page }) => {
    const one = await seedPackage();
    const two = await seedPackage();
    const rows = [`${one.code},TBMT-${one.code},BID_OPENING,2026-09-01`, `${two.code},TBMT-${two.code},RESULT_PUBLISHED,2026-09-15`, 'GT-NOT-THERE,TBMT-X,BID_OPENING,2026-09-01'];
    const file = { name: 'muasamcong.csv', mimeType: 'text/csv', buffer: Buffer.from(['package_code,external_code,milestone_kind,actual_at', ...rows].join('\n')) };
    const outside: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') outside.push(request.url());
    });

    await open(page, 'procurementPlanner', '/bid/bid-19');
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.links.page.title'] })).toBeVisible();
    await expect(page.getByTestId('adapter-note')).toHaveText(vi['bid.import.adapter.note']);
    const panel = page.getByTestId('import-panel');
    await expect(panel.getByRole('button', { name: vi['bid.import.check.action'] })).toBeDisabled();
    await panel.getByLabel(vi['bid.import.file.label']).setInputFiles(file);
    await panel.getByRole('button', { name: vi['bid.import.check.action'] }).click();

    // The dry run: two rows would be taken, the third names a package that does not exist; nothing has been written.
    await expect(panel.getByTestId('import-counts')).toHaveText(vi['bid.import.preview.counts'].replace('{total}', '3').replace('{valid}', '2').replace('{repeats}', '0').replace('{errors}', '1'));
    await expect(panel.locator('[data-line="4"][data-status="ERROR"]')).toContainText(vi['bid.import.row.notFound']);
    await expect(panel.locator('[data-line="2"][data-status="VALID"]')).toContainText(vi['bid.import.row.create']);
    expect(await milestoneRows(one.packageId)).toEqual([]);
    expect(await sql('select id from machvon.procurement_import_batch where file_sha256 = $1', [createHash('sha256').update(file.buffer).digest('hex')])).toEqual([]);

    await panel.getByRole('button', { name: vi['bid.import.apply.action'] }).click();
    await expect(panel.getByTestId('import-applied')).toHaveText(vi['bid.import.applied.notice']);
    await expect(panel.getByTestId('import-counts')).toHaveText(vi['bid.import.applied.counts'].replace('{written}', '2').replace('{errors}', '1').replace('{differences}', '0'));
    expect(await milestoneRows(one.packageId)).toEqual([{ milestone_kind: 'BID_OPENING', source: 'IMPORT', actual_at: '2026-08-31T17:00:00Z' }]);
    expect(await milestoneRows(two.packageId)).toEqual([{ milestone_kind: 'RESULT_PUBLISHED', source: 'IMPORT', actual_at: '2026-09-14T17:00:00Z' }]);
    const links = await sql<{ package_id: string; external_code: string; diff_status: string }>('select package_id, external_code, diff_status from machvon.procurement_external_link where package_id = any($1::uuid[]) order by external_code', [[one.packageId, two.packageId]]);
    expect(links.map((link) => [link.external_code, link.diff_status])).toEqual([
      [`TBMT-${one.code}`, 'IN_SYNC'],
      [`TBMT-${two.code}`, 'IN_SYNC'],
    ]);
    const [batch] = await sql<{ status: string; adapter_status: string; rows_ok: number; rows_error: number }>("select status, adapter_status, rows_ok, rows_error from machvon.procurement_import_batch where id = (select last_batch_id from machvon.procurement_external_link where package_id = $1)", [one.packageId]);
    expect(batch).toEqual({ status: 'APPLIED', adapter_status: 'PROPOSED', rows_ok: 2, rows_error: 1 });

    // The links show the code, the source and the file; the milestones show the source IMPORT.
    await page.reload();
    await page.waitForSelector('[data-screen-id]');
    const linkRow = page.locator('tr[data-link-id]', { hasText: `TBMT-${one.code}` });
    await expect(linkRow.getByTestId('diff-status')).toHaveText(vi['bid.link.status.inSync']);
    await expect(linkRow.getByTestId('adapter')).toHaveText(vi['bid.links.source.file'].replace('{status}', 'PROPOSED'));
    await open(page, 'procurementPlanner', '/bid/bid-17');
    await expect(page.locator(`tr[data-package-id="${one.packageId}"]`).locator('[data-kind="BID_OPENING"]').getByTestId('source')).toHaveText(vi['bid.milestone.source.import']);

    // The same file again: the dry run says it was loaded, and the apply is not possible.
    await open(page, 'procurementPlanner', '/bid/bid-19');
    await panel.getByLabel(vi['bid.import.file.label']).setInputFiles(file);
    await panel.getByRole('button', { name: vi['bid.import.check.action'] }).click();
    await expect(panel.getByTestId('import-already')).toHaveText(vi['bid.import.already.notice']);
    await expect(panel.getByRole('button', { name: vi['bid.import.apply.action'] })).toBeDisabled();
    expect(await milestoneRows(one.packageId)).toHaveLength(1);
    // Nothing left this machine: the adapter is a proposal and calls no system of the State.
    expect(outside).toEqual([]);
  });

  test('someone who may only read sees the milestones, the links and no button (UI-BID-17, UI-BID-19)', async ({ page }) => {
    const seeded = await seedPackage();
    await open(page, 'procurementPlanner', '/bid/bid-17');
    await page.locator(`tr[data-package-id="${seeded.packageId}"]`).getByRole('button', { name: vi['bid.milestones.record.aria'].replace('{code}', seeded.code) }).click();
    await page.getByRole('dialog').getByLabel(vi['bid.milestone.field.kind'], { exact: true }).selectOption('INVITATION_PUBLISHED');
    await page.getByRole('dialog').getByLabel(vi['bid.milestone.field.actual'], { exact: true }).fill('2026-08-01T08:00');
    await page.getByRole('dialog').getByRole('button', { name: vi['bid.milestone.dialog.submit'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await open(page, 'procurementReader', '/bid/bid-17');
    const row = page.locator(`tr[data-package-id="${seeded.packageId}"]`);
    await expect(row.locator('[data-kind="INVITATION_PUBLISHED"]')).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(0);
    await open(page, 'procurementReader', '/bid/bid-19');
    await expect(page.getByTestId('import-denied')).toHaveText(vi['bid.import.denied.notice']);
    await expect(page.getByLabel(vi['bid.import.file.label'])).toHaveCount(0);
  });
});
