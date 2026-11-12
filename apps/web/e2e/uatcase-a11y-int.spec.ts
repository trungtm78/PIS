import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { DESKTOP, PHONE, seriousViolations } from './support/axe-page.ts';
import { pressButton, startAtTitle, tabTo, typeInto } from './support/keyboard.ts';

/**
 * UAT-INT-A11-01: the five screens of the open interface against the real stack of the enterprise edition, judged by axe (colour contrast included) at 1280 px and 360 px,
 * and the opening of a machine account with the keyboard alone: the dialog that shows the secret once is read, its copy buttons work with the keys, and nothing but the
 * close button closes it. The BI accounts and the dialogs with data are also judged by src/screens/int/uatcase-a11y.test.tsx.
 */

const ACCOUNT_NAME = 'Máy đọc báo cáo A11Y';

async function open(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

test.describe('UAT-INT-A11-01 the open interface screens', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('UAT-INT-A11-01 a machine account is opened and its secret copied with the keyboard alone, the secret is shown once and readable, and only the close button closes the dialog', async ({ page }) => {
    await open(page, '/int/int-01', DESKTOP);
    await startAtTitle(page);
    await pressButton(page, page.getByRole('button', { name: vi['int.accounts.action.create'] }));
    await typeInto(page, page.locator('#int-account-name'), ACCOUNT_NAME);
    await tabTo(page, page.locator('.int-scope-option input[type="checkbox"]').first());
    await page.keyboard.press('Space');
    await pressButton(page, page.getByRole('button', { name: vi['int.accounts.create.confirm.action'], exact: true }));

    const dialog = page.getByRole('dialog', { name: vi['int.accounts.secret.created.title'].replace('{name}', ACCOUNT_NAME) });
    await expect(dialog).toBeVisible();
    // The warning says it is shown once; both values are text in the dialog (readable, not an image); the focus starts on the close button, inside the dialog.
    await expect(dialog.getByRole('alert')).toHaveText(vi['int.common.secret.warning']);
    const secretValue = dialog.getByTestId(`secret-${vi['int.accounts.secret.clientSecret.label']}`);
    const secret = (await secretValue.innerText()).trim();
    expect(secret.length).toBeGreaterThan(8);
    await expect(dialog.getByTestId(`secret-${vi['int.accounts.secret.clientId.label']}`)).not.toBeEmpty();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await seriousViolations(page)).toEqual([]);

    // The copy button is reached with Tab and works with Enter: the clipboard holds the secret and the button says so.
    const copy = dialog.getByRole('button', { name: vi['int.common.secret.copy.label'].replace('{label}', vi['int.accounts.secret.clientSecret.label']) });
    await tabTo(page, copy);
    await page.keyboard.press('Enter');
    await expect(copy).toHaveText(vi['int.common.secret.copied']);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);

    // Nothing closes it by accident: a click beside the dialog, another copy with the Space key and a stray key leave it open with the secret still there.
    await page.mouse.click(2, 2);
    await tabTo(page, copy);
    await page.keyboard.press('Space');
    await page.keyboard.press('x');
    await expect(dialog).toBeVisible();
    await expect(secretValue).toHaveText(secret);

    // The close button closes it, and the secret is nowhere on the page after that.
    await pressButton(page, dialog.getByRole('button', { name: vi['int.common.secret.close.action'] }));
    await expect(dialog).toHaveCount(0);
    expect(await page.content()).not.toContain(secret);
  });

  for (const [name, size] of [['1280 px', DESKTOP], ['360 px', PHONE]] as const) {
    test(`UAT-INT-A11-01 INT-01 to INT-05 at ${name} have 0 serious or critical axe violations`, async ({ page }) => {
      const list = await apiCall('owner', 'GET', '/int/machine-accounts');
      const account = (list.json.items as Array<{ id: string }>)[0];
      expect(account, 'the account of the keyboard case exists').toBeDefined();
      const paths = {
        'INT-01': '/int/int-01',
        'INT-02': `/int/int-02?account=${account?.id}`,
        'INT-03': '/int/int-03',
        'INT-04': '/int/int-04',
        'INT-05': '/int/int-05',
      };
      for (const [screen, path] of Object.entries(paths)) {
        await open(page, path, size);
        expect(await seriousViolations(page), `${screen} at ${name}`).toEqual([]);
      }
    });
  }

  test('negative control: the axe check reports a button without a name', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><button></button></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('button-name');
  });
});
