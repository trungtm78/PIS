import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { buildOf, buildRunStore, datasetOf, main, readJournal, resultsOfTests, schemaVersionOf, testsOfRun } from './uat-run.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

// The paths of a journal are the ones of the machine that wrote it: built with the separators of the machine that runs the test.
const ROOT = resolve('repo-root');
const KNOWN = new Set(['UAT-AC01', 'UAT-AC02', 'UAT-AC03', 'UAT-NFR-AVAILABILITY-04']);
const request = (id, test, file, extra = {}) => ({ kind: 'request', id, pid: 1, test, file, method: 'GET', path: '/x', status: 200, at: '2026-11-04T10:00:01.000Z', durationMs: 5, ...extra });
const result = (suite, file, name, status, extra = {}) => ({ kind: 'result', suite, file, name, status, durationMs: 9, at: '2026-11-04T10:00:00.000Z', ...extra });

test('a journal is read line by line and a line that is not JSON is left out', () => {
  assert.deepEqual(readJournal('{"kind":"request"}\r\n\nnot json\n{"kind":"result"}\n'), [{ kind: 'request' }, { kind: 'result' }]);
});

test('a Jest test gets the requests it made, matched by its file and its name; a browser test gets the ones that began while it ran', () => {
  const lines = [
    request('r-1', 'api UAT-AC01 reads', join(ROOT, 'apps', 'api', 'test', 'a.test.ts')),
    request('r-2', 'api other', join(ROOT, 'apps', 'api', 'test', 'a.test.ts')),
    request('r-3', '', '', { at: '2026-11-04T10:00:02.000Z' }),
    request('r-4', '', '', { at: '2026-11-04T10:05:00.000Z' }),
    result('jest', join(ROOT, 'apps', 'api', 'test', 'a.test.ts'), 'api UAT-AC01 reads', 'passed'),
    result('playwright', join(ROOT, 'apps', 'web', 'e2e', 'b.spec.ts'), 'flow UAT-AC02', 'passed', { endedAt: '2026-11-04T10:00:03.000Z' }),
  ];
  const tests = testsOfRun(lines, ROOT);
  assert.deepEqual(tests.map((item) => [item.suite, item.file, item.requests.map((entry) => entry.id)]), [
    ['jest', 'apps/api/test/a.test.ts', ['r-1']],
    ['playwright', 'apps/web/e2e/b.spec.ts', ['r-3']],
  ]);
});

test('a Vitest or a Flutter test is a unit test like a Jest one: it gets no request of the browser stack', () => {
  const lines = [
    request('r-3', '', '', { at: '2026-11-04T10:00:02.000Z' }),
    result('vitest', join(ROOT, 'apps', 'web', 'src', 'a.test.tsx'), 'screen UAT-AC01', 'passed', { endedAt: '2026-11-04T10:00:03.000Z' }),
    result('dart', join(ROOT, 'apps', 'mobile', 'test', 'a_test.dart'), 'phone UAT-AC02', 'passed', { endedAt: '2026-11-04T10:00:03.000Z' }),
  ];
  assert.deepEqual(testsOfRun(lines, ROOT).map((item) => [item.suite, item.file, item.requests]), [['vitest', 'apps/web/src/a.test.tsx', []], ['dart', 'apps/mobile/test/a_test.dart', []]]);
});

test('a test that ran again keeps its last attempt', () => {
  const lines = [
    result('playwright', '/r/e2e/b.spec.ts', 'flow UAT-AC02', 'failed', { retry: 0 }),
    result('playwright', '/r/e2e/b.spec.ts', 'flow UAT-AC02', 'passed', { retry: 1 }),
  ];
  assert.deepEqual(testsOfRun(lines, '/r').map((item) => item.status), ['passed']);
});

