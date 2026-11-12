// Captures the bearer token the web application sends for a development-session person (?devUser=<key>), the way a browser does; prints the base64 header value.
// node get-token.mjs <origin> <devUser> <outFile>   (run from a folder where @playwright/test is installed)
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');
const [origin, user, outFile] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
const seen = new Map();
page.on('request', (request) => {
  const headers = request.headers();
  if (request.url().includes('/api/') && headers.authorization) seen.set(request.url(), headers);
});
await page.goto(`${origin}/home/home-09?devUser=${user}`, { waitUntil: 'networkidle' });
await browser.close();
const first = [...seen.values()][0];
if (!first) { console.error('no authorised request seen'); process.exit(1); }
writeFileSync(outFile, JSON.stringify({ authorization: first.authorization, tenant: first['x-tenant-context'] ?? null, headers: Object.keys(first) }, null, 1));
console.log('captured headers:', Object.keys(first).join(','));
