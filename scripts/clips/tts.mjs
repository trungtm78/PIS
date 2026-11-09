import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { argument, flag, loadVoices, mapLimit, positionals, readJson, sha256 } from './common.mjs';
import { loadScenario, recordableScenes, speedOf } from './scenario.mjs';
import { speechText } from './text.mjs';

/**
 * The narration client for the clips: VieNeuTTS (primary) and NghiTTS (only when asked for). Keys are read from the environment variables named in
 * voices.json and nowhere else; a missing key is an error that names the variable, never a quiet switch to another service.
 * The scripts/hdsd/tts.mjs client (edge-tts, used by the guide) is untouched.
 */
export class TtsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.details = details;
  }
}

export const RETRY_WAITS_MS = [2000, 5000, 15000, 30000];

/** Where the audio of one text is kept: the key is the sha256 of the voice, the speed and the (respelled) text. */
export function cacheKey({ voiceId, speed, text }) {
  return sha256(voiceId, speed, text);
}

export function cachePaths(cacheDir, key) {
  return { wav: join(cacheDir, `${key}.wav`), meta: join(cacheDir, `${key}.json`) };
}

/** The engine, the voice and the identity the cache uses for it. */
export function resolveVoice(voices, { voiceId, engineName }) {
  const id = voiceId ?? voices.defaultVoice;
  if (engineName === 'nghi') {
    const modelId = id.startsWith('nghi:') ? id.slice(5) : voices.engines.nghi.defaultModelId;
    if (!voices.engines.nghi.models.includes(modelId)) throw new TtsError('UNKNOWN_VOICE', `NghiTTS has no model ${modelId} (known: ${voices.engines.nghi.models.join(', ')})`);
    return { engineName: 'nghi', engine: voices.engines.nghi, voiceId: `nghi:${modelId}`, modelId };
  }
  const voice = voices.voices.find((candidate) => candidate.id === id);
  if (voice === undefined) throw new TtsError('UNKNOWN_VOICE', `unknown voice ${id} (known: ${voices.voices.map((candidate) => candidate.id).join(', ')})`);
  return { engineName: 'vieneu', engine: voices.engines.vieneu, voiceId: voice.id, voice };
}

/** The key and the base URL of an engine from the environment; a missing key stops the run with a message that says what to set. */
export function engineAccess(engine, env) {
  const key = env[engine.apiKeyEnv];
  if (key === undefined || key.trim() === '') throw new TtsError('KEY_MISSING', `${engine.apiKeyEnv} is not set. Set it in your environment (never in a file or a command history) and run again. No other service is tried instead.`, { variable: engine.apiKeyEnv });
  const base = (env[engine.baseUrlEnv] ?? engine.defaultBaseUrl).replace(/\/+$/u, '');
  return { key: key.trim(), baseUrl: base };
}

/** The HTTP request of one synthesis. The key travels only in the header, and this object is never logged. */
export function buildRequest({ resolved, text, speed }, env) {
  const { key, baseUrl } = engineAccess(resolved.engine, env);
  const params = resolved.engine.request;
  const body =
    resolved.engineName === 'vieneu'
      ? { text, voice_data: { codes: resolved.voice.codes, text: resolved.voice.refText }, speed, ...params }
      : { text, model_id: resolved.modelId, length_scale: Math.round((1 / speed) * 1000) / 1000, ...params };
  return { url: `${baseUrl}${resolved.engine.endpoint}`, init: { method: 'POST', headers: { 'content-type': 'application/json', [resolved.engine.keyHeader]: key }, body: JSON.stringify(body) } };
}

