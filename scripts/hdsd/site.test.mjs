import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterHtml, coverageOf, indexHtml, screensById, screensHtml } from './site.mjs';

const catalogue = [
  { id: 'HOME-01', title: 'Tổng quan điều hành', module: 'HOME', moduleName: 'Tổng quan' },
  { id: 'PRJ-01', title: 'Danh sách <dự án>', module: 'PRJ', moduleName: 'Danh mục dự án' },
];
const flow = { id: 'f1', group: 'G', title: 'Chương "một"', audience: 'Mọi người', outcome: 'Làm được.', steps: [{ id: 's1', screens: ['HOME-01'], heading: 'Mở', text: 'Lời & chữ.', note: 'Chú ý' }, { id: 's2', screens: [], heading: 'Hai', text: 'Hai.' }] };
const timeline = [{ id: 's1', heading: 'Mở', screens: ['HOME-01'], startMs: 0, voiceMs: 400, endMs: 5000 }, { id: 's2', heading: 'Hai', screens: [], startMs: 5000, voiceMs: 5400, endMs: 9000 }];

test('a screen is covered when a recorded step shows it, with the chapter and the moment', () => {
  const coverage = coverageOf(catalogue, [flow], new Map([['f1', timeline]]));
  assert.equal(coverage.covered, 1);
  assert.equal(coverage.total, 2);
  assert.deepEqual(coverage.shown.get('HOME-01').map((place) => [place.flow, place.step, place.startMs]), [['f1', 's1', 400]]);
  assert.equal(coverage.shown.has('PRJ-01'), false);
  assert.equal(coverageOf(catalogue, [flow], new Map()).covered, 0);
});

test('a chapter page has the film, the captions, and a button for the moment of each step; the words are escaped', () => {
  const html = chapterHtml(flow, timeline, screensById(catalogue), { number: 3 });
  assert.match(html, /<video id="clip"[^>]*src="clips\/f1\.mp4"/);
  assert.match(html, /<track kind="captions" srclang="vi"[^>]*src="clips\/f1\.vi\.vtt"/);
  assert.match(html, /data-seek="0\.4"/);
  assert.match(html, /data-seek="5\.4"/);
  assert.match(html, /Chương &quot;một&quot;/);
  assert.match(html, /Lời &amp; chữ\./);
  assert.match(html, /class="num">3</);
  assert.match(html, /href="man-hinh\.html#HOME-01"/);
});

test('the table of screens says which chapter shows each screen and says why the others are not filmed', () => {
  const coverage = coverageOf(catalogue, [flow], new Map([['f1', timeline]]));
  const html = screensHtml(catalogue, coverage, new Map([['PRJ-01', 'Cần dữ liệu mồi']]));
  assert.match(html, /href="f1\.html#s1"/);
  assert.match(html, /Cần dữ liệu mồi/);
  assert.match(html, /Danh sách &lt;dự án&gt;/);
  assert.match(html, /1 trên 2 màn hình/);
});

test('the first page lists the chapters by group in the order of the work', () => {
  const coverage = coverageOf(catalogue, [flow], new Map([['f1', timeline]]));
  const html = indexHtml({ chapters: [{ id: 'f1', title: 'Chương một', audience: 'Mọi người', group: 'G', durationMs: 65_000 }], coverage, intro: { title: 'T', lead: 'L', paragraphs: ['P'], quickStart: ['Q'] } });
  assert.match(html, /<h3>G<\/h3>/);
  assert.match(html, /href="machvon\/f1\.html"/);
  assert.match(html, /01:05/);
  assert.match(html, /href="machvon\/style\.css"/);
});
