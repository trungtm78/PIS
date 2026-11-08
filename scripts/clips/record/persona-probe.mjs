// Which person can read a screen, and does it show data? Opens each screen as each person of the guide on a running stack and prints one line per pair:
// the verdict (REFUSED when the screen says the person has no access, EMPTY when it says there is nothing, DATA otherwise) and the length of the text.
//   node scripts/clips/record/persona-probe.mjs --web-url http://127.0.0.1:47613 --screens PRJ-14,DOC-24 [--people capApprover,projectManager]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Vietnamese phrases that tell a refused or an empty screen live in persona-probe.json, not in code. */
const PHRASES = JSON.parse(readFileSync(join(resolve(fileURLToPath(new URL('.', import.meta.url))), 'persona-probe.json'), 'utf8'));
const phrase = (name) => new RegExp(PHRASES[name].source, PHRASES[name].flags);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};

/** The verdict of the text of a screen. Pure. */
export function verdictOf(text) {
  if (phrase('refused').test(text)) return 'REFUSED';
  if (text.length < 700 && phrase('empty').test(text)) return 'EMPTY';
  return 'DATA';
}

async function main() {
  const baseUrl = flag('web-url');
  const screens = (flag('screens') ?? '').split(',').filter(Boolean);
  const routes = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, 'apps', 'web', 'src', 'routes', 'routes.generated.json'), 'utf8')).routes.map((route) => [route.id, route.path]));
  const people = (flag('people') ?? 'capApprover,projectManager,owner,unitAdmin,auditor,treasuryMaker').split(',');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'vi-VN' });
  const page = await context.newPage();
  for (const screen of screens) {
    const path = routes[screen];
    if (path === undefined) {
      console.log(`${screen} no route`);
      continue;
    }
    const line = [];
    for (const person of people) {
      try {
        await page.goto(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}devUser=${person}`);
        await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]', { timeout: 20_000 });
        await page.waitForTimeout(2500);
        const text = await page.evaluate(() => globalThis.document.body.innerText);
        line.push(`${person}=${verdictOf(text)}(${text.length})`);
      } catch {
        line.push(`${person}=ERROR`);
      }
    }
    console.log(`${screen} ${path}  ${line.join(' ')}`);
  }
  await browser.close();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
