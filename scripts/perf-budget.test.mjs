import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_BUDGET, budgetProblems, buildRequest, discoverVariables, evaluateEntry, exitCode, formatLine, main, percentile, pickValue, runBudget, selectOperations, summarize, summaryOf } from './perf-budget.mjs';

const budget = {
  version: 1,
  classes: { FUNCTION: { budgetMs: 5000 }, REPORT: { budgetMs: 20000 } },
  defaults: { samples: 5, warmup: 1, stat: 'p95' },
  variables: { projectId: 'a project', week: 'a week' },
  operations: [
    { id: 'PB-F001', operationId: 'getHome', method: 'GET', path: '/home', class: 'FUNCTION', area: 'HOME' },
    { id: 'PB-F002', operationId: 'getChain', method: 'GET', path: '/chain', class: 'FUNCTION', area: 'PAY', query: { project_id: '$projectId', limit: '10' } },
    { id: 'PB-R001', operationId: 'exportCurve', method: 'GET', path: '/projects/{id}/export/{format}', class: 'REPORT', area: 'PRJ', pathVars: { id: 'projectId' }, pathFixed: { format: 'xlsx' } },
  ],
};

/** A clock that moves by the given steps, one for each reading (a request reads it twice). */
const clockOf = (steps) => {
  let at = 0;
  let index = 0;
  let reading = 0;
  return () => {
    if (reading % 2 === 1) {
      at += steps[index % steps.length];
      index += 1;
    }
    reading += 1;
    return at;
  };
};

const answer = (status = 200) => ({ status, arrayBuffer: async () => new ArrayBuffer(4) });

test('percentile is the nearest rank and refuses an empty list', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19);
  assert.equal(percentile([7], 0), 7);
  assert.throws(() => percentile([], 50), RangeError);
});

test('summarize gives p50, p95, max and counts the samples that failed', () => {
  const stats = summarize([{ ms: 10, status: 200 }, { ms: 30, status: 200 }, { ms: 20, status: 500 }, { ms: 40, status: 0 }]);
  assert.deepEqual(stats, { samples: 4, failed: 2, statuses: [0, 500], min: 10, p50: 20, p95: 40, max: 40 });
  assert.equal(summarize([]).p95, 0);
  assert.equal(summarize([{ ms: 1.26, status: 304 }]).p50, 1.3);
});

test('budgetProblems accepts a good table and names each way a table is wrong', () => {
  assert.deepEqual(budgetProblems(budget), []);
  assert.deepEqual(budgetProblems(null), ['the budget is not an object']);
  const bad = {
    classes: { FUNCTION: { budgetMs: 0 } },
    defaults: { stat: 'p99' },
    variables: {},
    operations: [
      { id: 'A', operationId: 'one', method: 'POST', path: 'no-slash', class: 'OTHER' },
      { id: 'A', operationId: 'one', method: 'GET', path: '/x/{id}', class: 'FUNCTION', query: { q: '$ghost' } },
      { operationId: 'two', method: 'GET', path: '/y/{id}', class: 'FUNCTION', pathVars: { id: 'ghost' } },
      { id: 'D' },
    ],
  };
  const problems = budgetProblems(bad);
  for (const expected of [
    'class FUNCTION has no positive budgetMs',
    'unknown default stat p99',
    'A is not a GET: only reads and downloads are measured',
    'A has no path',
    'A has an unknown class OTHER',
    'A is listed twice',
    'A repeats the operation one',
    'A has no value for {id}',
    'A query q uses the undeclared variable ghost',
    'an operation has no id',
    '(no id) uses the undeclared variable ghost',
    'D has no operationId',
  ]) assert.ok(problems.includes(expected), `missing: ${expected}\n${problems.join('\n')}`);
  assert.deepEqual(budgetProblems({ classes: {}, operations: [] }), ['no classes', 'no operations']);
});

