import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'browsers.yml');
const workflow = () => load(readFileSync(WORKFLOW, 'utf8'));

/** What the cross-browser leg must be: a matrix of the two engines that browser.yml does not run, smoke only, one engine for each runner. */
export function browsersWorkflowProblems(parsed) {
  const problems = [];
  const jobs = Object.entries(parsed.jobs ?? {});
  if (jobs.length !== 1) problems.push(`one job expected, found ${jobs.length}`);
  const [, job] = jobs[0] ?? [undefined, {}];
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const runs = steps.map((step) => String(step.run ?? ''));
  if (!String(job['runs-on'] ?? '').startsWith('ubuntu')) problems.push('the job runs on an ubuntu runner');
  const engines = job.strategy?.matrix?.engine;
  if (!Array.isArray(engines) || [...engines].sort().join(',') !== 'firefox,webkit') problems.push('the matrix is firefox and webkit');
  if (job.strategy?.['fail-fast'] !== false) problems.push('one engine failing does not cancel the other');
  if (job.env?.E2E_BROWSERS !== '${{ matrix.engine }}') problems.push('E2E_BROWSERS is the engine of the leg');
  if (!steps.some((step) => String(step.uses ?? '').startsWith('actions/checkout'))) problems.push('the job checks the code out');
  if (!steps.some((step) => String(step.uses ?? '').startsWith('actions/setup-node') && step.with?.['node-version'] === 24)) problems.push('the job sets up Node 24');
  const install = runs.findIndex((run) => /^npm ci\b/.test(run.trim()));
  const browser = runs.findIndex((run) => /playwright install --with-deps \$\{\{ matrix\.engine \}\}/.test(run));
  const smoke = runs.findIndex((run) => /npm run e2e:smoke -w @machvon\/web\s*$/.test(run.trim()));
  if (install < 0) problems.push('the job installs the dependencies with npm ci');
  if (browser < 0) problems.push('the job installs the engine of the leg with its system libraries');
  if (smoke < 0) problems.push('the job runs npm run e2e:smoke');
  if (install >= 0 && smoke >= 0 && install > smoke) problems.push('dependencies are installed before the run');
  if (browser >= 0 && smoke >= 0 && browser > smoke) problems.push('the engine is installed before the run');
  if (runs.some((run) => /npm run e2e\s+-w|visual|route-walk/.test(run))) problems.push('the leg does not run the pixel baselines or the route walk');
  const group = parsed.concurrency?.group;
  if (typeof group !== 'string' || !group.includes('browsers') || !group.includes('github.ref')) problems.push('a concurrency group of this lane, per ref');
  if (parsed.concurrency?.['cancel-in-progress'] !== true) problems.push('a newer run of the same ref cancels the older one');
  if (!(job['timeout-minutes'] > 0)) problems.push('the job has a timeout');
  if (parsed.permissions?.contents !== 'read') problems.push('the token is read only');
  const upload = steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact'));
  if (upload === undefined || upload.if !== 'failure()') problems.push('the traces of a failed run are uploaded');
  return problems;
}

test('the cross-browser workflow is a valid YAML document that passes every rule', () => {
  assert.deepEqual(browsersWorkflowProblems(workflow()), []);
});

test('it runs on pushes to main and pull requests and can be started by hand', () => {
  const parsed = workflow();
  assert.deepEqual(parsed.on.push.branches, ['main']);
  assert.ok('pull_request' in parsed.on);
  assert.ok('workflow_dispatch' in parsed.on);
});

test('the matrix, the helper of the Playwright projects and the runbook name the same engines', () => {
  const engines = workflow().jobs.smoke.strategy.matrix.engine;
  const helper = readFileSync(join(REPO_ROOT, 'apps', 'web', 'e2e', 'support', 'browsers.ts'), 'utf8');
  for (const engine of engines) assert.match(helper, new RegExp(`'${engine}'`));
  const runbook = readFileSync(join(REPO_ROOT, 'docs', 'runbooks', 'browser-differences.md'), 'utf8');
  for (const engine of [...engines, 'chromium']) assert.match(runbook, new RegExp(engine, 'i'));
  const web = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'web', 'package.json'), 'utf8'));
  assert.ok(web.scripts['e2e:smoke']);
});

test('the other browser workflow still runs the whole suite on Chrome and is not part of this matrix', () => {
  const other = load(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'browser.yml'), 'utf8'));
  assert.equal(Object.keys(other.jobs).length, 1);
  assert.equal(other.jobs.browser.env.E2E_BROWSER_CHANNEL, 'chrome');
  assert.equal(other.jobs.browser.env.E2E_BROWSERS, undefined);
});

test('a workflow that breaks a rule is reported', () => {
  const clone = () => structuredClone(workflow());
  const withEngine = clone();
  withEngine.jobs.smoke.strategy.matrix.engine = ['firefox'];
  assert.ok(browsersWorkflowProblems(withEngine).some((problem) => problem.includes('matrix')));
  const cancelling = clone();
  cancelling.jobs.smoke.strategy['fail-fast'] = true;
  assert.ok(browsersWorkflowProblems(cancelling).some((problem) => problem.includes('cancel')));
  const noSmoke = clone();
  noSmoke.jobs.smoke.steps = noSmoke.jobs.smoke.steps.filter((step) => !String(step.run ?? '').includes('e2e:smoke'));
  assert.ok(browsersWorkflowProblems(noSmoke).some((problem) => problem.includes('e2e:smoke')));
  const walking = clone();
  walking.jobs.smoke.steps.push({ run: 'npx playwright test e2e/route-walk.spec.ts' });
  assert.ok(browsersWorkflowProblems(walking).some((problem) => problem.includes('route walk')));
  const noUpload = clone();
  noUpload.jobs.smoke.steps = noUpload.jobs.smoke.steps.filter((step) => !String(step.uses ?? '').startsWith('actions/upload-artifact'));
  assert.ok(browsersWorkflowProblems(noUpload).some((problem) => problem.includes('traces')));
  assert.ok(browsersWorkflowProblems({}).length > 3);
});
