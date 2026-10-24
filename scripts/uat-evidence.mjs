import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const ENGINEERING = join('Design', 'MACHVON_Design', '03_Engineering');
const SCREENS_PATH = join(ENGINEERING, 'screen_catalog.json');
const TRACEABILITY_PATH = join(ENGINEERING, 'traceability.json');
const TESTS_PATH = join(ENGINEERING, 'test_cases.json');
const RESULTS_PATH = join('docs', 'uat-run-results.json');
const CRITICAL_PATH = join('docs', 'uat-critical.json');
const OUT_PATH = join('docs', 'UAT-EVIDENCE.md');
const DEFAULT_LOCALE = 'vi';
// The generated document is part of the repository documentation, which is English.
const DOCUMENT_LOCALE = 'en';

/** The result a run store may record for a test; anything else is an invalid record and never a pass. */
const RECORDED = new Set(['PASS', 'FAIL', 'SKIPPED', 'NOT_RUN']);
/** What a PASS must carry to be evidence and not an assertion (docs/runbooks/uat-evidence.md). */
const EVIDENCE_FIELDS = ['at', 'build', 'schema_version', 'dataset_sha256'];
/** The state of a test or of a row, from the best to the worst; only PASS and WAIVED count as complete. */
export const STATES = ['PASS', 'WAIVED', 'UNPROVEN', 'NOT_RUN', 'SKIPPED', 'FAIL', 'GAP'];
const COMPLETE = new Set(['PASS', 'WAIVED']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const worse = (left, right) => (STATES.indexOf(left) >= STATES.indexOf(right) ? left : right);

/**
 * The state of one test in the run store. NOT_RUN is what a test has when the store does not name it; a PASS that does not carry its evidence (when it ran, the build, the
 * schema version, the hash of the dataset, and the ids of the requests that were made) is UNPROVEN: it was claimed, not shown. FAIL, SKIPPED and NOT_RUN never count as PASS.
 */
export function stateOfTest(record) {
  if (record === undefined || record === null) return { state: 'NOT_RUN' };
  if (!RECORDED.has(record.result)) return { state: 'FAIL', invalid: true };
  if (record.result !== 'PASS') return { state: record.result, at: record.at, evidence: record.evidence };
  const proven = EVIDENCE_FIELDS.every((field) => filled(record[field])) && Array.isArray(record.request_ids) && record.request_ids.length > 0 && filled(record.evidence);
  return { state: proven ? 'PASS' : 'UNPROVEN', at: record.at, evidence: record.evidence };
}

/** Whether a waiver may excuse a result today: approved by someone, with an owner, a reason and a day that has not passed. */
export function waiverStanding(waiver, today) {
  if (![waiver.owner, waiver.reason, waiver.approved_by].every(filled)) return 'INCOMPLETE';
  if (!filled(waiver.expires) || !ISO_DAY.test(waiver.expires)) return 'INCOMPLETE';
  return waiver.expires >= today ? 'VALID' : 'EXPIRED';
}

/**
 * Joins the screens and the requirements of the design with the tests that prove them and the run store, and decides each row. A screen or a requirement with no known test
 * is a GAP; a row is the worst state of its tests, and WAIVED only when every test that is not PASS has a valid waiver (by test id, by the screen or by the requirement).
 * Critical tests are the ones that cover a requirement named in the critical list (money, isolation, restore): the section reports how many of them PASS, and a waiver never
 * counts as a pass there.
 */
export function buildCoverage({ screens, traceability, tests, results, waivers = [], critical = {}, today }) {
  const known = new Map(tests.map((test) => [test.id, test]));
  const states = new Map();
  for (const test of tests) states.set(test.id, stateOfTest(results[test.id]));
  const waiverFor = (testId, row) => waivers.find((waiver) => [testId, row.screen, row.requirement].includes(waiver.target) && waiverStanding(waiver, today) === 'VALID');

  const rows = traceability.map((entry) => {
    const ids = (entry.test_ids ?? []).filter((id) => known.has(id));
    const unknown = (entry.test_ids ?? []).filter((id) => !known.has(id));
    if (ids.length === 0) return { screen: entry.screen, requirement: entry.requirement, tests: [], unknown, state: 'GAP' };
    const perTest = ids.map((id) => ({ id, ...states.get(id) }));
    const open = perTest.filter((test) => test.state !== 'PASS');
    const unwaived = open.filter((test) => waiverFor(test.id, entry) === undefined);
    let state = 'PASS';
    for (const test of perTest) state = worse(state, test.state);
    if (open.length > 0 && unwaived.length === 0) state = 'WAIVED';
    return { screen: entry.screen, requirement: entry.requirement, tests: perTest, unknown, state };
  });

  const screenRow = new Map();
  for (const row of rows) screenRow.set(row.screen, screenRow.has(row.screen) ? worse(screenRow.get(row.screen), row.state) : row.state);
  const screenRows = screens.map((screen) => ({ id: screen.id, title: screen.title, module: screen.module, state: screenRow.get(screen.id) ?? 'GAP' }));

  const criticalNfr = (test) => {
    const covers = String(test.covers ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return Object.entries(critical).flatMap(([area, prefixes]) => (covers.some((id) => prefixes.some((prefix) => id.startsWith(prefix))) ? [area] : []));
  };
  const criticalRows = tests.flatMap((test) => {
    const areas = criticalNfr(test);
    return areas.length === 0 ? [] : [{ id: test.id, areas, ...states.get(test.id) }];
  });

  const standing = waivers.map((waiver) => ({ ...waiver, standing: waiverStanding(waiver, today) }));
  const count = (list, state) => list.filter((row) => row.state === state).length;
  const complete = (list) => list.filter((row) => COMPLETE.has(row.state)).length;
  const summary = {
    screens: screenRows.length,
    screensComplete: complete(screenRows),
    requirements: new Set(rows.map((row) => row.requirement)).size,
    rows: rows.length,
    rowsComplete: complete(rows),
    byState: Object.fromEntries(STATES.map((state) => [state, count(rows, state)])),
    gaps: screenRows.filter((row) => row.state === 'GAP').length,
    critical: criticalRows.length,
    criticalPass: criticalRows.filter((row) => row.state === 'PASS').length,
    waivers: standing.length,
    waiversExpired: standing.filter((waiver) => waiver.standing !== 'VALID').length,
  };
  const failures = [];
  for (const row of screenRows) if (!COMPLETE.has(row.state)) failures.push({ code: 'SCREEN_NOT_COMPLETE', id: row.id, state: row.state });
  for (const row of rows) if (!COMPLETE.has(row.state)) failures.push({ code: 'REQUIREMENT_NOT_COMPLETE', id: row.requirement, state: row.state });
  for (const waiver of standing) if (waiver.standing !== 'VALID') failures.push({ code: 'WAIVER_NOT_VALID', id: waiver.target ?? '?', state: waiver.standing });
  return { rows, screenRows, criticalRows, waivers: standing, summary, failures };
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const percent = (part, total) => (total === 0 ? '0.0' : ((part * 100) / total).toFixed(1));

export function renderCoverage(coverage, meta, messages = loadMessages(DOCUMENT_LOCALE)) {
  const { summary } = coverage;
  const stateCounts = STATES.map((state) => `${state} ${summary.byState[state]}`).join(', ');
  const lines = [
    `# ${messages['uatev.doc.title']}`,
    '',
    messages['uatev.doc.generated'],
    '',
    format(messages['uatev.doc.run'], { run: meta.runId ?? '-', build: meta.build ?? '-', schema: meta.schemaVersion ?? '-', dataset: meta.datasetSha256 ?? '-' }),
    format(messages['uatev.doc.screens'], { complete: summary.screensComplete, total: summary.screens, percent: percent(summary.screensComplete, summary.screens), gaps: summary.gaps }),
    format(messages['uatev.doc.rows'], { complete: summary.rowsComplete, total: summary.rows, requirements: summary.requirements, states: stateCounts }),
    messages['uatev.doc.rule'],
    '',
    `## ${messages['uatev.doc.criticalHeading']}`,
    '',
    format(messages['uatev.doc.critical'], { pass: summary.criticalPass, total: summary.critical, percent: percent(summary.criticalPass, summary.critical) }),
    '',
    '| test | area | state |',
    '| --- | --- | --- |',
    ...coverage.criticalRows.map((row) => `| ${row.id} | ${row.areas.join(', ')} | ${row.state} |`),
    '',
    `## ${messages['uatev.doc.waiversHeading']}`,
    '',
    coverage.waivers.length === 0 ? messages['uatev.doc.noWaivers'] : '| target | owner | reason | approved by | expires | standing |',
    ...(coverage.waivers.length === 0 ? [] : ['| --- | --- | --- | --- | --- | --- |', ...coverage.waivers.map((waiver) => `| ${cell(waiver.target)} | ${cell(waiver.owner)} | ${cell(waiver.reason)} | ${cell(waiver.approved_by)} | ${cell(waiver.expires)} | ${waiver.standing} |`)]),
    '',
    `## ${messages['uatev.doc.gapsHeading']}`,
    '',
    ...(summary.gaps === 0 ? [messages['uatev.doc.noGaps']] : coverage.screenRows.filter((row) => row.state === 'GAP').map((row) => `- ${row.id} ${cell(row.title)}`)),
    '',
    `## ${messages['uatev.doc.screensHeading']}`,
    '',
    '| screen | module | state |',
    '| --- | --- | --- |',
    ...coverage.screenRows.map((row) => `| ${row.id} | ${row.module} | ${row.state} |`),
    '',
    `## ${messages['uatev.doc.requirementsHeading']}`,
    '',
    '| requirement | screen | tests | state |',
    '| --- | --- | --- | --- |',
    ...coverage.rows.map((row) => `| ${row.requirement} | ${row.screen} | ${row.tests.length === 0 ? '-' : row.tests.map((test) => `${test.id} ${test.state}`).join('<br>')} | ${row.state} |`),
  ];
  return `${lines.join('\n')}\n`;
}

function describeFailure(failure, messages) {
  return format(messages[`uatev.${failure.code}`], { id: failure.id, state: failure.state });
}

export function main(argv, { log = console.log, today = new Date().toISOString().slice(0, 10) } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      out: { type: 'string' },
      check: { type: 'boolean', default: false },
      gate: { type: 'boolean', default: false },
      locale: { type: 'string', default: DEFAULT_LOCALE },
    },
  });
  const messages = loadMessages(values.locale);
  const root = resolve(values.root);
  const outPath = values.out === undefined ? join(root, OUT_PATH) : resolve(values.out);
  for (const path of [SCREENS_PATH, TRACEABILITY_PATH, TESTS_PATH]) {
    if (!existsSync(join(root, path))) {
      log(format(messages['uatev.input.missing'], { path: join(root, path) }));
      return 1;
    }
  }
  const store = readJson(join(root, RESULTS_PATH), {});
  const coverage = buildCoverage({
    screens: readJson(join(root, SCREENS_PATH), []),
    traceability: readJson(join(root, TRACEABILITY_PATH), []),
    tests: readJson(join(root, TESTS_PATH), []),
    results: store.results ?? {},
    waivers: store.waivers ?? [],
    critical: readJson(join(root, CRITICAL_PATH), { areas: {} }).areas,
    today,
  });
  const document = renderCoverage(coverage, store);
  const problems = [];
  if (values.check) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined;
    if (current !== document) problems.push(format(messages['uatev.stale'], { path: relative(root, outPath).split(sep).join('/') }));
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, document);
  }
  const { summary } = coverage;
  const gated = values.gate ? coverage.failures.map((failure) => describeFailure(failure, messages)) : [];
  for (const line of [...problems, ...gated]) log(line);
  log(
    format(messages[problems.length + gated.length === 0 ? 'uatev.summary.pass' : 'uatev.summary.fail'], {
      screensComplete: summary.screensComplete,
      screens: summary.screens,
      rowsComplete: summary.rowsComplete,
      rows: summary.rows,
      gaps: summary.gaps,
      criticalPass: summary.criticalPass,
      critical: summary.critical,
      count: problems.length + gated.length,
    }),
  );
  return problems.length + gated.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
