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
 * Joins the stories of the implementation plan with the legal confirmation ledger and the status file and decides the gate (AC-ST-KERNEL-060-3):
 * a story that is DONE (or DONE_PENDING_ENV) while a CXN item it cites is not confirmed fails, listing the ids; DONE_UNCONFIRMED is the honest
 * status for it, and it is refused once every item it cites is confirmed (the label would be stale) or when it cites none.
 * Returns the failures and the figures the summary reports.
 */
export function checkCxn({ plan, ledger, statuses }) {
  const failures = [];
  const rows = new Map(ledger.map((row) => [row.id, row]));
  for (const row of ledger) if (row.status === CONFIRMED && !isConfirmed(row)) failures.push({ code: 'LEDGER_INCOMPLETE', id: row.id });
  const unconfirmedStories = [];
  let unconfirmedIds = new Set();
  let complete = 0;
  for (const story of plan.stories) {
    const status = statuses[story.id];
    const cited = [...new Set(story.cxn ?? [])];
    for (const id of cited) if (!rows.has(id)) failures.push({ code: 'UNKNOWN_CXN', id, story: story.id });
    const open = cited.filter((id) => rows.has(id) && !isConfirmed(rows.get(id)));
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
  const { failures, summary } = checkCxn({ plan, ledger, statuses });
  for (const failure of failures) log(describeFailure(failure, messages));
  log(format(messages[failures.length === 0 ? 'cxn.summary.pass' : 'cxn.summary.fail'], { ...summary, count: failures.length }));
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
