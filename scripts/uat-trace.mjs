import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PLAN_RELATIVE_PATH = join('Design', 'MACHVON_Design', '03_Engineering', 'implementation_plan.json');
const STATUS_RELATIVE_PATH = join('docs', 'story-status.json');
const OUT_RELATIVE_PATH = join('docs', 'UAT-COVERAGE.md');
const DEFAULT_LOCALE = 'vi';
// The generated document is part of the repository documentation, which is English.
const DOCUMENT_LOCALE = 'en';
const DEFAULT_RELEASES = ['R0', 'R1'];
const SEARCHED_ROOTS = ['apps', 'packages', 'scripts', 'ci'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git', 'test-results', '__diff__', '.test-locks']);
const TEST_FILE = /\.(?:test|spec|contract)\.(?:[cm]?[jt]sx?)$|_test\.dart$/;
const TEST_DIRECTORY = new Set(['test', 'tests', 'e2e', '__tests__']);
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const ACCEPTANCE_ID = /\bAC-ST-[A-Z0-9]+-\d+-\d+\b/g;
const STATUS_VOCABULARY = new Set(['DONE', 'DONE_PENDING_ENV', 'DONE_UNCONFIRMED', 'PARTIAL', 'NOT STARTED']);
// A story with one of these statuses claims that its in-repo acceptance criteria all have a live test. DONE_PENDING_ENV may
// name the ids that only an external system can prove (`externalChecks` of docs/story-status.json); the others may not.
const GATED_STATUSES = new Set(['DONE', 'DONE_PENDING_ENV', 'DONE_UNCONFIRMED']);
// DONE_UNCONFIRMED may declare them as well: a story can both rest on a legal item nobody confirmed and wait for an external system, and the status is one word.
const EXTERNAL_STATUSES = new Set(['DONE_PENDING_ENV', 'DONE_UNCONFIRMED']);
const SKIP_MODIFIERS = new Set(['skip', 'todo', 'fixme', 'skipIf']);
// A title is the first literal argument of one of these calls (Jest, Vitest, node:test, Playwright, Dart test).
const TEST_CALL = /(?<![.\w$])(x?(?:it|test|describe)|specify|group)((?:\.[A-Za-z]+)*)\s*(?:<[^()]*?>)?\s*\(/g;
const REGEX_CAN_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading test titles. The source is first reduced to two masks of the same length: `text` (comments blanked, strings
// kept, to read titles from) and `code` (comments and the inside of strings, templates and regular expressions blanked,
// to find calls in). So a title that sits in a comment or in a fixture string is never a test.
// ---------------------------------------------------------------------------------------------------------------------

function blank(chars, from, to) {
  for (let index = from; index < to; index += 1) if (chars[index] !== '\n') chars[index] = ' ';
}

function skipQuoted(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote && source[index] !== '\n') index += source[index] === '\\' ? 2 : 1;
  return Math.min(index + 1, source.length);
}

function skipRegex(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length && source[index] !== '\n') {
    const char = source[index];
    if (char === '\\') index += 1;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return index + 1;
    index += 1;
  }
  return Math.min(index, source.length);
}

function skipTemplate(source, masks, start) {
  let index = start + 1;
  while (index < source.length && source[index] !== '`') {
    if (source[index] === '\\') {
      blank(masks.code, index, index + 2);
      index += 2;
    } else if (source[index] === '$' && source[index + 1] === '{') index = scanCode(source, masks, index + 2, true) + 1;
    else {
      blank(masks.code, index, index + 1);
      index += 1;
    }
  }
  return Math.min(index + 1, source.length);
}

function scanCode(source, masks, start, untilBrace) {
  let index = start;
  let depth = 0;
  let last = '';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      let end = index;
      while (end < source.length && source[end] !== '\n') end += 1;
      blank(masks.text, index, end);
      blank(masks.code, index, end);
      index = end;
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close < 0 ? source.length : close + 2;
      blank(masks.text, index, end);
      blank(masks.code, index, end);
      index = end;
    } else if (char === '"' || char === "'") {
      const end = skipQuoted(source, index);
      blank(masks.code, index + 1, end - 1);
      index = end;
      last = char;
    } else if (char === '`') {
      index = skipTemplate(source, masks, index);
      last = char;
    } else if (char === '/' && next !== '>' && REGEX_CAN_FOLLOW.has(last)) {
      // `/>` closes a self-closing JSX tag after an attribute in braces; it never opens a regular expression.
      const end = skipRegex(source, index);
      blank(masks.code, index + 1, end - 1);
      index = end;
      last = '/';
    } else {
      if (untilBrace && char === '{') depth += 1;
      else if (untilBrace && char === '}') {
        if (depth === 0) return index;
        depth -= 1;
      }
      if (!/\s/.test(char)) last = char;
      index += 1;
    }
  }
  return index;
}

