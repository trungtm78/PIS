import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBLEM_CODES,
  STAGING_CONTEXT,
  addWorkingDays,
  evaluateErrorBudget,
  evaluateProductionGate,
  main,
  openPostMortem,
  productionContext,
  readBudgetReport,
  readCanaryPolicy,
  readErrorBudgetPolicy,
  vietnamDay,
} from './deploy-gate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const COHORTS = ['pilot', 'cohort-1', 'all'];
const NOW = Date.parse('2026-06-01T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const greenRun = { head_sha: SHA, status: 'completed', conclusion: 'success' };
const staging = (state = 'success') => ({ context: STAGING_CONTEXT, state, created_at: minutesAgo(600) });
const production = (cohort, minutes, state = 'success') => ({ context: productionContext(cohort), state, created_at: minutesAgo(minutes) });

function gate(overrides = {}) {
  return evaluateProductionGate({
    sha: SHA,
    cohort: 'pilot',
    cohorts: COHORTS,
    bakeMinutes: 30,
    ciRuns: [greenRun],
    statuses: [staging()],
    now: NOW,
    ...overrides,
  }).problems.map((problem) => problem.code);
}

test('a commit with green CI and a green staging deployment may go to the first cohort', () => {
  assert.deepEqual(gate(), []);
});

test('a commit whose CI never succeeded is refused', () => {
  assert.deepEqual(gate({ ciRuns: [] }), ['CI_NOT_GREEN']);
  assert.deepEqual(gate({ ciRuns: [{ ...greenRun, conclusion: 'failure' }] }), ['CI_NOT_GREEN']);
  assert.deepEqual(gate({ ciRuns: [{ ...greenRun, status: 'in_progress', conclusion: null }] }), ['CI_NOT_GREEN']);
  assert.deepEqual(gate({ ciRuns: [{ ...greenRun, head_sha: OTHER_SHA }] }), ['CI_NOT_GREEN']);
});

test('a commit that never reached staging, or whose latest staging deployment failed, is refused', () => {
  assert.deepEqual(gate({ statuses: [] }), ['STAGING_NOT_GREEN']);
  assert.deepEqual(gate({ statuses: [staging('failure')] }), ['STAGING_NOT_GREEN']);
  // The API lists the newest status first: a later failure outranks an earlier success.
  assert.deepEqual(gate({ statuses: [staging('failure'), staging('success')] }), ['STAGING_NOT_GREEN']);
  assert.deepEqual(gate({ statuses: [staging('success'), staging('failure')] }), []);
});

test('a short or symbolic revision is not a promotable commit', () => {
  assert.deepEqual(gate({ sha: 'main' }), ['SHA_INVALID', 'CI_NOT_GREEN']);
});

test('the canary order and the bake time are enforced for the later cohorts', () => {
  assert.deepEqual(gate({ cohort: 'cohort-1' }), ['PREVIOUS_COHORT_MISSING']);
  assert.deepEqual(gate({ cohort: 'cohort-1', statuses: [production('pilot', 10), staging()] }), ['BAKE_NOT_ELAPSED']);
  assert.deepEqual(gate({ cohort: 'cohort-1', statuses: [production('pilot', 30), staging()] }), []);
  assert.deepEqual(gate({ cohort: 'all', statuses: [production('pilot', 500), staging()] }), ['PREVIOUS_COHORT_MISSING']);
  assert.deepEqual(gate({ cohort: 'all', statuses: [production('cohort-1', 31), production('pilot', 500), staging()] }), []);
  assert.deepEqual(gate({ cohort: 'all', statuses: [production('cohort-1', 31, 'failure'), staging()] }), ['PREVIOUS_COHORT_MISSING']);
});

test('an unknown cohort is refused', () => {
  assert.deepEqual(gate({ cohort: 'everyone' }), ['COHORT_UNKNOWN']);
});

test('the canary policy is read from the production pipeline declaration', () => {
  const policy = readCanaryPolicy(REPO_ROOT);
  assert.deepEqual(policy.cohorts, COHORTS);
  assert.equal(policy.bakeMinutes, 30);
});

function fakeApi({ runs = [greenRun], statuses = [staging()] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), authorization: init.headers.authorization });
    const body = url.includes('/actions/workflows/') ? { workflow_runs: runs } : url.includes('/statuses') && init.method === 'GET' ? statuses : {};
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

