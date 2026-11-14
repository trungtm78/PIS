// Runs the test suites of a UAT run one after the other, each with its own journal (UAT_JOURNAL), then hands every journal to scripts/uat-run.mjs, so that a run needs no
// hand-made joining of journals (docs/uat/INDEX.md, "Các bộ test một lượt UAT phải ghi journal"). The seven suites: Jest of apps/api, of packages/db and of packages/kernel,
// Vitest of apps/web, node:test of scripts/, Playwright of apps/web/e2e and the Flutter tests of apps/mobile.
//
//   node scripts/uat-suites.mjs                                  every suite, then the run store (docs/uat-run-results.json) and the evidence
//   node scripts/uat-suites.mjs --suite api --suite kernel       some of them (the store then keeps the results of the others: --merge)
//   node scripts/uat-suites.mjs --journal-dir <dir> --no-store   only the journals, for a harness that reads them itself
//
// A suite that fails does not stop the others: its failed cases are in its journal and become FAIL. A suite whose tool is not on the machine is reported and left out.
// The two Jest suites that start PostgreSQL and Playwright go through the lanes of scripts/lane.mjs (one at a time on the machine).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readJournal } from './uat-run.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const JEST = ['--experimental-vm-modules', '../../node_modules/jest/bin/jest.js', '--coverage=false', '--forceExit'];

/** The suites of a run in the order they run: the name, the folder (from the root), the lane of the machine it takes (if any) and its command. */
export const SUITES = [
  { name: 'api', cwd: 'apps/api', lane: 'db', command: ['node', ...JEST] },
  { name: 'db', cwd: 'packages/db', lane: 'db', command: ['node', ...JEST] },
  { name: 'kernel', cwd: 'packages/kernel', command: ['node', '../../node_modules/jest/bin/jest.js', '--coverage=false'] },
  { name: 'vitest', cwd: 'apps/web', lane: 'heavy1', command: ['npx', 'vitest', 'run', '--coverage=false'] },
  { name: 'node', cwd: '.', command: ['node', '--test', '--test-reporter=./scripts/uat-node-reporter.mjs', '--test-reporter-destination=stdout'], files: 'scripts' },
  { name: 'playwright', cwd: 'apps/web', lane: 'browser', command: ['npx', 'playwright', 'test'] },
  { name: 'flutter', cwd: 'apps/mobile', lane: 'heavy2', perFile: true, command: ['flutter', 'test', '--no-pub', '--reporter', 'json'] },
];

export const SUITE_NAMES = SUITES.map((suite) => suite.name);

/** The suites named (all of them when none is), in the order of SUITES; a name that is not a suite is an error. */
export function selectSuites(names = []) {
  const unknown = names.filter((name) => !SUITE_NAMES.includes(name));
  if (unknown.length > 0) throw new Error(`unknown suite: ${unknown.join(', ')} (known: ${SUITE_NAMES.join(', ')})`);
  return names.length === 0 ? SUITES : SUITES.filter((suite) => names.includes(suite.name));
}

/** The journal of a suite in the folder of the journals of the run. */
export const journalOf = (journalDir, suite) => join(journalDir, `journal-${suite.name}.jsonl`);

function* filesUnder(directory, pattern) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path, pattern);
    else if (pattern.test(entry.name)) yield path;
  }
}

/**
 * The commands of a suite: `{ argv, cwd, env }` each. One command for most; the node:test suite names its files (a glob is not expanded on every shell); the Flutter suite
 * is one command per test file, whose JSON events are turned into journal lines afterwards (`convert`).
 */
export function commandsOf(suite, { root = REPO_ROOT, journalDir, useLanes = true } = {}) {
  const cwd = resolve(root, suite.cwd);
  const env = { UAT_JOURNAL: journalOf(journalDir, suite) };
  const inLane = (argv) => (useLanes && suite.lane !== undefined ? ['node', resolve(root, 'scripts', 'lane.mjs'), suite.lane, '--', ...argv] : argv);
  if (suite.perFile === true) {
    return [...filesUnder(join(cwd, 'test'), /_test\.dart$/)].map((file) => {
      const name = relative(cwd, file).split(sep).join('/');
      return { argv: inLane([...suite.command, name]), cwd, env, convert: join(journalDir, 'flutter', `${name.split('/').join('_')}.json`) };
    });
  }
  if (suite.files !== undefined) {
    const files = [...filesUnder(join(cwd, suite.files), /\.test\.mjs$/)].filter((file) => dirname(file) === join(cwd, suite.files)).map((file) => relative(cwd, file).split(sep).join('/'));
    return [{ argv: inLane([...suite.command, ...files]), cwd, env }];
  }
  return [{ argv: inLane(suite.command), cwd, env }];
}

