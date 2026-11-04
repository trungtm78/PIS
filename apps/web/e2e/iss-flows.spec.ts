import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql } from './support/stack.ts';

/**
 * ISS-09 in a real browser against the real API and database (apps/api/test/e2e-stack): the manager of the SLA policies publishes a
 * policy for an issue category, is refused a second policy that overlaps it, publishes the next revision of the first one (which takes
 * over on its date and leaves the first revision as it was), and ends another policy from a date. What the screen changed is looked up
 * in the database.
 */

const unique = (): string => `E2E-${Date.now().toString(36).toUpperCase()}`;
const DAY_MS = 86_400_000;
/** The Vietnam date `days` days from now, the clock the screen and the API judge "in the past" by. */
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/iss/iss-09?devUser=slaManager');
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface PolicyRow {
  code: string;
  revision: number;
  status: string;
  severity: string;
  resolve_hours: number;
  valid_from: string;
  valid_until: string | null;
}

const policiesOf = (code: string): Promise<PolicyRow[]> =>
  sql('select code, revision, status, severity, resolve_hours, valid_from::text, valid_until::text from machvon.issue_sla_policy where code = $1 order by revision', [code]);

/** The options of the category choice: the key and the name of the two categories the stack seeds. */
const CATEGORY_LABELS: Record<string, string> = {
  E2E_ISSUE_CATEGORY_1: 'E2E_ISSUE_CATEGORY_1 · Giải phóng mặt bằng',
  E2E_ISSUE_CATEGORY_2: 'E2E_ISSUE_CATEGORY_2 · Chất lượng công trình',
};

interface Fields {
  code: string;
  category: string;
  severity: string;
  resolve: string;
  from: string;
}

async function fill(page: Page, fields: Fields): Promise<void> {
  await page.getByLabel(vi['iss.sla.form.code.label'], { exact: true }).fill(fields.code);
  await page.getByLabel(vi['iss.sla.form.category.label'], { exact: true }).selectOption({ label: CATEGORY_LABELS[fields.category] ?? fields.category });
  await page.getByLabel(vi['iss.sla.form.severity.label'], { exact: true }).selectOption({ label: fields.severity });
  await page.getByLabel(vi['iss.sla.form.response.label'], { exact: true }).fill('4');
  await page.getByLabel(vi['iss.sla.form.resolve.label'], { exact: true }).fill(fields.resolve);
  await page.getByLabel(vi['iss.sla.form.validFrom.label'], { exact: true }).fill(fields.from);
}

const publish = (page: Page) => page.getByRole('button', { name: vi['iss.sla.save.action'] }).click();

test.describe('ISS-09 SLA policies', () => {
  test('the manager publishes a policy, an overlapping one is refused, and the next revision takes over on its date (AC-ST-ISS-001-2)', async ({ page }) => {
    const code = unique();
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: vi['iss.sla.page.title'] })).toBeVisible();
    // The two categories the stack seeds are offered (other tests may have added categories of their own).
    for (const label of Object.values(CATEGORY_LABELS)) {
      await expect(page.getByLabel(vi['iss.sla.form.category.label'], { exact: true }).locator('option').filter({ hasText: label })).toHaveCount(1);
    }

    // An empty form sends nothing: every field says it is required and the database has nothing.
    await publish(page);
    await expect(page.locator('[data-field="sla-code"]').getByText(vi['iss.field.required.error'])).toBeVisible();
    await expect(page.locator('[data-field="sla-category"]').getByText(vi['iss.field.required.error'])).toBeVisible();
    expect(await policiesOf(code)).toEqual([]);

    // A policy of two working days (16 hours) for the first category.
    await fill(page, { code, category: 'E2E_ISSUE_CATEGORY_1', severity: vi['iss.severity.high.text'], resolve: '16', from: inDays(2) });
    await publish(page);
    await expect(page.getByTestId('policy-saved')).toBeVisible();
    const row = page.locator('tr[data-group-key]', { hasText: 'E2E_ISSUE_CATEGORY_1' });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-phase', 'scheduled');
    expect(await policiesOf(code)).toEqual([{ code, revision: 1, status: 'ACTIVE', severity: 'HIGH', resolve_hours: 16, valid_from: inDays(2), valid_until: null }]);

    // A second policy for the same category, severity and unit is refused and nothing is written.
    const other = unique();
    await fill(page, { code: other, category: 'E2E_ISSUE_CATEGORY_1', severity: vi['iss.severity.high.text'], resolve: '20', from: inDays(3) });
    await publish(page);
    await expect(page.getByRole('alert').filter({ hasText: vi['iss.problem.overlap.error'] })).toBeVisible();
    expect(await policiesOf(other)).toEqual([]);

    // The next revision of the first policy takes over on its date; the first revision is ended there and keeps what it said.
    await fill(page, { code, category: 'E2E_ISSUE_CATEGORY_1', severity: vi['iss.severity.high.text'], resolve: '12', from: inDays(10) });
    await publish(page);
    await expect(page.getByTestId('policy-saved')).toBeVisible();
    expect(await policiesOf(code)).toEqual([
      { code, revision: 1, status: 'RETIRED', severity: 'HIGH', resolve_hours: 16, valid_from: inDays(2), valid_until: inDays(10) },
      { code, revision: 2, status: 'ACTIVE', severity: 'HIGH', resolve_hours: 12, valid_from: inDays(10), valid_until: null },
    ]);
    await row.getByRole('button', { name: vi['iss.sla.history.action'] }).click();
    await expect(page.getByTestId('history').locator('tr[data-revision]')).toHaveCount(2);
    await expect(page.getByTestId('history').locator('tr[data-revision]').first()).toHaveAttribute('data-revision', '2');
  });

  test('the manager ends a policy from a date, and a date before it began is refused (AC-ST-ISS-001-2)', async ({ page }) => {
    const code = unique();
    await open(page);
    await fill(page, { code, category: 'E2E_ISSUE_CATEGORY_2', severity: vi['iss.severity.low.text'], resolve: '24', from: inDays(5) });
    await publish(page);
    await expect(page.getByTestId('policy-saved')).toBeVisible();
    const row = page.locator('tr[data-group-key]', { hasText: 'E2E_ISSUE_CATEGORY_2' });
    await row.getByRole('button', { name: vi['iss.sla.retire.action'] }).click();
    const form = page.getByRole('form', { name: vi['iss.sla.retire.title'].replace('{code}', code) });
    await form.getByLabel(vi['iss.sla.retire.until.label'], { exact: true }).fill(inDays(5));
    await form.getByRole('button', { name: vi['iss.sla.retire.confirm.action'] }).click();
    await expect(form.getByText(vi['iss.field.untilOrder.error'])).toBeVisible();
    expect((await policiesOf(code))[0]?.status).toBe('ACTIVE');
    await form.getByLabel(vi['iss.sla.retire.until.label'], { exact: true }).fill(inDays(30));
    await form.getByRole('button', { name: vi['iss.sla.retire.confirm.action'] }).click();
    await expect(form).toBeHidden();
    expect(await policiesOf(code)).toEqual([{ code, revision: 1, status: 'RETIRED', severity: 'LOW', resolve_hours: 24, valid_from: inDays(5), valid_until: inDays(30) }]);
  });
});
