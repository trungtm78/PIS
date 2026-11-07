import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheDir, formatVtt, hashOf, mmss, parseCues, parseFfmpegDuration, shiftCues, validateFlow } from './lib.mjs';

const flow = (extra = {}) => ({ id: 'f', title: 'T', audience: 'A', outcome: 'O', steps: [{ id: 's1', screens: ['HOME-01'], heading: 'H', text: 'Lời.' }], ...extra });

test('a flow needs its identity, its words and unique steps', () => {
  assert.doesNotThrow(() => validateFlow(flow(), 'f'));
  assert.throws(() => validateFlow(flow(), 'g'), /the id is f/);
  assert.throws(() => validateFlow(flow({ title: ' ' }), 'f'), /title is missing/);
  assert.throws(() => validateFlow(flow({ steps: [] }), 'f'), /no steps/);
  const twice = flow({ steps: [flow().steps[0], flow().steps[0]] });
  assert.throws(() => validateFlow(twice, 'f'), /twice/);
  assert.throws(() => validateFlow(flow({ steps: [{ id: 's', screens: 'x', heading: 'H', text: '' }] }), 'f'), /text is missing.*screens is not a list/);
});

test('the same words with the same voice share one key, other words or another voice do not', () => {
  assert.equal(hashOf('a'), hashOf('a'));
  assert.notEqual(hashOf('a'), hashOf('b'));
  assert.notEqual(hashOf('a', 'x'), hashOf('a', 'y'));
  assert.equal(hashOf('a').length, 24);
});

test('the duration is read from what ffmpeg prints', () => {
  assert.equal(parseFfmpegDuration('  Duration: 00:00:09.17, start: 0.000000, bitrate: 48 kb/s'), 9170);
  assert.equal(parseFfmpegDuration('Duration: 01:02:03.5, x'), 3_723_500);
  assert.throws(() => parseFfmpegDuration('nothing'), /did not print/);
});

test('the cues of a subtitle file are read, shifted and written again as WebVTT', () => {
  const srt = '1\n00:00:00,100 --> 00:00:05,112\nChào mừng.\n\n2\n00:00:05,062 --> 00:00:09,100\nClip này.\n';
  const cues = parseCues(srt);
  assert.deepEqual(cues, [
    { from: 100, to: 5112, text: 'Chào mừng.' },
    { from: 5062, to: 9100, text: 'Clip này.' },
  ]);
  const vtt = formatVtt(shiftCues(cues, 61_000));
  assert.match(vtt, /^WEBVTT\n\n1\n00:01:01\.100 --> 00:01:06\.112\nChào mừng\./);
  assert.deepEqual(parseCues(vtt).map((cue) => cue.from), [61_100, 66_062]);
  assert.deepEqual(parseCues(''), []);
  assert.throws(() => parseCues('1\nx --> y\ntext'), /not a time stamp/);
});

test('a time on screen is minutes and seconds, and the cache is on drive D unless told otherwise', () => {
  assert.equal(mmss(0), '00:00');
  assert.equal(mmss(125_900), '02:05');
  assert.equal(cacheDir({}), 'D:/tmp/hdsd-cache');
  assert.equal(cacheDir({ HDSD_CACHE: 'E:/x' }), 'E:/x');
});
