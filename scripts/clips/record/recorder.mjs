// Records a web scene: a real browser on the running stack, 1920x1080, a visible pointer with a click ripple, optional slow motion.
// The guard comes first: a clip is never recorded on a tenant whose key lists are empty. Output, in <out>/<scene id>/:
//   video.webm (what Playwright wrote), video.mp4 (constant 30 fps, what the assembly reads), timeline.json, shots/<step>.png
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { FFMPEG } from '../../hdsd/tts.mjs';
import { CURSOR_SCRIPT } from './cursor.mjs';
import { assertSeeded, devToken, loadRequirements } from './data-guard.mjs';
import { runScene, StepFailure } from './runner.mjs';
import { parseScene } from './scene.mjs';
import { constantRateArgs, timelineDocument } from './timeline.mjs';
import { Ui } from './ui.mjs';

export const VIEWPORT = { width: 1920, height: 1080 };
export const MIN_FREE_GB = 2.5;
export const OUT_ROOT = process.env.CLIPS_OUT ?? 'D:/tmp/clips-out';

/** The headers the guard reads the API with: a token given, or one signed with the session key of the stack. */
export function apiHeaders(env = process.env) {
  if (env.CLIPS_API_TOKEN) return { authorization: `Bearer ${env.CLIPS_API_TOKEN}` };
  const token = devToken({ key: env.E2E_SESSION_KEY, tenantId: env.CLIPS_TENANT_ID, membershipId: env.CLIPS_MEMBERSHIP_ID });
  return { authorization: `Bearer ${token}` };
}

/** Reads the key lists of the tenant and throws EmptyTenantError when they are empty (no browser is started). */
export function checkTenant(scene, { apiUrl, headers = apiHeaders(), fetchImpl, scale } = {}) {
  const requirements = loadRequirements(scene.edition ?? 'public');
  return assertSeeded({ baseUrl: apiUrl, headers, requirements, scale, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
}

function convert(input, output) {
  const done = spawnSync(FFMPEG, constantRateArgs({ input, output }), { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffmpeg failed: ${done.stderr}`);
}

/** Records one web scene; returns where the files are. */
export async function recordWebScene(rawScene, { baseUrl, apiUrl, outDir = join(OUT_ROOT, 'record'), slowMo = 1, audio, only, log = console.log, minFreeGb = MIN_FREE_GB, guard = checkTenant } = {}) {
  const scene = parseScene(rawScene);
  if (scene.platform !== 'web') throw new Error(`the scene ${scene.id} is a ${scene.platform} scene: use the phone recorder`);
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('the address of the web app is needed (--web-url)');
  // 1. The data: no browser until the tenant has what the clip shows.
  const verdict = await guard(scene, { apiUrl });
  log(`data guard: ${verdict.rows.map((row) => `${row.id}=${row.found}`).join(' ')}`);
  // 2. Memory: the lane brief asks for 2.5 GB free before a browser starts.
  if (freemem() < minFreeGb * 1024 ** 3) throw new Error(`less than ${minFreeGb} GB of memory is free: wait before starting a browser`);

  const dir = resolve(outDir, scene.id);
  rmSync(join(dir, 'raw'), { recursive: true, force: true });
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const { chromium } = await import('playwright');
  const channel = process.env.CLIPS_BROWSER_CHANNEL;
  const browser = await chromium.launch({ headless: true, ...(channel === undefined || channel === '' ? {} : { channel }) });
  let timeline = [];
  let failure = null;
  let video = null;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'vi-VN', recordVideo: { dir: join(dir, 'raw'), size: VIEWPORT } });
    await context.addInitScript(CURSOR_SCRIPT);
    const startedAt = Date.now();
    const page = await context.newPage();
    const ui = new Ui(page, { baseUrl, slowMo, persona: scene.persona });
    const clock = { now: () => Date.now() - startedAt, wait: (ms) => page.waitForTimeout(ms) };
    const shot = async (id) => {
      const path = join(dir, 'shots', `${id}.png`);
      await page.screenshot({ path });
      return path;
    };
    try {
      timeline = await runScene(scene, { ui, clock, audio, slowMo, only, shot, log });
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      failure = error;
      timeline = error.timeline;
    }
    video = page.video();
    await context.close();
    if (video === null) throw new Error('the page was not recorded');
    await video.saveAs(join(dir, 'video.webm'));
  } finally {
    await browser.close();
  }
  convert(join(dir, 'video.webm'), join(dir, 'video.mp4'));
  const file = join(dir, failure === null ? 'timeline.json' : 'timeline.failed.json');
  if (failure === null) writeFileSync(file, `${JSON.stringify(timelineDocument({ sceneId: scene.id, platform: 'web', slowMo, entries: timeline }), null, 2)}\n`);
  else writeFileSync(file, `${JSON.stringify({ flow: scene.id, failedStep: failure.stepId, error: failure.message, timeline }, null, 2)}\n`);
  if (failure !== null) throw failure;
  return { scene: scene.id, dir, video: join(dir, 'video.mp4'), timeline: file, steps: timeline.length };
}
