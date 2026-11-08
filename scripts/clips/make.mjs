import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../hdsd/tts.mjs';
import { CLIPS_DIR, REPO_ROOT, argument, flag, loadSpec, positionals, readJson } from './common.mjs';
import { loadScenario, selectScenes } from './scenario.mjs';
import { assColour } from './mix.mjs';
import { CURSOR_SCRIPT } from './record/cursor.mjs';
import { withPersona } from './record/scene.mjs';
import { Ui } from './record/ui.mjs';
import { sentencesOf } from './text.mjs';
import { buildTimeline, cuesOf, formatSrt, formatVtt, checkCues } from './subtitles.mjs';

/**
 * Assembles the screen film of a cut of a clip: one segment for each scene, exactly as long as the scene of the timeline (the measured voice plus the lead-in and the tail),
 *   - web scenes: a real browser on the running stack opens the screens of the scene as the persona and moves the pointer and scrolls while the voice speaks;
 *   - animatic and title scenes: the animatic of the scene is rendered (animatic/render.mjs) and held on its last picture;
 *   - phone scenes: see `phoneSegment` (the emulator when there is one, else the animatic cards of the phone chapter).
 * The on-screen captions and stamps of the timeline are burned into each segment; the segments are joined without re-encoding. The mixer then adds the voice, the
 * subtitles and the loudness (mix.mjs). The words come from the scenario; this file holds none.
 */
const VIEWPORT = { width: 1920, height: 1080 };
const ROUTES = Object.fromEntries(readJson(join(REPO_ROOT, 'apps', 'web', 'src', 'routes', 'routes.generated.json')).routes.map((route) => [route.id, route.path]));
const ANIMATIC_ALIASES = { 'platform-map': 'platform-public', 'service-flow': 'service-flow-public' };
/** The people the development session of the clip stack knows (apps/web/e2e/support/docs-people.json). */
const KNOWN_PERSONAS = new Set(readJson(join(REPO_ROOT, 'apps', 'web', 'e2e', 'support', 'docs-people.json')).map((person) => person.key));

const ffmpeg = (args) => {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (done.status !== 0) throw new Error(`ffmpeg failed: ${(done.stderr ?? '').split('\n').slice(-5).join(' ')}`);
};

const assTime = (ms) => {
  const total = Math.max(0, Math.round(ms / 10));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${Math.floor(total / 360000)}:${pad(Math.floor(total / 6000) % 60)}:${pad(Math.floor(total / 100) % 60)}.${pad(total % 100)}`;
};

/** The captions of one scene (on-screen stamps and notes) as an ASS file with times from the start of the scene; null when it has none. */
export function captionsAss(captions, sceneStartMs, file, spec = loadSpec()) {
  if (captions.length === 0) return null;
  const s = spec.subtitles;
  const tokens = readJson(join(REPO_ROOT, 'Design', 'MACHVON_Design', '04_Design_Assets', 'design_tokens.json'));
  const background = tokens.color[s.backgroundToken];
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 512',
    'PlayResY: 288',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Caption,${s.fontName},${s.fontSize + 1},${assColour('#FFFFFF')},${assColour('#FFFFFF')},${assColour(background, 0.86)},${assColour(background, 0.86)},-1,0,0,0,100,100,0,0,3,5,0,8,14,14,22,1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...captions.map((caption) => `Dialogue: 0,${assTime(caption.startMs - sceneStartMs)},${assTime(caption.endMs - sceneStartMs)},Caption,,0,0,0,,${caption.text.replace(/\n/gu, '\\N')}`),
    '',
  ];
  writeFileSync(file, lines.join('\n'));
  return file;
}

const filterPath = (path) => `'${path.replace(/\\/gu, '/').replace(/:/gu, '\\:').replace(/'/gu, "'\\''")}'`;
const fontsDir = resolve(REPO_ROOT, loadSpec().subtitles.fontDir);

