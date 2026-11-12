import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTests, handoffFailures, renderCoverage, traceCoverage, main } from './uat-trace.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanups = [];

// The protocol scan bans literal skipped-test calls in added lines, so the fixtures spell the calls out piece by piece.
const skipped = (callee) => `${callee}.${'skip'}`;
const prefixed = (callee) => `x${callee}`;

process.on('exit', () => cleanups.forEach((clean) => clean()));

const PLAN = {
  stories: [
    { id: 'ST-AAA-001', release: 'R0', acceptance: [{ id: 'AC-ST-AAA-001-1' }, { id: 'AC-ST-AAA-001-2' }] },
    { id: 'ST-BBB-002', release: 'R0', acceptance: [{ id: 'AC-ST-BBB-002-1' }] },
    { id: 'ST-CCC-003', release: 'R1', acceptance: [{ id: 'AC-ST-CCC-003-1' }] },
  ],
};

/** A scratch repository: the plan, an optional status file and the given source files. */
function scratch(files, { plan = PLAN, status = { stories: { 'ST-AAA-001': 'DONE' } } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-uat-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const all = { 'plan.json': JSON.stringify(plan), ...(status === null ? {} : { 'docs/story-status.json': JSON.stringify(status) }), ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, plan: join(root, 'plan.json'), out: join(root, 'docs', 'UAT-COVERAGE.md') };
}

const COVERING = `
describe('first story', () => {
  it('rejects a wrong key (AC-ST-AAA-001-1)', () => {});
  it('AC-ST-AAA-001-2: replays the answer', () => {});
});
`;

const trace = (tree) => traceCoverage({ root: tree.root, planPath: tree.plan });
const resultOf = (result, id) => result.rows.find((row) => row.id === id).result;

test('extractTests reads it, test and describe titles in every quoting style, over several lines and with concatenation', () => {
  const source = [
    "it('single', () => {});",
    'test("double", () => {});',
    'describe(`template`, () => {});',
    'it(',
    "  'on the next line',",
    '  () => {},',
    ');',
    "it('joined ' + 'title', () => {});",
    "it('escaped \\' quote', () => {});",
  ].join('\n');
  assert.deepEqual(
    extractTests(source).map((entry) => entry.title),
    ['single', 'double', 'template', 'on the next line', 'joined title', "escaped ' quote"],
  );
});

test('extractTests reads Playwright and Dart styles and the title of an each table', () => {
  const source = [
    "test.describe('walk', () => {});",
    "test.describe.serial('serial', () => {});",
    "group('dart group', () => {});",
    "it.each([[1, 2]])('table %s', () => {});",
    "describe.each<Row>([[1]])('typed table', () => {});",
  ].join('\n');
  assert.deepEqual(
    extractTests(source).map((entry) => entry.title),
    ['walk', 'serial', 'dart group', 'table %s', 'typed table'],
  );
});

test('extractTests ignores comments, string contents and calls without a literal title', () => {
  const source = [
    "// it('commented out (AC-ST-AAA-001-1)', () => {});",
    "/* it('block comment', () => {}); */",
    "const fixture = \"it('inside a string', () => {})\";",
    'const template = `',
    "  it('inside a template', () => {});",
    '`;',
    `${skipped('test')}(!process.env.CI, 'a runtime condition has no title');`,
    'it(titleVariable, () => {});',
    "it('real', () => {});",
  ].join('\n');
  assert.deepEqual(extractTests(source), [{ title: 'real', skipped: false }]);
});

test('extractTests keeps going after a regular expression, a division and an apostrophe in JSX text', () => {
  const source = [
    "expect(value).toMatch(/it\\('x'\\)/);",
    'const ratio = total / count / 2;',
    "const view = <p>don't</p>;",
    "it('after the noise', () => {});",
  ].join('\n');
  assert.deepEqual(extractTests(source).map((entry) => entry.title), ['after the noise']);
});

test('extractTests keeps going after a self-closing JSX tag that is followed on its line by a template with a slash', () => {
  const source = [
    'const open = () => mount(<Screen route={ROUTE} />, { signIn }, `/iam/iam-01?until=${until}`);',
    "it('after the tag', () => {});",
    "it('and another one', () => {});",
  ].join('\n');
  assert.deepEqual(extractTests(source).map((entry) => entry.title), ['after the tag', 'and another one']);
});

test('extractTests flags every skipped form and the tests inside a skipped describe', () => {
  const source = [
    `${skipped('it')}('a', () => {});`,
    `${prefixed('it')}('b', () => {});`,
    `${skipped('test')}('c', () => {});`,
    "test.fixme('d', () => {});",
    "it.todo('e');",
    "it.skipIf(process.platform === 'win32')('f', () => {});",
    `${prefixed('describe')}('g', () => { it('inside g', () => {}); });`,
    `${skipped('describe')}('h', () => { describe('nested', () => { it('inside h', () => {}); }); });`,
    "it('live', () => {});",
  ].join('\n');
  const flags = Object.fromEntries(extractTests(source).map((entry) => [entry.title, entry.skipped]));
  assert.deepEqual(flags, {
    a: true,
    b: true,
    c: true,
    d: true,
    e: true,
    f: true,
    g: true,
    'inside g': true,
    h: true,
    nested: true,
    'inside h': true,
    live: false,
  });
});

test('a criterion named in a test title is covered, one that no title names is missing', () => {
  const tree = scratch({ 'apps/api/test/first.test.ts': "it('only the first (AC-ST-AAA-001-1)', () => {});" });
  const result = trace(tree);
  assert.equal(resultOf(result, 'AC-ST-AAA-001-1'), 'COVERED');
  assert.equal(resultOf(result, 'AC-ST-AAA-001-2'), 'MISSING');
  assert.equal(resultOf(result, 'AC-ST-BBB-002-1'), 'MISSING');
  assert.deepEqual(result.rows.find((row) => row.id === 'AC-ST-AAA-001-1').tests, [{ file: 'apps/api/test/first.test.ts', title: 'only the first (AC-ST-AAA-001-1)', skipped: false }]);
});

test('the same id in two tests lists both and still counts once', () => {
  const tree = scratch({
    'apps/api/test/a.test.ts': "it('one (AC-ST-AAA-001-1)', () => {});",
    'packages/kernel/test/b.test.ts': "it('two AC-ST-AAA-001-1 and AC-ST-AAA-001-2', () => {});",
  });
  const result = trace(tree);
  assert.deepEqual(
    result.rows.find((row) => row.id === 'AC-ST-AAA-001-1').tests.map((entry) => entry.file),
    ['apps/api/test/a.test.ts', 'packages/kernel/test/b.test.ts'],
  );
  assert.equal(result.summary.covered, 2);
  assert.equal(resultOf(result, 'AC-ST-AAA-001-2'), 'COVERED');
});

test('an id that only a skipped test names is not coverage, a live test beside it makes it covered', () => {
  const tree = scratch({
    'apps/api/test/skipped.test.ts': `${skipped('it')}('later (AC-ST-AAA-001-1)', () => {});\n${skipped('describe')}('group', () => { it('AC-ST-AAA-001-2', () => {}); });`,
  });
  const result = trace(tree);
  assert.equal(resultOf(result, 'AC-ST-AAA-001-1'), 'SKIPPED');
  assert.equal(resultOf(result, 'AC-ST-AAA-001-2'), 'SKIPPED');
  assert.equal(result.summary.covered, 0);
  assert.equal(result.summary.skipped, 2);
  const withLive = scratch({
    'apps/api/test/skipped.test.ts': `${skipped('it')}('later (AC-ST-AAA-001-1)', () => {});`,
    'apps/api/test/live.test.ts': "it('now (AC-ST-AAA-001-1)', () => {});",
  });
  assert.equal(resultOf(trace(withLive), 'AC-ST-AAA-001-1'), 'COVERED');
});

test('the gate fails for a DONE story with a missing or skipped id and ignores the other statuses and releases', () => {
  const tree = scratch({ 'apps/api/test/a.test.ts': `${skipped('it')}('AC-ST-AAA-001-1', () => {});` });
  const result = trace(tree);
  assert.deepEqual(
    result.failures.map((failure) => [failure.code, failure.id]),
    [
      ['UNCOVERED_SKIPPED', 'AC-ST-AAA-001-1'],
      ['UNCOVERED_MISSING', 'AC-ST-AAA-001-2'],
    ],
  );
  assert.equal(result.summary.gatedIds, 2);
  assert.equal(result.summary.gatedCovered, 0);
  const notDone = scratch({}, { status: { stories: { 'ST-AAA-001': 'PARTIAL', 'ST-BBB-002': 'NOT STARTED' } } });
  assert.deepEqual(trace(notDone).failures, []);
  const noStatusFile = scratch({}, { status: null });
  assert.deepEqual(trace(noStatusFile).failures, []);
});

test('the gate also holds DONE_PENDING_ENV and DONE_UNCONFIRMED stories, and says which status it enforced', () => {
  for (const status of ['DONE_PENDING_ENV', 'DONE_UNCONFIRMED']) {
    const tree = scratch({ 'apps/api/test/a.test.ts': "it('AC-ST-AAA-001-1', () => {});" }, { status: { stories: { 'ST-AAA-001': status } } });
    const result = trace(tree);
    assert.deepEqual(result.failures.map((failure) => [failure.code, failure.id, failure.status]), [['UNCOVERED_MISSING', 'AC-ST-AAA-001-2', status]]);
    assert.equal(result.summary.gatedStories, 1);
  }
});

test('a DONE_PENDING_ENV or DONE_UNCONFIRMED story may declare the ids that only an external system proves; no other status may', () => {
  const external = { 'AC-ST-AAA-001-2': 'a real CA sandbox' };
  const files = { 'apps/api/test/a.test.ts': "it('AC-ST-AAA-001-1', () => {});" };
  const pending = scratch(files, { status: { stories: { 'ST-AAA-001': 'DONE_PENDING_ENV' }, externalChecks: external } });
  const result = traceCoverage({ root: pending.root, planPath: pending.plan });
  assert.deepEqual(result.failures, []);
  assert.equal(result.summary.gatedIds, 2);
  assert.equal(result.summary.gatedCovered, 1);
  assert.equal(result.summary.gatedExternal, 1);
  assert.match(renderCoverage(result), /## External checks[\s\S]*\| AC-ST-AAA-001-2 \| ST-AAA-001 \| a real CA sandbox \|/);

  const unconfirmed = scratch(files, { status: { stories: { 'ST-AAA-001': 'DONE_UNCONFIRMED' }, externalChecks: external } });
  assert.deepEqual(traceCoverage({ root: unconfirmed.root, planPath: unconfirmed.plan }).failures, []);

  for (const status of ['DONE', 'PARTIAL']) {
    const tree = scratch(files, { status: { stories: { 'ST-AAA-001': status }, externalChecks: external } });
    const codes = trace(tree).failures.map((failure) => [failure.code, failure.id]);
    assert.ok(codes.some(([code, id]) => code === 'EXTERNAL_MISPLACED' && id === 'AC-ST-AAA-001-2'), status);
    if (status !== 'PARTIAL') assert.ok(codes.some(([code]) => code === 'UNCOVERED_MISSING'), status);
  }
});

test('an external check that no story defines, that a live test now covers or that says nothing fails the gate', () => {
  const status = (externalChecks) => ({ status: { stories: { 'ST-AAA-001': 'DONE_PENDING_ENV' }, externalChecks } });
  const codesOf = (tree) => trace(tree).failures.map((failure) => [failure.code, failure.id]);
  assert.deepEqual(codesOf(scratch({ 'apps/api/test/a.test.ts': COVERING }, status({ 'AC-ST-AAA-001-1': 'was external' }))), [['EXTERNAL_COVERED', 'AC-ST-AAA-001-1']]);
  assert.deepEqual(codesOf(scratch({ 'apps/api/test/a.test.ts': COVERING }, status({ 'AC-ST-ZZZ-009-1': 'a typo' }))), [['EXTERNAL_UNKNOWN', 'AC-ST-ZZZ-009-1']]);
  assert.deepEqual(codesOf(scratch({}, status({ 'AC-ST-AAA-001-1': '', 'AC-ST-AAA-001-2': 'a CA' }))), [['UNCOVERED_MISSING', 'AC-ST-AAA-001-1'], ['EXTERNAL_NO_CHECK', 'AC-ST-AAA-001-1']]);
});

test('only the selected releases are listed', () => {
  const tree = scratch({});
  assert.deepEqual(traceCoverage({ root: tree.root, planPath: tree.plan, releases: ['R0'] }).rows.map((row) => row.id), ['AC-ST-AAA-001-1', 'AC-ST-AAA-001-2', 'AC-ST-BBB-002-1']);
  // The repository traces the foundations (R0) and the breadth (R1) by default.
  assert.equal(trace(tree).rows.length, 4);
  assert.equal(traceCoverage({ root: tree.root, planPath: tree.plan, releases: ['R1'] }).rows.length, 1);
});

test('an id in a title that no story defines is a typo and fails the gate', () => {
  const tree = scratch({ 'apps/api/test/a.test.ts': "it('typo (AC-ST-AAA-001-9)', () => {});" });
  assert.deepEqual(trace(tree).failures.map((failure) => [failure.code, failure.id]).filter(([code]) => code === 'UNKNOWN_ID'), [['UNKNOWN_ID', 'AC-ST-AAA-001-9']]);
});

test('an id that the plan defines twice, an unknown story and an invalid status fail the gate', () => {
  const duplicated = scratch({}, { plan: { stories: [...PLAN.stories, { id: 'ST-DDD-004', release: 'R0', acceptance: [{ id: 'AC-ST-AAA-001-1' }] }] } });
  assert.ok(trace(duplicated).failures.some((failure) => failure.code === 'DUPLICATE_PLAN_ID' && failure.id === 'AC-ST-AAA-001-1'));
  const status = scratch({}, { status: { stories: { 'ST-NOPE-999': 'DONE', 'ST-BBB-002': 'FINISHED' } } });
  const codes = trace(status).failures.map((failure) => [failure.code, failure.id]);
  assert.ok(codes.some(([code, id]) => code === 'STATUS_UNKNOWN_STORY' && id === 'ST-NOPE-999'));
  assert.ok(codes.some(([code, id]) => code === 'STATUS_INVALID' && id === 'ST-BBB-002'));
});

test('files outside test locations, build output and node_modules are not read', () => {
  const tree = scratch({
    'apps/api/src/service.ts': "it('AC-ST-AAA-001-1', () => {});",
    'apps/api/test/node_modules/x/a.test.ts': "it('AC-ST-AAA-001-2', () => {});",
    'packages/kernel/dist/b.test.js': "it('AC-ST-BBB-002-1', () => {});",
  });
  assert.equal(trace(tree).summary.covered, 0);
});

test('test helpers under test and e2e directories and Dart tests are read', () => {
  const tree = scratch({
    'apps/api/test/auth/token.contract.ts': "describe('AC-ST-AAA-001-1', () => {});",
    'apps/web/e2e/walk.spec.ts': "test('AC-ST-AAA-001-2', async () => {});",
    'packages/mobile-api-client/test/client_test.dart': "test('AC-ST-BBB-002-1 works', () {});",
  });
  assert.equal(trace(tree).summary.covered, 3);
});

test('the document has the four columns, escapes a pipe in a title and is the same on every run and tree order', () => {
  const files = {
    'apps/api/test/a.test.ts': "it('pipe | in title (AC-ST-AAA-001-1)', () => {});",
    'packages/kernel/test/b.test.ts': "it('AC-ST-AAA-001-1 again', () => {});\nit('AC-ST-BBB-002-1', () => {});",
  };
  const first = renderCoverage(trace(scratch(files)));
  const reversed = renderCoverage(trace(scratch(Object.fromEntries(Object.entries(files).reverse()))));
  assert.equal(first, reversed);
  assert.equal(first, renderCoverage(trace(scratch(files))));
  assert.match(first, /\| ID \| story \| test \| result \|/);
  assert.ok(first.includes('pipe \\| in title'));
  assert.ok(first.includes('| AC-ST-AAA-001-2 | ST-AAA-001 | - | MISSING |'));
  assert.ok(first.endsWith('\n'));
  assert.equal(first.includes('\r'), false);
});

test('main writes the document and exits 0 when every DONE story is covered, then leaves the bytes alone on a rerun', () => {
  const tree = scratch({ 'apps/api/test/a.test.ts': COVERING });
  const lines = [];
  const args = ['--root', tree.root, '--plan', tree.plan, '--out', tree.out, '--locale', 'en', '--releases', 'R0'];
  assert.equal(main(args, { log: (line) => lines.push(line) }), 0);
  const first = readFileSync(tree.out, 'utf8');
  assert.match(lines.join('\n'), /2 of 3/);
  assert.equal(main(args, { log: () => undefined }), 0);
  assert.equal(readFileSync(tree.out, 'utf8'), first);
});

test('main exits 1, names the missing id and still writes the document when a DONE story lacks a test title', () => {
  const tree = scratch({ 'apps/api/test/a.test.ts': "it('AC-ST-AAA-001-1', () => {});" });
  const lines = [];
  assert.equal(main(['--root', tree.root, '--plan', tree.plan, '--out', tree.out, '--locale', 'en'], { log: (line) => lines.push(line) }), 1);
  assert.ok(lines.some((line) => line.includes('AC-ST-AAA-001-2')));
  assert.match(readFileSync(tree.out, 'utf8'), /AC-ST-AAA-001-2 \| ST-AAA-001 \| - \| MISSING/);
});

test('main --check fails when the document on disk is stale and does not touch it', () => {
  const tree = scratch({ 'apps/api/test/a.test.ts': COVERING });
  const args = ['--root', tree.root, '--plan', tree.plan, '--out', tree.out, '--locale', 'en'];
  assert.equal(main([...args, '--check'], { log: () => undefined }), 1);
  assert.throws(() => readFileSync(tree.out, 'utf8'));
  main(args, { log: () => undefined });
  assert.equal(main([...args, '--check'], { log: () => undefined }), 0);
  writeFileSync(join(tree.root, 'apps', 'api', 'test', 'b.test.ts'), "it('more (AC-ST-BBB-002-1)', () => {});");
  const lines = [];
  assert.equal(main([...args, '--check'], { log: (line) => lines.push(line) }), 1);
  assert.ok(lines.some((line) => line.includes('uat:trace')));
});

test('main reports a missing plan', () => {
  const tree = scratch({});
  const lines = [];
  assert.equal(main(['--root', tree.root, '--plan', join(tree.root, 'absent.json'), '--out', tree.out, '--locale', 'en'], { log: (line) => lines.push(line) }), 1);
  assert.equal(lines.length, 1);
});

test('every message exists in both catalogues', () => {
  for (const locale of ['vi', 'en']) {
    const messages = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'messages', `${locale}.json`), 'utf8'));
    const keys = Object.keys(messages).filter((key) => key.startsWith('uat.'));
    assert.ok(keys.length >= 10, locale);
    for (const key of ['uat.UNCOVERED_MISSING', 'uat.UNCOVERED_SKIPPED', 'uat.UNKNOWN_ID', 'uat.DUPLICATE_PLAN_ID', 'uat.STATUS_UNKNOWN_STORY', 'uat.STATUS_INVALID', 'uat.summary.pass', 'uat.summary.fail', 'uat.stale', 'uat.plan.missing', 'uat.EXTERNAL_UNKNOWN', 'uat.EXTERNAL_MISPLACED', 'uat.EXTERNAL_COVERED', 'uat.EXTERNAL_NO_CHECK']) {
      assert.ok(messages[key], `${locale} ${key}`);
    }
  }
});

