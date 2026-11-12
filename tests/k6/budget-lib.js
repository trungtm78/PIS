import http from 'k6/http';
import { check } from 'k6';

// The table of docs/qa/perf-budget.json read by the k6 scripts of this folder (the same table that drives scripts/perf-budget.mjs).
// Settings come from the environment: BASE_URL (with the version prefix), TOKEN (a bearer token), VARS (a JSON object with the
// variables of the table), ONLY (a list of ids, areas or classes, for example "REPORT,HOME").
export const budget = JSON.parse(open('../../docs/qa/perf-budget.json'));
const baseUrl = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const token = __ENV.TOKEN || '';
const vars = JSON.parse(__ENV.VARS || '{}');
const only = (__ENV.ONLY || '')
  .split(',')
  .map((item) => item.trim().toUpperCase())
  .filter((item) => item !== '');

const reference = /^\$([A-Za-z][A-Za-z0-9]*)$/;

/** The URL of an operation of the table, or null when a variable it needs is not given (the operation is then left out of the run). */
export function urlOf(entry) {
  let complete = true;
  const value = (name) => {
    if (vars[name] === undefined || vars[name] === '') complete = false;
    return String(vars[name]);
  };
  const path = entry.path.replace(/\{(\w+)\}/g, (_match, name) => {
    const fixed = entry.pathFixed ? entry.pathFixed[name] : undefined;
    return encodeURIComponent(fixed !== undefined ? fixed : value(entry.pathVars[name]));
  });
  const pairs = Object.keys(entry.query || {}).map((name) => {
    const found = reference.exec(String(entry.query[name]));
    return `${encodeURIComponent(name)}=${encodeURIComponent(found === null ? String(entry.query[name]) : value(found[1]))}`;
  });
  return complete ? `${baseUrl}${path}${pairs.length === 0 ? '' : `?${pairs.join('&')}`}` : null;
}

/** The operations this run covers: selected by ONLY, and with every variable given. */
export const operations = budget.operations
  .filter((entry) => only.length === 0 || [entry.id, entry.operationId, entry.area, entry.class].some((key) => key !== undefined && only.indexOf(String(key).toUpperCase()) >= 0))
  .map((entry) => ({ entry, url: urlOf(entry) }))
  .filter((item) => item.url !== null);

/** The budget of an operation: its own `budgetMs` when it has one (tighter than its class), else the budget of its class. */
export const limitOf = (entry) => (entry.budgetMs !== undefined ? entry.budgetMs : budget.classes[entry.class].budgetMs);

/** One request of an operation, tagged so that the thresholds can single it out; the body is received to the end. */
export function hit(item) {
  const params = { headers: { Authorization: `Bearer ${token}` }, tags: { op: item.entry.id, cls: item.entry.class }, timeout: `${limitOf(item.entry) * 2}ms` };
  const response = http.get(item.url, params);
  check(response, { 'status is 2xx or 3xx': (answer) => answer.status >= 200 && answer.status < 400 });
}

/** The thresholds of the budget: p95 of every operation under its own budget (that of its class unless the row tightens it), and almost no failed request. */
export function thresholdsOf(items) {
  const thresholds = { http_req_failed: ['rate<0.01'] };
  Object.keys(budget.classes).forEach((name) => {
    thresholds[`http_req_duration{cls:${name}}`] = [`p(95)<${budget.classes[name].budgetMs}`];
  });
  items.forEach((item) => {
    thresholds[`http_req_duration{op:${item.entry.id}}`] = [`p(95)<${limitOf(item.entry)}`];
  });
  return thresholds;
}
