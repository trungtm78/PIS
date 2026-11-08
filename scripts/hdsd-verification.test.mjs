import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHAPTERS_PATH, LEDGER_PATH, criterionOf, exitCodeOf, ledgerProblems, loadVisits, main, reportOf, statusOf, stepsOf } from './hdsd/verification.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chapters = JSON.parse(readFileSync(CHAPTERS_PATH, 'utf8'));
const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
const catalogue = JSON.parse(readFileSync(join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json'), 'utf8'));
const catalogueIds = new Set(catalogue.map((screen) => screen.id));

const step = (id, screen, extra = {}) => ({ id, screens: [screen], ops: [{ tap: 'x' }], ...extra });
const chapter = (id, steps, extra = {}) => ({ id, steps, ...extra });
const visit = (screen, status = 'passed', heading = '', evidence = 'e1') => ({ evidence, screen, status, heading });

test('the committed ledger is consistent with the chapters: every step has a pass criterion, every pattern compiles, the evidence is there', () => {
  const { problems: evidenceProblems } = loadVisits(ledger);
  assert.deepEqual(ledgerProblems(chapters, ledger, catalogueIds, evidenceProblems), []);
  for (const { step: entry } of stepsOf(chapters)) assert.ok(criterionOf(entry, ledger) !== undefined, `${entry.id} has no criterion`);
});

test('the steps of the chapter of the directives and the progress tree (DIR-06, MOB-69, MOB-70, MOB-71) have criteria and a state', () => {
  const { visits } = loadVisits(ledger);
  const report = reportOf(chapters, ledger, visits);
  const rows = report.rows.filter((row) => ['DIR-06', 'MOB-69', 'MOB-70', 'MOB-71'].includes(row.screen));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok(['VERIFIED', 'UNTESTED', 'BLOCKED'].includes(row.status), `${row.step}: ${row.status}`);
    const found = stepsOf(chapters).find((entry) => entry.step.id === row.step);
    assert.match(criterionOf(found.step, ledger).pattern, /\S/);
  }
  assert.equal(report.totals.steps, stepsOf(chapters).length);
  assert.equal(report.totals.steps, report.totals.verified + report.totals.failed + report.totals.blocked + report.totals.untested);
  assert.equal(report.totals.failed, 0, 'the walks on record never failed a step of the plan');
});

test('a step is VERIFIED by a passed visit, FAILED by a visit that did not pass, BLOCKED by a reason on record, otherwise UNTESTED', () => {
  const entry = step('mob-09', 'MOB-09', { expect: '^Dự án' });
  assert.deepEqual(statusOf('c', entry, {}, [visit('MOB-09')]), { status: 'VERIFIED', reason: '', evidence: 'e1' });
  assert.equal(statusOf('c', entry, {}, [visit('MOB-09', 'failed'), visit('MOB-09')]).status, 'VERIFIED', 'a later passed visit counts');
  assert.deepEqual(statusOf('c', entry, {}, [visit('MOB-09', 'failed')]), { status: 'FAILED', reason: 'visited with status failed' });
  assert.equal(statusOf('c', entry, {}, [visit('MOB-10')]).status, 'UNTESTED');
  assert.deepEqual(statusOf('c', entry, { blockers: { 'mob-09': 'no data' } }, []), { status: 'BLOCKED', reason: 'no data' });
  assert.deepEqual(statusOf('c', entry, { blockers: { c: 'chapter blocked' } }, []), { status: 'BLOCKED', reason: 'chapter blocked' });
  assert.equal(statusOf('c', entry, { blockers: { 'mob-09': 'no data' } }, [visit('MOB-09')]).status, 'VERIFIED', 'a measurement beats a blocker');
});

test('a criterion that was written from a walk is checked against the heading of that walk', () => {
  const entry = step('mob-02', 'MOB-02');
  const withCriterion = { criteria: { 'mob-02': { pattern: '^Đăng nhập', confirmedBy: 'e1' } } };
  assert.equal(statusOf('c', entry, withCriterion, [visit('MOB-02', 'passed', 'Đăng nhập')]).status, 'VERIFIED');
  assert.match(statusOf('c', entry, withCriterion, [visit('MOB-02', 'passed', 'Welcome')]).reason, /heading of the passed visit does not match/);
  assert.equal(statusOf('c', entry, withCriterion, [visit('MOB-02', 'passed', 'Đăng nhập', 'other')]).status, 'FAILED', 'the confirming evidence has no passed visit');
  assert.equal(statusOf('c', entry, { criteria: { 'mob-02': { pattern: '(' , confirmedBy: 'e1' } } }, [visit('MOB-02', 'passed', 'x')]).status, 'FAILED');
  // Without confirmedBy the pattern is a plan: a passed visit verifies the step whatever its heading.
  assert.equal(statusOf('c', entry, { criteria: { 'mob-02': { pattern: 'plan' } } }, [visit('MOB-02', 'passed', 'anything')]).status, 'VERIFIED');
});

test('the ledger is reported wrong in each way it can be wrong', () => {
  const plan = [chapter('c1', [step('mob-01', 'MOB-01', { expect: 'x' }), step('mob-02', 'MOB-02'), step('mob-03', 'MOB-03', { expect: 'y' }), step('mob-04', 'NOPE-1', { expect: 'z' })], { needs: ['data'] }), chapter('c2', [step('mob-05', 'MOB-05', { ops: [{ run: 'conflict' }] })])];
  const bad = {
    evidence: [{ id: 'a', path: 'x' }, { id: 'a', path: 'y' }],
    criteria: { 'mob-01': { pattern: 'override' }, ghost: { pattern: 'p' }, 'mob-03': { pattern: '' }, 'mob-02': { pattern: '(', confirmedBy: 'missing' } },
    blockers: { nothing: 'reason', 'mob-02': ' ' },
  };
  const problems = ledgerProblems(plan, bad, catalogueIds);
  for (const expected of [
    'mob-01: the step has an expect already' ,
    'criteria ghost: there is no such step',
    'criteria mob-02: confirmedBy missing is not an evidence of the ledger',
    'mob-02 (c1): the criterion ( is not a valid pattern',
    'mob-04: NOPE-1 is not in the catalogue',
    'blockers nothing: there is no such step or chapter',
    'blockers mob-02: no reason',
    'evidence: an id is used twice',
    'c2: a step runs a command of the data maker but the chapter lists no needs',
    'mob-05 (c2): no pass criterion; give the step an expect or add it to criteria of the ledger',
  ]) assert.ok(problems.some((problem) => problem.includes(expected)), `missing: ${expected}\n${problems.join('\n')}`);
  assert.ok(problems.some((problem) => problem.startsWith('criteria mob-03: no pattern')));
});

test('loadVisits reports a missing, unreadable or empty evidence file and reads the visits of a good one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdsd-verify-'));
  try {
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ visits: [{ id: 'MOB-09', status: 'passed', heading: 'Dự án' }, { status: 'passed' }] }));
    writeFileSync(join(dir, 'bad.json'), '{not json');
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ label: 'x' }));
    const result = loadVisits({ evidence: [{ id: 'good', path: 'good.json' }, { id: 'bad', path: 'bad.json' }, { id: 'empty', path: 'empty.json' }, { id: 'gone', path: 'gone.json' }] }, [], dir);
    assert.deepEqual(result.visits, [{ evidence: 'good', screen: 'MOB-09', status: 'passed', heading: 'Dự án' }]);
    assert.deepEqual(result.problems.map((problem) => problem.replace(dir, '').replace(/\\/g, '/')), ['evidence bad: not valid JSON', 'evidence empty: no visits', 'evidence gone: /gone.json does not exist']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scoring a new walk against the plan: passed visits verify, a failed visit fails, --require-verified fails what is not seen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdsd-verify-'));
  try {
    const plan = [chapter('c1', [step('mob-01', 'MOB-01', { expect: '^A' }), step('mob-02', 'MOB-02', { expect: '^B' })])];
    writeFileSync(join(dir, 'chapters.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ evidence: [] }));
    const walk = (visits) => {
      const path = join(dir, `walk-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(path, JSON.stringify({ visits }));
      return path;
    };
    const lines = [];
    const run = (args) => main(args, { log: (line) => lines.push(line), chaptersPath: join(dir, 'chapters.json'), ledgerPath: join(dir, 'ledger.json'), root: dir });
    const all = walk([{ id: 'MOB-01', status: 'passed' }, { id: 'MOB-02', status: 'passed' }]);
    const part = walk([{ id: 'MOB-01', status: 'passed' }]);
    const failed = walk([{ id: 'MOB-01', status: 'passed' }, { id: 'MOB-02', status: 'failed' }]);
    assert.equal(run(['--walk', all, '--require-verified']), 0);
    assert.equal(lines.at(-1), '2 steps: 2 verified, 0 failed, 0 blocked, 0 untested');
    assert.equal(run(['--walk', part]), 0, 'untested steps do not fail a plain check');
    assert.equal(run(['--walk', part, '--require-verified']), 1);
    assert.ok(lines.some((line) => line.startsWith('not verified: mob-02 (UNTESTED)')));
    assert.equal(run(['--walk', failed]), 1);
    assert.equal(run(['--walk', `${dir}/missing.json`]), 1, 'an evidence that does not exist is a problem');
    assert.equal(run(['--walk', all, '--list']), 0);
    assert.ok(lines.some((line) => /^VERIFIED\s+c1\s+mob-01/.test(line)));
    assert.equal(run(['--bogus']), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exitCodeOf: problems and failures are 1, untested is 1 only when everything must be verified', () => {
  const report = (totals) => ({ totals: { steps: 3, verified: 3, failed: 0, blocked: 0, untested: 0, ...totals } });
  assert.equal(exitCodeOf([], report({}), true), 0);
  assert.equal(exitCodeOf(['p'], report({}), false), 1);
  assert.equal(exitCodeOf([], report({ failed: 1, verified: 2 }), false), 1);
  assert.equal(exitCodeOf([], report({ untested: 1, verified: 2 }), false), 0);
  assert.equal(exitCodeOf([], report({ untested: 1, verified: 2 }), true), 1);
});

test('the blocker of the conflict step stands only while the data command conflict is not made', () => {
  const run = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'hdsd', 'mobile-data.mjs'), 'conflict'], { encoding: 'utf8' });
  const notMade = run.status === 1 && /not made yet/.test(run.stderr);
  assert.equal(notMade, ledger.blockers?.['mob-42'] !== undefined, 'remove the blocker of mob-42 when the command conflict exists, or restore it when it does not');
});
