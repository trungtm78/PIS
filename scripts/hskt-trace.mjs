import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The traceability matrix of the customer dossier HSKT "Phan mem quan ly DTXD" v0.3 (lane DELIVERY-1, plan ENT-3 gap G19):
 *   node scripts/hskt-trace.mjs check      fails when the matrix and the repository disagree (default)
 *   node scripts/hskt-trace.mjs generate   writes docs/hskt/TRACEABILITY.md from docs/hskt/requirements.json
 *
 * The data is `docs/hskt/requirements.json` (one row per requirement code, per phase and per deliverable of the dossier). `check` fails when
 *   - a code of the dossier has no row, appears twice, or a row has a code the dossier does not have;
 *   - a row names a screen, an operation, a story, a document or a test that does not exist;
 *   - a DONE row has no evidence at all;
 *   - a row that is not DONE has no gap text or no owning lane, or names a lane that is not on the list;
 *   - a PENDING-EXTERNAL row names no item of the register, or an item is unknown, unused or missing from the register document;
 *   - the generated file is out of date.
 * Vietnamese words live in the data file (key `texts`), never in this source.
 */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_PATH = 'docs/hskt/requirements.json';
export const OUTPUT_PATH = 'docs/hskt/TRACEABILITY.md';
const ENGINEERING = 'Design/MACHVON_Design/03_Engineering';

export const STATUSES = ['DONE', 'PARTIAL', 'MISSING', 'PENDING-EXTERNAL'];
export const LANES = ['ENT-3a', 'ENT-3b', 'ENT-3c', 'ENT-3d', 'ENT-3e', 'ENT-4a', 'ENT-4b', 'ENT-4c', 'ENT-4d', 'ENT-4e', 'INFRA-2', 'DOC-3', 'DELIVERY-1'];
export const EVIDENCE_KINDS = ['screens', 'operations', 'stories', 'docs', 'tests'];

/** The codes of the dossier: section II.3 (requirements), II.2.3 (the 7 phases) and II.5 (the 11 deliverables). */
const REQUIREMENT_GROUPS = { MD: 3, DL: 3, QT: 2, CN: 4, BC: 2, TH: 3, HT: 6, YCK: 8, TK: 4 };
const two = (n) => String(n).padStart(2, '0');
const range = (count, make) => Array.from({ length: count }, (_, index) => make(index + 1));
export const REQUIREMENT_CODES = Object.entries(REQUIREMENT_GROUPS).flatMap(([group, count]) => range(count, (n) => `${group}.${two(n)}`));
export const PHASE_CODES = range(7, (n) => `GD.${n}`);
export const DELIVERABLE_CODES = range(11, (n) => `SP.${two(n)}`);
export const ALL_CODES = [...REQUIREMENT_CODES, ...PHASE_CODES, ...DELIVERABLE_CODES];

const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

/** What exists in the repository: screen ids, operation ids, story ids, and a file test. */
export function loadSources(root = ROOT) {
  const screens = new Set(readJson(root, `${ENGINEERING}/screen_catalog.json`).map((screen) => screen.id));
  const stories = new Set(readJson(root, `${ENGINEERING}/implementation_plan.json`).stories.map((story) => story.id));
  const operations = new Set();
  for (const methods of Object.values(readJson(root, `${ENGINEERING}/openapi.json`).paths)) {
    for (const operation of Object.values(methods)) if (operation !== null && typeof operation === 'object' && typeof operation.operationId === 'string') operations.add(operation.operationId);
  }
  return { screens, stories, operations, fileExists: (path) => existsSync(join(root, path)), readText: (path) => readFileSync(join(root, path), 'utf8') };
}

const evidenceOf = (row) => EVIDENCE_KINDS.flatMap((kind) => (Array.isArray(row.evidence?.[kind]) ? row.evidence[kind] : []));
const list = (value) => (Array.isArray(value) ? value : []);

