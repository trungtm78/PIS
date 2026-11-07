import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './lib.mjs';
import { coverageGaps, gapsFound, loadNotFilmed, notFilmedProblems, reasonsOf, secureScreensOf } from './notfilmed.mjs';

const catalogue = [
  { id: 'MOB-01', platform: 'mobile' },
  { id: 'MOB-23', platform: 'mobile' },
  { id: 'MOB-24', platform: 'mobile' },
  { id: 'PRJ-01', platform: 'web' },
];
const entry = (screen) => ({ screen, reason: 'Lý do', evidence: 'Bằng chứng' });

test('a list of not-filmed screens must be an array of screens of the catalogue with a reason and an evidence, each once', () => {
  assert.deepEqual(notFilmedProblems([], catalogue), []);
  assert.deepEqual(notFilmedProblems([entry('MOB-23')], catalogue), []);
  assert.match(notFilmedProblems({ 'MOB-23': 'x' }, catalogue)[0], /must be an array/u);
  assert.match(notFilmedProblems([{ screen: 'MOB-23', reason: ' ', evidence: 'x' }], catalogue).join(), /reason is missing/u);
  assert.match(notFilmedProblems([{ screen: 'MOB-23', reason: 'x' }], catalogue).join(), /evidence is missing/u);
  assert.match(notFilmedProblems([entry('MOB-99')], catalogue).join(), /not a screen of the catalogue/u);
  assert.match(notFilmedProblems([entry('MOB-23'), entry('MOB-23')], catalogue).join(), /listed twice/u);
});

test('the reason of a screen that is not filmed is the words written for the reader of the guide', () => {
  assert.equal(reasonsOf([entry('MOB-23')]).get('MOB-23'), 'Lý do');
});

test('the phone is complete when every screen is shown or listed, and only a protected screen may be listed', () => {
  const base = { phoneIds: ['MOB-01', 'MOB-23', 'MOB-24'], shown: new Map([['MOB-01', []]]), entries: [entry('MOB-23'), entry('MOB-24')], secure: ['MOB-23', 'MOB-24'] };
  assert.equal(gapsFound(coverageGaps(base)), false);
  assert.deepEqual(coverageGaps({ ...base, entries: [entry('MOB-23')] }).missing, ['MOB-24']);
  assert.deepEqual(coverageGaps({ ...base, entries: [entry('MOB-23'), entry('MOB-24'), entry('MOB-01')] }).listedButNotProtected, ['MOB-01']);
  assert.deepEqual(coverageGaps({ ...base, entries: [entry('MOB-23'), entry('MOB-24'), entry('PRJ-01')] }).listedNotOnPhone, ['PRJ-01']);
  assert.deepEqual(coverageGaps({ ...base, shown: new Map([['MOB-01', []], ['MOB-23', []]]) }).protectedButFilmed, ['MOB-23']);
});

test('the screens that the application protects are read from its route policy', () => {
  const secure = secureScreensOf();
  assert.ok(secure.includes('MOB-23') && secure.includes('DOC-22'));
  assert.equal(new Set(secure).size, secure.length);
});

test('scripts/hdsd/not-filmed.json lists exactly the screens that the phone application protects against recordings', () => {
  const catalog = JSON.parse(readFileSync(join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json'), 'utf8'));
  const entries = loadNotFilmed();
  assert.deepEqual(notFilmedProblems(entries, catalog), []);
  assert.deepEqual(entries.map((found) => found.screen).sort(), secureScreensOf().sort());
  for (const found of entries) assert.match(found.reason, /cấm chụp và quay màn hình/u, found.screen);
});
