import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSpec } from './common.mjs';
import { factsFromFfmpeg, factsFromFfprobe, findFfprobe, judge, loudnessFromEbur128 } from './verify.mjs';

const spec = loadSpec();

const FFMPEG_REPORT = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'final.mp4':
  Duration: 00:10:03.20, start: 0.000000, bitrate: 2210 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 2000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 172 kb/s (default)
  Stream #0:2[0x3](vie): Subtitle: mov_text (tx3g / 0x67337874), 0 kb/s (default)`;

const EBUR128 = `[Parsed_ebur128_0 @ 0000023a9b0c16c0] Summary:

  Integrated loudness:
    I:         -16.1 LUFS
    Threshold: -27.3 LUFS

  Loudness range:
    LRA:         4.8 LU

  True peak:
    Peak:      -14.6 dBFS`;

test('the facts of a file are read from the report of ffmpeg when there is no ffprobe', () => {
  assert.deepEqual(factsFromFfmpeg(FFMPEG_REPORT), { width: 1920, height: 1080, fps: 30, durationSec: 603.2, hasAudio: true, subtitleStreams: 1 });
  assert.deepEqual(factsFromFfmpeg('nothing'), { width: undefined, height: undefined, fps: undefined, durationSec: 0, hasAudio: false, subtitleStreams: 0 });
});

test('the facts of a file are read from the JSON of ffprobe, with a fractional frame rate', () => {
  const json = { format: { duration: '603.200000' }, streams: [{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001' }, { codec_type: 'audio' }, { codec_type: 'subtitle' }] };
  const facts = factsFromFfprobe(json);
  assert.equal(facts.width, 1920);
  assert.ok(Math.abs(facts.fps - 29.97) < 0.01);
  assert.equal(facts.durationSec, 603.2);
  assert.equal(facts.hasAudio, true);
  assert.equal(facts.subtitleStreams, 1);
});

test('the loudness is read from the summary of the ebur128 filter', () => {
  assert.deepEqual(loudnessFromEbur128(EBUR128), { integratedLufs: -16.1, truePeakDb: -14.6, rangeLu: 4.8 });
  assert.throws(() => loudnessFromEbur128('no summary'), /no integrated value/u);
});

test('ffprobe is looked for in the variable, beside ffmpeg and on the PATH, and its absence is not an error', () => {
  assert.equal(findFfprobe({ CLIPS_FFPROBE: 'X:/tools/ffprobe.exe' }, (path) => path === 'X:/tools/ffprobe.exe'), 'X:/tools/ffprobe.exe');
  const found = findFfprobe({}, () => false);
  assert.ok(found === undefined || found === 'ffprobe');
});

const good = {
  facts: { width: 1920, height: 1080, fps: 30, durationSec: 603, hasAudio: true, subtitleStreams: 1 },
  loudness: { integratedLufs: -16.1, truePeakDb: -3 },
  cues: [{ startMs: 1000, endMs: 4000, text: 'Xin chào' }, { startMs: 4100, endMs: 8000, text: 'Hệ thống quản lý đầu tư công' }],
  sidecars: { srt: 'x', vtt: 'y', record: { burnedInSubtitles: true } },
  kind: 'main',
};

test('a clip that is 1920x1080 at 30 fps, 8 to 12 minutes, with sound in range and subtitles passes', () => {
  assert.deepEqual(judge({ ...good, spec }), []);
});

test('every way a clip can be wrong is named', () => {
  const problems = judge({
    ...good,
    spec,
    facts: { width: 1280, height: 720, fps: 25, durationSec: 100, hasAudio: false, subtitleStreams: 0 },
    loudness: { integratedLufs: -23, truePeakDb: 0.5 },
    cues: [],
    sidecars: { srt: undefined, vtt: undefined, record: { burnedInSubtitles: false } },
  }).join(' | ');
  assert.match(problems, /size is 1280x720/u);
  assert.match(problems, /frame rate is 25/u);
  assert.match(problems, /duration is 1:40 .* expected 480-720 s for a main/u);
  assert.match(problems, /no audio stream/u);
  assert.match(problems, /loudness is -23 LUFS/u);
  assert.match(problems, /true peak is 0.5/u);
  assert.match(problems, /\.srt and \.vtt files are missing/u);
  assert.match(problems, /does not say the subtitles are burned in/u);
  assert.match(problems, /no cue/u);
});

test('a chapter cut has its own duration range and the loudness must have been measured', () => {
  assert.deepEqual(judge({ ...good, kind: 'chapter', facts: { ...good.facts, durationSec: 90 }, spec }), []);
  assert.match(judge({ ...good, kind: 'main', facts: { ...good.facts, durationSec: 90 }, spec }).join(' '), /expected 480-720 s for a main/u);
  assert.match(judge({ ...good, loudness: undefined, spec }).join(' '), /loudness was not measured/u);
});

test('subtitles that break the line rules or run past the end of the video fail the clip', () => {
  const long = [{ startMs: 0, endMs: 3000, text: 'x'.repeat(80) }];
  assert.match(judge({ ...good, cues: long, spec }).join(' '), /subtitles: cue 1: a line of 80 characters/u);
  const late = [{ startMs: 600_000, endMs: 700_000, text: 'Xin chào' }];
  assert.match(judge({ ...good, cues: late, spec }).join(' '), /run past the end of the video/u);
});