/** The problems of the data against the dossier's code list and the repository; an empty array means the matrix is closed. */
export function validate(data, sources) {
  const problems = [];
  const rows = list(data.rows);
  const seen = new Map();
  for (const row of rows) seen.set(row.code, (seen.get(row.code) ?? 0) + 1);
  for (const code of ALL_CODES) if (!seen.has(code)) problems.push(`${code}: the code of the dossier has no row`);
  for (const [code, count] of seen) {
    if (!ALL_CODES.includes(code)) problems.push(`${code}: the row has a code the dossier does not have`);
    if (count > 1) problems.push(`${code}: ${count} rows for one code`);
  }
  const register = new Map(list(data.pendingExternal).map((item) => [item.id, item]));
  const used = new Set();
  const registerText = typeof data.registerDocument === 'string' && sources.fileExists(data.registerDocument) ? sources.readText(data.registerDocument) : null;
  if (registerText === null) problems.push(`registerDocument: ${data.registerDocument ?? '(missing)'} does not exist`);
  for (const row of rows) {
    const at = row.code;
    if (!STATUSES.includes(row.status)) problems.push(`${at}: status ${row.status} is not one of ${STATUSES.join(', ')}`);
    if (typeof row.title !== 'string' || row.title.trim() === '') problems.push(`${at}: no title`);
    const ownEvidence = row.evidence ?? {};
    for (const kind of Object.keys(ownEvidence)) if (!EVIDENCE_KINDS.includes(kind)) problems.push(`${at}: evidence kind ${kind} is unknown`);
    for (const id of list(ownEvidence.screens)) if (!sources.screens.has(id)) problems.push(`${at}: screen ${id} is not in screen_catalog.json`);
    for (const id of list(ownEvidence.operations)) if (!sources.operations.has(id)) problems.push(`${at}: operation ${id} is not in openapi.json`);
    for (const id of list(ownEvidence.stories)) if (!sources.stories.has(id)) problems.push(`${at}: story ${id} is not in implementation_plan.json`);
    for (const path of [...list(ownEvidence.docs), ...list(ownEvidence.tests)]) if (!sources.fileExists(path)) problems.push(`${at}: file ${path} does not exist`);
    if (row.status === 'DONE' && evidenceOf(row).length === 0) problems.push(`${at}: status DONE but no evidence`);
    if (row.status !== 'DONE') {
      if (typeof row.gap !== 'string' || row.gap.trim() === '') problems.push(`${at}: status ${row.status} needs a gap text`);
      if (list(row.owners).length === 0) problems.push(`${at}: status ${row.status} needs an owning lane`);
    }
    for (const lane of list(row.owners)) if (!LANES.includes(lane)) problems.push(`${at}: lane ${lane} is not one of ${LANES.join(', ')}`);
    for (const id of list(row.pending)) {
      used.add(id);
      if (!register.has(id)) problems.push(`${at}: pending item ${id} is not in the register`);
    }
    if (row.status === 'PENDING-EXTERNAL' && list(row.pending).length === 0) problems.push(`${at}: status PENDING-EXTERNAL needs an item of the register`);
  }
  for (const [id, item] of register) {
    if (!used.has(id)) problems.push(`${id}: register item is used by no row`);
    if (typeof item.provider !== 'string' || item.provider.trim() === '' || typeof item.what !== 'string' || item.what.trim() === '') problems.push(`${id}: register item needs what and provider`);
    if (registerText !== null && !registerText.includes(id)) problems.push(`${id}: register item is missing from ${data.registerDocument}`);
  }
  return problems;
}

const cell = (text) => String(text ?? '').replace(/\|/gu, '/').replace(/\r?\n/gu, ' ');
const joined = (values) => (values.length === 0 ? '' : values.join(', '));
const code = (values) => joined(values.map((value) => `\`${value}\``));

function evidenceCell(row) {
  const parts = [];
  const screens = list(row.evidence?.screens);
  const operations = list(row.evidence?.operations);
  const stories = list(row.evidence?.stories);
  const docs = list(row.evidence?.docs);
  const tests = list(row.evidence?.tests);
  if (screens.length > 0) parts.push(`M: ${joined(screens)}`);
  if (operations.length > 0) parts.push(`O: ${code(operations)}`);
  if (stories.length > 0) parts.push(`S: ${joined(stories)}`);
  if (docs.length > 0) parts.push(`D: ${code(docs)}`);
  if (tests.length > 0) parts.push(`T: ${code(tests)}`);
  return parts.join('<br>');
}

const GROUP_OF = (rowCode) => rowCode.split('.')[0];