test('a design test case fails when any test that names it failed, passes when one ran and none failed, and is skipped when all were skipped', () => {
  const named = (name, status, ids = []) => ({ suite: 'jest', file: 'f', name, status, durationMs: 1, at: 'x', requests: ids.map((id) => ({ id })) });
  const outcome = resultsOfTests(
    [
      named('UAT-AC01 first', 'passed', ['r-1']),
      named('UAT-AC01 second', 'failed', ['r-2']),
      named('UAT-AC02 only', 'passed', ['r-3', 'r-3']),
      named('UAT-AC02 again', 'passed', ['r-4']),
      named('UAT-AC03 held', 'skipped'),
      named('UAT-AC03 todo', 'todo'),
      named('UAT-NFR-AVAILABILITY-04: a long id', 'passed'),
      named('UAT-AC99 is not a design case', 'passed', ['r-9']),
      named('no id at all', 'passed', ['r-8']),
    ],
    KNOWN,
  );
  assert.deepEqual([...outcome.keys()], ['UAT-AC01', 'UAT-AC02', 'UAT-AC03', 'UAT-NFR-AVAILABILITY-04']);
  assert.equal(outcome.get('UAT-AC01').result, 'FAIL');
  assert.deepEqual(outcome.get('UAT-AC02'), { result: 'PASS', tests: outcome.get('UAT-AC02').tests, requestIds: ['r-3', 'r-4'] });
  assert.equal(outcome.get('UAT-AC03').result, 'SKIPPED');
  assert.deepEqual(outcome.get('UAT-NFR-AVAILABILITY-04').requestIds, []);
});

