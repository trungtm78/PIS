// Takes the screenshots of docs/demo-camau/production from the demo INSTALLATION, signed in the way a person signs in (the sign-in page of the realm):
//   ssh <server> "type C:\ProgramData\MACHVON\secrets\admin\demo-credentials.json" | node docs/demo-camau/capture-production.mjs [--out docs/demo-camau/production] [--only 01,05]
// The credentials are read from the standard input and never written. Chromium of Playwright, 1440x900, full page. For each screen it prints the JavaScript errors of the
// page, the failed API calls (status 500 and above), whether the page scrolls sideways and whether a word of the older demo province is on it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openScreen, signIn } from './sign-in.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(HERE, '..', '..', 'apps', 'web', 'package.json'))('@playwright/test');
const { values } = parseArgs({ options: { out: { type: 'string', default: join(HERE, 'production') }, only: { type: 'string' }, person: { type: 'string', default: 'owner' } } });
const text = readFileSync(0, 'utf8');
const credentials = JSON.parse(text.slice(text.indexOf('{')));
const account = credentials.people[values.person];
const OLD_WORDS = /Cao Bằng|Thục Phán|Nùng Trí Cao|Sông Hiến|Bản Giốc|Quảng Hòa/u;

/** file, path, what the screen is, and (optionally) what to do on the page before the picture. */
export const SCREENS = [
  ['01-tong-quan-dieu-hanh', '/home/home-01', 'HOME-01 Tổng quan điều hành'],
  ['02-viec-cua-toi', '/home/home-02', 'HOME-02 Việc của tôi'],
  ['03-canh-bao-som', '/home/home-03', 'HOME-03 Cảnh báo sớm'],
  ['04-danh-sach-du-an', '/prj/prj-01', 'PRJ-01 Danh sách dự án'],
  ['05-ke-hoach-von-nam', '/cap/cap-03', 'CAP-03 Kế hoạch năm'],
  ['06-nguon-von', '/cap/cap-04', 'CAP-04 Nguồn vốn'],
  ['07-giai-ngan-tong-hop', '/dis/dis-12', 'DIS-12 Tổng hợp giải ngân theo chủ đầu tư'],
  ['08-goi-thau', '/bid/bid-03', 'BID-03 Gói thầu và đề án'],
  ['09-nha-thau', '/bid/bid-01', 'BID-01 Danh sách nhà thầu'],
  ['10-hop-dong', '/ctr/ctr-01', 'CTR-01 Hợp đồng'],
  ['11-thanh-toan', '/pay/pay-01', 'PAY-01 Thanh toán'],
  ['12-bang-deadline', '/pwf/pwf-07', 'PWF-07 Bảng deadline toàn danh mục'],
  ['13-bang-diem-don-vi', '/pwf/pwf-12', 'PWF-12 Bảng điểm đơn vị'],
  ['14-cay-to-chuc', '/adm/adm-01', 'ADM-01 Cây tổ chức'],
  ['15-van-ban-di', '/doc/doc-03', 'DOC-03 Danh sách văn bản đi'],
  ['16-theo-doi-phe-duyet', '/adm/adm-18', 'ADM-18 Theo dõi quy trình phê duyệt'],
  ['17-ban-chi-dao', '/ban/ban-01', 'BAN-01 Bảng điều hành Ban chỉ đạo'],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
const page = await context.newPage();
const errors = [];
const failed = [];
page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 160)));
page.on('response', (response) => {
  if (response.status() >= 500 && response.url().includes('/api/')) failed.push(`${response.status()} ${new URL(response.url()).pathname}`);
});
try {
  await signIn(page, credentials.origin, account);
  process.stdout.write(`signed in as ${account.username}: ${new URL(page.url()).pathname}\n`);
  const only = values.only === undefined ? undefined : new Set(values.only.split(','));
  for (const [file, path, title] of SCREENS) {
    if (only !== undefined && !only.has(file.slice(0, 2))) continue;
    errors.length = 0;
    failed.length = 0;
    const shown = await openScreen(page, credentials.origin, path, title.split(' ')[0]).catch((error) => { errors.push(`open: ${String(error.message).slice(0, 100)}`); return false; });
    await page.waitForTimeout(2500);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    const body = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: resolve(values.out, `${file}.png`), fullPage: true });
    process.stdout.write(`${file}.png  ${title}  errors=${errors.length}${errors.length > 0 ? ` (${errors[0]})` : ''}  api5xx=${failed.length}${failed.length > 0 ? ` (${failed[0]})` : ''}  sideways=${sideways}  oldWords=${OLD_WORDS.test(body)}  chars=${body.length}\n`);
  }
} finally {
  await browser.close();
}
