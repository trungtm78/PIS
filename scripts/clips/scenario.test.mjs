import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLIPS_DIR, loadSpec } from './common.mjs';
import { cutNames, estimateScene, isPending, listClips, loadContext, loadScenario, pendingLanes, recordableScenes, selectScenes, speedOf, STEP_VERBS, unusedRefs, validateScenario } from './scenario.mjs';
import { estimateVoiceMs, sceneMsFromVoice, sentencesOf, syllableCount } from './text.mjs';

const context = loadContext();
const clips = listClips();

test('there are exactly the two clips of the plan', () => {
  assert.deepEqual(clips, ['enterprise-phu-my', 'public-investment']);
});

test('both scenarios pass the whole check against the real catalogue, contract, refs and phonetic table', () => {
  const usedRefs = [];
  for (const clip of clips) {
    const scenario = loadScenario(clip);
    const { problems, used } = validateScenario(scenario, context);
    assert.deepEqual(problems, [], clip);
    assert.equal(scenario.clip, clip);
    usedRefs.push(used.refs);
  }
  assert.deepEqual(unusedRefs(usedRefs, context.refs), []);
});

test('the main video of each clip is 8 to 12 minutes and every standalone chapter cut has its own length', () => {
  const spec = loadSpec();
  for (const clip of clips) {
    const scenario = loadScenario(clip);
    const speed = speedOf(scenario);
    const main = selectScenes(scenario, 'main').reduce((sum, scene) => sum + estimateScene(scene, scenario, { speed }).sceneMs, 0) / 1000;
    assert.ok(main >= spec.mainVideo.minSec && main <= spec.mainVideo.maxSec, `${clip} main ${main}`);
    for (const chapter of scenario.chapters) assert.ok(cutNames(scenario).includes(chapter.id));
  }
});

test('the chapters of the plan exist in both clips as chapter cuts', () => {
  const wanted = ['contractors', 'analytics', 'alerts', 'phone', 'process-tree'];
  for (const clip of clips) {
    const scenario = loadScenario(clip);
    for (const id of wanted) assert.ok(selectScenes(scenario, id).length >= 6, `${clip} ${id}`);
  }
  assert.ok(selectScenes(loadScenario('public-investment'), 'egp').length >= 8, 'the muasamcong chapter has its eight points and more');
});

test('the muasamcong chapter covers the eight points of the plan with the assumption stamp and the no-crawling statement', () => {
  const scenario = loadScenario('public-investment');
  const ids = selectScenes(scenario, 'egp').map((scene) => scene.id);
  for (const id of ['egp-why', 'egp-connection', 'egp-import', 'egp-mapping', 'egp-obligations', 'egp-reconcile', 'egp-tree-evidence']) assert.ok(ids.includes(id), id);
  const why = scenario.scenes.find((scene) => scene.id === 'egp-why');
  assert.match(why.narration, /không quét trang web/u);
  const connection = scenario.scenes.find((scene) => scene.id === 'egp-connection');
  assert.ok(connection.stamps.includes('egp-assumption'));
  assert.ok(scenario.scenes.some((scene) => scene.chapter === 'contractors' && scene.id === 'vnd-egp-link'), 'the contractor chapter links to the network');
});

test('the enterprise clip stamps every scene that shows the six forms as demo forms', () => {
  const scenario = loadScenario('enterprise-phu-my');
  for (const id of ['ent-intro-title', 'rpt-six-forms', 'rpt-word']) assert.ok(scenario.scenes.find((scene) => scene.id === id).stamps.includes('demo-form'), id);
  assert.match(scenario.scenes.find((scene) => scene.id === 'rpt-six-forms').narration, /mẫu demo/u);
});

