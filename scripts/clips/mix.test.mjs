import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadSpec } from './common.mjs';
import { assColour, buildFilterGraph, buildMixArgs, filterPath, loudnormFilter, mix, parseLoudnorm, subtitleStyle } from './mix.mjs';

const spec = loadSpec();
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'clips-mix-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test('an ASS colour is blue-green-red order with the alpha first, 00 being opaque', () => {
  assert.equal(assColour('#FFFFFF'), '&H00FFFFFF');
  assert.equal(assColour('#1C3B48'), '&H00483B1C');
  assert.equal(assColour('#1C3B48', 0.5), '&H80483B1C');
  assert.equal(assColour('#000000', 0), '&HFF000000');
  assert.throws(() => assColour('white'), /not a #RRGGBB colour/u);
});

test('the subtitle style is Be Vietnam Pro, white, on a box of the dark workspace colour of the design tokens', () => {
  const style = subtitleStyle(spec);
  assert.match(style, /FontName=Be Vietnam Pro,/u);
  assert.match(style, /PrimaryColour=&H00FFFFFF/u);
  assert.match(style, /OutlineColour=&H38483B1C/u);
  assert.match(style, /BorderStyle=3/u);
  assert.match(style, /Alignment=2/u);
  assert.throws(() => subtitleStyle({ ...spec, subtitles: { ...spec.subtitles, backgroundToken: 'nope' } }), /design token nope not found/u);
});

test('a path inside a filter option uses forward slashes, an escaped drive colon and single quotes', () => {
  assert.equal(filterPath('D:\\tmp\\clips\\a.srt'), "'D\\:/tmp/clips/a.srt'");
  assert.equal(filterPath('/home/u/it\'s.srt'), "'/home/u/it'\\''s.srt'");
});

