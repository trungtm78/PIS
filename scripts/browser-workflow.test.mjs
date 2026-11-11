import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'browser.yml');
const REPORT_PATH = 'apps/web/e2e/report.json';
const DIFF_DIRECTORY = 'apps/web/e2e/__diff__/';
const LINUX_BASELINES_ARTIFACT = 'visual-baselines-linux';

// ---------------------------------------------------------------------------------------------------------------------
// A reader for the subset of YAML that the workflow uses: block maps and lists, inline lists, quoted scalars and `|`
// block scalars. The repository has no YAML parser in its lockfile, and a structure check does not need a full one.
// ---------------------------------------------------------------------------------------------------------------------

function scalar(text) {
  const value = text.trim();
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').map((part) => scalar(part)).filter((part) => part !== '');
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function tokenise(text) {
  return text
    .split(/\r?\n/)
    .map((raw) => ({ raw, indent: raw.length - raw.trimStart().length, body: raw.trim() }))
    .filter((line) => line.body !== '' && !line.body.startsWith('#'));
}

function parseBlock(lines, start, indent) {
  if (lines[start].body.startsWith('- ')) return parseList(lines, start, indent);
  return parseMap(lines, start, indent);
}

function parseMap(lines, start, indent) {
  const result = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent && !lines[index].body.startsWith('- ')) {
    const match = /^([^:]+):(?:\s+(.*))?$/.exec(lines[index].body);
    assert.ok(match, `not a map entry: ${lines[index].raw}`);
    const key = match[1].trim();
    const rest = match[2];
    index += 1;
    if (rest === '|') {
      const parts = [];
      while (index < lines.length && lines[index].indent > indent) parts.push(lines[index++].body);
      result[key] = parts.join('\n');
    } else if (rest !== undefined && rest !== '') {
      result[key] = scalar(rest);
    } else if (index < lines.length && (lines[index].indent > indent || (lines[index].indent === indent && lines[index].body.startsWith('- ')))) {
      const child = parseBlock(lines, index, lines[index].indent);
      result[key] = child.value;
      index = child.next;
    } else {
      result[key] = null;
    }
  }
  return { value: result, next: index };
}

