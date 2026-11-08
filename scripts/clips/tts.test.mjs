import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadVoices } from './common.mjs';
import { loadScenario, selectScenes } from './scenario.mjs';
import { buildRequest, cacheKey, engineAccess, parseWav, resolveVoice, synthesize, synthesizeScenes, TtsError } from './tts.mjs';

const voices = loadVoices();
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'clips-tts-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const PROBE = 'unit-test-probe-0123456789';
const ENV = { VIENEU_TTS_API_KEY: PROBE, NGHI_TTS_API_KEY: `${PROBE}-nghi` };

/** A mono 16-bit PCM WAV of the given length. */
function wav(ms, sampleRate = 24_000) {
  const samples = Math.round((sampleRate * ms) / 1000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

/** A fake of fetch that answers from a queue and remembers each call. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    const body = answer.body ?? Buffer.alloc(0);
    return { ok: answer.status === undefined || answer.status < 400, status: answer.status ?? 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), text: async () => body.toString('utf8') };
  };
  fn.calls = calls;
  return fn;
}

const silent = () => undefined;
const noWait = [0, 0];

test('the cache key is the sha256 of the voice, the speed and the text, and changes with each of them', () => {
  const key = cacheKey({ voiceId: 'v', speed: 1.1, text: 'xin chào' });
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(key, cacheKey({ voiceId: 'v', speed: 1.1, text: 'xin chào' }));
  assert.notEqual(key, cacheKey({ voiceId: 'w', speed: 1.1, text: 'xin chào' }));
  assert.notEqual(key, cacheKey({ voiceId: 'v', speed: 1.2, text: 'xin chào' }));
  assert.notEqual(key, cacheKey({ voiceId: 'v', speed: 1.1, text: 'xin chao' }));
});

test('the voice table is the appendix: seven voices with the recommended speeds and the chosen default', () => {
  assert.equal(voices.voices.length, 7);
  const speeds = Object.fromEntries(voices.voices.map((voice) => [voice.id, voice.speed]));
  assert.deepEqual(speeds, { 'vieneu-west-female': 1.1, 'vieneu-south-female': 1.2, 'vieneu-north-female': 1.1, 'vieneu-central-female': 1.2, 'vieneu-south-male': 1.2, 'vieneu-north-male': 1.3, 'vieneu-central-male': 1.2 });
  for (const voice of voices.voices) {
    assert.equal(voice.codes.length, voice.codeCount);
    assert.ok(voice.codes.every((code) => Number.isInteger(code) && code >= 0));
    assert.ok(voice.refText.length > 5);
  }
  assert.equal(voices.defaultVoice, 'vieneu-north-female');
  assert.ok(voices.defaultReason.length > 100);
  assert.equal(voices.engines.vieneu.request.temperature, 0.6);
  assert.equal(voices.engines.vieneu.request.stream, false);
});

test('a missing key stops the run with the name of the variable and never reaches the network', async () => {
  const fetchImpl = fakeFetch({ body: wav(500) });
  await assert.rejects(
    () => synthesize({ text: 'Xin chào', cacheDir: tempDir(), env: {}, fetchImpl, log: silent }),
    (error) => error instanceof TtsError && error.code === 'KEY_MISSING' && /VIENEU_TTS_API_KEY is not set/u.test(error.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
  await assert.rejects(() => synthesize({ text: 'Xin chào', cacheDir: tempDir(), env: { VIENEU_TTS_API_KEY: '   ' }, fetchImpl, log: silent }), /VIENEU_TTS_API_KEY is not set/u);
});

test('a missing primary key is not repaired by the fallback: there is no silent switch of service', async () => {
  const fetchImpl = fakeFetch({ body: wav(500) });
  await assert.rejects(() => synthesize({ text: 'Xin chào', fallback: 'nghi', cacheDir: tempDir(), env: { NGHI_TTS_API_KEY: PROBE }, fetchImpl, log: silent }), /VIENEU_TTS_API_KEY is not set/u);
  assert.equal(fetchImpl.calls.length, 0);
});

test('base URLs come from the environment with the documented defaults', () => {
  assert.equal(engineAccess(voices.engines.vieneu, ENV).baseUrl, 'https://cloud-api.tts.vieneu.cybertech.com.vn');
  assert.equal(engineAccess(voices.engines.nghi, ENV).baseUrl, 'https://cloud-api.tts.nghitts.cybertech.com.vn');
  assert.equal(engineAccess(voices.engines.vieneu, { ...ENV, VIENEU_TTS_BASE_URL: 'http://localhost:9000/' }).baseUrl, 'http://localhost:9000');
});

test('the VieNeuTTS request follows the documented contract: voice data, speed, temperature 0.6, no stream, the key in the header', () => {
  const resolved = resolveVoice(voices, { voiceId: undefined, engineName: 'vieneu' });
  const { url, init } = buildRequest({ resolved, text: 'Xin chào', speed: 1.1 }, ENV);
  assert.equal(url, 'https://cloud-api.tts.vieneu.cybertech.com.vn/v1/tts/generate');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-API-Key'], PROBE);
  assert.equal(init.headers['content-type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.equal(body.text, 'Xin chào');
  assert.equal(body.speed, 1.1);
  assert.equal(body.temperature, 0.6);
  assert.equal(body.stream, false);
  assert.equal(body.expected_sample_rate, 24_000);
  assert.deepEqual(body.voice_data.codes, voices.voices.find((voice) => voice.id === 'vieneu-north-female').codes);
  assert.ok(body.voice_data.text.startsWith('Tết là dịp'));
  assert.ok(!init.body.includes(PROBE), 'the key is not in the body');
});

test('the NghiTTS request uses the model, the length scale from the speed and no stream', () => {
  const resolved = resolveVoice(voices, { voiceId: 'nghi:thanhphuong2', engineName: 'nghi' });
  const { url, init } = buildRequest({ resolved, text: 'Xin chào', speed: 1.25 }, ENV);
  assert.equal(url, 'https://cloud-api.tts.nghitts.cybertech.com.vn/api/v1/synthesize');
  assert.equal(init.headers['X-API-Key'], `${PROBE}-nghi`);
  const body = JSON.parse(init.body);
  assert.equal(body.model_id, 'thanhphuong2');
  assert.equal(body.length_scale, 0.8);
  assert.equal(body.stream, false);
  assert.equal(body.normalize_text, true);
  assert.throws(() => resolveVoice(voices, { voiceId: 'nghi:nobody', engineName: 'nghi' }), /no model nobody/u);
  assert.throws(() => resolveVoice(voices, { voiceId: 'nobody', engineName: 'vieneu' }), /unknown voice nobody/u);
});

test('a WAV file is measured and anything else is refused', () => {
  assert.deepEqual(parseWav(wav(1500)), { channels: 1, sampleRate: 24_000, bitsPerSample: 16, durationMs: 1500 });
  assert.throws(() => parseWav(Buffer.from('<html>error</html>'.padEnd(60, ' '))), (error) => error.code === 'NOT_WAV');
  assert.throws(() => parseWav(wav(0)), (error) => error.code === 'EMPTY_AUDIO');
});

test('a text is asked for once: the second time it comes from the cache and the key never reaches the cache or the log', async () => {
  const cacheDir = tempDir();
  const fetchImpl = fakeFetch({ body: wav(2000) });
  const lines = [];
  const first = await synthesize({ text: 'Xin chào các bạn', cacheDir, env: ENV, fetchImpl, log: (line) => lines.push(line) });
  assert.equal(first.cached, false);
  assert.equal(first.durationMs, 2000);
  assert.equal(first.engine, 'vieneu');
  assert.equal(first.fallbackFrom, null);
  assert.ok(existsSync(first.wav));
  const second = await synthesize({ text: 'Xin chào các bạn', cacheDir, env: ENV, fetchImpl, log: (line) => lines.push(line) });
  assert.equal(second.cached, true);
  assert.equal(second.durationMs, 2000);
  assert.equal(fetchImpl.calls.length, 1);
  for (const name of readdirSync(cacheDir)) assert.ok(!readFileSync(join(cacheDir, name)).includes(PROBE), name);
  assert.ok(!lines.join('\n').includes(PROBE));
  await synthesize({ text: 'Một câu khác', cacheDir, env: ENV, fetchImpl, log: silent });
  assert.equal(fetchImpl.calls.length, 2);
});

test('a rejected key is final: no retry, no fallback, and the message does not carry the key', async () => {
  const fetchImpl = fakeFetch({ status: 403, body: Buffer.from('Invalid or missing API Key') });
  await assert.rejects(
    () => synthesize({ text: 'Xin chào', fallback: 'nghi', cacheDir: tempDir(), env: ENV, fetchImpl, log: silent, retryWaitsMs: noWait }),
    (error) => error.code === 'KEY_REJECTED' && !error.message.includes(PROBE),
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('a failure that passes is tried again; a failure that stays is reported', async () => {
  const flaky = fakeFetch({ status: 500, body: Buffer.from('Data trả ra bị rỗng.') }, { body: wav(1000) });
  const made = await synthesize({ text: 'Xin chào', cacheDir: tempDir(), env: ENV, fetchImpl: flaky, log: silent, retryWaitsMs: noWait });
  assert.equal(made.durationMs, 1000);
  assert.equal(flaky.calls.length, 2);
  const down = fakeFetch({ status: 502, body: Buffer.from('bad gateway') });
  await assert.rejects(() => synthesize({ text: 'Xin chào', cacheDir: tempDir(), env: ENV, fetchImpl: down, log: silent, retryWaitsMs: noWait }), /502/u);
  assert.equal(down.calls.length, 3);
  const offline = fakeFetch(new Error('connect refused'));
  await assert.rejects(() => synthesize({ text: 'Xin chào', cacheDir: tempDir(), env: ENV, fetchImpl: offline, log: silent, retryWaitsMs: [0] }), /no answer from/u);
  const html = fakeFetch({ body: Buffer.from('<html>maintenance</html>'.padEnd(80, ' ')) });
  await assert.rejects(() => synthesize({ text: 'Xin chào', cacheDir: tempDir(), env: ENV, fetchImpl: html, log: silent, retryWaitsMs: [] }), /not a WAV/u);
});

test('NghiTTS is used after a VieNeuTTS failure only when the fallback was asked for, and it is logged and written in the metadata', async () => {
  const route = async (url) => (url.includes('vieneu') ? { status: 500, body: Buffer.from('boom') } : { body: wav(1200) });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const answer = await route(url);
    return { ok: !answer.status, status: answer.status ?? 200, arrayBuffer: async () => answer.body.buffer.slice(answer.body.byteOffset, answer.body.byteOffset + answer.body.byteLength), text: async () => answer.body.toString() };
  };
  await assert.rejects(() => synthesize({ text: 'Xin chào', cacheDir: tempDir(), env: ENV, fetchImpl, log: silent, retryWaitsMs: [] }), /500/u);
  assert.ok(calls.every((url) => url.includes('vieneu')), 'without the fallback flag only VieNeuTTS is called');
  calls.length = 0;
  const lines = [];
  const made = await synthesize({ text: 'Xin chào', fallback: 'nghi', cacheDir: tempDir(), env: ENV, fetchImpl, log: (line) => lines.push(line), retryWaitsMs: [] });
  assert.equal(made.engine, 'nghi');
  assert.equal(made.fallbackFrom.engine, 'vieneu');
  assert.ok(lines.some((line) => line.startsWith('FALLBACK:')));
  assert.ok(calls.some((url) => url.includes('nghitts')));
  assert.ok(!lines.join('\n').includes(PROBE));
  await assert.rejects(() => synthesize({ text: 'Xin chào', fallback: 'nghi', cacheDir: tempDir(), env: { VIENEU_TTS_API_KEY: PROBE }, fetchImpl, log: silent, retryWaitsMs: [] }), /NGHI_TTS_API_KEY is not set/u);
});

test('an empty text is refused before any call', async () => {
  const fetchImpl = fakeFetch({ body: wav(500) });
  await assert.rejects(() => synthesize({ text: '  ', cacheDir: tempDir(), env: ENV, fetchImpl, log: silent }), (error) => error.code === 'EMPTY_TEXT');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a dry run lists what would be asked for with the respelled text and needs no key and no network', async () => {
  const scenario = loadScenario('public-investment');
  const scenes = selectScenes(scenario, 'analytics').slice(0, 3);
  const fetchImpl = fakeFetch({ body: wav(500) });
  const index = await synthesizeScenes({ scenario, scenes, mode: 'sample', cacheDir: tempDir(), env: {}, fetchImpl, dryRun: true, log: silent });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(index.voiceId, 'vieneu-north-female');
  assert.equal(index.speed, 1.1);
  assert.deepEqual(Object.keys(index.scenes), scenes.map((scene) => scene.id));
  for (const entry of Object.values(index.scenes)) {
    assert.equal(entry.cached, false);
    assert.doesNotMatch(entry.text, /\d/u, 'numbers are spelled for the voice');
  }
  assert.match(index.scenes['ana-hub'].text, /mười chín báo cáo/u);
  assert.match(index.scenes['ana-hub'].text, /ếch-xeo/u);
});

test('the scenes of a cut are made together, keep the order, and report measured durations', async () => {
  const scenario = loadScenario('public-investment');
  const scenes = selectScenes(scenario, 'analytics').slice(0, 4);
  const cacheDir = tempDir();
  let length = 1000;
  const fetchImpl = async () => {
    length += 500;
    const body = wav(length);
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), text: async () => '' };
  };
  const index = await synthesizeScenes({ scenario, scenes, mode: 'sample', cacheDir, env: ENV, fetchImpl, limit: 2, log: silent });
  assert.deepEqual(Object.keys(index.scenes), scenes.map((scene) => scene.id));
  for (const entry of Object.values(index.scenes)) {
    assert.ok(entry.voiceMs >= 1500);
    assert.ok(existsSync(entry.wav));
    assert.equal(entry.engine, 'vieneu');
  }
  const again = await synthesizeScenes({ scenario, scenes, mode: 'sample', cacheDir, env: {}, fetchImpl: async () => assert.fail('the cache answers'), log: silent });
  assert.ok(Object.values(again.scenes).every((entry) => entry.cached));
});

test('nothing in scripts/clips holds a key or a token', () => {
  const dir = join(import.meta.dirname);
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else if (/\.(mjs|json|md)$/u.test(entry.name)) files.push(join(current, entry.name));
    }
  };
  walk(dir);
  for (const file of files.filter((name) => !name.endsWith('tts.test.mjs'))) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /nghitts_sk_|vieneu_sk_|\b(sk|pk)_(live|test)_[A-Za-z0-9]{8,}/u, file);
    assert.doesNotMatch(text, /X-API-Key['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}['"]/u, file);
    assert.doesNotMatch(text, /(api[_-]?key|token|secret)['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/iu, file);
  }
});
