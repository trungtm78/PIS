// Raw footage of the PWA (the installable web application of the leaders) on a running stack: a mobile browser (touch, small portrait screen, standalone display mode) opens the
// start page and the three screens as a person of the development session, moves like a finger and scrolls. One film for each screen, plus one joined film for the scene ph-pwa.
// Usage: node scripts/clips/record/pwa.mjs --web-url http://127.0.0.1:47513 --out D:/PIS-clips-out/phone [--persona owner] [--seconds 9] [--edition public]
// The films are listed in <out>/index.json (the index of the phone footage, schema phone-footage/1) under the keys pwa-<screen>.<edition> and ph-pwa.<edition>.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../../hdsd/tts.mjs';
import { argument } from '../common.mjs';
import { withPersona } from './scene.mjs';

/** The viewport of the phone (CSS pixels) and the size of the film: twice the viewport, portrait. */
export const VIEWPORT = { width: 360, height: 780 };
export const FILM = { width: 720, height: 1560 };

/** The screens of the PWA in the order of the story: the start page (install), then the three manager screens. */
export const PWA_SCREENS = [
  { key: 'pwa-start', path: '/m', screen: 'PWA-01', headline: 'Cài lên màn hình chính' },
  { key: 'pwa-approvals', path: '/m/approvals', screen: 'PWA-02', headline: 'Hàng đợi phê duyệt' },
  { key: 'pwa-dashboard', path: '/m/dashboard', screen: 'PWA-03', headline: 'Dashboard điều hành' },
  { key: 'pwa-directives', path: '/m/directives', screen: 'PWA-04', headline: 'Theo dõi chỉ đạo' },
];

/** Makes the page believe it runs as an installed application: `display-mode: standalone` matches, and `navigator.standalone` is true. */
export const STANDALONE_SCRIPT = `
(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    if (/display-mode\\s*:\\s*standalone/.test(query)) {
      const list = real('all');
      return Object.assign(Object.create(Object.getPrototypeOf(list)), { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
    }
    return real(query);
  };
  try { Object.defineProperty(navigator, 'standalone', { value: true }); } catch (error) { void error; }
})();
`;

const ffmpeg = (args) => {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (done.status !== 0) throw new Error(`ffmpeg failed: ${(done.stderr ?? '').split('\n').slice(-4).join(' ')}`);
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function scrollLikeAFinger(page, seconds) {
  const total = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight)).catch(() => 0);
  const steps = Math.max(6, Math.round(seconds * 3));
  for (let step = 1; step <= steps; step += 1) {
    await page.evaluate(([to]) => window.scrollTo({ top: to, behavior: 'smooth' }), [Math.round((total * step) / (steps * 1.4))]).catch(() => undefined);
    await sleep((seconds * 1000) / steps);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => undefined);
}

/** Films one screen: the page loads (the film starts after the screen is drawn), rests, scrolls and rests. Returns the path of the film made by the browser. */
export async function recordScreen(browser, { baseUrl, entry, persona, seconds, dir }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    recordVideo: { dir, size: FILM },
  });
  await context.addInitScript(STANDALONE_SCRIPT);
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`${baseUrl.replace(/\/+$/u, '')}${withPersona(entry.path, persona)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-screen-id], main, h1', { timeout: 30000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  const contentAt = Date.now() - started;
  await sleep(1800);
  const problems = await page.evaluate(() => ({ alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent?.trim() ?? '').filter(Boolean), busy: document.querySelectorAll('[aria-busy="true"]').length })).catch(() => ({ alerts: [], busy: 0 }));
  await scrollLikeAFinger(page, Math.max(2, seconds - 3.5));
  await sleep(800);
  await context.close();
  const path = await page.video().path();
  return { path, contentAt, problems };
}

/** Cuts the film to start when the screen is drawn and last `seconds`. */
function cut({ input, startSec, seconds, out }) {
  ffmpeg(['-ss', (startSec / 1000).toFixed(3), '-i', input, '-t', String(seconds), '-vf', `fps=30,scale=${FILM.width}:${FILM.height}:flags=bicubic,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-an', out]);
}

export function readIndex(file) {
  if (!existsSync(file)) return { schema: 'phone-footage/1', orientation: 'portrait', size: `${FILM.width}x${FILM.height}`, fps: 30, scenes: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function main(argv) {
  const webUrl = argument(argv, 'web-url');
  const outArgument = argument(argv, 'out');
  if (webUrl === undefined || outArgument === undefined) {
    console.error('usage: node scripts/clips/record/pwa.mjs --web-url http://127.0.0.1:47513 --out <dir> [--persona owner] [--seconds 9] [--edition public]');
    return 2;
  }
  const out = resolve(outArgument);
  const persona = argument(argv, 'persona') ?? 'owner';
  const seconds = Number(argument(argv, 'seconds') ?? 9);
  const edition = argument(argv, 'edition') ?? 'public';
  if (freemem() < 1.5 * 1024 ** 3) throw new Error('less than 1.5 GB of memory is free: wait before the browser starts');
  mkdirSync(out, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const made = [];
  try {
    for (const entry of PWA_SCREENS) {
      const raw = join(out, `${entry.key}.${edition}.work`);
      const recorded = await recordScreen(browser, { baseUrl: webUrl, entry, persona, seconds, dir: raw });
      const file = join(out, `${entry.key}.${edition}.mp4`);
      cut({ input: recorded.path, startSec: Math.max(0, recorded.contentAt - 200), seconds, out: file });
      rmSync(raw, { recursive: true, force: true });
      console.log(`${entry.key}: ${seconds} s${recorded.problems.alerts.length > 0 ? ` (page banners: ${recorded.problems.alerts.join(' | ')})` : ''}`);
      made.push({ entry, file });
    }
  } finally {
    await browser.close();
  }
  const list = join(out, `ph-pwa.${edition}.concat.txt`);
  writeFileSync(list, made.map((item) => `file '${item.file.replace(/\\/gu, '/')}'`).join('\n'));
  const joined = join(out, `ph-pwa.${edition}.mp4`);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', joined]);
  rmSync(list, { force: true });
  // The index is shared with the emulator footage: read it again right before writing.
  const indexFile = join(out, 'index.json');
  const index = readIndex(indexFile);
  for (const item of made) index.scenes[`${item.entry.key}.${edition}`] = { scene: item.entry.key, edition, file: item.file, durationMs: seconds * 1000, persona, headline: item.entry.headline, kind: 'pwa', display: 'standalone', screen: item.entry.screen };
  index.scenes[`ph-pwa.${edition}`] = { scene: 'ph-pwa', edition, file: joined, durationMs: seconds * 1000 * made.length, persona, headline: 'Ứng dụng web cài trên điện thoại (PWA)', kind: 'pwa', display: 'standalone', parts: made.map((item) => item.entry.key) };
  const temporary = `${indexFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(temporary, indexFile);
  console.log(`index: ${indexFile} (${Object.keys(index.scenes).length} films)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
