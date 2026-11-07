import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODULE_ORDER, moduleNamesOf, slug, tourChapters } from './chapters.mjs';

const routes = [
  { id: 'CAP-01', module: 'CAP', group: 'Kế hoạch vốn' },
  { id: 'PRJ-01', module: 'PRJ', group: 'Danh mục & theo dõi' },
  { id: 'PRJ-02', module: 'PRJ', group: 'Danh mục & theo dõi' },
  { id: 'ADM-01', module: 'ADM', group: 'Tổ chức & con người' },
  { id: 'ZZZ-01', module: 'ZZZ', group: 'Lạ' },
];

test('a slug has no accents, spaces or signs', () => {
  assert.equal(slug('Danh mục & theo dõi'), 'danh-muc-theo-doi');
  assert.equal(slug('  Đối soát  '), 'doi-soat');
});

test('a group of screens is one tour, and the tours follow the order of the work of a unit', () => {
  const chapters = tourChapters(routes, new Map([['PRJ', 'Danh mục dự án']]));
  assert.deepEqual(chapters.map((chapter) => chapter.module), ['ADM', 'PRJ', 'CAP', 'ZZZ']);
  const project = chapters.find((chapter) => chapter.module === 'PRJ');
  assert.deepEqual(project.screens, ['PRJ-01', 'PRJ-02']);
  assert.equal(project.id, 'tour-prj-danh-muc-theo-doi');
  assert.equal(project.title, 'Danh mục dự án: Danh mục & theo dõi');
  assert.equal(chapters[0].title, 'ADM: Tổ chức & con người');
  assert.ok(MODULE_ORDER.indexOf('PRJ') < MODULE_ORDER.indexOf('CAP'));
});

test('the names of the modules come from the web screens of the catalogue', () => {
  const names = moduleNamesOf([{ platform: 'web', module: 'PRJ', moduleName: 'Danh mục dự án' }, { platform: 'mobile', module: 'MOB', moduleName: 'Điện thoại' }]);
  assert.equal(names.get('PRJ'), 'Danh mục dự án');
  assert.equal(names.has('MOB'), false);
});
