import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCALE = 'vi';

/** The shared contract files this tool owns, relative to the repository root. */
export const FILES = {
  openapi: 'Design/MACHVON_Design/03_Engineering/openapi.json',
  errorCodes: 'Design/MACHVON_Design/03_Engineering/error_codes.json',
  screens: 'Design/MACHVON_Design/03_Engineering/screen_catalog.json',
  blocks: 'db/migrations/blocks.json',
  plan: 'Design/MACHVON_Design/03_Engineering/implementation_plan.json',
  tests: 'Design/MACHVON_Design/03_Engineering/test_cases.json',
  trace: 'Design/MACHVON_Design/03_Engineering/traceability.json',
  backlog: 'Design/MACHVON_Design/03_Engineering/implementation_backlog.json',
  navigation: 'Design/MACHVON_Design/03_Engineering/navigation_architecture.json',
};
/** The command that edits each file. */
const TARGET_OF = {
  'add-operation': 'openapi',
  'add-schema': 'openapi',
  'add-error-code': 'errorCodes',
  'add-screen': 'screens',
  'register-block': 'blocks',
  'add-epic': 'plan',
  'add-feature': 'plan',
  'add-story': 'plan',
  'add-test-case': 'tests',
  'add-trace': 'trace',
  'add-backlog': 'backlog',
  'add-route': 'navigation',
  'add-nav-group': 'navigation',
};
export const COMMANDS = Object.keys(TARGET_OF);

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const SLICE_BLOCK_SIZE = 20;
const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;
const DIFF_CONTEXT = 2;
const DIFF_WINDOW = 4000;
const DIFF_KEY_LINES = 3;
const DIFF_KEY_REPEATS = 20;
const DIFF_MIN_RUN = 20;
const DIFF_CANDIDATES = 2000;

// ---------------------------------------------------------------------------------------------------------------------
// Messages and errors

const messageCache = new Map();
let activeLocale = DEFAULT_LOCALE;