test('an operation may tighten the budget of its class with budgetMs, never loosen it', () => {
  const row = (extra) => ({ ...budget, operations: [{ id: 'PB-F001', operationId: 'getHome', method: 'GET', path: '/home', class: 'FUNCTION', ...extra }] });
  assert.deepEqual(budgetProblems(row({ budgetMs: 800 })), []);
  assert.deepEqual(budgetProblems(row({ budgetMs: 5000 })), []);
  assert.deepEqual(budgetProblems(row({ budgetMs: 5001 })), ['PB-F001 budgetMs 5001 is over the 5000 ms of its class FUNCTION']);
  assert.deepEqual(budgetProblems(row({ budgetMs: 0 })), ['PB-F001 budgetMs must be a positive whole number of milliseconds']);
  assert.deepEqual(budgetProblems(row({ budgetMs: '800' })), ['PB-F001 budgetMs must be a positive whole number of milliseconds']);
});

const discoveringBudget = {
  ...budget,
  discovery: {
    projectId: { path: '/resources/project', query: { limit: '1' }, pick: 'items.0.id' },
    week: { path: '/weeks', pick: 'current' },
  },
};
const jsonAnswer = (body, status = 200) => ({ status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(4) });

test('pickValue follows a dotted path through objects and lists and gives undefined where there is nothing', () => {
  const answerOf = { items: [{ id: 'a-1' }], page: { next: null } };
  assert.equal(pickValue(answerOf, 'items.0.id'), 'a-1');
  assert.equal(pickValue(answerOf, 'items.1.id'), undefined);
  assert.equal(pickValue(answerOf, 'page.next.x'), undefined);
  assert.equal(pickValue(null, 'items'), undefined);
});

test('budgetProblems checks the discovery of the table: a declared variable, a fixed path and a pick', () => {
  assert.deepEqual(budgetProblems(discoveringBudget), []);
  const wrong = { ...budget, discovery: { nothing: { path: '/x', pick: 'a' }, projectId: { path: '/p/{id}', pick: 'a' }, week: { path: '/w' } } };
  assert.deepEqual(budgetProblems(wrong), [
    'discovery of nothing names a variable the table does not declare',
    'discovery of projectId has no fixed path',
    'discovery of week has no pick',
  ]);
});

test('discoverVariables reads the first row of a list for each variable that is not given, keeps the given ones and says why one is not found', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization });
    if (url.includes('/resources/project')) return jsonAnswer({ items: [{ id: 'p-9' }] });
    return jsonAnswer({}, 403);
  };
  const first = await discoverVariables({ budget: discoveringBudget, baseUrl: 'https://h/v1/', token: 't', fetchImpl });
  assert.deepEqual(first.found, { projectId: 'p-9' });
  assert.deepEqual(first.problems, ['week: /weeks answered 403']);
  assert.deepEqual(calls.map((call) => call.url), ['https://h/v1/resources/project?limit=1', 'https://h/v1/weeks']);
  assert.ok(calls.every((call) => call.authorization === 'Bearer t'));

  calls.length = 0;
  const kept = await discoverVariables({ budget: discoveringBudget, baseUrl: 'https://h/v1', vars: { projectId: 'mine' }, fetchImpl: async () => jsonAnswer({ current: '2026-W42' }) });
  assert.deepEqual(kept.found, { week: '2026-W42' });
  assert.deepEqual(kept.problems, []);

  const empty = await discoverVariables({ budget: discoveringBudget, baseUrl: 'https://h/v1', fetchImpl: async () => jsonAnswer({ items: [] }) });
  assert.deepEqual(empty.found, {});
  assert.equal(empty.problems.length, 2);
  assert.match(empty.problems[0], /^projectId: \/resources\/project has nothing at items\.0\.id/);
  const unreachable = await discoverVariables({ budget: discoveringBudget, baseUrl: 'https://h/v1', fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(unreachable.problems, ['projectId: /resources/project could not be read', 'week: /weeks could not be read']);
});

