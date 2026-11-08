import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CURSOR_SCRIPT } from './cursor.mjs';
import { EmptyTenantError, assertSeeded, countOf, devToken, evaluateCounts, loadRequirements, probeTenant } from './data-guard.mjs';
import { convertPhoneTimeline, loadChapters, phonePaths, phoneSceneProblems } from './phone.mjs';
import { apiHeaders, checkTenant, recordWebScene } from './recorder.mjs';
import { StepFailure, budgetOf, runScene } from './runner.mjs';
import { ACTIONS, parseAction, parseScene, parseTarget, sceneProblems, selectSteps, withPersona } from './scene.mjs';
import { MIN_STEP_MS, TAIL_MS, VOICE_DELAY_MS, constantRateArgs, frameOfMs, makeEntry, scaleMs, shiftTimeline, stepSchedule, timelineDocument, timelineProblems, totalMs, waitUntil } from './timeline.mjs';
import { Ui, runAction } from './ui.mjs';
import { loadSceneFile } from './cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const example = (name) => JSON.parse(readFileSync(join(HERE, 'examples', name), 'utf8'));

// ---------- timeline math ----------

test('slow motion lengthens a delay by its factor and never shortens it', () => {
  assert.equal(scaleMs(350, 1), 350);
  assert.equal(scaleMs(350, 2), 700);
  assert.equal(scaleMs(70, 1.5), 105);
  assert.equal(scaleMs(333, 1.5), 500);
  assert.throws(() => scaleMs(100, 0.5), /1 or more/);
  assert.throws(() => scaleMs(100, Number.NaN), /1 or more/);
});

test('a step lasts as long as its voice plus the tail, and at least its minimum', () => {
  assert.deepEqual(stepSchedule({ startMs: 1000, budgetMs: 5000 }), { voiceMs: 1000 + VOICE_DELAY_MS, wantedEndMs: 1000 + VOICE_DELAY_MS + 5000 + TAIL_MS });
  assert.deepEqual(stepSchedule({ startMs: 1000 }), { voiceMs: 1400, wantedEndMs: 1000 + MIN_STEP_MS });
  assert.equal(stepSchedule({ startMs: 0, budgetMs: 200, minMs: 4000 }).wantedEndMs, 4000);
  assert.equal(waitUntil(5000, 3200), 1800);
  assert.equal(waitUntil(5000, 5200), 0);
});

test('a timeline is valid when its steps come in order, do not overlap and keep their voice inside', () => {
  const a = makeEntry({ id: 'a', startMs: 0, endMs: 3000, voiceMs: 400 });
  const b = makeEntry({ id: 'b', startMs: 3000, endMs: 6000, voiceMs: 3400 });
  assert.deepEqual(timelineProblems([a, b]), []);
  assert.match(timelineProblems([a, a]).join(), /is twice/u);
  assert.match(timelineProblems([b, { ...a, id: 'c' }]).join(), /before the step before it ends/u);
  assert.match(timelineProblems([{ ...a, endMs: 0 }]).join(), /before it starts/u);
  assert.match(timelineProblems([{ ...a, voiceMs: 9000 }]).join(), /voice of a is outside/u);
});

test('the timeline file keeps the shape of the user guide and refuses an invalid timeline', () => {
  const entries = [makeEntry({ id: 'a', heading: 'H', screens: ['HOME-01'], startMs: 0, endMs: 3000, voiceMs: 400, shot: 'a.png' })];
  const document = timelineDocument({ sceneId: 's', platform: 'web', slowMo: 1.5, entries });
  assert.deepEqual(Object.keys(document), ['flow', 'platform', 'slowMo', 'fps', 'video', 'durationMs', 'timeline']);
  assert.equal(document.flow, 's');
  assert.equal(document.fps, 30);
  assert.equal(document.durationMs, 3000);
  assert.deepEqual(document.timeline[0], { id: 'a', heading: 'H', screens: ['HOME-01'], startMs: 0, endMs: 3000, voiceMs: 400, shot: 'a.png' });
  assert.throws(() => timelineDocument({ sceneId: 's', platform: 'web', entries: [entries[0], entries[0]] }), /not valid/);
  assert.deepEqual(makeEntry({ id: 'x', startMs: 0, endMs: 1, voiceMs: 0, error: 'boom' }).error, 'boom');
});

