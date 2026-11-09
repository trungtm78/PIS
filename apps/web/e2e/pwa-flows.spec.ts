import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };

/**
 * The manager application (PWA, YCK.01, eng review R7) in a real browser against the real API stack (apps/api/test/e2e-stack): the manifest and the icons
 * that make the page installable, the start page and the three screens at the width of a phone (360 px), and what must be left on a shared phone when the
 * person signs out. The screens are found by their `data-screen-id` and test ids, not by their words, so a change of wording does not break them.
 *
 * The development server never registers the service worker (only a production build does), so the cache policy itself is tested in the unit tests
 * (`src/pwa/*.test.ts`); the last block here runs against a production build served over localhost (a secure context) when `E2E_PWA_PREVIEW_URL` names it
 * (`npm run build` then `npx vite preview`) and is skipped otherwise.
 */

/** The edition the stack serves and the browser build reads (MACHVON_EDITION, then VITE_EDITION; public when unset): its overlay names the product. */
const ENTERPRISE = (process.env.MACHVON_EDITION ?? process.env.VITE_EDITION) === 'enterprise';
const PUBLIC_PRODUCT_NAME = vi['shell.app.name.title'];

const PHONE = { width: 360, height: 780 };
const TOUCH_TARGET = 44;
const SCREEN = { start: 'PWA-01', approvals: 'PWA-02', dashboard: 'PWA-03', directives: 'PWA-04' } as const;

async function open(page: Page, path: string, user = 'owner'): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** The page never scrolls sideways (design.md: responsive and accessibility). */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('the manifest makes the page installable', () => {
  test('serves a manifest with the name, the start URL inside the scope, standalone display and icons of 192 and 512 px', async ({ page }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const response = await page.request.get('/manifest.webmanifest');
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('manifest+json');
    const manifest = (await response.json()) as { name: string; short_name: string; start_url: string; scope: string; display: string; theme_color: string; icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>; shortcuts: Array<{ url: string }> };
    // The public edition says the name as the shell does; the enterprise edition names its own product (the public specs never import the enterprise overlay, edition:check).
    if (ENTERPRISE) {
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.name).not.toBe(PUBLIC_PRODUCT_NAME);
    } else {
      expect(manifest.name).toBe(PUBLIC_PRODUCT_NAME);
    }
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url.startsWith('/m')).toBe(true);
    expect(manifest.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(['/m/approvals', '/m/dashboard', '/m/directives']);
    const sizes = manifest.icons.filter((icon) => icon.type === 'image/png' && icon.purpose === 'any').map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    // Every icon the manifest names is there.
    for (const icon of manifest.icons) {
      const file = await page.request.get(icon.src);
      expect(file.ok(), icon.src).toBe(true);
      expect(file.headers()['content-type'], icon.src).toContain(icon.type);
    }
    expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toBe('/icons/apple-touch-icon-180.png');
  });

  test('registers no service worker in a development build, so a session never runs behind a cache', async ({ page }) => {
    await open(page, '/m');
    const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    expect(registrations).toBe(0);
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
  });
});

