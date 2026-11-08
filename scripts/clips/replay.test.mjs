import assert from 'node:assert/strict';
import test from 'node:test';
import { loadScenario } from './scenario.mjs';
import { ReplayUi, candidatesFor, glidePath, groupSteps, namePattern, replayStep, replayView, resolve, summariseReplay, travelMs, viewShares } from './record/replay.mjs';

const table = {
  refs: { 'x.exact': ['css:#exact'] },
  tails: { click: { save: ['role:button:Luu|Ghi'] } },
  kinds: { table: ['css:table'], region: ['css:section'], 'first-item': ['css:tbody tr'] },
  words: [{ match: 'first-', kind: 'first-item', verbs: ['click'] }, { match: 'table|rows', kind: 'table' }],
};

/** A page whose screen holds the named places: { 'css:table': [box, ...] }. A place may be hidden. */
function fakePage(places = {}) {
  const calls = [];
  const locatorOf = (name) => {
    const list = places[name] ?? [];
    const make = (index) => ({
      count: async () => list.length,
      nth: (at) => make(at),
      first: () => make(0),
      isVisible: async () => list[index]?.hidden !== true && list[index] !== undefined,
      boundingBox: async () => (list[index] === undefined ? null : { x: list[index].x, y: list[index].y, width: list[index].width, height: list[index].height }),
      scrollIntoViewIfNeeded: async () => calls.push(['into-view', name]),
      click: async (options) => calls.push(['click', name, options?.timeout]),
      pressSequentially: async (text) => calls.push(['type', name, text]),
      evaluate: async (fn, arg) => {
        calls.push(['evaluate', name, fn.name]);
        return fn.name === '' ? true : arg;
      },
      selectOption: async (value) => calls.push(['select', name, value]),
      waitFor: async () => calls.push(['wait-for', name]),
    });
    return make(0);
  };
  return {
    calls,
    getByRole: (role, options) => locatorOf(`role:${role}:${options?.name?.source ?? ''}`),
    getByLabel: (pattern) => locatorOf(`label:${pattern.source}`),
    getByText: (pattern) => locatorOf(`text:${pattern.source}`),
    getByTestId: (id) => locatorOf(`testid:${id}`),
    getByPlaceholder: (pattern) => locatorOf(`placeholder:${pattern.source}`),
    locator: (css) => locatorOf(`css:${css}`),
    mouse: { move: async (x, y) => calls.push(['move', x, y]) },
    keyboard: { press: async (key) => calls.push(['key', key]) },
    waitForTimeout: async (ms) => calls.push(['pause', ms]),
    waitForFunction: async () => undefined,
    evaluate: async (fn) => (fn.name === 'prepareScroller' ? 0 : { busy: 0, alerts: [], loadingText: false, blank: false }),
  };
}

const box = (x, y, width = 300, height = 100, extra = {}) => ({ x, y, width, height, ...extra });

test('a ref is found by its own line, then by the last word, then by the kind of place; a spot always has the region as last resort', () => {
  assert.deepEqual(candidatesFor('click', 'x.exact', table), { source: 'ref', targets: ['css:#exact'] });
  assert.equal(candidatesFor('click', 'a.b.save', table).targets[0], 'role:button:Luu|Ghi');
  assert.deepEqual(candidatesFor('click', 'a.list.first-row', table).targets, ['css:tbody tr']);
  const spot = candidatesFor('spot', 'a.ranking.table', table);
  assert.deepEqual(spot.targets, ['css:table', 'css:section']);
  assert.match(spot.source, /kind:table/u);
  assert.deepEqual(candidatesFor('spot', 'a.nothing.known', table).targets, ['css:section']);
  assert.deepEqual(candidatesFor('click', 'a.nothing.known', table).targets, []);
  assert.deepEqual(candidatesFor('click', undefined, table), { source: 'none', targets: [] });
});

test('every screen step of both scenarios has at least one candidate place (a click is never left to the region fallback)', () => {
  for (const clip of ['enterprise-phu-my', 'public-investment']) {
    for (const scene of loadScenario(clip).scenes) {
      for (const step of scene.steps ?? []) {
        if (!['click', 'choose', 'type', 'point', 'spot'].includes(step.do)) continue;
        const found = candidatesFor(step.do, step.ref);
        assert.ok(found.targets.length > 0, `${clip} ${scene.id}: ${step.do} ${step.ref}`);
        if (step.do !== 'spot') assert.doesNotMatch(found.source, /^kind:region$/u, `${clip} ${scene.id}: ${step.ref}`);
      }
    }
  }
});

