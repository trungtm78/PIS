import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib.mjs';
import { fold } from './narration.mjs';

const ROUTES = join('apps', 'web', 'src', 'routes', 'routes.generated.json');
const CATALOGUE = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');

/** The modules in the order of the work of a unit: its own people and catalogues, then the projects and their money, contracts, reports, payments, the field, the paperwork, and last what leaders and the platform watch. */
export const MODULE_ORDER = ['IAM', 'ADM', 'MDM', 'SAS', 'PRJ', 'CAP', 'BID', 'CTR', 'DIS', 'MNE', 'PAY', 'ISS', 'QMS', 'LND', 'AST', 'PMT', 'DOC', 'AUD', 'NOT', 'OMNI', 'BI', 'HOME', 'DGV', 'LLM'];

export const slug = (text) => fold(text).replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');

/** One tour for each group of screens of the route table, in the order of the work. */
export function tourChapters(routes, moduleNames = new Map()) {
  const groups = new Map();
  for (const route of routes) {
    const key = `${route.module}|${route.group}`;
    const group = groups.get(key) ?? { module: route.module, group: route.group, screens: [] };
    group.screens.push(route.id);
    groups.set(key, group);
  }
  const rank = (module) => {
    const at = MODULE_ORDER.indexOf(module);
    return at < 0 ? MODULE_ORDER.length : at;
  };
  return [...groups.values()]
    .map((group, index) => ({ ...group, index }))
    .sort((left, right) => rank(left.module) - rank(right.module) || left.index - right.index)
    .map(({ module, group, screens }) => ({
      id: `tour-${module.toLowerCase()}-${slug(group)}`,
      kind: 'tour',
      module,
      group,
      title: `${moduleNames.get(module) ?? module}: ${group}`,
      screens,
    }));
}

/** The module names of the catalogue, by module code. */
export function moduleNamesOf(catalogue) {
  return new Map(catalogue.filter((screen) => screen.platform === 'web').map((screen) => [screen.module, screen.moduleName]));
}

export function loadChapters(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, 'scripts', 'hdsd', 'chapters.json'), 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv.includes('--write')) {
  const routes = JSON.parse(readFileSync(join(REPO_ROOT, ROUTES), 'utf8')).routes;
  const names = moduleNamesOf(JSON.parse(readFileSync(join(REPO_ROOT, CATALOGUE), 'utf8')));
  const chapters = [{ id: '01-dang-nhap', kind: 'flow' }, ...tourChapters(routes, names)];
  writeFileSync(join(REPO_ROOT, 'scripts', 'hdsd', 'chapters.json'), `${JSON.stringify(chapters, null, 2)}\n`);
  console.log(`${chapters.length} chapters written`);
}
