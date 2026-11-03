import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCALE = 'vi';
const CI_WORKFLOW_FILE = 'ci.yml';
const API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;
const MS_PER_MINUTE = 60_000;
/** The commit status the staging job writes once the staging deployment of a commit succeeded. */
export const STAGING_CONTEXT = 'deploy/staging';
export const PRODUCTION_CONTEXT_PREFIX = 'deploy/production/';
const STATES = new Set(['success', 'failure', 'pending', 'error']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export const PROBLEM_CODES = [
  'SHA_INVALID',
  'CI_NOT_GREEN',
  'STAGING_NOT_GREEN',
  'COHORT_UNKNOWN',
  'PREVIOUS_COHORT_MISSING',
  'BAKE_NOT_ELAPSED',
  'KIND_UNKNOWN',
  'BUDGET_UNKNOWN',
  'BUDGET_STALE',
  'BUDGET_EXHAUSTED',
];
const MS_PER_DAY = 86_400_000;
/** Working days are counted on the calendar of Vietnam (UTC+7), Monday to Friday; public holidays are not known to this script. */
const VIETNAM_OFFSET_MS = 7 * 3_600_000;
const POST_MORTEM_LABEL = 'post-mortem';

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** The newest status of a context (the API lists newest first); undefined when the context never reported. */
function latestStatus(statuses, context) {
  return statuses.find((status) => status.context === context);
}

export function productionContext(cohort) {
  return `${PRODUCTION_CONTEXT_PREFIX}${cohort}`;
}

/**
 * Decides whether `sha` may be promoted to `cohort` in production. Inputs are API payloads, so the decision is a pure
 * function: the commit must have a successful CI run, the staging deployment of this exact commit must have succeeded,
 * and (past the first cohort) the previous cohort must have been promoted at least `bakeMinutes` ago.
 *
 * @param {{ sha: string, cohort: string, cohorts: string[], bakeMinutes: number, ciRuns: object[], statuses: object[], now: number }} input
 * @returns {{ problems: { code: string, detail: string }[] }}
 */
export function evaluateProductionGate({ sha, cohort, cohorts, bakeMinutes, ciRuns, statuses, now }) {
  const problems = [];
  if (!SHA_PATTERN.test(sha)) problems.push({ code: 'SHA_INVALID', detail: sha });
  const green = ciRuns.some((run) => run.head_sha === sha && run.status === 'completed' && run.conclusion === 'success');
  if (!green) problems.push({ code: 'CI_NOT_GREEN', detail: sha });
  if (latestStatus(statuses, STAGING_CONTEXT)?.state !== 'success') problems.push({ code: 'STAGING_NOT_GREEN', detail: STAGING_CONTEXT });
  const index = cohorts.indexOf(cohort);
  if (index < 0) {
    problems.push({ code: 'COHORT_UNKNOWN', detail: cohort });
  } else if (index > 0) {
    const previous = latestStatus(statuses, productionContext(cohorts[index - 1]));
    if (previous?.state !== 'success') {
      problems.push({ code: 'PREVIOUS_COHORT_MISSING', detail: cohorts[index - 1] });
    } else {
      const elapsed = (now - Date.parse(previous.created_at)) / MS_PER_MINUTE;
      if (!(elapsed >= bakeMinutes)) problems.push({ code: 'BAKE_NOT_ELAPSED', detail: `${cohorts[index - 1]} ${Math.max(0, Math.ceil(bakeMinutes - elapsed))}` });
    }
  }
  return { problems };
}

function apiBase(env) {
  return env.GITHUB_API_URL ?? 'https://api.github.com';
}

async function request(fetchImpl, env, method, path, body) {
  const response = await fetchImpl(`${apiBase(env)}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GH_TOKEN ?? ''}`,
      'x-github-api-version': API_VERSION,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

/** Writes a commit status. Production and staging evidence is a status on the deployed commit itself. */
export async function recordStatus({ repo, sha, context, state, description }, { fetchImpl = fetch, env = process.env } = {}) {
  return request(fetchImpl, env, 'POST', `/repos/${repo}/statuses/${sha}`, { state, context, description });
}

export async function loadEvidence({ repo, sha }, { fetchImpl = fetch, env = process.env } = {}) {
  const runs = await request(fetchImpl, env, 'GET', `/repos/${repo}/actions/workflows/${CI_WORKFLOW_FILE}/runs?head_sha=${sha}&per_page=${PAGE_SIZE}`);
  const statuses = await request(fetchImpl, env, 'GET', `/repos/${repo}/commits/${sha}/statuses?per_page=${PAGE_SIZE}`);
  return { ciRuns: runs.workflow_runs ?? [], statuses };
}

export function readCanaryPolicy(root = REPO_ROOT) {
  const policy = JSON.parse(readFileSync(join(root, 'infra', 'pipelines', 'production.json'), 'utf8'));
  return { cohorts: policy.canary.cohorts, bakeMinutes: policy.canary.bakeMinutes };
}

/** The calendar day (YYYY-MM-DD, Vietnam time) of a moment. */
export function vietnamDay(moment) {
  return new Date(Date.parse(moment) + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
}

/** The day, YYYY-MM-DD in Vietnam time, that is `workingDays` working days (Monday to Friday) after the day of `moment`. */
export function addWorkingDays(moment, workingDays) {
  let day = Date.parse(`${vietnamDay(moment)}T00:00:00Z`);
  for (let left = workingDays; left > 0; ) {
    day += MS_PER_DAY;
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return new Date(day).toISOString().slice(0, 10);
}

/** What the error budget stops (infra/pipelines/production.json, ST-KERNEL-052). */
export function readErrorBudgetPolicy(root = REPO_ROOT) {
  const policy = JSON.parse(readFileSync(join(root, 'infra', 'pipelines', 'production.json'), 'utf8')).errorBudget;
  return {
    blockedKinds: policy.blockedKinds,
    allowedKinds: policy.allowedKinds,
    postMortemWorkingDays: policy.postMortemWorkingDays,
    maxReportAgeMinutes: policy.maxReportAgeMinutes,
  };
}

/** The budget report the SLO evaluation exports (kernel `budgetReport`); undefined when the file is missing or is not one. */
export function readBudgetReport(path) {
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    return typeof report?.exhausted === 'boolean' && typeof report.generatedAt === 'string' ? report : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decides whether a release of `kind` may go out while the error budget is in the state `report` says. Reliability and
 * security fixes always may (they are how the budget is earned back). A feature release is stopped when the budget is spent
 * and, because a gate that cannot see the budget cannot vouch for it, also when the report is missing or older than the
 * policy allows. A kind the policy does not know is refused.
 *
 * @returns {{ problems: { code: string, detail: string }[], postMortemDue?: string }}
 */
export function evaluateErrorBudget({ kind, report, policy, now }) {
  if (policy.allowedKinds.includes(kind)) return { problems: [] };
  if (!policy.blockedKinds.includes(kind)) return { problems: [{ code: 'KIND_UNKNOWN', detail: kind }] };
  if (report === undefined) return { problems: [{ code: 'BUDGET_UNKNOWN', detail: kind }] };
  const age = (now - Date.parse(report.generatedAt)) / MS_PER_MINUTE;
  if (!(age <= policy.maxReportAgeMinutes)) return { problems: [{ code: 'BUDGET_STALE', detail: report.generatedAt }] };
  if (!report.exhausted) return { problems: [] };
  const since = report.exhaustedAt ?? report.generatedAt;
  const postMortemDue = addWorkingDays(since, policy.postMortemWorkingDays);
  return { problems: [{ code: 'BUDGET_EXHAUSTED', detail: `${vietnamDay(since)} ${postMortemDue}` }], postMortemDue };
}

/**
 * Opens the post-mortem task of a spent budget as an issue, once: a second call finds the issue of the same day and opens
 * nothing. The issue states the day by which the post-mortem is due.
 */
export async function openPostMortem({ repo, report, policy }, { fetchImpl = fetch, env = process.env } = {}) {
  if (report?.exhausted !== true) return { opened: false, reason: 'NOT_EXHAUSTED' };
  const since = report.exhaustedAt ?? report.generatedAt;
  const due = addWorkingDays(since, policy.postMortemWorkingDays);
  const title = `Post-mortem: error budget exhausted on ${vietnamDay(since)}`;
  const existing = await request(fetchImpl, env, 'GET', `/repos/${repo}/issues?labels=${POST_MORTEM_LABEL}&state=all&per_page=${PAGE_SIZE}`);
  if (existing.some((issue) => issue.title === title)) return { opened: false, reason: 'EXISTS', due };
  const body = [
    `The 30 day error budget was spent on ${vietnamDay(since)}. Feature releases are stopped until it recovers; reliability and security fixes are allowed.`,
    `Due: ${due} (${policy.postMortemWorkingDays} working days).`,
  ].join('\n\n');
  await request(fetchImpl, env, 'POST', `/repos/${repo}/issues`, { title, body, labels: [POST_MORTEM_LABEL] });
  return { opened: true, due };
}

const OPTIONS = {
  sha: { type: 'string' },
  cohort: { type: 'string' },
  repo: { type: 'string' },
  context: { type: 'string' },
  state: { type: 'string' },
  description: { type: 'string', default: '' },
  kind: { type: 'string', default: 'feature' },
  'budget-report': { type: 'string' },
  'exhausted-at': { type: 'string' },
  root: { type: 'string', default: REPO_ROOT },
  locale: { type: 'string', default: DEFAULT_LOCALE },
};

/**
 * `check --sha <sha> --cohort <cohort> --repo <owner/name>` exits 1 when the promotion is not allowed.
 * `record --sha <sha> --repo <owner/name> --context <context> --state <state>` writes a commit status.
 * `postmortem --repo <owner/name> --budget-report <file>` opens the post-mortem task when the budget report says the budget is spent.
 */
export async function main(argv, { log = console.log, fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch {
    log(loadMessages(DEFAULT_LOCALE)['deployGate.usage']);
    return 2;
  }
  const { values, positionals } = parsed;
  const messages = loadMessages(values.locale);
  const [command] = positionals;
  const complete = values.sha !== undefined && values.repo !== undefined;
  if (command === 'record' && complete && values.context !== undefined && STATES.has(values.state ?? '')) {
    await recordStatus({ repo: values.repo, sha: values.sha, context: values.context, state: values.state, description: values.description }, { fetchImpl, env });
    log(format(messages['deployGate.recorded'], { context: values.context, state: values.state }));
    return 0;
  }
  if (command === 'check' && complete && values.cohort !== undefined) {
    const policy = readCanaryPolicy(resolve(values.root));
    const evidence = await loadEvidence({ repo: values.repo, sha: values.sha }, { fetchImpl, env });
    const { problems } = evaluateProductionGate({ sha: values.sha, cohort: values.cohort, ...policy, ...evidence, now });
    const budget = evaluateErrorBudget({ kind: values.kind, report: readBudgetReport(values['budget-report']), policy: readErrorBudgetPolicy(resolve(values.root)), now });
    problems.push(...budget.problems);
    for (const problem of problems) log(format(messages[`deployGate.${problem.code}`], { detail: problem.detail }));
    log(problems.length === 0 ? format(messages['deployGate.summary.pass'], { sha: values.sha, cohort: values.cohort }) : format(messages['deployGate.summary.fail'], { count: problems.length }));
    return problems.length === 0 ? 0 : 1;
  }
  if (command === 'postmortem' && values.repo !== undefined && values['budget-report'] !== undefined) {
    const report = readBudgetReport(values['budget-report']);
    if (report === undefined) {
      log(format(messages['deployGate.BUDGET_UNKNOWN'], { detail: values['budget-report'] }));
      return 1;
    }
    const result = await openPostMortem({ repo: values.repo, report, policy: readErrorBudgetPolicy(resolve(values.root)) }, { fetchImpl, env });
    log(format(messages[`deployGate.postMortem.${result.reason ?? 'OPENED'}`], { due: result.due ?? '' }));
    return 0;
  }
  log(messages['deployGate.usage']);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