test('a name with bars matches any of its parts, without case', () => {
  const pattern = namePattern('Lưu|Ghi (nháp)');
  assert.ok(pattern.test('lưu lại') && pattern.test('GHI (NHÁP)') && !pattern.test('Gửi'));
});

test('resolve takes the first visible place, skips hidden ones, tiny ones and places already framed', async () => {
  const page = fakePage({ 'css:table': [box(0, 0, 400, 200, { hidden: true }), box(10, 10, 2, 2), box(20, 300, 400, 200)], 'css:section': [box(900, 0, 500, 200)] });
  const found = await resolve(page, ['css:missing', 'css:table', 'css:section']);
  assert.equal(found.via, 'css:table');
  assert.equal(found.box.y, 300);
  const second = await resolve(page, ['css:table', 'css:section'], { avoid: [found.box] });
  assert.equal(second.via, 'css:section');
  assert.equal(await resolve(page, ['css:missing']), null);
});

test('the pointer path is smooth: ends exactly on the target, eases in and out, and bends a little', () => {
  const path = glidePath({ x: 0, y: 0 }, { x: 600, y: 300 }, 20);
  assert.equal(path.length, 20);
  assert.deepEqual(path.at(-1), { x: 600, y: 300 });
  const first = path[0].x;
  const middle = path[10].x - path[9].x;
  assert.ok(first < middle, 'it starts slowly');
  assert.ok(path.slice(4, 16).some((point) => Math.abs(point.y - point.x / 2) > 2), 'it is not a ruler line');
  assert.deepEqual(glidePath({ x: 5, y: 5 }, { x: 5, y: 5 }, 3).at(-1), { x: 5, y: 5 });
  assert.ok(travelMs(0) >= 380 && travelMs(5000) <= 1100 && travelMs(500) > travelMs(100));
});

test('a click glides to the place, clicks it and leaves a line in the report', async () => {
  const page = fakePage({ 'css:tbody tr': [box(100, 200, 600, 40)] });
  const ui = new ReplayUi(page, { slowMo: 1 });
  const line = await replayStep(ui, { do: 'click', ref: 'a.list.first-row' }, { table });
  assert.equal(line.status, 'replayed');
  assert.match(line.via, /kind:first-item/u);
  assert.deepEqual(page.calls.find((call) => call[0] === 'click'), ['click', 'css:tbody tr', 6000]);
  assert.ok(page.calls.filter((call) => call[0] === 'move').length >= 10, 'many small moves');
  assert.ok(ui.at.x > 100 && ui.at.y === 220);
});

test('a step with no place on the screen is skipped with a warning, never thrown', async () => {
  const page = fakePage({});
  const warnings = [];
  const line = await replayStep(new ReplayUi(page), { do: 'click', ref: 'a.b.save' }, { table, log: (text) => warnings.push(text) });
  assert.equal(line.status, 'skipped');
  assert.match(line.reason, /not visible/u);
  assert.match(warnings[0], /warning/u);
  const unbound = await replayStep(new ReplayUi(page), { do: 'click', ref: 'a.unknown.thing' }, { table });
  assert.match(unbound.reason, /no binding/u);
});

test('a place that the browser refuses to click is a skipped step with the reason', async () => {
  const page = fakePage({ 'css:tbody tr': [box(100, 200, 600, 40)] });
  const original = page.locator('tbody tr');
  assert.ok(original);
  page.locator = (css) => {
    const loc = fakePage({ 'css:tbody tr': [box(100, 200, 600, 40)] }).locator(css);
    return { ...loc, nth: () => ({ ...loc.nth(0), click: async () => { throw new Error('element is covered by another one\nlong log'); } }) };
  };
  const line = await replayStep(new ReplayUi(page), { do: 'click', ref: 'a.list.first-row' }, { table });
  assert.equal(line.status, 'skipped');
  assert.equal(line.reason, 'element is covered by another one');
});