/** The format and the length of a WAV file; anything else is refused (an error page saved as audio would be mixed into a film). */
export function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new TtsError('NOT_WAV', 'the answer is not a WAV file');
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels: buffer.readUInt16LE(offset + 10), sampleRate: buffer.readUInt32LE(offset + 12), bitsPerSample: buffer.readUInt16LE(offset + 22) };
    if (id === 'data') {
      if (format === null) throw new TtsError('NOT_WAV', 'the WAV file has no format chunk');
      const bytes = size === 0xffffffff || offset + 8 + size > buffer.length ? buffer.length - offset - 8 : size;
      const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
      if (bytes <= 0 || bytesPerSecond <= 0) throw new TtsError('EMPTY_AUDIO', 'the WAV file has no samples');
      return { ...format, durationMs: Math.round((bytes / bytesPerSecond) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new TtsError('NOT_WAV', 'the WAV file has no data chunk');
}

const RETRYABLE = (status) => status === 429 || status >= 500;

async function requestOnce(request, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new TtsError(response.status === 403 ? 'KEY_REJECTED' : 'HTTP', `${response.status} from ${new URL(request.url).host}${new URL(request.url).pathname}: ${detail}`, { status: response.status });
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw new TtsError('NETWORK', `no answer from ${new URL(request.url).host}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** One engine, with a few tries for the failures that pass (429, 5xx, no answer); a 4xx is final, so a wrong key is told at once. */
async function callEngine(args, { env, fetchImpl, retryWaitsMs, timeoutMs, log }) {
  const request = buildRequest(args, env);
  let last;
  for (let attempt = 0; attempt <= retryWaitsMs.length; attempt += 1) {
    try {
      const audio = await requestOnce(request, fetchImpl, timeoutMs);
      return { audio, wav: parseWav(audio) };
    } catch (error) {
      last = error;
      const retry = error instanceof TtsError && (error.code === 'NETWORK' || error.code === 'EMPTY_AUDIO' || error.code === 'NOT_WAV' || (error.code === 'HTTP' && RETRYABLE(error.details.status)));
      if (!retry || attempt === retryWaitsMs.length) break;
      log(`${args.resolved.engineName}: ${error.message}; trying again in ${retryWaitsMs[attempt] / 1000} s`);
      await delay(retryWaitsMs[attempt]);
    }
  }
  throw last;
}

/**
 * The voice of one text: from the cache when it is there, else from the engine. `fallback: 'nghi'` allows NghiTTS after the primary engine failed for a
 * reason other than a missing or rejected key; the fallback is logged and written in the metadata of the audio, so it is never silent.
 */
export async function synthesize({ text, voiceId, speed, engineName = 'vieneu', fallback, cacheDir, env = process.env, fetchImpl = globalThis.fetch, log = console.log, retryWaitsMs = RETRY_WAITS_MS, timeoutMs = 120_000, voices = loadVoices() }) {
  if (typeof text !== 'string' || text.trim() === '') throw new TtsError('EMPTY_TEXT', 'there is nothing to say');
  const resolved = resolveVoice(voices, { voiceId, engineName });
  const rate = speed ?? resolved.voice?.speed ?? 1;
  const key = cacheKey({ voiceId: resolved.voiceId, speed: rate, text });
  const paths = cachePaths(cacheDir, key);
  if (existsSync(paths.wav) && existsSync(paths.meta)) return { ...JSON.parse(readFileSync(paths.meta, 'utf8')), key, wav: paths.wav, cached: true };
  const attempt = (resolvedVoice, from) =>
    callEngine({ resolved: resolvedVoice, text, speed: rate }, { env, fetchImpl, retryWaitsMs, timeoutMs, log }).then((result) => ({ ...result, resolved: resolvedVoice, from }));
  let made;
  try {
    made = await attempt(resolved, undefined);
  } catch (error) {
    const allowed = fallback === 'nghi' && resolved.engineName === 'vieneu' && error instanceof TtsError && error.code !== 'KEY_MISSING' && error.code !== 'KEY_REJECTED';
    if (!allowed) throw error;
    log(`FALLBACK: VieNeuTTS failed (${error.message}); using NghiTTS for this text because --fallback nghi was given`);
    made = await attempt(resolveVoice(voices, { voiceId: undefined, engineName: 'nghi' }), { engine: 'vieneu', reason: error.message });
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(paths.wav, made.audio);
  const meta = { voiceId: made.resolved.voiceId, engine: made.resolved.engineName, speed: rate, sampleRate: made.wav.sampleRate, durationMs: made.wav.durationMs, textHash: sha256(text), fallbackFrom: made.from ?? null };
  writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, key, wav: paths.wav, cached: false };
}

/**
 * The voice of every scene of a cut. The text of each scene is the respelled narration with its figures from the data manifest. A scene whose text
 * is already in the cache costs nothing. The result is the audio index the subtitles, the recorder and the mixer read.
 */
export async function synthesizeScenes({ scenario, scenes, manifest, mode = 'manifest', voiceId, engineName = 'vieneu', fallback, cacheDir, env, fetchImpl, log = console.log, limit = 3, dryRun = false, retryWaitsMs, voices = loadVoices() }) {
  const resolved = resolveVoice(voices, { voiceId: voiceId ?? scenario.voice, engineName });
  const speed = resolved.voice?.speed ?? speedOf(scenario, voices);
  const jobs = scenes.map((scene) => {
    const text = speechText(scene.narration, { figures: scenario.figures, manifest, mode });
    return { scene, text, key: cacheKey({ voiceId: resolved.voiceId, speed, text }) };
  });
  const result = {};
  await mapLimit(jobs, limit, async (job) => {
    const paths = cachePaths(cacheDir, job.key);
    if (dryRun) {
      result[job.scene.id] = { key: job.key, cached: existsSync(paths.wav), text: job.text };
      return;
    }
    const made = await synthesize({ text: job.text, voiceId: resolved.voiceId, speed, engineName, fallback, cacheDir, env, fetchImpl, log, retryWaitsMs, voices });
    result[job.scene.id] = { key: made.key, wav: made.wav, voiceMs: made.durationMs, engine: made.engine, cached: made.cached };
    log(`voice: ${job.scene.id} ${made.cached ? '(cache)' : `(${made.engine})`}`);
  });
  return { clip: scenario.clip, voiceId: resolved.voiceId, speed, scenes: result };
}

async function main(argv) {
  const [clip, cut = 'main'] = positionals(argv, ['manifest', 'voice', 'engine', 'fallback', 'cache', 'out', 'limit']);
  if (clip === undefined) {
    console.error('usage: node scripts/clips/tts.mjs <clip> [main|chapter-id] [--manifest data-manifest.json | --sample] [--voice id] [--engine vieneu|nghi] [--fallback nghi] [--cache dir] [--out audio.json] [--limit n] [--dry-run]');
    return 2;
  }
  const scenario = loadScenario(clip);
  const sample = flag(argv, 'sample');
  const manifestPath = argument(argv, 'manifest');
  if (!sample && manifestPath === undefined) {
    console.error('figures come from the data manifest: give --manifest <file> (or --sample for a trial with nominal values, never for a release)');
    return 2;
  }
  const dryRun = flag(argv, 'dry-run');
  try {
    const index = await synthesizeScenes({
      scenario,
      scenes: recordableScenes(scenario, cut, { includePending: flag(argv, 'include-pending') }),
      manifest: manifestPath === undefined ? undefined : readJson(manifestPath),
      mode: sample ? 'sample' : 'manifest',
      voiceId: argument(argv, 'voice'),
      engineName: argument(argv, 'engine', 'vieneu'),
      fallback: argument(argv, 'fallback'),
      cacheDir: argument(argv, 'cache', process.env.CLIPS_CACHE ?? 'D:/tmp/clips-cache/audio'),
      env: process.env,
      limit: Number(argument(argv, 'limit', '3')),
      dryRun,
    });
    const out = argument(argv, 'out');
    if (out !== undefined && !dryRun) writeFileSync(out, `${JSON.stringify({ ...index, sample }, null, 2)}\n`);
    if (dryRun) for (const [id, entry] of Object.entries(index.scenes)) console.log(`${id}: ${entry.cached ? 'cached' : 'would be asked for'}\n  ${entry.text}`);
    return 0;
  } catch (error) {
    console.error(error instanceof TtsError ? `tts: ${error.message}` : error);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