/** One segment file of exactly `seconds`: the source cut or held, 1920x1080, 30 fps, with the captions burned in. */
function finishSegment({ input, startSec = 0, seconds, ass, out, hold }) {
  const filters = [`fps=30`, `scale=1920:1080:flags=lanczos`, 'format=yuv420p'];
  if (hold) filters.push(`tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds)}`);
  if (ass !== null) filters.push(`subtitles=filename=${filterPath(ass)}:fontsdir=${filterPath(fontsDir)}`);
  ffmpeg(['-ss', String(startSec), '-i', input, '-vf', filters.join(','), '-t', seconds.toFixed(3), '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
};

function renderAnimatic(id, out) {
  const data = ANIMATIC_ALIASES[id] ?? id;
  const done = spawnSync(process.execPath, [join(CLIPS_DIR, 'animatic', 'render.mjs'), data, '--out', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (done.status !== 0) throw new Error(`animatic ${data} failed: ${(done.stderr || done.stdout).split('\n').slice(-4).join(' ')}`);
}

/** The views of a web scene in order: the screens it opens as the persona that opens them. A screen the steps never open is added at the end. */
export function viewsOf(scene, defaultPersona = 'capApprover') {
  const views = [];
  let persona = defaultPersona;
  const personaOf = (name) => (KNOWN_PERSONAS.has(name) ? name : defaultPersona);
  for (const step of scene.steps) {
    if (step.do === 'as') persona = personaOf(step.persona);
    if (step.do === 'open' && ROUTES[step.screen] !== undefined && !views.some((view) => view.screen === step.screen)) views.push({ screen: step.screen, persona });
  }
  for (const screen of scene.screen.screens ?? []) if (ROUTES[screen] !== undefined && !views.some((view) => view.screen === screen)) views.push({ screen, persona });
  return views;
}

const EMPTY_SELECTION = new RegExp(readJson(join(CLIPS_DIR, 'record', 'empty-selection.json')).patterns.join('|'), 'u');
/** Screens whose pages hold the links (with the id of a record) that open the detail screens, tried in this order. */
const CONTEXT_HINTS = ['HOME-09', 'CTR-01', 'CTR-02', 'BID-01', 'BID-27', 'BID-28', 'BID-21', 'RPT-01', 'PRJ-27', 'HOME-02'];
const contextLinks = new Map();
/** Screens that stay empty without a record and for which none was found: they are left out of the film. */
const emptyScreens = new Set();
/** A detail screen that says "choose one" is a short page; a long page that happens to hold such words (a filter) is not empty. */
const isEmptySelection = (text) => text.length < 700 && EMPTY_SELECTION.test(text);

/** The internal links of the page now open (same origin, no query noise kept except what the app wrote). */
const hrefsOf = (page) => page.$eval('[data-screen-id] a[href]', (anchors) => [...new Set(anchors.map((anchor) => anchor.getAttribute('href')))].filter((href) => href.startsWith('/')));

/**
 * A detail screen opened with no record says "choose one": find a link of another screen that opens it with a record (the app writes the id in the link) and
 * return that address. Pages are searched breadth first, two levels deep, at most 12 pages.
 */
async function findContext(ui, page, target, persona, hints, log) {
  const prefix = ROUTES[target];
  if (contextLinks.has(target)) return contextLinks.get(target);
  const queue = [...hints.filter((id) => id !== target), ...CONTEXT_HINTS].map((id) => ROUTES[id]).filter((path) => path !== undefined && path !== prefix);
  const seen = new Set();
  const queries = [];
  let loads = 0;
  while (queue.length > 0 && loads < 12) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    loads += 1;
    await ui.goto(path, persona).catch(() => undefined);
    await page.waitForTimeout(1800);
    const links = await hrefsOf(page).catch(() => []);
    for (const href of links) if (/[?]([a-z_]+)=/u.test(href) && queries.length < 6) queries.push(href.slice(href.indexOf('?')));
    const hit = links.find((href) => href.startsWith(`${prefix}?`));
    if (hit !== undefined) {
      log(`  context of ${target} found on ${path}`);
      contextLinks.set(target, hit);
      return hit;
    }
    for (const href of links.filter((link) => !link.startsWith(prefix) && link.includes('?')).slice(0, 2)) if (!seen.has(href.split('?')[0]) && queue.length < 10) queue.push(href);
  }
  // The same record may open the screen with the query of a sibling screen (the contract of the portfolio is `?id=`).
  for (const query of queries) {
    await ui.goto(`${prefix}${query}`, persona).catch(() => undefined);
    const text = await page.locator('[data-screen-id]').first().innerText().catch(() => '');
    if (text !== '' && !EMPTY_SELECTION.test(text)) {
      log(`  context of ${target}: ${query.slice(0, 30)}`);
      contextLinks.set(target, `${prefix}${query}`);
      return `${prefix}${query}`;
    }
  }
  contextLinks.set(target, undefined);
  return undefined;
}

/** Records the views of a scene in an open browser for `durationMs` after the first screen has drawn; returns the file and the second the content begins at. */
async function recordViews(browser, { views: wanted, durationMs, baseUrl, dir, log }) {
  let views = wanted;
  // The records that open the detail screens are looked for first, in a page that is not filmed.
  const scout = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'vi-VN' });
  try {
    const scoutPage = await scout.newPage();
    const scoutUi = new Ui(scoutPage, { baseUrl, slowMo: 1 });
    for (const view of views) {
      if (contextLinks.has(view.screen)) continue;
      await scoutUi.goto(ROUTES[view.screen], view.persona).catch(() => undefined);
      const text = await scoutPage.locator('[data-screen-id]').first().innerText().catch(() => '');
      if (isEmptySelection(text)) {
        const address = await findContext(scoutUi, scoutPage, view.screen, view.persona, views.map((other) => other.screen), log);
        if (address === undefined) emptyScreens.add(view.screen);
      }
    }
  } finally {
    await scout.close();
  }
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'vi-VN', recordVideo: { dir, size: VIEWPORT } });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();
  const started = Date.now();
  const ui = new Ui(page, { baseUrl, slowMo: 1 });
  let contentAt = 0;
  const problems = [];
  const shown = views.filter((view) => !emptyScreens.has(view.screen));
  if (shown.length < views.length) log(`  left out (no record to open them): ${views.filter((view) => emptyScreens.has(view.screen)).map((view) => view.screen).join(' ')}`);
  views = shown.length > 0 ? shown : views;
  try {
    for (let index = 0; index < views.length; index += 1) {
      const view = views[index];
      const viewStart = Date.now();
      await ui.goto(ROUTES[view.screen], view.persona);
      const empty = isEmptySelection(await page.locator('[data-screen-id]').first().innerText().catch(() => ''));
      if (empty) {
        const address = contextLinks.get(view.screen);
        if (address !== undefined) await ui.goto(address, view.persona);
        else problems.push(`${view.screen}: no record to open it with`);
      }
      if (index === 0) contentAt = Date.now() - started;
      const alert = await page.locator('[role="alert"]').first().textContent({ timeout: 500 }).catch(() => null);
      if (alert !== null && alert.trim() !== '') problems.push(`${view.screen}: ${alert.trim().slice(0, 80)}`);
      const share = durationMs / views.length;
      const target = index === 0 ? contentAt + share : contentAt + share * (index + 1);
      const remaining = Math.max(2000, target - (Date.now() - started) - 0);
      const row = page.locator('[data-screen-id] table tbody tr, [data-screen-id] [role="row"], [data-screen-id] article, [data-screen-id] [class*="card"]').first();
      if ((await row.count()) > 0) await ui.hover(row).catch(() => undefined);
      await ui.scrollThrough(Math.max(1500, remaining - 700));
      log(`  view ${view.screen} as ${view.persona}: ${Date.now() - viewStart} ms`);
    }
    const left = contentAt + durationMs - (Date.now() - started);
    if (left > 0) await page.waitForTimeout(left);
  } finally {
    await context.close();
  }
  const video = page.video();
  const path = await video.path();
  return { path, contentAt, problems };
}

