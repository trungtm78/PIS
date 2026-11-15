// Checks of the sign-in of the demo installation that a person notices (run after an update of the web or of the realm theme):
//   ssh <server> "type ...\demo-credentials.json" | node docs/demo-camau/login-ux-check.mjs [--shots <dir>]
// 1 the page of the realm is in Vietnamese for a browser that announces English; 2 a person of one organisation lands on the home screen without choosing it;
// 3 the name of the person is shown family name first; 4 the error page of the realm offers "Đăng nhập lại", and that way leads to the sign-in form (a NEW sign-in).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(HERE, '..', '..', 'apps', 'web', 'package.json'))('@playwright/test');
const { values } = parseArgs({ options: { shots: { type: 'string' } } });
const text = readFileSync(0, 'utf8');
const credentials = JSON.parse(text.slice(text.indexOf('{')));
const account = credentials.people.owner;
const origin = credentials.origin;
let failed = 0;
const say = (ok, name, detail) => {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}\n`);
};
const shot = async (page, name) => {
  if (values.shots !== undefined) await page.screenshot({ path: join(values.shots, `${name}.png`), fullPage: true });
};
const browser = await chromium.launch();
try {
  // A browser that announces English only.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.getByRole('button', { name: /Đăng nhập|Sign in/u }).first().click();
  await page.locator('#username').waitFor({ timeout: 60_000 });
  const loginText = await page.evaluate(() => document.body.innerText);
  say(/Đăng nhập/u.test(loginText) && !/Public Investment Management System/u.test(loginText), 'the sign-in page is in Vietnamese for an English browser', `${new URL(page.url()).searchParams.get('ui_locales') ?? 'no ui_locales'}; lang="${await page.evaluate(() => document.documentElement.lang)}"`);
  await shot(page, 'login-01-trang-dang-nhap-trinh-duyet-tieng-anh');
  await page.locator('#username').fill(account.username);
  await page.locator('#password').fill(account.password);
  await page.locator('#kc-login').click();
  await page.locator('[data-screen-id="HOME-01"]').first().waitFor({ timeout: 90_000 }).catch(() => undefined);
  const path = new URL(page.url()).pathname;
  say(path === '/home/home-01', 'one organisation: the home screen without choosing', path);
  const body = await page.evaluate(() => document.body.innerText);
  say(body.includes(account.displayName ?? 'Nguyễn Văn An'), 'the name is shown family name first', (body.match(/Nguyễn Văn An|An Nguyễn Văn/u) ?? ['name not found'])[0]);
  say(!body.includes('Cán bộ quản lý · Bản mẫu'), 'no sample job title under the name', body.includes('Thành viên tổ chức') || body.includes('Organisation member') ? 'neutral label' : 'label not found');
  await shot(page, 'login-02-trang-chu-sau-dang-nhap');
  await context.close();

  // The error page of the realm: an authorization request the realm refuses shows it; the way out must be there and must lead to the form of a new sign-in.
  const second = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN' });
  const error = await second.newPage();
  await error.goto(`${origin}/idp/realms/machvon/protocol/openid-connect/auth?client_id=machvon-web&response_type=code&redirect_uri=${encodeURIComponent('https://example.invalid/not-registered')}&scope=openid`, { waitUntil: 'networkidle', timeout: 60_000 });
  const again = error.locator('#pis-sign-in-again');
  const offered = (await again.count()) > 0;
  say(offered, 'the error page of the realm offers "Đăng nhập lại"', offered ? String(await again.getAttribute('href')) : (await error.evaluate(() => document.body.innerText)).slice(0, 120).replace(/\n/gu, ' / '));
  await shot(error, 'login-03-trang-loi-co-nut-dang-nhap-lai');
  if (offered) {
    await again.click();
    await error.locator('#username').waitFor({ timeout: 60_000 }).catch(() => undefined);
    const url = new URL(error.url());
    say((await error.locator('#username').count()) > 0 && url.searchParams.get('prompt') === 'login', '"Đăng nhập lại" starts a new sign-in (prompt=login) and shows the form', `${url.pathname} prompt=${url.searchParams.get('prompt')}`);
    await shot(error, 'login-04-form-dang-nhap-moi');
  }
  await second.close();
} finally {
  await browser.close();
}
process.stdout.write(failed === 0 ? 'every check passed\n' : `${failed} checks FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