function loadMessages(locale) {
  if (!messageCache.has(locale)) messageCache.set(locale, JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8')));
  return messageCache.get(locale);
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function setLocale(locale) {
  loadMessages(locale);
  activeLocale = locale;
}

/** A failure the tool reports itself: `key` is the stable, language-neutral identifier, `message` is localised. */
export class PatchError extends Error {
  constructor(key, params = {}) {
    super(format(loadMessages(activeLocale)[`contractPatch.error.${key}`] ?? key, params));
    this.name = 'PatchError';
    this.key = key;
    this.params = params;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Documents: parse, render, byte-exact round trip

/** Serialises as the repository files are written: two-space JSON, the file's own line ending, its own final newline. */
export function render(data, { eol = '\n', trailing = true } = {}) {
  let text = JSON.stringify(data, null, 2);
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  return trailing ? text + eol : text;
}

/**
 * Parses a contract file and proves it can be patched without touching a byte it did not mean to: the file must render
 * back to exactly itself (same indentation, key order, line endings, final newline). A file that does not is refused,
 * because rewriting it would reformat unrelated lines.
 */
export function parseDocument(text, file = '') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new PatchError('notJson', { file, reason: error.message });
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const style = { eol, trailing: text.endsWith(eol) };
  if (render(data, style) !== text) throw new PatchError('notCanonical', { file });
  return { data, style };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

function need(step, option) {
  if (step[option] === undefined || step[option] === '') throw new PatchError('missingOption', { option });
  return step[option];
}

function invalid(option, value) {
  return new PatchError('invalidValue', { option, value: typeof value === 'string' ? value : JSON.stringify(value) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Operation builder: the shape the neighbouring operations of openapi.json carry

const STANDARD_ERROR_RESPONSES = [
  ['400', 'Invalid request / field not allowed (DTO allowlist)'],
  ['401', 'Unauthenticated'],
  ['403', 'Forbidden / scope / self-approval / entitlement'],
  ['404', 'Not found within scope (never discloses other tenants)'],
  ['409', 'Version / state / idempotency conflict'],
  ['422', 'Domain invariant failure'],
  ['429', 'Rate limit'],
  ['503', 'Dependency unavailable'],
];
const IDEMPOTENCY_TEXT = 'tenant + actor + operationId + key; same key & same request hash → original response; different hash → 409 IDEMPOTENCY_CONFLICT';
/** Vietnamese text written into the contract lives in contract-patch.json next to this script. */
const CONTRACT_TEXT = JSON.parse(readFileSync(join(SCRIPT_DIR, 'contract-patch.json'), 'utf8'));
const READ_MODEL_REASON = CONTRACT_TEXT.readModelReason;
const COMMAND_OK = 'Command accepted; returns resource id/version/status';
const READ_OK = 'Scoped DTO; amounts as decimal strings; carries as_of';
const IF_MATCH_TEXT = 'Strong ETag of the current resource version; required for changes to versioned records.';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (name) => ({ 'application/json': { schema: ref(name) } });

function pathParameter(name, spec) {
  const schema = isRecord(spec) ? spec : { type: 'string', format: spec ?? 'uuid' };
  return { name, in: 'path', required: true, schema };
}

function queryParameter(spec) {
  const { name, type = 'string', format: fmt, required = false, description } = spec;
  if (!isNonEmptyString(name)) throw invalid('query', spec);
  const schema = fmt === undefined ? { type } : { type, format: fmt };
  const parameter = { name, in: 'query', required, schema };
  if (description !== undefined) parameter.description = description;
  return parameter;
}

/**
 * Builds a complete operation object the way the existing ones look. Reads (get) are DTO read models with the 200
 * response; every other method is a command with the Idempotency-Key header, the CommandResult 200 (or the given
 * `responseRef`), `x-error-codes`, `x-idempotency` and optional `x-domain-events`. Anything else a lane needs
 * (`x-plane`, `x-audit-action`, `x-state-guard`, `x-step-up` ...) goes in `extra` and lands after the standard keys.
 */
export function buildOperation(build, { path, method }) {
  const operationId = need(build, 'operationId');
  const summary = need(build, 'summary');
  const permission = need(build, 'permission');
  const tags = Array.isArray(build.tags) ? build.tags : [];
  if (tags.length === 0) throw new PatchError('missingOption', { option: 'tags' });
  const isRead = method === 'get';
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map((match) => pathParameter(match[1], build.pathParams?.[match[1]]));
  for (const query of build.query ?? []) parameters.push(queryParameter(query));
  if (!isRead) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 16 } });
  if (build.ifMatch === true) parameters.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' }, description: IF_MATCH_TEXT });
  if (isRead && build.responseRef === undefined) throw new PatchError('missingOption', { option: 'responseRef' });
  const success = String(build.successStatus ?? 200);
  const responses = {
    [success]: { description: build.successDescription ?? (isRead ? READ_OK : COMMAND_OK), content: jsonContent(build.responseRef ?? 'CommandResult') },
  };
  for (const [status, description] of STANDARD_ERROR_RESPONSES) {
    responses[status] = { description, content: { 'application/problem+json': { schema: ref('Problem') } } };
  }
  const errorCodes = build.errorCodes ?? ['VALIDATION_FAILED'];
  const operation = { operationId, summary, tags, 'x-permission': permission, parameters };
  if (!isRead && build.requestRef !== undefined) operation.requestBody = { required: true, content: jsonContent(build.requestRef) };
  if (isRead) {
    operation['x-read-model'] = true;
    operation['x-exposure'] = 'dto';
    operation['x-exposure-reason'] = build.exposureReason ?? READ_MODEL_REASON;
  }
  operation.responses = responses;
  operation['x-error-codes'] = errorCodes;
  if (!isRead) operation['x-idempotency'] = build.idempotency ?? IDEMPOTENCY_TEXT;
  if (Array.isArray(build.domainEvents) && build.domainEvents.length > 0) operation['x-domain-events'] = build.domainEvents;
  return { ...operation, ...(isRecord(build.extra) ? build.extra : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mutators: pure functions over parsed documents; each returns { status: 'added' | 'replaced' | 'unchanged', name }

function* operationsOf(doc) {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) if (isRecord(item?.[method])) yield { path, method, operation: item[method] };
  }
}

export function addOperation(doc, step) {
  const path = need(step, 'path');
  const method = String(need(step, 'method')).toLowerCase();
  if (!path.startsWith('/')) throw invalid('path', path);
  if (!METHODS.includes(method)) throw invalid('method', method);
  const operation = step.operation ?? buildOperation(step.build ?? {}, { path, method });
  if (!isRecord(operation)) throw invalid('operation', operation);
  for (const field of ['operationId', 'x-permission']) if (!isNonEmptyString(operation[field])) throw new PatchError('missingOption', { option: field });
  if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) throw new PatchError('missingOption', { option: 'responses' });
  if (operation.tags !== undefined && !Array.isArray(operation.tags)) throw invalid('tags', operation.tags);
  const name = `${method.toUpperCase()} ${path} (${operation.operationId})`;
  for (const other of operationsOf(doc)) {
    if (other.operation.operationId === operation.operationId && !(other.path === path && other.method === method)) {
      throw new PatchError('operationIdTaken', { operationId: operation.operationId, where: `${other.method.toUpperCase()} ${other.path}` });
    }
  }
  doc.paths ??= {};
  const existing = doc.paths[path]?.[method];
  if (existing !== undefined) {
    if (sameJson(existing, operation)) return { status: 'unchanged', name };
    if (step.replace !== true) throw new PatchError('operationExists', { name });
    doc.paths[path][method] = operation;
    return { status: 'replaced', name };
  }
  doc.paths[path] = { ...(doc.paths[path] ?? {}), [method]: operation };
  return { status: 'added', name };
}

export function addSchema(doc, step) {
  const name = need(step, 'name');
  const schema = need(step, 'schema');
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) throw invalid('name', name);
  if (!isRecord(schema)) throw invalid('schema', schema);
  doc.components ??= {};
  doc.components.schemas ??= {};
  const schemas = doc.components.schemas;
  if (Object.hasOwn(schemas, name)) {
    if (sameJson(schemas[name], schema)) return { status: 'unchanged', name };
    if (step.replace !== true) throw new PatchError('schemaExists', { name });
    schemas[name] = schema;
    return { status: 'replaced', name };
  }
  schemas[name] = schema;
  return { status: 'added', name };
}

export function addErrorCode(doc, step) {
  const code = need(step, 'code');
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw invalid('code', code);
  const status = Number(need(step, 'status'));
  if (!Number.isInteger(status) || status < 400 || status > 599) throw invalid('status', step.status);
  const en = need(step, 'en');
  const vi = need(step, 'vi');
  const module = step.module ?? (typeof step.source === 'string' && step.source.startsWith('spec:') ? step.source.slice(5) : undefined);
  if (!isNonEmptyString(module)) throw new PatchError('missingOption', { option: 'module' });
  const entry = { status, title: en, meaning: vi, module, statusBasis: step.statusBasis ?? 'spec', source: step.source ?? `spec:${module}` };
  if (step.otherStatuses !== undefined) {
    const others = (Array.isArray(step.otherStatuses) ? step.otherStatuses : String(step.otherStatuses).split(',')).map((value) => Number(value));
    if (others.length === 0 || others.some((value) => !Number.isInteger(value) || value < 400 || value > 599)) throw invalid('otherStatuses', step.otherStatuses);
    entry.otherStatuses = others;
  }
  if ([doc.canonical, doc.aliases, doc.excluded].some((table) => isRecord(table) && Object.hasOwn(table, code))) throw new PatchError('codeReserved', { code });
  doc.registry ??= {};
  const registry = doc.registry;
  if (Object.hasOwn(registry, code)) {
    if (sameJson(registry[code], entry)) return { status: 'unchanged', name: code };
    if (step.replace !== true) throw new PatchError('codeExists', { code });
    registry[code] = entry;
    return { status: 'replaced', name: code };
  }
  registry[code] = entry;
  return { status: 'added', name: code };
}

const numberOf = (id) => Number(id.slice(id.lastIndexOf('-') + 1));

export function addScreen(doc, step) {
  if (!Array.isArray(doc)) throw new PatchError('notJson', { file: FILES.screens, reason: 'array expected' });
  const module = need(step, 'module');
  if (!/^[A-Z][A-Z0-9]*$/.test(module)) throw invalid('module', module);
  const title = need(step, 'title');
  const kind = need(step, 'kind');
  if (!Array.isArray(step.fields) || step.fields.length === 0 || !step.fields.every(isNonEmptyString)) throw new PatchError('missingOption', { option: 'fields' });
  const role = need(step, 'role');
  const rule = need(step, 'rule');
  const phase = need(step, 'phase');
  if (!/^P\d$/.test(phase)) throw invalid('phase', phase);
  const platform = step.platform ?? 'web';
  const source = need(step, 'source');
  const inModule = doc.filter((screen) => screen.module === module);
  const moduleName = step.moduleName ?? inModule[0]?.moduleName;
  if (!isNonEmptyString(moduleName)) throw new PatchError('missingOption', { option: 'moduleName' });
  const sameTitle = inModule.find((screen) => screen.title === title);
  const wantedId = step.id ?? sameTitle?.id;
  if (wantedId !== undefined && !new RegExp(`^${module}-\\d{2,}$`).test(wantedId)) throw invalid('id', wantedId);
  const byId = wantedId === undefined ? undefined : doc.find((screen) => screen.id === wantedId);
  if (byId !== undefined && byId.title !== title) throw new PatchError('screenIdTaken', { id: wantedId, title: byId.title });
  const build = (id) => ({ id, module, moduleName, title, kind, fields: step.fields, role, rule, phase, platform, req: step.req ?? `FR-${id}`, source });
  if (byId !== undefined) {
    const entry = build(wantedId);
    if (sameJson(byId, entry)) return { status: 'unchanged', name: wantedId };
    if (step.replace !== true) throw new PatchError('screenExists', { id: wantedId, title });
    doc[doc.indexOf(byId)] = entry;
    return { status: 'replaced', name: wantedId };
  }
  const next = wantedId ?? `${module}-${String(Math.max(0, ...inModule.map((screen) => numberOf(screen.id))) + 1).padStart(2, '0')}`;
  doc.push(build(next));
  return { status: 'added', name: next };
}

export function registerBlock(doc, step) {
  const slice = need(step, 'slice');
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(slice)) throw invalid('slice', slice);
  if (!Array.isArray(doc.slices) || !isRecord(doc.platform)) throw new PatchError('notJson', { file: FILES.blocks, reason: 'platform and slices expected' });
  const existing = doc.slices.find((entry) => entry.slice === slice);
  const from = step.from === undefined ? undefined : Number(step.from);
  if (from !== undefined && !Number.isInteger(from)) throw invalid('from', step.from);
  if (existing !== undefined) {
    if (from === undefined || from === existing.from) return { status: 'unchanged', name: slice };
    throw new PatchError('blockMoved', { slice, from: existing.from, to: existing.to });
  }
  if (from === undefined) throw new PatchError('missingOption', { option: 'from' });
  const to = from + SLICE_BLOCK_SIZE - 1;
  const ranges = [{ name: 'platform', from: doc.platform.from, to: doc.platform.to }, ...doc.slices.map((entry) => ({ name: entry.slice, from: entry.from, to: entry.to }))];
  const clash = ranges.find((range) => range.from <= to && from <= range.to);
  if (clash !== undefined) {
    const free = Math.max(...ranges.map((range) => range.to)) + 1;
    throw new PatchError('blockOverlap', { slice, from, to, other: clash.name, otherFrom: clash.from, otherTo: clash.to, free });
  }
  doc.slices.push({ slice, from, to });
  return { status: 'added', name: slice };
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry records: plan, test cases, traceability, backlog and navigation (the design package of 03_Engineering)

/**
 * Appends `record` to `list` (or leaves it, or replaces it) keyed by `record[key]`. An existing record with the same key and
 * the same content is `unchanged`; with other content it is an error until the step says `replace`.
 */
function upsertRecord(list, key, record, step, kind) {
  const name = String(record[key]);
  const at = list.findIndex((entry) => entry[key] === record[key]);
  if (at < 0) {
    list.push(record);
    return { status: 'added', name };
  }
  if (sameJson(list[at], record)) return { status: 'unchanged', name };
  if (step.replace !== true) throw new PatchError('recordExists', { kind, name });
  list[at] = record;
  return { status: 'replaced', name };
}

/** The object a step carries under `field`, with every name of `required` present and non-empty. */
function recordOf(step, field, required) {
  const record = need(step, field);
  if (!isRecord(record)) throw invalid(field, record);
  for (const name of required) {
    if (record[name] === undefined || record[name] === null || record[name] === '') throw new PatchError('missingOption', { option: `${field}.${name}` });
  }
  return record;
}

function listOf(doc, collection, file) {
  if (!isRecord(doc) || !Array.isArray(doc[collection])) throw new PatchError('notJson', { file, reason: `${collection} expected` });
  return doc[collection];
}

function arrayOf(doc, file) {
  if (!Array.isArray(doc)) throw new PatchError('notJson', { file, reason: 'array expected' });
  return doc;
}

function idShape(record, pattern, option) {
  if (!pattern.test(record.id)) throw invalid(option, record.id);
}

function knownRef(list, id, what, name) {
  if (!list.some((entry) => entry.id === id)) throw new PatchError('refUnknown', { name, what, value: id });
}

export function addEpic(doc, step) {
  const epic = recordOf(step, 'epic', ['id', 'module', 'title', 'goal']);
  idShape(epic, /^EP-[A-Z][A-Z0-9]*$/, 'epic.id');
  return upsertRecord(listOf(doc, 'epics', FILES.plan), 'id', epic, step, 'epic');
}

export function addFeature(doc, step) {
  const feature = recordOf(step, 'feature', ['id', 'epic', 'title']);
  idShape(feature, /^FT-[A-Z][A-Z0-9]*-\d+$/, 'feature.id');
  knownRef(listOf(doc, 'epics', FILES.plan), feature.epic, 'epic', feature.id);
  return upsertRecord(listOf(doc, 'features', FILES.plan), 'id', feature, step, 'feature');
}

export function addStory(doc, step) {
  const story = recordOf(step, 'story', ['id', 'epic', 'feature', 'module', 'title', 'narrative', 'release', 'screens', 'operations', 'acceptance', 'review', 'effort', 'tasks']);
  idShape(story, /^ST-[A-Z][A-Z0-9]*-\d+$/, 'story.id');
  if (!Array.isArray(story.acceptance) || !Array.isArray(story.tasks)) throw invalid('story', story.id);
  knownRef(listOf(doc, 'epics', FILES.plan), story.epic, 'epic', story.id);
  const feature = listOf(doc, 'features', FILES.plan).find((entry) => entry.id === story.feature);
  if (feature === undefined || feature.epic !== story.epic) throw new PatchError('refUnknown', { name: story.id, what: `feature of ${story.epic}`, value: story.feature });
  return upsertRecord(listOf(doc, 'stories', FILES.plan), 'id', story, step, 'story');
}

export function addTestCase(doc, step) {
  const test = recordOf(step, 'test', ['id', 'type', 'priority', 'setup', 'steps', 'expected']);
  if (!Array.isArray(test.steps) || test.steps.length === 0) throw invalid('test.steps', test.steps);
  return upsertRecord(arrayOf(doc, FILES.tests), 'id', test, step, 'test case');
}

export function addTrace(doc, step) {
  const row = recordOf(step, 'trace', ['requirement', 'screen', 'title', 'backlog_id', 'test_ids']);
  if (!Array.isArray(row.test_ids)) throw invalid('trace.test_ids', row.test_ids);
  return upsertRecord(arrayOf(doc, FILES.trace), 'requirement', row, step, 'traceability row');
}

export function addBacklog(doc, step) {
  const row = recordOf(step, 'backlog', ['id', 'requirement', 'screen', 'title', 'module', 'platform', 'test_ids']);
  if (!Array.isArray(row.test_ids)) throw invalid('backlog.test_ids', row.test_ids);
  return upsertRecord(arrayOf(doc, FILES.backlog), 'id', row, step, 'backlog row');
}

const ROUTE_LISTS = { web: 'webRoutes', mobile: 'mobileRoutes' };

/** Keeps the counters of `coverage` equal to what the file holds (the routes are the catalogue: every catalogued screen has one). */
function refreshCoverage(doc) {
  if (!isRecord(doc.coverage)) return;
  const web = doc.webRoutes ?? [];
  const mobile = doc.mobileRoutes ?? [];
  Object.assign(doc.coverage, {
    webRoutes: web.length,
    webCatalog: web.length,
    webModules: new Set(web.map((route) => route.module)).size,
    mobileRoutes: mobile.length,
    mobileCatalog: mobile.length,
    modulesTotal: Object.keys(doc.modules ?? {}).length,
  });
}

/** A route goes after the last route of its own module (the file keeps a module's routes together), or at the end of the list. */
export function addRoute(doc, step) {
  const platform = need(step, 'platform');
  if (!Object.hasOwn(ROUTE_LISTS, platform)) throw invalid('platform', platform);
  const route = recordOf(step, 'route', ['id', 'title', 'kind']);
  const list = doc[ROUTE_LISTS[platform]];
  if (!Array.isArray(list)) throw new PatchError('notJson', { file: FILES.navigation, reason: `${ROUTE_LISTS[platform]} expected` });
  const at = list.findIndex((entry) => entry.id === route.id);
  const name = route.id;
  if (at >= 0) {
    if (sameJson(list[at], route)) return { status: 'unchanged', name };
    if (step.replace !== true) throw new PatchError('recordExists', { kind: 'route', name });
    list[at] = route;
    return { status: 'replaced', name };
  }
  const sameModule = list.map((entry, index) => (entry.module === route.module ? index : -1)).filter((index) => index >= 0);
  const position = route.module === undefined || sameModule.length === 0 ? list.length : sameModule.at(-1) + 1;
  list.splice(position, 0, route);
  refreshCoverage(doc);
  return { status: 'added', name };
}

const unique = (values) => [...new Set(values)];

/**
 * Adds the screens of a task group to a module of the navigation: the group is created when its title is new, otherwise the
 * ids, the primary ids and the parents are merged into it. `shortcuts` ([number, label]) join the contextual shortcuts of the module.
 */
export function addNavGroup(doc, step) {
  const module = need(step, 'module');
  const group = recordOf(step, 'group', ['title', 'ids']);
  const target = doc.modules?.[module];
  if (!isRecord(target) || !Array.isArray(target.groups)) throw new PatchError('refUnknown', { name: group.title, what: 'navigation module', value: module });
  const wanted = { title: group.title, description: group.description, ids: group.ids, primary: group.primary ?? group.ids, parents: group.parents ?? {} };
  const before = JSON.stringify([target, doc.contextualShortcuts?.[module]]);
  const existing = target.groups.find((entry) => entry.title === group.title);
  if (existing === undefined) {
    if (!isNonEmptyString(wanted.description)) throw new PatchError('missingOption', { option: 'group.description' });
    target.groups.push(wanted);
  } else {
    existing.ids = unique([...existing.ids, ...wanted.ids]);
    existing.primary = unique([...existing.primary, ...wanted.primary]);
    existing.parents = { ...existing.parents, ...wanted.parents };
  }
  if (Array.isArray(step.shortcuts)) {
    doc.contextualShortcuts ??= {};
    const shortcuts = (doc.contextualShortcuts[module] ??= []);
    for (const shortcut of step.shortcuts) if (!shortcuts.some((entry) => entry[0] === shortcut[0])) shortcuts.push(shortcut);
  }
  if (before === JSON.stringify([target, doc.contextualShortcuts?.[module]])) return { status: 'unchanged', name: group.title };
  return { status: existing === undefined ? 'added' : 'replaced', name: group.title };
}

const MUTATORS = {
  'add-operation': addOperation,
  'add-schema': addSchema,
  'add-error-code': addErrorCode,
  'add-screen': addScreen,
  'register-block': registerBlock,
  'add-epic': addEpic,
  'add-feature': addFeature,
  'add-story': addStory,
  'add-test-case': addTestCase,
  'add-trace': addTrace,
  'add-backlog': addBacklog,
  'add-route': addRoute,
  'add-nav-group': addNavGroup,
};
const KINDS = {
  'add-operation': 'operation',
  'add-schema': 'schema',
  'add-error-code': 'error code',
  'add-screen': 'screen',
  'register-block': 'block',
  'add-epic': 'epic',
  'add-feature': 'feature',
  'add-story': 'story',
  'add-test-case': 'test case',
  'add-trace': 'traceability row',
  'add-backlog': 'backlog row',
  'add-route': 'route',
  'add-nav-group': 'navigation group',
};

// ---------------------------------------------------------------------------------------------------------------------
// Cross-checks on the patched documents

function* refsIn(node) {
  if (Array.isArray(node)) for (const child of node) yield* refsIn(child);
  else if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') yield value;
      else yield* refsIn(value);
    }
  }
}

/** Every schema reference of an added or replaced operation or schema resolves, and every error code is registered. */
function verifyReferences(steps, results, docs, registryOf) {
  const openapi = docs.openapi?.data;
  if (openapi === undefined) return;
  const registry = registryOf();
  steps.forEach((step, index) => {
    if (results[index].status === 'unchanged') return;
    let node;
    if (step.command === 'add-operation') node = openapi.paths[step.path][String(step.method).toLowerCase()];
    else if (step.command === 'add-schema') node = openapi.components.schemas[step.name];
    else return;
    for (const target of refsIn(node)) {
      const match = SCHEMA_REF.exec(target);
      if (match === null || !Object.hasOwn(openapi.components?.schemas ?? {}, match[1])) throw new PatchError('refMissing', { ref: target, name: results[index].name });
    }
    if (step.command === 'add-operation' && registry !== undefined) {
      for (const code of Array.isArray(node['x-error-codes']) ? node['x-error-codes'] : []) {
        if (!registry.has(code)) throw new PatchError('errorCodeUnknown', { code, name: results[index].name });
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Locking and atomic writes

const heldLocks = new Set();
process.on('exit', () => {
  for (const lock of heldLocks) rmSync(lock.path, { force: true });
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function holderAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockIsStale(path, staleMs) {
  try {
    if (Date.now() - statSync(path).mtimeMs > staleMs) return true;
    const holder = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(holder.pid) && !holderAlive(holder.pid);
  } catch {
    // The lock file vanished or is mid-write: let the next attempt decide.
    return false;
  }
}

/** Creates `<file>.lock` exclusively; waits for another holder, reclaims a lock whose holder died or that is too old. */
async function acquireLock(file, { timeoutMs = 20000, staleMs = 30000, pollMs = 20 } = {}) {
  const path = `${file}.lock`;
  const token = randomBytes(8).toString('hex');
  const startedAt = Date.now();
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, token, at: startedAt }));
      closeSync(fd);
      const lock = { path, token };
      heldLocks.add(lock);
      return lock;
    } catch (error) {
      // Windows answers EPERM/EACCES instead of EEXIST while another process is deleting the lock file: that is contention too.
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    }
    if (lockIsStale(path, staleMs)) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Somebody else is removing it at the same moment; the next attempt sorts it out.
      }
      continue;
    }
    if (Date.now() - startedAt > timeoutMs) throw new PatchError('lockTimeout', { file, seconds: Math.round((Date.now() - startedAt) / 1000) });
    await sleep(pollMs);
  }
}

function releaseLock(lock) {
  heldLocks.delete(lock);
  try {
    // Only the lock this call created: after a stale reclaim the file may belong to the next holder.
    if (JSON.parse(readFileSync(lock.path, 'utf8')).token === lock.token) rmSync(lock.path, { force: true });
  } catch {
    // Already gone.
  }
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      // Windows refuses a rename onto a file another process has open for a moment (an editor, a scanner).
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 40) throw error;
      await sleep(25);
    }
  }
}

