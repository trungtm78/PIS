import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * ENT-MONKEY-01: the page is never empty, not at the first paint and not on any step of a walk through the sidebar, and the walk
 * raises no page error and no "Cannot update a component while rendering a different component".
 */
const OWNER = '/?devUser=owner';
const MODULE_TITLES = ['Dự án', 'Kế hoạch vốn', 'Giải ngân', 'Hợp đồng', 'Thanh toán', 'Nhà thầu', 'BI & báo cáo', 'Quản trị & cấu hình'];

interface Watch {
  failures: string[];
  consoleErrors: string[];
}

function watch(page: Page): Watch {
  const seen: Watch = { failures: [], consoleErrors: [] };
  page.on('response', (response) => {
    if (response.status() >= 400) seen.failures.push(`${response.status()} ${response.request().method()} ${response.url()} (page ${page.url()})`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') seen.consoleErrors.push(`${message.text().slice(0, 300)} (page ${page.url()})`);
  });
  page.on('pageerror', (error) => seen.consoleErrors.push(`pageerror ${error.message.slice(0, 300)}`));
  return seen;
}

const bodyText = (page: Page): Promise<string> => page.evaluate(() => (document.body.innerText ?? '').trim());

test('the page has text from the first paint until the application is ready, and during a walk', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const seen = watch(page);
  // The document alone, before any script: the placeholder of index.html says that the application is loading.
  const first = await page.request.get('/');
  expect(await first.text()).toContain('Đang tải ứng dụng');
  await page.goto(OWNER, { waitUntil: 'commit' });
  const samples: string[] = [];
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    // The tab is on about:blank until the server answers; only a loaded document counts.
    if (page.url() === 'about:blank') {
      await page.waitForTimeout(5);
      continue;
    }
    const text = await bodyText(page).catch(() => 'navigating');
    samples.push(text === '' ? 'EMPTY' : text.slice(0, 30));
    if (text.includes('Tổng quan')) break;
    await page.waitForTimeout(20);
  }
  expect(samples.filter((sample) => sample === 'EMPTY')).toEqual([]);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 30_000 });

  // The sidebar: open every module, then every link of the module it shows, and look at the page after each.
  const links = await page.locator('nav a[href]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') ?? '').filter((href) => href.startsWith('/')));
  const unique = [...new Set(links)].slice(0, 60);
  for (const title of MODULE_TITLES) {
    const toggle = page.getByRole('button', { name: new RegExp(title) }).first();
    if (await toggle.count()) await toggle.click({ timeout: 2000 }).catch(() => undefined);
    expect(await bodyText(page), `empty page after opening ${title}`).not.toBe('');
  }
  for (const href of unique) {
    await page.locator(`nav a[href="${href}"]`).first().click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(150);
    expect(await bodyText(page), `empty page at ${href}`).not.toBe('');
  }
  // The notification screens and back, as the monkey did (step 24 to 27).
  await page.goto('/not/not-01?devUser=owner');
  await page.waitForTimeout(1500);
  await page.goBack();
  await page.waitForTimeout(500);
  await page.goto('/not/not-01?devUser=owner');
  await page.waitForTimeout(1500);

  // A refused or empty read is an answer the screens show as a state card; what must never appear is a thrown error or the setState-in-render warning.
  expect(seen.consoleErrors.filter((line) => line.startsWith('pageerror') || line.includes('Cannot update a component'))).toEqual([]);
});
