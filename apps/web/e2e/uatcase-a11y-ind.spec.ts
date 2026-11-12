import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { DESKTOP, PHONE, seriousViolations } from './support/axe-page.ts';
import { pressButton, startAtTitle, typeInto } from './support/keyboard.ts';

/**
 * UAT-IND-A11-01: the three indicator screens against the real stack of the enterprise edition, judged by axe (colour contrast included) at 1280 px and 360 px, and the trial run of
 * numbers on IND-02 done with the keyboard alone: a wrong number is tied to its field by aria-describedby and the verdict is announced as a status. The locked cell of a derived
 * indicator, the figure entry and the mapping table with data are judged by src/screens/ind/uatcase-a11y.test.tsx.
 */

async function open(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${path}?devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

test.describe('UAT-IND-A11-01 the indicator screens', () => {
  for (const [name, size] of [['1280 px', DESKTOP], ['360 px', PHONE]] as const) {
    test(`UAT-IND-A11-01 IND-01, IND-02 and IND-03 at ${name} have 0 serious or critical axe violations`, async ({ page }) => {
      for (const [screen, path] of [['IND-01', '/ind/ind-01'], ['IND-02', '/ind/ind-02'], ['IND-03', '/ind/ind-03']] as const) {
        await open(page, path, size);
        expect(await seriousViolations(page), `${screen} at ${name}`).toEqual([]);
      }
    });
  }

  test('UAT-IND-A11-01 a wrong number in the trial run is named by its field with aria-describedby, and the verdict is announced, with the keyboard alone', async ({ page }) => {
    await open(page, '/ind/ind-02', DESKTOP);
    await startAtTitle(page);
    const field = page.getByLabel(vi['ind.rules.try.field'], { exact: true }).first();
    const value = page.getByLabel(vi['ind.rules.try.value'], { exact: true }).first();
    await typeInto(page, field, 'EQUITY');
    // The line has a field and no number yet: the field of the number is invalid and its error is its description.
    await expect(value).toHaveAttribute('aria-invalid', 'true');
    const error = page.locator('[role="alert"]').filter({ hasText: vi['ind.rules.try.fault.value'] });
    await expect(error).toBeVisible();
    const describedBy = await value.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(vi['ind.rules.try.fault.value']);
    await typeInto(page, value, '400');
    await expect(value).not.toHaveAttribute('aria-invalid', 'true');
    await pressButton(page, page.getByRole('button', { name: vi['ind.rules.try.action'] }));
    await expect(page.getByTestId('try-verdict')).toBeVisible();
    await expect(page.getByTestId('try-verdict')).toHaveAttribute('role', 'status');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('negative control: the axe check reports a form field without a label', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><input type="text"></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('label');
  });
});
