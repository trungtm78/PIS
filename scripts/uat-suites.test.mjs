import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SUITE_NAMES, commandsOf, journalOf, main, runArguments, runSuites, selectSuites, summarizeJournals } from './uat-suites.mjs';
import { readJournal, resultsOfTests, testsOfRun } from './uat-run.mjs';

const made = [];
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), 'uat-suites-'));
  made.push(path);
  return path;
};
after(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

const line = (suite, file, name, status) => `${JSON.stringify({ kind: 'result', suite, file, name, status, durationMs: 1, at: '2026-11-14T00:00:00.000Z' })}\n`;

/** A repository with script tests and Flutter test files, enough for the commands of every suite. */
function layout() {
  const root = folder();
  for (const dir of ['scripts/nested', 'apps/api', 'packages/db', 'packages/kernel', 'apps/web', 'apps/mobile/test/features']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['scripts/a.test.mjs', 'scripts/b.test.mjs', 'scripts/nested/c.test.mjs', 'scripts/tool.mjs', 'apps/mobile/test/one_test.dart', 'apps/mobile/test/features/two_test.dart', 'apps/mobile/test/helper.dart']) writeFileSync(join(root, file), '');
  return root;
}

describe('the suites of a UAT run', () => {
  it('are the seven of docs/uat/INDEX.md, in the order they run', () => {
    assert.deepEqual(SUITE_NAMES, ['api', 'db', 'kernel', 'vitest', 'node', 'playwright', 'flutter']);
    assert.deepEqual(selectSuites().map((suite) => suite.name), SUITE_NAMES);
    assert.deepEqual(selectSuites(['kernel', 'api']).map((suite) => suite.name), ['api', 'kernel']);
    assert.throws(() => selectSuites(['api', 'cypress']), /unknown suite: cypress/);
  });

  it('give each suite a journal of its own and its command; PostgreSQL and the browser go through a lane, the script tests are named file by file, Flutter runs file by file', () => {
    const root = layout();
    const journalDir = join(root, 'journals');
    const of = (name, options = {}) => commandsOf(selectSuites([name])[0], { root, journalDir, ...options });
    const [api] = of('api');
    assert.equal(api.env.UAT_JOURNAL, join(journalDir, 'journal-api.jsonl'));
    assert.deepEqual(api.argv.slice(0, 4), ['node', join(root, 'scripts', 'lane.mjs'), 'db', '--']);
    assert.equal(api.cwd, join(root, 'apps', 'api'));
    assert.ok(api.argv.includes('--coverage=false'));
    assert.deepEqual(of('api', { useLanes: false })[0].argv.slice(0, 2), ['node', '--experimental-vm-modules']);
    assert.equal(of('kernel')[0].argv[1], '../../node_modules/jest/bin/jest.js');
    assert.deepEqual(of('playwright')[0].argv.slice(2, 4), ['browser', '--']);
    // Only the tests directly in scripts/, as the test command of the repository takes them.
    assert.deepEqual(of('node')[0].argv.slice(-2), ['scripts/a.test.mjs', 'scripts/b.test.mjs']);
    assert.ok(of('node')[0].argv.includes('--test-reporter=./scripts/uat-node-reporter.mjs'));
    const flutter = of('flutter', { useLanes: false });
    assert.deepEqual(flutter.map((command) => command.argv.at(-1)), ['test/features/two_test.dart', 'test/one_test.dart']);
    assert.deepEqual(flutter.map((command) => command.convert), [join(journalDir, 'flutter', 'test_features_two_test.dart.json'), join(journalDir, 'flutter', 'test_one_test.dart.json')]);
  });

  it('run one after the other from an empty journal each, go on after a suite that fails, leave out a suite whose tool does not start, and convert the events of each Flutter file', () => {
    const root = layout();
    const journalDir = join(root, 'journals');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(join(journalDir, 'journal-kernel.jsonl'), line('jest', 'old.test.ts', 'a result of an earlier run', 'passed'));
    const calls = [];
    const converted = [];
    const spawn = (argv, { cwd, env }) => {
      calls.push({ argv, cwd });
      if (argv.includes('vitest')) return { error: new Error('ENOENT') };
      if (argv[0] === 'flutter') return { status: 0, stdout: '{"type":"done"}\n' };
      appendFileSync(env.UAT_JOURNAL, line('jest', join(cwd, 'x.test.ts'), `UAT-AC1 of ${cwd}`, cwd.endsWith('db') ? 'failed' : 'passed'));
      return { status: cwd.endsWith('db') ? 1 : 0 };
    };
    const chosen = selectSuites(['db', 'kernel', 'vitest', 'flutter']);
    const outcomes = runSuites(chosen, { root, journalDir, useLanes: false, spawn, convert: (json, journal) => converted.push([json, journal]) });
    assert.deepEqual(outcomes, [
      { suite: 'db', started: true, commands: 1, failed: 1 },
      { suite: 'kernel', started: true, commands: 1, failed: 0 },
      { suite: 'vitest', started: false, commands: 0, failed: 0 },
      { suite: 'flutter', started: true, commands: 2, failed: 0 },
    ]);
    assert.deepEqual(calls.map((call) => call.cwd), [join(root, 'packages', 'db'), join(root, 'packages', 'kernel'), join(root, 'apps', 'web'), join(root, 'apps', 'mobile'), join(root, 'apps', 'mobile')]);
    assert.equal(converted.length, 2);
    assert.equal(converted[0][1], join(journalDir, 'journal-flutter.jsonl'));
    assert.equal(readFileSync(converted[0][0], 'utf8'), '{"type":"done"}\n');
    // The journal of the kernel holds this run only: the line of the earlier run is gone.
    assert.deepEqual(summarizeJournals(journalDir, chosen).map((one) => [one.suite, one.missing, one.passed, one.failed]), [['db', false, 0, 1], ['kernel', false, 1, 0], ['vitest', true, 0, 0], ['flutter', true, 0, 0]]);
  });

  it('join the journals of the suites into one run: a case named by tests of two suites is FAIL when one of them failed and PASS when all that ran passed', () => {
    const journalDir = folder();
    const suites = selectSuites(['api', 'kernel', 'node']);
    writeFileSync(journalOf(journalDir, suites[0]), line('jest', 'a.test.ts', 'UAT-AC1: over HTTP', 'passed') + line('jest', 'a.test.ts', 'UAT-AC2: over HTTP', 'passed'));
    writeFileSync(journalOf(journalDir, suites[1]), line('jest', 'k.test.ts', 'UAT-AC1: the rule', 'passed') + line('jest', 'k.test.ts', 'UAT-AC2: the rule', 'failed'));
    writeFileSync(journalOf(journalDir, suites[2]), line('jest', 's.test.mjs', 'the gate UAT-AC3', 'skipped'));
    const summaries = summarizeJournals(journalDir, suites);
    assert.deepEqual(summaries.map((one) => [one.passed, one.failed, one.skipped]), [[2, 0, 0], [1, 1, 0], [0, 0, 1]]);
    assert.deepEqual(runArguments(summaries, { runId: 'r4', partial: true }), ['--journal', summaries[0].path, '--journal', summaries[1].path, '--journal', summaries[2].path, '--run-id', 'r4', '--merge']);
    assert.deepEqual(runArguments(summaries, { partial: false }).filter((arg) => arg.startsWith('--') && arg !== '--journal'), []);
    const lines = summaries.flatMap((one) => readJournal(readFileSync(one.path, 'utf8')));
    const results = resultsOfTests(testsOfRun(lines, journalDir), new Set(['UAT-AC1', 'UAT-AC2', 'UAT-AC3']));
    assert.deepEqual([...results].map(([id, entry]) => [id, entry.result]).sort(), [['UAT-AC1', 'PASS'], ['UAT-AC2', 'FAIL'], ['UAT-AC3', 'SKIPPED']]);
  });

  it('hand every journal to the store of the run: all suites give a whole run, some suites or a missing journal are merged into the store, and no journal at all is an error', async () => {
    const root = layout();
    const journalDir = join(root, 'journals');
    const logs = [];
    const stored = [];
    const store = (args) => {
      stored.push(args);
      return 0;
    };
    const writes = (names) => (suites) => {
      mkdirSync(journalDir, { recursive: true });
      for (const suite of suites) if (names.includes(suite.name)) writeFileSync(journalOf(journalDir, suite), line('jest', 'a.test.ts', 'UAT-AC1', 'passed'));
      return suites.map((suite) => ({ suite: suite.name, started: true, commands: 1, failed: 0 }));
    };
    assert.equal(await main(['--root', root, '--journal-dir', journalDir, '--run-id', 'r4'], { log: (text) => logs.push(text), run: writes(SUITE_NAMES), store }), 0);
    assert.equal(stored[0].filter((arg) => arg === '--journal').length, 7);
    assert.ok(!stored[0].includes('--merge'));
    assert.deepEqual(stored[0].slice(-2), ['--run-id', 'r4']);
    rmSync(journalDir, { recursive: true, force: true });
    assert.equal(await main(['--root', root, '--journal-dir', journalDir, '--suite', 'api', '--suite', 'kernel'], { log: () => undefined, run: writes(['api']), store }), 0);
    assert.equal(stored[1].filter((arg) => arg === '--journal').length, 1);
    assert.equal(stored[1].at(-1), '--merge');
    rmSync(journalDir, { recursive: true, force: true });
    assert.equal(await main(['--root', root, '--journal-dir', journalDir, '--suite', 'api'], { log: (text) => logs.push(text), run: writes([]), store }), 1);
    assert.equal(stored.length, 2);
    assert.equal(await main(['--root', root, '--journal-dir', journalDir, '--suite', 'api', '--no-store'], { log: () => undefined, run: writes(['api']), store }), 0);
    assert.equal(stored.length, 2);
    assert.equal(await main(['--suite', 'cypress'], { log: (text) => logs.push(text), store }), 1);
    assert.ok(logs.some((text) => /unknown suite: cypress/.test(text)));
  });
});
