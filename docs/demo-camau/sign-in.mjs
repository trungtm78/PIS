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

/**
 * Opens a screen of the application by its address. The application keeps its session in memory only, so a page that is loaded anew shows the "Đăng nhập" card first;
 * the session of the realm (its cookies) then signs the person in again without asking. Returns true when the screen (`[data-screen-id]`) is shown.
 */
export async function openScreen(page, origin, path, screenId, { timeout = 60_000 } = {}) {
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout });
  const gate = page.getByRole('button', { name: 'Đăng nhập', exact: true }).first();
  const screen = page.locator(`[data-screen-id="${screenId}"]`).first();
  await gate.or(screen).first().waitFor({ timeout }).catch(() => undefined);
  if (await gate.isVisible().catch(() => false)) {
    await gate.click();
    await page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/idp/') && url.pathname !== '/auth/callback', { timeout });
    const choose = page.getByRole('button', { name: /Chọn tổ chức|Vào tổ chức|Chọn/u }).first();
    await screen.or(choose).first().waitFor({ timeout }).catch(() => undefined);
    if (!(await screen.isVisible().catch(() => false)) && (await choose.isVisible().catch(() => false))) await choose.click();
  }
  const shown = await screen.waitFor({ timeout }).then(() => true, () => false);
  await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
  return shown;
}
