// Takes the screenshots of this directory from a running public demo (node scripts/demo-public.mjs): the main screens, signed in with the development session.
//   node docs/demo-camau/capture.mjs [--web http://127.0.0.1:5180] [--out docs/demo-camau]
// Chromium of Playwright, 1440x900, full page. For each screen it prints the JavaScript errors of the page and whether the page scrolls sideways.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(HERE, '..', '..', 'apps', 'web', 'package.json'))('@playwright/test');
const { values } = parseArgs({ options: { web: { type: 'string', default: 'http://127.0.0.1:5180' }, out: { type: 'string', default: HERE } } });

/** file, person of the development session, path, and what the screen is. */
export const SCREENS = [
  ['01-trang-chu-tong-quan-dieu-hanh', 'owner', '/home/home-01', 'HOME-01 Tổng quan điều hành'],
  ['02-danh-sach-du-an', 'owner', '/prj/prj-01', 'PRJ-01 Danh sách dự án'],
  ['03-giai-ngan-tong-hop-theo-chu-dau-tu', 'capApprover', '/dis/dis-12', 'DIS-12 Tổng hợp giải ngân theo chủ đầu tư'],
  ['04-giai-ngan-hai-ty-le', 'capApprover', '/dis/dis-19', 'DIS-19 Hai tỷ lệ giải ngân song song'],
  ['05-bang-deadline-toan-danh-muc', 'owner', '/pwf/pwf-07', 'PWF-07 Bảng deadline toàn danh mục'],
  ['06-bang-diem-don-vi', 'owner', '/pwf/pwf-12', 'PWF-12 Bảng điểm đơn vị'],
  ['07-cay-to-chuc', 'owner', '/adm/adm-01', 'ADM-01 Cây tổ chức'],
  ['08-bang-dieu-hanh-ban-chi-dao', 'docHead', '/ban/ban-01', 'BAN-01 Bảng điều hành Ban chỉ đạo'],
  ['09-viec-cua-toi-can-bo', 'projectManager', '/home/home-02', 'HOME-02 Việc của tôi (cán bộ Ban quản lý dự án)'],
];

const browser = await chromium.launch();
try {
  for (const [file, person, path, title] of SCREENS) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 160)));
    await page.goto(`${values.web}${path}?devUser=${person}`, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForTimeout(2500);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    await page.screenshot({ path: resolve(values.out, `${file}.png`), fullPage: true });
    process.stdout.write(`${file}.png  ${title}  errors=${errors.length}${errors.length > 0 ? ` (${errors[0]})` : ''}  sideways=${sideways}\n`);
    await context.close();
  }
} finally {
  await browser.close();
}
