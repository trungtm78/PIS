import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * The verification of the steps of the phone chapters of the user guide, without an emulator. A step of `mobile-chapters.json` says what the recorder does (taps, waits); this ledger says what
 * makes the step PASS or FAIL: a criterion (the text the screen must show: the `expect` of the step, or a pattern written here for the steps that have none) and the evidence that it was ever
 * seen on a device (a walk result of `scripts/uat-mobile-walk.mjs`, committed under `apps/mobile/qa/device/results`). A step with no passed visit is UNTESTED; with a reason that stops it, BLOCKED.
 * A new walk can be scored against the plan with `--walk <walk.json>`; `--require-verified` turns every step that is not verified into a failure (the gate before the guide is released).
 *
 *   node scripts/hdsd/verification.mjs [--check] [--list] [--walk <walk.json>] [--require-verified]
 *
 * Exit codes: 0 consistent (and, with --require-verified, every step verified); 1 the ledger is inconsistent, a step FAILED, or --require-verified and a step is not verified; 2 wrong usage.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
export const CHAPTERS_PATH = join(SCRIPT_DIR, 'mobile-chapters.json');
export const LEDGER_PATH = join(SCRIPT_DIR, 'verification.json');
const CATALOGUE_PATH = join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Every step of every chapter, with its chapter. */
export const stepsOf = (chapters) => chapters.flatMap((chapter) => chapter.steps.map((step) => ({ chapter: chapter.id, step })));

/** What the screen of a step must show: the expectation of the step, else the pattern of the ledger. */
export function criterionOf(step, ledger) {
  if (typeof step.expect === 'string' && step.expect !== '') return { pattern: step.expect, source: 'expect', confirmedBy: undefined };
  const own = ledger.criteria?.[step.id];
  if (typeof own?.pattern === 'string' && own.pattern !== '') return { pattern: own.pattern, source: 'ledger', confirmedBy: own.confirmedBy };
  return undefined;
}

/** The visits of the walk results the ledger names (plus extra ones): `{ evidence, screen, status, heading }`. A missing or unreadable file is reported, not ignored. */
export function loadVisits(ledger, extra = [], root = REPO_ROOT) {
  const visits = [];
  const problems = [];
  const sources = [...(ledger.evidence ?? []).map((entry) => ({ id: entry.id, path: join(root, entry.path) })), ...extra];
  for (const source of sources) {
    if (!existsSync(source.path)) {
      problems.push(`evidence ${source.id}: ${source.path} does not exist`);
      continue;
    }
    let walk;
    try {
      walk = readJson(source.path);
    } catch {
      problems.push(`evidence ${source.id}: not valid JSON`);
      continue;
    }
    if (!Array.isArray(walk.visits)) {
      problems.push(`evidence ${source.id}: no visits`);
      continue;
    }
    for (const visit of walk.visits) if (typeof visit?.id === 'string') visits.push({ evidence: source.id, screen: visit.id, status: visit.status, heading: typeof visit.heading === 'string' ? visit.heading : '' });
  }
  return { visits, problems };
}

const compile = (pattern) => {
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    return undefined;
  }
};

/**
 * The state of one step: VERIFIED (a passed visit of its screen, and where the criterion was written from a walk, the heading still matches), FAILED (the screen was visited and did not pass or its heading
 * is not the one expected), BLOCKED (never seen, with a reason on record) or UNTESTED.
 */
export function statusOf(chapterId, step, ledger, visits) {
  const screen = step.screens[0];
  const seen = visits.filter((visit) => visit.screen === screen);
  const criterion = criterionOf(step, ledger);
  const passed = seen.filter((visit) => visit.status === 'passed');
  if (passed.length > 0) {
    const wrote = criterion?.source === 'ledger' && criterion.confirmedBy !== undefined;
    if (wrote) {
      const pattern = compile(criterion.pattern);
      const confirming = passed.find((visit) => visit.evidence === criterion.confirmedBy);
      if (pattern === undefined || confirming === undefined || !pattern.test(confirming.heading)) return { status: 'FAILED', reason: `the heading of the passed visit does not match ${criterion.pattern}` };
    }
    return { status: 'VERIFIED', reason: '', evidence: passed[0].evidence };
  }
  if (seen.length > 0) return { status: 'FAILED', reason: `visited with status ${seen[0].status}` };
  const blocker = ledger.blockers?.[step.id] ?? ledger.blockers?.[chapterId];
  if (blocker !== undefined) return { status: 'BLOCKED', reason: blocker };
  return { status: 'UNTESTED', reason: 'no passed visit of the screen in any evidence' };
}