/** The markdown of the matrix. The words are the data's (`texts`), the layout is here. */
export function render(data) {
  const texts = data.texts ?? {};
  const rows = list(data.rows);
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const out = [];
  out.push(`# ${texts.title}`, '', texts.generated, '', texts.intro, '');
  const counts = Object.fromEntries(STATUSES.map((status) => [status, rows.filter((row) => row.status === status).length]));
  out.push(`## ${texts.summaryHeading}`, '', `| ${texts.statusColumn} | ${texts.countColumn} |`, '| --- | ---: |');
  for (const status of STATUSES) out.push(`| ${status} | ${counts[status]} |`);
  out.push(`| ${texts.totalLabel} | ${rows.length} |`, '');
  out.push(`### ${texts.byLaneHeading}`, '', `| ${texts.laneColumn} | ${texts.countColumn} | ${texts.codesColumn} |`, '| --- | ---: | --- |');
  for (const lane of LANES) {
    const owned = rows.filter((row) => list(row.owners).includes(lane) && row.status !== 'DONE');
    if (owned.length > 0) out.push(`| ${lane} | ${owned.length} | ${owned.map((row) => row.code).join(', ')} |`);
  }
  out.push('', `${texts.legend}`, '');
  const header = `| ${texts.codeColumn} | ${texts.titleColumn} | ${texts.statusColumn} | ${texts.evidenceColumn} | ${texts.gapColumn} | ${texts.laneColumn} | ${texts.pendingColumn} |`;
  const separator = '| --- | --- | --- | --- | --- | --- | --- |';
  const line = (row) => `| ${row.code} | ${cell(row.title)} | ${row.status} | ${cell(evidenceCell(row))} | ${cell(row.gap)} | ${joined(list(row.owners))} | ${joined(list(row.pending))} |`;
  for (const group of Object.keys(REQUIREMENT_GROUPS)) {
    out.push(`## ${group}. ${texts.groups?.[group] ?? ''}`, '', header, separator);
    for (const requirement of REQUIREMENT_CODES.filter((one) => GROUP_OF(one) === group)) if (byCode.has(requirement)) out.push(line(byCode.get(requirement)));
    out.push('');
  }
  out.push(`## ${texts.phasesHeading}`, '', header, separator);
  for (const phase of PHASE_CODES) if (byCode.has(phase)) out.push(line(byCode.get(phase)));
  out.push('', `## ${texts.deliverablesHeading}`, '', header, separator);
  for (const deliverable of DELIVERABLE_CODES) if (byCode.has(deliverable)) out.push(line(byCode.get(deliverable)));
  out.push('', `## ${texts.registerHeading}`, '', texts.registerIntro, '', `| ${texts.idColumn} | ${texts.whatColumn} | ${texts.providerColumn} | ${texts.assumptionColumn} | ${texts.blocksColumn} |`, '| --- | --- | --- | --- | --- |');
  for (const item of list(data.pendingExternal)) {
    const blocks = rows.filter((row) => list(row.pending).includes(item.id)).map((row) => row.code);
    out.push(`| ${item.id} | ${cell(item.what)} | ${cell(item.provider)} | ${cell(item.assumption)} | ${blocks.join(', ')} |`);
  }
  out.push('', `${texts.registerDocumentNote} \`${data.registerDocument}\`.`, '');
  return `${out.join('\n')}`;
}

export function run(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const root = io.root ?? ROOT;
  const read = io.read ?? ((path) => readFileSync(join(root, path), 'utf8'));
  const write = io.write ?? ((path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); });
  const [command = 'check'] = argv;
  if (command !== 'check' && command !== 'generate') {
    log('usage: node scripts/hskt-trace.mjs <check|generate>');
    return 2;
  }
  const data = JSON.parse(read(DATA_PATH));
  const text = render(data);
  if (command === 'generate') {
    write(OUTPUT_PATH, text);
    log(`wrote ${OUTPUT_PATH}`);
    return 0;
  }
  const sources = io.sources ?? loadSources(root);
  const problems = validate(data, sources);
  let current = null;
  try {
    current = read(OUTPUT_PATH);
  } catch {
    current = null;
  }
  if (current === null) problems.push(`${OUTPUT_PATH} does not exist: run node scripts/hskt-trace.mjs generate`);
  else if (current.replace(/\r\n/gu, '\n') !== text) problems.push(`${OUTPUT_PATH} is out of date: run node scripts/hskt-trace.mjs generate`);
  for (const problem of problems) log(`hskt-trace: ${problem}`);
  const rows = list(data.rows);
  log(`hskt-trace: ${rows.length} rows, ${problems.length === 0 ? 'ok' : `${problems.length} problem(s)`}`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