test('main --discover measures the operations whose ids it found in the tenant and writes the variables it used with --vars-out', async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'budget.json'), JSON.stringify(discoveringBudget));
    const lines = [];
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return url.includes('/resources/project') ? jsonAnswer({ items: [{ id: 'p-9' }] }) : answer();
    };
    const out = join(dir, 'vars.json');
    const code = await main(['--budget', join(dir, 'budget.json'), '--base-url', 'https://h/v1', '--discover', '--var', 'week=2026-W42', '--samples', '1', '--warmup', '0', '--vars-out', out], { log: (line) => lines.push(line), fetchImpl, now: clockOf([10]) });
    assert.equal(code, 0);
    assert.ok(lines.includes('found projectId = p-9'));
    assert.ok(urls.includes('https://h/v1/projects/p-9/export/xlsx'));
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { week: '2026-W42', projectId: 'p-9' });
    assert.equal(lines.at(-1), '3 operations: 3 within budget, 0 over budget or failed, 0 not measured');

    lines.length = 0;
    assert.equal(await main(['--budget', join(dir, 'budget.json'), '--base-url', 'https://h/v1', '--discover', '--strict', '--samples', '1', '--warmup', '0'], { log: (line) => lines.push(line), fetchImpl: async (url) => (url.includes('/resources/project') ? jsonAnswer({}, 404) : answer()), now: clockOf([10]) }), 3);
    assert.ok(lines.some((line) => line.startsWith('not found projectId: /resources/project answered 404')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the discovery of the committed budget reads lists of the contract and gives the variables that the operations lacked', () => {
  const contract = operationsOfContract();
  const reads = new Set([...contract.values()].map((found) => `${found.method.toLowerCase()} ${found.path}`));
  for (const [name, rule] of Object.entries(committed.discovery)) {
    assert.ok(reads.has(`get ${rule.path}`), `${name}: ${rule.path} is not a read of the contract`);
  }
  const used = new Set(committed.operations.flatMap((entry) => [...Object.values(entry.pathVars ?? {}), ...Object.values(entry.query ?? {}).flatMap((value) => /^\$(\w+)$/.exec(String(value))?.slice(1) ?? [])]));
  for (const name of ['projectId', 'allocationLineId', 'reportDraftId', 'reportIssueId']) {
    assert.ok(used.has(name), `${name} is used by an operation`);
    assert.ok(committed.discovery[name] !== undefined, `${name} can be discovered`);
  }
});

test('buildRequest fills the path and the query, encodes values and lists the missing variables', () => {
  const [, chain, curve] = budget.operations;
  assert.deepEqual(buildRequest(chain, 'https://host/v1/', { projectId: 'p 1' }), { url: 'https://host/v1/chain?project_id=p+1&limit=10', missing: [] });
  assert.deepEqual(buildRequest(curve, 'https://host/v1', { projectId: 'a/b' }), { url: 'https://host/v1/projects/a%2Fb/export/xlsx', missing: [] });
  assert.deepEqual(buildRequest(curve, 'https://host/v1', {}).missing, ['projectId']);
  assert.deepEqual(buildRequest(chain, 'https://host/v1', { projectId: '' }).missing, ['projectId']);
});

test('evaluateEntry fails when the statistic is over the budget of the class and when a sample failed', () => {
  const entry = budget.operations[0];
  const good = { samples: 5, failed: 0, statuses: [], p50: 100, p95: 4999, max: 6000 };
  assert.equal(evaluateEntry(entry, good, budget, 'p95').status, 'PASS');
  assert.match(evaluateEntry(entry, good, budget, 'max').reason, /max 6000 ms is over the budget of 5000 ms/);
  assert.equal(evaluateEntry(entry, { ...good, p95: 5000 }, budget, 'p95').status, 'PASS');
  assert.equal(evaluateEntry(entry, { ...good, p95: 5001 }, budget, 'p95').status, 'FAIL');
  assert.equal(evaluateEntry(budget.operations[2], { ...good, p95: 19_999 }, budget, 'p95').status, 'PASS');
  assert.equal(evaluateEntry(budget.operations[2], { ...good, p95: 20_001 }, budget, 'p95').status, 'FAIL');
  const failed = evaluateEntry(entry, { ...good, failed: 2, statuses: [403, 500] }, budget, 'p95');
  assert.deepEqual([failed.status, failed.reason], ['FAIL', '2 of 5 samples failed (status 403,500)']);
});

test('scale and edition of a row are checked: a whole number of at least 1, and a known edition', () => {
  const row = (extra) => ({ ...budget, operations: [{ id: 'PB-F001', operationId: 'getHome', method: 'GET', path: '/home', class: 'FUNCTION', ...extra }] });
  assert.deepEqual(budgetProblems(row({ scale: 20, edition: 'ENTERPRISE' })), []);
  assert.deepEqual(budgetProblems(row({ scale: 0 })), ['PB-F001 scale must be a whole number of at least 1']);
  assert.deepEqual(budgetProblems(row({ scale: 2.5 })), ['PB-F001 scale must be a whole number of at least 1']);
  assert.deepEqual(budgetProblems(row({ edition: 'GOLD' })), ['PB-F001 has an unknown edition GOLD']);
});

