import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCxn, isConfirmed, main } from './cxn-gate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

const row = (id, overrides = {}) => ({ id, status: 'AWAITING_CONFIRMATION', confirmed_by: null, confirmed_at: null, evidence: null, ...overrides });
const confirmed = (id) => row(id, { status: 'CONFIRMED', confirmed_by: 'Legal reviewer', confirmed_at: '2026-10-01T00:00:00Z', evidence: 'Official letter 12/PC' });
const story = (id, cxn) => ({ id, release: 'R1', cxn, acceptance: [] });

test('a confirmation is a status together with who, when and the evidence (AC-ST-KERNEL-060-3)', () => {
  assert.equal(isConfirmed(confirmed('CXN-03')), true);
  assert.equal(isConfirmed(row('CXN-03', { status: 'CONFIRMED' })), false);
  assert.equal(isConfirmed(row('CXN-03', { status: 'CONFIRMED', confirmed_by: 'Someone', confirmed_at: '2026-10-01', evidence: '   ' })), false);
  assert.equal(isConfirmed(row('CXN-03', { confirmed_by: 'Someone', confirmed_at: '2026-10-01', evidence: 'x' })), false);
});

test('a DONE story that cites a CXN item still awaiting confirmation fails and lists the ids; it passes when the ledger shows who confirmed it and when (AC-ST-KERNEL-060-3)', () => {
  const plan = { stories: [story('ST-PAY-006', ['CXN-03', 'CXN-08']), story('ST-ISS-001', ['CXN-CAL-01']), story('ST-DOC-001', [])] };
  const statuses = { 'ST-PAY-006': 'DONE', 'ST-ISS-001': 'DONE_PENDING_ENV', 'ST-DOC-001': 'DONE' };
  const awaiting = checkCxn({ plan, ledger: [row('CXN-03'), confirmed('CXN-08'), row('CXN-CAL-01')], statuses });
  assert.deepEqual(awaiting.failures, [
    { code: 'DONE_WITH_UNCONFIRMED', story: 'ST-PAY-006', status: 'DONE', ids: 'CXN-03' },
    { code: 'DONE_WITH_UNCONFIRMED', story: 'ST-ISS-001', status: 'DONE_PENDING_ENV', ids: 'CXN-CAL-01' },
  ]);
  const settled = checkCxn({ plan, ledger: [confirmed('CXN-03'), confirmed('CXN-08'), confirmed('CXN-CAL-01')], statuses });
  assert.deepEqual(settled.failures, []);
  assert.deepEqual(settled.summary, { ledger: 3, confirmed: 3, complete: 3, awaiting: 0, awaitingIds: 0 });
});

test('DONE_UNCONFIRMED is the honest status for a story that rests on an item nobody confirmed, and is refused once the item is confirmed or when it cites none', () => {
  const plan = { stories: [story('ST-A', ['CXN-01']), story('ST-B', ['CXN-02']), story('ST-C', []), story('ST-D', ['CXN-01', 'CXN-02'])] };
  const statuses = { 'ST-A': 'DONE_UNCONFIRMED', 'ST-B': 'DONE_UNCONFIRMED', 'ST-C': 'DONE_UNCONFIRMED', 'ST-D': 'DONE_UNCONFIRMED' };
  const result = checkCxn({ plan, ledger: [row('CXN-01'), confirmed('CXN-02')], statuses });
  assert.deepEqual(result.failures, [
    { code: 'STALE_UNCONFIRMED', story: 'ST-B', ids: 'CXN-02' },
    { code: 'UNCONFIRMED_WITHOUT_CXN', story: 'ST-C' },
  ]);
  assert.deepEqual(result.summary, { ledger: 2, confirmed: 1, complete: 0, awaiting: 4, awaitingIds: 1 });
});

test('a story that is not complete is not judged, a citation the ledger does not know is refused, and so is a ledger row confirmed without its evidence', () => {
  const plan = { stories: [story('ST-A', ['CXN-01']), story('ST-B', ['CXN-99'])] };
  const result = checkCxn({ plan, ledger: [row('CXN-01'), row('CXN-04', { status: 'CONFIRMED' })], statuses: { 'ST-A': 'PARTIAL' } });
  assert.deepEqual(result.failures, [{ code: 'LEDGER_INCOMPLETE', id: 'CXN-04' }, { code: 'UNKNOWN_CXN', id: 'CXN-99', story: 'ST-B' }]);
});

function scratch({ plan, ledger, status }) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-cxn-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'Design/MACHVON_Design/03_Engineering/implementation_plan.json': plan,
    'Design/MACHVON_Design/03_Engineering/legal_confirmation_ledger.json': ledger,
    ...(status === undefined ? {} : { 'docs/story-status.json': status }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(content));
  }
  return root;
}

test('the command reads the plan, the ledger and the status file, prints the problems and the summary, and fails with 1', () => {
  const root = scratch({ plan: { stories: [story('ST-A', ['CXN-01'])] }, ledger: [row('CXN-01')], status: { stories: { 'ST-A': 'DONE' } } });
  const lines = [];
  assert.equal(main(['--root', root], { log: (line) => lines.push(line) }), 1);
  assert.match(lines[0], /ST-A/);
  assert.match(lines[0], /CXN-01/);
  assert.match(lines.at(-1), /1 vấn đề/);
  const english = [];
  assert.equal(main(['--root', root, '--locale', 'en'], { log: (line) => english.push(line) }), 1);
  assert.match(english[0], /mark it DONE_UNCONFIRMED/);
});

test('the command passes when nothing complete rests on an unconfirmed item, with no status file at all too', () => {
  const root = scratch({ plan: { stories: [story('ST-A', ['CXN-01'])] }, ledger: [row('CXN-01')], status: { stories: { 'ST-A': 'DONE_UNCONFIRMED' } } });
  const lines = [];
  assert.equal(main(['--root', root], { log: (line) => lines.push(line) }), 0);
  assert.match(lines.at(-1), /cổng pháp lý đạt/);
  const bare = scratch({ plan: { stories: [story('ST-A', ['CXN-01'])] }, ledger: [row('CXN-01')] });
  assert.equal(main(['--root', bare], { log: () => undefined }), 0);
});

test('the command says which input is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'machvon-cxn-empty-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const lines = [];
  assert.equal(main(['--root', root], { log: (line) => lines.push(line) }), 1);
  assert.match(lines[0], /implementation_plan\.json/);
});

test('the repository itself keeps the gate: no story is DONE on an item that is not confirmed', () => {
  const lines = [];
  assert.equal(main(['--root', REPO_ROOT], { log: (line) => lines.push(line) }), 0, lines.join('\n'));
});
