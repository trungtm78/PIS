import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listScenes, loadScene } from './lib.mjs';
import { SCENES, frameOf, sceneOf, sceneProblems } from './scenes/index.mjs';
import { cursorAt, easeInOut, ramp, sceneFade } from './scenes/kit.mjs';
import { lengthOf, partialPath, pointAt, routeOf } from './scenes/topology.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scenes = listScenes().map((id) => loadScene(id));
const byId = (id) => scenes.find((scene) => scene.id === id);
const sampleTimes = (scene) => [0, 250, 1000, 2500, 5000, 8000, 12000, 20000, scene.durationMs - 100, scene.durationMs].filter((t) => t <= scene.durationMs);

test('every kind of animatic the plan asks for exists', () => {
  for (const kind of ['title', 'chapter', 'platform', 'service-flow', 'progress-tree', 'alert-ladder', 'governance-chain']) assert.ok(SCENES.has(kind), kind);
  assert.throws(() => sceneOf('nothing'), /unknown animatic kind/);
});

test('every scene file in data/ is valid for its kind', () => {
  assert.ok(scenes.length >= 9);
  for (const scene of scenes) assert.deepEqual(sceneProblems(scene), [], scene.id);
});

test('a scene is a pure function of time: the same time draws the same markup, in any order', () => {
  for (const scene of scenes) {
    const times = sampleTimes(scene);
    const first = times.map((t) => frameOf(scene, t));
    const again = [...times].reverse().map((t) => frameOf(scene, t)).reverse();
    assert.deepEqual(again, first, scene.id);
  }
});