/** Writes beside the target, re-parses what reached the disk, then renames over the target in one step. */
async function writeAtomically(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text);
    const written = readFileSync(temp, 'utf8');
    try {
      JSON.parse(written);
    } catch (error) {
      throw new PatchError('verifyFailed', { file, reason: error.message });
    }
    if (written !== text) throw new PatchError('verifyFailed', { file, reason: 'the written bytes differ from the rendered text' });
    await renameWithRetry(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Diff for --dry-run

/** A unified diff of two texts that finds each changed region by re-synchronising on the next common lines. */
export function unifiedDiff(before, after, label = 'file') {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const sentinel = Array.from({ length: DIFF_KEY_LINES }, () => '\u0000end');
  const a2 = [...a, ...sentinel];
  const b2 = [...b, ...sentinel];
  const keyAt = (lines, at) => lines.slice(at, at + DIFF_KEY_LINES).join('\n');
  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    // Candidate re-synchronisation points: where the next DIFF_KEY_LINES lines of a and b are equal again. Repeated
    // content (the same response blocks over and over) makes the cheapest candidate wrong, so a candidate counts only
    // when the lines keep agreeing for DIFF_MIN_RUN lines; with none like that the cheapest one is taken.
    const wanted = new Map();
    for (let dj = 0; dj <= DIFF_WINDOW && j + dj <= b.length; dj += 1) {
      const key = keyAt(b2, j + dj);
      const at = wanted.get(key);
      if (at === undefined) wanted.set(key, [dj]);
      else if (at.length < DIFF_KEY_REPEATS) at.push(dj);
    }
    const candidates = [];
    for (let di = 0; di <= DIFF_WINDOW && i + di <= a.length; di += 1) {
      for (const dj of wanted.get(keyAt(a2, i + di)) ?? []) candidates.push({ di, dj });
    }
    candidates.sort((x, y) => x.di + x.dj - (y.di + y.dj));
    const runAt = ({ di, dj }) => {
      let run = 0;
      while (a2[i + di + run] !== undefined && a2[i + di + run] === b2[j + dj + run]) run += 1;
      return run;
    };
    let best = candidates[0] ?? { di: a.length - i, dj: b.length - j };
    for (const candidate of candidates.slice(0, DIFF_CANDIDATES)) {
      if (runAt(candidate) >= DIFF_MIN_RUN) {
        best = candidate;
        break;
      }
    }
    hunks.push({ aFrom: i, aTo: i + best.di, bFrom: j, bTo: j + best.dj });
    i += best.di;
    j += best.dj;
  }
  const groups = [];
  for (const hunk of hunks) {
    const last = groups.at(-1);
    if (last !== undefined && hunk.aFrom - last.at(-1).aTo <= DIFF_CONTEXT * 2) last.push(hunk);
    else groups.push([hunk]);
  }
  const out = [`--- ${label}`, `+++ ${label}`];
  for (const group of groups) {
    const aStart = Math.max(0, group[0].aFrom - DIFF_CONTEXT);
    const aEnd = Math.min(a.length, group.at(-1).aTo + DIFF_CONTEXT);
    const bStart = group[0].bFrom - (group[0].aFrom - aStart);
    const lines = [];
    let at = aStart;
    let bAt = bStart;
    for (const hunk of group) {
      for (; at < hunk.aFrom; at += 1, bAt += 1) lines.push(` ${a[at]}`);
      for (let k = hunk.aFrom; k < hunk.aTo; k += 1) lines.push(`-${a[k]}`);
      for (let k = hunk.bFrom; k < hunk.bTo; k += 1) lines.push(`+${b[k]}`);
      at = hunk.aTo;
      bAt = hunk.bTo;
    }
    for (; at < aEnd; at += 1, bAt += 1) lines.push(` ${a[at]}`);
    out.push(`@@ -${aStart + 1},${aEnd - aStart} +${bStart + 1},${bAt - bStart} @@`, ...lines);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan runner

function readDocument(path, file) {
  if (!existsSync(path)) throw new PatchError('notJson', { file, reason: 'file not found' });
  const text = readFileSync(path, 'utf8');
  return { text, ...parseDocument(text, file) };
}

/**
 * Applies steps to the shared files. All the files a plan touches are locked (in a fixed order), re-read inside the
 * lock, patched in memory, cross-checked and rendered; only then is anything written, so a failing step leaves every
 * file as it was. A file whose rendered text equals its current text is not written at all (idempotent).
 */
export async function applySteps(steps, { root = REPO_ROOT, dryRun = false, replace = false, lockOptions } = {}) {
  for (const step of steps) {
    if (!Object.hasOwn(TARGET_OF, step.command)) throw new PatchError('unknownCommand', { command: step.command });
  }
  const targets = [...new Set(steps.map((step) => TARGET_OF[step.command]))].sort((x, y) => (FILES[x] < FILES[y] ? -1 : 1));
  const paths = Object.fromEntries(targets.map((target) => [target, resolve(root, FILES[target])]));
  const locks = [];
  try {
    if (!dryRun) for (const target of targets) locks.push(await acquireLock(paths[target], lockOptions));
    const docs = Object.fromEntries(targets.map((target) => [target, readDocument(paths[target], FILES[target])]));
    const results = steps.map((step) => {
      const effective = replace && step.replace === undefined ? { ...step, replace: true } : step;
      const result = MUTATORS[step.command](docs[TARGET_OF[step.command]].data, effective);
      return { ...result, command: step.command, kind: KINDS[step.command], file: FILES[TARGET_OF[step.command]] };
    });
    verifyReferences(steps, results, docs, () => {
      const registry = docs.errorCodes?.data ?? (existsSync(resolve(root, FILES.errorCodes)) ? readDocument(resolve(root, FILES.errorCodes), FILES.errorCodes).data : undefined);
      return registry === undefined ? undefined : new Set([...Object.keys(registry.canonical ?? {}), ...Object.keys(registry.registry ?? {})]);
    });
    const changes = [];
    for (const target of targets) {
      const { text, data, style } = docs[target];
      const next = render(data, style);
      if (next === text) continue;
      try {
        if (render(JSON.parse(next), style) !== next) throw new Error('re-rendering the parsed text gives different text');
      } catch (error) {
        throw new PatchError('verifyFailed', { file: FILES[target], reason: error.message });
      }
      changes.push({ target, file: FILES[target], path: paths[target], before: text, after: next });
    }
    if (!dryRun) for (const change of changes) await writeAtomically(change.path, change.after);
    return { results, changed: changes.map((change) => change.file), diffs: changes.map((change) => unifiedDiff(change.before, change.after, change.file)), written: !dryRun };
  } finally {
    for (const lock of locks) releaseLock(lock);
  }
}

/** Reports whether each shared file is a byte-exact round trip (patchable without reformatting). */
export function checkFiles(root = REPO_ROOT) {
  return Object.values(FILES).map((file) => {
    try {
      readDocument(resolve(root, file), file);
      return { file, ok: true };
    } catch (error) {
      return { file, ok: false, error };
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line

const OPTIONS = {
  root: { type: 'string' },
  locale: { type: 'string', default: DEFAULT_LOCALE },
  spec: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  replace: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  // add-operation
  path: { type: 'string' },
  method: { type: 'string' },
  'operation-file': { type: 'string' },
  'operation-id': { type: 'string' },
  summary: { type: 'string' },
  tags: { type: 'string' },
  permission: { type: 'string' },
  'request-ref': { type: 'string' },
  'response-ref': { type: 'string' },
  'success-status': { type: 'string' },
  'error-codes': { type: 'string' },
  'domain-events': { type: 'string' },
  'if-match': { type: 'boolean', default: false },
  'path-param': { type: 'string', multiple: true },
  query: { type: 'string', multiple: true },
  extra: { type: 'string' },
  // add-schema
  name: { type: 'string' },
  'schema-file': { type: 'string' },
  schema: { type: 'string' },
  // add-error-code
  code: { type: 'string' },
  status: { type: 'string' },
  vi: { type: 'string' },
  en: { type: 'string' },
  module: { type: 'string' },
  source: { type: 'string' },
  'status-basis': { type: 'string' },
  'other-statuses': { type: 'string' },
  // add-screen
  id: { type: 'string' },
  'module-name': { type: 'string' },
  title: { type: 'string' },
  kind: { type: 'string' },
  fields: { type: 'string' },
  role: { type: 'string' },
  rule: { type: 'string' },
  phase: { type: 'string' },
  platform: { type: 'string' },
  req: { type: 'string' },
  // register-block
  slice: { type: 'string' },
  // registry commands: the JSON record of the step
  'record-file': { type: 'string' },
  from: { type: 'string' },
};

const list = (value, separator = ',') => (value === undefined ? undefined : value.split(separator).map((item) => item.trim()).filter((item) => item !== ''));
const readJsonFile = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));

function parseJsonOption(option, value) {
  try {
    return JSON.parse(value);
  } catch {
    throw invalid(option, value);
  }
}

function parseQuery(value) {
  const [name, ...rest] = value.split(':');
  const required = rest.includes('required');
  const [type, format] = rest.filter((part) => part !== 'required');
  return { name, ...(type === undefined ? {} : { type }), ...(format === undefined ? {} : { format }), required };
}

function parsePathParam(value) {
  const [name, format] = value.split(':');
  return [name, format];
}

/** The step field that holds the JSON record of each registry command (read from --record-file). */
const RECORD_FIELD = { 'add-epic': 'epic', 'add-feature': 'feature', 'add-story': 'story', 'add-test-case': 'test', 'add-trace': 'trace', 'add-backlog': 'backlog', 'add-route': 'route', 'add-nav-group': 'group' };

/** The step a command line stands for; the same object a `--spec` file lists. */
export function stepFromOptions(command, values) {
  const step = { command };
  const copy = (key, option = key) => {
    if (values[option] !== undefined) step[key] = values[option];
  };
  if (values.replace) step.replace = true;
  if (command === 'add-operation') {
    copy('path');
    copy('method');
    if (values['operation-file'] !== undefined) step.operation = readJsonFile(values['operation-file']);
    else {
      step.build = {
        operationId: values['operation-id'],
        summary: values.summary,
        tags: list(values.tags),
        permission: values.permission,
        requestRef: values['request-ref'],
        responseRef: values['response-ref'],
        successStatus: values['success-status'],
        errorCodes: list(values['error-codes']),
        domainEvents: list(values['domain-events']),
        ifMatch: values['if-match'],
        pathParams: Object.fromEntries((values['path-param'] ?? []).map(parsePathParam)),
        query: (values.query ?? []).map(parseQuery),
        extra: values.extra === undefined ? undefined : parseJsonOption('extra', values.extra),
      };
    }
  } else if (command === 'add-schema') {
    copy('name');
    if (values['schema-file'] !== undefined) step.schema = readJsonFile(values['schema-file']);
    else if (values.schema !== undefined) step.schema = parseJsonOption('schema', values.schema);
  } else if (command === 'add-error-code') {
    for (const key of ['code', 'status', 'vi', 'en', 'module', 'source']) copy(key);
    copy('statusBasis', 'status-basis');
    copy('otherStatuses', 'other-statuses');
  } else if (command === 'add-screen') {
    for (const key of ['id', 'module', 'title', 'kind', 'role', 'rule', 'phase', 'platform', 'req', 'source']) copy(key);
    copy('moduleName', 'module-name');
    if (values.fields !== undefined) step.fields = list(values.fields, ';');
  } else if (Object.hasOwn(RECORD_FIELD, command)) {
    step[RECORD_FIELD[command]] = readJsonFile(need(values, 'record-file'));
    copy('platform');
    copy('module');
  } else if (command === 'register-block') {
    copy('slice');
    copy('from');
  }
  return step;
}

function stepsFromSpec(file) {
  const spec = readJsonFile(file);
  const steps = Array.isArray(spec) ? spec : spec?.steps;
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every(isRecord)) throw new PatchError('specInvalid', { file });
  return steps;
}

export async function main(argv, { log = console.log, error = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (cause) {
    error(cause.message);
    return 2;
  }
  const { values, positionals } = parsed;
  try {
    setLocale(values.locale);
  } catch {
    error(`unknown locale: ${values.locale}`);
    return 2;
  }
  const messages = loadMessages(activeLocale);
  const command = positionals[0];
  if (values.help || command === undefined) {
    log(format(messages['contractPatch.usage'], { commands: [...COMMANDS, 'apply', 'check'].join('|') }));
    return values.help ? 0 : 2;
  }
  const root = resolve(values.root ?? REPO_ROOT);
  try {
    if (command === 'check') {
      const reports = checkFiles(root);
      for (const report of reports) log(report.ok ? format(messages['contractPatch.check.ok'], { file: report.file }) : format(messages['contractPatch.check.fail'], { file: report.file, reason: report.error.message }));
      return reports.every((report) => report.ok) ? 0 : 1;
    }
    let steps;
    if (command === 'apply' || values.spec !== undefined) {
      if (command !== 'apply' && !COMMANDS.includes(command)) throw new PatchError('unknownCommand', { command });
      steps = stepsFromSpec(need(values, 'spec'));
    } else {
      if (!COMMANDS.includes(command)) throw new PatchError('unknownCommand', { command });
      steps = [stepFromOptions(command, values)];
    }
    const outcome = await applySteps(steps, { root, dryRun: values['dry-run'], replace: values.replace });
    for (const result of outcome.results) log(format(messages[`contractPatch.result.${result.status}`], { kind: result.kind, name: result.name }));
    if (values['dry-run']) for (const diff of outcome.diffs) log(diff);
    log(format(messages[values['dry-run'] ? 'contractPatch.summary.dryRun' : 'contractPatch.summary.written'], { changed: outcome.changed.length, files: outcome.changed.join(', ') }));
    return 0;
  } catch (cause) {
    if (!(cause instanceof PatchError) && !(cause instanceof SyntaxError) && cause?.code !== 'ENOENT') throw cause;
    error(cause.message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
