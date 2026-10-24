import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES, buildCoverage, main, renderCoverage, stateOfTest, waiverStanding } from './uat-evidence.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

const TODAY = '2026-10-25';
const SCREENS = [
  { id: 'AAA-01', title: 'First screen', module: 'AAA' },
  { id: 'AAA-02', title: 'Second screen', module: 'AAA' },
  { id: 'BBB-01', title: 'Third screen with no test', module: 'BBB' },
];
const TRACEABILITY = [
  { requirement: 'FR-AAA-01', screen: 'AAA-01', test_ids: ['T1', 'T2'] },
  { requirement: 'FR-AAA-02', screen: 'AAA-02', test_ids: ['T3'] },
  { requirement: 'FR-BBB-01', screen: 'BBB-01', test_ids: [] },
];
const TESTS = [
  { id: 'T1', type: 'domain', covers: 'NFR-TENANCY-01' },
  { id: 'T2', type: 'domain', covers: 'FR-AAA-01' },
  { id: 'T3', type: 'security', covers: 'NFR-SECURITY-09, FR-AAA-02' },
  { id: 'T4', type: 'operational', covers: 'NFR-AVAILABILITY-02' },
];
const CRITICAL = { money: ['NFR-SECURITY-09'], isolation: ['NFR-TENANCY-'], restore: ['NFR-AVAILABILITY-02'] };

const pass = (overrides = {}) => ({ result: 'PASS', at: '2026-10-24T10:00:00Z', build: 'abc123', schema_version: '1365', dataset_sha256: 'a'.repeat(64), request_ids: ['req-1'], evidence: 'docs/evidence/run-1/T.json', ...overrides });
const waiver = (target, overrides = {}) => ({ target, owner: 'Product owner', reason: 'The environment for the external adapter is not available', approved_by: 'Head of QA', expires: '2026-12-31', ...overrides });
const coverageOf = (results, extra = {}) => buildCoverage({ screens: SCREENS, traceability: TRACEABILITY, tests: TESTS, results, critical: CRITICAL, today: TODAY, ...extra });

test('every screen and every requirement appears with its tests, and a screen with no test is a GAP (AC-ST-KERNEL-090-1, UAT-NFR-OPERABILITY-02)', () => {
  const coverage = coverageOf({});
  assert.deepEqual(coverage.screenRows.map((row) => [row.id, row.state]), [
    ['AAA-01', 'NOT_RUN'],
    ['AAA-02', 'NOT_RUN'],
    ['BBB-01', 'GAP'],
  ]);
  assert.deepEqual(coverage.rows.map((row) => [row.requirement, row.tests.map((entry) => entry.id), row.state]), [
    ['FR-AAA-01', ['T1', 'T2'], 'NOT_RUN'],
    ['FR-AAA-02', ['T3'], 'NOT_RUN'],
    ['FR-BBB-01', [], 'GAP'],
  ]);
  assert.equal(coverage.summary.gaps, 1);
  const document = renderCoverage(coverage, {});
  for (const id of ['AAA-01', 'AAA-02', 'BBB-01', 'FR-AAA-01', 'FR-BBB-01']) assert.match(document, new RegExp(id));
  assert.match(document, /- BBB-01 Third screen with no test/);
});

test('a test the design names but does not define is ignored and reported, never counted', () => {
  const coverage = buildCoverage({ screens: SCREENS.slice(0, 1), traceability: [{ requirement: 'FR-AAA-01', screen: 'AAA-01', test_ids: ['T1', 'GHOST'] }], tests: TESTS, results: { T1: pass() }, today: TODAY });
  assert.deepEqual(coverage.rows[0].unknown, ['GHOST']);
  assert.equal(coverage.rows[0].state, 'PASS');
  const onlyGhost = buildCoverage({ screens: SCREENS.slice(0, 1), traceability: [{ requirement: 'FR-AAA-01', screen: 'AAA-01', test_ids: ['GHOST'] }], tests: TESTS, results: {}, today: TODAY });
  assert.equal(onlyGhost.rows[0].state, 'GAP');
});

