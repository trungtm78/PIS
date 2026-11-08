import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSpec } from './common.mjs';
import { cutNames, estimateScene, loadScenario, listClips, selectScenes } from './scenario.mjs';
import { buildTimeline, checkCues, chunkSentence, cuesForScene, cuesOf, formatSrt, formatVtt, parseCues, timestamp, wrapLines } from './subtitles.mjs';

const rules = loadSpec().subtitles;

test('a short text is one line and a long one is two balanced lines of at most 42 characters', () => {
  assert.deepEqual(wrapLines('Hệ thống quản lý đầu tư công', 42, 2), ['Hệ thống quản lý đầu tư công']);
  const lines = wrapLines('Hệ thống quản lý đầu tư công theo dõi một khoản vốn từ kế hoạch', 42, 2);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(line.length <= 42);
  assert.ok(Math.abs(lines[0].length - lines[1].length) < 14);
  assert.equal(wrapLines('một '.repeat(30).trim(), 42, 1), null);
});

test('a sentence that does not fit in a cue is cut into balanced pieces, preferably after a comma', () => {
  const sentence = 'Người dùng vào bằng trình duyệt hoặc điện thoại, đăng nhập một lần, rồi mọi thao tác đi qua máy chủ nghiệp vụ.';
  const pieces = chunkSentence(sentence, rules);
  assert.ok(pieces.length >= 2);
  assert.equal(pieces.join(' '), sentence);
  for (const piece of pieces) assert.notEqual(wrapLines(piece, 42, 2), null);
  assert.ok(pieces[0].endsWith(','), pieces[0]);
});

test('the cues of a scene cover its voice, in order, without overlap, and follow the line rules', () => {
  const text = 'Người dùng vào bằng trình duyệt hoặc điện thoại, đăng nhập một lần. Mỗi thao tác đi qua máy chủ nghiệp vụ, ghi vào cơ sở dữ liệu phân quyền theo dòng, rồi phát sự kiện cho thông báo và phân tích. Kho bạc và mạng đấu thầu nối bằng tệp.';
  const cues = cuesForScene(text, 1000, 21_000, rules);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[cues.length - 1].endMs, 21_000);
  assert.deepEqual(checkCues(cues, rules), []);
  assert.equal(cues.map((cue) => cue.text.replace(/\n/gu, ' ')).join(' '), text);
});

test('the checker names every broken rule', () => {
  const problems = checkCues(
    [
      { startMs: 0, endMs: 9000, text: 'a '.repeat(30).trim() },
      { startMs: 8000, endMs: 8200, text: 'một\nhai\nba' },
      { startMs: 9000, endMs: 10_000, text: 'x'.repeat(60) },
    ],
    rules,
  );
  const joined = problems.join(' | ');
  assert.match(joined, /lasts 9000 ms \(max 6500\)/u);
  assert.match(joined, /3 lines/u);
  assert.match(joined, /starts before the previous cue ends/u);
  assert.match(joined, /a line of 60 characters/u);
  assert.match(joined, /characters per second/u);
});

test('SRT and VTT carry the same cues with a comma or a dot in the time, and they read back', () => {
  const cues = [
    { startMs: 1000, endMs: 3500, text: 'Dòng một\nDòng hai' },
    { startMs: 3600, endMs: 3_723_004, text: 'Đã quá một giờ' },
  ];
  const srt = formatSrt(cues);
  const vtt = formatVtt(cues);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:03,500\nDòng một\nDòng hai\n/u);
  assert.match(srt, /00:00:03,600 --> 01:02:03,004/u);
  assert.ok(vtt.startsWith('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500'));
  assert.deepEqual(parseCues(srt), cues);
  assert.deepEqual(parseCues(vtt), cues);
  assert.equal(timestamp(61_005, ','), '00:01:01,005');
});

test('the timeline places each scene after the one before, with the voice after the lead-in, and prefers the measured voice to the estimate', () => {
  const spec = loadSpec();
  const scenes = [
    { id: 'a', chapter: 'x', narration: 'Một hai ba.', captions: [{ text: 'Chú thích', atSec: 1, forSec: 2 }] },
    { id: 'b', chapter: 'x', narration: 'Bốn năm sáu.' },
  ];
  const timeline = buildTimeline(scenes, { a: { voiceMs: 9000 } }, { estimate: () => 2000 });
  const [a, b] = timeline.scenes;
  assert.equal(a.startMs, 0);
  assert.equal(a.voiceStartMs, spec.narration.leadInMs);
  assert.equal(a.voiceEndMs, spec.narration.leadInMs + 9000);
  assert.equal(a.measured, true);
  assert.equal(a.endMs, 9000 + spec.narration.leadInMs + spec.narration.tailMs);
  assert.equal(b.startMs, a.endMs);
  assert.equal(b.measured, false);
  assert.equal(b.endMs - b.startMs, spec.narration.minSceneSec * 1000);
  assert.equal(timeline.totalMs, b.endMs);
  assert.deepEqual(a.captions, [{ startMs: 1000, endMs: 3000, text: 'Chú thích' }]);
  const longer = buildTimeline(scenes.slice(0, 1), { a: { voiceMs: 1000, visualMs: 20_000 } }, { estimate: () => 0 });
  assert.equal(longer.totalMs, 20_000, 'a recorded scene that lasts longer than its voice keeps its length');
});

test('the subtitles of every cut of both real clips obey the rules (with estimated voices)', () => {
  for (const clip of listClips()) {
    const scenario = loadScenario(clip);
    for (const cut of cutNames(scenario)) {
      const timeline = buildTimeline(selectScenes(scenario, cut), {}, { figures: scenario.figures, mode: 'sample', estimate: (scene) => estimateScene(scene, scenario).voiceMs });
      assert.deepEqual(checkCues(cuesOf(timeline), rules), [], `${clip} ${cut}`);
    }
  }
});

test('subtitles show the words as written with the figures from the manifest, never the respelled text', () => {
  const figures = { rate: { kind: 'percent', sample: 1, digits: 1 } };
  const scenes = [{ id: 'a', chapter: 'x', narration: 'AI cho thấy {{figure:rate}} trên dashboard.' }];
  const timeline = buildTimeline(scenes, { a: { voiceMs: 3000 } }, { figures, manifest: { figures: { rate: { value: 62.4 } } } });
  assert.equal(cuesOf(timeline)[0].text.replace(/\n/gu, ' '), 'AI cho thấy 62,4% trên dashboard.');
});