const run = (argv, api, env = { GH_TOKEN: 'token', GITHUB_API_URL: 'https://api.example.test' }) => {
  const lines = [];
  return main(argv, { log: (line) => lines.push(line), fetchImpl: api.fetchImpl, env, now: NOW }).then((code) => ({ code, lines }));
};

const scratch = mkdtempSync(join(tmpdir(), 'deploy-gate-'));
/** Writes a budget report as the SLO evaluation exports it (kernel budgetReport) and returns its path. */
function reportFile(name, report) {
  const path = join(scratch, name);
  writeFileSync(path, typeof report === 'string' ? report : JSON.stringify(report));
  return path;
}
const healthy = { generatedAt: minutesAgo(5), exhausted: false, services: [] };
const spent = { generatedAt: minutesAgo(5), exhausted: true, exhaustedAt: '2026-05-29T03:00:00.000Z', services: [] };

test('check exits 0 and names the commit when every gate is met', async () => {
  const api = fakeApi();
  const { code, lines } = await run(['check', '--locale', 'en', '--repo', 'o/r', '--sha', SHA, '--cohort', 'pilot', '--budget-report', reportFile('healthy.json', healthy)], api);
  assert.equal(code, 0);
  assert.match(lines.at(-1), new RegExp(`commit ${SHA} may be promoted to pilot`));
  assert.ok(api.calls.every((call) => call.url.startsWith('https://api.example.test/repos/o/r/') && call.authorization === 'Bearer token'));
  assert.ok(api.calls.some((call) => call.url.includes(`/actions/workflows/ci.yml/runs?head_sha=${SHA}`)));
});

test('check exits 1 and prints every unmet gate', async () => {
  const { code, lines } = await run(['check', '--locale', 'en', '--repo', 'o/r', '--sha', SHA, '--cohort', 'cohort-1', '--kind', 'security'], fakeApi({ runs: [], statuses: [] }));
  assert.equal(code, 1);
  assert.equal(lines.length, 4);
  assert.match(lines.at(-1), /3 promotion gate\(s\) not met/);
});

test('record writes a commit status on the exact commit', async () => {
  const api = fakeApi();
  const { code, lines } = await run(['record', '--locale', 'en', '--repo', 'o/r', '--sha', SHA, '--context', 'deploy/staging', '--state', 'success', '--description', 'Deployed'], api);
  assert.equal(code, 0);
  assert.deepEqual(api.calls.map((call) => [call.method, call.url]), [['POST', `https://api.example.test/repos/o/r/statuses/${SHA}`]]);
  assert.deepEqual(api.calls[0].body, { state: 'success', context: 'deploy/staging', description: 'Deployed' });
  assert.match(lines[0], /recorded deploy\/staging as success/);
});

test('a failing API call is an error, never a pass', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => run(['check', '--repo', 'o/r', '--sha', SHA, '--cohort', 'pilot', '--kind', 'security'], { fetchImpl }), /HTTP 403/);
});

test('missing or unknown arguments print the usage and exit 2', async () => {
  for (const argv of [['--nope'], [], ['check', '--repo', 'o/r'], ['postmortem', '--repo', 'o/r'], ['record', '--repo', 'o/r', '--sha', SHA, '--context', 'c', '--state', 'maybe']]) {
    const { code, lines } = await run(argv, fakeApi());
    assert.equal(code, 2, argv.join(' '));
    assert.match(lines[0], /^(usage|cách\sdùng)/);
  }
});

test('every problem code has a message in both catalogues', () => {
  for (const locale of ['vi', 'en']) {
    const messages = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'messages', `${locale}.json`), 'utf8'));
    for (const code of PROBLEM_CODES) assert.ok(messages[`deployGate.${code}`], `${locale} ${code}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The workflow wires the gate in: these checks read the text because the repository has no YAML parser dependency.
// ---------------------------------------------------------------------------------------------------------------------

const WORKFLOW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
const jobBlock = (name) => {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name}`);
  const rest = WORKFLOW.slice(start + 1);
  const next = /\n {2}[a-z-]+:\n/.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
};

test('the commit is resolved once, in preflight, and exposed as an output', () => {
  const preflight = jobBlock('preflight');
  assert.match(preflight, /outputs:\n\s+sha: \$\{\{ steps\.resolve\.outputs\.sha \}\}/);
  assert.match(preflight, /git rev-parse HEAD/);
});

