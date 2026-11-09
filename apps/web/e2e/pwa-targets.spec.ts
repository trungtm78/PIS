import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Every link and button a person taps on the screens of the manager application (PWA-01 to PWA-10) is at least 44 px high (the phone guideline of
 * design.md; the token `touch.ios_pt`), at the two widths of a phone, and the page does not scroll sideways. The screens reuse cards of the web screens
 * (the figures, the alert band), so this reads the rendered boxes instead of trusting the classes.
 */
const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
] as const;
const SCREENS = [
  ['/m', 'PWA-01'],
  ['/m/approvals', 'PWA-02'],
  ['/m/dashboard', 'PWA-03'],
  ['/m/directives', 'PWA-04'],
  ['/m/settings', 'PWA-07'],
  ['/m/dashboard/detail', 'PWA-08'],
  ['/m/progress', 'PWA-09'],
  ['/m/notifications', 'PWA-10'],
] as const;
const TOUCH_TARGET = 44;
const AXE_SOURCE = createRequire(import.meta.url).resolve('axe-core');

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${path}?devUser=owner`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
  await page.waitForLoadState('networkidle');
}

for (const viewport of VIEWPORTS) {
  test.describe(`touch targets of the manager application at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const [path, screen] of SCREENS) {
      test(`${screen} ${path}: every link and button is at least ${TOUCH_TARGET} px high and nothing scrolls sideways`, async ({ page }) => {
        await open(page, path);
        await expect(page.locator(`[data-screen-id="${screen}"]`)).toBeVisible();
        const small = await page.evaluate((minimum) => {
          const seen = new Set<Element>();
          const found: string[] = [];
          for (const element of document.querySelectorAll<HTMLElement>('main a[href], main button, [data-screen-id] a[href], [data-screen-id] button')) {
            if (seen.has(element) || element.offsetParent === null) continue;
            seen.add(element);
            const box = element.getBoundingClientRect();
            if (box.height > 0 && box.height < minimum) found.push(`${element.tagName.toLowerCase()}.${element.className} "${(element.textContent ?? '').trim().slice(0, 30)}": ${Math.round(box.height)}px`);
          }
          return found;
        }, TOUCH_TARGET);
        expect(small).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      });

      // ENT-PWA-01: a table that scrolls on a phone is a region the keyboard reaches; no screen holds a second, unfocusable scroller.
      test(`${screen} ${path}: no scrollable region is out of reach of the keyboard`, async ({ page }) => {
        await open(page, path);
        await expect(page.locator(`[data-screen-id="${screen}"]`)).toBeVisible();
        await page.addScriptTag({ path: AXE_SOURCE });
        const found = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run(c: Document, o: object): Promise<{ violations: Array<{ nodes: Array<{ target: unknown[] }> }> }> } }).axe;
          const result = await axe.run(document, { runOnly: { type: 'rule', values: ['scrollable-region-focusable'] }, resultTypes: ['violations'] });
          return result.violations.flatMap((violation) => violation.nodes.map((node) => node.target.join(' ')));
        });
        expect(found).toEqual([]);
      });
    }
  });
}
