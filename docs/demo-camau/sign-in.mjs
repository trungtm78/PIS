// The sign-in a person makes at the demo installation, for the Playwright scripts of this directory: the "Đăng nhập" button of the application, the page of the realm
// (user name and password; a one-time password only when the realm asks for one, which the demonstration mode does not), then the organisation when the application asks to choose one.
// Returns what was seen on the way: { otpAsked, choseOrganization, path }.
export async function signIn(page, origin, account, { timeout = 90_000 } = {}) {
  await page.goto(origin, { waitUntil: 'networkidle', timeout });
  const username = page.locator('#username');
  if ((await username.count()) === 0) await page.getByRole('button', { name: 'Đăng nhập', exact: true }).first().click();
  await username.waitFor({ timeout });
  await username.fill(account.username);
  await page.locator('#password').fill(account.password);
  await Promise.all([page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/idp/'), { timeout }), page.locator('#kc-login').click()]);
  await page.waitForLoadState('networkidle', { timeout });
  const otpAsked = (await page.locator('input[name="otp"]').count()) > 0;
  // A person who belongs to one organisation is still asked to choose it on this release.
  let choseOrganization = false;
  const choose = page.getByRole('button', { name: /Chọn tổ chức|Vào tổ chức|Chọn/u }).first();
  if (/\/iam\//u.test(new URL(page.url()).pathname) && (await choose.count()) > 0) {
    await choose.click();
    await page.waitForLoadState('networkidle', { timeout });
    choseOrganization = true;
  }
  await page.waitForTimeout(1500);
  return { otpAsked, choseOrganization, path: new URL(page.url()).pathname };
}
