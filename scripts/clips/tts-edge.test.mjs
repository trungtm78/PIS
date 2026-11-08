import assert from 'node:assert/strict';
import test from 'node:test';
import { edgeArgs, edgeKey, joinGraph, settingsOf, voiceSettings } from './tts-edge.mjs';

const file = { default: 'a', voices: { a: { rate: '-3%', pitch: '+0Hz' }, b: { rate: '-4%', pitch: '-2Hz' } }, sentencePauseMs: 300, sceneLufs: -18 };

test('each voice has its own rate and pitch, and the environment wins over the file', () => {
  assert.deepEqual(settingsOf('b', {}, file), { voice: 'b', rate: '-4%', pitch: '-2Hz', pauseMs: 300, sceneLufs: -18 });
  assert.equal(settingsOf('a', { CLIPS_EDGE_RATE: '+5%' }, file).rate, '+5%');
  assert.equal(settingsOf('unknown', {}, file).rate, '+0%');
  const real = voiceSettings();
  assert.equal(real.default, 'vi-VN-HoaiMyNeural');
  assert.ok(real.voices['vi-VN-NamMinhNeural'] && real.comparison.decision.includes('HoaiMy'));
});

test('a negative rate is joined to its flag so that the parser does not take it for a flag; the cache key follows every setting', () => {
  const args = edgeArgs('Xin chào', 'x.mp3', { voice: 'v', rate: '-3%', pitch: '-2Hz' });
  assert.ok(args.includes('--rate=-3%') && args.includes('--pitch=-2Hz'));
  assert.deepEqual(args.slice(-4), ['--text', 'Xin chào', '--write-media', 'x.mp3']);
  const base = edgeKey('a', 'v', { rate: '+0%', pitch: '+0Hz' });
  assert.notEqual(base, edgeKey('a', 'v', { rate: '-3%', pitch: '+0Hz' }));
  assert.notEqual(base, edgeKey('a', 'v', { rate: '+0%', pitch: '-2Hz' }));
  assert.notEqual(base, edgeKey('a', 'w', { rate: '+0%', pitch: '+0Hz' }));
});

test('sentences are joined with a pause after each but the last, and the scene is brought to one loudness', () => {
  const graph = joinGraph(3, { pauseMs: 320, sceneLufs: -18 });
  assert.match(graph, /\[0:a\]apad=pad_dur=0\.320\[p0\]/u);
  assert.match(graph, /\[1:a\]apad=pad_dur=0\.320\[p1\]/u);
  assert.match(graph, /\[2:a\]anull\[p2\]/u);
  assert.match(graph, /concat=n=3:v=0:a=1,loudnorm=I=-18/u);
  assert.match(joinGraph(1, { pauseMs: 320, sceneLufs: -18 }), /^\[0:a\]anull\[p0\];\[p0\]concat=n=1/u);
});
