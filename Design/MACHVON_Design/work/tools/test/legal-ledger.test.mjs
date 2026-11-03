import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMarkers, buildLedger, checkLedgerMarkers } from '../src/legal-ledger.mjs';
import { ledgerMain } from '../src/legal-ledger-cli.mjs';

const SPEC_A = [
  '## 5. Quy tắc',
  'Trần tạm ứng theo loại hợp đồng [CXN-12] cần xác nhận.',
  'Hạn quyết toán nhóm B [CXN-31] và nhóm C [CXN-31].',
  'Dòng không có mã [CXN] cần mã.',
].join('\n');
const SPEC_B = 'Tỷ lệ giải ngân mẫu số [CXN-12]; mẫu TT44 [CXN-03, CXN-04].';

test('extractMarkers finds ids, including comma lists, with the line they appear on', () => {
  const found = extractMarkers(SPEC_A, 'PAY.md');
  assert.deepEqual(found.map((m) => m.id), ['CXN-12', 'CXN-31', 'CXN-31', null]);
  assert.equal(found[0].file, 'PAY.md');
  assert.match(found[0].context, /Trần tạm ứng/);
  assert.equal(found[0].line, 2);
  assert.deepEqual(extractMarkers(SPEC_B, 'DIS.md').map((m) => m.id), ['CXN-12', 'CXN-03', 'CXN-04']);
});

test('buildLedger groups markers by id with files, a statement and default status', () => {
  const markers = [...extractMarkers(SPEC_A, 'PAY.md'), ...extractMarkers(SPEC_B, 'DIS.md')];
  const ledger = buildLedger(markers, {});
  assert.deepEqual(ledger.map((row) => row.id), ['CXN-03', 'CXN-04', 'CXN-12', 'CXN-31']);
  const row12 = ledger.find((row) => row.id === 'CXN-12');
  assert.deepEqual(row12.files, ['DIS.md', 'PAY.md']);
  assert.equal(row12.occurrences, 2);
  assert.equal(row12.status, 'AWAITING_CONFIRMATION');
  assert.equal(row12.owner, 'Pháp chế');
  assert.match(row12.statement, /Trần tạm ứng|Tỷ lệ giải ngân/);
});

test('owners and confirmations from the human-maintained register override defaults', () => {
  const markers = extractMarkers(SPEC_B, 'DIS.md');
  const ledger = buildLedger(markers, {
    'CXN-12': { owner: 'Chủ nghiệp vụ vốn', evidence: 'Công báo số 123', status: 'CONFIRMED', confirmed_by: 'PO', confirmed_at: '2026-11-01' },
  });
  const row = ledger.find((r) => r.id === 'CXN-12');
  assert.deepEqual([row.owner, row.evidence, row.status, row.confirmed_by], ['Chủ nghiệp vụ vốn', 'Công báo số 123', 'CONFIRMED', 'PO']);
});

test('a waiver of the register reaches the ledger with who waived it, when and why, and an item that is not waived carries none of it (AC-ST-KERNEL-110-1)', () => {
  const markers = extractMarkers(SPEC_B, 'DIS.md');
  const ledger = buildLedger(markers, {
    'CXN-12': { owner: 'Chủ nghiệp vụ vốn', status: 'WAIVED', waived_by: 'Chủ nghiệp vụ vốn', waived_at: '2026-11-02', waiver_reason: 'Rủi ro được chấp nhận đến khi có nghị định' },
  });
  const waived = ledger.find((r) => r.id === 'CXN-12');
  assert.deepEqual([waived.status, waived.waived_by, waived.waived_at, waived.waiver_reason], ['WAIVED', 'Chủ nghiệp vụ vốn', '2026-11-02', 'Rủi ro được chấp nhận đến khi có nghị định']);
  assert.equal('waived_by' in ledger.find((r) => r.id === 'CXN-03'), false);
  assert.equal(buildLedger(markers, { 'CXN-12': { status: 'WAIVED' } }).find((r) => r.id === 'CXN-12').waived_by, null);
});

test('a CONFIRMED entry without evidence and confirmer is rejected as an invalid confirmation', () => {
  const markers = extractMarkers(SPEC_B, 'DIS.md');
  const ledger = buildLedger(markers, { 'CXN-12': { status: 'CONFIRMED' } });
  assert.equal(ledger.find((r) => r.id === 'CXN-12').status, 'INVALID_CONFIRMATION');
});

test('checkLedgerMarkers reports markers without an id', () => {
  const findings = checkLedgerMarkers(extractMarkers(SPEC_A, 'PAY.md'));
  assert.deepEqual(findings.map((f) => f.code), ['CXN_MARKER_WITHOUT_ID']);
  assert.deepEqual(findings[0].params, { file: 'PAY.md', line: 4 });
});

test('the CLI writes the ledger JSON from spec files and keeps register entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'machvon-ledger-'));
  const specs = join(root, 'specs');
  const eng = join(root, 'eng');
  mkdirSync(specs);
  mkdirSync(eng);
  writeFileSync(join(specs, 'PAY.md'), SPEC_A);
  writeFileSync(join(specs, 'DIS.md'), SPEC_B);
  writeFileSync(join(specs, '_KHUNG.md'), 'ignored [CXN-99]');
  writeFileSync(join(eng, 'legal_confirmation_register.json'), JSON.stringify({ 'CXN-03': { owner: 'Pháp chế' } }));
  const log = [];
  const code = ledgerMain(['--specs', specs, '--dir', eng, '--locale', 'en'], (line) => log.push(line));
  assert.equal(code, 1, 'a marker without an id is an error');
  const ledger = JSON.parse(readFileSync(join(eng, 'legal_confirmation_ledger.json'), 'utf8'));
  assert.deepEqual(ledger.map((r) => r.id), ['CXN-03', 'CXN-04', 'CXN-12', 'CXN-31']);
  assert.ok(log.some((line) => /PAY\.md/.test(line)));
});

test('extractMarkers accepts ids with letter segments and lists of mixed ids', () => {
  const text = 'Tổ chức [CXN-ORG-01] và dữ liệu cá nhân [CXN-PDP-01, CXN-PDP-02]; hóa đơn [CXN-INV-01] cùng [CXN-12].';
  assert.deepEqual(extractMarkers(text, 'IAM.md').map((m) => m.id), ['CXN-ORG-01', 'CXN-PDP-01', 'CXN-PDP-02', 'CXN-INV-01', 'CXN-12']);
});

test('buildLedger sorts numeric and lettered ids together deterministically', () => {
  const markers = extractMarkers('[CXN-ORG-01] [CXN-12] [CXN-03] [CXN-INV-02] [CXN-INV-01]', 'X.md');
  assert.deepEqual(buildLedger(markers, {}).map((r) => r.id), ['CXN-03', 'CXN-12', 'CXN-INV-01', 'CXN-INV-02', 'CXN-ORG-01']);
});
