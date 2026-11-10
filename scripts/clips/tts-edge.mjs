import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { argument, flag, mapLimit, positionals, readJson, sha256 } from './common.mjs';
import { loadScenario, recordableScenes } from './scenario.mjs';
import { sentencesOf, speechText } from './text.mjs';
import { parseWav } from './tts.mjs';

/**
 * The free fallback voice of the clips (the same engine the guide recorder uses: edge-tts, a vi-VN neural voice). It writes the same audio index as
 * tts.mjs (`{ clip, voiceId, speed, scenes: { <id>: { key, wav, voiceMs, engine } } }`), so subtitles, recorder and mixer read it unchanged.
 * It is used only while the keys of VieNeuTTS and NghiTTS are not set; the engine name is written in the index, so the film is never mistaken for the final voice.
 * To sound less like a machine: each voice has its own rate and pitch (edge-voices.json), every sentence is spoken on its own and joined with a pause, and each scene
 * is brought to the same loudness. The respelled text of the clips (phonetics, numbers as words) is what is spoken; no key is needed or read.
 */
export const voiceSettings = () => readJson('edge-voices.json');
export const EDGE_VOICE = process.env.CLIPS_EDGE_VOICE ?? voiceSettings().default;
const PYTHON = process.env.HDSD_PYTHON ?? 'D:/Python312/python.exe';
const FFMPEG = process.env.HDSD_FFMPEG ?? 'D:/Python312/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';
const RETRY_WAITS_MS = [3000, 8000, 20000, 45000];
const CACHE_VERSION = 'edge2';

/** Rate and pitch of a voice: the file, then the environment (`CLIPS_EDGE_RATE`, `CLIPS_EDGE_PITCH`) over it. */
export function settingsOf(voice = EDGE_VOICE, env = process.env, file = voiceSettings()) {
  const own = file.voices[voice] ?? {};
  return { voice, rate: env.CLIPS_EDGE_RATE ?? own.rate ?? '+0%', pitch: env.CLIPS_EDGE_PITCH ?? own.pitch ?? '+0Hz', pauseMs: file.sentencePauseMs ?? 0, sceneLufs: file.sceneLufs ?? -18 };
}

export const edgeKey = (text, voice = EDGE_VOICE, settings = { rate: '+0%', pitch: '+0Hz' }) => sha256(CACHE_VERSION, voice, settings.rate, settings.pitch, text);

/** The arguments of the edge-tts command (a value that starts with a minus is joined to its flag with `=`, or the parser takes it for a flag). */
export function edgeArgs(text, mp3, settings) {
  return ['-m', 'edge_tts', '--voice', settings.voice, `--rate=${settings.rate}`, `--pitch=${settings.pitch}`, '--text', text, '--write-media', mp3];
}

function speakOnce(text, mp3, settings) {
  return new Promise((done) => {
    const child = spawn(PYTHON, edgeArgs(text, mp3, settings), { env: { ...process.env, PYTHONUTF8: '1' } });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => done({ ok: code === 0 && existsSync(mp3) && statSync(mp3).size > 0, stderr }));
  });
}

