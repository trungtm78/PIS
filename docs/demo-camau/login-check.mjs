// Signs every demo account in the way a person does (the sign-in page of the realm: user name and password) and says where the application lands:
//   ssh <server> "type C:\ProgramData\MACHVON\secrets\admin\demo-credentials.json" | node docs/demo-camau/login-check.mjs
// One browser context for each account. Nothing is written but the lines of the result; the credentials are read from the standard input.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from './sign-in.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(HERE, '..', '..', 'apps', 'web', 'package.json'))('@playwright/test');
const text = readFileSync(0, 'utf8');
const credentials = JSON.parse(text.slice(text.indexOf('{')));
const browser = await chromium.launch();
let failed = 0;
try {
  for (const [person, account] of Object.entries(credentials.people)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN' });
    const page = await context.newPage();
    try {
      const seen = await signIn(page, credentials.origin, account);
      const heading = (await page.locator('h1').first().textContent({ timeout: 15_000 }).catch(() => null)) ?? '';
      const tenant = await page.evaluate(() => document.body.innerText.includes('UBND tỉnh Cà Mau'));
      const otp = seen.otpAsked;
      const ok = heading.trim() !== '' && tenant && !otp;
      if (!ok) failed += 1;
      process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${account.username} (${person}): ${new URL(page.url()).pathname} | h1 "${heading.trim().slice(0, 50)}" | tenant shown ${tenant} | asked for a one-time password ${otp}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${account.username} (${person}): ${String(error.message).split('\n')[0].slice(0, 160)}\n`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.stdout.write(failed === 0 ? 'every account signs in\n' : `${failed} accounts do not sign in\n`);
process.exitCode = failed === 0 ? 0 : 1;
