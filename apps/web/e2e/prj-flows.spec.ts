import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * PRJ-01 (register), PRJ-02 (create with the suggested group) and PRJ-03 (workspace) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): the project manager creates a project in the stage CONCEPT, reads the group the rule data suggests for it with the
 * badge of the rule that still waits for its confirmation, finds it in the register and changes its profile; a second project with the same
 * code is refused; someone who only reads cannot create or change anything. What the screens changed is looked up in the database.
 */

const unique = (): string => `E2E-${Date.now().toString(36).toUpperCase()}`;
/** The Vietnam date today, the day the rule data is read for. */
const today = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const AREA_LABEL = 'E2E_AREA_1 · Thành phố Cao Bằng';
const SECTOR_LABEL = 'EDUCATION · Giáo dục và đào tạo';
/** 150 billion dong: above 120 billion and below 2,300 billion, the band of group B of the thresholds the baseline publishes. */
const TOTAL = '150000000000';

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface ProjectRow {
  code: string;
  name: string;
  status: string;
  version: string;
  classification: string;
  total_investment_vnd: string;
  owner_unit_id: string;
  start_year: number | null;
  end_year: number | null;
  created_by: string;
  national_project_code: string | null;
}

const projectOf = async (code: string): Promise<ProjectRow | undefined> =>
  (
    await sql<ProjectRow>(
      'select code, name, status, version::text as version, classification, total_investment_vnd::text as total_investment_vnd, owner_unit_id, start_year, end_year, created_by, national_project_code from machvon.project where code = $1',
      [code],
    )
  )[0];

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

async function fillCreate(page: Page, code: string, name: string): Promise<void> {
  await field(page, vi['prj.form.code.label']).fill(code);
  await field(page, vi['prj.form.name.label']).fill(name);
  await field(page, vi['prj.form.owner.label']).selectOption({ label: 'CB-SKHDT-QLDA · Ban Quản lý dự án' });
  await field(page, vi['prj.form.area.label']).selectOption({ label: AREA_LABEL });
  await field(page, vi['prj.form.sector.label']).selectOption({ label: SECTOR_LABEL });
  await field(page, vi['prj.form.total.label']).fill(TOTAL);
}

const create = (page: Page) => page.getByRole('button', { name: vi['prj.create.submit.action'] }).click();