function parseList(lines, start, indent) {
  const items = [];
  let index = start;
  while (index < lines.length && lines[index].indent === indent && lines[index].body.startsWith('- ')) {
    const inner = lines[index].body.slice(2);
    const innerIndent = indent + 2;
    // The text after "- " is the first line of a map that continues on the following, deeper lines.
    const rewritten = [{ raw: inner, indent: innerIndent, body: inner }];
    let end = index + 1;
    while (end < lines.length && lines[end].indent >= innerIndent) rewritten.push(lines[end++]);
    items.push(/^[^:'"\s][^:]*:(\s|$)/.test(inner) ? parseMap(rewritten, 0, innerIndent).value : scalar(inner));
    index = end;
  }
  return { value: items, next: index };
}

export function parseYaml(text) {
  const lines = tokenise(text);
  return parseBlock(lines, 0, lines[0].indent).value;
}

// ---------------------------------------------------------------------------------------------------------------------
// The structure rules of the browser workflow
// ---------------------------------------------------------------------------------------------------------------------

const usesOf = (step) => (typeof step.uses === 'string' ? step.uses.split('@')[0] : undefined);
const runsOf = (step) => (typeof step.run === 'string' ? step.run : '');
const artifactPaths = (steps) => steps.filter((step) => usesOf(step) === 'actions/upload-artifact').map((step) => String(step.with?.path ?? ''));

/** The problems of a parsed workflow against the rules of the browser lane; an empty list means it is as designed. */
export function browserWorkflowProblems(workflow) {
  const problems = [];
  const jobs = Object.entries(workflow.jobs ?? {});
  if (jobs.length !== 1) problems.push(`the lane is one job, found ${jobs.length}`);
  const [, job] = jobs[0] ?? [undefined, {}];
  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (!String(job['runs-on'] ?? '').startsWith('ubuntu')) problems.push('the job runs on an ubuntu runner');
  const group = workflow.concurrency?.group ?? job.concurrency?.group;
  const cancel = workflow.concurrency?.['cancel-in-progress'] ?? job.concurrency?.['cancel-in-progress'];
  if (typeof group !== 'string' || !group.includes('browser')) problems.push('a concurrency group named for the browser lane replaces the run lock');
  if (!String(group ?? '').includes('github.ref')) problems.push('the concurrency group is per ref');
  if (cancel !== true) problems.push('a newer run of the same ref cancels the older one');
  if (!steps.some((step) => usesOf(step) === 'actions/checkout')) problems.push('the job checks the code out');
  if (!steps.some((step) => usesOf(step) === 'actions/setup-node' && step.with?.['node-version'] === 24)) problems.push('the job sets up Node 24');
  const install = steps.findIndex((step) => /^npm ci\b/.test(runsOf(step).trim()));
  const chrome = steps.findIndex((step) => /playwright install\b.*\bchrome\b/.test(runsOf(step)));
  const run = steps.findIndex((step) => /npm run e2e -w @machvon\/web\s*$/.test(runsOf(step).trim()));
  if (install < 0) problems.push('the job installs the dependencies with npm ci');
  if (chrome < 0) problems.push('the job installs Google Chrome');
  if (run < 0) problems.push('the job runs the walk, the flows and the visual regions with npm run e2e -w @machvon/web');
  if (install >= 0 && run >= 0 && install > run) problems.push('dependencies are installed before the browser run');
  if (chrome >= 0 && run >= 0 && chrome > run) problems.push('Chrome is installed before the browser run');
  if (job.env?.E2E_BROWSER_CHANNEL !== 'chrome') problems.push('the browser channel is chrome (the baselines were rendered with it)');
  const uploads = steps.filter((step) => usesOf(step) === 'actions/upload-artifact');
  const paths = artifactPaths(steps);
  if (!paths.includes(REPORT_PATH)) problems.push(`the artifacts include ${REPORT_PATH}`);
  if (!paths.some((path) => path === DIFF_DIRECTORY || path.startsWith(DIFF_DIRECTORY))) problems.push(`the artifacts include the diff images under ${DIFF_DIRECTORY}`);
  // The Linux baselines are an upload of the run that renders them (update_visual); every other artifact is kept even when the run fails.
  if (uploads.some((step) => step.if !== 'always()' && step.with?.name !== LINUX_BASELINES_ARTIFACT)) problems.push('artifacts are uploaded even when the run fails (if: always())');
  if (workflow.on?.workflow_dispatch?.inputs?.update_visual === undefined) problems.push('a run by hand can render the Linux visual baselines (input update_visual)');
  if (!uploads.some((step) => step.with?.name === LINUX_BASELINES_ARTIFACT && step.if !== undefined)) problems.push(`the rendered Linux baselines are uploaded as ${LINUX_BASELINES_ARTIFACT} when update_visual is set`);
  if (!(job['timeout-minutes'] > 0)) problems.push('the job has a timeout');
  return problems;
}

const real = () => parseYaml(readFileSync(WORKFLOW, 'utf8'));

test('the browser workflow is one ubuntu job with Chrome, the whole browser run, a concurrency group and the artifacts', () => {
  assert.deepEqual(browserWorkflowProblems(real()), []);
});

test('the workflow runs on pushes to main and pull requests and can be started by hand', () => {
  const workflow = real();
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok('pull_request' in workflow.on);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.equal(workflow.permissions.contents, 'read');
});

test('the artifact paths are the files the browser run writes', () => {
  const visual = readFileSync(join(REPO_ROOT, 'apps', 'web', 'e2e', 'visual.spec.ts'), 'utf8');
  const report = readFileSync(join(REPO_ROOT, 'apps', 'web', 'e2e', 'support', 'report.ts'), 'utf8');
  assert.match(visual, /new URL\('\.\/__diff__', import\.meta\.url\)/);
  assert.match(report, /resolve\(HERE, '\.\.', 'report\.json'\)/);
  const web = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'web', 'package.json'), 'utf8'));
  assert.match(web.scripts.e2e, /route-walk\.spec\.ts/);
  assert.match(web.scripts.e2e, /visual\.spec\.ts/);
  assert.match(web.scripts.e2e, /flows\.spec\.ts/);
});

