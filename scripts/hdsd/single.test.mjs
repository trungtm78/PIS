import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterSection, dataUri, guideHtml, screensSection } from './single.mjs';
import { coverageOf, screensById } from './site.mjs';

const catalogue = [
  { id: 'HOME-01', title: 'Tổng quan', module: 'HOME', moduleName: 'Tổng quan điều hành' },
  { id: 'PRJ-01', title: 'Danh sách <dự án>', module: 'PRJ', moduleName: 'Danh mục dự án' },
];
const flow = { id: 'f1', group: 'G', title: 'Chương "một"', audience: 'Mọi người', outcome: 'Làm được.', steps: [{ id: 's1', screens: ['HOME-01'], heading: 'Mở', text: 'Lời & chữ.', note: 'Chú ý' }] };
const timeline = [{ id: 's1', heading: 'Mở', screens: ['HOME-01'], startMs: 0, voiceMs: 400, endMs: 5000 }];
const assets = { film: (id) => `FILM:${id}`, captions: (id) => `VTT:${id}`, poster: (id) => `POSTER:${id}`, image: (id, step) => `IMG:${id}/${step}` };

test('a file becomes a data address that carries its own bytes', () => {
  assert.equal(dataUri('text/plain', Buffer.from('hi')), 'data:text/plain;base64,aGk=');
});

test('a chapter carries its film, captions and picture inside the page and a button for the moment of each step', () => {
  const html = chapterSection(flow, timeline, screensById(catalogue), assets, 7);
  assert.match(html, /src="FILM:f1"/);
  assert.match(html, /<track kind="captions" srclang="vi"[^>]*src="VTT:f1"/);
  assert.match(html, /poster="POSTER:f1"/);
  assert.match(html, /src="IMG:f1\/s1"/);
  assert.match(html, /id="f1--s1"/);
  assert.match(html, /data-seek="0\.4"/);
  assert.match(html, /class="num">7</);
  assert.match(html, /Chương &quot;một&quot;/);
  assert.match(html, /Lời &amp; chữ\./);
  assert.match(html, /href="#screen-HOME-01"/);
  assert.doesNotMatch(html, /src="(?!FILM|VTT|IMG)[^"]*\.(mp4|png|vtt)"/);
});

test('the table of screens links a screen to the step that shows it, and says why the others are not filmed', () => {
  const coverage = coverageOf(catalogue, [flow], new Map([['f1', timeline]]));
  const html = screensSection(catalogue, coverage, new Map([['PRJ-01', 'Cần dữ liệu mồi']]));
  assert.match(html, /href="#f1--s1" data-open/);
  assert.match(html, /Cần dữ liệu mồi/);
  assert.match(html, /Danh sách &lt;dự án&gt;/);
  assert.match(html, /id="screen-HOME-01"/);
  assert.match(html, /1 trên 2 màn hình/);
});

test('the whole guide is one page with every part and no outside address', () => {
  const coverage = coverageOf(catalogue, [flow], new Map([['f1', timeline]]));
  const html = guideHtml({
    intro: { title: 'Hướng dẫn', lead: 'Giới thiệu', paragraphs: ['Một.'], quickStart: ['Bước 1'] },
    content: { roles: [{ name: 'Quản trị', does: 'Cấu hình' }], rolesIntro: 'Các vai trò.', menu: [{ group: 'Dự án', items: 'Danh sách, Tạo' }], faq: [{ q: 'Quên mật khẩu?', a: 'Dùng trang của tổ chức.' }], glossary: [{ term: 'TTQG', means: 'Mã quốc gia' }], notes: ['Ghi chú.'] },
    chapters: [{ id: 'f1', title: 'Chương một', audience: 'Mọi người', group: 'G', durationMs: 65_000, flow, timeline }],
    screens: screensById(catalogue),
    assets,
    catalogue,
    coverage,
    reasons: new Map(),
    built: '2026-11-07',
  });
  for (const part of ['id="gioi-thieu"', 'id="vai-tro"', 'id="bat-dau"', 'id="muc-luc"', 'id="thuc-don"', 'id="tra-cuu"', 'id="hoi-dap"', 'id="thuat-ngu"', 'id="ghi-chu"', 'id="ch-f1"']) assert.ok(html.includes(part), part);
  assert.match(html, /href="#ch-f1"/);
  assert.match(html, /01:05/);
  assert.doesNotMatch(html, /<link /);
  assert.doesNotMatch(html, /src="https?:/);
  assert.equal(html.startsWith('<!doctype html>'), true);
});
