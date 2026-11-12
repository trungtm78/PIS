import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DESKTOP, PHONE, seriousViolations } from './support/axe-page.ts';

/**
 * HPM A11Y: the two screens of the push of reports to HPM against the real stack of the enterprise edition, judged by axe (colour contrast included) at 1280 px and 360 px,
 * with the keyboard moving through the page. The case itself stays with a person for what a screen reader says aloud; the populated states, the order of Tab and the dialog
 * are judged by src/editions/enterprise/screens/hpm/uatcase-a11y.test.tsx.
 */

// The two screens belong to the enterprise edition only: the block is registered only when the stack serves it (a public run has no such test instead of a skipped one).
const ENTERPRISE = (process.env.MACHVON_EDITION ?? process.env.VITE_EDITION) === 'enterprise';
type DescribeBlock = (title: string, body: () => void) => void;
const noBlock: DescribeBlock = () => undefined;
const describeEnterprise: DescribeBlock = ENTERPRISE ? test.describe : noBlock;

async function open(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${path}?devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

describeEnterprise('HPM screens in the enterprise edition, accessibility', () => {
  for (const [name, size] of [['1280 px', DESKTOP], ['360 px', PHONE]] as const) {
    test(`HPM A11Y HPM-01 and HPM-02 at ${name} have 0 serious or critical axe violations`, async ({ page }) => {
      for (const [screen, path] of [['HPM-01', '/hpm/hpm-01'], ['HPM-02', '/hpm/hpm-02']] as const) {
        await open(page, path, size);
        expect(await seriousViolations(page), `${screen} at ${name}`).toEqual([]);
      }
    });
  }

  test('HPM A11Y the PENDING-EXTERNAL band of HPM-01 is text in the accessibility tree, not an image or a pseudo-element', async ({ page }) => {
    await open(page, '/hpm/hpm-01', DESKTOP);
    const band = page.getByTestId('pending-list');
    await expect(band).toBeVisible();
    expect((await band.innerText()).trim().length).toBeGreaterThan(0);
    expect(await band.evaluate((element) => element.closest('[aria-hidden="true"]') === null)).toBe(true);
  });

  test('negative control: the axe check reports a link without a name', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><a href="#x"></a></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('link-name');
  });
});
