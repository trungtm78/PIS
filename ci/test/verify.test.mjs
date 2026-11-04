import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRun, resolveBase, runVerification, EMPTY_TREE } from '../src/verify.mjs';
import { formatReport } from '../src/report.mjs';
import { loadMessages } from '../src/i18n.mjs';

const GOOD_PROGRESS = [
  'STATUS: IN_PROGRESS', '# PROGRESS', 'Cập nhật: x',
  '## Đã hoàn thành', '## Đang làm dở', '## Hàng đợi task kế tiếp', '## Quyết định kiến trúc',
  '## Assumption đã tự quyết', '## Trạng thái test', '## Nợ kỹ thuật / rủi ro',
  'BƯỚC TIẾP THEO: next',
].join('\n');

function workspace({ progress = GOOD_PROGRESS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pis-verify-'));
  writeFileSync(join(root, 'PROGRESS.md'), progress);
  mkdirSync(join(root, 'work'));
  return root;
}

function fakeRunner(responses) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    const key = Object.keys(responses).find((pattern) => calls.at(-1).includes(pattern));
    return key ? responses[key] : { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const OK = { status: 0, stdout: '', stderr: '' };

test('resolveBase handles explicit refs, CI zero shas and the missing-remote case', () => {
  const git = (known) => (command, args) =>
    command === 'git' && args.includes('--verify') && known.includes(args.at(-1)) ? OK : { status: 1, stdout: '', stderr: '' };
  assert.equal(resolveBase({ explicit: 'abc123', run: git([]) }), 'abc123');
  assert.equal(resolveBase({ explicit: '0'.repeat(40), run: git([]) }), EMPTY_TREE);
  assert.equal(resolveBase({ githubBaseRef: 'main', run: git(['origin/main']) }), 'origin/main');
  assert.equal(resolveBase({ run: git(['origin/main']) }), 'origin/main');
  assert.equal(resolveBase({ run: git([]) }), EMPTY_TREE);
});

test('a clean change set passes every required stage', () => {
  const root = workspace();
  const { run } = fakeRunner({
    'diff ': { status: 0, stdout: 'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1,1 +1,1 @@\n+export const a = 1;\n', stderr: '' },
    'log ': { status: 0, stdout: 'feat: add a\n', stderr: '' },
  });
  const result = runVerification({ root, base: 'origin/main', run, config: { stages: { designCheck: { required: false } } } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stages.map((s) => s.name), ['protocol-scan', 'progress', 'commits', 'design-tests', 'design-check', 'baseline-preservation', 'sql-verify', 'product-tests', 'mobile-tests', 'review-labels']);
  assert.ok(result.stages.every((s) => ['pass', 'reported', 'skipped'].includes(s.status)));
});

test('review-labels is skipped locally because a pre-push run has no pull request context', () => {
  const root = workspace();
  const { run } = fakeRunner({});
  const result = runVerification({ root, base: 'origin/main', run });
  const stage = result.stages.find((s) => s.name === 'review-labels');
  assert.equal(stage.status, 'skipped');
  assert.deepEqual(stage.findings, []);
  assert.match(formatReport(result.stages, loadMessages('en')), /SKIPPED.*review-labels - Human review labels/);
});

test('forbidden patterns, bad progress, bad commits and failing tests each fail their stage', () => {
  const root = workspace({ progress: 'no status here' });
  const { run } = fakeRunner({
    'diff ': { status: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n+// @ts-ignore\n', stderr: '' },
    'log ': { status: 0, stdout: 'Fix things\n', stderr: '' },
    'run test': { status: 1, stdout: 'not ok', stderr: '' },
  });
  const result = runVerification({ root, base: 'b', run, config: { stages: { designCheck: { required: false } } } });
  assert.equal(result.exitCode, 1);
  const status = Object.fromEntries(result.stages.map((s) => [s.name, s.status]));
  // design-check succeeds in this scenario (the fake runner defaults to exit 0), so it passes.
  assert.deepEqual(status, { 'protocol-scan': 'fail', progress: 'fail', commits: 'fail', 'design-tests': 'fail', 'design-check': 'pass', 'baseline-preservation': 'pass', 'sql-verify': 'pass', 'product-tests': 'skipped', 'mobile-tests': 'skipped', 'review-labels': 'skipped' });
});

test('a required design-check stage fails the run; a non-required one only reports (AC-ST-KERNEL-010-3)', () => {
  const root = workspace();
  const responses = { 'check-cli': { status: 1, stdout: '239 errors', stderr: '' } };
  const required = runVerification({ root, base: 'b', run: fakeRunner(responses).run, config: { stages: { designCheck: { required: true } } } });
  assert.equal(required.exitCode, 1);
  const optional = runVerification({ root, base: 'b', run: fakeRunner(responses).run, config: { stages: { designCheck: { required: false } } } });
  assert.equal(optional.exitCode, 0);
  assert.equal(optional.stages.find((s) => s.name === 'design-check').status, 'reported');
});

test('the Codex review stage is skipped unless requested and never counts as a pass', () => {
  const root = workspace();
  const skipped = runVerification({ root, base: 'b', run: fakeRunner({}).run, config: {}, options: {} });
  assert.equal(skipped.stages.some((s) => s.name === 'codex-review'), false);

  const missing = runVerification({ root, base: 'b', run: (cmd) => (cmd === 'codex' ? { status: 127, stdout: '', stderr: 'not found', error: new Error('ENOENT') } : OK), config: {}, options: { codex: true } });
  assert.equal(missing.stages.find((s) => s.name === 'codex-review').status, 'skipped');
  assert.equal(missing.exitCode, 0);

  const blocking = runVerification({ root, base: 'b', run: (cmd) => (cmd === 'codex' ? { status: 0, stdout: '1. High — tenant leak\nRecommendation: fix because it leaks', stderr: '' } : OK), config: {}, options: { codex: true } });
  assert.equal(blocking.stages.find((s) => s.name === 'codex-review').status, 'fail');
  assert.equal(blocking.exitCode, 1);

  const clean = runVerification({ root, base: 'b', run: (cmd) => (cmd === 'codex' ? { status: 0, stdout: 'No findings.\nRecommendation: ship because clean', stderr: '' } : OK), config: {}, options: { codex: true } });
  assert.equal(clean.stages.find((s) => s.name === 'codex-review').status, 'pass');
});

test('formatReport lists stages and findings from message keys', () => {
  const messages = loadMessages('en');
  const text = formatReport(
    [{ name: 'progress', status: 'fail', findings: [{ code: 'PROGRESS_STATUS_INVALID', severity: 'error', messageKey: 'finding.progressStatusInvalid', params: {} }] }],
    messages,
  );
  assert.match(text, /progress/);
  assert.match(text, /FAIL/i);
  assert.match(text, /STATUS/);
});

function shipRunner({ dirty = '', behind = '0', upstream = true, codex }) {
  return (command, args) => {
    const line = [command, ...args].join(' ');
    if (line.startsWith('git status')) return { status: 0, stdout: dirty, stderr: '' };
    if (line.startsWith('git rev-list')) return upstream ? { status: 0, stdout: `${behind}\n`, stderr: '' } : { status: 128, stdout: '', stderr: 'no upstream' };
    if (command === 'codex') return codex ?? { status: 127, stdout: '', stderr: 'missing', error: new Error('ENOENT') };
    return OK;
  };
}

const CLEAN_CODEX = { status: 0, stdout: 'No findings.\nRecommendation: ship because clean', stderr: '' };

test('ship mode passes only with a clean tree, an up-to-date branch and a completed Codex review', () => {
  const root = workspace();
  const ready = runVerification({ root, base: 'b', run: shipRunner({ codex: CLEAN_CODEX }), config: {}, options: { ship: true } });
  assert.equal(ready.exitCode, 0);
  assert.equal(ready.stages.find((s) => s.name === 'ship-readiness').status, 'pass');
  assert.equal(ready.stages.find((s) => s.name === 'codex-review').status, 'pass');
});

test('ship mode fails on uncommitted changes, a branch behind upstream, or a skipped Codex review', () => {
  const root = workspace();
  const dirty = runVerification({ root, base: 'b', run: shipRunner({ dirty: ' M src/a.mjs\n', codex: CLEAN_CODEX }), config: {}, options: { ship: true } });
  assert.deepEqual(dirty.stages.find((s) => s.name === 'ship-readiness').findings.map((f) => f.code), ['SHIP_WORKTREE_DIRTY']);
  assert.equal(dirty.exitCode, 1);

  const behind = runVerification({ root, base: 'b', run: shipRunner({ behind: '3', codex: CLEAN_CODEX }), config: {}, options: { ship: true } });
  assert.deepEqual(behind.stages.find((s) => s.name === 'ship-readiness').findings.map((f) => f.code), ['SHIP_BEHIND_UPSTREAM']);

  const noCodex = runVerification({ root, base: 'b', run: shipRunner({}), config: {}, options: { ship: true } });
  assert.equal(noCodex.stages.find((s) => s.name === 'codex-review').status, 'fail');
  assert.equal(noCodex.exitCode, 1);
});

test('ship mode tolerates a branch without an upstream (first push)', () => {
  const root = workspace();
  const result = runVerification({ root, base: 'b', run: shipRunner({ upstream: false, codex: CLEAN_CODEX }), config: {}, options: { ship: true } });
  assert.equal(result.stages.find((s) => s.name === 'ship-readiness').status, 'pass');
});

test('a failing baseline-preservation stage fails the run unless it is configured as not required', () => {
  const root = workspace();
  const responses = { 'baseline-cli': { status: 1, stdout: '3 problem(s)', stderr: '' } };
  const strict = runVerification({ root, base: 'b', run: fakeRunner(responses).run, config: {} });
  assert.equal(strict.stages.find((s) => s.name === 'baseline-preservation').status, 'fail');
  assert.equal(strict.exitCode, 1);
  const relaxed = runVerification({ root, base: 'b', run: fakeRunner(responses).run, config: { stages: { baseline: { required: false } } } });
  assert.equal(relaxed.stages.find((s) => s.name === 'baseline-preservation').status, 'reported');
  assert.equal(relaxed.exitCode, 0);
});

test('a failing sql-verify stage fails the run unless it is configured as not required', () => {
  const root = workspace();
  const responses = { 'sql-verify-cli': { status: 1, stdout: 'SQL verification failed', stderr: '' } };
  const calls = fakeRunner(responses);
  const strict = runVerification({ root, base: 'b', run: calls.run, config: {} });
  assert.equal(strict.stages.find((s) => s.name === 'sql-verify').status, 'fail');
  assert.equal(strict.exitCode, 1);
  assert.ok(calls.calls.some((call) => call.includes('node src/sql-verify-cli.mjs --locale en')));
  const relaxed = runVerification({ root, base: 'b', run: fakeRunner(responses).run, config: { stages: { sqlVerify: { required: false } } } });
  assert.equal(relaxed.stages.find((s) => s.name === 'sql-verify').status, 'reported');
  assert.equal(relaxed.exitCode, 0);
});

function productWorkspace() {
  const root = workspace();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'product', private: true, workspaces: ['apps/*', 'packages/*'] }));
  return root;
}

test('product-tests is skipped, without failing the run, when the root has no package.json', () => {
  const root = workspace();
  const calls = fakeRunner({});
  const result = runVerification({ root, base: 'b', run: calls.run, config: {} });
  const stage = result.stages.find((s) => s.name === 'product-tests');
  assert.equal(stage.status, 'skipped');
  assert.equal(result.exitCode, 0);
  assert.equal(calls.calls.some((call) => call.includes('--workspaces')), false);
});

test('product-tests runs workspace tests, lint and the architecture check in the product root', () => {
  const root = productWorkspace();
  const seen = [];
  const run = (command, args, options) => {
    seen.push({ line: [command, ...args].join(' '), cwd: options?.cwd });
    return OK;
  };
  const result = runVerification({ root, base: 'b', run, config: {} });
  const stage = result.stages.find((s) => s.name === 'product-tests');
  assert.equal(stage.status, 'pass');
  const product = seen.filter((call) => call.cwd === root && call.line.startsWith('npm'));
  assert.deepEqual(product.map((call) => call.line), ['npm test --workspaces --if-present', 'npm run coverage:libs', 'npm run lint', 'npm run architecture']);
});

test('product-tests fails and names the command when any of the three scripts exits non-zero', () => {
  const root = productWorkspace();
  for (const failing of ['npm test --workspaces --if-present', 'npm run coverage:libs', 'npm run lint', 'npm run architecture']) {
    const { run } = fakeRunner({ [failing]: { status: 2, stdout: 'broken', stderr: 'boom' } });
    const result = runVerification({ root, base: 'b', run, config: {} });
    const stage = result.stages.find((s) => s.name === 'product-tests');
    assert.equal(stage.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(stage.findings.map((f) => [f.code, f.params.command]), [['PRODUCT_COMMAND_FAILED', failing]]);
    assert.match(stage.output, /boom/);
  }
});

test('product-tests only reports when configured as not required', () => {
  const root = productWorkspace();
  const { run } = fakeRunner({ 'npm run lint': { status: 1, stdout: '', stderr: 'lint' } });
  const result = runVerification({ root, base: 'b', run, config: { stages: { productTests: { required: false } } } });
  assert.equal(result.stages.find((s) => s.name === 'product-tests').status, 'reported');
  assert.equal(result.exitCode, 0);
});

function mobileWorkspace() {
  const root = workspace();
  mkdirSync(join(root, 'packages', 'mobile-tokens'), { recursive: true });
  writeFileSync(join(root, 'packages', 'mobile-tokens', 'pubspec.yaml'), 'name: machvon_tokens\n');
  return root;
}

test('mobile-tests is skipped, without failing the run, when the Dart package does not exist', () => {
  const root = workspace();
  const calls = fakeRunner({});
  const result = runVerification({ root, base: 'b', run: calls.run, config: {} });
  assert.equal(result.stages.find((s) => s.name === 'mobile-tests').status, 'skipped');
  assert.equal(result.exitCode, 0);
  assert.equal(calls.calls.some((call) => call.startsWith('flutter')), false);
});

test('mobile-tests is skipped, never counted as a pass, when Flutter is not installed', () => {
  const root = mobileWorkspace();
  const calls = fakeRunner({ 'flutter --version': { status: 1, stdout: '', stderr: 'not found' } });
  const result = runVerification({ root, base: 'b', run: calls.run, config: {} });
  assert.equal(result.stages.find((s) => s.name === 'mobile-tests').status, 'skipped');
  assert.equal(result.exitCode, 0);
  assert.equal(calls.calls.includes('flutter test'), false);
});

test('mobile-tests runs flutter test in the Dart package and passes when it passes', () => {
  const root = mobileWorkspace();
  const seen = [];
  const run = (command, args, options) => {
    seen.push({ line: [command, ...args].join(' '), cwd: options?.cwd });
    return OK;
  };
  const result = runVerification({ root, base: 'b', run, config: {} });
  assert.equal(result.stages.find((s) => s.name === 'mobile-tests').status, 'pass');
  assert.deepEqual(seen.filter((call) => call.line === 'flutter test').map((call) => call.cwd), [join(root, 'packages', 'mobile-tokens')]);
});

test('mobile-tests fails the run when flutter test fails, unless it is configured as not required', () => {
  const root = mobileWorkspace();
  const responses = { 'flutter test': { status: 1, stdout: 'Some tests failed.', stderr: '' } };
  const strict = runVerification({ root, base: 'b', run: fakeRunner(responses).run, config: {} });
  const failed = strict.stages.find((s) => s.name === 'mobile-tests');
  assert.equal(failed.status, 'fail');
  assert.match(failed.output, /Some tests failed/);
  assert.equal(strict.exitCode, 1);
  const relaxed = runVerification({ root, base: 'b', run: fakeRunner(responses).run, config: { stages: { mobileTests: { required: false } } } });
  assert.equal(relaxed.stages.find((s) => s.name === 'mobile-tests').status, 'reported');
  assert.equal(relaxed.exitCode, 0);
});

test('every mobile-tests message exists in both locales and the committed config keeps the stage required', async () => {
  for (const locale of ['vi', 'en']) assert.ok(loadMessages(locale)['stage.mobile-tests']);
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(config.stages.mobileTests.required, true);
});

test('every product-tests message exists in both locales', () => {
  for (const locale of ['vi', 'en']) {
    const messages = loadMessages(locale);
    assert.ok(messages['stage.product-tests']);
    assert.match(messages['finding.productCommandFailed'], /{command}/);
  }
});

test('the committed ci/config.json requires the product-tests stage', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(config.stages.productTests.required, true);
});

test('mobile-tests runs flutter test in every Dart package that exists and fails when any of them fails', () => {
  const root = mobileWorkspace();
  mkdirSync(join(root, 'packages', 'mobile-api-client'), { recursive: true });
  writeFileSync(join(root, 'packages', 'mobile-api-client', 'pubspec.yaml'), 'name: machvon_api_client\n');
  const seen = [];
  const passing = (command, args, options) => {
    seen.push({ line: [command, ...args].join(' '), cwd: options?.cwd });
    return OK;
  };
  const passed = runVerification({ root, base: 'b', run: passing, config: {} });
  assert.equal(passed.stages.find((s) => s.name === 'mobile-tests').status, 'pass');
  assert.deepEqual(seen.filter((call) => call.line === 'flutter test').map((call) => call.cwd), [join(root, 'packages', 'mobile-tokens'), join(root, 'packages', 'mobile-api-client')]);

  const failing = (command, args, options) =>
    command === 'flutter' && args[0] === 'test' && options?.cwd.endsWith('mobile-api-client') ? { status: 1, stdout: '', stderr: 'client tests broke' } : OK;
  const failed = runVerification({ root, base: 'b', run: failing, config: {} });
  const stage = failed.stages.find((s) => s.name === 'mobile-tests');
  assert.equal(stage.status, 'fail');
  assert.match(stage.output, /client tests broke/);
  assert.equal(failed.exitCode, 1);
});

test('mobile-tests also runs flutter test in the application apps/mobile, after the two packages, and fails when it fails', () => {
  const root = mobileWorkspace();
  mkdirSync(join(root, 'packages', 'mobile-api-client'), { recursive: true });
  writeFileSync(join(root, 'packages', 'mobile-api-client', 'pubspec.yaml'), 'name: machvon_api_client\n');
  mkdirSync(join(root, 'apps', 'mobile'), { recursive: true });
  writeFileSync(join(root, 'apps', 'mobile', 'pubspec.yaml'), 'name: machvon_mobile\n');
  const seen = [];
  const passing = (command, args, options) => {
    seen.push({ line: [command, ...args].join(' '), cwd: options?.cwd });
    return OK;
  };
  const passed = runVerification({ root, base: 'b', run: passing, config: {} });
  assert.equal(passed.stages.find((s) => s.name === 'mobile-tests').status, 'pass');
  assert.deepEqual(
    seen.filter((call) => call.line === 'flutter test').map((call) => call.cwd),
    [join(root, 'packages', 'mobile-tokens'), join(root, 'packages', 'mobile-api-client'), join(root, 'apps', 'mobile')],
  );

  const failing = (command, args, options) =>
    command === 'flutter' && args[0] === 'test' && options?.cwd.endsWith('mobile') ? { status: 1, stdout: '', stderr: 'application tests broke' } : OK;
  const failed = runVerification({ root, base: 'b', run: failing, config: {} });
  const stage = failed.stages.find((s) => s.name === 'mobile-tests');
  assert.equal(stage.status, 'fail');
  assert.match(stage.output, /application tests broke/);
  assert.equal(failed.exitCode, 1);
});

test('a command that writes more than a megabyte (the whole output of the product tests) still ends with its own status', () => {
  const size = 4 * 1024 * 1024;
  const result = defaultRun(process.execPath, ['-e', `process.stdout.write('x'.repeat(${size}))`]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, size);
});
