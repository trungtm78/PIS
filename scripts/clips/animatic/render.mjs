// Renders an animatic to a 1920x1080, 30 fps H.264 file: frames are captured with Chromium (Playwright) at exact times and piped to ffmpeg.
//   node scripts/clips/animatic/render.mjs <scene id | path to a scene json> [--out file.mp4] [--fps 30] [--no-fade] [--max-seconds 3]
//   node scripts/clips/animatic/render.mjs <scene> --still 4000 --out frame.png     one picture instead of a film
//   node scripts/clips/animatic/render.mjs --list        the scenes in data/
//   node scripts/clips/animatic/render.mjs --probe file.mp4   size, frame rate, codec and length of a render
//   node scripts/clips/animatic/render.mjs --check       validate every scene in data/ (no browser)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../../hdsd/tts.mjs';
import { sceneProblems } from './scenes/index.mjs';
import {
  ANIMATIC_DIR, APP_CSS, FONT_DIR, FPS, HEIGHT, MIN_FREE_GB, TOKENS_CSS, WIDTH,
  contentTypeOf, encodeArgs, enoughMemory, fontFacesFrom, frameSchedule, listScenes, loadScene, pageHtml, parseArgs, parseVideoInfo, resolveStatic,
} from './lib.mjs';

/** Where renders go by default: outside the repository (a render is never committed). */
export const OUT_ROOT = process.env.CLIPS_OUT ?? 'D:/tmp/clips-out';

function startServer() {
  const roots = { '/static/': ANIMATIC_DIR, '/fonts/': FONT_DIR };
  const html = pageHtml({
    tokensCss: readFileSync(TOKENS_CSS, 'utf8'),
    fontCss: fontFacesFrom(readFileSync(APP_CSS, 'utf8')),
    stageCss: readFileSync(join(ANIMATIC_DIR, 'stage.css'), 'utf8'),
  });
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/' || url.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    const file = resolveStatic(url, roots);
    if (file === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { 'content-type': contentTypeOf(file) });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end();
    }
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

function startEncoder(out, fps) {
  const encoder = spawn(FFMPEG, encodeArgs({ fps, out }), { stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  encoder.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const exited = new Promise((done, fail) => {
    encoder.once('error', fail);
    encoder.once('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg failed (${code}): ${errors.trim().slice(-600)}`))));
  });
  // A write after ffmpeg has died would otherwise surface as an unhandled stream error.
  encoder.stdin.on('error', () => undefined);
  return { encoder, exited };
}

const writeFrame = (stream, buffer) => new Promise((done, fail) => stream.write(buffer, (error) => (error ? fail(error) : done())));

const FONT_PROBE = 'a\u0103\u00E2\u0111\u00EA\u00F4\u01A1\u01B0\u1EA0\u1EF9';

/** A page with the scene loaded and every font ready; `close` shuts the browser and the local server. */
async function openStage(scene, minFreeGb) {
  const problems = sceneProblems(scene);
  if (problems.length > 0) throw new Error(`the scene cannot be rendered: ${problems.join('; ')}`);
  if (!enoughMemory(freemem(), minFreeGb)) throw new Error(`less than ${minFreeGb} GB of memory is free: wait before starting a browser`);
  const { chromium } = await import('playwright');
  const channel = process.env.CLIPS_BROWSER_CHANNEL;
  const { server, port } = await startServer();
  const browser = await chromium.launch({ headless: true, ...(channel === undefined || channel === '' ? {} : { channel }) });
  const close = async () => {
    await browser.close();
    server.close();
  };
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, locale: 'vi-VN' });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => globalThis.__animaticReady === true);
    await page.evaluate((data) => globalThis.__animatic.load(data), scene);
    // Fonts are fetched when the first glyph needs them: draw once, then wait for every weight so that no frame is set in a fallback font.
    await page.evaluate(() => globalThis.__animatic.render(0));
    await page.evaluate(async (probe) => {
      for (const weight of [400, 500, 600, 700]) await globalThis.document.fonts.load(`${weight} 24px "Be Vietnam Pro"`, probe);
      await globalThis.document.fonts.ready;
    }, FONT_PROBE);
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** One picture of a scene at `tMs` (to look at a design, or for a poster frame). */
export async function renderStill(scene, { out, tMs, minFreeGb = MIN_FREE_GB } = {}) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const { page, close } = await openStage(scene, minFreeGb);
  try {
    await page.evaluate((t) => globalThis.__animatic.render(t), tMs);
    await page.screenshot({ path: resolve(out), type: 'png' });
  } finally {
    await close();
  }
  return { out: resolve(out), tMs };
}