/** Problems of the ledger against the chapters: what would make the pass or fail of a step mean nothing. */
export function ledgerProblems(chapters, ledger, catalogueIds, evidenceProblems = []) {
  const problems = [...evidenceProblems];
  const steps = stepsOf(chapters);
  const stepIds = new Set(steps.map((entry) => entry.step.id));
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));
  for (const { chapter, step } of steps) {
    const criterion = criterionOf(step, ledger);
    if (criterion === undefined) problems.push(`${step.id} (${chapter}): no pass criterion; give the step an expect or add it to criteria of the ledger`);
    else if (compile(criterion.pattern) === undefined) problems.push(`${step.id} (${chapter}): the criterion ${criterion.pattern} is not a valid pattern`);
    if (!catalogueIds.has(step.screens[0])) problems.push(`${step.id}: ${step.screens[0]} is not in the catalogue`);
  }
  for (const [id, entry] of Object.entries(ledger.criteria ?? {})) {
    if (!stepIds.has(id)) problems.push(`criteria ${id}: there is no such step`);
    else if (steps.find((candidate) => candidate.step.id === id)?.step.expect) problems.push(`criteria ${id}: the step has an expect already; the ledger does not override it`);
    if (typeof entry?.pattern !== 'string' || entry.pattern === '') problems.push(`criteria ${id}: no pattern`);
    if (entry?.confirmedBy !== undefined && !(ledger.evidence ?? []).some((candidate) => candidate.id === entry.confirmedBy)) problems.push(`criteria ${id}: confirmedBy ${entry.confirmedBy} is not an evidence of the ledger`);
  }
  for (const [id, reason] of Object.entries(ledger.blockers ?? {})) {
    if (!stepIds.has(id) && !chapterIds.has(id)) problems.push(`blockers ${id}: there is no such step or chapter`);
    if (typeof reason !== 'string' || reason.trim() === '') problems.push(`blockers ${id}: no reason`);
  }
  const evidenceIds = (ledger.evidence ?? []).map((entry) => entry.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) problems.push('evidence: an id is used twice');
  for (const chapter of chapters) {
    if (!Array.isArray(chapter.needs) && chapter.steps.some((step) => step.ops.some((op) => op.run !== undefined))) problems.push(`${chapter.id}: a step runs a command of the data maker but the chapter lists no needs`);
  }
  return problems;
}

/** The report of a run: the state of every step, in the order of the chapters, and the count of each state. */
export function reportOf(chapters, ledger, visits) {
  const rows = stepsOf(chapters).map(({ chapter, step }) => ({ chapter, step: step.id, screen: step.screens[0], ...statusOf(chapter, step, ledger, visits) }));
  const count = (status) => rows.filter((row) => row.status === status).length;
  return { rows, totals: { steps: rows.length, verified: count('VERIFIED'), failed: count('FAILED'), blocked: count('BLOCKED'), untested: count('UNTESTED') } };
}

export function exitCodeOf(problems, report, requireVerified) {
  if (problems.length > 0 || report.totals.failed > 0) return 1;
  if (requireVerified && report.totals.verified !== report.totals.steps) return 1;
  return 0;
}

const USAGE = 'usage: node scripts/hdsd/verification.mjs [--check] [--list] [--walk <walk.json>] [--require-verified]';

export function main(argv, { log = console.log, chaptersPath = CHAPTERS_PATH, ledgerPath = LEDGER_PATH, root = REPO_ROOT } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { check: { type: 'boolean', default: false }, list: { type: 'boolean', default: false }, walk: { type: 'string', multiple: true }, 'require-verified': { type: 'boolean', default: false } } }));
  } catch {
    log(USAGE);
    return 2;
  }
  const chapters = readJson(chaptersPath);
  const ledger = readJson(ledgerPath);
  const catalogue = existsSync(CATALOGUE_PATH) ? readJson(CATALOGUE_PATH) : [];
  const extra = (values.walk ?? []).map((path, index) => ({ id: `walk-${index + 1}`, path: resolve(path) }));
  const { visits, problems: evidenceProblems } = loadVisits(ledger, extra, root);
  const problems = ledgerProblems(chapters, ledger, new Set(catalogue.map((screen) => screen.id)), evidenceProblems);
  const report = reportOf(chapters, ledger, visits);
  if (values.list) for (const row of report.rows) log(`${row.status.padEnd(9)}${row.chapter.padEnd(40)}${row.step.padEnd(9)}${row.reason}`);
  for (const problem of problems) log(`problem: ${problem}`);
  const { totals } = report;
  log(`${totals.steps} steps: ${totals.verified} verified, ${totals.failed} failed, ${totals.blocked} blocked, ${totals.untested} untested`);
  if (values['require-verified'] && totals.verified !== totals.steps) for (const row of report.rows.filter((entry) => entry.status !== 'VERIFIED')) log(`not verified: ${row.step} (${row.status}) ${row.reason}`);
  return exitCodeOf(problems, report, values['require-verified']);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