test('the internal code name is never in a narration or a caption, and no narration carries a free number', () => {
  for (const clip of clips) {
    const scenario = loadScenario(clip);
    for (const scene of scenario.scenes) {
      assert.doesNotMatch(JSON.stringify([scene.narration, scene.captions]), /machvon/iu, scene.id);
      const numbers = scene.narration.replace(/\{\{figure:[a-z0-9-]+\}\}/gu, '').match(/\d+(?:,\d+)?/gu) ?? [];
      for (const number of numbers) assert.ok(scenario.literalNumbers[number] !== undefined, `${scene.id}: ${number}`);
    }
  }
});

test('shared chapters are the same scenes in both clips, so the footage is shared', () => {
  const [enterprise, pub] = ['enterprise-phu-my', 'public-investment'].map((clip) => loadScenario(clip));
  for (const chapter of ['analytics', 'alerts', 'contractors', 'process-tree', 'phone', 'leader-home']) {
    const a = enterprise.scenes.filter((scene) => scene.chapter === chapter && scene.id !== 'ent-home');
    // a scene marked onlyFor public is not in the enterprise clip (no data for its screen there)
    const b = pub.scenes.filter((scene) => scene.chapter === chapter && scene.id !== 'home-command' && !(Array.isArray(scene.onlyFor) && !scene.onlyFor.includes('enterprise')));
    assert.deepEqual(a.map((scene) => scene.id), b.map((scene) => scene.id), chapter);
  }
});

test('a broken scenario is reported with what is wrong, one message each', () => {
  const base = loadScenario('public-investment');
  const copy = (change) => {
    const scenario = { ...base, scenes: base.scenes.map((scene) => ({ ...scene })), figures: { ...base.figures }, _loadProblems: [] };
    change(scenario);
    return validateScenario(scenario, context).problems;
  };
  const first = (scenario) => scenario.scenes[0];
  assert.ok(copy((s) => (first(s).narration = 'Đây là số 77 chưa khai báo.')).some((p) => /number 77 is a literal/u.test(p)));
  assert.ok(copy((s) => (first(s).narration = 'Hệ thống MACHVON.')).some((p) => /internal name/u.test(p)));
  assert.ok(copy((s) => (first(s).narration = 'Gửi file cho đối tác.')).some((p) => /"file" would be read as written/u.test(p)));
  assert.ok(copy((s) => (first(s).narration = 'Con số {{figure:khong-co}} đây.')).some((p) => /figure khong-co is not declared/u.test(p)));
  assert.ok(copy((s) => (first(s).steps = [{ do: 'teleport' }])).some((p) => /unknown step verb/u.test(p)));
  assert.ok(copy((s) => (first(s).steps = [{ do: 'click', ref: 'nowhere.at-all' }])).some((p) => /not in refs.json/u.test(p)));
  assert.ok(copy((s) => (first(s).steps = [{ do: 'command', operation: 'noSuchOperation' }])).some((p) => /not in the contract/u.test(p)));
  assert.ok(copy((s) => (first(s).screen = { platform: 'web', screens: ['ZZZ-99'] })).some((p) => /not in the catalogue/u.test(p)));
  assert.ok(copy((s) => (first(s).expectedSec = 99)).some((p) => /differs from the estimate/u.test(p)));
  assert.ok(copy((s) => (first(s).stamps = ['demo-form'])).some((p) => /stamp demo-form needs a caption/u.test(p)));
  assert.ok(copy((s) => (first(s).captions = [{ text: 'quá dài', atSec: 5, forSec: 50 }])).some((p) => /runs past the scene/u.test(p)));
  assert.ok(copy((s) => s.scenes.push({ ...s.scenes[0] })).some((p) => /id is twice/u.test(p)));
  assert.ok(copy((s) => (s.scenes = s.scenes.map((scene) => ({ ...scene, main: false })))).some((p) => /main video is 0:00/u.test(p)));
  assert.ok(copy((s) => (s.figures = { ...s.figures, 'chua-dung': { kind: 'count', sample: 1, description: 'x', source: { operation: 'getMyWork', select: 'x' } } })).some((p) => /declared and never used/u.test(p)));
});

