import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };

/**
 * ADM-05 (shared catalogues) in a real browser against the real API and database (apps/api/test/e2e-stack): the tenant owner reads the entries
 * master data holds, narrows them by type, and follows the links to the master data screens; someone who may not read master data is denied. The
 * screen writes nothing: every change is a command of master data (MDM).
 */

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/adm/adm-05?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

test.describe('ADM-05 shared catalogues', () => {
  test('the owner reads the entries of master data, narrows them by type and follows the links to the screens of master data (AC-ST-ADM-019-1)', async ({ page }) => {
    await open(page, 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.catalogues.page.title'] })).toBeVisible();
    const cards = page.locator('[data-type-card]');
    expect(await cards.count()).toBeGreaterThan(3);
    // Every catalogue card links to the master data screen of its type or to the hub filtered on it.
    const firstCard = cards.first();
    const type = (await firstCard.getAttribute('data-type-card')) as string;
    const target = (await firstCard.getByTestId('open-catalogue').getAttribute('href')) as string;
    expect(target.startsWith('/mdm/mdm-')).toBe(true);

    const all = await page.locator('tbody tr').count();
    await page.getByLabel(vi['adm.catalogues.type.label'], { exact: true }).selectOption(type);
    const narrowed = await page.locator('tbody tr').count();
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowed).toBeLessThanOrEqual(all);
    for (const cell of await page.locator('tbody tr td:first-child').allTextContents()) expect(cell).toBe(type);

    // The entry opens its detail on the master data screen; the hub and the catalogue open too.
    await page.locator('tbody tr').first().getByTestId('open-entry').click();
    await expect(page).toHaveURL(/\/mdm\/mdm-27\?/);
    await open(page, 'owner');
    await page.getByTestId('hub-link').click();
    await expect(page).toHaveURL(/\/mdm\/mdm-01/);
    await open(page, 'owner');
    await page.locator('[data-type-card]').first().getByTestId('open-catalogue').click();
    await page.waitForURL((url) => `${url.pathname}${url.search}`.startsWith(target.split("&")[0] as string));
  });

  test('someone who may not read master data is denied and sees none of its entries', async ({ page }) => {
    await open(page, 'planReader');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('[data-type-card]')).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});