test('evaluateEntry judges an operation by its own budgetMs when it has one, and says that figure', () => {
  const entry = { ...budget.operations[0], budgetMs: 800 };
  const stats = { samples: 5, failed: 0, statuses: [], p50: 100, p95: 800, max: 900 };
  assert.deepEqual(evaluateEntry(entry, stats, budget, 'p95'), { status: 'PASS', reason: '', limit: 800 });
  const slow = evaluateEntry(entry, { ...stats, p95: 801 }, budget, 'p95');
  assert.deepEqual([slow.status, slow.limit, slow.reason], ['FAIL', 800, 'p95 801 ms is over the budget of 800 ms']);
});

test('a run times out an operation after twice its own budget and prints that budget in the list', async () => {
  const tight = { ...budget, operations: [{ ...budget.operations[0], budgetMs: 800 }] };
  const [result] = await runBudget({ budget: tight, baseUrl: 'https://h/v1', samples: 2, warmup: 0, fetchImpl: async () => answer(), now: clockOf([10]) });
  assert.equal(result.limit, 800);
  const lines = [];
  const dir = mkdtempSync(join(tmpdir(), 'perf-list-'));
  try {
    writeFileSync(join(dir, 'budget.json'), JSON.stringify(tight));
    assert.equal(await main(['--budget', join(dir, 'budget.json'), '--list'], { log: (line) => lines.push(line) }), 0);
    assert.match(lines[0], /PB-F001\s+FUNCTION\s+800 ms\s+GET \/home/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectOperations matches id, operation, area and class without regard to case', () => {
  assert.equal(selectOperations(budget, undefined).length, 3);
  assert.deepEqual(selectOperations(budget, ['home']).map((entry) => entry.id), ['PB-F001']);
  assert.deepEqual(selectOperations(budget, ['report']).map((entry) => entry.id), ['PB-R001']);
  assert.deepEqual(selectOperations(budget, ['pb-f002', 'exportCurve']).map((entry) => entry.id), ['PB-F002', 'PB-R001']);
  assert.deepEqual(selectOperations(budget, ['nothing']), []);
});

test('runBudget skips what lacks variables, warms up without counting, sends the token and measures every sample', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization, extra: init.headers['x-extra'] });
    return answer();
  };
  const results = await runBudget({ budget, baseUrl: 'https://h/v1', token: 'secret', vars: { projectId: 'p' }, headers: { 'x-extra': '1' }, fetchImpl, now: clockOf([100, 200, 300, 400, 500, 600]) });
  assert.deepEqual(results.map((result) => [result.id, result.status]), [['PB-F001', 'PASS'], ['PB-F002', 'PASS'], ['PB-R001', 'PASS']]);
  assert.equal(seen.length, 3 * (1 + 5));
  assert.ok(seen.every((call) => call.authorization === 'Bearer secret' && call.extra === '1'));
  assert.deepEqual(results[0].stats.samples, 5);
  const skipped = await runBudget({ budget, baseUrl: 'https://h/v1', vars: {}, fetchImpl, now: clockOf([1]) });
  assert.deepEqual(skipped.map((result) => result.status), ['PASS', 'SKIPPED', 'SKIPPED']);
  assert.equal(skipped[1].reason, 'missing variables: projectId');
  assert.equal(skipped[1].stats, undefined);
});

