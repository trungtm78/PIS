import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WALK_PAGES, devUserFor, MAX_RETRY_SHARE, batchesOf, failedByTheMachine, isExpectedAbsence, isInfrastructureFailure, parseWalkPages, retryShareExceeded, summariseRetries } from './walk-plan.ts';

test('the failures a starved machine produces are infrastructure failures', () => {
  for (const message of [
    'page.goto: Page crashed',
    'page.goto: net::ERR_INSUFFICIENT_RESOURCES at http://127.0.0.1:1/doc/doc-07?devUser=owner',
    'page.goto: net::ERR_ABORTED at http://127.0.0.1:1/doc/doc-11',
    'page.goto: net::ERR_FAILED at http://127.0.0.1:1/x',
    'page.goto: Navigation to "http://127.0.0.1:1/sas/sas-22" is interrupted by another navigation to "chrome-error://chromewebdata/"',
    'page.goto: Target page, context or browser has been closed',
    'page.waitForSelector: Target closed',
    'browserContext.newPage: Browser has been closed',
  ]) {
    assert.equal(isInfrastructureFailure(message), true, message);
  }
});

test('a screen defect is never an infrastructure failure, so it is never retried away', () => {
  for (const message of [
    'page.waitForSelector: Timeout 15000ms exceeded.',
    'page.goto: Timeout 15000ms exceeded.',
    'page.waitForLoadState: Timeout 15000ms exceeded.',
    'expected breadcrumb',
    '',
  ]) {
    assert.equal(isInfrastructureFailure(message), false, message);
  }
  assert.equal(isInfrastructureFailure(undefined), false);
});

test('routes are walked in batches of a fixed size, in order, with a shorter last batch', () => {
  const routes = Array.from({ length: 7 }, (_, index) => ({ id: `R-${index}` }));
  assert.deepEqual(
    batchesOf(routes, 3).map((batch) => batch.map((route) => route.id)),
    [['R-0', 'R-1', 'R-2'], ['R-3', 'R-4', 'R-5'], ['R-6']],
  );
  assert.deepEqual(batchesOf([], 3), []);
  assert.deepEqual(batchesOf(routes, 100).map((batch) => batch.length), [7]);
});

test('a batch size below one is refused, because it would never advance', () => {
  assert.throws(() => batchesOf([{ id: 'A' }], 0), /at least 1/);
  assert.throws(() => batchesOf([{ id: 'A' }], 1.5), /at least 1/);
});

test('the number of pages walked at once defaults to three and accepts only a small positive whole number', () => {
  assert.equal(DEFAULT_WALK_PAGES, 3);
  assert.equal(parseWalkPages(undefined), 3);
  assert.equal(parseWalkPages(''), 3);
  assert.equal(parseWalkPages('1'), 1);
  assert.equal(parseWalkPages(' 4 '), 4);
  for (const bad of ['0', '-2', '2.5', 'many', '9']) assert.throws(() => parseWalkPages(bad), /E2E_WALK_PAGES/, bad);
});

test('retries are counted per page and the run is flagged when more than two percent needed one', () => {
  assert.equal(MAX_RETRY_SHARE, 0.02);
  const entries = [{ retries: 1 }, { retries: 0 }, {}, { retries: 1 }];
  assert.deepEqual(summariseRetries(entries), { retried: 2, total: 4 });
  assert.equal(retryShareExceeded({ retried: 2, total: 100 }), false);
  assert.equal(retryShareExceeded({ retried: 3, total: 100 }), true);
  assert.equal(retryShareExceeded({ retried: 0, total: 0 }), false);
  assert.equal(retryShareExceeded({ retried: 1, total: 0 }), true);
});

test('control-plane screens are opened by a system administrator, every other screen by the tenant owner', () => {
  assert.equal(devUserFor({ module: 'SAS' }), 'sysAdmin');
  for (const module of ['HOME', 'ADM', 'IAM', 'NOT', 'PRJ', 'DOC']) assert.equal(devUserFor({ module }), 'owner', module);
});

test('the 404 of an estimate that DIS has none to give for a project is an answer of the product, and no other failed resource is', () => {
  const missing = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
  const estimate = 'http://127.0.0.1:1/api/disbursement-forecasts?project_id=d9761587-3cad-4e67-b7d2-cdcdc2826c85';
  assert.equal(isExpectedAbsence(missing, estimate), true);
  assert.equal(isExpectedAbsence(missing, 'http://127.0.0.1:1/api/disbursement-forecasts?limit=50'), false);
  assert.equal(isExpectedAbsence(missing, 'http://127.0.0.1:1/api/projects/x'), false);
  assert.equal(isExpectedAbsence('Failed to load resource: the server responded with a status of 500 (Internal Server Error)', estimate), false);
  assert.equal(isExpectedAbsence('Uncaught TypeError', estimate), false);
});

test('a page whose load failed with a console error of the machine (no buffer space for a socket) is the machine\'s failure, and a plain 404 or a script error is not', () => {
  const full = 'Failed to load resource: net::ERR_NO_BUFFER_SPACE http://127.0.0.1:1/src/routes/DocumentLink.tsx';
  assert.equal(failedByTheMachine('page.waitForSelector: Timeout 15000ms exceeded.', [full]), true);
  assert.equal(failedByTheMachine(undefined, [full]), true);
  assert.equal(failedByTheMachine('page.goto: Page crashed', []), true);
  assert.equal(failedByTheMachine('page.waitForSelector: Timeout 15000ms exceeded.', ['Failed to load resource: the server responded with a status of 404 (Not Found) http://127.0.0.1:1/api/x']), false);
  assert.equal(failedByTheMachine(undefined, ['Uncaught TypeError: x is not a function']), false);
  assert.equal(failedByTheMachine(undefined, []), false);
});