/** Renders one scene (its data object) to `out`; returns the facts of the film. `maxSeconds` cuts a smoke render short. */
export async function renderAnimatic(scene, { out, fps = FPS, maxSeconds = Infinity, minFreeGb = MIN_FREE_GB, log = console.log } = {}) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const schedule = frameSchedule(scene.durationMs, fps, Math.floor(maxSeconds * fps));
  const { page, close } = await openStage(scene, minFreeGb);
  const { encoder, exited } = startEncoder(resolve(out), fps);
  try {
    for (const frame of schedule) {
      await page.evaluate((t) => globalThis.__animatic.render(t), frame.tMs);
      await writeFrame(encoder.stdin, await page.screenshot({ type: 'png' }));
      if (frame.index % (fps * 2) === 0) log(`${scene.id ?? scene.kind}: frame ${frame.index + 1}/${schedule.length}`);
    }
    encoder.stdin.end();
    await exited;
  } catch (error) {
    encoder.kill();
    throw error;
  } finally {
    await close();
  }
  return { out: resolve(out), frames: schedule.length, fps, durationMs: (schedule.length * 1000) / fps, size: `${WIDTH}x${HEIGHT}`, height: HEIGHT };
}

/** The facts of a video file: size, frame rate, codec, length. */
export function probeVideo(file) {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return parseVideoInfo(`${done.stderr}${done.stdout}`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.list === true) {
    for (const id of listScenes()) console.log(id);
    return;
  }
  if (typeof flags.probe === 'string') {
    console.log(JSON.stringify(probeVideo(flags.probe)));
    return;
  }
  if (flags.check === true) {
    let bad = 0;
    for (const id of listScenes()) {
      const found = sceneProblems(loadScene(id));
      if (found.length > 0) bad += 1;
      console.log(`${found.length === 0 ? 'ok  ' : 'FAIL'} ${id}${found.length === 0 ? '' : `: ${found.join('; ')}`}`);
    }
    process.exitCode = bad === 0 ? 0 : 1;
    return;
  }
  const [id] = positional;
  if (id === undefined) {
    console.error('usage: node scripts/clips/animatic/render.mjs <scene id | json file> [--out file.mp4] [--fps 30] [--no-fade] [--no-captions] [--max-seconds n] [--still ms] | --list | --check');
    process.exitCode = 1;
    return;
  }
  const scene = loadScene(id, { ...(flags['no-fade'] === true ? { fadeMs: 0 } : {}), ...(flags['no-captions'] === true ? { hideCaptions: true } : {}) });
  const name = scene.id ?? id;
  if (typeof flags.still === 'string') {
    const out = typeof flags.out === 'string' ? flags.out : join(OUT_ROOT, 'animatic', `${name}-${flags.still}.png`);
    const done = await renderStill(scene, { out, tMs: Number(flags.still) });
    console.log(`${done.out}: frame at ${done.tMs} ms`);
    return;
  }
  const out = typeof flags.out === 'string' ? flags.out : join(OUT_ROOT, 'animatic', `${name}.mp4`);
  const done = await renderAnimatic(scene, {
    out,
    fps: typeof flags.fps === 'string' ? Number(flags.fps) : FPS,
    maxSeconds: typeof flags['max-seconds'] === 'string' ? Number(flags['max-seconds']) : Infinity,
  });
  console.log(`${done.out}: ${done.frames} frames at ${done.fps} fps (${done.durationMs} ms)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
