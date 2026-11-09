import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ALL_CODES, DATA_PATH, DELIVERABLE_CODES, OUTPUT_PATH, PHASE_CODES, REQUIREMENT_CODES, loadSources, render, run, validate } from './hskt-trace.mjs';

const real = JSON.parse(readFileSync(new URL('../docs/hskt/requirements.json', import.meta.url), 'utf8'));

const REGISTER = 'register.md';
const sources = (overrides = {}) => ({
  screens: new Set(['SCR-01']),
  operations: new Set(['doThing']),
  stories: new Set(['ST-X-001']),
  fileExists: (path) => path === 'doc.md' || path === REGISTER,
  readText: () => 'PX-01 is described here',
  ...overrides,
});

const row = (code, extra = {}) => ({ code, title: `title ${code}`, status: 'DONE', evidence: { docs: ['doc.md'] }, gap: '', owners: [], pending: [], ...extra });
const valid = () => ({
  registerDocument: REGISTER,
  texts: real.texts,
  pendingExternal: [{ id: 'PX-01', what: 'a file', provider: 'the customer', assumption: 'none' }],
  rows: ALL_CODES.map((code, index) => (index === 0 ? row(code, { status: 'PENDING-EXTERNAL', gap: 'waits', owners: ['DELIVERY-1'], pending: ['PX-01'] }) : row(code))),
});
const withRow = (data, code, patch) => ({ ...data, rows: data.rows.map((one) => (one.code === code ? { ...one, ...patch } : one)) });
const problems = (data, over) => validate(data, sources(over));

test('the code list is the dossier: 35 requirements, 7 phases, 11 deliverables', () => {
  assert.equal(REQUIREMENT_CODES.length, 35);
  assert.equal(PHASE_CODES.length, 7);
  assert.equal(DELIVERABLE_CODES.length, 11);
  assert.ok(REQUIREMENT_CODES.includes('YCK.08') && REQUIREMENT_CODES.includes('TK.04') && REQUIREMENT_CODES.includes('MD.01'));
  assert.equal(new Set(ALL_CODES).size, ALL_CODES.length);
});

test('a closed matrix has no problem', () => {
  assert.deepEqual(problems(valid()), []);
});

test('a code of the dossier without a row fails, and so does an unknown code or a duplicate', () => {
  const data = valid();
  assert.match(problems({ ...data, rows: data.rows.filter((one) => one.code !== 'QT.02') }).join('\n'), /QT\.02: the code of the dossier has no row/u);
  assert.match(problems({ ...data, rows: [...data.rows, row('ZZ.01')] }).join('\n'), /ZZ\.01: the row has a code the dossier does not have/u);
  assert.match(problems({ ...data, rows: [...data.rows, row('QT.01')] }).join('\n'), /QT\.01: 2 rows for one code/u);
});

test('a row that points to a screen, operation, story, document or test that does not exist fails', () => {
  const data = valid();
  assert.match(problems(withRow(data, 'DL.01', { evidence: { screens: ['SCR-99'] } })).join('\n'), /DL\.01: screen SCR-99/u);
  assert.match(problems(withRow(data, 'DL.01', { evidence: { operations: ['nope'] } })).join('\n'), /DL\.01: operation nope/u);
  assert.match(problems(withRow(data, 'DL.01', { evidence: { stories: ['ST-X-999'] } })).join('\n'), /DL\.01: story ST-X-999/u);
  assert.match(problems(withRow(data, 'DL.01', { evidence: { docs: ['missing.md'] } })).join('\n'), /DL\.01: file missing\.md does not exist/u);
  assert.match(problems(withRow(data, 'DL.01', { evidence: { tests: ['missing.test.ts'] } })).join('\n'), /DL\.01: file missing\.test\.ts does not exist/u);
  assert.match(problems(withRow(data, 'DL.01', { evidence: { videos: ['x'] } })).join('\n'), /DL\.01: evidence kind videos is unknown/u);
  assert.deepEqual(problems(withRow(data, 'DL.01', { evidence: { screens: ['SCR-01'], operations: ['doThing'], stories: ['ST-X-001'], docs: ['doc.md'] } })), []);
});

test('a DONE row without evidence fails', () => {
  assert.match(problems(withRow(valid(), 'HT.03', { evidence: {} })).join('\n'), /HT\.03: status DONE but no evidence/u);
  assert.match(problems(withRow(valid(), 'HT.03', { evidence: { docs: [] } })).join('\n'), /HT\.03: status DONE but no evidence/u);
});