function maskSource(source) {
  const masks = { text: source.split(''), code: source.split('') };
  scanCode(source, masks, 0, false);
  return { text: masks.text.join(''), code: masks.code.join('') };
}

function matchingParen(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1;
    else if (code[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function nextNonSpace(text, from) {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

// The string literal that starts at `from` (after blanks), with `+` concatenation; undefined when there is none.
function readTitle(text, from) {
  let index = nextNonSpace(text, from);
  let title = '';
  let found = false;
  while (text[index] === "'" || text[index] === '"' || text[index] === '`') {
    const quote = text[index];
    let cursor = index + 1;
    let value = '';
    while (cursor < text.length && text[cursor] !== quote) {
      if (text[cursor] === '\\') {
        value += text[cursor + 1] ?? '';
        cursor += 2;
      } else {
        value += text[cursor];
        cursor += 1;
      }
    }
    title += value;
    found = true;
    index = nextNonSpace(text, cursor + 1);
    if (text[index] !== '+') break;
    index = nextNonSpace(text, index + 1);
  }
  return found ? title : undefined;
}

/**
 * The tests of one source file: `{title, skipped}` for every it/test/describe call whose first argument is a string
 * literal (the table of an `.each` call comes first, the title after it). A call is skipped when it is `xit`/`xdescribe`,
 * has a `skip`, `todo`, `fixme` or `skipIf` modifier, or sits inside a skipped describe.
 */
export function extractTests(source) {
  const { text, code } = maskSource(source);
  const found = [];
  const skippedRanges = [];
  for (const match of code.matchAll(TEST_CALL)) {
    const [, callee, modifierText] = match;
    const modifiers = modifierText.split('.').filter(Boolean);
    let open = match.index + match[0].length - 1;
    if (modifiers.includes('each') || modifiers.includes('skipIf')) {
      const close = matchingParen(code, open);
      const after = close < 0 ? -1 : nextNonSpace(code, close + 1);
      if (after < 0 || code[after] !== '(') continue;
      open = after;
    }
    const title = readTitle(text, open + 1);
    if (title === undefined) continue;
    const skipped = callee.startsWith('x') || modifiers.some((modifier) => SKIP_MODIFIERS.has(modifier)) || skippedRanges.some(([from, to]) => open > from && open < to);
    const isGroup = /describe$|group$|^specify$/.test(callee) || modifiers.includes('describe');
    if (skipped && isGroup) skippedRanges.push([open, matchingParen(code, open)]);
    found.push({ title, skipped });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// Collecting the tests of a repository
// ---------------------------------------------------------------------------------------------------------------------

function* testFiles(directory, inTestDirectory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* testFiles(path, inTestDirectory || TEST_DIRECTORY.has(entry.name));
    else if (TEST_FILE.test(entry.name) || (inTestDirectory && SCRIPT_FILE.test(entry.name))) yield path;
  }
}

function collectTests(root) {
  const tests = [];
  for (const top of SEARCHED_ROOTS) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const file of testFiles(base, false)) {
      const path = relative(root, file).split(sep).join('/');
      for (const entry of extractTests(readFileSync(file, 'utf8'))) tests.push({ file: path, title: entry.title, skipped: entry.skipped });
    }
  }
  return tests;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------------------------------------------------

function loadStatusFile(statusPath) {
  if (!existsSync(statusPath)) return { statuses: {}, externalChecks: {} };
  const file = JSON.parse(readFileSync(statusPath, 'utf8'));
  return { statuses: file.stories ?? {}, externalChecks: file.externalChecks ?? {} };
}

const byFileThenTitle = (a, b) => (a.file === b.file ? (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) : a.file < b.file ? -1 : 1);

/**
 * Reads the acceptance ids of the stories of `releases` from the implementation plan, finds them in test titles and
 * decides the gate: every acceptance id of a story whose status is DONE, DONE_PENDING_ENV or DONE_UNCONFIRMED
 * (`docs/story-status.json`) must be named by a live test, except the ids that a DONE_PENDING_ENV or DONE_UNCONFIRMED story declares in
 * `externalChecks` (what only an external system can prove). Returns the rows (one per id, in plan order), the stories, the summary and the failures.
 */
export function traceCoverage({ root, planPath = join(root, PLAN_RELATIVE_PATH), statusPath = join(root, STATUS_RELATIVE_PATH), releases = DEFAULT_RELEASES }) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const { statuses, externalChecks } = loadStatusFile(statusPath);
  // A declaration excuses an id only when it says what the external system has to prove.
  const isExternal = (id, status) => EXTERNAL_STATUSES.has(status) && typeof externalChecks[id] === 'string' && externalChecks[id].trim() !== '';
  const failures = [];
  const planIds = new Map();
  for (const story of plan.stories) for (const criterion of story.acceptance) planIds.set(criterion.id, (planIds.get(criterion.id) ?? 0) + 1);
  const storyIds = new Set(plan.stories.map((story) => story.id));

  const testsById = new Map();
  for (const test of collectTests(root)) {
    for (const id of new Set(test.title.match(ACCEPTANCE_ID) ?? [])) {
      if (!planIds.has(id)) failures.push({ code: 'UNKNOWN_ID', id, where: `${test.file}: ${test.title}` });
      testsById.set(id, [...(testsById.get(id) ?? []), test]);
    }
  }

  const rows = [];
  const stories = [];
  for (const story of plan.stories.filter((entry) => releases.includes(entry.release))) {
    const status = statuses[story.id];
    const storyRows = story.acceptance.map((criterion) => {
      const tests = (testsById.get(criterion.id) ?? []).slice().sort(byFileThenTitle);
      const result = tests.some((test) => !test.skipped) ? 'COVERED' : tests.length > 0 ? 'SKIPPED' : 'MISSING';
      if (planIds.get(criterion.id) > 1) failures.push({ code: 'DUPLICATE_PLAN_ID', id: criterion.id, story: story.id });
      if (GATED_STATUSES.has(status) && result !== 'COVERED' && !isExternal(criterion.id, status)) failures.push({ code: `UNCOVERED_${result}`, id: criterion.id, story: story.id, status });
      return { id: criterion.id, story: story.id, tests, result };
    });
    rows.push(...storyRows);
    stories.push({
      id: story.id,
      status,
      total: storyRows.length,
      covered: storyRows.filter((row) => row.result === 'COVERED').length,
      external: storyRows.filter((row) => row.result !== 'COVERED' && isExternal(row.id, status)).length,
    });
  }

  for (const [id, status] of Object.entries(statuses)) {
    if (!storyIds.has(id)) failures.push({ code: 'STATUS_UNKNOWN_STORY', id });
    else if (!STATUS_VOCABULARY.has(status)) failures.push({ code: 'STATUS_INVALID', id, status });
  }

  const storyOfId = new Map(rows.map((row) => [row.id, row]));
  for (const [id, check] of Object.entries(externalChecks)) {
    const row = storyOfId.get(id);
    if (!planIds.has(id)) failures.push({ code: 'EXTERNAL_UNKNOWN', id });
    else if (row === undefined) continue;
    else if (!EXTERNAL_STATUSES.has(statuses[row.story])) failures.push({ code: 'EXTERNAL_MISPLACED', id, story: row.story, status: statuses[row.story] ?? '-' });
    else if (row.result === 'COVERED') failures.push({ code: 'EXTERNAL_COVERED', id, story: row.story });
    if (typeof check !== 'string' || check.trim() === '') failures.push({ code: 'EXTERNAL_NO_CHECK', id });
  }

  const gated = stories.filter((story) => GATED_STATUSES.has(story.status));
  const summary = {
    releases,
    stories: stories.length,
    total: rows.length,
    covered: rows.filter((row) => row.result === 'COVERED').length,
    skipped: rows.filter((row) => row.result === 'SKIPPED').length,
    missing: rows.filter((row) => row.result === 'MISSING').length,
    gatedStories: gated.length,
    gatedIds: gated.reduce((sum, story) => sum + story.total, 0),
    gatedCovered: gated.reduce((sum, story) => sum + story.covered, 0),
    gatedExternal: gated.reduce((sum, story) => sum + story.external, 0),
  };
  return { rows, stories, summary, failures, externalChecks };
}

// ---------------------------------------------------------------------------------------------------------------------
// The handoff files of docs/uat/<module>/uat.json: every id they name must exist
// ---------------------------------------------------------------------------------------------------------------------

const ENGINEERING_RELATIVE_PATH = join('Design', 'MACHVON_Design', '03_Engineering');

const readJsonIfThere = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

/**
 * The cases of the handoff files that name something that does not exist: a screen that is not in the screen catalogue, a story that the plan does not define, a case that the design catalogue (`test_cases.json`) does not hold
 * (the run store and the evidence document know a case by that id), a case twice, and a case that says it is automated whose script (or the table the script reads) never names it. A case that points nowhere cannot be run and a
 * case that claims a script that does not name it is a claim, not a proof.
 */
export function handoffFailures({ root, plan }) {
  const directory = join(root, 'docs', 'uat');
  if (!existsSync(directory)) return [];
  const engineering = join(root, ENGINEERING_RELATIVE_PATH);
  const screens = new Set(readJsonIfThere(join(engineering, 'screen_catalog.json'), []).map((screen) => screen.id));
  const designIds = new Set(readJsonIfThere(join(engineering, 'test_cases.json'), []).map((test) => test.id));
  const stories = new Set(plan.stories.map((story) => story.id));
  const failures = [];
  const seen = new Map();
  const sources = new Map();
  const sourceOf = (path) => {
    if (!sources.has(path)) sources.set(path, existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined);
    return sources.get(path);
  };
  // `critical` is a slice of cases that the module folders hold as well, so it is the only folder where an id may repeat.
  for (const entry of readdirSync(directory, { withFileTypes: true }).filter((one) => one.isDirectory() && one.name !== 'critical')) {
    const file = join(directory, entry.name, 'uat.json');
    if (!existsSync(file)) continue;
    const where = relative(root, file).split(sep).join('/');
    for (const test of JSON.parse(readFileSync(file, 'utf8')).test_cases ?? []) {
      const id = String(test.tc_id ?? '').replace(/^TC-/, '');
      const place = `${where}: ${test.tc_id}`;
      if (seen.has(test.tc_id)) failures.push({ code: 'HANDOFF_DUPLICATE', id: test.tc_id, where: `${place}, already in ${seen.get(test.tc_id)}` });
      seen.set(test.tc_id, where);
      if (designIds.size > 0 && !designIds.has(id) && test.automation !== undefined) failures.push({ code: 'HANDOFF_CASE_UNKNOWN', id: test.tc_id, where: place });
      if (test.screen_id !== undefined && screens.size > 0 && !screens.has(test.screen_id)) failures.push({ code: 'HANDOFF_SCREEN_UNKNOWN', id: test.screen_id, where: place });
      for (const story of test.story_ids ?? []) if (!stories.has(story)) failures.push({ code: 'HANDOFF_STORY_UNKNOWN', id: story, where: place });
      if (test.automation?.state === 'AUTOMATED') {
        const named = [test.automation.suite, test.automation.registry].filter((path) => typeof path === 'string').some((path) => sourceOf(path)?.includes(id));
        if (!named) failures.push({ code: 'HANDOFF_AUTOMATION_MISSING', id: test.tc_id, where: `${place} names ${test.automation.suite ?? 'no suite'}` });
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------------
// The generated document
// ---------------------------------------------------------------------------------------------------------------------

const cell = (value) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderCoverage(trace, messages = loadMessages(DOCUMENT_LOCALE)) {
  const externalChecks = trace.externalChecks ?? {};
  const { summary } = trace;
  const lines = [
    `# ${messages['uat.doc.title']}`,
    '',
    messages['uat.doc.generated'],
    '',
    format(messages['uat.doc.releases'], { releases: summary.releases.join(', '), stories: summary.stories }),
    format(messages['uat.doc.totals'], { covered: summary.covered, total: summary.total, skipped: summary.skipped, missing: summary.missing }),
    format(messages['uat.doc.gated'], { stories: summary.gatedStories, covered: summary.gatedCovered, external: summary.gatedExternal, total: summary.gatedIds }),
    '',
    `## ${messages['uat.doc.storiesHeading']}`,
    '',
    '| story | status | covered | total |',
    '| --- | --- | --- | --- |',
    ...trace.stories.map((story) => `| ${story.id} | ${story.status ?? '-'} | ${story.covered} | ${story.total} |`),
    '',
    `## ${messages['uat.doc.criteriaHeading']}`,
    '',
    '| ID | story | test | result |',
    '| --- | --- | --- | --- |',
    ...trace.rows.map((row) => {
      const tests = row.tests.length === 0 ? '-' : row.tests.map((test) => cell(`${test.file}: ${test.title}${test.skipped ? ` ${messages['uat.doc.skippedMark']}` : ''}`)).join('<br>');
      return `| ${row.id} | ${row.story} | ${tests} | ${row.result} |`;
    }),
  ];
  const declared = trace.rows.filter((row) => row.result !== 'COVERED' && Object.hasOwn(externalChecks, row.id) && trace.stories.some((story) => story.id === row.story && EXTERNAL_STATUSES.has(story.status)));
  if (declared.length > 0) {
    lines.push('', `## ${messages['uat.doc.externalHeading']}`, '', messages['uat.doc.externalNote'], '', '| ID | story | what only an external system can prove |', '| --- | --- | --- |');
    for (const row of declared) lines.push(`| ${row.id} | ${row.story} | ${cell(externalChecks[row.id])} |`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------

function describeFailure(failure, messages) {
  return format(messages[`uat.${failure.code}`], { id: failure.id, story: failure.story ?? '', where: failure.where ?? '', status: failure.status ?? '' });
}

export function main(argv, { log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      plan: { type: 'string' },
      status: { type: 'string' },
      out: { type: 'string' },
      releases: { type: 'string', default: DEFAULT_RELEASES.join(',') },
      check: { type: 'boolean', default: false },
      locale: { type: 'string', default: DEFAULT_LOCALE },
    },
  });
  const messages = loadMessages(values.locale);
  const root = resolve(values.root);
  const planPath = values.plan === undefined ? join(root, PLAN_RELATIVE_PATH) : resolve(values.plan);
  const outPath = values.out === undefined ? join(root, OUT_RELATIVE_PATH) : resolve(values.out);
  if (!existsSync(planPath)) {
    log(format(messages['uat.plan.missing'], { path: planPath }));
    return 1;
  }
  const trace = traceCoverage({
    root,
    planPath,
    statusPath: values.status === undefined ? join(root, STATUS_RELATIVE_PATH) : resolve(values.status),
    releases: values.releases.split(',').filter(Boolean),
  });
  const document = renderCoverage(trace);
  const failures = [...trace.failures, ...handoffFailures({ root, plan: JSON.parse(readFileSync(planPath, 'utf8')) })].map((failure) => describeFailure(failure, messages));
  if (values.check) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined;
    if (current !== document) failures.push(format(messages['uat.stale'], { path: relative(root, outPath).split(sep).join('/') }));
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, document);
  }
  for (const line of failures) log(line);
  const { summary } = trace;
  log(
    format(messages[failures.length === 0 ? 'uat.summary.pass' : 'uat.summary.fail'], {
      covered: summary.covered,
      total: summary.total,
      gatedCovered: summary.gatedCovered,
      gatedExternal: summary.gatedExternal,
      gatedIds: summary.gatedIds,
      count: failures.length,
    }),
  );
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