test('runBudget fails an operation that is over its budget, one that answers with an error and one that cannot be reached', async () => {
  const slow = await runBudget({ budget, baseUrl: 'https://h', vars: { projectId: 'p' }, only: ['PB-F001'], fetchImpl: async () => answer(), now: clockOf([6000]) });
  assert.equal(slow[0].status, 'FAIL');
  assert.match(slow[0].reason, /p95 6000 ms is over the budget of 5000 ms/);
  const forbidden = await runBudget({ budget, baseUrl: 'https://h', only: ['PB-F001'], fetchImpl: async () => answer(403), now: clockOf([5]) });
  assert.equal(forbidden[0].reason, '5 of 5 samples failed (status 403)');
  const down = await runBudget({ budget, baseUrl: 'https://h', only: ['PB-F001'], fetchImpl: async () => { throw new Error('refused'); }, now: clockOf([5]), samples: 2, warmup: 0 });
  assert.equal(down[0].reason, '2 of 2 samples failed (status 0)');
  const lines = [];
  await runBudget({ budget, baseUrl: 'https://h', only: ['PB-F001'], fetchImpl: async () => answer(), now: clockOf([10]), onResult: (result) => lines.push(formatLine(result)) });
  assert.match(lines[0], /^PASS\s+PB-F001\s+FUNCTION\s+getHome\s+p50 10 ms {2}p95 10 ms {2}max 10 ms\s+budget 5000 ms$/);
});

test('a request that does not answer within twice the budget is aborted and counted as failed', async () => {
  const hanging = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const tiny = { ...budget, classes: { FUNCTION: { budgetMs: 10 }, REPORT: { budgetMs: 10 } } };
  const results = await runBudget({ budget: tiny, baseUrl: 'https://h', only: ['PB-F001'], fetchImpl: hanging, samples: 1, warmup: 0 });
  assert.equal(results[0].status, 'FAIL');
  assert.equal(results[0].stats.statuses[0], 0);
});

test('exit code and summary: over budget is 1, a skip is 3 only when strict', () => {
  const pass = { status: 'PASS' };
  assert.equal(exitCode([pass], false), 0);
  assert.equal(exitCode([pass, { status: 'SKIPPED' }], false), 0);
  assert.equal(exitCode([pass, { status: 'SKIPPED' }], true), 3);
  assert.equal(exitCode([pass, { status: 'FAIL' }, { status: 'SKIPPED' }], true), 1);
  assert.deepEqual(summaryOf([pass, pass, { status: 'FAIL' }, { status: 'SKIPPED' }]), { total: 4, pass: 2, fail: 1, skipped: 1 });
});

const scratch = () => mkdtempSync(join(tmpdir(), 'perf-budget-'));

test('main: usage errors, an invalid table and a missing variables file give exit 2', async () => {
  const dir = scratch();
  try {
    const lines = [];
    const log = (line) => lines.push(line);
    assert.equal(await main(['--nonsense'], { log }), 2);
    assert.equal(await main([], { log }), 2);
    assert.equal(await main(['--base-url', 'localhost'], { log }), 2);
    assert.equal(await main(['--base-url', 'http://h', '--samples', '0'], { log }), 2);
    assert.equal(await main(['--base-url', 'http://h', '--stat', 'p99'], { log }), 2);
    assert.equal(await main(['--base-url', 'http://h', '--var', 'novalue'], { log }), 2);
    assert.equal(await main(['--base-url', 'http://h', '--header', 'novalue'], { log }), 2);
    assert.equal(await main(['--base-url', 'http://h', '--vars', join(dir, 'missing.json')], { log }), 2);
    assert.equal(await main(['--base-url', 'http://h', '--budget', join(dir, 'missing.json')], { log }), 2);
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ classes: {}, operations: [] }));
    assert.equal(await main(['--base-url', 'http://h', '--budget', join(dir, 'bad.json')], { log }), 2);
    assert.ok(lines.some((line) => line.includes('the budget table is not valid')));
    assert.ok(lines.some((line) => line.startsWith('usage:')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main --check validates the table and says what it holds', async () => {
  const lines = [];
  assert.equal(await main(['--check'], { log: (line) => lines.push(line) }), 0);
  assert.match(lines[0], /^the budget table is valid: \d+ operations \(\d+ FUNCTION at 5000 ms, \d+ REPORT at 20000 ms\)$/);
});

