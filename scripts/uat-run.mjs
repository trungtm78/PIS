import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ENGINEERING = join('Design', 'MACHVON_Design', '03_Engineering');
const DEFAULT_LOCALE = 'vi';
/** The files whose bytes make the dataset of the run: the fixtures of the design and the ones of the browser stack. */
const DATASET_FILES = [join(ENGINEERING, 'test_fixtures.json'), join('apps', 'web', 'e2e', 'support', 'e2e-fixtures.json')];

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const slash = (path) => String(path).split('\\').join('/');

/** The lines of a journal: what the tests did (`request`) and how each test case ended (`result`). A line that is not JSON is left out. */
export function readJournal(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * The test cases of the run with the requests each one made. A Jest test names the requests it made itself (the journal line holds its name and file); a browser
 * test gets the requests of the API stack that began while it ran (the browser tests run one at a time). A test that ran again keeps its last attempt.
 */
export function testsOfRun(lines, root = REPO_ROOT) {
  const requests = lines.filter((line) => line.kind === 'request');
  const last = new Map();
  for (const line of lines.filter((candidate) => candidate.kind === 'result')) {
    const key = `${line.suite}|${slash(line.file)}|${line.name}`;
    const before = last.get(key);
    if (before === undefined || (line.retry ?? 0) >= (before.retry ?? 0)) last.set(key, line);
  }
  return [...last.values()].map((line) => {
    const mine =
      line.suite === 'jest'
        ? requests.filter((request) => request.file !== '' && slash(request.file) === slash(line.file) && request.test === line.name)
        : requests.filter((request) => request.file === '' && request.at >= line.at && request.at <= (line.endedAt ?? line.at));
    return {
      suite: line.suite,
      file: slash(relative(root, line.file)),
      name: line.name,
      status: line.status,
      durationMs: line.durationMs,
      at: line.at,
      requests: mine.map((request) => ({ id: request.id, method: request.method, path: request.path, status: request.status, at: request.at })),
    };
  });
}

const passed = (test) => test.status === 'passed';
const skipped = (test) => test.status === 'skipped' || test.status === 'pending' || test.status === 'todo' || test.status === 'disabled';

const matchers = new WeakMap();

/** The design cases a test names: an id counts where it stands as a word (a `TC-` before it is fine, a letter or a digit on either side is not), the longest id first. */
export function idsNamedBy(name, knownIds) {
  let matcher = matchers.get(knownIds);
  if (matcher === undefined) {
    const escaped = [...knownIds].sort((left, right) => right.length - left.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    matcher = new RegExp(`(?<![A-Za-z0-9])(${escaped.join('|')})(?![A-Za-z0-9])`, 'g');
    matchers.set(knownIds, matcher);
  }
  return new Set([...name.matchAll(matcher)].map((found) => found[1]));
}

/** What a design test case came to: FAIL when any test that names it failed, PASS when at least one ran and none failed, SKIPPED when all were skipped. */
export function resultsOfTests(tests, knownIds) {
  const byId = new Map();
  for (const test of tests) {
    for (const id of idsNamedBy(test.name, knownIds)) byId.set(id, [...(byId.get(id) ?? []), test]);
  }
  const results = new Map();
  for (const [id, named] of byId) {
    const failed = named.some((test) => !passed(test) && !skipped(test));
    const ran = named.filter(passed);
    const result = failed ? 'FAIL' : ran.length > 0 ? 'PASS' : 'SKIPPED';
    const requestIds = [...new Set(ran.flatMap((test) => test.requests.map((request) => request.id)))];
    results.set(id, { result, tests: named, requestIds });
  }
  return results;
}

/** The hash of the dataset the run used and the last migration it ran on. */
export function datasetOf(root) {
  const hash = createHash('sha256');
  for (const file of DATASET_FILES) hash.update(readFileSync(join(root, file)));
  return hash.digest('hex');
}

export function schemaVersionOf(root) {
  const versions = readdirSync(join(root, 'db', 'migrations'))
    .map((name) => /^V(\d+)__/.exec(name)?.[1])
    .filter((version) => version !== undefined)
    .map(Number);
  return String(Math.max(...versions));
}

export function buildOf(root, run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })) {
  const sha = run(['rev-parse', 'HEAD']).trim();
  return run(['status', '--porcelain']).trim() === '' ? sha : `${sha}+dirty`;
}

/**
 * The run store (docs/uat-run-results.json) and the evidence of each result (docs/evidence/<run>/<id>.json). A PASS carries when the run ended, the build, the schema,
 * the hash of the dataset, the ids of the requests the tests made and the path of the evidence; the store keeps the waivers it already had.
 */
export function buildRunStore({ runId, tests, knownIds, build, schemaVersion, datasetSha256, at, waivers = [] }) {
  const results = {};
  const evidence = {};
  for (const [id, entry] of [...resultsOfTests(tests, knownIds)].sort(([left], [right]) => left.localeCompare(right))) {
    const path = `docs/evidence/${runId}/${id}.json`;
    results[id] = {
      result: entry.result,
      at,
      build,
      schema_version: schemaVersion,
      dataset_sha256: datasetSha256,
      request_ids: entry.requestIds,
      evidence: path,
    };
    evidence[path] = { id, result: entry.result, at, build, run: runId, tests: entry.tests };
  }
  return { store: { runId, build, schemaVersion, datasetSha256, results, waivers }, evidence };
}

export function main(argv, { log = console.log, now = () => new Date(), build = buildOf } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      locale: { type: 'string', default: DEFAULT_LOCALE },
      journal: { type: 'string', multiple: true, default: [] },
      'run-id': { type: 'string' },
      // Keeps the results of an earlier run that this journal does not name (a run of the phone adds to the run of the API and the browser).
      merge: { type: 'boolean', default: false },
    },
  });
  const messages = loadMessages(values.locale);
  const root = resolve(values.root);
  if (values.journal.length === 0 || values.journal.some((path) => !existsSync(path))) {
    log(messages['uatrun.journal.missing']);
    return 1;
  }
  const lines = values.journal.flatMap((path) => readJournal(readFileSync(path, 'utf8')));
  const known = new Set(JSON.parse(readFileSync(join(root, ENGINEERING, 'test_cases.json'), 'utf8')).map((test) => test.id));
  const at = now().toISOString();
  const runId = values['run-id'] ?? `local-${at.slice(0, 10)}-${at.slice(11, 19).split(':').join('')}`;
  const storePath = join(root, 'docs', 'uat-run-results.json');
  const before = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
  const { store, evidence } = buildRunStore({
    runId,
    tests: testsOfRun(lines, root),
    knownIds: known,
    build: build(root),
    schemaVersion: schemaVersionOf(root),
    datasetSha256: datasetOf(root),
    at,
    waivers: before.waivers ?? [],
  });
  mkdirSync(join(root, 'docs', 'evidence', runId), { recursive: true });
  for (const [path, content] of Object.entries(evidence)) writeFileSync(join(root, path), `${JSON.stringify(content, null, 2)}\n`);
  if (values.merge) store.results = { ...(before.results ?? {}), ...store.results };
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const entry of Object.values(store.results)) counts[entry.result] += 1;
  const unproven = Object.values(store.results).filter((entry) => entry.result === 'PASS' && entry.request_ids.length === 0).length;
  log(format(messages['uatrun.summary'], { run: runId, pass: counts.PASS, fail: counts.FAIL, skipped: counts.SKIPPED, unproven }));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