test('a timeline can be moved and measured, and a moment finds its frame at 30 fps', () => {
  const entries = [makeEntry({ id: 'a', startMs: 0, endMs: 3000, voiceMs: 400 }), makeEntry({ id: 'b', startMs: 3000, endMs: 6500, voiceMs: 3400 })];
  const moved = shiftTimeline(entries, 5000);
  assert.deepEqual(moved.map((entry) => [entry.startMs, entry.endMs, entry.voiceMs]), [[5000, 8000, 5400], [8000, 11500, 8400]]);
  assert.equal(totalMs(entries), 6500);
  assert.equal(totalMs([]), 0);
  assert.equal(frameOfMs(1000), 30);
  assert.equal(frameOfMs(33), 0);
  assert.equal(frameOfMs(34), 1);
});

test('the recording of the browser is made a constant 30 fps 1920x1080 file for the assembly', () => {
  const args = constantRateArgs({ input: 'a.webm', output: 'a.mp4' }).join(' ');
  assert.match(args, /-i a\.webm/u);
  assert.match(args, /fps=30,scale=1920:1080/u);
  assert.match(args, /-r 30/u);
  assert.match(args, /a\.mp4$/u);
});

// ---------- scene and step parsing ----------

test('a target is written as one word and parsed into the fields of a locator', () => {
  assert.deepEqual(parseTarget('role:button:Save draft'), { kind: 'role', role: 'button', name: 'Save draft' });
  assert.deepEqual(parseTarget('role:table'), { kind: 'role', role: 'table' });
  assert.deepEqual(parseTarget('label:Name'), { kind: 'label', value: 'Name' });
  assert.deepEqual(parseTarget('css:main a:first-child'), { kind: 'css', value: 'main a:first-child' });
  assert.deepEqual(parseTarget('testid:save'), { kind: 'testid', value: 'save' });
  assert.throws(() => parseTarget('button'), /must start with one of/);
  assert.throws(() => parseTarget('css:'), /nothing after the colon/);
  assert.throws(() => parseTarget('role:'), /no role/);
  assert.throws(() => parseTarget(''), /non-empty/);
});

test('an action needs its fields, a known name and sane numbers', () => {
  assert.deepEqual(parseAction({ do: 'click', target: 'label:Name' }), { do: 'click', target: { kind: 'label', value: 'Name' } });
  assert.equal(parseAction({ do: 'wait', ms: 500 }).ms, 500);
  assert.throws(() => parseAction({ do: 'fly' }), /unknown action "fly"/);
  assert.throws(() => parseAction({ do: 'type', target: 'label:Name' }), /needs text/);
  assert.throws(() => parseAction({ do: 'wait', ms: -1 }), /milliseconds/);
  assert.throws(() => parseAction({ do: 'goto', path: 'home' }), /starts with \//);
  assert.throws(() => parseAction(null), /object/);
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['click', 'expect', 'goto', 'hover', 'press', 'scroll', 'select', 'spot', 'type', 'wait']);
});

test('the example scenes are valid, and a broken scene lists every problem at once', () => {
  assert.deepEqual(sceneProblems(example('progress-tree-web.scene.json')), []);
  assert.deepEqual(sceneProblems(example('progress-tree-phone.scene.json')), []);
  const scene = parseScene(example('progress-tree-web.scene.json'));
  assert.equal(scene.steps[0].actions[1].target.kind, 'css');
  assert.deepEqual(scene.steps[1].screens, ['BID-27']);
  const broken = { id: 'Bad Id', platform: 'tv', steps: [] };
  assert.match(sceneProblems(broken).join(), /id of lower-case.*platform must be/u);
  const steps = { id: 's', platform: 'web', steps: [{ id: 'a', actions: [{ do: 'click' }] }, { id: 'a', actions: [{ do: 'wait', ms: 1 }] }, { id: 'b' }, { id: 'c', actions: [{ do: 'wait', ms: 1 }], run: () => undefined }] };
  const found = sceneProblems(steps).join('|');
  assert.match(found, /step a, action 1: the action "click" needs target/u);
  assert.match(found, /step a is twice/u);
  assert.match(found, /step b: give either a list of actions or a run function/u);
  assert.match(found, /step c: give either/u);
  assert.throws(() => parseScene(steps), /scene s:/);
  assert.match(sceneProblems({ id: 'p', platform: 'phone' }).join(), /phoneChapter/u);
});

