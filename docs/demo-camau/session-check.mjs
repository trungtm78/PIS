// Checks of signing out and of a dead provider session on the demo installation, the way a person meets them (run after an update of the web or of the realm theme):
//   ssh <server> "type ...\demo-credentials.json" | node docs/demo-camau/session-check.mjs --shots <dir> [--stale-user <name> --stale-password <password> --remove-command "<command that removes that person from the realm>"]
// 1 the role under the name; 2 "Đăng xuất" in the top bar and in the sidebar; 3 a sign-out lands on the clean page "Bạn đã đăng xuất" (no menu), and the provider forgot
//   its session too: the next sign-in asks for the password, and ANOTHER account signs in in the same browser; 4 (with --stale-user) a browser that still holds the cookies
//   of a person who was removed from the realm ends on the user name and password form, through "Đăng nhập lại" of the error page when the provider shows one.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(HERE, '..', '..', 'apps', 'web', 'package.json'))('@playwright/test');
const { values } = parseArgs({ options: { shots: { type: 'string' }, 'stale-user': { type: 'string' }, 'stale-password': { type: 'string' }, 'remove-command': { type: 'string' } } });
const text = readFileSync(0, 'utf8');
const credentials = JSON.parse(text.slice(text.indexOf('{')));
const origin = credentials.origin;
let failed = 0;
const say = (ok, name, detail) => {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}\n`);
};
const shot = async (page, name) => {
  if (values.shots !== undefined) await page.screenshot({ path: join(values.shots, `${name}.png`), fullPage: true });
};
const typeIn = async (page, account) => {
  await page.locator('#username').waitFor({ timeout: 60_000 });
  await page.locator('#username').fill(account.username);
  await page.locator('#password').fill(account.password);
  await page.locator('#kc-login').click();
};
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN' });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).first().click();
  await typeIn(page, credentials.people.owner);
  await page.locator('[data-screen-id="HOME-01"]').first().waitFor({ timeout: 90_000 });
  await page.waitForLoadState('networkidle');
  const card = page.locator('.account-link').first();
  await page.waitForFunction(() => !/Thành viên tổ chức/u.test(document.querySelector('.account-link')?.textContent ?? 'Thành viên tổ chức'), undefined, { timeout: 20_000 }).catch(() => undefined);
  const cardText = ((await card.textContent()) ?? '').replace(/\s+/gu, ' ').trim();
  say(/Quản trị cao nhất/u.test(cardText), 'the role under the name of demo is the highest role', cardText);
  const outs = page.getByRole('button', { name: /Đăng xuất/u });
  say((await outs.count()) === 2, '"Đăng xuất" is offered in the top bar and in the sidebar', `${await outs.count()} buttons`);
  say((await page.locator('.app-version').count()) > 0, 'the release is shown', ((await page.locator('.app-version').first().textContent()) ?? '').trim());
  await shot(page, 'session-01-menu-dang-xuat-va-vai-tro');
  await outs.first().click();
  await page.waitForURL((url) => url.origin === origin && url.pathname === '/auth/signed-out', { timeout: 60_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle');
  const outText = await page.evaluate(() => document.body.innerText);
  say(new URL(page.url()).pathname === '/auth/signed-out' && /Bạn đã đăng xuất/u.test(outText) && !/Phiên làm việc đã hết hạn/u.test(outText) && (await page.locator('nav').count()) === 0, 'a sign-out lands on the clean page, without the menu', `${new URL(page.url()).pathname}; ${outText.slice(0, 80).replace(/\n/gu, ' / ')}`);
  await shot(page, 'session-02-trang-da-dang-xuat');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  const asked = await page.locator('#username').waitFor({ timeout: 60_000 }).then(() => true, () => false);
  say(asked, 'the provider forgot its session: the next sign-in asks for the user name and the password', new URL(page.url()).pathname);
  await shot(page, 'session-03-form-dang-nhap-sau-dang-xuat');
  if (asked) {
    await typeIn(page, credentials.people.capApprover);
    await page.locator('[data-screen-id="HOME-01"]').first().waitFor({ timeout: 90_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !/Thành viên tổ chức/u.test(document.querySelector('.account-link')?.textContent ?? 'Thành viên tổ chức'), undefined, { timeout: 20_000 }).catch(() => undefined);
    const second = ((await page.locator('.account-link').first().textContent().catch(() => '')) ?? '').replace(/\s+/gu, ' ').trim();
    say(second.includes(credentials.people.capApprover.displayName ?? 'Trần Thị Bích'), 'another account signs in in the same browser', second);
    await shot(page, 'session-04-lanhdao-trong-cung-trinh-duyet');
  }
  await context.close();

  if (values['stale-user'] !== undefined && values['stale-password'] !== undefined && values['remove-command'] !== undefined) {
    const stale = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN' });
    const tab = await stale.newPage();
    await tab.goto(origin, { waitUntil: 'networkidle', timeout: 90_000 });
    await tab.getByRole('button', { name: 'Đăng nhập', exact: true }).first().click();
    await typeIn(tab, { username: values['stale-user'], password: values['stale-password'] });
    await tab.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/idp/'), { timeout: 60_000 });
    await tab.waitForLoadState('networkidle');
    const cookies = (await stale.cookies()).filter((cookie) => /KEYCLOAK|AUTH_SESSION/u.test(cookie.name)).length;
    // The person is removed from the realm while the browser still holds the cookies of their session.
    const removed = spawnSync(values['remove-command'], { shell: true, encoding: 'utf8' });
    say(removed.status === 0 && cookies > 0, 'the person was removed while the browser holds the cookies of the provider', `${cookies} cookies; remove exit ${removed.status}`);
    await tab.goto(origin, { waitUntil: 'networkidle', timeout: 90_000 });
    await tab.getByRole('button', { name: 'Đăng nhập', exact: true }).first().click();
    await tab.waitForLoadState('networkidle');
    const direct = (await tab.locator('#username').count()) > 0;
    const again = tab.locator('#pis-sign-in-again');
    await shot(tab, 'session-05-phien-cu-sau-khi-bam-dang-nhap');
    if (!direct && (await again.count()) > 0) {
      await again.click();
      await tab.locator('#username').waitFor({ timeout: 60_000 }).catch(() => undefined);
    }
    const form = (await tab.locator('#username').count()) > 0;
    say(form, 'a dead provider session ends on the user name and password form', direct ? 'the form at once' : `through "Đăng nhập lại" of the error page (prompt=${new URL(tab.url()).searchParams.get('prompt')})`);
    await shot(tab, 'session-06-phien-cu-ket-thuc-o-form-dang-nhap');
    await stale.close();
  }
} finally {
  await browser.close();
}
process.stdout.write(failed === 0 ? 'every check passed\n' : `${failed} checks FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
