// Takes the screenshots of the "quy trình" screens from the demo INSTALLATION, signed in the way a person signs in (the sign-in page of the realm):
//   ssh <server> "type C:\ProgramData\MACHVON\secrets\admin\demo-credentials.json" | node docs/demo-camau/capture-quy-trinh.mjs [--out docs/demo-camau/production/quy-trinh]
// The credentials are read from the standard input and never written. The ids of the projects and of the tasks are read from the API (clip-seed-client), so the script follows the data.
// Chromium of Playwright, 1440 px wide, full page. For each screen it prints the JavaScript errors of the page, the failed API calls (500 and above) and whether the page scrolls sideways.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiReader } from '../../scripts/clip-seed-client.mjs';
import { brokerOf } from '../../scripts/clip-seed-auth.mjs';
import { openScreen, signIn } from './sign-in.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(HERE, '..', '..', 'apps', 'web', 'package.json'))('@playwright/test');
const { values } = parseArgs({ options: { out: { type: 'string', default: join(HERE, 'production', 'quy-trinh') } } });
const text = readFileSync(0, 'utf8');
const credentials = JSON.parse(text.slice(text.indexOf('{')));
const reader = new ApiReader({ base: `${credentials.origin}/api`, tokenOf: (person) => broker.token(person) });
const broker = brokerOf(credentials, {});

const projects = await reader.list('owner', '/resources/project');
const idOf = (code) => projects.find((row) => row.code === code)?.id;
const taskOf = async (projectCode, taskCode) => (await reader.list('owner', `/projects/${idOf(projectCode)}/workflow/tasks`)).find((row) => row.task_code === taskCode)?.id;

const MID = 'DA-DT205';
const CLAIM = 'DA-GT105';
const decision = await taskOf(MID, 'RR_DECISION');
const estimate = await taskOf(CLAIM, 'RR_ESTIMATE');
const proposal = (await reader.get('owner', `/projects/${idOf(MID)}/workflow`)).json.pending_reschedule?.proposal_id;

/** person, file, path, screen id, what the screen is. */
const SCREENS = [
  ['owner', '01-quy-trinh-cua-du-an-giua-chung', `/prj/prj-03?id=${idOf(MID)}&tab=workflow`, 'PRJ-03', 'PWF-03 Quy trình của dự án (giữa chừng, hạn chung có nguy cơ)'],
  ['owner', '02-chi-tiet-viec', `/pwf/pwf-04?id=${decision}&project=${idOf(MID)}`, 'PWF-04', 'PWF-04 Chi tiết một việc (đang làm, hạn vàng)'],
  ['owner', '03-de-nghi-gia-han', `/pwf/pwf-06?id=${idOf(MID)}${proposal === undefined ? '' : `&proposal=${proposal}`}`, 'PWF-06', 'PWF-06 Đề nghị dời lịch, gia hạn đang chờ quyết định'],
  ['owner', '04-bang-deadline', '/pwf/pwf-07', 'PWF-07', 'PWF-07 Bảng deadline toàn danh mục'],
  ['owner', '05-trang-chu-canh-bao', '/home/home-03', 'HOME-03', 'HOME-03 Cảnh báo sớm'],
  ['projectManager', '06-viec-chua-co-nguoi-nhan', `/pwf/pwf-04?id=${estimate}&project=${idOf(CLAIM)}`, 'PWF-04', 'PWF-04 Việc chưa có người nhận (canbo.qlda, nút "Nhận việc")'],
  ['projectManager', '07-viec-chua-co-nguoi-nhan-trang-chu', '/home/home-02', 'HOME-02', 'HOME-02 Việc của tôi: việc chưa có người nhận (canbo.qlda)', 'Chưa có người nhận'],
  ['capApprover', '08-han-chung-co-nguy-co-lanh-dao', '/home/home-02', 'HOME-02', 'HOME-02 Việc của tôi của lãnh đạo: hạn chung của hồ sơ có nguy cơ (lanhdao)', 'Hạn chung của hồ sơ'],
];

const browser = await chromium.launch();
try {
  for (const person of [...new Set(SCREENS.map((one) => one[0]))]) {
    const account = credentials.people[person];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1900 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await context.newPage();
    const errors = [];
    const failed = [];
    page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 160)));
    page.on('response', (response) => {
      if (response.status() >= 500 && response.url().includes('/api/')) failed.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    await signIn(page, credentials.origin, account);
    process.stdout.write(`signed in as ${account.username}\n`);
    for (const [who, file, path, screenId, title, focus] of SCREENS) {
      if (who !== person) continue;
      errors.length = 0;
      failed.length = 0;
      const shown = await openScreen(page, credentials.origin, path, screenId).catch((error) => { errors.push(`open: ${String(error.message).slice(0, 100)}`); return false; });
      await page.waitForTimeout(3000);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      const body = await page.evaluate(() => document.body.innerText);
      if (focus !== undefined) {
        // A long list: the window is moved to the row the picture is about.
        // The list is long and cut: when the row is not there, the chips of the levels narrow it until it is.
        const chips = page.locator('.mv-alert-chip[data-severity]');
        for (let index = 0; index < (await chips.count()) && (await page.getByText(focus).count()) === 0; index += 1) await chips.nth(index).click();
        const row = page.getByText(focus).first();
        await row.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.scrollBy(0, 0));
        const box = await row.boundingBox();
        const top = Math.max(0, Math.round((box?.y ?? 0) + (await page.evaluate(() => window.scrollY)) - 260));
        await page.screenshot({ path: resolve(values.out, `${file}.png`), fullPage: true, clip: { x: 0, y: top, width: 1440, height: 760 } });
        process.stdout.write(`${file}.png  ${title}  shown=${shown}  errors=${errors.length}  api5xx=${failed.length}
`);
        continue;
      }
      // A tall viewport keeps the bar of actions of a task (it sticks to the bottom of the window) under the content; a long list is cut at 2600 px.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.screenshot({ path: resolve(values.out, `${file}.png`), ...(height > 2600 ? { clip: { x: 0, y: 0, width: 1440, height: 2600 } } : { fullPage: true }) });
      const count = (words) => body.split(words).length - 1;
      process.stdout.write(`${file}.png  ${title}  shown=${shown}  errors=${errors.length}${errors.length > 0 ? ` (${errors[0]})` : ''}  api5xx=${failed.length}${failed.length > 0 ? ` (${failed[0]})` : ''}  sideways=${sideways}  workflowWord=${/workflow/i.test(body)}  chuaCoNguoiNhan=${count('Chưa có người nhận')}  hanChungNguyCo=${count('Hạn chung')}  chars=${body.length}\n`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