/** The journals that exist with what each holds: the lines of results by state. A suite that wrote nothing is listed with `missing`. */
export function summarizeJournals(journalDir, suites = SUITES) {
  return suites.map((suite) => {
    const path = journalOf(journalDir, suite);
    if (!existsSync(path)) return { suite: suite.name, path, missing: true, passed: 0, failed: 0, skipped: 0 };
    const results = readJournal(readFileSync(path, 'utf8')).filter((line) => line.kind === 'result');
    const count = (wanted) => results.filter((line) => wanted(line.status)).length;
    return {
      suite: suite.name,
      path,
      missing: false,
      passed: count((status) => status === 'passed'),
      failed: count((status) => status === 'failed' || status === 'timedOut' || status === 'interrupted'),
      skipped: count((status) => ['skipped', 'pending', 'todo', 'disabled'].includes(status)),
    };
  });
}

/** The arguments of scripts/uat-run.mjs for the journals that exist: one --journal each, the run id, and --merge when some suite did not run. */
export function runArguments(summaries, { runId, partial }) {
  const journals = summaries.filter((one) => !one.missing).flatMap((one) => ['--journal', one.path]);
  return [...journals, ...(runId === undefined ? [] : ['--run-id', runId]), ...(partial ? ['--merge'] : [])];
}

function defaultSpawn(argv, options) {
  // `npx` and `flutter` are command files on Windows: they need the shell there.
  const viaShell = process.platform === 'win32' && argv[0] !== 'node';
  return spawnSync(argv[0], argv.slice(1), { ...options, shell: viaShell, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
}

/**
 * Runs the suites one after the other. Each starts from an empty journal of its own. Returns, per suite, the exit codes of its commands and whether its tool could be started.
 * `spawn(argv, { cwd, env })` answers `{ status, stdout, error }`; `convert(jsonPath, journalPath)` turns the events of a Flutter file into journal lines.
 */
export function runSuites(suites, { root = REPO_ROOT, journalDir, useLanes = true, spawn = defaultSpawn, convert = convertFlutter, log = () => undefined, write = defaultWrite } = {}) {
  mkdirSync(journalDir, { recursive: true });
  const outcomes = [];
  for (const suite of suites) {
    rmSync(journalOf(journalDir, suite), { force: true });
    const codes = [];
    let started = true;
    for (const command of commandsOf(suite, { root, journalDir, useLanes })) {
      const done = spawn(command.argv, { cwd: command.cwd, env: { ...process.env, ...command.env } });
      if (done.error !== undefined) {
        started = false;
        break;
      }
      codes.push(done.status ?? 1);
      if (command.convert !== undefined) {
        write(command.convert, done.stdout ?? '');
        convert(command.convert, command.env.UAT_JOURNAL, root);
      }
    }
    outcomes.push({ suite: suite.name, started, commands: codes.length, failed: codes.filter((code) => code !== 0).length });
    log(`${suite.name}: ${started ? `${codes.length} command(s), ${codes.filter((code) => code !== 0).length} with failures` : 'the tool could not be started, left out'}`);
  }
  return outcomes;
}

function defaultWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  // The events of one Flutter file, kept beside the journal as what the lines were made from.
  writeFileSync(path, text);
}

function convertFlutter(jsonPath, journalPath, root) {
  spawnSync('node', [resolve(root, 'scripts', 'uat-dart-journal.mjs'), jsonPath, journalPath], { cwd: root, encoding: 'utf8' });
}

export async function main(argv, { log = console.log, run = runSuites, store } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      suite: { type: 'string', multiple: true, default: [] },
      'journal-dir': { type: 'string' },
      'run-id': { type: 'string' },
      'no-lanes': { type: 'boolean', default: false },
      'no-store': { type: 'boolean', default: false },
    },
  });
  const root = resolve(values.root);
  let suites;
  try {
    suites = selectSuites(values.suite);
  } catch (error) {
    log(error.message);
    return 1;
  }
  const journalDir = resolve(values['journal-dir'] ?? join(root, 'test-results', 'uat-journals'));
  const outcomes = run(suites, { root, journalDir, useLanes: !values['no-lanes'], log });
  const summaries = summarizeJournals(journalDir, suites);
  for (const one of summaries) log(one.missing ? `${one.suite}: no journal` : `${one.suite}: ${one.passed} passed, ${one.failed} failed, ${one.skipped} skipped -> ${one.path}`);
  const empty = summaries.filter((one) => one.missing).map((one) => one.suite);
  if (values['no-store']) return empty.length === suites.length ? 1 : 0;
  if (empty.length === suites.length) {
    log('no suite wrote a journal: nothing to store');
    return 1;
  }
  const partial = suites.length < SUITES.length || empty.length > 0 || outcomes.some((one) => !one.started);
  const storeRun = store ?? (await import('./uat-run.mjs')).main;
  return storeRun(['--root', root, ...runArguments(summaries, { runId: values['run-id'], partial })], { log });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
