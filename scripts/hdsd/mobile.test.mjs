import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOverrides, centre, chapterProblems, factsOfNodes, filmMsOf, findNode, inputTextOf, nodesOfDump, sameBounds } from './mobile.mjs';

const dump = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.view.View" content-desc="Danh sách dự án" clickable="false" bounds="[0,152][720,216]" />
<node index="1" text="" class="android.widget.Button" content-desc="Bản đồ hiện trường" clickable="false" bounds="[0,712][720,808]" />
<node index="2" text="" class="android.widget.Button" content-desc="Làm mới" clickable="true" bounds="[616,248][712,344]" />
<node index="3" text="" class="android.view.View" content-desc="Hiển thị 3 trên 3 dự án" clickable="false" bounds="[0,352][720,712]" />
<node index="4" text="" class="android.widget.Button" content-desc="Dự án&#10;Tab 2 trong tổng số 5" clickable="true" bounds="[144,1352][288,1512]" />
<node index="5" text="A &amp; B" class="android.view.View" content-desc="" clickable="false" bounds="[0,900][720,960]" />
</hierarchy>`;

test('the nodes of a dump keep what a person hears, where it is and whether it takes a touch; a Button counts even when it is not flagged', () => {
  const nodes = nodesOfDump(dump);
  assert.equal(nodes.length, 6);
  assert.deepEqual(nodes[1], { label: 'Bản đồ hiện trường', clickable: true, bounds: { left: 0, top: 712, right: 720, bottom: 808 } });
  assert.equal(nodes[4].label, 'Dự án\nTab 2 trong tổng số 5');
  assert.equal(nodes[5].label, 'A & B');
  assert.deepEqual(centre(nodes[1]), [360, 760]);
  assert.deepEqual(nodesOfDump('<hierarchy></hierarchy>'), []);
});

test('the facts of a screen leave out the tab bar and the buttons that every screen has', () => {
  const facts = factsOfNodes(nodesOfDump(dump));
  assert.deepEqual(facts.labels, ['Danh sách dự án', 'Hiển thị 3 trên 3 dự án', 'A & B']);
  assert.deepEqual(facts.buttons, ['Bản đồ hiện trường']);
  assert.equal(facts.empty, false);
  assert.equal(factsOfNodes(nodesOfDump(`<node text="" content-desc="Chưa có dữ liệu. Điều chỉnh" class="x" clickable="false" bounds="[0,700][720,800]"/>`)).empty, true);
});

test('a node is found by its name in the content, not in the tab bar', () => {
  const nodes = nodesOfDump(dump);
  assert.equal(findNode(nodes, /^Bản đồ/u)?.bounds.top, 712);
  assert.equal(findNode(nodes, /^Dự án\n/u), undefined);
});

const ids = new Set(['MOB-01', 'MOB-02', 'MOB-03']);
const chapter = (steps, extra = {}) => ({ id: 'm99', group: 'G', title: 'T', audience: 'A', outcome: 'O', module: 'MOB', steps, ...extra });

test('a chapter is checked: one screen of the catalogue for each step, once, known operations, the film stopped and started in pairs, at most eight steps', () => {
  assert.deepEqual(chapterProblems(chapter([{ id: 'mob-01', screens: ['MOB-01'], ops: [{ tab: 'Dự án' }] }, { id: 'mob-02', screens: ['MOB-02'], ops: [{ pause: true }, { tap: 'x' }, { resume: true }] }]), ids), []);
  const bad = chapterProblems(chapter([{ id: 'mob-01', screens: ['MOB-01'], ops: [{ jump: 1 }] }, { id: 'mob-1', screens: ['MOB-01'], ops: [{ pause: true }] }, { id: 'mob-09', screens: ['MOB-09'], ops: [] }, { id: 'x', screens: [], ops: [{ back: true }] }]), ids).join('\n');
  assert.match(bad, /unknown operation/u);
  assert.match(bad, /MOB-01 is shown twice/u);
  assert.match(bad, /the id must be mob-01/u);
  assert.match(bad, /still stopped when the step ends/u);
  assert.match(bad, /MOB-09 is not in the catalogue/u);
  assert.match(bad, /no operations/u);
  assert.match(bad, /exactly one screen/u);
  const nine = Array.from({ length: 9 }, (_, index) => ({ id: `mob-0${index}`, screens: ['MOB-01'], ops: [{ back: true }] }));
  assert.match(chapterProblems(chapter(nine), ids).join(), /9 steps, at most 8/u);
  assert.match(chapterProblems(chapter([{ id: 'mob-01', screens: ['MOB-01'], ops: [{ resume: true }] }]), ids).join(), /started while it runs/u);
  assert.match(chapterProblems(chapter([{ id: 'mob-01', screens: ['MOB-01'], ops: [{ back: true }] }], { module: 'PRJ', prepare: [{ pause: true }] }), ids).join('\n'), /module must be MOB[\s\S]*nothing is filmed there/u);
});

test('the words an author wrote for a step replace the composed ones, and only those', () => {
  const flow = { steps: [{ id: 'mob-52', heading: 'H', text: 'T', note: 'N' }, { id: 'mob-09', heading: 'H9', text: 'T9', note: '' }] };
  applyOverrides(flow, { steps: [{ id: 'mob-52', text: 'Mới' }, { id: 'mob-77', text: 'Không có' }] });
  assert.deepEqual(flow.steps[0], { id: 'mob-52', heading: 'H', text: 'Mới', note: 'N' });
  assert.equal(flow.steps[1].text, 'T9');
});

test('a node is the same when it has not moved; text for the keyboard is escaped and must be ASCII', () => {
  const a = { bounds: { left: 0, top: 1, right: 2, bottom: 3 } };
  assert.equal(sameBounds(a, { bounds: { ...a.bounds } }), true);
  assert.equal(sameBounds(a, { bounds: { ...a.bounds, top: 9 } }), false);
  assert.equal(sameBounds(a, undefined), false);
  assert.equal(inputTextOf('Km3 & (ghi chu)'), 'Km3%s\\&%s\\(ghi%schu\\)');
  assert.throws(() => inputTextOf('Đường'), /only ASCII/u);
});

test('a moment is placed in the film by the pieces that came before its piece, the lag of the recorder and the length of its piece', () => {
  const pieces = [{ startWall: 1000, durationMs: 5000 }, { startWall: 9000, durationMs: 4000 }];
  assert.equal(filmMsOf({ piece: 0, wall: 3000 }, pieces, 700), 1300);
  assert.equal(filmMsOf({ piece: 0, wall: 1100 }, pieces, 700), 0);
  assert.equal(filmMsOf({ piece: 1, wall: 10_700 }, pieces, 700), 6000);
  assert.equal(filmMsOf({ piece: 1, wall: 99_000 }, pieces, 700), 9000);
  assert.throws(() => filmMsOf({ piece: 2, wall: 0 }, pieces, 700), /no piece 2/u);
});
