import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainRole, plainRule } from './hdsd/narration.mjs';

/**
 * The on-screen help (DOC-3, YCK.08). `generate` builds apps/web/src/help/help.vi.json, one entry per web screen, from
 *   - the route table of the web app (which screens exist),
 *   - the screen catalogue of the design (purpose, role, fields, rule),
 *   - the hdsd tours (the chapter of the guide that shows the screen),
 *   - scripts/help/kind-guides.json (the generic steps of each kind of screen and the tips every screen shares).
 * `check` fails when the committed file differs from what `generate` would write, when a screen has neither an entry nor a reason
 * in scripts/help/no-help.json, or when a reason names an id that is not a web screen or is empty. All Vietnamese words live in JSON; this file holds none.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const OUTPUT = join('apps', 'web', 'src', 'help', 'help.vi.json');
const ROUTES = join('apps', 'web', 'src', 'routes', 'routes.generated.json');
const CATALOGUE = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');
const GUIDES = join('scripts', 'help', 'kind-guides.json');
const NO_HELP = join('scripts', 'help', 'no-help.json');
const NARRATION = join('scripts', 'hdsd', 'narration.json');
const FLOWS = join('scripts', 'hdsd', 'flows');
const CHAPTERS = join('scripts', 'hdsd', 'chapters.json');
export const SCHEMA = 1;

const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const fill = (template, params) =>
  template.replace(/\{(\w+)\}/gu, (_, key) => {
    if (!(key in params)) throw new Error(`no value for the placeholder {${key}}`);
    return String(params[key]);
  });
const sentence = (text) => {
  const trimmed = String(text).trim().replace(/[.;,\s]+$/u, '');
  return trimmed === '' ? '' : `${trimmed}.`;
};

/** The first chapter of the guide whose steps show each screen, in the order of chapters.json. */
export function chapterOfScreens(root) {
  const order = readJson(root, CHAPTERS).map((chapter) => chapter.id);
  const found = new Map();
  for (const id of order) {
    const file = join(root, FLOWS, `${id}.json`);
    if (!existsSync(file)) continue;
    const flow = JSON.parse(readFileSync(file, 'utf8'));
    for (const step of flow.steps ?? []) {
      for (const screen of step.screens ?? []) {
        if (!found.has(screen)) found.set(screen, { id: flow.id, title: flow.title, step: step.id });
      }
    }
  }
  return found;
}

/** The fields of the design without the qualifier in brackets, each once. */
function plainFields(fields) {
  const seen = new Set();
  const out = [];
  for (const field of fields ?? []) {
    const name = String(field).replace(/\s*\(.*?\)/gu, '').trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** The help index as an object (no file is written). */
export function buildIndex(root = REPO_ROOT) {
  const routes = readJson(root, ROUTES).routes;
  const catalogue = new Map(readJson(root, CATALOGUE).map((screen) => [screen.id, screen]));
  const guides = readJson(root, GUIDES);
  const narration = readJson(root, NARRATION);
  const noHelp = readJson(root, NO_HELP).reasons ?? {};
  const chapters = chapterOfScreens(root);
  const nouns = { ...narration.kindNoun, ...guides.kindNoun };

  const kinds = {};
  const screens = {};
  for (const route of routes) {
    if (Object.hasOwn(noHelp, route.id)) continue;
    const design = catalogue.get(route.id);
    if (design === undefined) continue;
    const kind = design.kind ?? route.kind;
    if (kinds[kind] === undefined) kinds[kind] = { noun: nouns[kind] ?? narration.defaultKindNoun, steps: guides.kinds[kind]?.steps ?? guides.default.steps };
    const role = plainRole(design.role);
    const rule = plainRule(design.rule);
    const entry = {
      title: route.title,
      module: route.module,
      moduleName: design.moduleName,
      kind,
      purpose: sentence(fill(guides.text.isA, { noun: kinds[kind].noun })),
      audience: role === '' ? guides.text.unknownRole : role,
      fields: plainFields(design.fields),
      req: design.req,
    };
    if (rule !== '') entry.rule = rule;
    const chapter = chapters.get(route.id);
    if (chapter !== undefined) entry.chapter = chapter;
    screens[route.id] = entry;
  }
  return { schema: SCHEMA, locale: 'vi', tips: guides.common.tips, kinds, screens };
}

export const render = (index) => `${JSON.stringify(index, null, 2)}\n`;

/** Writes the index and returns the number of screens. */
export function generate(root = REPO_ROOT) {
  const index = buildIndex(root);
  const target = join(root, OUTPUT);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, render(index));
  return Object.keys(index.screens).length;
}

const normalise = (text) => text.replace(/\r\n/gu, '\n');

/** The problems of the committed index; an empty list means it is current and every web screen has a guide or a reason. */
export function check(root = REPO_ROOT) {
  const problems = [];
  const routes = readJson(root, ROUTES).routes;
  const noHelp = readJson(root, NO_HELP).reasons ?? {};
  const ids = new Set(routes.map((route) => route.id));
  const target = join(root, OUTPUT);
  if (!existsSync(target)) return [`${OUTPUT} is missing: run node scripts/help-index.mjs generate`];
  const committed = normalise(readFileSync(target, 'utf8'));
  const index = buildIndex(root);
  if (committed !== normalise(render(index))) problems.push(`${OUTPUT} is out of date: run node scripts/help-index.mjs generate`);
  for (const id of ids) {
    if (index.screens[id] === undefined && !Object.hasOwn(noHelp, id)) problems.push(`${id}: no help entry and no reason in scripts/help/no-help.json`);
  }
  for (const [id, reason] of Object.entries(noHelp)) {
    if (!ids.has(id)) problems.push(`${id}: no-help reason for a screen that is not in the route table`);
    else if (typeof reason !== 'string' || reason.trim() === '') problems.push(`${id}: the no-help reason is empty`);
  }
  for (const [id, entry] of Object.entries(index.screens)) {
    for (const key of ['title', 'purpose', 'audience']) if (typeof entry[key] !== 'string' || entry[key] === '') problems.push(`${id}: ${key} is empty`);
    if (!Array.isArray(entry.fields) || entry.fields.length === 0) problems.push(`${id}: no fields`);
    if (index.kinds[entry.kind] === undefined || index.kinds[entry.kind].steps.length === 0) problems.push(`${id}: no steps for the kind ${entry.kind}`);
  }
  return problems;
}


if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mode = process.argv[2];
  if (mode === 'generate') {
    console.log(`help index written: ${generate()} screens`);
  } else if (mode === 'check') {
    const problems = check();
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(`help index is current: ${Object.keys(buildIndex().screens).length} screens covered`);
  } else {
    console.error('usage: node scripts/help-index.mjs generate|check');
    process.exit(2);
  }
}