const ENGINEERING = join('Design', 'MACHVON_Design', '03_Engineering');
const handoffTree = (cases, extra = {}) =>
  scratch({
    [join(ENGINEERING, 'screen_catalog.json')]: JSON.stringify([{ id: 'HPM-01' }]),
    [join(ENGINEERING, 'test_cases.json')]: JSON.stringify([{ id: 'UAT-HPM-E2E-01' }, { id: 'UAT-HPM-SEC-01' }]),
    [join('docs', 'uat', 'hpm', 'uat.json')]: JSON.stringify({ test_cases: cases }),
    ...extra,
  });
const codes = (tree) => handoffFailures({ root: tree.root, plan: PLAN }).map((failure) => `${failure.code} ${failure.id}`);

test('a handoff case that names a screen, a story and a design case that exist, with a script that names it, raises nothing', () => {
  const tree = handoffTree(
    [{ tc_id: 'TC-UAT-HPM-E2E-01', screen_id: 'HPM-01', story_ids: ['ST-AAA-001'], automation: { state: 'AUTOMATED', suite: 'apps/api/test/uat/hpm.uat.test.ts' } }],
    { 'apps/api/test/uat/hpm.uat.test.ts': "it('UAT-HPM-E2E-01 pushes', () => {});" },
  );
  assert.deepEqual(codes(tree), []);
});