test('a failing, a skipped and a NOT_RUN test keep the gate red and none of them counts as PASS (AC-ST-KERNEL-090-2, UAT-NFR-OPERABILITY-02)', () => {
  const coverage = buildCoverage({
    screens: [
      { id: 'S1', title: 'one', module: 'M' },
      { id: 'S2', title: 'two', module: 'M' },
      { id: 'S3', title: 'three', module: 'M' },
      { id: 'S4', title: 'four', module: 'M' },
    ],
    traceability: [
      { requirement: 'FR-1', screen: 'S1', test_ids: ['T1'] },
      { requirement: 'FR-2', screen: 'S2', test_ids: ['T2'] },
      { requirement: 'FR-3', screen: 'S3', test_ids: ['T3'] },
      { requirement: 'FR-4', screen: 'S4', test_ids: ['T4'] },
    ],
    tests: TESTS,
    results: { T1: { result: 'FAIL', at: '2026-10-24T10:00:00Z' }, T2: { result: 'SKIPPED' }, T3: { result: 'NOT_RUN' }, T4: pass() },
    today: TODAY,
  });
  assert.deepEqual(coverage.screenRows.map((row) => row.state), ['FAIL', 'SKIPPED', 'NOT_RUN', 'PASS']);
  assert.equal(coverage.summary.screensComplete, 1);
  assert.deepEqual(coverage.failures.filter((failure) => failure.code === 'SCREEN_NOT_COMPLETE').map((failure) => [failure.id, failure.state]), [['S1', 'FAIL'], ['S2', 'SKIPPED'], ['S3', 'NOT_RUN']]);
});

test('a PASS counts only with its evidence, and a record that says something else is a failure', () => {
  assert.equal(stateOfTest(pass()).state, 'PASS');
  for (const missing of ['at', 'build', 'schema_version', 'dataset_sha256', 'evidence']) assert.equal(stateOfTest(pass({ [missing]: '' })).state, 'UNPROVEN', missing);
  assert.equal(stateOfTest(pass({ request_ids: [] })).state, 'UNPROVEN');
  assert.equal(stateOfTest(pass({ request_ids: undefined })).state, 'UNPROVEN');
  assert.deepEqual(stateOfTest({ result: 'GREEN' }), { state: 'FAIL', invalid: true });
  assert.equal(stateOfTest(undefined).state, 'NOT_RUN');
  assert.equal(stateOfTest(null).state, 'NOT_RUN');
  assert.deepEqual(stateOfTest({ result: 'FAIL', at: 'x', evidence: 'y' }), { state: 'FAIL', at: 'x', evidence: 'y' });
  assert.equal(coverageOf({ T1: pass(), T2: pass({ build: '' }) }).rows[0].state, 'UNPROVEN');
});

test('the row is the worst of its tests, and a row is WAIVED only when every test that is not PASS has a valid waiver (AC-ST-KERNEL-090-3, UAT-NFR-TENANCY-01)', () => {
  const results = { T1: pass(), T2: { result: 'NOT_RUN' }, T3: pass(), T4: pass() };
  assert.equal(coverageOf(results).rows[0].state, 'NOT_RUN');
  assert.equal(coverageOf(results, { waivers: [waiver('T2')] }).rows[0].state, 'WAIVED');
  assert.equal(coverageOf(results, { waivers: [waiver('FR-AAA-01')] }).rows[0].state, 'WAIVED');
  assert.equal(coverageOf(results, { waivers: [waiver('AAA-01')] }).rows[0].state, 'WAIVED');
  assert.equal(coverageOf(results, { waivers: [waiver('T2', { expires: '2026-10-24' })] }).rows[0].state, 'NOT_RUN');
  assert.equal(coverageOf(results, { waivers: [waiver('T2', { approved_by: '' })] }).rows[0].state, 'NOT_RUN');
  // A waiver covers the tests it names, not the others of the row.
  assert.equal(coverageOf({ T1: { result: 'FAIL' }, T2: { result: 'NOT_RUN' }, T3: pass() }, { waivers: [waiver('T2')] }).rows[0].state, 'FAIL');
});

test('the critical section shows 100 percent when every critical test PASSes, and each waiver shows its owner, reason and expiry; a waiver is not a pass there', () => {
  const results = { T1: pass(), T2: { result: 'NOT_RUN' }, T3: pass(), T4: pass() };
  const coverage = coverageOf(results, { waivers: [waiver('T2'), waiver('T9', { expires: '2026-01-01' })] });
  assert.equal(coverage.summary.critical, 3);
  assert.equal(coverage.summary.criticalPass, 3);
  assert.deepEqual(coverage.criticalRows.map((row) => [row.id, row.areas]), [['T1', ['isolation']], ['T3', ['money']], ['T4', ['restore']]]);
  const document = renderCoverage(coverage, { runId: 'run-7', build: 'abc123', schemaVersion: '1365', datasetSha256: 'f'.repeat(64) });
  assert.match(document, /Critical tests with a PASS: 3 of 3 \(100\.0 percent\)/);
  assert.match(document, /\| T2 \| Product owner \| The environment for the external adapter is not available \| Head of QA \| 2026-12-31 \| VALID \|/);
  assert.match(document, /\| T9 \|.*\| EXPIRED \|/);
  assert.match(document, /Run: run-7; build abc123; schema version 1365; dataset f{64}/);
  const waivedCritical = coverageOf({ T1: { result: 'NOT_RUN' }, T2: pass(), T3: pass(), T4: pass() }, { waivers: [waiver('T1')] });
  assert.equal(waivedCritical.summary.criticalPass, 2);
  assert.equal(waivedCritical.rows[0].state, 'WAIVED');
});

