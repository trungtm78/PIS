import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PLAN_RELATIVE_PATH = join('Design', 'MACHVON_Design', '03_Engineering', 'implementation_plan.json');
const LEDGER_RELATIVE_PATH = join('Design', 'MACHVON_Design', '03_Engineering', 'legal_confirmation_ledger.json');
const STATUS_RELATIVE_PATH = join('docs', 'story-status.json');
const DEFAULT_LOCALE = 'vi';
const CONFIRMED = 'CONFIRMED';
const WAIVED = 'WAIVED';
/** The releases whose stories the legal confirmation window has to settle before it closes (ST-KERNEL-110). */
const WINDOW_RELEASES = new Set(['R1', 'R2']);
/** A story with one of these statuses says its work is complete; a CXN item it cites that no lawyer confirmed makes that claim untrue. */
const COMPLETE_STATUSES = new Set(['DONE', 'DONE_PENDING_ENV']);
const UNCONFIRMED_STATUS = 'DONE_UNCONFIRMED';

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * A ledger row counts as confirmed only when it says who confirmed it, when and on what evidence: a status that was edited without the
 * rest is not a confirmation (the ledger is the record the legal reviewer signs, ST-KERNEL-060).
 */
export function isConfirmed(row) {
  return row.status === CONFIRMED && filled(row.confirmed_by) && filled(row.confirmed_at) && filled(row.evidence);
}

/**
 * A waiver is the named owner of the item accepting the risk of going on without a confirmation: it counts only when the row says who waived it (and that is
 * the owner of the item), when, and why. A status that was edited without the rest is not a waiver.
 */
export function isWaived(row) {
  return row.status === WAIVED && filled(row.owner) && row.waived_by === row.owner && filled(row.waived_at) && filled(row.waiver_reason);
}

/** An item that no longer holds the legal confirmation window open: confirmed with its evidence, or waived by its owner. */
export function isSettled(row) {
  return isConfirmed(row) || isWaived(row);
}

/**
 * The legal gate report (ST-KERNEL-110): every item of the ledger with its owner, evidence and status, the R1 and R2 stories that rest on it, and the verdict
 * on the legal confirmation window. The window closes only when every item that gates an R1 or R2 story is confirmed or waived by its owner.
 */
export function legalGateReport({ plan, ledger }) {
  const gates = new Map(ledger.map((row) => [row.id, []]));
  for (const story of plan.stories) {
    if (!WINDOW_RELEASES.has(story.release)) continue;
    for (const id of new Set(story.cxn ?? [])) gates.get(id)?.push(story.id);
  }
  const items = ledger.map((row) => ({
    id: row.id,
    owner: row.owner ?? null,
    status: row.status,
    evidence: (isWaived(row) ? row.waiver_reason : row.evidence) ?? null,
    settled: isSettled(row),
    gates: gates.get(row.id),
  }));
  const open = items.filter((item) => item.gates.length > 0 && !item.settled).map((item) => item.id);
  return { items, open, windowClosed: open.length === 0 };
}

/**
 * Joins the stories of the implementation plan with the legal confirmation ledger and the status file and decides the gate (AC-ST-KERNEL-060-3):
 * a story that is DONE (or DONE_PENDING_ENV) while a CXN item it cites is not confirmed fails, listing the ids; DONE_UNCONFIRMED is the honest
 * status for it, and it is refused once every item it cites is confirmed (the label would be stale) or when it cites none.
 * Returns the failures and the figures the summary reports.
 */
export function checkCxn({ plan, ledger, statuses }) {
  const failures = [];
  const rows = new Map(ledger.map((row) => [row.id, row]));
  for (const row of ledger) if (row.status === CONFIRMED && !isConfirmed(row)) failures.push({ code: 'LEDGER_INCOMPLETE', id: row.id });
  for (const row of ledger) if (row.status === WAIVED && !isWaived(row)) failures.push({ code: 'WAIVER_INCOMPLETE', id: row.id });
  const unconfirmedStories = [];
  let unconfirmedIds = new Set();
  let complete = 0;
  for (const story of plan.stories) {
    const status = statuses[story.id];
    const cited = [...new Set(story.cxn ?? [])];
    for (const id of cited) if (!rows.has(id)) failures.push({ code: 'UNKNOWN_CXN', id, story: story.id });
    const open = cited.filter((id) => rows.has(id) && !isSettled(rows.get(id)));
    if (COMPLETE_STATUSES.has(status)) {
      complete += 1;
      if (open.length > 0) failures.push({ code: 'DONE_WITH_UNCONFIRMED', story: story.id, status, ids: open.join(', ') });
    } else if (status === UNCONFIRMED_STATUS) {
      unconfirmedStories.push(story.id);
      if (cited.length === 0) failures.push({ code: 'UNCONFIRMED_WITHOUT_CXN', story: story.id });
      else if (open.length === 0) failures.push({ code: 'STALE_UNCONFIRMED', story: story.id, ids: cited.join(', ') });
      else unconfirmedIds = new Set([...unconfirmedIds, ...open]);
    }
  }
  return {
    failures,
    summary: {
      ledger: ledger.length,
      confirmed: ledger.filter(isConfirmed).length,
      complete,
      awaiting: unconfirmedStories.length,
      awaitingIds: unconfirmedIds.size,
    },
  };
}

function describeFailure(failure, messages) {
  return format(messages[`cxn.${failure.code}`], { id: failure.id ?? '', story: failure.story ?? '', status: failure.status ?? '', ids: failure.ids ?? '' });
}

export function main(argv, { log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      plan: { type: 'string' },
      ledger: { type: 'string' },
      status: { type: 'string' },
      locale: { type: 'string', default: DEFAULT_LOCALE },
      report: { type: 'boolean', default: false },
    },
  });
  const messages = loadMessages(values.locale);
  const root = resolve(values.root);
  const paths = {
    plan: values.plan === undefined ? join(root, PLAN_RELATIVE_PATH) : resolve(values.plan),
    ledger: values.ledger === undefined ? join(root, LEDGER_RELATIVE_PATH) : resolve(values.ledger),
    status: values.status === undefined ? join(root, STATUS_RELATIVE_PATH) : resolve(values.status),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (name !== 'status' && !existsSync(path)) {
      log(format(messages['cxn.input.missing'], { path }));
      return 1;
    }
  }
  const plan = JSON.parse(readFileSync(paths.plan, 'utf8'));
  const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
  const statuses = existsSync(paths.status) ? (JSON.parse(readFileSync(paths.status, 'utf8')).stories ?? {}) : {};
  if (values.report) {
    const report = legalGateReport({ plan, ledger });
    for (const item of report.items) {
      log(format(messages['cxn.report.item'], { id: item.id, owner: item.owner ?? '-', status: item.status, evidence: item.evidence ?? '-', stories: item.gates.join(', ') || '-' }));
    }
    log(report.windowClosed ? messages['cxn.report.closed'] : format(messages['cxn.report.open'], { count: report.open.length, ids: report.open.join(', ') }));
    return report.windowClosed ? 0 : 1;
  }
  const { failures, summary } = checkCxn({ plan, ledger, statuses });
  for (const failure of failures) log(describeFailure(failure, messages));
  log(format(messages[failures.length === 0 ? 'cxn.summary.pass' : 'cxn.summary.fail'], { ...summary, count: failures.length }));
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
