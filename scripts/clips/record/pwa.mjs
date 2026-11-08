// Records the installed manager application (PWA, docs/pwa.md) on the running stack: a phone-sized browser in standalone display mode, the four screens under /m
// (start page, approval queue, leader dashboard, directive tracking), a visible touch ripple. Output: <out>/<name>.mp4 (720x1560, 30 fps) and an entry in <out>/index.json
// (schema phone-footage/1, shared with the phone footage of the emulator).
//   node scripts/clips/record/pwa.mjs --web-url http://127.0.0.1:47513 --edition enterprise [--persona capApprover] [--out D:/PIS-clips-out/phone] [--seconds 7]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FFMPEG } from '../../hdsd/tts.mjs';
import { CURSOR_SCRIPT } from './cursor.mjs';
import { withPersona } from './scene.mjs';

export const PWA_VIEWPORT = { width: 360, height: 780 };
export const PWA_VIDEO = { width: 720, height: 1560 };
export const PWA_SCREENS = [
  { id: 'PWA-01', path: '/m?source=pwa', headline: 'Trang khởi động của ứng dụng cài đặt' },
  { id: 'PWA-02', path: '/m/approvals', headline: 'Hàng đợi phê duyệt số liệu kỳ' },
  { id: 'PWA-03', path: '/m/dashboard', headline: 'Dashboard lãnh đạo' },
  { id: 'PWA-04', path: '/m/directives', headline: 'Theo dõi chỉ đạo' },
];

/** The page script that makes the browser say it runs as an installed application (display-mode: standalone). */
export const STANDALONE_SCRIPT = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const list = real(query);
    if (!/display-mode:\\s*standalone/u.test(query)) return list;
    return new Proxy(list, { get: (target, key) => (key === 'matches' ? true : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
  };
  Object.defineProperty(navigator, 'standalone', { get: () => true });
})();`;

/** An entry of the index of the footage. Pure. */
export function indexEntry({ name, edition, file, durationMs, persona, headline }) {
  return [name, { scene: name.replace(`.${edition}`, ''), edition, file, durationMs, persona, headline }];
}

function convert(input, output) {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', `fps=30,scale=${PWA_VIDEO.width}:${PWA_VIDEO.height}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an', output], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffmpeg failed: ${done.stderr}`);
}

export async function recordPwa({ baseUrl, edition = 'enterprise', persona = 'capApprover', outDir = 'D:/PIS-clips-out/phone', seconds = 7, name = `ent-pwa-all`, log = console.log } = {}) {
  const out = resolve(outDir);
  const raw = join(out, `.raw-${name}`);
  mkdirSync(raw, { recursive: true });
  const { chromium } = await import('playwright');
  const channel = process.env.CLIPS_BROWSER_CHANNEL;
  const browser = await chromium.launch({ headless: true, ...(channel === undefined || channel === '' ? {} : { channel }) });
  const started = Date.now();
  let videoPath;
  try {
    const context = await browser.newContext({ viewport: PWA_VIEWPORT, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'vi-VN', recordVideo: { dir: raw, size: PWA_VIEWPORT } });
    await context.addInitScript(STANDALONE_SCRIPT);
    await context.addInitScript(CURSOR_SCRIPT);
    const page = await context.newPage();
    for (const screen of PWA_SCREENS) {
      await page.goto(`${baseUrl}${withPersona(screen.path, persona)}`);
      await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"], main', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForFunction(() => globalThis.document.querySelector('[aria-busy="true"]') === null, undefined, { timeout: 15_000 }).catch(() => undefined);
      log(`${screen.id} ${await page.title()}`);
      await page.waitForTimeout(1500);
      // A slow scroll through the page, as a thumb does, then a pause on the top again.
      const room = await page.evaluate(() => Math.max(0, globalThis.document.scrollingElement.scrollHeight - globalThis.innerHeight));
      const steps = 24;
      const share = Math.min(room, 900) / steps;
      for (let step = 1; step <= steps; step += 1) {
        await page.evaluate((top) => globalThis.scrollTo(0, top), share * step);
        await page.waitForTimeout(Math.max(40, ((seconds - 3) * 1000) / steps));
      }
      await page.waitForTimeout(800);
    }
    const video = page.video();
    await context.close();
    videoPath = await video.path();
  } finally {
    await browser.close();
  }
  const mp4 = join(out, `${name}.${edition}.mp4`);
  convert(videoPath, mp4);
  rmSync(raw, { recursive: true, force: true });
  const indexFile = join(out, 'index.json');
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { schema: 'phone-footage/1', orientation: 'portrait', size: `${PWA_VIDEO.width}x${PWA_VIDEO.height}`, fps: 30, scenes: {} };
  const [key, entry] = indexEntry({ name: `${name}.${edition}`, edition, file: mp4.replace(/\//gu, '\\'), durationMs: Date.now() - started, persona, headline: 'Ứng dụng cài đặt (PWA) cho lãnh đạo: phê duyệt, dashboard, chỉ đạo' });
  index.scenes[key] = { ...entry, kind: 'pwa', screens: PWA_SCREENS.map((screen) => screen.id) };
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  void renameSync;
  log(`written ${mp4}`);
  return mp4;
}

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))) {
  const baseUrl = flag('web-url');
  if (baseUrl === undefined) {
    console.error('usage: node scripts/clips/record/pwa.mjs --web-url <url> [--edition enterprise] [--persona capApprover] [--out dir] [--seconds 7]');
    process.exitCode = 1;
  } else {
    await recordPwa({ baseUrl, edition: flag('edition'), persona: flag('persona'), outDir: flag('out'), seconds: flag('seconds') === undefined ? undefined : Number(flag('seconds')) });
  }
}