test('a handoff case that names a screen, a story or a design case that does not exist is reported, so is a case that is in two files', () => {
  const tree = handoffTree(
    [
      { tc_id: 'TC-UAT-HPM-NOPE-01', screen_id: 'HPM-99', story_ids: ['ST-ZZZ-009'], automation: { state: 'MANUAL', reason: 'by hand' } },
      { tc_id: 'TC-UAT-HPM-E2E-01', automation: { state: 'MANUAL', reason: 'by hand' } },
    ],
    { [join('docs', 'uat', 'ebs', 'uat.json')]: JSON.stringify({ test_cases: [{ tc_id: 'TC-UAT-HPM-E2E-01' }] }) },
  );
  const found = codes(tree);
  assert.ok(found.includes('HANDOFF_CASE_UNKNOWN TC-UAT-HPM-NOPE-01'));
  assert.ok(found.includes('HANDOFF_SCREEN_UNKNOWN HPM-99'));
  assert.ok(found.includes('HANDOFF_STORY_UNKNOWN ST-ZZZ-009'));
  assert.ok(found.includes('HANDOFF_DUPLICATE TC-UAT-HPM-E2E-01'));
});

test('a case that claims a script is reported when the script is missing or does not name it, and is accepted when the table the script reads does', () => {
  const tree = handoffTree(
    [
      { tc_id: 'TC-UAT-HPM-E2E-01', automation: { state: 'AUTOMATED', suite: 'apps/api/test/uat/absent.test.ts' } },
      { tc_id: 'TC-UAT-HPM-SEC-01', automation: { state: 'AUTOMATED', suite: 'apps/api/test/uat/hpm.uat.test.ts' } },
    ],
    { 'apps/api/test/uat/hpm.uat.test.ts': "it('names another case', () => {});" },
  );
  assert.deepEqual(codes(tree), ['HANDOFF_AUTOMATION_MISSING TC-UAT-HPM-E2E-01', 'HANDOFF_AUTOMATION_MISSING TC-UAT-HPM-SEC-01']);
  const withTable = handoffTree([{ tc_id: 'TC-UAT-HPM-SEC-01', automation: { state: 'AUTOMATED', suite: 'apps/api/test/uat/hpm.uat.test.ts', registry: 'apps/api/test/uat/ops.json' } }], {
    'apps/api/test/uat/hpm.uat.test.ts': "it('the matrix', () => {});",
    'apps/api/test/uat/ops.json': '[{"id":"UAT-HPM-SEC-01"}]',
  });
  assert.deepEqual(codes(withTable), []);
  // The table does not stand in for a script that is gone.
  const withoutScript = handoffTree([{ tc_id: 'TC-UAT-HPM-SEC-01', automation: { state: 'AUTOMATED', suite: 'apps/api/test/uat/gone.test.ts', registry: 'apps/api/test/uat/ops.json' } }], { 'apps/api/test/uat/ops.json': '[{"id":"UAT-HPM-SEC-01"}]' });
  assert.deepEqual(codes(withoutScript), ['HANDOFF_AUTOMATION_MISSING TC-UAT-HPM-SEC-01']);
  const noSuiteAtAll = handoffTree([{ tc_id: 'TC-UAT-HPM-SEC-01', automation: { state: 'AUTOMATED', registry: 'apps/api/test/uat/ops.json' } }], { 'apps/api/test/uat/ops.json': '[{"id":"UAT-HPM-SEC-01"}]' });
  assert.deepEqual(codes(noSuiteAtAll), ['HANDOFF_AUTOMATION_MISSING TC-UAT-HPM-SEC-01']);
});

