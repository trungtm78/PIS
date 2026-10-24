import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * BID-04 (evaluation criteria) in a real browser against the real API and database (apps/api/test/e2e-stack): a planner drafts the criteria of a package
 * of an approved plan with the running total of the weights in front of them, weights that do not add up and a criterion nobody may ask for are refused
 * (the second by the server, with the legal basis), a person other than the maker approves and locks the version, the next revision takes the place of the
 * version in force, and someone who only reads sees the versions in force and neither the drafts nor the form.
 */

const tenantA = (): string => stackInfo().tenants.A;
const BASIS = 'Luật Đấu thầu 22/2023/QH15';

async function open(page: Page, user: string, packageId: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/bid/bid-04?package=${packageId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function seedPackage(label: string): Promise<{ projectId: string; packageId: string }> {
  const projectId = randomUUID();
  const packageId = randomUUID();
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantA()]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 'B', $7, 1, $8, $8)`,
    [tenantA(), projectId, `E2E-CR-${label}`, `Dự án ${label}`, stackInfo().units.A['CB-SKHDT-QLDA'], area?.id, String(9700000 + (Number.parseInt(projectId.slice(0, 5), 16) % 90000)), membershipOf('owner')],
  );
  await sql(
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title)
     values ($1, $2, $3, $4, 1000, 'OPEN_BIDDING', 1, 'PLANNED', $5)`,
    [tenantA(), packageId, projectId, `GT-CR-${label}`, `Gói thầu ${label}`],
  );
  return { projectId, packageId };
}

const versionsOf = (packageId: string) =>
  sql<{ id: string; revision: number; status: string; weights_sum: number | null; approved_by: string | null; legal_basis: string }>(
    'select id, revision, status, weights_sum, approved_by, legal_basis from machvon.criteria_version where package_id = $1 order by revision',
    [packageId],
  );

const form = (page: Page): Locator => page.getByRole('form', { name: vi['bid.criteria.form.aria'] });
const rowOf = (page: Page, number: number): Locator => form(page).getByRole('group', { name: `Tiêu chí ${number}` });
const field = (scope: Locator, label: string): Locator => scope.getByLabel(label, { exact: true });
const save = (page: Page) => form(page).getByRole('button', { name: vi['bid.criteria.form.submit.action'] }).click();

async function fill(page: Page, number: number, values: { code: string; name: string; weight?: string; scale?: string; threshold?: string; evidence?: string; kind?: 'PASS_FAIL' }): Promise<void> {
  const row = rowOf(page, number);
  if (values.kind === 'PASS_FAIL') await field(row, vi['bid.criteria.row.kind']).selectOption('PASS_FAIL');
  await field(row, vi['bid.criteria.row.code']).fill(values.code);
  await field(row, vi['bid.criteria.row.name']).fill(values.name);
  if (values.weight !== undefined) await field(row, vi['bid.criteria.row.weight']).fill(values.weight);
  if (values.scale !== undefined) await field(row, vi['bid.criteria.row.scale']).fill(values.scale);
  if (values.threshold !== undefined) await field(row, vi['bid.criteria.row.threshold']).fill(values.threshold);
  if (values.evidence !== undefined) await field(row, vi['bid.criteria.row.evidence']).fill(values.evidence);
}