test('a retake runs only the named steps, in the order of the scene', () => {
  const scene = parseScene(example('progress-tree-web.scene.json'));
  assert.deepEqual(selectSteps(scene).map((step) => step.id), ['open-tree', 'open-node']);
  assert.deepEqual(selectSteps(scene, ['open-node', 'open-tree']).map((step) => step.id), ['open-tree', 'open-node']);
  assert.deepEqual(selectSteps(scene, ['open-node']).map((step) => step.id), ['open-node']);
  assert.throws(() => selectSteps(scene, ['nope']), /no step nope/);
});

test('a path opens as the person of the scene', () => {
  assert.equal(withPersona('/bid/bid-27', 'projectManager'), '/bid/bid-27?devUser=projectManager');
  assert.equal(withPersona('/x?a=1', 'a b'), '/x?a=1&devUser=a%20b');
  assert.equal(withPersona('/x', undefined), '/x');
});

// ---------- the empty-data guard ----------

const requirements = [
  { id: 'projects', label: 'Projects', path: '/resources/project', count: 'items.length', min: 5 },
  { id: 'packages', label: 'Packages', path: '/package-workflows/summary', count: 'total', min: 5 },
  { id: 'alerts', label: 'Alerts', path: '/home/my-work/counts', count: 'counts.total', min: 1 },
];

const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fakeApi = (answers) => async (url) => {
  const path = url.replace('http://api', '');
  const answer = answers[path];
  if (answer instanceof Error) throw answer;
  return answer === undefined ? reply({}, 404) : answer;
};
const SEEDED = {
  '/resources/project': reply({ items: new Array(12).fill({}), next_cursor: null }),
  '/package-workflows/summary': reply({ total: 48, running: 30 }),
  '/home/my-work/counts': reply({ counts: { urgent: 2, action: 5, watch: 4, total: 11 } }),
};

test('the counts of an answer are read by a path, or by "auto"', () => {
  assert.equal(countOf({ items: [1, 2, 3] }, 'items.length'), 3);
  assert.equal(countOf({ total: 7 }, 'total'), 7);
  assert.equal(countOf({ counts: { total: 0 } }, 'counts.total'), 0);
  assert.equal(countOf({ other: 1 }, 'items.length'), null);
  assert.equal(countOf(null, 'total'), null);
  assert.equal(countOf([1, 2], 'auto'), 2);
  assert.equal(countOf({ a: 'x', dashboards: [1, 2, 3] }, 'auto'), 3);
  assert.equal(countOf({ total: 4 }, 'auto'), 4);
  assert.equal(countOf({ a: 'x' }, 'auto'), null);
});

test('a tenant with rows in every key list passes', async () => {
  const counts = await probeTenant({ fetchImpl: fakeApi(SEEDED), baseUrl: 'http://api', headers: {}, requirements });
  assert.deepEqual({ projects: counts.projects, packages: counts.packages, alerts: counts.alerts }, { projects: 12, packages: 48, alerts: 11 });
  const verdict = evaluateCounts(requirements, counts);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
  assert.equal((await assertSeeded({ fetchImpl: fakeApi(SEEDED), baseUrl: 'http://api', headers: {}, requirements })).ok, true);
});

test('an empty tenant is refused and every empty list is named', async () => {
  const empty = { ...SEEDED, '/resources/project': reply({ items: [] }), '/package-workflows/summary': reply({ total: 2 }) };
  await assert.rejects(assertSeeded({ fetchImpl: fakeApi(empty), baseUrl: 'http://api', headers: {}, requirements }), (error) => {
    assert.ok(error instanceof EmptyTenantError);
    assert.equal(error.problems.length, 2);
    assert.match(error.message, /Projects \(projects\) has 0 rows, at least 5 needed/u);
    assert.match(error.message, /Packages \(packages\) has 2 rows, at least 5 needed/u);
    return true;
  });
});

test('a list that cannot be read counts as missing, never as fine', async () => {
  const broken = { ...SEEDED, '/resources/project': reply({}, 500), '/package-workflows/summary': new Error('connect ECONNREFUSED'), '/home/my-work/counts': reply({ nothing: true }) };
  const counts = await probeTenant({ fetchImpl: fakeApi(broken), baseUrl: 'http://api', headers: {}, requirements });
  const verdict = evaluateCounts(requirements, counts);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('|'), /Projects \(projects\) answered 500/u);
  assert.match(verdict.problems.join('|'), /Packages \(packages\) could not be reached \(connect ECONNREFUSED\)/u);
  assert.match(verdict.problems.join('|'), /Alerts \(alerts\) answered with no count/u);
  const denied = evaluateCounts(requirements, await probeTenant({ fetchImpl: fakeApi({ '/resources/project': reply({}, 403) }), baseUrl: 'http://api', headers: {}, requirements }));
  assert.equal(denied.ok, false);
});

