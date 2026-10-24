import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql } from './support/stack.ts';

/**
 * SAS-06, the plan catalogue (ST-SAS-007), in a real browser against the real API and database (apps/api/test/e2e-stack): the system
 * administrator writes a plan version, publishes it and writes its next revision; a Published version never changes; an operator who does
 * not manage billing is refused. Fixture control users are picked with `?devUser=`.
 */

const unique = (): string => Date.now().toString(36);

async function openCatalogue(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sas/sas-06?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const label = (key: keyof typeof vi, row?: number): string => (row === undefined ? vi[key] : vi[key].replace('{row}', String(row)));
const rowOf = (page: Page, code: string, revision: number) => page.locator('tr[data-plan-id]', { hasText: vi['sas.plan.row.code'].replace('{code}', code).replace('{revision}', String(revision)) });

interface PlanRow {
  id: string;
  revision: number;
  status: string;
  base_price_vnd: string;
  version: string;
  published_by: string | null;
}

const plansOf = (code: string): Promise<PlanRow[]> =>
  sql<PlanRow>('select id, revision, status, base_price_vnd::text as base_price_vnd, version::text as version, published_by from machvon.product_plan_version where plan_code = $1 order by revision', [code]);

test.describe('SAS-06 plan catalogue', () => {
  test('lists the seeded plan with its feature matrix', async ({ page }) => {
    await openCatalogue(page, 'sysAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.plan.page.title'] })).toBeVisible();
    const standard = page.locator('tr[data-plan-id]', { hasText: 'STANDARD' }).first();
    await expect(standard).toContainText(vi['sas.plan.standard.name']);
    await expect(standard).toContainText(vi['sas.plan.status.published']);
    await standard.getByRole('button', { name: vi['sas.plan.row.features.action'] }).click();
    const matrix = page.getByTestId('matrix');
    const seats = matrix.locator('tr[data-feature="member.seats"]');
    await expect(seats).toContainText(vi['sas.entitlements.feature.memberSeats']);
    await expect(seats).toContainText(vi['sas.plan.kind.quota']);
    await expect(seats).toContainText('50');
    await expect(matrix.locator('tr[data-feature="ai.analysis"]')).toContainText(vi['sas.plan.limit.off']);
    await expect(matrix.locator('tr[data-feature="export"]')).toContainText(vi['sas.plan.expired.exportOnly']);
  });

  test('writes a draft, publishes it with a reason, and writes the next revision without touching the published one (UAT-AC154)', async ({ page }) => {
    const code = `e2e-plan-${unique()}`;
    await openCatalogue(page, 'sysAdmin');
    const form = page.getByRole('form', { name: vi['sas.plan.form.aria'] });

    // What breaks a rule of the plan never leaves the browser.
    await form.getByLabel(vi['sas.plan.form.code.label'], { exact: true }).fill('Bad_Code');
    await form.getByRole('button', { name: vi['sas.plan.form.submit.action'] }).click();
    await expect(form.getByText(vi['sas.plan.field.format'])).toBeVisible();
    expect(await plansOf('Bad_Code')).toHaveLength(0);

    await form.getByLabel(vi['sas.plan.form.code.label'], { exact: true }).fill(code);
    await form.getByLabel(vi['sas.plan.form.name.label'], { exact: true }).fill('Gói kiểm thử e2e');
    await form.getByLabel(vi['sas.plan.form.price.label'], { exact: true }).fill('1500000');
    await form.getByLabel(vi['sas.plan.form.terms.label'], { exact: true }).fill('TERMS-E2E-1');
    await form.getByLabel(vi['sas.plan.cycle.monthly'], { exact: true }).check();
    await form.getByRole('button', { name: vi['sas.plan.edit.add.action'] }).click();
    await form.getByLabel(label('sas.plan.edit.code.aria', 2), { exact: true }).selectOption('member.seats');
    await form.getByLabel(label('sas.plan.edit.kind.aria', 2), { exact: true }).selectOption('QUOTA');
    await form.getByLabel(label('sas.plan.edit.limit.aria', 2), { exact: true }).fill('25');
    await form.getByLabel(label('sas.plan.edit.grace.aria', 2), { exact: true }).selectOption('READ_ONLY');
    await form.getByLabel(label('sas.plan.edit.expired.aria', 2), { exact: true }).selectOption('DENY');
    await form.getByRole('button', { name: vi['sas.plan.form.submit.action'] }).click();
    await expect(page.getByText(vi['sas.plan.done.created'].replace('{code}', code))).toBeVisible();

    const first = rowOf(page, code, 1);
    await expect(first).toContainText(vi['sas.plan.status.draft']);
    await expect(first).toContainText(`${(1500000).toLocaleString('vi')}`);
    const [draft] = await plansOf(code);
    expect(draft).toMatchObject({ revision: 1, status: 'Draft', base_price_vnd: '1500000', version: '1', published_by: null });
    expect(await sql('select feature_code, limit_kind, trim_scale(limit_value)::text as limit_value from machvon.plan_feature where plan_version_id = $1 order by feature_code', [draft?.id])).toEqual([
      { feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '25' },
      { feature_code: 'reporting', limit_kind: 'BOOLEAN', limit_value: null },
    ]);

    // Publication asks for the reason and says the version will never change.
    await first.getByRole('button', { name: vi['sas.plan.row.publish.action'] }).click();
    const confirm = page.getByRole('form', { name: vi['sas.plan.publish.aria'] });
    await expect(confirm.getByText(vi['sas.plan.publish.rule'])).toBeVisible();
    await confirm.getByLabel(vi['sas.plan.publish.reason.label'], { exact: true }).fill('short');
    await confirm.getByRole('button', { name: vi['sas.plan.publish.confirm.action'] }).click();
    await expect(confirm.getByText(vi['sas.plan.publish.reason.tooShort'])).toBeVisible();
    expect((await plansOf(code))[0]?.status).toBe('Draft');
    await confirm.getByLabel(vi['sas.plan.publish.reason.label'], { exact: true }).fill('The price list of the agency was approved.');
    await confirm.getByRole('button', { name: vi['sas.plan.publish.confirm.action'] }).click();
    await expect(page.getByText(vi['sas.plan.done.published'].replace('{code}', code).replace('{revision}', '1'))).toBeVisible();
    await expect(first).toContainText(vi['sas.plan.status.published']);
    await expect(first.getByRole('button', { name: vi['sas.plan.row.publish.action'] })).toHaveCount(0);
    const published = (await plansOf(code))[0];
    expect(published).toMatchObject({ status: 'Published', version: '2', published_by: membershipOf('sysAdmin') });
    expect(await sql("select action from machvon.audit_event where resource_id = $1 and outcome = 'SUCCESS' order by occurred_at", [published?.id])).toEqual([{ action: 'plan.draft_created' }, { action: 'plan.published' }]);
    // The database refuses to change it, whatever asked.
    await expect(sql('update machvon.product_plan_version set base_price_vnd = 1 where id = $1', [published?.id])).rejects.toThrow(/immutable/);

    // The next revision starts from the published one and leaves it as it was.
    await first.getByRole('button', { name: vi['sas.plan.row.revise.action'] }).click();
    await expect(form.getByLabel(vi['sas.plan.form.code.label'], { exact: true })).toHaveValue(code);
    await expect(form.getByLabel(vi['sas.plan.form.price.label'], { exact: true })).toHaveValue('1500000');
    await form.getByLabel(vi['sas.plan.form.price.label'], { exact: true }).fill('2000000');
    await form.getByRole('button', { name: vi['sas.plan.form.submit.action'] }).click();
    const second = rowOf(page, code, 2);
    await expect(second).toContainText(vi['sas.plan.status.draft']);
    await expect(second).toContainText(`${(2000000).toLocaleString('vi')}`);
    expect(await plansOf(code)).toEqual([
      { id: published?.id, revision: 1, status: 'Published', base_price_vnd: '1500000', version: '2', published_by: membershipOf('sysAdmin') },
      expect.objectContaining({ revision: 2, status: 'Draft', base_price_vnd: '2000000', version: '1', published_by: null }),
    ]);
  });

  test('refuses an operator who does not manage billing', async ({ page }) => {
    await openCatalogue(page, 'operator');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByRole('form', { name: vi['sas.plan.form.aria'] })).toHaveCount(0);
  });
});
