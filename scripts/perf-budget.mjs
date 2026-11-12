import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * The performance budget of the customer, as a runner that needs nothing but Node: every function answers in under 5 seconds and every report in under 20 seconds.
 * `docs/qa/perf-budget.json` lists the hot reads and the report exports of the contract with their class; this script calls them against any API base URL with a bearer token,
 * takes the samples one after the other, reports p50 and p95 for each and exits 1 when one is over its budget (or fails). The same table drives the k6 scripts of `tests/k6`.
 *
 *   node scripts/perf-budget.mjs --base-url https://host/v1 --token <jwt> --vars vars.json [--only HOME,REPORT] [--samples 20] [--strict] [--out result.json]
 *
 * Exit codes: 0 every measured operation is within its budget; 1 one is over its budget or failed; 2 wrong usage or a budget table that is not valid; 3 `--strict` and an operation could not be measured.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BUDGET = join(SCRIPT_DIR, '..', 'docs', 'qa', 'perf-budget.json');
const STATS = ['p50', 'p95', 'max'];
const VARIABLE_REFERENCE = /^\$([A-Za-z][A-Za-z0-9]*)$/;

/** Nearest-rank percentile of a list of numbers (p from 0 to 100). */
export function percentile(values, p) {
  if (values.length === 0) throw new RangeError('percentile of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** The budget of one operation: its own `budgetMs` when it tightens the budget of its class (a snapshot read at 800 ms), else the budget of the class. */
export const limitOf = (entry, budget) => entry.budgetMs ?? budget.classes[entry.class].budgetMs;

const round = (value) => Math.round(value * 10) / 10;

/** The figures of one operation from its samples: `{ ms, status }` where status 0 means no answer (timeout or network failure). */
export function summarize(samples) {
  const times = samples.map((sample) => sample.ms);
  const failed = samples.filter((sample) => sample.status < 200 || sample.status >= 400);
  return {
    samples: samples.length,
    failed: failed.length,
    statuses: [...new Set(failed.map((sample) => sample.status))].sort((a, b) => a - b),
    min: times.length === 0 ? 0 : round(Math.min(...times)),
    p50: times.length === 0 ? 0 : round(percentile(times, 50)),
    p95: times.length === 0 ? 0 : round(percentile(times, 95)),
    max: times.length === 0 ? 0 : round(Math.max(...times)),
  };
}

const EDITIONS = ['PUBLIC', 'ENTERPRISE'];

/** What is wrong with the optional `budgetMs` (only tighter than the class), `scale` (times the demo volume the row is measured at) and `edition` of a row. */
function rowLimitProblems(label, entry, classes) {
  const problems = [];
  if (entry?.budgetMs !== undefined) {
    const classLimit = classes[entry.class]?.budgetMs;
    if (!Number.isInteger(entry.budgetMs) || entry.budgetMs <= 0) problems.push(`${label} budgetMs must be a positive whole number of milliseconds`);
    else if (Number.isInteger(classLimit) && entry.budgetMs > classLimit) problems.push(`${label} budgetMs ${entry.budgetMs} is over the ${classLimit} ms of its class ${entry.class}`);
  }
  if (entry?.scale !== undefined && (!Number.isInteger(entry.scale) || entry.scale < 1)) problems.push(`${label} scale must be a whole number of at least 1`);
  if (entry?.edition !== undefined && !EDITIONS.includes(entry.edition)) problems.push(`${label} has an unknown edition ${entry.edition}`);
  return problems;
}

/** Problems of a budget table: what would make a run meaningless. An empty list is a valid table. */
export function budgetProblems(budget) {
  const problems = [];
  if (budget === null || typeof budget !== 'object') return ['the budget is not an object'];
  const classes = budget.classes ?? {};
  if (Object.keys(classes).length === 0) problems.push('no classes');
  for (const [name, entry] of Object.entries(classes)) if (!Number.isInteger(entry?.budgetMs) || entry.budgetMs <= 0) problems.push(`class ${name} has no positive budgetMs`);
  const defaults = budget.defaults ?? {};
  if (defaults.stat !== undefined && !STATS.includes(defaults.stat)) problems.push(`unknown default stat ${defaults.stat}`);
  if (!Array.isArray(budget.operations) || budget.operations.length === 0) {
    problems.push('no operations');
    return problems;
  }
  const variables = new Set(Object.keys(budget.variables ?? {}));
  const ids = new Set();
  const operationIds = new Set();
  for (const entry of budget.operations) {
    const label = entry?.id ?? '(no id)';
    if (typeof entry?.id !== 'string' || entry.id === '') problems.push('an operation has no id');
    else if (ids.has(entry.id)) problems.push(`${label} is listed twice`);
    else ids.add(entry.id);
    if (typeof entry?.operationId !== 'string' || entry.operationId === '') problems.push(`${label} has no operationId`);
    else if (operationIds.has(entry.operationId)) problems.push(`${label} repeats the operation ${entry.operationId}`);
    else operationIds.add(entry.operationId);
    if (entry?.method !== 'GET') problems.push(`${label} is not a GET: only reads and downloads are measured`);
    if (typeof entry?.path !== 'string' || !entry.path.startsWith('/')) problems.push(`${label} has no path`);
    if (classes[entry?.class] === undefined) problems.push(`${label} has an unknown class ${entry?.class}`);
    problems.push(...rowLimitProblems(label, entry, classes));
    const placeholders = [...String(entry?.path ?? '').matchAll(/\{(\w+)\}/g)].map((found) => found[1]);
    for (const name of placeholders) {
      const fixed = entry.pathFixed?.[name];
      const variable = entry.pathVars?.[name];
      if (fixed === undefined && variable === undefined) problems.push(`${label} has no value for {${name}}`);
      if (variable !== undefined && !variables.has(variable)) problems.push(`${label} uses the undeclared variable ${variable}`);
    }
    for (const [name, value] of Object.entries(entry?.query ?? {})) {
      const reference = VARIABLE_REFERENCE.exec(String(value));
      if (reference !== null && !variables.has(reference[1])) problems.push(`${label} query ${name} uses the undeclared variable ${reference[1]}`);
    }
  }
  for (const [name, rule] of Object.entries(budget.discovery ?? {})) {
    if (!variables.has(name)) problems.push(`discovery of ${name} names a variable the table does not declare`);
    if (typeof rule?.path !== 'string' || !rule.path.startsWith('/') || /\{\w+\}/.test(rule.path)) problems.push(`discovery of ${name} has no fixed path`);
    if (typeof rule?.pick !== 'string' || rule.pick === '') problems.push(`discovery of ${name} has no pick`);
  }
  return problems;
}

/** The value at a dotted path of a parsed answer (`items.0.id`), or undefined. */
export function pickValue(answer, pick) {
  let at = answer;
  for (const step of String(pick).split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = at[step];
  }
  return at;
}

/**
 * Finds the ids the table needs in the tenant that is measured, by reading the first row of a list the API already serves (the `discovery` of the table): a variable that is given is kept, a list that is
 * empty or refused leaves the variable missing (its operations are then `SKIPPED` with the name of the variable, and `problems` says why). Nothing is written to the tenant.
 */
export async function discoverVariables({ budget, baseUrl, token, headers = {}, vars = {}, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const found = {};
  const problems = [];
  const requestHeaders = { accept: 'application/json', ...headers, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) };
  for (const [name, rule] of Object.entries(budget.discovery ?? {})) {
    if (vars[name] !== undefined && vars[name] !== '') continue;
    const query = new URLSearchParams(rule.query ?? {}).toString();
    const url = `${baseUrl.replace(/\/+$/, '')}${rule.path}${query === '' ? '' : `?${query}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: requestHeaders, signal: controller.signal });
      if (response.status < 200 || response.status >= 300) {
        problems.push(`${name}: ${rule.path} answered ${response.status}`);
        continue;
      }
      const value = pickValue(await response.json(), rule.pick);
      if (typeof value === 'string' && value !== '') found[name] = value;
      else problems.push(`${name}: ${rule.path} has nothing at ${rule.pick} (the tenant has no such row)`);
    } catch {
      problems.push(`${name}: ${rule.path} could not be read`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { found, problems };
}

/** The URL of one operation, or the variables it lacks. Path values are percent-encoded. */
export function buildRequest(entry, baseUrl, vars) {
  const missing = [];
  const value = (variable) => {
    if (vars[variable] === undefined || vars[variable] === '') {
      if (!missing.includes(variable)) missing.push(variable);
      return '';
    }
    return String(vars[variable]);
  };
  const path = entry.path.replace(/\{(\w+)\}/g, (_match, name) => {
    const fixed = entry.pathFixed?.[name];
    return encodeURIComponent(fixed !== undefined ? fixed : value(entry.pathVars?.[name]));
  });
  const query = new URLSearchParams();
  for (const [name, raw] of Object.entries(entry.query ?? {})) {
    const reference = VARIABLE_REFERENCE.exec(String(raw));
    query.set(name, reference === null ? String(raw) : value(reference[1]));
  }
  const text = query.toString();
  return { url: `${baseUrl.replace(/\/+$/, '')}${path}${text === '' ? '' : `?${text}`}`, missing };
}

/** The verdict on one operation: over budget (by the chosen statistic), failed (some samples got no 2xx or 3xx), or within the budget. */
export function evaluateEntry(entry, stats, budget, stat) {
  const limit = limitOf(entry, budget);
  if (stats.failed > 0) return { status: 'FAIL', reason: `${stats.failed} of ${stats.samples} samples failed (status ${stats.statuses.join(',')})`, limit };
  const measured = stats[stat];
  if (measured > limit) return { status: 'FAIL', reason: `${stat} ${measured} ms is over the budget of ${limit} ms`, limit };
  return { status: 'PASS', reason: '', limit };
}

const timedFetch = async (fetchImpl, url, headers, timeoutMs, now) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
    // The whole body counts: a report is not done until it has been received.
    await response.arrayBuffer();
    return { ms: now() - started, status: response.status };
  } catch {
    return { ms: now() - started, status: 0 };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Measures the operations of the table. Each operation is called `warmup` times (not counted) and then `samples` times, one request at a time. An operation whose variables are not given is `SKIPPED`
 * with the names of the missing variables. A request that has no answer within twice its budget is a failed sample.
 */
export async function runBudget({ budget, baseUrl, token, vars = {}, headers = {}, samples, warmup, stat, only, fetchImpl = fetch, now = () => performance.now(), onResult }) {
  const count = samples ?? budget.defaults?.samples ?? 20;
  const skip = warmup ?? budget.defaults?.warmup ?? 2;
  const chosenStat = stat ?? budget.defaults?.stat ?? 'p95';
  const results = [];
  for (const entry of selectOperations(budget, only)) {
    const { url, missing } = buildRequest(entry, baseUrl, vars);
    const limit = limitOf(entry, budget);
    let result;
    if (missing.length > 0) {
      result = { id: entry.id, operationId: entry.operationId, class: entry.class, path: entry.path, status: 'SKIPPED', reason: `missing variables: ${missing.join(', ')}`, limit, stats: undefined };
    } else {
      const requestHeaders = { accept: '*/*', ...headers, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) };
      const timeoutMs = limit * 2;
      for (let round = 0; round < skip; round += 1) await timedFetch(fetchImpl, url, requestHeaders, timeoutMs, now);
      const taken = [];
      for (let round = 0; round < count; round += 1) taken.push(await timedFetch(fetchImpl, url, requestHeaders, timeoutMs, now));
      const stats = summarize(taken);
      result = { id: entry.id, operationId: entry.operationId, class: entry.class, path: entry.path, stats, ...evaluateEntry(entry, stats, budget, chosenStat) };
    }
    results.push(result);
    if (onResult !== undefined) onResult(result);
  }
  return results;
}

/** The operations a run covers: all, or those whose id, operationId, area or class is in the list. */
export function selectOperations(budget, only) {
  if (only === undefined || only.length === 0) return budget.operations;
  const wanted = new Set(only.map((item) => item.toUpperCase()));
  return budget.operations.filter((entry) => [entry.id, entry.operationId, entry.area, entry.class].some((key) => key !== undefined && wanted.has(String(key).toUpperCase())));
}

export function exitCode(results, strict) {
  // A run that measured nothing proves nothing.
  if (results.length === 0 || results.some((result) => result.status === 'FAIL')) return 1;
  if (strict && results.some((result) => result.status === 'SKIPPED')) return 3;
  return 0;
}

const pad = (text, width) => String(text).padEnd(width);

/** One line for an operation. */
export function formatLine(result) {
  const figures = result.stats === undefined ? '' : `p50 ${result.stats.p50} ms  p95 ${result.stats.p95} ms  max ${result.stats.max} ms`;
  return `${pad(result.status, 8)}${pad(result.id, 9)}${pad(result.class, 9)}${pad(result.operationId, 36)}${pad(figures, 48)}budget ${result.limit} ms${result.reason === '' ? '' : `  ${result.reason}`}`;
}

/** The summary of a run for the end of the output and for `--out`. */
export function summaryOf(results) {
  const count = (status) => results.filter((result) => result.status === status).length;
  return { total: results.length, pass: count('PASS'), fail: count('FAIL'), skipped: count('SKIPPED') };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} ${path} cannot be read as JSON: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
}