test.describe('PRJ-01 to PRJ-03 project register', () => {
  test('the manager creates a project, reads the group the rule data suggests with the badge of the unconfirmed rule, finds it in the register and changes its profile; a duplicate code and a stale version are refused (AC-ST-PRJ-001-1, AC-ST-PRJ-001-2)', async ({ page }) => {
    const code = unique();
    const name = 'Dự án trường học kiểm thử e2e';
    await open(page, 'projectManager', '/prj/prj-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.list.page.title'] })).toBeVisible();
    await page.getByRole('link', { name: vi['prj.list.create.action'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.create.page.title'] })).toBeVisible();

    // An empty form sends nothing: every required field says so and the database has nothing.
    await create(page);
    for (const id of ['project-code', 'project-name', 'project-ownerUnitId', 'project-areaVersionId', 'project-totalInvestment']) {
      await expect(page.locator(`[data-field="${id}"]`).getByText(vi['prj.field.required.error'])).toBeVisible();
    }
    expect(await projectOf(code)).toBeUndefined();

    // An amount that is not whole dong is stopped before it is sent.
    await fillCreate(page, code, name);
    await field(page, vi['prj.form.total.label']).fill('1500.5');
    await create(page);
    await expect(page.locator('[data-field="project-totalInvestment"]').getByText(vi['prj.field.invalidAmount.error'])).toBeVisible();
    expect(await projectOf(code)).toBeUndefined();

    await field(page, vi['prj.form.total.label']).fill(TOTAL);
    await create(page);
    const done = page.getByTestId('created');
    await expect(done).toBeVisible();
    await expect(done.getByText(vi['prj.create.done.text'])).toBeVisible();
    // The group of the thresholds in force today, and the badge that the rule waits for its confirmation (CXN-32).
    const suggestion = done.getByTestId('suggestion');
    await expect(suggestion).toContainText(vi['prj.suggestion.group.text'].replace('{group}', 'B').replace('{date}', today()));
    await expect(suggestion.getByTestId('suggestion-awaiting')).toHaveText(vi['prj.suggestion.awaitingCxn.badge'].replace('{cxn}', 'CXN-32'));

    const created = await projectOf(code);
    expect(created).toMatchObject({ code, name, status: 'CONCEPT', version: '1', classification: 'INTERNAL', total_investment_vnd: TOTAL, created_by: membershipOf('projectManager'), national_project_code: null });
    expect(created?.owner_unit_id).toBe(stackInfo().units.A['CB-SKHDT-QLDA']);
    // The first revision keeps the dossier as it was proposed and the group the rule data suggested that day.
    const [revision] = await sql<{ revision: number; change_kind: string; status: string; group_key: string | null }>(
      "select r.revision, r.change_kind, r.status, r.after_json->'group_suggestion'->>'group_key' as group_key from machvon.project_revision r join machvon.project p on p.id = r.project_id where p.code = $1",
      [code],
    );
    expect(revision).toEqual({ revision: 1, change_kind: 'INITIAL', status: 'DRAFT', group_key: 'B' });
    expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'project.created' and resource_id = (select id from machvon.project where code = $1)", [code])).toEqual([{ n: 1 }]);

    // The same code again is refused by the server and nothing is written.
    await page.getByRole('link', { name: vi['prj.create.cancel.action'] }).click();
    await page.getByRole('link', { name: vi['prj.list.create.action'] }).click();
    await fillCreate(page, code, 'Dự án trùng mã');
    await create(page);
    await expect(page.getByRole('alert').filter({ hasText: vi['prj.problem.duplicateCode.error'] })).toBeVisible();
    expect(await sql('select count(*)::int as n from machvon.project where code = $1', [code])).toEqual([{ n: 1 }]);

    // The register lists it in its stage with the badge of the missing national code, and the filters narrow the list.
    await page.goto(`/prj/prj-01?devUser=projectManager`);
    // The register pages by code (20 a page) and the specs of the same run leave many projects behind: the person looks the code up, as in a register of hundreds.
    await field(page, vi['prj.list.query.label']).fill(code);
    const row = page.locator('tr[data-project-id]', { hasText: code });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('stage')).toHaveText(vi['prj.stage.concept.label']);
    await expect(row.getByTestId('national-code-missing')).toHaveText(vi['prj.nationalCode.missing.badge']);
    await expect(row).toContainText('Ban Quản lý dự án');
    await field(page, vi['prj.list.query.label']).fill('khong-co-du-an-nao-ten-nhu-vay');
    await expect(page.getByTestId('projects').getByRole('status')).toContainText(vi['ui.dataTable.emptyFiltered']);
    await field(page, vi['prj.list.query.label']).fill(code.toLowerCase());
    await expect(page.locator('tr[data-project-id]')).toHaveCount(1);
    await page.getByLabel(vi['prj.list.missingCode.label']).check();
    await expect(page.locator('tr[data-project-id]')).toHaveCount(1);

    // The workspace shows the profile and the group the rule data suggests; its profile is changed within the allowlist.
    await row.getByRole('link', { name: code }).click();
    await expect(page.getByRole('heading', { level: 1, name: `${code} · ${name}` })).toBeVisible();
    await expect(page.getByTestId('stage')).toHaveText(vi['prj.stage.concept.label']);
    const profile = page.getByTestId('profile');
    await expect(profile).toContainText('150.000.000.000');
    await expect(profile).toContainText('Thành phố Cao Bằng');
    await expect(page.getByTestId('suggestion-awaiting')).toBeVisible();
    await page.getByRole('tab', { name: vi['prj.workspace.tab.plan'] }).click();
    await expect(page.getByRole('tab', { name: vi['prj.workspace.tab.plan'] })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: vi['prj.workspace.tab.overview'] }).click();

    const renamed = 'Dự án trường học kiểm thử e2e (đã sửa)';
    await field(page, vi['prj.form.name.label']).fill(renamed);
    await field(page, vi['prj.form.startYear.label']).fill('2029');
    await field(page, vi['prj.form.endYear.label']).fill('2027');
    await page.getByRole('button', { name: vi['prj.workspace.edit.submit.action'] }).click();
    await expect(page.locator('[data-field="project-endYear"]').getByText(vi['prj.field.order.error'])).toBeVisible();
    expect((await projectOf(code))?.version).toBe('1');
    await field(page, vi['prj.form.startYear.label']).fill('2027');
    await field(page, vi['prj.form.endYear.label']).fill('2029');
    await page.getByRole('button', { name: vi['prj.workspace.edit.submit.action'] }).click();
    await expect(page.getByTestId('saved')).toHaveText(vi['prj.workspace.edit.saved.notice']);
    expect(await projectOf(code)).toMatchObject({ name: renamed, version: '2', start_year: 2027, end_year: 2029, status: 'CONCEPT', total_investment_vnd: TOTAL });
    expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'project.profile_changed' and resource_id = (select id from machvon.project where code = $1)", [code])).toEqual([{ n: 1 }]);
    await expect(page.getByRole('heading', { level: 1, name: `${code} · ${renamed}` })).toBeVisible();

    // Someone else changes the project meanwhile: the save that carries the old version is refused, nothing is overwritten, and a reload starts the form over.
    await sql('update machvon.project set version = version + 1 where code = $1', [code]);
    await field(page, vi['prj.form.name.label']).fill('Tên sửa trên bản đã cũ');
    await page.getByRole('button', { name: vi['prj.workspace.edit.submit.action'] }).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['prj.problem.versionConflict.error']);
    expect(await projectOf(code)).toMatchObject({ name: renamed, version: '3' });
    await page.getByRole('button', { name: vi['prj.workspace.edit.reload.action'] }).click();
    await expect(page.getByTestId('problem')).toHaveCount(0);
    await expect(field(page, vi['prj.form.name.label'])).toHaveValue(renamed);
  });

  test('someone who only reads the register cannot create or change a project, and someone without the read permission is refused the screen (AC-ST-PRJ-001-5)', async ({ page }) => {
    const [seeded] = await sql<{ id: string }>("select id from machvon.project where code = 'DA-01'");
    const before = await projectOf('DA-01');

    await open(page, 'projectViewer', '/prj/prj-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.list.page.title'] })).toBeVisible();
    await expect(page.locator('tr[data-project-id]', { hasText: 'DA-01' })).toBeVisible();
    await expect(page.getByRole('link', { name: vi['prj.list.create.action'] })).toHaveCount(0);

    await open(page, 'projectViewer', '/prj/prj-02');
    await expect(page.getByText(vi['prj.readOnly.denied.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['prj.create.submit.action'] })).toBeDisabled();
    await expect(field(page, vi['prj.form.code.label'])).toBeDisabled();

    await open(page, 'projectViewer', `/prj/prj-03?id=${seeded?.id ?? ''}`);
    await expect(page.getByRole('heading', { level: 1, name: /DA-01/ })).toBeVisible();
    await expect(page.getByTestId('read-only')).toHaveText(vi['prj.workspace.edit.denied.notice']);
    await expect(page.getByRole('button', { name: vi['prj.workspace.edit.submit.action'] })).toBeDisabled();
    await expect(field(page, vi['prj.form.name.label'])).toBeDisabled();
    expect(await projectOf('DA-01')).toEqual(before);

    await open(page, 'nobody', '/prj/prj-01');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-project-id]')).toHaveCount(0);
  });
});
