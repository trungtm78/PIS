import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql } from './support/stack.ts';

/**
 * CAP-17 in a real browser against the real API and database (apps/api/test/e2e-stack): the administrator drafts the thresholds of a policy (a warning above the block or a block
 * above 100 is refused before anything is sent), another person publishes it, a person who holds both rights is not offered their own draft, a policy that overlaps another of the
 * same scope is refused with the reason, and a reader sees the policies and the counts but no form. What a screen changed is looked up in the database.
 */

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`/cap/cap-17?devUser=${user}`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForSelector('.cap-avc');
}

const form = (page: Page) => page.getByRole('form', { name: vi['cap.avc.form.aria'] });
const fieldOf = (page: Page, label: string) => form(page).getByLabel(label, { exact: true });
const rowOf = (page: Page, code: string) => page.locator('tr[data-policy-id]', { hasText: code });

async function draft(page: Page, values: { code: string; group?: string; warn?: string; block?: string; from: string; until?: string }): Promise<void> {
  await fieldOf(page, vi['cap.avc.form.code.label']).fill(values.code);
  await fieldOf(page, vi['cap.avc.form.scopeKind.label']).selectOption('PROJECT_GROUP');
  await fieldOf(page, vi['cap.avc.form.scopeGroup.label']).selectOption(values.group ?? 'A');
  await fieldOf(page, vi['cap.avc.form.warn.label']).fill(values.warn ?? '90');
  await fieldOf(page, vi['cap.avc.form.block.label']).fill(values.block ?? '100');
  await fieldOf(page, vi['cap.avc.form.basis.label']).fill('Quyet dinh 12/QD-UBND ve kiem soat von');
  await fieldOf(page, vi['cap.avc.form.from.label']).fill(values.from);
  if (values.until !== undefined) await fieldOf(page, vi['cap.avc.form.until.label']).fill(values.until);
  await form(page).getByRole('button', { name: vi['cap.avc.form.submit.action'] }).click();
}

const policyOf = async (code: string) =>
  (
    await sql<{ id: string; status: string; created_by: string; approved_by: string | null; warn_pct: string; block_pct: string; effective_until: string | null; revision: number }>(
      'select id, status, created_by, approved_by, warn_pct::text as warn_pct, block_pct::text as block_pct, effective_until::text as effective_until, revision from machvon.avc_policy where policy_code = $1 order by revision desc limit 1',
      [code],
    )
  )[0];