test('a row that is not DONE needs a gap and an owning lane from the list', () => {
  const data = valid();
  assert.match(problems(withRow(data, 'CN.01', { status: 'PARTIAL', gap: '', owners: ['ENT-3e'] })).join('\n'), /CN\.01: status PARTIAL needs a gap text/u);
  assert.match(problems(withRow(data, 'CN.01', { status: 'MISSING', gap: 'g', owners: [] })).join('\n'), /CN\.01: status MISSING needs an owning lane/u);
  assert.match(problems(withRow(data, 'CN.01', { status: 'PARTIAL', gap: 'g', owners: ['ENT-9z'] })).join('\n'), /CN\.01: lane ENT-9z is not one of/u);
  assert.match(problems(withRow(data, 'CN.01', { status: 'DONEISH' })).join('\n'), /CN\.01: status DONEISH is not one of/u);
  assert.deepEqual(problems(withRow(data, 'CN.01', { status: 'PARTIAL', gap: 'g', owners: ['ENT-3e'] })), []);
});

test('PENDING-EXTERNAL needs an item of the register, every item is used and described in the register document', () => {
  const data = valid();
  assert.match(problems(withRow(data, 'TH.01', { status: 'PENDING-EXTERNAL', gap: 'g', owners: ['ENT-3c'], pending: [] })).join('\n'), /TH\.01: status PENDING-EXTERNAL needs an item/u);
  assert.match(problems(withRow(data, 'TH.01', { pending: ['PX-77'] })).join('\n'), /TH\.01: pending item PX-77 is not in the register/u);
  assert.match(problems({ ...data, rows: data.rows.map((one) => ({ ...one, pending: [] })) }).join('\n'), /PX-01: register item is used by no row/u);
  assert.match(problems(data, { readText: () => 'nothing' }).join('\n'), /PX-01: register item is missing from register\.md/u);
  assert.match(problems(data, { fileExists: (path) => path === 'doc.md' }).join('\n'), /registerDocument: register\.md does not exist/u);
  assert.match(problems({ ...data, pendingExternal: [{ id: 'PX-01', what: '', provider: 'x' }] }).join('\n'), /PX-01: register item needs what and provider/u);
});

test('render lists every code once and the status counts', () => {
  const text = render(valid());
  for (const code of ALL_CODES) assert.ok(text.includes(`| ${code} |`), code);
  assert.match(text, /\| DONE \| 52 \|/u);
  assert.match(text, /\| PX-01 \|/u);
});