/** The phone scenes. The emulator is used when `--serial` is given (scripts/clips/record/phone.mjs); without one the scene is shown as a card (animatic) that names the phone screens. */
function phoneCard(scene, out, dir) {
  const id = `phone-${scene.id}`;
  const data = join(dir, `${id}.json`);
  writeFileSync(data, `${JSON.stringify({ id, kind: 'chapter', theme: 'dark', durationMs: 6000, fadeMs: 300, number: 9, title: scene.phoneTitle, summary: scene.phoneSummary, items: scene.phoneItems }, null, 2)}\n`);
  const done = spawnSync(process.execPath, [join(CLIPS_DIR, 'animatic', 'render.mjs'), data, '--out', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (done.status !== 0) throw new Error(`phone card failed: ${(done.stderr || done.stdout).split('\n').slice(-4).join(' ')}`);
}

async function main(argv) {
  const [clip, cut = 'main'] = positionals(argv, ['audio', 'manifest', 'web-url', 'out', 'only', 'phone-cards']);
  const audioPath = argument(argv, 'audio');
  const manifestPath = argument(argv, 'manifest');
  const out = argument(argv, 'out');
  if (clip === undefined || audioPath === undefined || manifestPath === undefined || out === undefined) {
    console.error('usage: node scripts/clips/make.mjs <clip> [main|chapter] --audio <clip>.audio.json --manifest data-manifest.json --web-url http://127.0.0.1:47313 --out <dir> [--only id,id] [--reuse] [--no-web]');
    return 2;
  }
  const scenario = loadScenario(clip);
  const scenes = selectScenes(scenario, cut);
  const audio = JSON.parse(readFileSync(audioPath, 'utf8')).scenes;
  const manifest = readJson(manifestPath);
  const timeline = buildTimeline(scenes, audio, { figures: scenario.figures, manifest, estimate: () => 0 });
  const dir = resolve(out);
  mkdirSync(join(dir, 'seg'), { recursive: true });
  writeFileSync(join(dir, `${clip}.${cut}.timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);
  const cues = cuesOf(timeline);
  writeFileSync(join(dir, `${clip}.${cut}.srt`), formatSrt(cues));
  writeFileSync(join(dir, `${clip}.${cut}.vtt`), formatVtt(cues));
  console.log(`${clip}/${cut}: ${scenes.length} scenes, ${(timeline.totalMs / 1000).toFixed(1)} s, ${cues.length} cues${checkCues(cues).length === 0 ? '' : ' (subtitle rule problems)'}`);

  const only = argument(argv, 'only')?.split(',');
  const reuse = flag(argv, 'reuse');
  const webUrl = argument(argv, 'web-url');
  let browser;
  const report = [];
  const segments = [];
  try {
    for (const entry of timeline.scenes) {
      const scene = scenes.find((candidate) => candidate.id === entry.id);
      const seconds = (entry.endMs - entry.startMs) / 1000;
      const file = join(dir, 'seg', `${entry.id}.mp4`);
      segments.push(file);
      if ((only !== undefined && !only.includes(entry.id)) || (reuse && existsSync(file))) {
        continue;
      }
      const ass = captionsAss(entry.captions, entry.startMs, join(dir, 'seg', `${entry.id}.ass`));
      const platform = scene.screen.platform;
      const stamp = Date.now();
      if (platform === 'title' || platform === 'animatic') {
        mkdirSync(join(dir, 'anim'), { recursive: true });
        const raw = join(dir, 'anim', `${scene.screen.animatic}.mp4`);
        if (!existsSync(raw)) renderAnimatic(scene.screen.animatic, raw);
        finishSegment({ input: raw, seconds, ass, out: file, hold: true });
        report.push({ id: entry.id, kind: 'animatic', animatic: scene.screen.animatic, seconds });
      } else if (platform === 'web' || platform === 'pwa') {
        const views = viewsOf(scene);
        if (webUrl === undefined || views.length === 0 || flag(argv, 'no-web')) throw new Error(`scene ${entry.id}: no web address or no screen to open`);
        if (freemem() < 1.5 * 1024 ** 3) throw new Error('less than 1.5 GB of memory is free: wait before the browser starts');
        if (browser === undefined) {
          const { chromium } = await import('playwright');
          browser = await chromium.launch({ headless: true });
        }
        const rawDir = join(dir, 'seg', `${entry.id}.raw`);
        rmSync(rawDir, { recursive: true, force: true });
        const recorded = await recordViews(browser, { views, durationMs: seconds * 1000, baseUrl: webUrl, dir: rawDir, log: console.log });
        finishSegment({ input: recorded.path, startSec: recorded.contentAt / 1000, seconds, ass, out: file, hold: true });
        rmSync(rawDir, { recursive: true, force: true });
        report.push({ id: entry.id, kind: 'web', screens: views.map((view) => view.screen), seconds, problems: recorded.problems });
      } else {
        const raw = join(dir, 'seg', `${entry.id}.raw.mp4`);
        const sentences = sentencesOf(entry.subtitles.map((cue) => cue.text).join(' '));
        phoneCard({ id: entry.id, phoneTitle: scenario.chapters.find((chapter) => chapter.id === scene.chapter)?.title ?? scene.id, phoneSummary: sentences[0], phoneItems: sentences.slice(1, 4) }, raw, join(dir, 'seg'));
        finishSegment({ input: raw, seconds, ass, out: file, hold: true });
        rmSync(raw, { force: true });
        report.push({ id: entry.id, kind: 'phone-card', seconds });
      }
      console.log(`segment ${entry.id} (${platform}) ${seconds.toFixed(1)} s made in ${((Date.now() - stamp) / 1000).toFixed(0)} s`);
    }
  } finally {
    if (browser !== undefined) await browser.close();
  }
  const absent = segments.filter((file) => !existsSync(file));
  if (absent.length > 0) {
    console.log(`${absent.length} segment(s) not made yet: no screen film joined`);
    return 0;
  }
  const list = join(dir, 'concat.txt');
  writeFileSync(list, segments.map((file) => `file '${file.replace(/\\/gu, '/')}'`).join('\n'));
  const screen = join(dir, `${clip}.${cut}.screen.mp4`);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', screen]);
  writeFileSync(join(dir, `${clip}.${cut}.make.json`), `${JSON.stringify({ screen, scenes: report }, null, 2)}\n`);
  console.log(`screen film: ${screen}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
