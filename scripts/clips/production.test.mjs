import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLIPS_DIR } from './common.mjs';
import { buildBook, bookPath, checkClip, checkFiles, dataRisks, isEnglishOnly, loadAll, musicTimeline, screenFact, secretHits, selectorProblem, shotChecklist, subtitleCues } from './production.mjs';
import { loadScenario } from './scenario.mjs';
import { checkCues } from './subtitles.mjs';

const all = loadAll();
const shared = { context: all.context, facts: all.facts, production: all.production };
const clone = (value) => structuredClone(value);
const clip = 'public-investment';
const check = (change = () => {}, options = {}) => {
  const scenario = clone(loadScenario(clip));
  const production = clone(all.production);
  const facts = { ...all.facts, webRoutes: new Map(all.facts.webRoutes), implemented: new Set(all.facts.implemented) };
  const context = { ...all.context, spec: clone(all.context.spec) };
  change({ scenario, production, facts, context });
  return checkClip(clip, { context, facts, production, scenario, ...options });
};
const sceneOf = (scenario, id) => scenario.scenes.find((scene) => scene.id === id);

test('both clips pass the whole production check and their committed shooting script is current', () => {
  for (const name of all.clips) {
    const { problems } = checkClip(name, shared);
    assert.deepEqual(problems, [], name);
    assert.equal(readFileSync(bookPath(name), 'utf8').replace(/\r\n/gu, '\n'), buildBook(name, shared), name);
  }
  assert.deepEqual(checkFiles({ production: all.production, scenarios: all.clips.map((name) => loadScenario(name)) }), []);
});

test('the scope of the owner is there: the chapters, the committee without a simulation label, the phone and the installed application', () => {
  const publicIds = loadScenario('public-investment').chapters.map((chapter) => chapter.id);
  for (const id of ['contractors', 'analytics', 'alerts', 'phone', 'process-tree', 'province-committee', 'egp']) assert.ok(publicIds.includes(id), id);
  const enterprise = loadScenario('enterprise-phu-my');
  for (const id of ['capital', 'reports-pvn', 'hpm-ebs', 'directives', 'phone']) assert.ok(enterprise.chapters.some((chapter) => chapter.id === id), id);
  assert.ok(enterprise.scenes.some((scene) => scene.screen.platform === 'pwa'));
  const committee = JSON.stringify(readFileSync(join(CLIPS_DIR, 'scenarios', 'public', 'province-committee.json'), 'utf8'));
  assert.ok(!committee.toUpperCase().includes('M\\u00d4 PH\\u1ece'.toUpperCase()));
});

test('a screen id that is not in the catalogue, or has no route, is a problem; a screen without a module is a warning until strict', () => {
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'home-command').screen.screens = ['ZZZ-99'])).problems.some((p) => /not in the catalogue/u.test(p)));
  assert.ok(check(({ facts }) => facts.webRoutes.delete('HOME-09')).problems.some((p) => /screen HOME-09 has no route/u.test(p)));
  const pending = ({ facts }) => facts.implemented.delete('HOME-09');
  assert.ok(check(pending).warnings.some((p) => /HOME-09 .* no module/u.test(p)));
  assert.ok(!check(pending).problems.some((p) => /no module/u.test(p)));
  assert.ok(check(pending, { strict: true }).problems.some((p) => /HOME-09 .* no module/u.test(p)));
  assert.equal(screenFact('MOB-07', all.context, all.facts).kind, 'phone');
  assert.equal(screenFact('PWA-02', all.context, all.facts).route, '/m/approvals');
  assert.equal(screenFact('HOME-09', all.context, all.facts).route, '/home/home-09');
});

test('durations that do not add up, a stale estimate or a chapter over its budget are problems', () => {
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'ban-dashboard').expectedSec += 4)).problems.some((p) => /expectedSec/u.test(p)));
  assert.ok(check(({ scenario }) => scenario.scenes.filter((scene) => scene.main).forEach((scene) => (scene.expectedSec += 0.4))).problems.some((p) => /main video sums to/u.test(p)));
  assert.ok(check(({ production }) => (production.rules.chapterBudgetSec.public.egp = [10, 20])).problems.some((p) => /chapter egp is .* outside its budget/u.test(p)));
});

test('an English-only sentence, a long sentence and a removed label are problems; an acronym in a Vietnamese sentence is not', () => {
  const english = 'The system will show you all the projects of the province.';
  assert.ok(isEnglishOnly(english, all.production.rules.english));
  assert.ok(!isEnglishOnly('Hệ thống API cho PVN và HPM.', all.production.rules.english));
  assert.ok(!isEnglishOnly('KPI PVN HPM', all.production.rules.english));
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'ban-roster').narration += ` ${english}`)).problems.some((p) => /English-only sentence/u.test(p)));
  const long = Array.from({ length: 34 }, () => 'dự án').join(' ');
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'ban-roster').narration = `${long}.`)).problems.some((p) => /too long for the voice/u.test(p)));
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'ban-roster').captions[0].text = 'MÔ PHỎNG')).problems.some((p) => /forbidden label/u.test(p)));
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'ban-roster').narration += ' Đây là dữ liệu mô phỏng.')).problems.some((p) => /dữ liệu mô phỏng/u.test(p)));
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'ban-roster').captions[0].text = 'x'.repeat(80))).problems.some((p) => /caption of 80 characters/u.test(p)));
});

