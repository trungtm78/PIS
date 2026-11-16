// Supplement outside the UAT gates: axe on the screens themselves (signed in), since the skill's scan stops at the sign-in card.
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [origin, user, password, spec, out] = process.argv.slice(2);
const routes = [...new Set([...readFileSync(spec, 'utf8').matchAll(/page\.goto\("([^"]+)"\)/g)].map((m) => m[1]))];
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(origin, { waitUntil: 'networkidle' });
if ((await page.locator('#username').count()) === 0) await page.getByRole('button', { name: 'Đăng nhập', exact: true }).first().click();
await page.locator('#username').fill(user);
await page.locator('#password').fill(password);
await page.locator('#kc-login').click();
await page.locator('[data-screen-id]').first().waitFor({ timeout: 60_000 });
import { existsSync } from 'node:fs';
const rows = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];
const done = new Set(rows.map((r) => r.route));
const limit = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('no answer in ' + ms + ' ms')), ms))]);
for (const route of routes) {
  if (done.has(route)) continue;
  const row = { route, scanned: false, violations: [] };
  try {
    await page.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const gate = page.getByRole('button', { name: 'Đăng nhập', exact: true }).first();
    const screen = page.locator('[data-screen-id]').first();
    await gate.or(screen).first().waitFor({ timeout: 20_000 });
    if (await gate.isVisible()) await gate.click();
    await screen.waitFor({ timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const result = await limit(new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze(), 60_000);
    row.scanned = true;
    row.screen = await screen.getAttribute('data-screen-id');
    row.violations = result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: (v.nodes[0]?.target ?? []).join(' ') }));
  } catch (error) { row.error = String(error.message).slice(0, 160); }
  rows.push(row);
  writeFileSync(out, JSON.stringify(rows, null, 1));
}
await browser.close();
console.log('AXE-DONE', rows.length, rows.filter((r) => r.scanned).length);