test('the store carries, for each result, when the run ended, the build, the schema, the dataset, the requests and the path of the evidence', () => {
  const tests = [{ suite: 'jest', file: 'f', name: 'UAT-AC02 ok', status: 'passed', durationMs: 1, at: 't', requests: [{ id: 'r-1' }] }];
  const { store, evidence } = buildRunStore({ runId: 'run-1', tests, knownIds: KNOWN, build: 'abc', schemaVersion: '1700', datasetSha256: 'd'.repeat(64), at: '2026-11-04T11:00:00.000Z', waivers: [{ target: 'UAT-AC77' }] });
  assert.deepEqual(store.results['UAT-AC02'], {
    result: 'PASS',
    at: '2026-11-04T11:00:00.000Z',
    build: 'abc',
    schema_version: '1700',
    dataset_sha256: 'd'.repeat(64),
    request_ids: ['r-1'],
    evidence: 'docs/evidence/run-1/UAT-AC02.json',
  });
  assert.deepEqual(store.waivers, [{ target: 'UAT-AC77' }]);
  assert.equal(evidence['docs/evidence/run-1/UAT-AC02.json'].result, 'PASS');
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'uat-run-'));
  roots.push(root);
  mkdirSync(join(root, 'Design', 'MACHVON_Design', '03_Engineering'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web', 'e2e', 'support'), { recursive: true });
  mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'Design', 'MACHVON_Design', '03_Engineering', 'test_fixtures.json'), '{"a":1}');
  writeFileSync(join(root, 'Design', 'MACHVON_Design', '03_Engineering', 'test_cases.json'), JSON.stringify([{ id: 'UAT-AC01' }, { id: 'UAT-AC02' }]));
  writeFileSync(join(root, 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json'), '{"b":2}');
  for (const name of ['V002__schema.sql', 'V1700__late.sql', 'V1699__early.sql', 'README.md']) writeFileSync(join(root, 'db', 'migrations', name), '');
  return root;
}

test('the dataset is the hash of the two fixture files and the schema is the last migration', () => {
  const root = repo();
  assert.match(datasetOf(root), /^[0-9a-f]{64}$/);
  assert.equal(schemaVersionOf(root), '1700');
});

test('the build is the commit, marked when the tree has changes', () => {
  assert.equal(buildOf('/r', (args) => (args[0] === 'rev-parse' ? 'abc123\n' : '')), 'abc123');
  assert.equal(buildOf('/r', (args) => (args[0] === 'rev-parse' ? 'abc123\n' : ' M file\n')), 'abc123+dirty');
});

test('a run writes the store and the evidence, and keeps the waivers the store had', () => {
  const root = repo();
  writeFileSync(join(root, 'docs', 'uat-run-results.json'), JSON.stringify({ waivers: [{ target: 'UAT-AC77' }] }));
  const journal = join(root, 'journal.jsonl');
  const file = join(root, 'apps', 'api', 'test', 'a.test.ts');
  writeFileSync(
    journal,
    [request('r-1', 'UAT-AC01 ok', file), result('jest', file, 'UAT-AC01 ok', 'passed'), request('r-2', 'UAT-AC02 bad', file), result('jest', file, 'UAT-AC02 bad', 'failed')]
      .map((line) => JSON.stringify(line))
      .join('\n'),
  );
  const lines = [];
  const code = main(['--root', root, '--locale', 'en', '--journal', journal, '--run-id', 'run-x'], { log: (line) => lines.push(line), now: () => new Date('2026-11-04T12:00:00Z'), build: () => 'abc' });
  assert.equal(code, 0);
  assert.equal(lines[0], 'Run run-x: 1 cases PASS (0 without full evidence), 1 FAIL, 0 skipped');
  const store = JSON.parse(readFileSync(join(root, 'docs', 'uat-run-results.json'), 'utf8'));
  assert.deepEqual(Object.keys(store.results), ['UAT-AC01', 'UAT-AC02']);
  assert.deepEqual(store.results['UAT-AC01'].request_ids, ['r-1']);
  assert.deepEqual(store.waivers, [{ target: 'UAT-AC77' }]);
  const evidence = JSON.parse(readFileSync(join(root, 'docs', 'evidence', 'run-x', 'UAT-AC01.json'), 'utf8'));
  assert.equal(evidence.tests[0].requests[0].id, 'r-1');
});

test('a run with --merge keeps the results of the earlier run that its journal does not name, and a result it names is replaced', () => {
  const root = repo();
  const before = { runId: 'run-a', results: { 'UAT-AC01': { result: 'FAIL', request_ids: [] }, 'UAT-AC02': { result: 'PASS', request_ids: ['old'] } }, waivers: [] };
  writeFileSync(join(root, 'docs', 'uat-run-results.json'), JSON.stringify(before));
  const journal = join(root, 'journal.jsonl');
  const file = join(root, 'apps', 'api', 'test', 'a.test.ts');
  writeFileSync(journal, [request('r-9', 'UAT-AC01 again', file), result('jest', file, 'UAT-AC01 again', 'passed')].map((line) => JSON.stringify(line)).join('\n'));
  main(['--root', root, '--locale', 'en', '--journal', journal, '--run-id', 'run-b', '--merge'], { log: () => undefined, now: () => new Date('2026-11-04T12:00:00Z'), build: () => 'abc' });
  const store = JSON.parse(readFileSync(join(root, 'docs', 'uat-run-results.json'), 'utf8'));
  assert.equal(store.runId, 'run-b');
  assert.equal(store.results['UAT-AC01'].result, 'PASS');
  assert.deepEqual(store.results['UAT-AC01'].request_ids, ['r-9']);
  assert.deepEqual(store.results['UAT-AC02'], { result: 'PASS', request_ids: ['old'] });
});

test('a PASS without any request is counted as one without full evidence, and the default run id is made from the time', () => {
  const root = repo();
  const journal = join(root, 'journal.jsonl');
  writeFileSync(journal, JSON.stringify(result('jest', join(root, 'x.test.ts'), 'UAT-AC01 pure', 'passed')));
  const lines = [];
  main(['--root', root, '--locale', 'en', '--journal', journal], { log: (line) => lines.push(line), now: () => new Date('2026-11-04T12:34:56Z'), build: () => 'abc' });
  assert.equal(lines[0], 'Run local-2026-11-04-123456: 1 cases PASS (1 without full evidence), 0 FAIL, 0 skipped');
});

test('a run without a journal, or with one that does not exist, is refused', () => {
  const root = repo();
  for (const args of [[], ['--journal', join(root, 'none.jsonl')]]) {
    const lines = [];
    assert.equal(main(['--root', root, '--locale', 'en', ...args], { log: (line) => lines.push(line) }), 1);
    assert.match(lines[0], /journal of the UAT run is missing/);
  }
});

test('the messages are in both languages', () => {
  const root = repo();
  const lines = [];
  main(['--root', root], { log: (line) => lines.push(line) });
  assert.match(lines[0], /Thiếu nhật ký/);
});

test('a test names a design case by its id wherever the id stands as a word: after a TC- prefix too, the longest id first, and never inside another word', () => {
  const known = new Set(['UAT-AC1', 'UAT-AC10', 'SEC01', 'TX01', 'UAT-NFR-TENANCY-01']);
  const named = (name) => ({ suite: 'playwright', file: 'f', name, status: 'passed', durationMs: 1, at: 'x', requests: [] });
  const outcome = resultsOfTests(
    [named('TC-SEC01: another tenant gets 404'), named('TC-UAT-NFR-TENANCY-01: sweep'), named('UAT-AC10 and TX01 together'), named('XSEC01 is not a case'), named('UAT-AC1x is not UAT-AC1')],
    known,
  );
  assert.deepEqual([...outcome.keys()].sort(), ['SEC01', 'TX01', 'UAT-AC1', 'UAT-AC10', 'UAT-NFR-TENANCY-01']);
  assert.deepEqual(outcome.get('UAT-AC1').tests.map((test) => test.name), ['UAT-AC1x is not UAT-AC1']);
});
