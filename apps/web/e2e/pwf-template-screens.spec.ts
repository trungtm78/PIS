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
      const widths = await frame.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      if (width >= 1440) expect(widths.scroll, 'at 1440 px every column is in view, the frame has no scroll of its own').toBeLessThanOrEqual(widths.client);
      // The investment template has 34 tasks: its later phases are folded, so the page stays usable.
      const high = await page.evaluate(() => document.documentElement.scrollHeight);
      expect(high, `the page is ${high}px high`).toBeLessThanOrEqual(width >= 1440 ? 3600 : 6000);
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
    await page.getByRole('dialog').getByRole('button', { name: 'Xong' }).click();
    effort.clicks += 1;
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
    expect(effort.clicks).toBeLessThanOrEqual(7);
    expect(effort.typed).toBeLessThanOrEqual(15);
    await page.screenshot({ path: join(SHOTS, '04-PWF-02-ten-steps-1440.png'), fullPage: true });
  });
});

test.describe('PWF-01 and PWF-02: the polish of the library rows and of the selects of the editor', () => {
  test('the library rows are about 56 px high and the header about 40, with the state in one compact line of chips', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/pwf/pwf-01?devUser=${PERSON}`);
    await expect(page.locator('[data-screen-id="PWF-01"] h1')).toBeVisible();
    const table = page.locator('.pwf-lib table').first();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    const sizes = await table.evaluate((element) => ({
      head: Math.round(element.querySelector('thead tr')?.getBoundingClientRect().height ?? 0),
      rows: Array.from(element.querySelectorAll('tbody tr')).map((row) => Math.round(row.getBoundingClientRect().height)),
      chipWords: Array.from(element.querySelectorAll('.pwf-lib-state .ui-pill')).map((chip) => Math.round(chip.getBoundingClientRect().height)),
    }));
    expect(sizes.head, `header ${sizes.head}px`).toBeLessThanOrEqual(48);
    // A row with a version in force, a draft and three actions needs a second line for its chips and buttons; the others are about 56 px.
    const sorted = [...sizes.rows].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)] ?? 0, `median row of ${sizes.rows.join(', ')}px`).toBeLessThanOrEqual(66);
    expect(Math.max(...sizes.rows), `rows ${sizes.rows.join(', ')}px`).toBeLessThanOrEqual(84);
    // A chip is one line (about 22 px), never a column of words.
    for (const height of sizes.chipWords) expect(height).toBeLessThanOrEqual(30);
    await noSidewaysScroll(page);
  });

  test('the unit, role, anchor and unit-of-limit selects of the editor show their selected text in full at 1440 px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/pwf/pwf-02?code=PUBLIC_INVESTMENT&devUser=${PERSON}`);
    await expect(page.getByTestId('steps-table')).toBeVisible();
    // A select shows its selected text in at most two lines and cuts nothing: the text box is no higher than its own content.
    const clipped = await page.getByTestId('steps-table').evaluate((root) =>
      Array.from(root.querySelectorAll('.pwfx-fit__text'))
        .filter((box) => box.scrollHeight > box.clientHeight + 1)
        .map((box) => box.textContent ?? ''),
    );
    const shown = await page.getByTestId('steps-table').locator('.pwfx-fit').count();
    expect(shown, 'the selects of the table are the full-text ones').toBeGreaterThan(10);
    expect(clipped, 'selects whose text does not fit').toEqual([]);
  });
});

test.describe('PWF-08 and ADM-07: the new screens at 1440 and 390 px', () => {
  for (const width of [1440, 390]) {
    test(`the default thresholds at ${width} px: no sideways scroll of the page, every box labelled`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/pwf/pwf-08?devUser=${PERSON}`);
      await expect(page.getByTestId('ladder-table')).toBeVisible();
      await expect(page.getByTestId('step-bands')).toBeVisible();
      await noSidewaysScroll(page);
      const unlabelled = await page.evaluate(() => Array.from(document.querySelectorAll('main input:not([type=hidden]), main select, main textarea')).filter((control) => (control as HTMLInputElement).labels?.length === 0 && control.getAttribute('aria-label') === null && control.getAttribute('aria-labelledby') === null).length);
      expect(unlabelled, 'controls without a label').toBe(0);
      await page.screenshot({ path: join(SHOTS, `04-PWF-08-nguong-mac-dinh-${width}.png`), fullPage: true });
    });

    test(`the yearly work calendar at ${width} px: no sideways scroll of the page, every box labelled`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/adm/adm-07?devUser=${PERSON}`);
      await expect(page.getByTestId('year-editor')).toBeVisible();
      await page.getByRole('button', { name: 'Nạp ngày lễ theo thông báo của năm' }).click();
      await expect(page.getByTestId('special-table')).toBeVisible();
      await noSidewaysScroll(page);
      const unlabelled = await page.evaluate(() => Array.from(document.querySelectorAll('main input:not([type=hidden]), main select, main textarea')).filter((control) => (control as HTMLInputElement).labels?.length === 0 && control.getAttribute('aria-label') === null && control.getAttribute('aria-labelledby') === null).length);
      expect(unlabelled, 'controls without a label').toBe(0);
      await page.screenshot({ path: join(SHOTS, `05-ADM-07-lich-lam-viec-nam-${width}.png`), fullPage: true });
    });
  }
});