test.describe('BID-04 evaluation criteria', () => {
  test('the planner drafts with a running total, a total that is not 100 and a prohibited criterion are refused, another person approves and locks, and the next revision takes over (AC-ST-BID-003-1, -2, -3)', async ({ page }) => {
    const label = Date.now().toString(36).toUpperCase();
    const { packageId } = await seedPackage(label);
    await open(page, 'criteriaSolo', packageId);
    await expect(page.getByRole('heading', { level: 1, name: vi['bid.criteria.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-versions')).toHaveText(vi['bid.criteria.versions.empty.text']);

    await form(page).getByLabel(vi['bid.criteria.form.basis.label'], { exact: true }).fill(BASIS);
    await fill(page, 1, { code: 'C1', name: 'Kinh nghiệm thi công công trình tương tự', weight: '30', threshold: '5', evidence: 'Hợp đồng tương tự\nBiên bản nghiệm thu' });
    await form(page).getByRole('button', { name: vi['bid.criteria.row.add'] }).click();
    await fill(page, 2, { code: 'C2', name: 'Năng lực tài chính', weight: '30', scale: '20' });
    await form(page).getByRole('button', { name: vi['bid.criteria.row.add'] }).click();
    await fill(page, 3, { code: 'C3', name: 'Biện pháp thi công', weight: '20' });
    await form(page).getByRole('button', { name: vi['bid.criteria.row.add'] }).click();
    await fill(page, 4, { code: 'C4', name: 'Tiến độ thực hiện', weight: '10' });
    await expect(page.getByTestId('running-total')).toHaveText('Σ trọng số: 90 / 100');

    // 30/30/20/10 is 90: nothing is sent, and the total is told in its place.
    await save(page);
    await expect(page.getByTestId('rows-error')).toContainText('100');
    expect(await versionsOf(packageId)).toEqual([]);

    // The weights are right now, but a criterion about a local director is not something anyone may ask: the server refuses it and says why.
    await field(rowOf(page, 4), vi['bid.criteria.row.weight']).fill('20');
    await expect(page.getByTestId('running-total')).toHaveText('Σ trọng số: 100 / 100');
    await field(rowOf(page, 3), vi['bid.criteria.row.name']).fill('Giám đốc là người địa phương');
    await save(page);
    const refusal = page.getByTestId('create-refusal');
    await expect(refusal).toHaveAttribute('data-reason', 'prohibited');
    await expect(refusal).toContainText('Tiêu chí C3 thuộc loại không được đặt ra cho nhà thầu');
    await expect(refusal).toContainText('Căn cứ pháp lý: Luật Đấu thầu 22/2023/QH15');
    expect(await versionsOf(packageId)).toEqual([]);

    await field(rowOf(page, 3), vi['bid.criteria.row.name']).fill('Biện pháp thi công');
    await save(page);
    await expect(page.getByTestId('saved')).toBeVisible();
    const [first] = await versionsOf(packageId);
    expect(first).toMatchObject({ revision: 1, status: 'DRAFT', weights_sum: 100, approved_by: null, legal_basis: BASIS });
    const detail = page.getByTestId('version-detail');
    await expect(detail.locator('[data-criterion-code]')).toHaveCount(4);
    await expect(detail.getByTestId('weights-sum')).toHaveText('100');
    await expect(page.getByTestId('criteria-status')).toHaveText(vi['bid.criteria.status.draft.label']);

    // Whoever holds both rights is still the maker: the server refuses their own approval.
    await detail.getByRole('button', { name: vi['bid.criteria.approve.action'] }).click();
    await expect(page.getByTestId('approve-refusal')).toHaveText(vi['bid.criteria.problem.selfApproval.error']);
    expect((await versionsOf(packageId))[0]?.status).toBe('DRAFT');

    // Another person approves, and the version is locked.
    await open(page, 'criteriaApprover', packageId);
    await expect(page.getByTestId('version-detail')).toBeVisible();
    await page.getByRole('button', { name: vi['bid.criteria.approve.action'] }).click();
    await expect(page.getByTestId('approved')).toHaveText(vi['bid.criteria.approve.done.notice']);
    await expect(page.getByTestId('criteria-status')).toHaveText(vi['bid.criteria.status.approved.label']);
    expect((await versionsOf(packageId))[0]).toMatchObject({ status: 'APPROVED', approved_by: membershipOf('criteriaApprover') });
    await expect(page.getByRole('button', { name: vi['bid.criteria.approve.action'] })).toHaveCount(0);
    expect(await sql("select 1 from machvon.audit_event where resource_id = $1::uuid and action = 'criteria_version.approved'", [first?.id])).toHaveLength(1);

    // The next revision starts from the version in force and replaces it only when approved.
    await open(page, 'criteriaPlanner', packageId);
    await form(page).getByRole('button', { name: 'Bắt đầu từ bản 1' }).click();
    await expect(rowOf(page, 4)).toBeVisible();
    await field(rowOf(page, 1), vi['bid.criteria.row.weight']).fill('40');
    await field(rowOf(page, 4), vi['bid.criteria.row.weight']).fill('10');
    await expect(page.getByTestId('running-total')).toHaveText('Σ trọng số: 100 / 100');
    await save(page);
    await expect(page.getByTestId('saved')).toBeVisible();
    expect((await versionsOf(packageId)).map((version) => [version.revision, version.status])).toEqual([
      [1, 'APPROVED'],
      [2, 'DRAFT'],
    ]);
    await open(page, 'criteriaApprover', packageId);
    await page.getByRole('button', { name: 'Xem bản 2' }).click();
    await page.getByRole('button', { name: vi['bid.criteria.approve.action'] }).click();
    await expect(page.getByTestId('approved')).toBeVisible();
    expect((await versionsOf(packageId)).map((version) => [version.revision, version.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'APPROVED'],
    ]);
  });

  test('someone who only reads sees the version in force and neither the draft nor the form', async ({ page }) => {
    const label = `R${Date.now().toString(36).toUpperCase()}`;
    const { packageId } = await seedPackage(label);
    const made = async (revision: number, approved: boolean): Promise<void> => {
      const versionId = randomUUID();
      const criteria = { criteria: [{ code: 'C1', name: `Tiêu chí bản ${revision}`, kind: 'SCORED', weight: 100, max_score: 10, threshold: null, mandatory: false, required_evidence: [] }] };
      await sql(
        `insert into machvon.criteria_version (tenant_id, id, package_id, revision, criteria_json, legal_basis, weights_sum, status, created_by, version)
         values ($1, $2, $3, $4, $5::jsonb, $6, 100, 'DRAFT', $7, 1)`,
        [tenantA(), versionId, packageId, revision, JSON.stringify(criteria), BASIS, membershipOf('owner')],
      );
      if (approved) await sql("update machvon.criteria_version set status = 'APPROVED', approved_by = $2, effective_at = now(), version = 2 where id = $1", [versionId, membershipOf('criteriaApprover')]);
    };
    await made(1, true);
    await made(2, false);
    await open(page, 'criteriaReader', packageId);
    await expect(page.getByTestId('versions').locator('tbody tr')).toHaveCount(1);
    await expect(page.getByTestId('criteria-status')).toHaveText(vi['bid.criteria.status.approved.label']);
    await expect(page.getByTestId('version-detail')).toContainText('Tiêu chí bản 1');
    await expect(form(page)).toHaveCount(0);
    await expect(page.getByTestId('read-only')).toHaveText(vi['bid.criteria.readonly.notice']);
    await expect(page.getByRole('button', { name: vi['bid.criteria.approve.action'] })).toHaveCount(0);

    // The approver sees the draft as well, and the planner too.
    await open(page, 'criteriaPlanner', packageId);
    await expect(page.getByTestId('versions').locator('tbody tr')).toHaveCount(2);
  });
});
