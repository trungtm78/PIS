import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { argument, flag, mapLimit, positionals, readJson, sha256 } from './common.mjs';
import { loadScenario, selectScenes } from './scenario.mjs';
import { speechText } from './text.mjs';
import { parseWav } from './tts.mjs';

/**
 * The free fallback voice of the clips (the same engine the guide recorder uses: edge-tts, a vi-VN neural voice). It writes the same audio index as
 * tts.mjs (`{ clip, voiceId, speed, scenes: { <id>: { key, wav, voiceMs, engine } } }`), so subtitles, recorder and mixer read it unchanged.
 * It is used only while the keys of VieNeuTTS and NghiTTS are not set; the engine name is written in the index, so the film is never mistaken for the final voice.
 * The respelled text of the clips (phonetics, numbers as words) is what is spoken; no key is needed or read.
 */
export const EDGE_VOICE = process.env.CLIPS_EDGE_VOICE ?? 'vi-VN-HoaiMyNeural';
const PYTHON = process.env.HDSD_PYTHON ?? 'D:/Python312/python.exe';
const FFMPEG = process.env.HDSD_FFMPEG ?? 'D:/Python312/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';
const RETRY_WAITS_MS = [3000, 8000, 20000, 45000];

export const edgeKey = (text, voice = EDGE_VOICE) => sha256('edge', voice, text);

function speakOnce(text, mp3) {
  return new Promise((done) => {
    const child = spawn(PYTHON, ['-m', 'edge_tts', '--voice', EDGE_VOICE, '--text', text, '--write-media', mp3], { env: { ...process.env, PYTHONUTF8: '1' } });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => done({ ok: code === 0 && existsSync(mp3) && statSync(mp3).size > 0, stderr }));
  });
}

/** One text to a WAV file (48 kHz mono) in the cache; tries again while the service sends nothing. */
export async function speakEdge(text, cacheDir, log = console.log) {
  const key = edgeKey(text);
  const wav = join(cacheDir, `${key}.wav`);
  const mp3 = join(cacheDir, `${key}.mp3`);
  if (existsSync(wav) && statSync(wav).size > 1000) return { key, wav, cached: true };
  mkdirSync(cacheDir, { recursive: true });
  let failure = '';
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt += 1) {
    rmSync(mp3, { force: true });
    const result = await speakOnce(text, mp3);
    if (result.ok) {
      const converted = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp3, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { encoding: 'utf8' });
      if (converted.status === 0) return { key, wav, cached: false };
      failure = converted.stderr;
    } else {
      failure = result.stderr.split('\n').slice(-3).join(' ');
    }
    if (attempt < RETRY_WAITS_MS.length) {
      log(`edge-tts: no audio (${failure.slice(0, 120)}); trying again in ${RETRY_WAITS_MS[attempt] / 1000} s`);
      await delay(RETRY_WAITS_MS[attempt]);
    }
  }
  throw new Error(`the fallback voice failed for "${text.slice(0, 40)}": ${failure.slice(0, 200)}`);
}

export async function synthesizeEdge({ scenario, scenes, manifest, mode = 'manifest', cacheDir, limit = 3, log = console.log }) {
  const result = {};
  await mapLimit(scenes, limit, async (scene) => {
    const text = speechText(scene.narration, { figures: scenario.figures, manifest, mode });
    const made = await speakEdge(text, cacheDir, log);
    result[scene.id] = { key: made.key, wav: made.wav, voiceMs: parseWav(readFileSync(made.wav)).durationMs, engine: 'edge-tts', text };
    log(`voice: ${scene.id} ${made.cached ? '(cache)' : '(edge-tts)'}`);
  });
  const ordered = Object.fromEntries(scenes.map((scene) => [scene.id, result[scene.id]]));
  return { clip: scenario.clip, voiceId: `edge:${EDGE_VOICE}`, speed: 1, fallbackVoice: true, scenes: ordered };
}

async function main(argv) {
  const [clip, cut = 'main'] = positionals(argv, ['manifest', 'cache', 'out', 'limit']);
  const manifestPath = argument(argv, 'manifest');
  if (clip === undefined || (manifestPath === undefined && !flag(argv, 'sample'))) {
    console.error('usage: node scripts/clips/tts-edge.mjs <clip> [main|chapter-id] --manifest data-manifest.json --out <clip>.audio.json [--cache dir] [--limit n]');
    return 2;
  }
  const scenario = loadScenario(clip);
  const index = await synthesizeEdge({
    scenario,
    scenes: selectScenes(scenario, cut),
    manifest: manifestPath === undefined ? undefined : readJson(manifestPath),
    mode: flag(argv, 'sample') ? 'sample' : 'manifest',
    cacheDir: argument(argv, 'cache', process.env.CLIPS_EDGE_CACHE ?? 'D:/tmp/clips-cache/audio-edge'),
    limit: Number(argument(argv, 'limit', '3')),
  });
  const out = argument(argv, 'out');
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
  const total = Object.values(index.scenes).reduce((sum, entry) => sum + entry.voiceMs, 0);
  console.log(`${clip}/${cut}: ${Object.keys(index.scenes).length} voices, ${(total / 1000).toFixed(1)} s (fallback voice ${EDGE_VOICE})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