const memory = (data, generated) => {
  const files = new Map([[DATA_PATH, JSON.stringify(data)]]);
  if (generated !== undefined) files.set(OUTPUT_PATH, generated);
  const lines = [];
  return {
    files,
    lines,
    io: {
      log: (line) => lines.push(line),
      read: (path) => {
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
      write: (path, text) => files.set(path, text),
      sources: sources(),
    },
  };
};

test('generate writes the file and check then passes; a stale or missing file fails', () => {
  const data = valid();
  const one = memory(data);
  assert.equal(run(['check'], one.io), 1);
  assert.ok(one.lines.some((line) => /does not exist: run/u.test(line)));
  assert.equal(run(['generate'], one.io), 0);
  assert.equal(run(['check'], one.io), 0);
  assert.ok(one.lines.some((line) => /53 rows, ok/u.test(line)));
  one.files.set(OUTPUT_PATH, `${one.files.get(OUTPUT_PATH)}\nedited by hand`);
  assert.equal(run(['check'], one.io), 1);
  assert.ok(one.lines.some((line) => /is out of date/u.test(line)));
});

test('check accepts a generated file with Windows line ends', () => {
  const data = valid();
  const one = memory(data, render(data).replace(/\n/gu, '\r\n'));
  assert.equal(run([], one.io), 0);
});

test('check goes red on a broken matrix and an unknown command is a usage error', () => {
  const data = withRow(valid(), 'BC.01', { evidence: { screens: ['SCR-99'] } });
  const one = memory(data, render(data));
  assert.equal(run(['check'], one.io), 1);
  assert.ok(one.lines.some((line) => /BC\.01: screen SCR-99/u.test(line)));
  assert.equal(run(['explode'], one.io), 2);
});

test('the repository matrix is closed: every reference exists and the generated file is current', () => {
  const lines = [];
  const code = run(['check'], { log: (line) => lines.push(line), sources: loadSources() });
  assert.equal(code, 0, lines.join('\n'));
  const generated = readFileSync(new URL('../docs/hskt/TRACEABILITY.md', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  assert.equal(generated, render(JSON.parse(readFileSync(new URL('../docs/hskt/requirements.json', import.meta.url), 'utf8'))));
});

test('the checker can go red on the real matrix: a dropped row, a renamed screen and an emptied evidence each fail', () => {
  const data = JSON.parse(readFileSync(new URL('../docs/hskt/requirements.json', import.meta.url), 'utf8'));
  const sourcesOfRepository = loadSources();
  assert.deepEqual(validate(data, sourcesOfRepository), []);
  assert.match(validate({ ...data, rows: data.rows.filter((one) => one.code !== 'TK.04') }, sourcesOfRepository).join('\n'), /TK\.04: the code of the dossier has no row/u);
  const renamed = { ...data, rows: data.rows.map((one) => (one.code === 'DL.02' ? { ...one, evidence: { ...one.evidence, screens: ['IND-99'] } } : one)) };
  assert.match(validate(renamed, sourcesOfRepository).join('\n'), /DL\.02: screen IND-99/u);
  const emptied = { ...data, rows: data.rows.map((one) => (one.code === 'HT.03' ? { ...one, evidence: {} } : one)) };
  assert.match(validate(emptied, sourcesOfRepository).join('\n'), /HT\.03: status DONE but no evidence/u);
});

test('malformed data is a problem line, never a crash', () => {
  const data = valid();
  assert.match(problems({ ...data, rows: [...data.rows, null] }).join(' '), /rows: an entry is not an object/u);
  assert.match(problems({ ...data, pendingExternal: [...data.pendingExternal, 7] }).join(' '), /pendingExternal: an entry is not an object/u);
  assert.match(problems({ ...data, rows: 'x' }).join(' '), /rows: not a list/u);
  assert.deepEqual(problems(null), ['the data is not an object']);
  assert.match(problems(withRow(data, 'DL.01', { evidence: { docs: 'doc.md' } })).join(' '), /DL\.01: docs must be a list/u);
  assert.match(problems(withRow(data, 'DL.01', { owners: 'ENT-3a' })).join(' '), /DL\.01: owners must be a list/u);
  assert.match(problems(withRow(data, 'DL.01', { evidence: 'doc.md' })).join(' '), /DL\.01: evidence is not an object/u);
  assert.match(problems({ ...data, texts: {} }).join(' '), /texts\.title: missing/u);
});

test('evidence paths must be non-empty relative files inside the repository', () => {
  const data = valid();
  for (const bad of ['', '../outside.md', '/abs.md', 'C:/abs.md', 'docs/../../x.md']) {
    const text = problems(withRow(data, 'DL.01', { evidence: { docs: [bad] } }), { fileExists: () => true }).join(' ');
    assert.match(text, /DL\.01: (file ".*" is (empty or not text|not a path inside the repository)|docs must be a list)/u, bad);
  }
});

test('a DONE row cannot wait for the customer, and a register item cannot appear twice', () => {
  const data = valid();
  assert.match(problems(withRow(data, 'TH.01', { pending: ['PX-01'] })).join(' '), /TH\.01: status DONE cannot wait for the customer/u);
  assert.match(problems({ ...data, pendingExternal: [...data.pendingExternal, data.pendingExternal[0]] }).join(' '), /PX-01: register item appears twice/u);
});

test('check reports unreadable data and ignores a byte order mark in the generated file', () => {
  const lines = [];
  assert.equal(run(['check'], { log: (line) => lines.push(line), read: () => '{not json', sources: sources() }), 1);
  assert.ok(lines.some((line) => /cannot be read as JSON/u.test(line)));
  const data = valid();
  const one = memory(data, `\uFEFF${render(data)}`);
  assert.equal(run(['check'], one.io), 0);
  const broken = memory(withRow(data, 'DL.01', { evidence: { screens: ['SCR-99'] } }));
  assert.equal(run(['generate'], broken.io), 1);
  assert.ok(!broken.files.has(OUTPUT_PATH));
});
