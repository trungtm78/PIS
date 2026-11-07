import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './lib.mjs';
import { chapterProblems } from './mobile.mjs';
import { commandNames } from './mobile-data.mjs';
import { loadNotFilmed } from './notfilmed.mjs';

const read = (...parts) => JSON.parse(readFileSync(join(REPO_ROOT, ...parts), 'utf8'));
const catalogue = read('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');
const phone = catalogue.filter((screen) => screen.platform === 'mobile').map((screen) => screen.id);
const chapters = read('scripts', 'hdsd', 'mobile-chapters.json');

test('every phone chapter is well formed', () => {
  const ids = new Set(catalogue.map((screen) => screen.id));
  assert.deepEqual(chapters.flatMap((chapter) => chapterProblems(chapter, ids)), []);
  assert.equal(new Set(chapters.map((chapter) => chapter.id)).size, chapters.length);
});

test('the phone has 72 screens, and each one is shown by a step of a chapter or listed as not filmed, never both', () => {
  assert.equal(phone.length, 72);
  const shown = new Set(chapters.flatMap((chapter) => chapter.steps.map((step) => step.screens[0])));
  const listed = new Set(loadNotFilmed().map((entry) => entry.screen));
  assert.deepEqual(phone.filter((id) => !shown.has(id) && !listed.has(id)), [], 'screens with neither a step nor a reason');
  assert.deepEqual([...shown].filter((id) => listed.has(id)), [], 'screens that are both filmed and listed');
  assert.deepEqual([...shown].filter((id) => !phone.includes(id)), [], 'steps that show a screen of the web');
  assert.equal(shown.size + listed.size, 72);
});

test('the phone chapters are in the list of chapters of the guide, in order, after the tours', () => {
  const list = read('scripts', 'hdsd', 'chapters.json');
  const mobile = list.filter((chapter) => chapter.kind === 'mobile').map((chapter) => chapter.id);
  assert.deepEqual(mobile, chapters.map((chapter) => chapter.id));
  assert.equal(list.findIndex((chapter) => chapter.kind === 'mobile'), list.length - mobile.length);
});

test('what the customer reads in a phone chapter says the new name of the system, never the old one', () => {
  const words = chapters.flatMap((chapter) => [chapter.title, chapter.outcome, ...chapter.steps.flatMap((step) => [step.heading, step.text, step.note])]).filter((text) => typeof text === 'string');
  assert.deepEqual(words.filter((text) => /machvon/iu.test(text)), []);
});

test('a chapter that runs a command of the data maker names a command it has', () => {
  const commands = new Set(chapters.flatMap((chapter) => [...(chapter.prepare ?? []), ...chapter.steps.flatMap((step) => step.ops)]).filter((op) => 'run' in op).map((op) => op.run.split(/\s+/u)[0]));
  for (const command of commands) assert.ok(commandNames.includes(command), `mobile-data.mjs has no command ${command}`);
});
