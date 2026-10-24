import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql } from './support/stack.ts';

/**
 * PMT-03 in a real browser against the real API and database (apps/api/test/e2e-stack): the tenant owner (who holds every tenant
 * permission) publishes a permit type with its legal basis, publishes the next revision of the same code, is refused an overlapping
 * period, and ends a version. What the screen changed is looked up in the database.
 */

const unique = (): string => `E2E_${Date.now().toString(36).toUpperCase()}`;
const DAY_MS = 86_400_000;
/** The Vietnam date `days` days from now, the clock the screen and the API judge "in the past" by. */
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/pmt/pmt-03?devUser=owner');
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface VersionRow {
  revision: number;
  status: string;
  effective_from: string;
  effective_until: string | null;
  cxn_ref: string | null;
  legal_basis: string;
}

const versionsOf = (code: string): Promise<VersionRow[]> =>
  sql(
    'select revision, status, effective_from::text, effective_until::text, cxn_ref, legal_basis from machvon.permit_type where code = $1 order by revision',
    [code],
  );

async function fill(page: Page, code: string, fields: { name?: string; legalBasis?: string; cxn?: string; from: string; until?: string }): Promise<void> {
  await page.getByLabel(vi['pmt.type.form.code.label']).fill(code);
  await page.getByLabel(vi['pmt.type.form.name.label']).fill(fields.name ?? 'Giấy phép kiểm thử e2e');
  await page.getByLabel(vi['pmt.type.form.authority.label']).fill('Sở Xây dựng');
  if (fields.legalBasis !== undefined) await page.getByLabel(vi['pmt.type.form.legalBasis.label']).fill(fields.legalBasis);
  if (fields.cxn !== undefined) await page.getByLabel(vi['pmt.type.form.cxn.label']).fill(fields.cxn);
  await page.getByLabel(vi['pmt.type.form.effectiveFrom.label']).fill(fields.from);
  if (fields.until !== undefined) await page.getByLabel(vi['pmt.type.form.effectiveUntil.label']).fill(fields.until);
}

const publish = (page: Page) => page.getByRole('button', { name: vi['pmt.type.save.action'] }).click();
const rowOf = (page: Page, code: string) => page.locator(`tr[data-group-code="${code}"]`);

test.describe('PMT-03 permit type catalogue', () => {
  test('the owner publishes a type with its legal basis, the next revision takes over, and an overlapping period is refused (AC-ST-PMT-001-1)', async ({ page }) => {
    const code = unique();
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: vi['pmt.type.page.title'] })).toBeVisible();

    // Without a legal basis nothing is sent: the field says it is required and the database has nothing.
    await fill(page, code, { from: '2026-01-01' });
    await publish(page);
    await expect(page.locator('[data-field="type-legal-basis"]').getByText(vi['pmt.field.required.error'])).toBeVisible();
    expect(await versionsOf(code)).toEqual([]);

    // With one it is published, and a type that waits for its confirmation says so.
    await page.getByLabel(vi['pmt.type.form.legalBasis.label']).fill('Luật Xây dựng 135/2025, điều 43');
    await page.getByLabel(vi['pmt.type.form.cxn.label']).fill('CXN-EXE-02');
    await publish(page);
    await expect(page.getByTestId('type-saved')).toBeVisible();
    const first = rowOf(page, code);
    await expect(first).toBeVisible();
    await expect(first.getByTestId('unconfirmed')).toHaveText('Chờ xác nhận CXN-EXE-02');
    expect(await versionsOf(code)).toEqual([
      { revision: 1, status: 'PUBLISHED', effective_from: '2026-01-01', effective_until: null, cxn_ref: 'CXN-EXE-02', legal_basis: 'Luật Xây dựng 135/2025, điều 43' },
    ]);

    // The next revision of the same code, confirmed (no reference), takes over from its first day and ends the one before the day before.
    const takeOver = inDays(30);
    await fill(page, code, { legalBasis: 'Nghị định 217/2026, điều 3', from: takeOver });
    await expect(page.getByTestId('next-revision')).toBeVisible();
    await publish(page);
    await expect(page.getByTestId('type-saved')).toBeVisible();
    expect(await versionsOf(code)).toEqual([
      { revision: 1, status: 'RETIRED', effective_from: '2026-01-01', effective_until: inDays(29), cxn_ref: 'CXN-EXE-02', legal_basis: 'Luật Xây dựng 135/2025, điều 43' },
      { revision: 2, status: 'PUBLISHED', effective_from: takeOver, effective_until: null, cxn_ref: null, legal_basis: 'Nghị định 217/2026, điều 3' },
    ]);
    // The row shows the version in force today (the first); its history lists both, newest first.
    await first.getByRole('button', { name: vi['pmt.type.history.action'] }).click();
    await expect(page.getByTestId('history').locator('tr[data-revision]')).toHaveCount(2);
    await expect(page.getByTestId('history').locator('tr[data-revision]').first()).toHaveAttribute('data-revision', '2');

    // A period that overlaps the last revision is refused by the server and changes nothing.
    await fill(page, code, { legalBasis: 'Văn bản trùng thời gian', from: inDays(10) });
    await publish(page);
    await expect(page.getByRole('alert').filter({ hasText: vi['pmt.problem.overlap.error'] })).toBeVisible();
    expect(await versionsOf(code)).toHaveLength(2);
  });

  test('the owner ends a version on its last day, the row stays, and a later end is refused', async ({ page }) => {
    const code = unique();
    await open(page);
    await fill(page, code, { legalBasis: 'Luật Bảo vệ môi trường 2020', from: '2026-01-01' });
    await publish(page);
    await expect(page.getByTestId('type-saved')).toBeVisible();

    const lastDay = inDays(90);
    await rowOf(page, code).getByRole('button', { name: vi['pmt.type.retire.action'] }).click();
    const form = page.getByRole('form', { name: vi['pmt.type.retire.title'].replace('{code}', code) });
    await form.getByLabel(vi['pmt.type.retire.until.label']).fill('2026-01-01');
    await form.getByRole('button', { name: vi['pmt.type.retire.confirm.action'] }).click();
    await expect(form.getByText(vi['pmt.field.untilOrder.error'])).toBeVisible();
    await form.getByLabel(vi['pmt.type.retire.until.label']).fill(lastDay);
    await form.getByRole('button', { name: vi['pmt.type.retire.confirm.action'] }).click();
    await expect(form).toBeHidden();
    await expect(rowOf(page, code).getByText(`2026-01-01 → ${lastDay}`)).toBeVisible();
    expect((await versionsOf(code))[0]).toMatchObject({ revision: 1, status: 'RETIRED', effective_until: lastDay });

    // The end only moves earlier: the same form refuses a later day before it asks the server.
    await rowOf(page, code).getByRole('button', { name: vi['pmt.type.retire.action'] }).click();
    await form.getByLabel(vi['pmt.type.retire.until.label']).fill(inDays(120));
    await form.getByRole('button', { name: vi['pmt.type.retire.confirm.action'] }).click();
    await expect(form.getByText(vi['pmt.field.laterEnd.error'])).toBeVisible();
  });
});