test('the minimum can be scaled, and is never below one row', () => {
  const counts = { projects: 3, packages: 3, alerts: 1, errors: {} };
  assert.equal(evaluateCounts(requirements, counts).ok, false);
  assert.equal(evaluateCounts(requirements, counts, { scale: 0.5 }).ok, true);
  assert.equal(evaluateCounts(requirements, { projects: 0, packages: 1, alerts: 0, errors: {} }, { scale: 0.01 }).ok, false);
});

test('both editions have a requirement profile with real endpoints, and an unknown profile is named', () => {
  const operations = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json'), 'utf8')).paths;
  for (const profile of ['public', 'enterprise']) {
    const list = loadRequirements(profile);
    assert.ok(list.length >= 5, profile);
    assert.ok(list.some((requirement) => requirement.id === 'projects'));
    for (const requirement of list) {
      assert.ok(operations[requirement.path]?.get !== undefined, `${profile}: ${requirement.path} is not a GET of the API`);
      assert.ok(requirement.min >= 1, requirement.id);
    }
  }
  assert.ok(loadRequirements('enterprise').some((requirement) => requirement.id === 'directives'));
  assert.ok(loadRequirements('public').some((requirement) => requirement.id === 'contractors'));
  assert.throws(() => loadRequirements('nowhere'), /no requirement profile "nowhere" \(known: public, enterprise\)/);
});

test('the development token has the format the stack signs and verifies', () => {
  const token = devToken({ key: Buffer.from('k'.repeat(32)).toString('base64'), tenantId: 't1', membershipId: 'm1', nowMs: 1_000_000 });
  const [payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), { tenantId: 't1', membershipId: 'm1', scopeVersion: 1, exp: 1300 });
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/u);
  assert.throws(() => devToken({ key: '', tenantId: 't', membershipId: 'm' }), /session key/);
  assert.deepEqual(apiHeaders({ CLIPS_API_TOKEN: 'abc' }), { authorization: 'Bearer abc' });
});

test('the recorder refuses to start a browser on an empty tenant: the guard runs first', async () => {
  const scene = example('progress-tree-web.scene.json');
  const empty = async () => {
    throw new EmptyTenantError(['Projects (projects) has 0 rows, at least 5 needed']);
  };
  await assert.rejects(recordWebScene(scene, { baseUrl: 'http://web', apiUrl: 'http://api', guard: empty, outDir: join(HERE, 'never-written') }), EmptyTenantError);
  await assert.rejects(checkTenant(scene, { apiUrl: 'http://api', headers: {}, fetchImpl: fakeApi({}) }), EmptyTenantError);
  assert.equal((await checkTenant(scene, { apiUrl: 'http://api', headers: {}, fetchImpl: fakeApi({ ...SEEDED, ...Object.fromEntries(loadRequirements('public').map((r) => [r.path, reply({ items: new Array(9).fill({}), total: 9, counts: { total: 9 }, dashboards: [1] })])) }) })).ok, true);
  await assert.rejects(recordWebScene({ ...scene, platform: 'phone', phoneChapter: 'x' }, { baseUrl: 'http://web', guard: empty }), /phone scene/);
  await assert.rejects(recordWebScene(scene, { guard: empty }), /address of the web app/);
});

// ---------- running steps ----------

function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, wait: async (ms) => { now += ms; }, advance: (ms) => { now += ms; } };
}

function fakeUi(log, clock) {
  return {
    locate: (target) => ({ target }),
    goto: async (path) => { log.push(['goto', path]); clock.advance(500); },
    click: async (locator) => { log.push(['click', locator.target.value]); clock.advance(800); },
    hover: async () => undefined,
    type: async (locator, text) => { log.push(['type', text]); },
    press: async (key) => { log.push(['press', key]); },
    select: async () => undefined,
    scrollThrough: async (ms) => { log.push(['scroll', ms]); clock.advance(ms); },
    spot: async (locator, during) => during(),
    expectVisible: async () => undefined,
    wait: async (ms) => { log.push(['wait', ms]); clock.advance(ms); },
  };
}