/** One text (a sentence) to a WAV file (48 kHz mono) in the cache; tries again while the service sends nothing. */
export async function speakSentence(text, cacheDir, settings, log = console.log) {
  const key = edgeKey(text, settings.voice, settings);
  const wav = join(cacheDir, `${key}.wav`);
  const mp3 = join(cacheDir, `${key}.mp3`);
  if (existsSync(wav) && statSync(wav).size > 1000) return { key, wav, cached: true };
  mkdirSync(cacheDir, { recursive: true });
  let failure = '';
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt += 1) {
    rmSync(mp3, { force: true });
    // The service answers some exact texts with no audio however often they are asked again; a leading space makes it a different request (found at the public round).
    const result = await speakOnce(attempt % 2 === 1 ? ` ${text}` : text, mp3, settings);
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

/** The ffmpeg graph that joins sentences with a pause after each (not after the last) and brings the whole to one loudness. */
export function joinGraph(count, { pauseMs, sceneLufs }) {
  const pad = (pauseMs / 1000).toFixed(3);
  const parts = Array.from({ length: count }, (_, index) => (index < count - 1 && pauseMs > 0 ? `[${index}:a]apad=pad_dur=${pad}[p${index}]` : `[${index}:a]anull[p${index}]`));
  const inputs = Array.from({ length: count }, (_, index) => `[p${index}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${count}:v=0:a=1,loudnorm=I=${sceneLufs}:TP=-2:LRA=7,aresample=48000[out]`;
}

/** A scene text to one WAV: sentences spoken one by one, joined with pauses, one loudness. The result is cached under the key of the whole text. */
export async function speakEdge(text, cacheDir, log = console.log, settings = settingsOf()) {
  const sentences = sentencesOf(text);
  const key = edgeKey(text, settings.voice, { ...settings, rate: `${settings.rate}|${settings.pauseMs}|${settings.sceneLufs}` });
  const wav = join(cacheDir, `${key}.wav`);
  if (existsSync(wav) && statSync(wav).size > 1000) return { key, wav, cached: true };
  const parts = [];
  for (const sentence of sentences.length > 0 ? sentences : [text]) parts.push(await speakSentence(sentence, cacheDir, settings, log));
  const args = ['-y', '-hide_banner', '-loglevel', 'error', ...parts.flatMap((part) => ['-i', part.wav]), '-filter_complex', joinGraph(parts.length, settings), '-map', '[out]', '-ac', '1', '-c:a', 'pcm_s16le', wav];
  const joined = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (joined.status !== 0) throw new Error(`joining the sentences failed: ${(joined.stderr ?? '').split('\n').slice(-3).join(' ')}`);
  return { key, wav, cached: parts.every((part) => part.cached) };
}

export async function synthesizeEdge({ scenario, scenes, manifest, mode = 'manifest', cacheDir, limit = 3, log = console.log, settings = settingsOf() }) {
  const result = {};
  await mapLimit(scenes, limit, async (scene) => {
    const text = speechText(scene.narration, { figures: scenario.figures, manifest, mode });
    const made = await speakEdge(text, cacheDir, log, settings);
    result[scene.id] = { key: made.key, wav: made.wav, voiceMs: parseWav(readFileSync(made.wav)).durationMs, engine: 'edge-tts', text };
    log(`voice: ${scene.id} ${made.cached ? '(cache)' : '(edge-tts)'}`);
  });
  const ordered = Object.fromEntries(scenes.map((scene) => [scene.id, result[scene.id]]));
  return { clip: scenario.clip, voiceId: `edge:${settings.voice}`, speed: 1, rate: settings.rate, pitch: settings.pitch, fallbackVoice: true, scenes: ordered };
}

async function main(argv) {
  const [clip, cut = 'main'] = positionals(argv, ['manifest', 'cache', 'out', 'limit', 'voice', 'rate', 'pitch']);
  const manifestPath = argument(argv, 'manifest');
  if (clip === undefined || (manifestPath === undefined && !flag(argv, 'sample'))) {
    console.error('usage: node scripts/clips/tts-edge.mjs <clip> [main|chapter-id] --manifest data-manifest.json --out <clip>.audio.json [--cache dir] [--limit n] [--voice vi-VN-NamMinhNeural] [--rate -3%] [--pitch +0Hz]');
    return 2;
  }
  const voice = argument(argv, 'voice', EDGE_VOICE);
  const base = settingsOf(voice);
  const settings = { ...base, rate: argument(argv, 'rate', base.rate), pitch: argument(argv, 'pitch', base.pitch) };
  const scenario = loadScenario(clip);
  const index = await synthesizeEdge({
    scenario,
    scenes: recordableScenes(scenario, cut, { includePending: flag(argv, 'include-pending') }),
    manifest: manifestPath === undefined ? undefined : readJson(manifestPath),
    mode: flag(argv, 'sample') ? 'sample' : 'manifest',
    cacheDir: argument(argv, 'cache', process.env.CLIPS_EDGE_CACHE ?? 'D:/tmp/clips-cache/audio-edge'),
    limit: Number(argument(argv, 'limit', '3')),
    settings,
  });
  const out = argument(argv, 'out');
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
  const total = Object.values(index.scenes).reduce((sum, entry) => sum + entry.voiceMs, 0);
  console.log(`${clip}/${cut}: ${Object.keys(index.scenes).length} voices, ${(total / 1000).toFixed(1)} s (fallback voice ${settings.voice}, rate ${settings.rate}, pitch ${settings.pitch})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