test('frames hold no float noise, no undefined and no NaN', () => {
  for (const scene of scenes) {
    for (const t of sampleTimes(scene)) {
      const html = frameOf(scene, t);
      assert.doesNotMatch(html, /NaN|undefined|Infinity|\[object/u, `${scene.id} at ${t}`);
      assert.doesNotMatch(html, /(opacity|transform|left|top|width|height):[^"]*d.d{3,}/u, `${scene.id} at ${t}`);
    }
  }
});

test('every scene fades in from nothing and out to nothing, and --no-fade removes both', () => {
  for (const scene of scenes) {
    assert.match(frameOf(scene, 0), /^<div class="scene[^"]*" style="opacity:0"/u, scene.id);
    assert.match(frameOf(scene, scene.durationMs), /style="opacity:0"/u, scene.id);
    assert.match(frameOf({ ...scene, fadeMs: 0 }, 0), /^<div class="scene[^"]*" style="opacity:1"/u, scene.id);
  }
  assert.equal(sceneFade(150, 3000, 300), 0.5);
  assert.equal(sceneFade(1500, 3000, 300), 1);
});

test('the easing and the ramp stay between 0 and 1', () => {
  assert.equal(ramp(0, 100, 500), 0);
  assert.equal(ramp(600, 100, 500), 1);
  assert.equal(ramp(5000, 100, 500), 1);
  assert.equal(ramp(100, 100, 0), 1);
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
});

test('a pointer travels between keyframes and pulses at a click', () => {
  const keys = [{ t: 1000, x: 0, y: 0 }, { t: 2000, x: 100, y: 200, click: true }];
  assert.equal(cursorAt(keys, 500).visible, false);
  assert.deepEqual({ x: cursorAt(keys, 1500).x, y: cursorAt(keys, 1500).y }, { x: 50, y: 100 });
  assert.equal(cursorAt(keys, 2000).ripple, 0);
  assert.ok(cursorAt(keys, 2350).ripple > 0.4);
  assert.equal(cursorAt(keys, 3000).ripple, 0);
  assert.equal(cursorAt([], 100).visible, false);
});

test('links are orthogonal routes whose length and points are exact', () => {
  const nodes = new Map([['a', { id: 'a', x: 0, y: 0, w: 100, h: 100 }], ['b', { id: 'b', x: 300, y: 200, w: 100, h: 100 }], ['c', { id: 'c', x: 300, y: 0, w: 100, h: 100 }]]);
  const straight = routeOf({ from: 'a', to: 'c' }, nodes);
  assert.deepEqual(straight, [{ x: 100, y: 50 }, { x: 300, y: 50 }]);
  const elbow = routeOf({ from: 'a', to: 'b' }, nodes);
  assert.deepEqual(elbow, [{ x: 100, y: 50 }, { x: 200, y: 50 }, { x: 200, y: 250 }, { x: 300, y: 250 }]);
  assert.equal(lengthOf(elbow), 100 + 200 + 100);
  assert.deepEqual(routeOf({ from: 'a', to: 'b', mid: 0.25 }, nodes)[1], { x: 150, y: 50 });
  assert.deepEqual(routeOf({ from: 'a', to: 'b', route: 'v' }, nodes)[0], { x: 50, y: 100 });
  assert.equal(pointAt(elbow, 0.5).x, 200);
  assert.equal(pointAt(elbow, 0.5).y, 150);
  assert.equal(pointAt(elbow, 1).angle, 0);
  assert.equal(partialPath(elbow, 0), 'M100 50 L100 50');
  assert.equal(partialPath(elbow, 1), 'M100 50 L200 50 L200 250 L300 250');
  assert.equal(partialPath(elbow, 0.375), 'M100 50 L200 50 L200 100');
  assert.throws(() => routeOf({ from: 'a', to: 'z' }, nodes), /not there/);
});

test('the platform scene builds up: nodes come in their order, links after both ends', () => {
  const platform = byId('platform-public');
  assert.match(frameOf(platform, 500), /node--store[^>]*opacity:0;/u, 'the database is not there yet');
  const early = frameOf(platform, 1500);
  assert.match(early, /Ứng dụng web/u);
  assert.doesNotMatch(early, /<path d="M[^"]*" fill="none" stroke="var\(--mv-color/u);
  const late = frameOf(platform, 11000);
  assert.match(late, /muasamcong/u);
  assert.ok((late.match(/<polygon/gu) ?? []).length >= 10, 'every link ends in an arrow once drawn');
  const enterprise = frameOf(byId('platform-enterprise'), 13000);
  assert.match(enterprise, /Bộ nối HPM/u);
  assert.match(enterprise, /Bộ nối Oracle EBS/u);
  assert.match(enterprise, /Bản doanh nghiệp/u);
  assert.doesNotMatch(frameOf(platform, 13000), /HPM|Oracle EBS|Bản doanh nghiệp/u);
});

test('the public platform has no enterprise parts and the enterprise one has no e-GP connector', () => {
  const ids = (scene) => scene.nodes.map((node) => node.id);
  assert.ok(ids(byId('platform-public')).includes('egp'));
  assert.ok(!ids(byId('platform-public')).some((id) => id.startsWith('hpm') || id.startsWith('ebs')));
  assert.ok(ids(byId('platform-enterprise')).includes('hpm') && ids(byId('platform-enterprise')).includes('ebs'));
  assert.ok(!ids(byId('platform-enterprise')).includes('egp'));
});

test('the service flow moves a packet along each link in turn and lights the node it reaches', () => {
  const flow = byId('service-flow-public');
  const [first, second] = flow.steps;
  const during = frameOf(flow, first.at + first.dur / 2);
  assert.match(during, /<circle[^>]*r="16"/u);
  assert.match(during, /Hồ sơ thanh toán/u);
  assert.match(during, new RegExp(first.caption, 'u'));
  const after = frameOf(flow, first.at + first.dur + 200);
  assert.match(after, /is-lit/u);
  assert.doesNotMatch(frameOf(flow, 100), /r="16"/u);
  assert.match(frameOf(flow, second.at + 100), /Lệnh đã kiểm quyền/u);
  assert.match(frameOf(flow, second.at + 100), /2\/6/u);
});

test('the progress tree counts up, selects a node, opens its packages and then one package with its days', () => {
  const tree = byId('progress-tree');
  const { select, package: open } = tree.phases;
  const before = frameOf(tree, select - 500);
  assert.match(before, /pt-node/u);
  assert.doesNotMatch(before, /class="pt-panel"/u);
  assert.doesNotMatch(before, /class="pt-page"/u);
  assert.doesNotMatch(before, /is-selected/u);
  const counting = frameOf(tree, tree.phases.tree + 300);
  assert.match(counting, /pt-node__count">0</u);
  assert.match(frameOf(tree, select - 500), /pt-node__count">10<small>/u);
  const selected = frameOf(tree, select + 3000);
  assert.match(selected, /is-selected/u);
  assert.match(selected, /class="pt-panel"/u);
  assert.match(selected, /TB-0412/u);
  assert.match(selected, /stroke-dasharray="16 10"/u);
  const page = frameOf(tree, open + 9000);
  assert.match(page, /class="pt-page"/u);
  assert.match(page, /pt-step pt-step--late/u);
  assert.match(page, /16 ngày không có thay đổi/u);
  assert.match(page, /pt-cell is-changed/u);
  assert.match(page, /Đang chặn/u);
});

test('the progress tree shows a node whose count could not be read as a question mark, never as 0', () => {
  const tree = structuredClone(byId('progress-tree'));
  tree.nodes[1].count = null;
  assert.deepEqual(sceneProblems(tree), []);
  assert.match(frameOf(tree, 6000), /pt-node__count">\?</u);
});

test('the alert ladder shows the three severities with an icon and a word, then the life cycle and the clocks', () => {
  const ladder = byId('alert-ladder');
  const html = frameOf(ladder, 12000);
  for (const word of ['Khẩn', 'Cần xử lý', 'Theo dõi']) assert.match(html, new RegExp(word, 'u'));
  assert.match(html, /⛔/u);
  assert.match(html, /⚠/u);
  assert.match(html, /⏸/u);
  assert.match(html, /Leo thang khi quá hạn/u);
  assert.match(frameOf(ladder, 6200), /al-chip is-active/u);
  assert.doesNotMatch(frameOf(ladder, 300), /al-chip is-active/u);
});

test('the governance chain moves the document from maker to checker to approver, stamping each', () => {
  const chain = byId('governance-chain');
  const x = (t) => Number(/gv-doc" style="left:([\d.]+)px/u.exec(frameOf(chain, t))[1]);
  assert.ok(x(1000) < x(chain.startMs + chain.stepMs + 100));
  assert.ok(x(chain.startMs + chain.stepMs + 100) <= x(chain.startMs + 2 * chain.stepMs + 800));
  assert.match(frameOf(chain, 1500), /gv-stamp" style="opacity:0;/u);
  const end = frameOf(chain, 16000);
  assert.equal((end.match(/gv-stamp" style="opacity:1;/gu) ?? []).length, 3);
  assert.match(end, /Đã lập/u);
  assert.match(end, /Hệ thống từ chối/u);
  assert.match(end, /ADM-11/u);
});

test('the title and chapter cards carry their words', () => {
  assert.match(frameOf(byId('smoke-title'), 2000), /Hệ thống quản lý đầu tư công/u);
  assert.match(frameOf(byId('title-enterprise'), 3000), /Phần mềm quản lý đầu tư xây dựng/u);
  assert.match(frameOf(byId('chapter-progress-tree'), 3000), />04</u);
});

test('text is escaped, so a caption cannot inject markup', () => {
  const scene = { ...byId('smoke-title'), title: '<img src=x onerror=1> & "q"' };
  const html = frameOf(scene, 2000);
  assert.doesNotMatch(html, /<img/u);
  assert.match(html, /&lt;img src=x onerror=1&gt; &amp; &quot;q&quot;/u);
});

test('bad data is reported, not drawn', () => {
  assert.deepEqual(sceneProblems(null), ['the scene has no "kind"']);
  assert.match(sceneProblems({ kind: 'nothing' })[0], /unknown animatic kind/u);
  assert.match(sceneProblems({ kind: 'title' }).join(), /"title" is missing.*"durationMs" is missing/u);
  assert.match(sceneProblems({ kind: 'title', title: 'x', durationMs: -5 }).join(), /durationMs must be positive/u);
  const flow = structuredClone(byId('service-flow-public'));
  flow.links.push({ from: 'web', to: 'ghost' });
  flow.nodes[0].x = 1800;
  flow.steps.push({ link: 'x-y', at: 0, dur: 1 });
  const found = sceneProblems(flow).join();
  assert.match(found, /ghost/u);
  assert.match(found, /outside the 1920x1080 frame/u);
  assert.match(found, /x-y/u);
  const tree = structuredClone(byId('progress-tree'));
  tree.select = 'nowhere';
  tree.phases.package = 100;
  tree.package.timeline.push({ type: 'entry', time: '1', text: 'x', actor: 'a', note: 'n' }, { type: 'entry', time: '1', text: 'x', actor: 'a', note: 'n' });
  const treeProblems = sceneProblems(tree).join();
  assert.match(treeProblems, /nowhere/u);
  assert.match(treeProblems, /phases must come in the order/u);
  assert.match(treeProblems, /the timeline needs/u);
  assert.match(sceneProblems({ ...byId('alert-ladder'), rungs: byId('alert-ladder').rungs.slice(0, 2) }).join(), /three rungs/u);
  assert.match(sceneProblems({ ...byId('governance-chain'), durationMs: 9000 }).join(), /ends before/u);
});

test('the source files of the clips hold English only: the words of a clip live in the json data', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(mjs|js|css)$/u.test(name) && !name.endsWith('.test.mjs')) files.push(path);
    }
  };
  walk(HERE);
  walk(join(HERE, '..', 'record'));
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const bad = /[À-ÃÈ-ÊÌÍÒ-ÕÙÚÝà-ãè-êìíò-õùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ]/u.exec(text);
    assert.equal(bad, null, `${file} has the Vietnamese letter ${bad?.[0]}`);
  }
});