test.describe('the start page and the three screens at 360 px', () => {
  test('the start page opens the three manager screens with targets of at least 44 px and does not scroll sideways', async ({ page }) => {
    await open(page, '/m');
    await expect(page.locator(`[data-screen-id="${SCREEN.start}"]`)).toBeVisible();
    await expectNoHorizontalScroll(page);
    for (const entry of ['approvals', 'dashboard', 'directives']) {
      const link = page.locator(`[data-entry="${entry}"]`);
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
    // The way to install and the way to turn notifications on are on the page, and the notice says what a notification carries.
    await expect(page.getByTestId('install-card')).toBeVisible();
    await expect(page.getByTestId('push-card')).toBeVisible();
    await expect(page.getByTestId('push-state')).toBeVisible();
  });

  // PWA2 (written, not run in the lane): the settings, the drill-downs of the dashboard and the empty detail routes fit a phone and keep the way back.
  test('the settings and the two drill-downs open at 360 px without horizontal scroll', async ({ page }) => {
    for (const [path, screen] of [
      ['/m/settings', 'PWA-07'],
      ['/m/dashboard/detail', 'PWA-08'],
      ['/m/progress', 'PWA-09'],
    ] as const) {
      await open(page, path);
      await expect(page.locator(`[data-screen-id="${screen}"]`)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expect(page.getByTestId('pwa-back')).toBeVisible();
    }
  });

  test('a detail of a task that is not there says so and offers the way back to the queue', async ({ page }) => {
    await open(page, '/m/approvals/00000000-0000-4000-8000-0000000000ff');
    await expect(page.locator('[data-screen-id="PWA-05"]')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expect(page.getByTestId('pwa-back')).toBeVisible();
  });

  test('each entry opens its screen, and each screen has the way back to the start page', async ({ page }) => {
    await open(page, '/m');
    for (const [entry, screen] of [
      ['approvals', SCREEN.approvals],
      ['dashboard', SCREEN.dashboard],
      ['directives', SCREEN.directives],
    ] as const) {
      await page.locator(`[data-entry="${entry}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/m/${entry}`));
      await expect(page.locator(`[data-screen-id="${screen}"]`)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.getByTestId('pwa-back').click();
      await expect(page.locator(`[data-screen-id="${SCREEN.start}"]`)).toBeVisible();
    }
  });

  test('the approval queue shows the tasks of the person with the way to decide them, or says that nothing waits', async ({ page }) => {
    await open(page, '/m/approvals');
    const screen = page.locator(`[data-screen-id="${SCREEN.approvals}"]`);
    await expect(screen).toBeVisible();
    // Never a count while it is not known: the counts line appears with the answer.
    await expect(page.getByTestId('counts')).toBeVisible();
    await expectNoHorizontalScroll(page);
    const tasks = page.locator('[data-task]');
    if ((await tasks.count()) === 0) {
      await expect(page.getByTestId('empty')).toBeVisible();
      return;
    }
    const approve = tasks.first().locator('[data-action="approve"]');
    if ((await approve.count()) === 0) {
      await expect(tasks.first().getByTestId('cannot-decide')).toBeVisible();
      return;
    }
    // A return needs a reason: the sheet refuses an empty one and names why, and sends nothing.
    const decisions: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/approval-tasks/')) decisions.push(request.url());
    });
    await tasks.first().locator('[data-action="return"]').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button').last().click();
    await expect(sheet.getByTestId('decision-problem')).toBeVisible();
    expect(decisions).toEqual([]);
    // The sheet is at the bottom on a phone and its buttons are targets of 44 px.
    const buttons = await sheet.getByRole('button').all();
    for (const button of buttons) expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('the leader dashboard shows the figures of the latest snapshot with their context first, or the standard state that says why not', async ({ page }) => {
    await open(page, '/m/dashboard');
    await expect(page.locator(`[data-screen-id="${SCREEN.dashboard}"]`)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expect(page.getByTestId('pwa-context')).toBeVisible();
    const figures = page.getByTestId('pwa-rates');
    if ((await figures.count()) > 0) {
      const context = await page.getByTestId('pwa-context').boundingBox();
      const rates = await figures.boundingBox();
      expect((context?.y ?? 0) < (rates?.y ?? 0)).toBe(true);
      await expect(page.getByTestId('pwa-full')).toHaveAttribute('href', '/home/home-09');
    }
  });

  test('the directive tracking reads the real list and summary and never an invented directive', async ({ page }) => {
    await open(page, '/m/directives');
    await expect(page.locator(`[data-screen-id="${SCREEN.directives}"]`)).toBeVisible();
    // The list is the one of the directive module: either its cards or its own empty state, never the old "not built" card.
    await expect(page.locator('[data-kind="notBuilt"]')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('someone who may not read the command center is told the scope is hidden, and sees none of its figures', async ({ page }) => {
    await open(page, '/m/dashboard', 'planReader');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('pwa-rates')).toHaveCount(0);
  });
});

test.describe('signing out leaves nothing of the person on the device (R7)', () => {
  /** The real sign-in of session-flows.spec.ts: the identity provider of the stack, the second factor, the tenant chooser. */
  async function signInAndChoose(page: Page, tenant: string): Promise<void> {
    await page.setViewportSize(PHONE);
    await page.goto('/m?session=oidc');
    await expect(page.getByRole('heading', { level: 1, name: vi['states.signedOut.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['session.oidc.signIn.action'] }).click();
    await page.waitForURL(/\/iam\/iam-04/);
    const choose = page.getByRole('button', { name: vi['iam.tenantChooser.select.label'].replace('{name}', tenant) });
    await choose.click();
    await expect(page.getByRole('alertdialog', { name: vi['adm.roles.stepUp.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['adm.roles.stepUp.confirm.action'] }).click();
    await page.waitForURL(/\/iam\/iam-04\?next=/);
    await page.getByRole('button', { name: vi['iam.tenantChooser.select.label'].replace('{name}', tenant) }).click();
    await expect(page.locator(`[data-screen-id="${SCREEN.start}"]`)).toBeVisible();
  }

  test('the caches, the device record and what the page holds in memory are gone, and the next visit asks to sign in', async ({ page }) => {
    await signInAndChoose(page, 'Cao Bằng');
    // What a worker and the push registration would have left behind: caches of the origin and the record of the registered device.
    await page.evaluate(async () => {
      for (const name of ['mv-shell-sentinel', 'mv-static-sentinel', 'another-cache']) await (await caches.open(name)).put(`/${name}`, new Response('x'));
      localStorage.setItem('mv.pwa.device', JSON.stringify({ publicId: 'web-sentinel-device-id' }));
    });
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(3);

    // The sign-out of the session, as the sign-in screen offers it to a person who is signed in (client-side, so the tokens in memory stay).
    await page.evaluate(() => {
      window.history.pushState({}, '', '/iam/iam-01');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByTestId('signin-already').getByRole('button', { name: vi['iam.signin.signOut.action'] }).click();

    await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBe(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('mv.pwa.device'))).toBeNull();
    // The screens of the manager application ask to sign in again: nothing of the last session is shown.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/m/approvals');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { level: 1, name: vi['states.signedOut.title'] })).toBeVisible();
    await expect(page.locator('[data-task]')).toHaveCount(0);
  });
});

// The block below needs a production build served from a secure origin (`npm run build -w @machvon/web`, then `npx vite preview`): it is registered
// only when its address is given, so a run without one has no such test instead of a skipped one.
const preview = process.env.E2E_PWA_PREVIEW_URL;
type DescribeBlock = (title: string, body: () => void) => void;
const noBlock: DescribeBlock = () => undefined;
const describeProductionBuild: DescribeBlock = preview === undefined ? noBlock : test.describe;

describeProductionBuild('a production build served from a secure origin (set E2E_PWA_PREVIEW_URL to run)', () => {

  test('registers the worker, keeps the shell and static files only, and never a response of the API', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(`${preview}/m`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Reload so the page is controlled by the worker and its requests pass through it.
    await page.reload();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const urls = await page.evaluate(async () => {
      const found: string[] = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) found.push(request.url);
      return found;
    });
    expect(urls.length).toBeGreaterThan(0);
    // Not one answer of the API or of the sign-in is kept, and no page of a screen: the shell and the files of the build only.
    for (const url of urls) expect(new URL(url).pathname, url).not.toMatch(/^\/(api|v1|resources|me|auth|oidc)\b/);
    expect(urls.some((url) => new URL(url).pathname === '/index.html')).toBe(true);
    for (const name of await page.evaluate(() => caches.keys())) expect(name.startsWith('mv-')).toBe(true);
  });

  test('purges every cache when told to, as at a sign-out or when the session expires', async ({ page }) => {
    await page.goto(`${preview}/m`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBeGreaterThan(0);
    await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: 'mv:purge' }));
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBe(0);
  });

  test('shows the shell and says it is offline when there is no network, never a stored page of data', async ({ page, context }) => {
    await page.goto(`${preview}/m`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await context.setOffline(true);
    await page.reload();
    // The shell starts; the screens that need the API say they are offline instead of showing what was seen before.
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.locator('[data-task]')).toHaveCount(0);
    await context.setOffline(false);
  });
});