test('the slice of critical cases may repeat the ids of the module folders, and a repository with no handoff files raises nothing', () => {
  const tree = handoffTree([{ tc_id: 'TC-UAT-HPM-E2E-01' }], { [join('docs', 'uat', 'critical', 'uat.json')]: JSON.stringify({ test_cases: [{ tc_id: 'TC-UAT-HPM-E2E-01' }] }) });
  assert.deepEqual(codes(tree), []);
  assert.deepEqual(handoffFailures({ root: scratch({}).root, plan: PLAN }), []);
  const folderWithoutFile = scratch({ [join(ENGINEERING, 'screen_catalog.json')]: '[]', [join('docs', 'uat', 'empty', 'note.md')]: 'nothing' });
  assert.deepEqual(handoffFailures({ root: folderWithoutFile.root, plan: PLAN }), []);
});

test('the handoff failures reach the command line and are worded in both languages', () => {
  const tree = handoffTree([{ tc_id: 'TC-UAT-HPM-E2E-01', screen_id: 'HPM-99' }]);
  const lines = [];
  assert.equal(main(['--root', tree.root, '--plan', tree.plan, '--out', tree.out, '--check', '--locale', 'en'], { log: (line) => lines.push(line) }), 1);
  assert.ok(lines.some((line) => line.includes('HPM-99')));
  for (const locale of ['vi', 'en']) {
    const messages = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'messages', `${locale}.json`), 'utf8'));
    for (const code of ['HANDOFF_DUPLICATE', 'HANDOFF_CASE_UNKNOWN', 'HANDOFF_SCREEN_UNKNOWN', 'HANDOFF_STORY_UNKNOWN', 'HANDOFF_AUTOMATION_MISSING']) assert.ok(messages[`uat.${code}`], `${locale} ${code}`);
  }
});

test('the repository passes its own gate and the committed UAT-COVERAGE.md is current', () => {
  const lines = [];
  assert.equal(main(['--root', REPO_ROOT, '--check', '--locale', 'en'], { log: (line) => lines.push(line) }), 0, lines.join('\n'));
});
