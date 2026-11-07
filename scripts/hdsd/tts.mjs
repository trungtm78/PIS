import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir, hashOf, loadFlow, parseCues, parseFfmpegDuration, VOICE } from './lib.mjs';

const PYTHON = process.env.HDSD_PYTHON ?? 'D:/Python312/python.exe';
export const FFMPEG = process.env.HDSD_FFMPEG ?? 'D:/Python312/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';

/** How long a file lasts: ffmpeg prints it when it is asked to read a file and told nothing else to do. */
export function probeMs(file) {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return parseFfmpegDuration(`${done.stderr}${done.stdout}`);
}

/** Waits without spinning (the narration is made by synchronous calls). */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The seconds to wait before each new attempt when the service answers with no audio (it does so for a while when it is asked too fast). */
export const RETRY_WAITS_S = [4, 8, 15, 30, 45, 60, 90, 120, 180, 240];

const spoken = (file) => existsSync(file) && statSync(file).size > 0;

/** Speaks one narration with the neural voice of Microsoft Edge (the words go to the service of Microsoft; nothing else does). It tries again when the service sends nothing. */
function speak(text, mp3, vtt) {
  let failure = '';
  for (let attempt = 0; attempt <= RETRY_WAITS_S.length; attempt += 1) {
    rmSync(mp3, { force: true });
    rmSync(vtt, { force: true });
    const done = spawnSync(PYTHON, ['-m', 'edge_tts', '--voice', VOICE, '--text', text, '--write-media', mp3, '--write-subtitles', vtt], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
      timeout: 120_000,
    });
    if (done.status === 0 && spoken(mp3) && spoken(vtt)) {
      pause(800);
      return;
    }
    failure = done.stderr || done.stdout || 'no audio';
    rmSync(mp3, { force: true });
    rmSync(vtt, { force: true });
    if (attempt < RETRY_WAITS_S.length) pause(RETRY_WAITS_S[attempt] * 1000);
  }
  throw new Error(`the voice failed for "${text.slice(0, 40)}": ${failure.split('\n').slice(-3).join(' ')}`);
}

/** Runs `work` on every item with at most `limit` in flight; the answers come back in the order of the items. */
export async function mapLimit(items, limit, work) {
  const answers = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      answers[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return answers;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** One narration spoken without blocking: the same tries as `speak`, so that several can be asked for at once. */
async function speakLater(text, mp3, vtt) {
  let failure = '';
  for (let attempt = 0; attempt <= RETRY_WAITS_S.length; attempt += 1) {
    rmSync(mp3, { force: true });
    rmSync(vtt, { force: true });
    const outcome = await new Promise((done) => {
      const child = spawn(PYTHON, ['-m', 'edge_tts', '--voice', VOICE, '--text', text, '--write-media', mp3, '--write-subtitles', vtt], { env: { ...process.env, PYTHONUTF8: '1' } });
      let said = '';
      child.stderr.on('data', (chunk) => (said += chunk));
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, said });
      });
    });
    if (outcome.code === 0 && spoken(mp3) && spoken(vtt)) return;
    failure = outcome.said || 'no audio';
    rmSync(mp3, { force: true });
    rmSync(vtt, { force: true });
    if (attempt < RETRY_WAITS_S.length) await sleep(RETRY_WAITS_S[attempt] * 1000);
  }
  throw new Error(`the voice failed for "${text.slice(0, 40)}": ${failure.split('\n').slice(-3).join(' ')}`);
}

/** The steps of a flow that have no voice yet are asked for together (a few at a time); the service refuses many of the calls, and asked one by one it takes a long time. */
export async function warm(flowId, { root, cache = cacheDir(), limit = 4, log = console.log } = {}) {
  const flow = loadFlow(flowId, root);
  const audioDir = join(cache, 'audio');
  mkdirSync(audioDir, { recursive: true });
  const wanted = new Map();
  for (const step of flow.steps) {
    const key = hashOf(step.text);
    const mp3 = join(audioDir, `${key}.mp3`);
    const vtt = join(audioDir, `${key}.vtt`);
    if (!spoken(mp3) || !spoken(vtt)) wanted.set(key, { text: step.text, mp3, vtt, id: step.id });
  }
  await mapLimit([...wanted.values()], limit, async (item) => {
    await speakLater(item.text, item.mp3, item.vtt);
    log(`voice: ${flowId}/${item.id}`);
  });
}

/** The audio of every step of a flow: spoken once, kept by the hash of its words; the answer says where each file is and how long it lasts. */
export function narrate(flowId, { root, cache = cacheDir(), log = console.log } = {}) {
  // The missing voices are asked for in a child process, several at once; what it could not make is made below, one by one.
  if (process.env.HDSD_VOICE_PARALLEL !== '0') spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--warm', flowId], { stdio: 'inherit', env: { ...process.env, ...(root === undefined ? {} : { HDSD_ROOT: root }), HDSD_CACHE: cache } });
  const flow = loadFlow(flowId, root);
  const audioDir = join(cache, 'audio');
  mkdirSync(audioDir, { recursive: true });
  const steps = {};
  for (const step of flow.steps) {
    const key = hashOf(step.text);
    const mp3 = join(audioDir, `${key}.mp3`);
    const vtt = join(audioDir, `${key}.vtt`);
    if (!spoken(mp3) || !spoken(vtt)) {
      speak(step.text, mp3, vtt);
      log(`voice: ${flowId}/${step.id}`);
    }
    steps[step.id] = { mp3, vtt, durationMs: probeMs(mp3), cues: parseCues(readFileSync(vtt, 'utf8')) };
  }
  const index = join(cache, `${flowId}.audio.json`);
  writeFileSync(index, `${JSON.stringify({ flow: flowId, voice: VOICE, steps }, null, 2)}\n`);
  return { index, steps };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const warming = args[0] === '--warm';
  const ids = warming ? args.slice(1) : args;
  if (warming) {
    for (const id of ids) await warm(id, { root: process.env.HDSD_ROOT, cache: process.env.HDSD_CACHE ?? cacheDir() }).catch((error) => console.error(String(error.message ?? error)));
  } else if (ids.length === 0) {
    console.error('usage: node scripts/hdsd/tts.mjs <flow id>...');
    process.exitCode = 1;
  } else {
    for (const id of ids) {
      const { steps } = narrate(id);
      const total = Object.values(steps).reduce((sum, step) => sum + step.durationMs, 0);
      console.log(`${id}: ${Object.keys(steps).length} steps, ${(total / 1000).toFixed(1)} s of voice`);
    }
  }
}