test('main: lists the table, runs it with variables from a file and the command line, takes the token from the environment and writes the result', async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'budget.json'), JSON.stringify(budget));
    writeFileSync(join(dir, 'vars.json'), JSON.stringify({ projectId: 'p-1' }));
    const lines = [];
    const log = (line) => lines.push(line);
    assert.equal(await main(['--budget', join(dir, 'budget.json'), '--list', '--only', 'PRJ'], { log }), 0);
    assert.match(lines[0], /^PB-R001\s+REPORT\s+20000 ms\s+GET \/projects\/\{id\}\/export\/\{format\}$/);

    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization });
      return answer();
    };
    lines.length = 0;
    const out = join(dir, 'result.json');
    const code = await main(['--budget', join(dir, 'budget.json'), '--base-url', 'https://h/v1', '--vars', join(dir, 'vars.json'), '--var', 'week=2026-W42', '--samples', '2', '--warmup', '0', '--out', out, '--header', 'X-Tenant: t1'], { log, env: { PERF_TOKEN: 'from-env' }, fetchImpl, now: clockOf([10]) });
    assert.equal(code, 0);
    assert.equal(calls.length, 6);
    assert.ok(calls.every((call) => call.authorization === 'Bearer from-env'));
    assert.ok(calls.some((call) => call.url === 'https://h/v1/projects/p-1/export/xlsx'));
    assert.equal(lines.at(-1), '3 operations: 3 within budget, 0 over budget or failed, 0 not measured');
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(written.summary, { total: 3, pass: 3, fail: 0, skipped: 0 });
    assert.ok(!JSON.stringify(written).includes('from-env'), 'the token never reaches the result file');

    lines.length = 0;
    assert.equal(await main(['--budget', join(dir, 'budget.json'), '--base-url', 'https://h/v1', '--only', 'PRJ', '--strict'], { log, fetchImpl, now: clockOf([10]) }), 3);
    assert.equal(await main(['--budget', join(dir, 'budget.json'), '--base-url', 'https://h/v1', '--only', 'HOME', '--stat', 'max'], { log, fetchImpl: async () => answer(500), now: clockOf([10]) }), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main against a real local server: measures real time, follows the body to the end and fails on a status of 500', async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/v1/ok') && request.headers.authorization === 'Bearer t') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(50_000));
    } else {
      response.writeHead(request.url?.startsWith('/v1/ok') ? 401 : 500);
      response.end('no');
    }
  });
  await new Promise((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
  const dir = scratch();
  try {
    const { port } = server.address();
    const table = { ...budget, operations: [{ id: 'PB-F001', operationId: 'ok', method: 'GET', path: '/ok', class: 'FUNCTION', area: 'HOME' }, { id: 'PB-F002', operationId: 'broken', method: 'GET', path: '/broken', class: 'FUNCTION', area: 'HOME' }] };
    writeFileSync(join(dir, 'budget.json'), JSON.stringify(table));
    const lines = [];
    const log = (line) => lines.push(line);
    const code = await main(['--budget', join(dir, 'budget.json'), '--base-url', `http://127.0.0.1:${port}/v1`, '--token', 't', '--samples', '3', '--warmup', '1'], { log });
    assert.equal(code, 1);
    assert.match(lines[0], /^PASS\s+PB-F001/);
    assert.match(lines[1], /^FAIL\s+PB-F002.*3 of 3 samples failed \(status 500\)/);
    assert.equal(await main(['--budget', join(dir, 'budget.json'), '--base-url', `http://127.0.0.1:${port}/v1`, '--only', 'PB-F001', '--samples', '2'], { log }), 1, 'without the token the server answers 401');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the committed table against the contract -----------------------------------------------------------------------------------------------

const committed = JSON.parse(readFileSync(DEFAULT_BUDGET, 'utf8'));
const openapi = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json'), 'utf8'));

const operationsOfContract = () => {
  const found = new Map();
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(item)) if (operation?.operationId !== undefined) found.set(operation.operationId, { path, method: method.toUpperCase(), operation });
  }
  return found;
};

test('the committed budget keeps the budgets of the customer: 5 seconds a function, 20 seconds a report', () => {
  assert.deepEqual(budgetProblems(committed), []);
  assert.equal(committed.classes.FUNCTION.budgetMs, 5000);
  assert.equal(committed.classes.REPORT.budgetMs, 20_000);
  assert.equal(committed.defaults.stat, 'p95');
  assert.ok(committed.operations.filter((entry) => entry.class === 'FUNCTION').length >= 50);
  assert.ok(committed.operations.filter((entry) => entry.class === 'REPORT').length >= 10);
});

test('the committed budget holds the enterprise frozen snapshot reads at 800 ms and the issued PDF of a report at 20 seconds (HT.05)', () => {
  const byOperation = (operationId) => committed.operations.find((entry) => entry.operationId === operationId);
  for (const operationId of ['getEnterpriseSnapshot', 'getLeaderRates']) {
    const entry = byOperation(operationId);
    assert.ok(entry !== undefined, `${operationId} is in the table`);
    assert.equal(entry.class, 'FUNCTION');
    assert.equal(entry.budgetMs, 800, operationId);
    assert.equal(entry.scale, 20, `${operationId} is measured on a tenant 20 times the size of the demo`);
    assert.equal(entry.edition, 'ENTERPRISE');
  }
  const pdf = byOperation('getReportIssueFile');
  assert.equal(pdf.class, 'REPORT');
  assert.equal(pdf.pathFixed.format, 'PDF');
  assert.equal(pdf.budgetMs, undefined, 'the PDF keeps the 20 seconds of its class');
  assert.ok(committed.variables.enterpriseSnapshotId !== undefined && committed.discovery.enterpriseSnapshotId !== undefined, 'the frozen snapshot is found by discovery, so a tenant without one skips the rows');
});

test('every operation of the committed budget is a read of the contract with the same path and permission, and its required parameters are given', () => {
  const contract = operationsOfContract();
  const problems = [];
  for (const entry of committed.operations) {
    const found = contract.get(entry.operationId);
    if (found === undefined) {
      problems.push(`${entry.id}: ${entry.operationId} is not in the contract`);
      continue;
    }
    if (found.method !== entry.method || found.path !== entry.path) problems.push(`${entry.id}: contract says ${found.method} ${found.path}`);
    if ((found.operation['x-permission'] ?? null) !== (entry.permission ?? null)) problems.push(`${entry.id}: permission differs (${found.operation['x-permission']})`);
    const parameters = (found.operation.parameters ?? []).map((parameter) => (parameter.$ref === undefined ? parameter : openapi.components.parameters[parameter.$ref.split('/').pop()]));
    for (const parameter of parameters.filter((candidate) => candidate.required)) {
      const given = parameter.in === 'path' ? entry.pathVars?.[parameter.name] !== undefined || entry.pathFixed?.[parameter.name] !== undefined : entry.query?.[parameter.name] !== undefined;
      if (!given) problems.push(`${entry.id}: required ${parameter.in} parameter ${parameter.name} has no value`);
      const allowed = parameter.schema?.enum;
      const fixed = parameter.in === 'path' ? entry.pathFixed?.[parameter.name] : undefined;
      if (allowed !== undefined && fixed !== undefined && !allowed.includes(fixed)) problems.push(`${entry.id}: ${fixed} is not an allowed ${parameter.name}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every export and report download of the contract that is a read has a place in the budget as a REPORT', () => {
  const inBudget = new Map(committed.operations.map((entry) => [entry.operationId, entry]));
  const reports = [...operationsOfContract()]
    .filter(([id, found]) => found.method === 'GET' && /^export[A-Z]/.test(id))
    .map(([id]) => id);
  assert.ok(reports.length >= 3);
  assert.deepEqual(reports.filter((id) => inBudget.get(id)?.class !== 'REPORT'), []);
});

test('the budget touches the main areas of the product and lists each operation once', () => {
  const areas = new Set(committed.operations.map((entry) => entry.area));
  for (const area of ['HOME', 'CAP', 'PRJ', 'CTR', 'BID', 'PAY', 'DOC', 'DIR', 'BI', 'RPT']) assert.ok(areas.has(area), `no operation of area ${area}`);
  assert.equal(new Set(committed.operations.map((entry) => entry.operationId)).size, committed.operations.length);
});

// ---- the k6 scripts read the same table and build the same requests --------------------------------------------------------------------------

/** Objects made inside the VM belong to another realm: compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Runs tests/k6/budget-lib.js outside k6: the imports are replaced by stubs, `open` reads the file, the environment is given. */
async function loadK6Lib(environment) {
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(join(import.meta.dirname, '..', 'tests', 'k6', 'budget-lib.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ');
  const calls = [];
  const sandbox = {
    __ENV: environment,
    open: (path) => readFileSync(join(import.meta.dirname, '..', 'tests', 'k6', path), 'utf8'),
    http: { get: (url, params) => { calls.push({ url, params }); return { status: 200 }; } },
    check: () => true,
    encodeURIComponent,
    JSON,
    Object,
    String,
  };
  runInNewContext(`${source}\nthis.api = { budget, urlOf, operations, limitOf, hit, thresholdsOf };`, sandbox);
  return { api: sandbox.api, calls };
}

test('the k6 library builds the same URLs as the node runner and leaves out an operation whose variable is missing', async () => {
  const vars = { projectId: 'p-1', isoWeek: '2026-W42', reportDraftId: 'd-1', reportIssueId: 'i-1', reportExportId: 'e-1', mneReportId: 'm-1', evaluationReportId: 'v-1', allocationLineId: 'l-1', enterpriseSnapshotId: 's-1' };
  const { api } = await loadK6Lib({ BASE_URL: 'https://h/v1/', TOKEN: 't', VARS: JSON.stringify(vars) });
  assert.equal(api.operations.length, committed.operations.length);
  for (const item of api.operations) {
    const expected = buildRequest(item.entry, 'https://h/v1', vars);
    assert.deepEqual(expected.missing, [], item.entry.id);
    assert.equal(item.url, expected.url, item.entry.id);
  }
  const partial = await loadK6Lib({ BASE_URL: 'https://h/v1', VARS: JSON.stringify({ projectId: 'p-1' }) });
  assert.ok(partial.api.operations.length < committed.operations.length);
  assert.ok(partial.api.operations.every((item) => item.url !== null));
});

test('the k6 library filters with ONLY, tags every request and sets a threshold for each class and each operation at the budget of the class', async () => {
  const { api, calls } = await loadK6Lib({ BASE_URL: 'https://h/v1', TOKEN: 't', VARS: '{}', ONLY: 'home, PB-F032' });
  assert.ok(api.operations.length >= 2);
  assert.ok(api.operations.every((item) => item.entry.area === 'HOME' || item.entry.id === 'PB-F032'));
  api.hit(api.operations[0]);
  assert.equal(calls[0].params.headers.Authorization, 'Bearer t');
  assert.deepEqual(plain(calls[0].params.tags), { op: api.operations[0].entry.id, cls: api.operations[0].entry.class });
  assert.equal(calls[0].params.timeout, `${api.limitOf(api.operations[0].entry) * 2}ms`);
  const thresholds = plain(api.thresholdsOf(api.operations));
  assert.deepEqual(thresholds['http_req_duration{cls:FUNCTION}'], ['p(95)<5000']);
  assert.deepEqual(thresholds['http_req_duration{cls:REPORT}'], ['p(95)<20000']);
  assert.deepEqual(thresholds.http_req_failed, ['rate<0.01']);
  assert.equal(Object.keys(thresholds).length, 3 + api.operations.length);
});

test('the k6 library holds an operation to its own budgetMs: its limit, its timeout and its threshold', async () => {
  const { api } = await loadK6Lib({ BASE_URL: 'https://h/v1', TOKEN: 't', VARS: JSON.stringify({ enterpriseSnapshotId: 's-1' }), ONLY: 'PB-F068' });
  assert.equal(api.operations.length, 1);
  assert.equal(api.limitOf(api.operations[0].entry), 800);
  assert.deepEqual(plain(api.thresholdsOf(api.operations))['http_req_duration{op:PB-F068}'], ['p(95)<800']);
});

test('both k6 scripts exist, import the library and fail the run when there is nothing to measure', () => {
  for (const name of ['budget.js', 'load.js']) {
    const text = readFileSync(join(import.meta.dirname, '..', 'tests', 'k6', name), 'utf8');
    assert.match(text, /from '\.\/budget-lib\.js'/);
    assert.match(text, /thresholds: thresholdsOf\(operations\)/);
    assert.match(text, /exec\.test\.abort\(/);
  }
});

test('a run that selects no operation fails: exit 2 from the command line, exit 1 from the exit code of an empty result', async () => {
  const lines = [];
  assert.equal(await main(['--base-url', 'http://localhost:1', '--only', 'TYPO', '--strict'], { log: (line) => lines.push(line), fetchImpl: async () => { throw new Error('must not be called'); } }), 2);
  assert.equal(lines[0], 'no operation of the table matches --only TYPO');
  assert.equal(exitCode([], false), 1);
  assert.equal(exitCode([], true), 1);
});