test('staging and production check out the preflight SHA, never a moving ref', () => {
  for (const name of ['staging', 'production']) {
    const block = jobBlock(name);
    assert.match(block, /ref: \$\{\{ needs\.preflight\.outputs\.sha \}\}/, name);
    assert.doesNotMatch(block, /inputs\.ref|workflow_run\.head_sha/, name);
  }
  // The gate decides on API evidence only: it checks out nothing of the release.
  assert.doesNotMatch(jobBlock('gate'), /inputs\.ref|workflow_run\.head_sha|ref: \$\{\{ needs\.preflight/);
});

test('the scripts come from the pinned workflow revision, never from the release being deployed (an older release has none)', () => {
  for (const name of ['preflight', 'staging', 'gate', 'production']) {
    const block = jobBlock(name);
    assert.match(block, /ref: \$\{\{ github\.sha \}\}\n\s+path: \.deploy-tools/, name);
    assert.doesNotMatch(block, /node scripts\//, name);
    assert.match(block, /node \.deploy-tools\/scripts\//, name);
  }
  // The canary policy is the pipeline's, read from the tooling checkout.
  assert.match(jobBlock('gate'), /deploy-gate\.mjs check [^\n]*--root \.deploy-tools/);
  assert.match(jobBlock('production'), /deploy-gate\.mjs check [^\n]*--root \.deploy-tools/);
});

test('a redeployment replaces the success of an earlier attempt: pending first, failure when it fails or is cancelled', () => {
  const productionJob = jobBlock('production');
  for (const [block, context] of [[jobBlock('staging'), 'deploy/staging'], [productionJob, '"deploy/production/$DEPLOY_COHORT"']]) {
    const pending = block.indexOf(`--context ${context} --state pending`);
    const deploy = block.indexOf('bash -c "$DEPLOY_COMMAND"');
    const success = block.indexOf(`--context ${context} --state success`);
    const failure = block.indexOf(`--context ${context} --state failure`);
    assert.ok(pending > 0 && pending < deploy && deploy < success && success < failure, context);
    // Only an attempt that really started may write the failure, so a refused gate leaves earlier evidence alone.
    assert.match(block, /if: \(failure\(\) \|\| cancelled\(\)\) && steps\.started\.outcome == 'success'/, context);
  }
  // The second gate check of the production job happens before the pending status is written.
  assert.ok(productionJob.indexOf('deploy-gate.mjs check') < productionJob.indexOf('--state pending'));
});

test('a pending or failed latest attempt outranks an earlier success, for staging and for the previous cohort', () => {
  assert.deepEqual(gate({ statuses: [staging('pending'), staging('success')] }), ['STAGING_NOT_GREEN']);
  assert.deepEqual(gate({ cohort: 'cohort-1', statuses: [production('pilot', 1, 'pending'), production('pilot', 500), staging()] }), ['PREVIOUS_COHORT_MISSING']);
  assert.deepEqual(gate({ cohort: 'cohort-1', statuses: [production('pilot', 1, 'failure'), production('pilot', 500), staging()] }), ['PREVIOUS_COHORT_MISSING']);
});

test('production waits for the gate and checks it again before running the command', () => {
  const production = jobBlock('production');
  assert.match(production, /needs: \[preflight, gate\]/);
  const check = production.indexOf('deploy-gate.mjs check');
  const command = production.indexOf('bash -c "$DEPLOY_COMMAND"');
  const record = production.indexOf('--state success');
  assert.ok(check > 0 && check < command && command < record, 'check, then deploy, then record');
  assert.match(jobBlock('gate'), /deploy-gate\.mjs check/);
});

test('staging records its evidence only after a real deployment', () => {
  const staging = jobBlock('staging');
  assert.match(staging, /if: success\(\) && vars\.DEPLOY_COMMAND_STAGING != ''/);
  assert.match(staging, /--context deploy\/staging --state success/);
  assert.match(staging, /statuses: write/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The error budget policy (ST-KERNEL-052).
// ---------------------------------------------------------------------------------------------------------------------

const policy = readErrorBudgetPolicy(REPO_ROOT);
const codesOfBudget = (overrides) => evaluateErrorBudget({ kind: 'feature', report: spent, policy, now: NOW, ...overrides }).problems.map((problem) => problem.code);

test('the error budget policy is read from the production pipeline declaration', () => {
  assert.deepEqual(policy, { blockedKinds: ['feature'], allowedKinds: ['reliability', 'security'], postMortemWorkingDays: 5, maxReportAgeMinutes: 15 });
});

test('AC-ST-KERNEL-052-2 UAT-NFR-AVAILABILITY-01: a feature release is blocked while the 30 day budget is spent, and a reliability or a security fix is allowed', () => {
  assert.deepEqual(codesOfBudget({ kind: 'feature' }), ['BUDGET_EXHAUSTED']);
  assert.deepEqual(codesOfBudget({ kind: 'reliability' }), []);
  assert.deepEqual(codesOfBudget({ kind: 'security' }), []);
  assert.deepEqual(codesOfBudget({ kind: 'feature', report: healthy }), []);
});

test('a fix is allowed even when the budget report is missing or stale, because a fix is how the budget is earned back', () => {
  for (const report of [undefined, { ...spent, generatedAt: minutesAgo(600) }]) {
    assert.deepEqual(codesOfBudget({ kind: 'security', report }), []);
    assert.deepEqual(codesOfBudget({ kind: 'reliability', report }), []);
  }
});

test('a feature release is refused when the gate cannot see the budget: no report, or a report older than the policy allows', () => {
  assert.deepEqual(codesOfBudget({ report: undefined }), ['BUDGET_UNKNOWN']);
  assert.deepEqual(codesOfBudget({ report: { ...healthy, generatedAt: minutesAgo(16) } }), ['BUDGET_STALE']);
  assert.deepEqual(codesOfBudget({ report: { ...healthy, generatedAt: minutesAgo(15) } }), []);
  assert.deepEqual(codesOfBudget({ report: { ...healthy, generatedAt: 'not a time' } }), ['BUDGET_STALE']);
});

test('a release kind the policy does not know is refused, whatever the budget is', () => {
  assert.deepEqual(codesOfBudget({ kind: 'hotfix', report: healthy }), ['KIND_UNKNOWN']);
});

test('the refusal names the day the budget ran out and the day the post-mortem is due', () => {
  const result = evaluateErrorBudget({ kind: 'feature', report: spent, policy, now: NOW });
  assert.equal(result.problems[0].detail, '2026-05-29 2026-06-05');
  assert.equal(result.postMortemDue, '2026-06-05');
  // Without the moment the budget ran out, the moment of the report stands in for it.
  const { exhaustedAt, ...withoutMoment } = spent;
  assert.notEqual(exhaustedAt, undefined);
  assert.equal(evaluateErrorBudget({ kind: 'feature', report: withoutMoment, policy, now: NOW }).postMortemDue, addWorkingDays(withoutMoment.generatedAt, 5));
});

test('AC-ST-KERNEL-052-2 UAT-NFR-AVAILABILITY-01: the post-mortem is due 5 working days after the day the budget ran out, on the calendar of Vietnam', () => {
  // Friday 2026-05-29: the 5 working days are Monday to Friday of the next week.
  assert.equal(addWorkingDays('2026-05-29T03:00:00Z', 5), '2026-06-05');
  // Saturday and Sunday count for nothing: the first working day after a Saturday is the Monday.
  assert.equal(addWorkingDays('2026-05-30T03:00:00Z', 5), '2026-06-05');
  assert.equal(addWorkingDays('2026-05-31T03:00:00Z', 5), '2026-06-05');
  // Monday: the fifth working day is the next Monday.
  assert.equal(addWorkingDays('2026-06-01T03:00:00Z', 5), '2026-06-08');
  assert.equal(addWorkingDays('2026-06-01T03:00:00Z', 1), '2026-06-02');
  assert.equal(addWorkingDays('2026-06-01T03:00:00Z', 0), '2026-06-01');
  // 20:00 UTC on Friday is already Saturday in Vietnam (UTC+7).
  assert.equal(vietnamDay('2026-05-29T20:00:00Z'), '2026-05-30');
  assert.equal(addWorkingDays('2026-05-29T20:00:00Z', 1), '2026-06-01');
});

test('AC-ST-KERNEL-052-2 UAT-NFR-AVAILABILITY-01: check refuses a feature release with a spent budget and passes a security fix, naming the due day', async () => {
  const path = reportFile('spent.json', spent);
  const base = ['check', '--locale', 'en', '--repo', 'o/r', '--sha', SHA, '--cohort', 'pilot', '--budget-report', path];
  const feature = await run([...base, '--kind', 'feature'], fakeApi());
  assert.equal(feature.code, 1);
  assert.match(feature.lines[0], /feature releases are stopped.*2026-05-29 2026-06-05/);
  assert.match(feature.lines.at(-1), /1 promotion gate\(s\) not met/);
  // The kind defaults to a feature release.
  assert.equal((await run(base, fakeApi())).code, 1);
  for (const kind of ['security', 'reliability']) assert.equal((await run([...base, '--kind', kind], fakeApi())).code, 0, kind);
});

test('check refuses a feature release when the budget report cannot be read', async () => {
  for (const path of [join(scratch, 'does-not-exist.json'), reportFile('garbage.json', 'not json'), reportFile('shape.json', { exhausted: 'yes' })]) {
    const { code, lines } = await run(['check', '--locale', 'en', '--repo', 'o/r', '--sha', SHA, '--cohort', 'pilot', '--budget-report', path], fakeApi());
    assert.equal(code, 1, path);
    assert.match(lines[0], /error budget of the core services is not known/);
  }
  assert.equal(readBudgetReport(undefined), undefined);
});

function issuesApi(existing = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => (init.method === 'GET' ? existing : {}) };
  };
  return { calls, fetchImpl };
}

test('AC-ST-KERNEL-052-2 UAT-NFR-AVAILABILITY-01: a spent budget opens one post-mortem task that states the day it is due, and asking again opens nothing', async () => {
  const path = reportFile('spent.json', spent);
  const api = issuesApi();
  const first = await run(['postmortem', '--locale', 'en', '--repo', 'o/r', '--budget-report', path], api);
  assert.equal(first.code, 0);
  assert.match(first.lines[0], /opened the post-mortem task, due 2026-06-05/);
  assert.deepEqual(
    api.calls.map((call) => [call.method, call.url]),
    [
      ['GET', 'https://api.example.test/repos/o/r/issues?labels=post-mortem&state=all&per_page=100'],
      ['POST', 'https://api.example.test/repos/o/r/issues'],
    ],
  );
  const created = api.calls[1].body;
  assert.equal(created.title, 'Post-mortem: error budget exhausted on 2026-05-29');
  assert.deepEqual(created.labels, ['post-mortem']);
  assert.match(created.body, /Due: 2026-06-05 \(5 working days\)/);
  const again = issuesApi([{ title: created.title }]);
  const second = await run(['postmortem', '--locale', 'en', '--repo', 'o/r', '--budget-report', path], again);
  assert.equal(second.code, 0);
  assert.match(second.lines[0], /already open, due 2026-06-05/);
  assert.deepEqual(again.calls.map((call) => call.method), ['GET']);
});

test('a healthy budget opens no post-mortem task, and an unreadable report is an error', async () => {
  const api = issuesApi();
  const quiet = await run(['postmortem', '--locale', 'en', '--repo', 'o/r', '--budget-report', reportFile('healthy.json', healthy)], api);
  assert.equal(quiet.code, 0);
  assert.match(quiet.lines[0], /no post-mortem task is needed/);
  assert.deepEqual(api.calls, []);
  const missing = await run(['postmortem', '--locale', 'en', '--repo', 'o/r', '--budget-report', join(scratch, 'nope.json')], api);
  assert.equal(missing.code, 1);
  const direct = await openPostMortem({ repo: 'o/r', report: undefined, policy }, { fetchImpl: api.fetchImpl, env: {} });
  assert.deepEqual(direct, { opened: false, reason: 'NOT_EXHAUSTED' });
});

test('the workflow passes the kind and the budget report to both checks of the gate, and opens the post-mortem task from the gate job', () => {
  for (const name of ['gate', 'production']) {
    assert.match(jobBlock(name), /deploy-gate\.mjs check [^\n]*--kind "\$DEPLOY_KIND" --budget-report budget-report\.json/, name);
    assert.match(jobBlock(name), /curl --fail[^\n]*"\$SLO_BUDGET_REPORT_URL"[^\n]*--output budget-report\.json/, name);
  }
  const gateJob = jobBlock('gate');
  assert.match(gateJob, /deploy-gate\.mjs postmortem [^\n]*--budget-report budget-report\.json/);
  assert.match(gateJob, /issues: write/);
  assert.match(WORKFLOW, /kind:\n\s+description: Kind of release[^\n]*\n\s+type: choice\n\s+options: \[feature, reliability, security\]/);
});