test('the reader understands the shapes of the workflow', () => {
  const parsed = parseYaml(['a:', '  b: [x, y]', '  c:', '    - name: one', '      run: |', '        first', '        second', '    - uses: u@v1', "  d: '1'"].join('\n'));
  assert.deepEqual(parsed, { a: { b: ['x', 'y'], c: [{ name: 'one', run: 'first\nsecond' }, { uses: 'u@v1' }], d: '1' } });
});

test('a workflow without a concurrency group, Chrome, the run, the report or always() uploads is reported', () => {
  const base = real();
  const clone = () => structuredClone(base);
  const withoutConcurrency = clone();
  delete withoutConcurrency.concurrency;
  assert.ok(browserWorkflowProblems(withoutConcurrency).some((problem) => problem.includes('concurrency group')));

  const noCancel = clone();
  noCancel.concurrency['cancel-in-progress'] = false;
  assert.ok(browserWorkflowProblems(noCancel).some((problem) => problem.includes('cancels')));

  const noChrome = clone();
  noChrome.jobs.browser.steps = noChrome.jobs.browser.steps.filter((step) => !String(step.run ?? '').includes('playwright install'));
  assert.ok(browserWorkflowProblems(noChrome).some((problem) => problem.includes('Chrome')));

  const noRun = clone();
  noRun.jobs.browser.steps = noRun.jobs.browser.steps.filter((step) => !String(step.run ?? '').includes('npm run e2e'));
  assert.ok(browserWorkflowProblems(noRun).some((problem) => problem.includes('npm run e2e')));

  const noReport = clone();
  noReport.jobs.browser.steps = noReport.jobs.browser.steps.filter((step) => step.with?.path !== REPORT_PATH);
  assert.ok(browserWorkflowProblems(noReport).some((problem) => problem.includes('report.json')));

  const noDiffs = clone();
  noDiffs.jobs.browser.steps = noDiffs.jobs.browser.steps.filter((step) => step.with?.path !== DIFF_DIRECTORY);
  assert.ok(browserWorkflowProblems(noDiffs).some((problem) => problem.includes('diff images')));

  const onlyOnSuccess = clone();
  for (const step of onlyOnSuccess.jobs.browser.steps) if (step.uses?.startsWith('actions/upload-artifact')) delete step.if;
  assert.ok(browserWorkflowProblems(onlyOnSuccess).some((problem) => problem.includes('always()')));

  const noUpdateInput = clone();
  delete noUpdateInput.on.workflow_dispatch.inputs;
  assert.ok(browserWorkflowProblems(noUpdateInput).some((problem) => problem.includes('update_visual')));

  const noBaselineUpload = clone();
  noBaselineUpload.jobs.browser.steps = noBaselineUpload.jobs.browser.steps.filter((step) => step.with?.name !== LINUX_BASELINES_ARTIFACT);
  assert.ok(browserWorkflowProblems(noBaselineUpload).some((problem) => problem.includes(LINUX_BASELINES_ARTIFACT)));

  const twoJobs = clone();
  twoJobs.jobs.second = twoJobs.jobs.browser;
  assert.ok(browserWorkflowProblems(twoJobs).some((problem) => problem.includes('one job')));

  const wrongRunner = clone();
  wrongRunner.jobs.browser['runs-on'] = 'windows-latest';
  assert.ok(browserWorkflowProblems(wrongRunner).some((problem) => problem.includes('ubuntu')));
});
