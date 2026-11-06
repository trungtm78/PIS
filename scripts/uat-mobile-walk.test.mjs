import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headingOf, identify, journalOf, judge, logProblems, nodesOf, parseBounds, smallTargets, targetsOf, titlesOf, unlabelled } from './uat-mobile-walk.mjs';

const node = (label, [left, top, right, bottom], extra = {}) => ({ label, bounds: { left, top, right, bottom }, clickable: false, editable: false, cls: '', ...extra });
const TITLES = titlesOf([
  { id: 'MOB-07', title: 'Trang chủ lãnh đạo' },
  { id: 'MOB-09', title: 'Danh sách dự án' },
  { id: 'WEB-01', title: 'A screen of the web' },
]);

test('the bounds of a node are read, and a text that holds none is null', () => {
  assert.deepEqual(parseBounds('[144,1352][288,1512]'), { left: 144, top: 1352, right: 288, bottom: 1512 });
  assert.equal(parseBounds('nothing'), null);
  assert.equal(parseBounds(undefined), null);
});

test('the nodes of a hierarchy are flattened with the text a person hears, the text first and then the accessibility text', () => {
  const root = {
    attributes: {},
    children: [
      { attributes: { text: '', accessibilityText: 'Dự án\nTab 2 trong tổng số 5', bounds: '[144,1352][288,1512]', clickable: 'true', class: 'android.view.View' }, children: [] },
      { attributes: { text: 'Tìm', accessibilityText: '', bounds: '[0,300][720,400]', clickable: 'true', class: 'android.widget.EditText' }, children: [] },
      { attributes: { text: 'Bản đồ', bounds: '[0,712][720,808]', clickable: 'false', class: 'android.widget.Button' }, children: [] },
      { attributes: { text: 'no bounds' }, children: [] },
    ],
  };
  const nodes = nodesOf(root);
  assert.deepEqual(nodes.map((item) => [item.label, item.clickable, item.editable]), [
    ['Dự án\nTab 2 trong tổng số 5', true, false],
    ['Tìm', true, true],
    ['Bản đồ', true, false],
  ]);
  assert.deepEqual(nodesOf(null), []);
});

test('a screen is the one whose catalogue title is in its bar; the titles of other platforms are not screens of the phone', () => {
  assert.equal(identify([node('Trang chủ lãnh đạo', [32, 160, 600, 230])], TITLES), 'MOB-07');
  assert.equal(identify([node('DANH SÁCH DỰ ÁN', [32, 160, 600, 230])], TITLES), 'MOB-09');
  assert.equal(identify([node('A screen of the web', [32, 160, 600, 230])], TITLES), null);
  assert.equal(identify([node('Something else', [32, 160, 600, 230])], TITLES), null);
  // a title in the body is the name of a neighbour, not the name of the screen
  assert.equal(identify([node('Danh sách dự án', [32, 900, 600, 960])], TITLES), null);
  assert.equal(identify([node('Chi tiết', [32, 160, 600, 230]), node('Danh sách dự án', [32, 500, 600, 560])], TITLES), null);
});

test('the heading of an unknown screen is the first line of the first label in its bar', () => {
  assert.equal(headingOf([node('6:41', [75, 40, 130, 90]), node('Một màn lạ\nphụ', [32, 160, 600, 230])]), 'Một màn lạ');
  assert.equal(headingOf([node('Quay lại', [20, 160, 100, 230]), node('Bản đồ hiện trường', [120, 160, 600, 230])]), 'Bản đồ hiện trường');
  assert.equal(headingOf([]), '');
});

test('a touch area with no name is found, an input field and the bar of the system are not', () => {
  const nodes = [
    node('', [10, 300, 110, 400], { clickable: true }),
    node('', [10, 420, 700, 500], { clickable: true, editable: true }),
    node('', [10, 20, 110, 100], { clickable: true }),
    node('Mở', [10, 520, 110, 620], { clickable: true }),
  ];
  assert.deepEqual(unlabelled(nodes).map((item) => item.bounds.top), [300]);
});

test('a touch area under 48 dp is listed with its size', () => {
  const nodes = [node('Nhỏ\nphụ', [10, 300, 80, 380], { clickable: true }), node('Đủ', [10, 400, 200, 520], { clickable: true }), node('Chữ', [10, 600, 60, 640])];
  assert.deepEqual(smallTargets(nodes), [{ label: 'Nhỏ', width: 70, height: 80 }]);
});

test('what the walk may tap: named touch areas of the content, once for each name, never an action that changes something', () => {
  const nodes = [
    node('Dự án thử', [0, 600, 700, 700], { clickable: true }),
    node('Dự án thử', [0, 720, 700, 800], { clickable: true }),
    node('Đăng xuất', [0, 820, 700, 900], { clickable: true }),
    node('Phê duyệt', [0, 920, 700, 1000], { clickable: true }),
    node('Dự án chưa nộp báo cáo', [0, 1010, 700, 1090], { clickable: true }),
    node('Trang chủ\nTab 1 trong tổng số 5', [0, 1352, 144, 1512], { clickable: true }),
    node('Làm mới', [616, 248, 712, 344], { clickable: true }),
    node('Kế hoạch vốn', [0, 1100, 700, 1200], { clickable: true }),
    node('Chữ', [0, 1210, 700, 1250]),
  ];
  assert.deepEqual(targetsOf(nodes, 10).map((item) => item.label), ['Dự án thử', 'Dự án chưa nộp báo cáo', 'Kế hoạch vốn']);
  assert.equal(targetsOf(nodes, 1).length, 1);
});

test('the lines of a log that say the application broke are kept, a few of them', () => {
  const log = ['I/flutter ( 1): fine', 'E/AndroidRuntime: FATAL EXCEPTION: main', 'I/flutter ( 1): A RenderFlex overflowed by 12 pixels on the right.', 'I/flutter ( 1): ══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞══'].join('\n');
  assert.equal(logProblems(log).length, 3);
  assert.deepEqual(logProblems('nothing\nhappened'), []);
});

test('a visit passes when the application lives, the log is clean, every control has a name and the screen says something', () => {
  const good = [node('Danh sách dự án', [32, 160, 600, 230]), node('Mở', [10, 520, 300, 620], { clickable: true })];
  assert.deepEqual(judge({ nodes: good, problems: [], alive: true }), { status: 'passed', reasons: [] });
  const bad = judge({ nodes: [node('', [10, 300, 300, 400], { clickable: true })], problems: ['FATAL EXCEPTION'], alive: false });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.reasons.length, 4);
});

test('the journal holds one result for each design screen: a failed visit wins over a passed one, a screen the catalogue does not know is left out', () => {
  const visit = (id, status, at) => ({ id, title: 'T', status, at, endedAt: new Date(Date.parse(at) + 5000).toISOString() });
  const lines = journalOf([
    visit('MOB-07', 'passed', '2026-11-06T01:00:00.000Z'),
    visit('MOB-09', 'passed', '2026-11-06T01:01:00.000Z'),
    visit('MOB-09', 'failed', '2026-11-06T01:02:00.000Z'),
    visit(null, 'passed', '2026-11-06T01:03:00.000Z'),
  ]);
  assert.deepEqual(lines.map((line) => [line.name, line.status, line.suite, line.file, line.durationMs]), [
    ['UI-MOB-07 T', 'passed', 'maestro', '', 5000],
    ['UI-MOB-09 T', 'failed', 'maestro', '', 5000],
  ]);
  assert.equal(lines[1].at, '2026-11-06T01:02:00.000Z');
});
