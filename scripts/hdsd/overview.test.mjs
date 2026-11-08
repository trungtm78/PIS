import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { countsOf, modulesOfChapter, overviewHtml } from './overview.mjs';

const overview = JSON.parse(readFileSync(new URL('./overview.json', import.meta.url), 'utf8'));
const catalogue = JSON.parse(readFileSync(new URL('../../Design/MACHVON_Design/03_Engineering/screen_catalog.json', import.meta.url), 'utf8'));
const screens = new Map(catalogue.map((screen) => [screen.id, screen]));

test('every module of the catalogue has a card, and every screen the controls point to exists', () => {
  const codes = new Set(catalogue.map((screen) => screen.module));
  assert.deepEqual([...codes].filter((code) => !overview.modules.some((module) => module.code === code)), []);
  assert.deepEqual(overview.modules.map((module) => module.code).filter((code) => !codes.has(code)), []);
  const missing = overview.governance.flatMap((control) => control.see).filter((id) => !screens.has(id));
  assert.deepEqual(missing, []);
  const unknownModules = overview.lifecycle.flatMap((step) => step.modules).filter((code) => !codes.has(code));
  assert.deepEqual(unknownModules, []);
});

test('the screens are counted by platform for each module', () => {
  const counts = countsOf(catalogue);
  const countOf = (module, platform) => catalogue.filter((screen) => screen.module === module && (screen.platform === 'mobile') === (platform === 'mobile')).length;
  assert.equal(counts.get('MOB').mobile, countOf('MOB', 'mobile'));
  assert.equal(counts.get('PRJ').web, countOf('PRJ', 'web'));
  assert.equal(counts.get('DIR').web, countOf('DIR', 'web'));
  assert.equal(counts.get('DIR').mobile, countOf('DIR', 'mobile'));
  assert.equal(catalogue.length, [...counts.values()].reduce((sum, entry) => sum + entry.web + entry.mobile, 0));
});

test('the part of the guide about the system has its sections, links the modules of the chain and the chapters of a module', () => {
  const chapters = [{ id: 'tour-prj-a', title: 'Danh mục dự án: A', module: 'PRJ' }, { id: '03-tao-du-an', title: 'Lập dự án mới' }];
  const html = overviewHtml(overview, { catalogue, screens, chapters });
  assert.deepEqual(Object.keys(html), ['values', 'chain', 'governance', 'modules', 'phone']);
  assert.match(html.chain, /href="#pm-PRJ"/u);
  assert.match(html.governance, /href="#screen-ADM-11"/u);
  const card = /<article class="card" id="pm-PRJ">[\s\S]*?<\/article>/u.exec(html.modules)?.[0] ?? '';
  assert.match(card, /href="#ch-tour-prj-a"/u);
  assert.match(card, /href="#ch-03-tao-du-an"/u);
  assert.match(card, new RegExp(`${countsOf(catalogue).get('PRJ').web} màn hình web`, 'u'));
  assert.deepEqual(modulesOfChapter({ id: '02-danh-muc-dia-ban' }, overview.flowModules), ['MDM', 'DOC']);
  assert.deepEqual(modulesOfChapter({ id: 'x', module: 'CAP' }, {}), ['CAP']);
});