const USAGE = [
  'usage: node scripts/perf-budget.mjs --base-url <url> [--token <jwt>] [--vars <file.json>] [--var name=value] [--only <ids,areas,class>] [--samples <n>] [--warmup <n>] [--stat p50|p95|max]',
  '                                    [--budget <file>] [--header "Name: value"] [--strict] [--list] [--check] [--out <file.json>] [--discover] [--vars-out <file.json>]',
  '--discover reads the first row of the lists named in the `discovery` of the table to find the ids that --vars and --var did not give; --vars-out writes the variables that were used (for the k6 scripts).',
  'the token can also be given in PERF_TOKEN; the base URL includes the version prefix (https://host/v1).',
].join('\n');

export async function main(argv, { log = console.log, env = process.env, fetchImpl = fetch, now = () => performance.now() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'base-url': { type: 'string' },
        token: { type: 'string' },
        vars: { type: 'string' },
        var: { type: 'string', multiple: true },
        only: { type: 'string' },
        samples: { type: 'string' },
        warmup: { type: 'string' },
        stat: { type: 'string' },
        budget: { type: 'string' },
        header: { type: 'string', multiple: true },
        strict: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        out: { type: 'string' },
        discover: { type: 'boolean', default: false },
        'vars-out': { type: 'string' },
      },
    }));
  } catch {
    log(USAGE);
    return 2;
  }
  let budget;
  try {
    budget = readJson(resolve(values.budget ?? DEFAULT_BUDGET), 'the budget');
  } catch (error) {
    log(error instanceof Error ? error.message : 'the budget cannot be read');
    return 2;
  }
  const problems = budgetProblems(budget);
  if (problems.length > 0) {
    log(['the budget table is not valid:', ...problems.map((problem) => `  ${problem}`)].join('\n'));
    return 2;
  }
  const only = values.only === undefined ? undefined : values.only.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (values.check) {
    const count = (name) => budget.operations.filter((entry) => entry.class === name).length;
    log(`the budget table is valid: ${budget.operations.length} operations (${Object.keys(budget.classes).map((name) => `${count(name)} ${name} at ${budget.classes[name].budgetMs} ms`).join(', ')})`);
    return 0;
  }
  if (values.list) {
    for (const entry of selectOperations(budget, only)) log(`${pad(entry.id, 9)}${pad(entry.class, 9)}${pad(`${limitOf(entry, budget)} ms`, 10)}${entry.method} ${entry.path}`);
    return 0;
  }
  if (selectOperations(budget, only).length === 0) {
    log(`no operation of the table matches --only ${values.only}`);
    return 2;
  }
  if (values['base-url'] === undefined || !/^https?:\/\//.test(values['base-url'])) {
    log(USAGE);
    return 2;
  }
  const integer = (text, fallback) => (text === undefined ? fallback : Number(text));
  const samples = integer(values.samples, undefined);
  const warmup = integer(values.warmup, undefined);
  if ((samples !== undefined && !(Number.isInteger(samples) && samples >= 1)) || (warmup !== undefined && !(Number.isInteger(warmup) && warmup >= 0)) || (values.stat !== undefined && !STATS.includes(values.stat))) {
    log(USAGE);
    return 2;
  }
  let vars = {};
  try {
    if (values.vars !== undefined) vars = { ...readJson(resolve(values.vars), 'the variables file') };
  } catch (error) {
    log(error instanceof Error ? error.message : 'the variables cannot be read');
    return 2;
  }
  for (const pair of values.var ?? []) {
    const at = pair.indexOf('=');
    if (at < 1) {
      log(USAGE);
      return 2;
    }
    vars[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const headers = {};
  for (const line of values.header ?? []) {
    const at = line.indexOf(':');
    if (at < 1) {
      log(USAGE);
      return 2;
    }
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const token = values.token ?? env.PERF_TOKEN;
  if (values.discover) {
    const discovered = await discoverVariables({ budget, baseUrl: values['base-url'], token, headers, vars, fetchImpl });
    vars = { ...vars, ...discovered.found };
    for (const [name, value] of Object.entries(discovered.found)) log(`found ${name} = ${value}`);
    for (const problem of discovered.problems) log(`not found ${problem}`);
  }
  if (values['vars-out'] !== undefined) writeFileSync(resolve(values['vars-out']), `${JSON.stringify(vars, null, 2)}
`);
  const results = await runBudget({ budget, baseUrl: values['base-url'], token, vars, headers, samples, warmup, stat: values.stat, only, fetchImpl, now, onResult: (result) => log(formatLine(result)) });
  const summary = summaryOf(results);
  const code = exitCode(results, values.strict);
  log(`${summary.total} operations: ${summary.pass} within budget, ${summary.fail} over budget or failed, ${summary.skipped} not measured`);
  if (values.out !== undefined) writeFileSync(resolve(values.out), `${JSON.stringify({ budget: budget.version, baseUrl: values['base-url'], summary, results }, null, 2)}\n`);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