test('a foreign word that the phonetic table does not cover is a problem, and a covered one is not', () => {
  assert.ok(check(({ scenario }) => (sceneOf(scenario, 'ban-roster').narration += ' Gửi file cho đối tác.')).problems.some((p) => /"file" would be read as written/u.test(p)));
  assert.ok(!check(({ scenario }) => (sceneOf(scenario, 'ban-roster').narration += ' Chạy trên PWA và API.')).problems.some((p) => /would be read as written/u.test(p)));
});

test('subtitle lines over the limit are problems', () => {
  assert.ok(check(({ context }) => (context.spec.subtitles.maxCharsPerLine = 12)).problems.some((p) => /subtitles:/u.test(p)));
  assert.ok(checkCues([{ startMs: 0, endMs: 3000, text: 'x'.repeat(60) }], all.context.spec.subtitles).some((p) => /a line of 60 characters/u.test(p)));
  assert.ok(checkCues([{ startMs: 0, endMs: 3000, text: ['a', 'b', 'c'].join(String.fromCharCode(10)) }], all.context.spec.subtitles).some((p) => /3 lines/u.test(p)));
  const scene = sceneOf(loadScenario(clip), 'ban-dashboard');
  const cues = subtitleCues(scene, loadScenario(clip), all.context);
  assert.ok(cues.length >= 2);
  for (const cue of cues) for (const line of cue.text.split('\n')) assert.ok(line.length <= all.context.spec.subtitles.maxCharsPerLine);
  assert.ok(subtitleCues(scene, loadScenario(clip), all.context, { figureToken: true }).some((cue) => cue.text.includes('{n}')));
});

