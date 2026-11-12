import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DESKTOP, PHONE, seriousViolations } from './support/axe-page.ts';

/**
 * UAT-RPT-A11-01: the four report screens against the real stack of the enterprise edition, judged by axe (colour contrast included) at 1280 px and 360 px. The draft taken
 * through the three people (prepared, checked, approved, issued) with the keyboard alone, the preview as a table and the states of the flow are judged with data by
 * src/screens/rpt/uatcase-a11y.test.tsx: the stack has one person who may do all steps, and the product refuses one person two of them.
 */

async function open(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${path}?devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

test.describe('UAT-RPT-A11-01 the report screens', () => {
  for (const [name, size] of [['1280 px', DESKTOP], ['360 px', PHONE]] as const) {
    test(`UAT-RPT-A11-01 RPT-01 to RPT-04 at ${name} have 0 serious or critical axe violations`, async ({ page }) => {
      for (const [screen, path] of [['RPT-01', '/rpt/rpt-01'], ['RPT-02', '/rpt/rpt-02'], ['RPT-03', '/rpt/rpt-03'], ['RPT-04', '/rpt/rpt-04']] as const) {
        await open(page, path, size);
        expect(await seriousViolations(page), `${screen} at ${name}`).toEqual([]);
      }
    });
  }

  test('UAT-RPT-A11-01 the catalogue form button is reached with Tab and opens its dialog with Enter, which Escape leaves with the focus back on the button', async ({ page }) => {
    await open(page, '/rpt/rpt-01', DESKTOP);
    const generate = page.locator('[data-testid^="generate-"]').first();
    await expect(generate).toBeVisible();
    await page.locator('h1').first().evaluate((heading) => {
      heading.setAttribute('tabindex', '-1');
      (heading as HTMLElement).focus();
    });
    for (let stop = 0; stop < 80 && !(await generate.evaluate((element) => element === document.activeElement)); stop += 1) await page.keyboard.press('Tab');
    await expect(generate).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(generate).toBeFocused();
  });

  test('negative control: the axe check reports an image without a text alternative', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('image-alt');
  });
});