test('a waiver without an owner, a reason, an approver or a day is incomplete, and one whose day has passed is expired', () => {
  assert.equal(waiverStanding(waiver('T1'), TODAY), 'VALID');
  assert.equal(waiverStanding(waiver('T1', { expires: TODAY }), TODAY), 'VALID');
  assert.equal(waiverStanding(waiver('T1', { expires: '2026-10-24' }), TODAY), 'EXPIRED');
  for (const field of ['owner', 'reason', 'approved_by', 'expires']) assert.equal(waiverStanding(waiver('T1', { [field]: ' ' }), TODAY), 'INCOMPLETE', field);
  assert.equal(waiverStanding(waiver('T1', { expires: 'someday' }), TODAY), 'INCOMPLETE');
  assert.equal(waiverStanding({ target: 'T1', owner: 'x', reason: 'y', approved_by: 'z' }, TODAY), 'INCOMPLETE');
});

test('the states run from the best to the worst and only PASS and WAIVED are complete', () => {
  assert.deepEqual(STATES, ['PASS', 'WAIVED', 'UNPROVEN', 'NOT_RUN', 'SKIPPED', 'FAIL', 'GAP']);
});

function scratch({ results, critical } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-uatev-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'Design/MACHVON_Design/03_Engineering/screen_catalog.json': SCREENS,
    'Design/MACHVON_Design/03_Engineering/traceability.json': TRACEABILITY,
    'Design/MACHVON_Design/03_Engineering/test_cases.json': TESTS,
    ...(results === undefined ? {} : { 'docs/uat-run-results.json': results }),
    ...(critical === undefined ? {} : { 'docs/uat-critical.json': critical }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(content));
  }
  return root;
}

test('the command writes the document, reports the figures and stays green until the gate is asked for', () => {
  const root = scratch({ results: { results: { T1: pass(), T2: pass(), T3: pass() }, runId: 'run-1' }, critical: { areas: CRITICAL } });
  const lines = [];
  assert.equal(main(['--root', root], { log: (line) => lines.push(line), today: TODAY }), 0);
  assert.match(readFileSync(join(root, 'docs', 'UAT-EVIDENCE.md'), 'utf8'), /Run: run-1/);
  assert.match(lines.at(-1), /màn hình hoàn tất 2\/3/);
  const gate = [];
  assert.equal(main(['--root', root, '--gate'], { log: (line) => gate.push(line), today: TODAY }), 1);
  assert.match(gate[0], /BBB-01.*GAP/);
  assert.match(gate.at(-1), /\d+ vấn đề nghiệm thu/);
});

test('the gate passes when every screen and requirement is PASS or validly waived', () => {
  const complete = {
    screens: [SCREENS[0]],
    traceability: [TRACEABILITY[0]],
    tests: TESTS,
    results: { T1: pass(), T2: { result: 'SKIPPED' } },
    waivers: [waiver('T2')],
    critical: CRITICAL,
    today: TODAY,
  };
  const coverage = buildCoverage(complete);
  assert.deepEqual(coverage.failures, []);
  assert.equal(coverage.rows[0].state, 'WAIVED');
});

test('an expired waiver fails the gate by itself, and the check mode says when the document is stale', () => {
  const root = scratch({ results: { results: { T1: pass(), T2: pass(), T3: pass() }, waivers: [waiver('T3', { expires: '2020-01-01' })] }, critical: { areas: {} } });
  const lines = [];
  assert.equal(main(['--root', root, '--gate'], { log: (line) => lines.push(line), today: TODAY }), 1);
  assert.ok(lines.some((line) => /miễn trừ cho T3/.test(line)));
  const stale = [];
  assert.equal(main(['--root', root, '--check'], { log: (line) => stale.push(line), today: TODAY }), 0, stale.join('\n'));
  writeFileSync(join(root, 'docs', 'UAT-EVIDENCE.md'), 'old');
  assert.equal(main(['--root', root, '--check', '--locale', 'en'], { log: (line) => stale.push(line), today: TODAY }), 1);
  assert.ok(stale.some((line) => /out of date/.test(line)));
});

test('the command says which input is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'machvon-uatev-empty-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const lines = [];
  assert.equal(main(['--root', root], { log: (line) => lines.push(line), today: TODAY }), 1);
  assert.match(lines[0], /screen_catalog\.json/);
});

test('the repository document is current and the real design lists every screen with a test or as a GAP', () => {
  const lines = [];
  assert.equal(main(['--root', REPO_ROOT, '--check'], { log: (line) => lines.push(line) }), 0, lines.join('\n'));
});
