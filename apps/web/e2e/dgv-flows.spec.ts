import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * DGV-03 and DGV-04 in a real browser against the real API and database (apps/api/test/e2e-stack): the catalogue steward registers a
 * critical dataset with two different people as owner and steward, is refused a second dataset with the same code, and changes the pair for
 * a stated reason against the version that was read; a reader of the catalogue sees only the datasets their roles allow and is not told how
 * many others there are. What the screens changed is looked up in the database.
 */

const unique = (): string => `DS-E2E-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 100)}`;
const OWNER = membershipOf('auditor');
const STEWARD = membershipOf('dgvSteward');
const NEW_OWNER = membershipOf('unitAdmin');
const NEW_STEWARD = membershipOf('owner');

async function open(page: Page, path: 'dgv-03' | 'dgv-04', user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/dgv/${path}?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface DatasetRow {
  dataset_code: string;
  status: string;
  classification: string;
  is_critical: boolean;
  owner_user_id: string;
  steward_user_id: string;
  freshness_slo_seconds: string;
  version: string;
  created_by: string;
}

const datasetsOf = (code: string): Promise<DatasetRow[]> =>
  sql('select dataset_code, status, classification, is_critical, owner_user_id, steward_user_id, freshness_slo_seconds::text, version::text, created_by from machvon.dataset where dataset_code = $1', [code]);

interface Fields {
  code: string;
  title: string;
  owner: string;
  steward: string;
  critical: boolean;
}

async function fill(page: Page, fields: Fields): Promise<void> {
  await page.getByLabel(vi['dgv.owners.register.code.label'], { exact: true }).fill(fields.code);
  await page.getByLabel(vi['dgv.owners.register.name.label'], { exact: true }).fill(fields.title);
  await page.getByLabel(vi['dgv.owners.register.domain.label'], { exact: true }).fill('treasury');
  await page.getByLabel(vi['dgv.owners.register.grain.label'], { exact: true }).fill('one row per payment order');
  await page.getByLabel(vi['dgv.owners.register.module.label'], { exact: true }).fill('PAY');
  await page.getByLabel(vi['dgv.owners.register.owner.label'], { exact: true }).selectOption(fields.owner);
  await page.getByLabel(vi['dgv.owners.register.steward.label'], { exact: true }).selectOption(fields.steward);
  const critical = page.getByLabel(vi['dgv.owners.register.critical.label'], { exact: true });
  if (fields.critical) await critical.check();
  else await critical.uncheck();
}

const registerForm = (page: Page) => page.getByRole('form', { name: vi['dgv.owners.register.title'] });
const submitRegistration = (page: Page) => registerForm(page).getByRole('button', { name: vi['dgv.owners.register.save.action'] }).click();
const rowOf = (page: Page, code: string) => page.locator(`tr[data-dataset-code="${code}"]`);

/** A dataset that no screen can create: it names the roles allowed to see it. */
async function seedDataset(code: string, classification: string, allowedRoles: string[]): Promise<void> {
  await sql(
    `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by, allowed_role_codes)
     values ($1, gen_random_uuid(), $2, $3, 'hr', 'one row per employee', 'HRM', $4, $5, $6, false, 86400, 'DRAFT', $5, $5, $7::text[])`,
    [stackInfo().tenants.A, code, `Dataset ${code}`, membershipOf('auditor'), membershipOf('nobody'), classification, allowedRoles],
  );
}

test.describe('DGV-03 owners and stewards', () => {
  test('the steward registers a critical dataset with two people, a duplicate code is refused, and the pair is changed for a stated reason (AC-ST-DGV-001-1)', async ({ page }) => {
    const code = unique();
    await open(page, 'dgv-03', 'dgvSteward');
    await expect(page.getByRole('heading', { level: 1, name: vi['dgv.owners.page.title'] })).toBeVisible();
    // The pickers list the active staff: the caller holds membership.read.
    await expect(page.getByTestId('members-unavailable')).toHaveCount(0);
    await expect(page.getByLabel(vi['dgv.owners.register.owner.label'], { exact: true }).locator(`option[value="${OWNER}"]`)).toHaveCount(1);

    // An empty form sends nothing: the fields say they are required and the database has nothing.
    await submitRegistration(page);
    await expect(page.locator('[data-field="register-code"]').getByText(vi['dgv.field.required.error'])).toBeVisible();
    await expect(page.locator('[data-field="register-owner"]').getByText(vi['dgv.field.required.error'])).toBeVisible();
    expect(await datasetsOf(code)).toEqual([]);

    // A critical dataset with one person as owner and steward is refused before it is sent, and the server refuses it as well.
    await fill(page, { code, title: 'Lệnh chi Kho bạc', owner: STEWARD, steward: STEWARD, critical: true });
    await submitRegistration(page);
    await expect(page.locator('[data-field="register-steward"]').getByText(vi['dgv.field.sameAsOwner.error'])).toBeVisible();
    const refused = await apiCall('dgvSteward', 'POST', '/dgv/datasets', {
      body: {
        dataset_code: code,
        title: 'Lệnh chi Kho bạc',
        domain: 'treasury',
        grain: 'one row per payment order',
        producer_module: 'PAY',
        owner_user_id: STEWARD,
        steward_user_id: STEWARD,
        classification: 'INTERNAL',
        is_critical: true,
        freshness_slo_seconds: 86_400,
      },
    });
    expect([refused.status, refused.json.code]).toEqual([422, 'OWNER_STEWARD_SAME']);
    expect(await datasetsOf(code)).toEqual([]);

    // Two different people: the dataset starts in DRAFT and the list shows it.
    await page.getByLabel(vi['dgv.owners.register.owner.label'], { exact: true }).selectOption(OWNER);
    await submitRegistration(page);
    await expect(page.getByTestId('dataset-saved')).toHaveText(vi['dgv.owners.register.saved.notice']);
    await expect(rowOf(page, code)).toBeVisible();
    await expect(rowOf(page, code).getByText(vi['dgv.status.dataset.draft.text'])).toBeVisible();
    await expect(rowOf(page, code).getByText(vi['dgv.owners.critical.yes'])).toBeVisible();
    expect(await datasetsOf(code)).toEqual([
      { dataset_code: code, status: 'DRAFT', classification: 'INTERNAL', is_critical: true, owner_user_id: OWNER, steward_user_id: STEWARD, freshness_slo_seconds: '86400', version: '1', created_by: STEWARD },
    ]);

    // The same code again is refused, and nothing is added.
    await fill(page, { code, title: 'Một dataset khác', owner: OWNER, steward: STEWARD, critical: false });
    await submitRegistration(page);
    await expect(registerForm(page).getByRole('alert').filter({ hasText: vi['dgv.problem.duplicateCode.error'] })).toBeVisible();
    expect(await datasetsOf(code)).toHaveLength(1);

    // The pair is changed for a stated reason; a short reason and a repeated person are refused before they are sent.
    await rowOf(page, code).getByRole('button', { name: vi['dgv.owners.change.action'] }).click();
    const form = page.getByRole('form', { name: vi['dgv.owners.change.title'].replace('{code}', code) });
    await form.getByLabel(vi['dgv.owners.change.owner.label'], { exact: true }).selectOption(NEW_OWNER);
    await form.getByLabel(vi['dgv.owners.change.steward.label'], { exact: true }).selectOption(NEW_OWNER);
    await form.getByLabel(vi['dgv.owners.change.reason.label'], { exact: true }).fill('ngắn');
    await form.getByRole('button', { name: vi['dgv.owners.change.confirm.action'] }).click();
    await expect(form.getByText(vi['dgv.field.sameAsOwner.error'])).toBeVisible();
    await expect(form.getByText(vi['dgv.field.tooShort.error'])).toBeVisible();
    expect((await datasetsOf(code))[0]).toMatchObject({ owner_user_id: OWNER, steward_user_id: STEWARD, version: '1' });

    // Someone else changes the dataset while the form is open: the form carries the version that was read, so the server refuses it.
    const dataset = (await sql<{ id: string }>('select id from machvon.dataset where dataset_code = $1', [code]))[0];
    const concurrent = await apiCall('dgvSteward', 'POST', `/dgv/datasets/${dataset?.id}/ownership`, {
      version: 1,
      body: { owner_user_id: NEW_STEWARD, steward_user_id: STEWARD, reason: 'Thay đổi đồng thời của người khác' },
    });
    expect(concurrent.status).toBe(200);
    await form.getByLabel(vi['dgv.owners.change.steward.label'], { exact: true }).selectOption(NEW_STEWARD);
    await form.getByLabel(vi['dgv.owners.change.reason.label'], { exact: true }).fill('Người phụ trách chuyển công tác');
    await form.getByRole('button', { name: vi['dgv.owners.change.confirm.action'] }).click();
    await expect(form.getByRole('alert').filter({ hasText: vi['dgv.problem.versionConflict.error'] })).toBeVisible();
    expect((await datasetsOf(code))[0]).toMatchObject({ owner_user_id: NEW_STEWARD, steward_user_id: STEWARD, version: '2' });

    // The list is read again, then the change goes through against version 2 and is audited with its reason.
    await open(page, 'dgv-03', 'dgvSteward');
    await rowOf(page, code).getByRole('button', { name: vi['dgv.owners.change.action'] }).click();
    await form.getByLabel(vi['dgv.owners.change.owner.label'], { exact: true }).selectOption(NEW_OWNER);
    await form.getByLabel(vi['dgv.owners.change.steward.label'], { exact: true }).selectOption(NEW_STEWARD);
    await form.getByLabel(vi['dgv.owners.change.reason.label'], { exact: true }).fill('Người phụ trách chuyển công tác');
    await form.getByRole('button', { name: vi['dgv.owners.change.confirm.action'] }).click();
    await expect(form).toBeHidden();
    expect((await datasetsOf(code))[0]).toMatchObject({ owner_user_id: NEW_OWNER, steward_user_id: NEW_STEWARD, version: '3' });
    expect(
      await sql("select count(*)::int as n from machvon.audit_event where action = 'dgv.dataset_ownership_changed' and resource_id = $1 and reason = $2 and outcome = 'SUCCESS'", [dataset?.id, 'Người phụ trách chuyển công tác']),
    ).toEqual([{ n: 1 }]);
  });

  test('a reader of the catalogue cannot change owners, and a member without the right to read gets the denied state', async ({ page }) => {
    const code = unique();
    await seedDataset(code, 'INTERNAL', []);
    await open(page, 'dgv-03', 'dgvReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['dgv.owners.page.title'] })).toBeVisible();
    await expect(rowOf(page, code)).toBeVisible();
    await expect(page.getByRole('button', { name: vi['dgv.owners.change.action'] })).toHaveCount(0);
    await expect(registerForm(page)).toHaveCount(0);

    await open(page, 'dgv-04', 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-dataset-code]')).toHaveCount(0);
  });
});

test.describe('DGV-04 data catalogue', () => {
  test('a reader sees only the datasets their roles allow, and a hidden dataset is not counted (AC-ST-DGV-001-2)', async ({ page }) => {
    const hidden = unique();
    const shown = unique();
    await seedDataset(hidden, 'PERSONAL', ['LND']);
    await seedDataset(shown, 'INTERNAL', []);
    const visibleToReader = await sql<{ n: number }>(
      `select count(*)::int as n from machvon.dataset
        where tenant_id = $1 and ((cardinality(allowed_role_codes) = 0 and classification in ('PUBLIC', 'INTERNAL')) or (cardinality(allowed_role_codes) > 0 and allowed_role_codes && array['E2E_DGV_READER']))`,
      [stackInfo().tenants.A],
    );
    const everything = await sql<{ n: number }>('select count(*)::int as n from machvon.dataset where tenant_id = $1', [stackInfo().tenants.A]);
    const expected = visibleToReader[0]?.n ?? -1;
    expect(expected).toBeLessThan(everything[0]?.n ?? 0);

    await open(page, 'dgv-04', 'dgvReader');
    await expect(page.getByRole('heading', { level: 1, name: vi['dgv.catalog.page.title'] })).toBeVisible();
    await expect(page.locator(`tr[data-dataset-code="${shown}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-dataset-code="${hidden}"]`)).toHaveCount(0);
    await expect(page.getByTestId('count')).toHaveText(vi['dgv.catalog.count.text'].replace('{count}', String(expected)));
    await expect(page.getByRole('link', { name: vi['dgv.catalog.manage.link'] })).toHaveCount(0);
    // A new dataset that nobody has assessed says so; the badge is a word, never a green mark.
    await expect(page.locator(`tr[data-dataset-code="${shown}"] [data-badge]`)).toHaveAttribute('data-badge', 'NOT_ASSESSED');

    // Looking for the hidden dataset by its code, or by its classification, finds nothing and says nothing about it.
    await page.getByLabel(vi['dgv.catalog.filter.text.label'], { exact: true }).fill(hidden);
    await page.getByRole('button', { name: vi['dgv.catalog.filter.apply.action'], exact: true }).click();
    await expect(page.getByTestId('empty-catalog')).toHaveText(vi['dgv.catalog.noMatch.text']);
    await page.getByRole('button', { name: vi['dgv.catalog.filter.clear.action'] }).click();
    await page.getByLabel(vi['dgv.catalog.filter.classification.label'], { exact: true }).selectOption('PERSONAL');
    await page.getByRole('button', { name: vi['dgv.catalog.filter.apply.action'], exact: true }).click();
    await expect(page.getByTestId('empty-catalog')).toHaveText(vi['dgv.catalog.noMatch.text']);
    await expect(page.locator('tr[data-dataset-code]')).toHaveCount(0);

    // The steward of the catalogue is not an exception: the dataset names the roles that may see it, and theirs is not among them.
    await open(page, 'dgv-04', 'dgvSteward');
    await expect(page.locator(`tr[data-dataset-code="${shown}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-dataset-code="${hidden}"]`)).toHaveCount(0);
    await expect(page.getByRole('link', { name: vi['dgv.catalog.manage.link'] })).toBeVisible();
  });
});
