import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Speaks one narration with the neural voice of Microsoft Edge (the words go to the service of Microsoft; nothing else does). */
function speak(text, mp3, vtt) {
  const done = spawnSync(PYTHON, ['-m', 'edge_tts', '--voice', VOICE, '--text', text, '--write-media', mp3, '--write-subtitles', vtt], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
    timeout: 120_000,
  });
  if (done.status !== 0 || !existsSync(mp3)) throw new Error(`the voice failed for "${text.slice(0, 40)}": ${done.stderr || done.stdout}`);
}

/** The audio of every step of a flow: spoken once, kept by the hash of its words; the answer says where each file is and how long it lasts. */
export function narrate(flowId, { root, cache = cacheDir(), log = console.log } = {}) {
  const flow = loadFlow(flowId, root);
  const audioDir = join(cache, 'audio');
  mkdirSync(audioDir, { recursive: true });
  const steps = {};
  for (const step of flow.steps) {
    const key = hashOf(step.text);
    const mp3 = join(audioDir, `${key}.mp3`);
    const vtt = join(audioDir, `${key}.vtt`);
    if (!existsSync(mp3) || !existsSync(vtt)) {
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
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
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