test.describe('CAP-17: the availability control policy', () => {
  test('the administrator drafts a policy and the thresholds are checked before anything is sent; another person publishes it (AC-ST-CAP-005-2)', async ({ page }) => {
    const code = `AVC-E2E-${Date.now().toString(36)}`.toUpperCase();
    await open(page, 'avcAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.avc.page.title'] })).toBeVisible();
    await expect(page.getByRole('img', { name: vi['cap.avc.bars.aria'].replace('{warn}', '90').replace('{block}', '100') })).toBeVisible();

    // A warning above the block, and a block above 100, are refused in the form, in words, and nothing is written.
    await draft(page, { code, warn: '95', block: '90', from: '2030-01-01', until: '2030-12-31' });
    await expect(form(page).getByText(vi['cap.avc.field.warnAboveBlock'])).toBeVisible();
    await fieldOf(page, vi['cap.avc.form.warn.label']).fill('90');
    await fieldOf(page, vi['cap.avc.form.block.label']).fill('101');
    await expect(form(page).getByText(vi['cap.avc.field.above100'])).toBeVisible();
    expect(await policyOf(code)).toBeUndefined();

    // The two thresholds are drawn and said in words.
    await fieldOf(page, vi['cap.avc.form.warn.label']).fill('85');
    await fieldOf(page, vi['cap.avc.form.block.label']).fill('95');
    await expect(page.getByText(vi['cap.avc.bars.warn'].replace('{warn}', '85').replace('{block}', '95'))).toBeVisible();
    await form(page).getByRole('button', { name: vi['cap.avc.form.submit.action'] }).click();
    await expect(page.getByText(vi['cap.avc.done.created'].replace('{code}', code).replace('{revision}', '1'))).toBeVisible();
    const made = await policyOf(code);
    expect(made).toMatchObject({ status: 'DRAFT', created_by: membershipOf('avcAdmin'), approved_by: null, warn_pct: '85.00', block_pct: '95.00', revision: 1 });
    await expect(rowOf(page, code)).toContainText(vi['cap.avc.status.draft']);
    // The administrator holds no right to publish: no button.
    await expect(rowOf(page, code).getByRole('button', { name: vi['cap.avc.row.publish.action'] })).toHaveCount(0);

    // Another person publishes it.
    await open(page, 'avcApprover');
    await expect(form(page)).toHaveCount(0);
    await rowOf(page, code).getByRole('button', { name: vi['cap.avc.row.publish.action'] }).click();
    await expect(page.getByText(vi['cap.avc.done.published'].replace('{code}', code).replace('{revision}', '1'))).toBeVisible();
    await expect(rowOf(page, code)).toContainText(vi['cap.avc.status.published']);
    expect(await policyOf(code)).toMatchObject({ status: 'PUBLISHED', approved_by: membershipOf('avcApprover') });
    const events = await sql<{ n: string }>("select count(*)::text as n from machvon.outbox_event where aggregate_id = $1::uuid and type = 'capital.avc_policy_published.v1'", [made?.id]);
    expect(events[0]?.n).toBe('1');
  });

  test('a person who holds both rights is not offered their own draft, and a policy that overlaps another of the same scope is refused with the reason', async ({ page }) => {
    const label = Date.now().toString(36).toUpperCase();
    await open(page, 'avcSolo');
    await draft(page, { code: `SOLO-${label}`, group: 'B', from: '2031-01-01', until: '2031-12-31' });
    await expect(page.getByText(vi['cap.avc.done.created'].replace('{code}', `SOLO-${label}`).replace('{revision}', '1'))).toBeVisible();
    await expect(rowOf(page, `SOLO-${label}`).getByRole('button', { name: vi['cap.avc.row.publish.action'] })).toHaveCount(0);

    // Two drafts of one scope and period: the second cannot be published once the first is.
    await draft(page, { code: `RIVAL-${label}`, group: 'B', from: '2031-06-01', until: '2031-09-30' });
    await expect(page.getByText(vi['cap.avc.done.created'].replace('{code}', `RIVAL-${label}`).replace('{revision}', '1'))).toBeVisible();
    await open(page, 'avcApprover');
    await rowOf(page, `SOLO-${label}`).getByRole('button', { name: vi['cap.avc.row.publish.action'] }).click();
    await expect(page.getByText(vi['cap.avc.done.published'].replace('{code}', `SOLO-${label}`).replace('{revision}', '1'))).toBeVisible();
    await rowOf(page, `RIVAL-${label}`).getByRole('button', { name: vi['cap.avc.row.publish.action'] }).click();
    await expect(page.getByRole('alert')).toContainText(vi['cap.avc.problem.overlap']);
    expect((await policyOf(`RIVAL-${label}`))?.status).toBe('DRAFT');
  });

  test('the preview counts the lines in each state in words, and a reader sees the policies but has no form', async ({ page }) => {
    const code = `SEE-${Date.now().toString(36).toUpperCase()}`;
    await open(page, 'avcAdmin');
    await draft(page, { code, group: 'C', from: '2032-01-01', until: '2032-12-31' });
    await expect(page.getByText(vi['cap.avc.done.created'].replace('{code}', code).replace('{revision}', '1'))).toBeVisible();
    await open(page, 'avcReader');
    await expect(form(page)).toHaveCount(0);
    await expect(page.getByText(vi['cap.avc.form.denied'])).toBeVisible();
    await expect(page.locator('tr[data-policy-id]').first()).toBeVisible();
    // The reader holds capital.read on the whole tenant, which is the authority the counts need: the counts are shown, in words, and add up.
    const preview = page.getByTestId('preview');
    await expect(preview.locator('[data-state="total"]')).toBeVisible();
    const numbers = await Promise.all(['ok', 'warn', 'block'].map(async (state) => Number(((await preview.locator(`[data-state="${state}"]`).textContent()) ?? '').match(/\d+/)?.[0])));
    const total = Number(((await preview.locator('[data-state="total"]').textContent()) ?? '').match(/\d+/)?.[0]);
    expect(numbers.reduce((sum, value) => sum + value, 0)).toBe(total);
  });
});