test('the steps run in order and each is held until its voice has said everything', async () => {
  const clock = fakeClock();
  const log = [];
  const audio = { steps: { 'open-tree': { durationMs: 6000 } } };
  const scene = parseScene(example('progress-tree-web.scene.json'));
  const shots = [];
  const timeline = await runScene(scene, { ui: fakeUi(log, clock), clock, audio, shot: async (id) => { shots.push(id); return `${id}.png`; } });
  assert.deepEqual(log.slice(0, 2), [['goto', '/bid/bid-27'], ['wait', 1200]]);
  const [first, second] = timeline;
  assert.equal(first.id, 'open-tree');
  assert.equal(first.startMs, 0);
  assert.equal(first.voiceMs, VOICE_DELAY_MS);
  assert.equal(first.endMs, VOICE_DELAY_MS + 6000 + TAIL_MS);
  assert.equal(second.startMs, first.endMs);
  assert.ok(second.endMs - second.startMs >= MIN_STEP_MS);
  assert.deepEqual(shots, ['open-tree', 'open-node']);
  assert.deepEqual(timelineProblems(timeline), []);
  assert.equal(first.shot, 'open-tree.png');
});

test('a step with no voice lasts its own minimum, and slow motion lengthens that minimum', async () => {
  const scene = parseScene({ id: 's', platform: 'web', steps: [{ id: 'a', minMs: 4000, actions: [{ do: 'wait', ms: 100 }] }] });
  const normal = fakeClock();
  const [one] = await runScene(scene, { ui: fakeUi([], normal), clock: normal });
  assert.equal(one.endMs, 4000);
  const slow = fakeClock();
  const [two] = await runScene(scene, { ui: fakeUi([], slow), clock: slow, slowMo: 1.5 });
  assert.equal(two.endMs, 6000);
});

test('a step that is too long for its voice is not cut: it ends when its actions end', async () => {
  const scene = parseScene({ id: 's', platform: 'web', steps: [{ id: 'a', actions: [{ do: 'wait', ms: 9000 }] }] });
  const clock = fakeClock();
  const [entry] = await runScene(scene, { ui: fakeUi([], clock), clock, audio: { steps: { a: { durationMs: 1000 } } } });
  assert.equal(entry.endMs, 9000);
});

test('a retake runs only the steps asked for', async () => {
  const scene = parseScene(example('progress-tree-web.scene.json'));
  const clock = fakeClock(10_000);
  const log = [];
  const timeline = await runScene(scene, { ui: fakeUi(log, clock), clock, only: ['open-node'] });
  assert.deepEqual(timeline.map((entry) => entry.id), ['open-node']);
  assert.equal(timeline[0].startMs, 10_000);
  assert.ok(!log.some((entry) => entry[0] === 'goto'));
});

test('a scene module may hold steps written as functions', async () => {
  const clock = fakeClock();
  const seen = [];
  const scene = parseScene({ id: 'code', platform: 'web', steps: [{ id: 'one', run: async (ui, context) => { seen.push(context.budgetMs); } }] });
  const timeline = await runScene(scene, { ui: fakeUi([], clock), clock, audio: { steps: { one: { durationMs: 2500 } } } });
  assert.deepEqual(seen, [2500]);
  assert.equal(timeline.length, 1);
});

test('a failing step is written down with its error and stops the run, keeping the timeline so far', async () => {
  const scene = parseScene({ id: 's', platform: 'web', steps: [{ id: 'ok', actions: [{ do: 'wait', ms: 10 }] }, { id: 'bad', actions: [{ do: 'click', target: 'css:.missing' }] }, { id: 'later', actions: [{ do: 'wait', ms: 10 }] }] });
  const clock = fakeClock();
  const ui = fakeUi([], clock);
  ui.click = async () => {
    throw new Error('no such button');
  };
  await assert.rejects(runScene(scene, { ui, clock }), (error) => {
    assert.ok(error instanceof StepFailure);
    assert.equal(error.stepId, 'bad');
    assert.deepEqual(error.timeline.map((entry) => entry.id), ['ok', 'bad']);
    assert.equal(error.timeline[1].error, 'no such button');
    assert.equal(error.timeline[1].shot, null);
    assert.match(error.message, /the step bad failed: no such button/u);
    return true;
  });
});