test('type uses the text of the scenario, and a missing text is skipped', async () => {
  const page = fakePage({ 'css:#exact': [box(50, 50, 300, 30)] });
  const ui = new ReplayUi(page);
  const done = await replayStep(ui, { do: 'type', ref: 'x.exact', textKey: 'k' }, { table, typed: { k: 'Chờ biên bản' } });
  assert.equal(done.status, 'replayed');
  assert.deepEqual(page.calls.find((call) => call[0] === 'type'), ['type', 'css:#exact', 'Chờ biên bản']);
  const missing = await replayStep(ui, { do: 'type', ref: 'x.exact', textKey: 'nope' }, { table, typed: {} });
  assert.match(missing.reason, /missing/u);
});

test('commands, uploads and phone steps are not browser clicks: they are reported as skipped by nature', async () => {
  const ui = new ReplayUi(fakePage());
  for (const step of [{ do: 'command', operation: 'x' }, { do: 'upload', operation: 'y' }, { do: 'phone-tap', ref: 'z' }]) {
    const line = await replayStep(ui, step, { table });
    assert.equal(line.status, 'skipped');
  }
  const summary = summariseReplay([{ status: 'replayed' }, { status: 'skipped', reason: 'done outside the screen (data, not a click)' }, { status: 'skipped', reason: 'not visible on the screen' }]);
  assert.deepEqual(summary, { total: 3, replayed: 1, skipped: 2, offScreen: 1 });
});

test('a spot zooms and dims the place for the slot, restores it, and the next spot avoids the same place', async () => {
  const page = fakePage({ 'css:table': [box(100, 100, 700, 300), box(100, 500, 700, 300)] });
  const ui = new ReplayUi(page);
  const avoid = [];
  const first = await replayStep(ui, { do: 'spot', ref: 'a.rows.table' }, { table, avoid, slotMs: 1500 });
  const second = await replayStep(ui, { do: 'spot', ref: 'a.rows.table' }, { table, avoid, slotMs: 1500 });
  assert.equal(first.status, 'replayed');
  assert.equal(second.status, 'replayed');
  assert.deepEqual(page.calls.filter((call) => call[0] === 'evaluate').map((call) => call[2]), ['applyFocus', 'clearFocus', 'applyFocus', 'clearFocus']);
  assert.equal(page.calls.filter((call) => call[0] === 'pause' && call[1] === 1500).length, 2);
  assert.equal(avoid.length, 2);
  const third = await replayStep(ui, { do: 'spot', ref: 'a.rows.table' }, { table, avoid, slotMs: 1500 });
  assert.equal(third.status, 'skipped', 'both tables were framed already and there is no section');
});

test('a view replays all its steps in order, never throws, closes overlays and tells whether it scrolled', async () => {
  const page = fakePage({ 'css:tbody tr': [box(100, 200, 600, 40)] });
  const steps = [{ do: 'click', ref: 'a.list.first-row' }, { do: 'click', ref: 'a.b.save' }, { do: 'scroll', through: 'voice' }, { do: 'command', operation: 'op' }];
  let clock = 0;
  const result = await replayView(new ReplayUi(page), steps, { budgetMs: 20000, table, now: () => clock, log: () => undefined });
  assert.deepEqual(result.lines.map((line) => line.status), ['replayed', 'skipped', 'replayed', 'skipped']);
  assert.equal(result.scrolled, true);
  clock += 1;
});

test('steps belong to the screen they follow; a longer view gets more of the scene', () => {
  const views = [{ screen: 'A-01' }, { screen: 'B-02' }, { screen: 'C-03' }];
  const scene = { steps: [{ do: 'as', persona: 'p' }, { do: 'open', screen: 'A-01' }, { do: 'spot', ref: 'r1' }, { do: 'open', screen: 'B-02' }, { do: 'click', ref: 'r2' }, { do: 'spot', ref: 'r3' }, { do: 'command', operation: 'x' }] };
  const groups = groupSteps(scene, views);
  assert.deepEqual(groups.map((group) => group.length), [1, 3, 0]);
  const shares = viewShares(groups, 30000);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 30000) < 1e-6);
  assert.ok(shares[1] > shares[0] && shares[0] > shares[2]);
  assert.deepEqual(groupSteps({ steps: [{ do: 'spot', ref: 'r' }] }, []), []);
});
