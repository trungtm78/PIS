import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * PWF-01 (the library) and PWF-02 (the table editor) in a real browser: the layout at 1440 and 390 px (the page never scrolls sideways, a table scrolls inside its own frame), the height of a 10-step procedure, and the
 * effort it takes to make one (clicks and typed fields), which is the usability criterion of the redesign. The shots are kept in docs/pwf-screens/web-new. Nothing is saved: the stack is shared by the other flows.
 */

const PERSON = 'owner';
const SHOTS = join(process.cwd(), '..', '..', 'docs', 'pwf-screens', 'web-new');

const noSidewaysScroll = async (page: Page): Promise<void> => {
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));
  expect(widths.page, 'the page does not scroll sideways').toBeLessThanOrEqual(widths.window);
};

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test.describe('PWF-01 and PWF-02: layout, height and effort', () => {
  for (const width of [1440, 390]) {
    test(`the library at ${width} px has no sideways scroll of the page and offers the four ways to begin`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/pwf/pwf-01?devUser=${PERSON}`);
      await expect(page.locator('[data-screen-id="PWF-01"] h1')).toBeVisible();
      await expect(page.getByRole('table').first()).toBeAttached();
      await page.getByTestId('new-template').click();
      await expect(page.getByTestId('quick-start')).toBeVisible();
      await noSidewaysScroll(page);
      await page.screenshot({ path: join(SHOTS, `01-PWF-01-library-${width}.png`), fullPage: true });
    });
  }

  for (const width of [1440, 390]) {
    test(`the editor at ${width} px: the table scrolls inside its own frame and the page does not`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/pwf/pwf-02?code=PUBLIC_INVESTMENT&devUser=${PERSON}`);
      await expect(page.getByTestId('steps-table')).toBeVisible();
      await expect(page.getByTestId('diagram-status')).toHaveAttribute('data-status', 'ready');
      await noSidewaysScroll(page);
      const frame = page.getByTestId('steps-table');
      expect(await frame.evaluate((element) => getComputedStyle(element).position)).toBe('relative');
      await page.screenshot({ path: join(SHOTS, `02-PWF-02-editor-${width}.png`), fullPage: true });
      await page.locator('[data-testid^="details-"]').first().click();
      await expect(page.getByTestId('step-drawer')).toBeVisible();
      await noSidewaysScroll(page);
      await page.screenshot({ path: join(SHOTS, `03-PWF-02-details-${width}.png`) });
    });
  }

  test('a procedure of 10 steps is made with the keyboard in a few actions and is at most two screens high at 1440 px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/pwf/pwf-02?start=blank&devUser=${PERSON}`);
    await expect(page.getByTestId('steps-table')).toBeVisible();
    const effort = { clicks: 0, typed: 0, keys: 0 };
    await page.getByTestId('rename').click();
    effort.clicks += 1;
    await page.getByTestId('field-name').fill('Sửa chữa, bảo trì đường giao thông địa phương');
    effort.typed += 1;
    await page.locator('[data-testid^="phase-name-"]').first().fill('Chuẩn bị');
    effort.typed += 1;
    const names = ['Khảo sát hiện trạng', 'Lập hồ sơ và dự toán', 'Thẩm định hồ sơ', 'Phê duyệt dự án', 'Lập kế hoạch lựa chọn nhà thầu', 'Phê duyệt kế hoạch', 'Lựa chọn nhà thầu', 'Ký hợp đồng', 'Thi công', 'Nghiệm thu'];
    const rows = page.locator('[data-field="name"]');
    await rows.first().fill(names[0] as string);
    effort.typed += 1;
    // Who and how long are set once, on the first row; every new row copies them.
    await page.getByLabel(/^vai trò của bước 1$/i).selectOption('PMB_MANAGER');
    effort.clicks += 1;
    await page.locator('[data-testid^="limit-"]').first().fill('4');
    effort.typed += 1;
    for (const [index, name] of names.slice(1).entries()) {
      await rows.nth(index).press('Enter');
      effort.keys += 1;
      await expect(rows).toHaveCount(index + 2);
      await expect(rows.nth(index + 1)).toBeFocused();
      await rows.nth(index + 1).fill(name);
      effort.typed += 1;
    }
    await expect(rows).toHaveCount(10);
    await expect(page.getByTestId('diagram-status')).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
    await noSidewaysScroll(page);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    // The editor (the header and the table of 10 steps) is at most two screens high; the diagram under it makes the page a little longer.
    const tableEnds = await page.evaluate(() => Math.round((document.querySelector('.pwfx-card')?.getBoundingClientRect().bottom ?? 0) + window.scrollY));
    expect(tableEnds, `the table of 10 steps ends ${tableEnds}px down`).toBeLessThanOrEqual(2 * 1000);
    // To save it: one click on "Lưu nháp", the reason, one click to confirm (not done here).
    effort.clicks += 2;
    effort.typed += 1;
    test.info().annotations.push({ type: 'effort', description: `10 steps: ${effort.clicks} clicks, ${effort.typed} typed fields, ${effort.keys} key presses; table ends at ${tableEnds}px, page ${height}px high` });
    expect(effort.clicks).toBeLessThanOrEqual(6);
    expect(effort.typed).toBeLessThanOrEqual(15);
    await page.screenshot({ path: join(SHOTS, '04-PWF-02-ten-steps-1440.png'), fullPage: true });
  });
});