test('secrets in the files of the clips are found, and a clean file is not', () => {
  const key = ['sk', 'a'.repeat(30)].join('-');
  const bearer = `Bearer ${'b'.repeat(30)}`;
  const assignment = `VIENEU_TTS_API_KEY=${'c'.repeat(24)}`;
  for (const text of [key, bearer, assignment, ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '), `AKIA${'A'.repeat(16)}`]) assert.ok(secretHits(text, all.production.rules.secretPatterns).length > 0, text);
  assert.deepEqual(secretHits('The variable VIENEU_TTS_API_KEY is read from the environment.', all.production.rules.secretPatterns), []);
  const dir = mkdtempSync(join(tmpdir(), 'clipscripts-'));
  const file = join(dir, 'leak.json');
  writeFileSync(file, JSON.stringify({ note: assignment }));
  const problems = checkFiles({ production: all.production, scenarios: all.clips.map((name) => loadScenario(name)), files: [file] });
  assert.equal(problems.length, 1);
  assert.ok(!problems[0].includes('cccc'), 'the secret itself is never printed');
});

test('the owner scope is enforced: required chapters, platforms and stamps', () => {
  assert.ok(check(({ scenario }) => (scenario.chapters = scenario.chapters.filter((chapter) => chapter.id !== 'province-committee'))).problems.some((p) => /required chapter province-committee is missing/u.test(p)));
  assert.ok(check(({ scenario }) => { sceneOf(scenario, 'egp-import').stamps = []; }).problems.some((p) => /needs the stamp egp-assumption/u.test(p)));
  const enterprise = clone(loadScenario('enterprise-phu-my'));
  enterprise.scenes.forEach((scene) => { if (scene.screen.platform === 'pwa') scene.screen.platform = 'phone'; });
  assert.ok(checkClip('enterprise-phu-my', { ...shared, scenario: enterprise }).problems.some((p) => /no scene on the platform pwa/u.test(p)));
});

test('the music cue sheet: one cue per chapter, only CC0, fades, level under the voice, approval needs the date the licence was read', () => {
  assert.ok(check(({ production }) => production.music.clips[clip].cues[1].chapters.pop()).problems.some((p) => /covered by 0 music cues/u.test(p)));
  assert.ok(check(({ production }) => production.music.clips[clip].cues[1].chapters.push('intro')).problems.some((p) => /intro is covered by 2 music cues/u.test(p)));
  assert.ok(check(({ production }) => (production.music.tracks[0].licence = 'CC BY 4.0')).problems.some((p) => /only CC0 is allowed/u.test(p)));
  assert.ok(check(({ production }) => (production.music.tracks[0].approval = { status: 'APPROVED', licenceReadOn: null })).problems.some((p) => /approved without the date/u.test(p)));
  assert.ok(check(({ production }) => (production.music.levels.lift.relativeDb = 8)).problems.some((p) => /louder than -17 dB/u.test(p)));
  assert.ok(check(({ production }) => delete production.music.clips[clip].cues[0].fadeInSec).problems.some((p) => /fades in too briefly/u.test(p)));
  assert.ok(check(({ production }) => delete production.music.clips[clip].cues.at(-1).fadeOutSec).problems.some((p) => /fades out too briefly/u.test(p)));
  const timeline = musicTimeline(clip, loadScenario(clip), all.production, all.context);
  assert.equal(timeline[0].startSec, 0);
  assert.deepEqual(timeline.map((cue) => cue.startSec), [...timeline.map((cue) => cue.startSec)].sort((a, b) => a - b));
});

test('seed readiness: groups must be groups of the dataset, every chapter has an entry, unproven data is a warning (a problem under strict-data)', () => {
  assert.ok(check(({ production }) => (production.readiness.datasets.public.groups['clip-public-nowhere'] = { proof: 'RUN_VERIFIED' })).problems.some((p) => /is not a group of the public dataset/u.test(p)));
  assert.ok(check(({ production }) => delete production.readiness.datasets.public.groups['clip-public-egp']).problems.some((p) => /has no proof state/u.test(p)));
  assert.ok(check(({ production }) => delete production.readiness.datasets.public.chapters.egp).problems.some((p) => /chapter egp has no readiness entry/u.test(p)));
  assert.ok(check(({ production }) => (production.readiness.datasets.public.groups.base.proof = 'MAYBE')).problems.some((p) => /unknown proof state/u.test(p)));
  const risks = dataRisks(loadScenario(clip), all.production);
  assert.deepEqual(risks.get('alerts').pending, ['clip-public-alerts']);
  assert.ok(check().warnings.some((p) => /chapter alerts: groups not run/u.test(p)));
  assert.ok(check(() => {}, { strictData: true }).problems.some((p) => /chapter alerts: groups not run/u.test(p)));
});

test('the shot checklist names the screen with its route, every stamp and caption, and every figure with its source', () => {
  const scenario = loadScenario(clip);
  const items = shotChecklist(sceneOf(scenario, 'ban-dashboard'), scenario, all.context, all.facts, all.production);
  const text = items.map((item) => item.text).join('\n');
  assert.ok(text.includes('/ban/ban-01'));
  assert.ok(text.includes('committee-projects') && text.includes('getCommitteeWorkspace'));
  assert.ok(items.some((item) => item.kind === 'extra'));
  const feed = shotChecklist(sceneOf(scenario, 'ban-feed'), scenario, all.context, all.facts, all.production).map((item) => item.text).join('\n');
  assert.ok(feed.includes('Mẫu tệp là giả định, chờ đặc tả chính thức'));
  assert.ok(check(({ production }) => (production.shots.scenes['no-such-scene'] = ['x'])).problems.length === 0, 'orphans are found by checkFiles');
  assert.ok(checkFiles({ production: { ...all.production, shots: { scenes: { 'no-such-scene': ['x'] } } }, scenarios: [scenario], files: [] }).some((p) => /scene no-such-scene is in no clip/u.test(p)));
});

test('the shooting script holds the narration, the respelled voice text, the subtitles and the checklist, and never a sampled figure', () => {
  const book = buildBook(clip, shared);
  assert.ok(book.includes('{{figure:disb-rate-pm}}'));
  assert.ok(!book.includes('62,4'));
  assert.ok(book.includes('đát-bo') || book.includes('ây-ai') || book.includes('pê-đắp-liu-a'));
  assert.ok(book.includes('- [ ] '));
  assert.ok(book.includes('Bảng nhạc nền'));
  assert.equal(buildBook(clip, shared), buildBook(clip, shared));
  assert.ok(!book.includes('\r'));
});

test('this tooling holds no Vietnamese letters in code (they live in JSON and markdown)', () => {
  for (const file of [join(CLIPS_DIR, 'production.mjs'), join(CLIPS_DIR, '..', 'clip-scripts-check.mjs')]) {
    const text = readFileSync(file, 'utf8');
    assert.ok([...text].every((char) => char.charCodeAt(0) < 128), file);
  }
});

test('a figure selector must read a field that the answer of its operation has', () => {
  assert.equal(selectorProblem('listEbsDifferences', 'counts.open'), null);
  assert.match(selectorProblem('listEbsDifferences', 'meta.open_count'), /does not have/u);
  assert.equal(selectorProblem('noSuchOperation', 'x.y'), null);
  assert.ok(check(({ scenario }) => (scenario.figures['committee-projects'].source.select = 'nowhere.projects')).problems.some((p) => /figure committee-projects reads "nowhere"/u.test(p)));
  assert.equal(loadScenario('enterprise-phu-my').figures['ent-ebs-differences'].source.select, 'counts.open');
});

test('the book labels a scene as part of the main video only when this edition plays it there', () => {
  const book = buildBook('enterprise-phu-my', shared);
  const section = book.slice(book.indexOf('### `home-drill`'));
  assert.match(section.slice(0, section.indexOf('**Lời đọc**')), /chỉ trong chương cắt riêng/u);
  const publicBook = buildBook('public-investment', shared);
  const publicSection = publicBook.slice(publicBook.indexOf('### `home-drill`'));
  assert.match(publicSection.slice(0, publicSection.indexOf('**Lời đọc**')), /có trong video chính/u);
});