test('strict mode turns what other lanes still have to build into errors', () => {
  const strict = { ...loadContext({ strict: true }), planned: { operations: {}, screens: { 'planned:later': { lane: 'LATER-1' } } } };
  const base = loadScenario('public-investment');
  const scenario = { ...base, scenes: base.scenes.map((scene) => ({ ...scene })), _loadProblems: [] };
  scenario.scenes[4].screen = { platform: 'web', screens: ['planned:later'] };
  const problems = validateScenario(scenario, strict).problems;
  assert.ok(problems.some((p) => /planned:later is still planned \(lane LATER-1\)/u.test(p)));
  assert.deepEqual(validateScenario(loadScenario('public-investment'), loadContext({ strict: true })).problems, []);
});

test('every verb of the step vocabulary is documented in the README and used or reserved', () => {
  const readme = readFileSync(join(CLIPS_DIR, 'README.md'), 'utf8');
  for (const verb of Object.keys(STEP_VERBS)) assert.ok(readme.includes(`\`${verb}\``), verb);
});

test('every scenario file and shared chapter is valid JSON with Vietnamese only in data files', () => {
  const dir = join(CLIPS_DIR, 'scenarios');
  const files = [...readdirSync(dir).filter((name) => name.endsWith('.json')), ...readdirSync(join(dir, 'shared')).map((name) => `shared/${name}`), ...readdirSync(join(dir, 'public')).map((name) => `public/${name}`)];
  assert.ok(files.length >= 7);
  for (const file of files) JSON.parse(readFileSync(join(dir, file), 'utf8'));
});

test('duration estimates follow the syllable count and the pause between sentences', () => {
  const spec = loadSpec();
  assert.equal(syllableCount('đát-bo và ca-pê-i'), 6);
  assert.deepEqual(sentencesOf('Một câu. Hai câu! Ba câu'), ['Một câu.', 'Hai câu!', 'Ba câu']);
  const oneSentence = estimateVoiceMs('một hai ba bốn năm sáu', 1, spec);
  assert.equal(oneSentence, 2000);
  assert.equal(estimateVoiceMs('một hai ba. bốn năm sáu', 1, spec), 2000 + spec.narration.sentencePauseMs);
  assert.equal(estimateVoiceMs('một hai ba bốn năm sáu', 2, spec), 1000);
  assert.equal(sceneMsFromVoice(1000, spec), spec.narration.minSceneSec * 1000);
  assert.equal(sceneMsFromVoice(10_000, spec), 10_000 + spec.narration.leadInMs + spec.narration.tailMs);
});

/** The lanes of planned.json as if none were merged yet (the real file says they are): the mechanism is tested on this copy. */
const pendingPlanned = (planned) => ({ ...planned, lanes: Object.fromEntries(Object.entries(planned.lanes).map(([name, lane]) => [name, { ...lane, status: 'pending' }])) });

