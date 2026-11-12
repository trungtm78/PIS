// Evidence for the public-edition failure of apps/web/e2e/mdm-flows.spec.ts:583 (MDM-37): opens the screen as the development person and lists the labelled controls; saves a screenshot. Not a test, no verdict.
import { createRequire } from 'node:module'; import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');
const [origin, user, shot] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto(`${origin}/mdm/mdm-37?devUser=${user}`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
console.log('title:', await p.title());
console.log('headings:', JSON.stringify(await p.locator('h1,h2').allInnerTexts()));
console.log('has label "Loại danh mục":', await p.getByLabel('Loại danh mục', { exact: true }).count());
console.log('labels:', JSON.stringify(await p.locator('label').allInnerTexts()));
console.log('body:', (await p.locator('main').innerText().catch(() => '')).slice(0, 300).replace(/\n/g, ' | '));
await p.screenshot({ path: shot });
await b.close();