test('the voice length of a step is read from the audio index, and a broken index is named', () => {
  assert.equal(budgetOf({ steps: { a: { durationMs: 1234 } } }, 'a'), 1234);
  assert.equal(budgetOf({ steps: {} }, 'a'), 0);
  assert.equal(budgetOf(undefined, 'a'), 0);
  assert.throws(() => budgetOf({ steps: { a: { durationMs: 0 } } }, 'a'), /no duration/);
});

// ---------- the actions, the pointer and the slow motion ----------

function fakePage() {
  const calls = [];
  const locator = (name) => ({
    first: () => locator(name),
    scrollIntoViewIfNeeded: async () => calls.push(['scroll-into-view', name]),
    boundingBox: async () => ({ x: 100, y: 200, width: 40, height: 20 }),
    click: async () => calls.push(['click', name]),
    pressSequentially: async (text, options) => calls.push(['type', text, options.delay]),
    selectOption: async (option) => calls.push(['select', option]),
    waitFor: async (options) => calls.push(['wait-for', name, options.state, options.timeout]),
  });
  return {
    calls,
    getByRole: (role, options) => locator(`role:${role}:${options?.name ?? ''}`),
    getByLabel: (text) => locator(`label:${text}`),
    getByText: (text) => locator(`text:${text}`),
    getByTestId: (id) => locator(`testid:${id}`),
    getByPlaceholder: (text) => locator(`placeholder:${text}`),
    locator: (css) => locator(`css:${css}`),
    mouse: { move: async (x, y, options) => calls.push(['move', x, y, options.steps]) },
    keyboard: { press: async (key) => calls.push(['key', key]) },
    waitForTimeout: async (ms) => calls.push(['pause', ms]),
    goto: async (url) => calls.push(['goto', url]),
    waitForSelector: async () => calls.push(['settle']),
    waitForFunction: async () => undefined,
    evaluate: async (fn, arg) => {
      calls.push(['evaluate', fn.name]);
      return fn.name === 'prepareScroller' ? 1000 : arg;
    },
  };
}

test('the pointer travels to the middle of the target with more steps in slow motion, then clicks', async () => {
  const page = fakePage();
  const ui = new Ui(page, { slowMo: 2 });
  await runAction(ui, parseAction({ do: 'click', target: 'role:button:Save' }));
  assert.deepEqual(page.calls.filter((call) => ['move', 'click'].includes(call[0])), [['move', 120, 210, 44], ['click', 'role:button:Save']]);
  assert.ok(page.calls.some((call) => call[0] === 'pause' && call[1] === 700), 'the pause before a click is 350 ms, doubled');
});

test('typing is slower in slow motion, and a page opens as the persona of the scene', async () => {
  const page = fakePage();
  const ui = new Ui(page, { baseUrl: 'http://web', slowMo: 1.5, persona: 'owner' });
  await runAction(ui, parseAction({ do: 'type', target: 'label:Name', text: 'Cao Bang' }));
  assert.deepEqual(page.calls.find((call) => call[0] === 'type'), ['type', 'Cao Bang', 105]);
  await runAction(ui, parseAction({ do: 'goto', path: '/home/home-01' }));
  assert.deepEqual(page.calls.find((call) => call[0] === 'goto'), ['goto', 'http://web/home/home-01?devUser=owner']);
  await runAction(ui, { do: 'goto', path: '/x', persona: 'other' });
  assert.equal(page.calls.filter((call) => call[0] === 'goto')[1][1], 'http://web/x?devUser=other');
});

test('a frame is drawn around a part of the screen only while the step talks about it', async () => {
  const page = fakePage();
  const ui = new Ui(page, { slowMo: 1 });
  await runAction(ui, parseAction({ do: 'spot', target: 'css:main table', ms: 1800 }));
  const names = page.calls.filter((call) => call[0] === 'evaluate').map((call) => call[1]);
  assert.deepEqual(names, ['addSpot', 'removeSpots']);
  assert.ok(page.calls.some((call) => call[0] === 'pause' && call[1] === 1800));
});

test('scrolling takes as long as asked (longer in slow motion) in steps of a quarter second', async () => {
  const page = fakePage();
  await new Ui(page, { slowMo: 2 }).scrollThrough(1000);
  assert.equal(page.calls.filter((call) => call[0] === 'pause' && call[1] === 250).length, 8);
  const flat = fakePage();
  flat.evaluate = async () => 10;
  await new Ui(flat, { slowMo: 1 }).scrollThrough(1000);
  assert.deepEqual(flat.calls.filter((call) => call[0] === 'pause'), [['pause', 1000]]);
});