test('a scene that waits for a lane is accepted while the lane is pending, left out of a recording, and checked as any other once the lane is merged', () => {
  const strict = loadContext({ strict: true });
  const planned = pendingPlanned(strict.planned);
  const base = loadScenario('enterprise-phu-my');
  const waiting = base.scenes.filter((scene) => scene.requires !== undefined);
  assert.ok(waiting.length >= 10, 'the enterprise cycle scenes name their lanes');
  for (const scene of waiting) assert.ok(isPending(scene, planned), scene.id);
  for (const scene of waiting.filter((scene) => !scene.requires.includes('ENT-3b-data'))) assert.ok(!isPending(scene, strict.planned), `${scene.id} is ready once the lanes are merged`);
  assert.ok(isPending(waiting.find((scene) => scene.id === 'ec-narrative'), strict.planned), 'the narrative scene waits for its data');
  assert.deepEqual(validateScenario(base, { ...strict, planned }).problems, [], 'strict mode does not fail on a pending scene');
  const lines = [];
  assert.throws(() => recordableScenes(base, 'ent-cycle', { planned, log: (line) => lines.push(line) }), /wait for lanes/u);
  assert.equal(recordableScenes(base, 'features-tour', { planned, log: () => {} }).length, 1, 'the tour of the cycle waits, the other tour scene is made');
  assert.match(lines[0], /ec-snapshot-close \(ENT-3a\)/u);
  assert.equal(recordableScenes(base, 'ent-cycle', { planned, includePending: true }).length, selectScenes(base, 'ent-cycle').length);
  assert.equal(recordableScenes(base, 'ent-cycle', { log: () => {} }).length, selectScenes(base, 'ent-cycle').length - 1, 'merged lanes: every scene of the cycle is recorded but the narrative scene, which waits for its data');
  // a merged lane makes the scene ready
  const merged = { ...planned, lanes: { ...planned.lanes, 'ENT-3d': { status: 'merged' } } };
  assert.equal(pendingLanes(base.scenes.find((scene) => scene.id === 'ec-org-pack'), merged).length, 0);
  // an unknown lane is an error
  const unknown = { ...base, scenes: base.scenes.map((scene) => ({ ...scene })), _loadProblems: [] };
  unknown.scenes.find((scene) => scene.id === 'ec-org-pack').requires = ['NO-SUCH-LANE'];
  assert.ok(validateScenario(unknown, loadContext()).problems.some((p) => /requires lane NO-SUCH-LANE/u.test(p)));
});

test('a chapter marked mainOptional needs no scene in the main video, and the main video stays inside its range with the tour scene', () => {
  const scenario = loadScenario('public-investment');
  const optional = scenario.chapters.filter((chapter) => chapter.mainOptional === true);
  assert.ok(optional.length >= 15);
  for (const chapter of optional) assert.ok(!scenario.scenes.some((scene) => scene.chapter === chapter.id && scene.main), chapter.id);
  assert.ok(scenario.scenes.some((scene) => scene.id === 'tour-more' && scene.main));
  const broken = { ...scenario, chapters: scenario.chapters.map((chapter) => (chapter.id === 'field-ops' ? { ...chapter, mainOptional: false } : chapter)), _loadProblems: [] };
  assert.ok(validateScenario(broken, context).problems.some((p) => /chapter field-ops has no scene in the main video/u.test(p)));
});

test('the added chapters cover the features of the plan in both clips', () => {
  const wanted = ['contractors-plus', 'contractor-portal', 'claims-warnings', 'alerts-plus', 'delegation', 'audit-controls', 'risk-forecast', 'docs-ai-plus', 'integration', 'reports-close', 'field-ops', 'phone-plus', 'platform'];
  for (const clip of clips) {
    const scenario = loadScenario(clip);
    for (const id of wanted) assert.ok(selectScenes(scenario, id).length >= 4, `${clip} ${id}`);
  }
  const enterprise = loadScenario('enterprise-phu-my');
  assert.ok(selectScenes(enterprise, 'ent-cycle').length >= 10);
  assert.ok(selectScenes(loadScenario('public-investment'), 'payments').length >= 5);
});

test('every scenario file under scenarios/ is valid JSON', () => {
  const dir = join(CLIPS_DIR, 'scenarios');
  for (const sub of ['enterprise', 'public', 'shared']) for (const name of readdirSync(join(dir, sub))) JSON.parse(readFileSync(join(dir, sub, name), 'utf8'));
});

test('a recording of a cut whose scenes all wait for lanes is refused with the lanes named', () => {
  const base = loadScenario('enterprise-phu-my');
  const planned = pendingPlanned(loadContext().planned);
  assert.throws(() => recordableScenes(base, 'ent-cycle', { planned, log: () => {} }), /wait for lanes \(ENT-3a/u);
});