test('the loudness target is minus 16 LUFS with a true peak ceiling of minus 1.5, exact in the second pass', () => {
  assert.equal(loudnormFilter(spec), 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json');
  const measured = { input_i: '-22.09', input_tp: '-20.65', input_lra: '4.70', input_thresh: '-33.00', target_offset: '-0.40' };
  assert.equal(loudnormFilter(spec, measured), 'loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-22.09:measured_TP=-20.65:measured_LRA=4.70:measured_thresh=-33.00:offset=-0.40:linear=true');
});

test('the measurement is read from the end of an ffmpeg log, and a log without one is an error', () => {
  const log = 'size=N/A time=00:00:14.00\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-22.09",\n\t"input_tp" : "-20.65",\n\t"input_lra" : "4.70",\n\t"input_thresh" : "-33.00",\n\t"output_i" : "-15.60",\n\t"target_offset" : "-0.40"\n}\n';
  assert.equal(parseLoudnorm(log).input_i, '-22.09');
  assert.throws(() => parseLoudnorm('nothing here'), /printed no measurement/u);
  assert.throws(() => parseLoudnorm('{ "input_i": "-20" }'), /has no input_tp/u);
});

const narration = [
  { file: 'a.wav', startMs: 1000 },
  { file: 'b.wav', startMs: 6000 },
];

test('the graph delays each voice to its time, mixes them, ducks the music under the voice and normalises the loudness', () => {
  const graph = buildFilterGraph({ narration, totalMs: 14_000, music: 'm.mp3', spec, subtitlesFile: 'D:\\x\\clip.srt', fontsDir: 'D:\\repo\\fonts' });
  assert.match(graph, /\[1:a\]aformat=sample_rates=48000:channel_layouts=stereo,adelay=1000:all=1\[v0\]/u);
  assert.match(graph, /\[2:a\]aformat=sample_rates=48000:channel_layouts=stereo,adelay=6000:all=1\[v1\]/u);
  assert.match(graph, /\[v0\]\[v1\]amix=inputs=2:normalize=0:duration=longest\[voice\]/u);
  assert.match(graph, /\[3:a\]aformat=[^;]*atrim=duration=14\.000[^;]*volume=-20dB,afade=t=in:st=0:d=2,afade=t=out:st=10\.000:d=4\[music\]/u);
  assert.match(graph, /\[voice\]asplit=2\[vmix\]\[vside\]/u);
  assert.match(graph, /\[music\]\[vside\]sidechaincompress=threshold=0\.04:ratio=10:attack=15:release=450:makeup=1\[ducked\]/u);
  assert.match(graph, /\[vmix\]\[ducked\]amix=inputs=2:normalize=0:duration=longest\[premix\]/u);
  assert.match(graph, /\[premix\]loudnorm=I=-16:TP=-1\.5:LRA=11:print_format=json,aresample=48000\[aout\]/u);
  assert.match(graph, /\[0:v\]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2,subtitles=filename='D\\:\/x\/clip\.srt':fontsdir='D\\:\/repo\/fonts':force_style='FontName=Be Vietnam Pro,/u);
  assert.match(graph, /\[vout\]$/u);
});

test('without music the voice goes straight to the loudness step, and a single voice needs no mix', () => {
  const graph = buildFilterGraph({ narration: [narration[0]], totalMs: 5000, spec });
  assert.match(graph, /\[v0\]anull\[voice\]/u);
  assert.match(graph, /\[voice\]anull\[premix\]/u);
  assert.doesNotMatch(graph, /sidechaincompress|\[vout\]/u);
});

test('the video arguments are 1080p 30 fps H.264 with AAC at 48 kHz, a soft Vietnamese subtitle track, and the filter script in a file', () => {
  const args = buildMixArgs({ video: 'v.mp4', narration, music: 'm.mp3', subtitlesSrt: 's.srt', graphFile: 'g.graph', out: 'o.mp4', totalMs: 14_000, spec });
  const text = args.join(' ');
  assert.match(text, /-i v\.mp4 -i a\.wav -i b\.wav -stream_loop -1 -i m\.mp3 -i s\.srt -\/filter_complex g\.graph -t 14\.000/u);
  assert.match(text, /-map \[vout\] -map \[aout\] -map 4:0/u);
  assert.match(text, /-c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 30/u);
  assert.match(text, /-c:a aac -b:a 192k -ar 48000/u);
  assert.match(text, /-c:s mov_text -metadata:s:s:0 language=vie/u);
  assert.match(text, /-movflags \+faststart o\.mp4$/u);
  const noMusic = buildMixArgs({ video: 'v.mp4', narration, subtitlesSrt: 's.srt', graphFile: 'g.graph', out: 'o.mp4', totalMs: 14_000, spec }).join(' ');
  assert.match(noMusic, /-map 3:0/u);
  assert.doesNotMatch(noMusic, /stream_loop/u);
});

test('the first pass writes nothing: it only measures, with the log level that prints the measurement', () => {
  const args = buildMixArgs({ video: 'v.mp4', narration, music: 'm.mp3', graphFile: 'g.graph', out: 'o.mp4', totalMs: 14_000, spec, passOne: true });
  assert.equal(args[args.indexOf('-loglevel') + 1], 'info');
  assert.deepEqual(args.slice(-5), ['-map', '[aout]', '-vn', '-f', 'null'].concat('-').slice(-5));
  assert.ok(!args.includes('libx264'));
});

test('the mix writes the sidecar subtitles and a record, runs the two passes in order, and refuses a missing voice or music file', () => {
  const dir = tempDir();
  const wavA = join(dir, 'a.wav');
  writeFileSync(wavA, 'x');
  const timeline = { totalMs: 14_000, scenes: [{ id: 'a', voiceStartMs: 1000, subtitles: [{ startMs: 1000, endMs: 3000, text: 'Xin chào' }] }] };
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    return args.includes('-vn') ? { status: 0, stderr: '{\n"input_i":"-20.0","input_tp":"-3.0","input_lra":"5.0","input_thresh":"-30.0","target_offset":"0.1"\n}' } : { status: 0, stderr: '' };
  };
  const out = join(dir, 'out', 'final.mp4');
  const result = mix({ video: 'v.mp4', timeline, audio: { a: { wav: wavA } }, out, runner, log: () => undefined });
  assert.equal(result.measured.input_i, '-20.0');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('-vn') && !calls[1].includes('-vn'));
  assert.match(readFileSync(join(dir, 'out', 'final.srt'), 'utf8'), /Xin chào/u);
  assert.match(readFileSync(join(dir, 'out', 'final.vtt'), 'utf8'), /^WEBVTT/u);
  const record = JSON.parse(readFileSync(join(dir, 'out', 'final.clip.json'), 'utf8'));
  assert.equal(record.burnedInSubtitles, true);
  assert.deepEqual(record.sidecars, ['final.srt', 'final.vtt']);
  assert.match(readFileSync(join(dir, 'out', 'final.graph'), 'utf8'), /measured_I=-20\.0/u);
  assert.ok(existsSync(join(dir, 'out', 'final.pass1.graph')));
  assert.throws(() => mix({ video: 'v.mp4', timeline, audio: {}, out, runner, log: () => undefined }), /no audio file for scene a/u);
  assert.throws(() => mix({ video: 'v.mp4', timeline, audio: { a: { wav: wavA } }, music: join(dir, 'nope.mp3'), out, runner, log: () => undefined }), /music file not found/u);
  assert.throws(() => mix({ video: 'v.mp4', timeline, audio: { a: { wav: wavA } }, out, runner: () => ({ status: 1, stderr: 'boom' }), log: () => undefined }), /ffmpeg failed in the loudness pass/u);
});

test('the music is brought to a fixed loudness before ducking, and the default track is the proposed file of the clip when it exists', async () => {
  const { parseEbur128, musicGainFor, defaultMusic } = await import('./mix.mjs');
  const log = 'x\n  Summary:\n\n  Integrated loudness:\n    I:         -13.9 LUFS\n    Threshold: -24.0 LUFS\n';
  assert.equal(parseEbur128(log), -13.9);
  assert.equal(parseEbur128('nothing'), null);
  assert.equal(musicGainFor(-13.9, -22, -20), -8.1);
  assert.equal(musicGainFor(null, -22, -20), -20);
  assert.equal(musicGainFor(-80, -22, -20), 6, 'a silent file is not boosted without limit');
  const music = { clips: { c: { track: 't2' } }, tracks: [{ id: 't1', file: '/a.ogg', approval: { status: 'PROPOSED' } }, { id: 't2', file: '/b.ogg', approval: { status: 'PROPOSED' } }, { id: 't3' }] };
  assert.deepEqual(defaultMusic('c', music, () => true), { id: 't2', file: '/b.ogg', status: 'PROPOSED' });
  assert.equal(defaultMusic('c', music, () => false), undefined);
  assert.equal(defaultMusic('c', { clips: {}, tracks: [{ id: 't3' }] }, () => true), undefined);
  const graph = buildFilterGraph({ narration: [{ file: 'a.wav', startMs: 0 }], totalMs: 8000, music: 'm.ogg', musicGainDb: -8.1 });
  assert.match(graph, /volume=-8\.1dB/u);
  assert.match(graph, /sidechaincompress/u);
  assert.match(graph, /afade=t=out/u);
});