test('every action of the scene format has a handler', async () => {
  const page = fakePage();
  const ui = new Ui(page, { baseUrl: 'http://web' });
  const samples = {
    goto: { path: '/a' }, click: { target: 'css:a' }, hover: { target: 'css:a' }, type: { target: 'css:a', text: 'x' }, press: { key: 'Escape' },
    select: { target: 'css:a', option: 'o' }, scroll: { ms: 300 }, spot: { target: 'css:a', ms: 100 }, expect: { target: 'css:a' }, wait: { ms: 10 },
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(ACTIONS).sort());
  for (const [name, fields] of Object.entries(samples)) await runAction(ui, parseAction({ do: name, ...fields }));
  await assert.rejects(runAction(ui, { do: 'nope' }), /unknown action/);
});

test('the pointer script draws an arrow and a ripple in the page and is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(CURSOR_SCRIPT));
  assert.match(CURSOR_SCRIPT, /clips-pointer/u);
  assert.match(CURSOR_SCRIPT, /clips-ripple/u);
  assert.match(CURSOR_SCRIPT, /mousedown/u);
  assert.match(CURSOR_SCRIPT, /--mv-color-primary-hover/u);
});

// ---------- the phone ----------

test('a phone scene must name a chapter of the phone guide', () => {
  const chapters = loadChapters();
  assert.ok(chapters.length >= 10);
  const scene = example('progress-tree-phone.scene.json');
  assert.deepEqual(phoneSceneProblems(scene, chapters), []);
  assert.match(phoneSceneProblems({ ...scene, phoneChapter: 'm99-none' }, chapters)[0], /no chapter m99-none/u);
  assert.match(phoneSceneProblems({ ...scene, platform: 'web' }, chapters)[0], /is a web scene/u);
  assert.match(phoneSceneProblems(scene, [{ id: scene.phoneChapter, steps: [] }])[0], /has no steps/u);
});

test('the film of the phone guide is found in its cache and its timeline becomes the timeline of the clip', () => {
  const paths = phonePaths({ cache: 'D:/cache', outDir: 'D:/out', sceneId: 'sc', chapterId: 'm13' });
  assert.equal(paths.video.replaceAll('\\', '/'), 'D:/cache/rec/m13/video.mp4');
  assert.equal(paths.timeline.replaceAll('\\', '/'), 'D:/cache/rec/m13/timeline.json');
  assert.ok(paths.to.replaceAll('\\', '/').endsWith('out/sc'));
  const guide = { flow: 'm13', timeline: [makeEntry({ id: 'a', startMs: 0, endMs: 4000, voiceMs: 400 }), makeEntry({ id: 'b', startMs: 4000, endMs: 9000, voiceMs: 4400 })] };
  const all = convertPhoneTimeline(guide, { sceneId: 'sc' });
  assert.equal(all.flow, 'sc');
  assert.equal(all.platform, 'phone');
  assert.equal(all.durationMs, 9000);
  assert.deepEqual(convertPhoneTimeline(guide, { sceneId: 'sc', only: ['b'] }).timeline.map((entry) => entry.id), ['b']);
});

// ---------- the command line loads scenes from json and from modules ----------

test('a scene file is a json file or a module with a default export', async () => {
  const fromJson = await loadSceneFile(join(HERE, 'examples', 'progress-tree-web.scene.json'));
  assert.equal(fromJson.id, 'example-progress-tree-web');
});

test('the recorder holds English only: the words of a clip live in json files', () => {
  const bad = /[\u00C0-\u00C3\u00C8-\u00CA\u00CC\u00CD\u00D2-\u00D5\u00D9\u00DA\u00DD\u00E0-\u00E3\u00E8-\u00EA\u00EC\u00ED\u00F2-\u00F5\u00F9\u00FA\u00FD\u0102\u0103\u0110\u0111\u0128\u0129\u0168\u0169\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9]/u;
  for (const name of ['timeline', 'scene', 'data-guard', 'cursor', 'ui', 'runner', 'recorder', 'phone', 'cli']) {
    assert.doesNotMatch(readFileSync(join(HERE, `${name}.mjs`), 'utf8'), bad, name);
  }
});
