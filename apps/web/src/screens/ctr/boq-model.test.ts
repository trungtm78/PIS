import { webcrypto } from 'node:crypto';
import { createHash } from 'node:crypto';
import { ApiError } from '@machvon/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES, MAX_IMPORT_LINES, boqLink, decimalText, describeImportProblem, linesOf, parseBoqCsv, prepareFile, reconcile, sha256Hex, toBoqLine, toImportResult, totalOf } from './boq-model';
import type { BoqLine } from './boq-model';

const HEADER = 'business_key,description,unit_code,quantity,unit_price';
const BOM = String.fromCharCode(0xfeff);
const rawLine = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `id-${n}`,
  contract_id: 'c1',
  contract_revision_id: 'r1',
  revision: 1,
  revision_status: 'DRAFT',
  line_no: n,
  business_key: `B0${n}`,
  description: `Item ${n}`,
  unit_code: 'M3',
  quantity: '3',
  unit_price: '1234.5',
  rounding_rule: 'HALF_UP',
  amount_vnd: '3704',
  retention_pct: '5.0000',
  milestone_code: null,
  milestone_due_on: null,
  party_name: null,
  ...overrides,
});
const file = (name: string, content: string | Uint8Array<ArrayBuffer>): File => new File([content], name, { type: 'text/csv' });

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the lines of a BOQ as the server answers them', () => {
  it('reads a line with its figures as exact strings and refuses an answer that is not a line', () => {
    expect(toBoqLine(rawLine(1, { milestone_code: 'M-1', milestone_due_on: '2026-12-31', party_name: 'Liên danh' }))).toEqual({
      id: 'id-1',
      contractId: 'c1',
      revisionId: 'r1',
      revision: 1,
      revisionStatus: 'DRAFT',
      lineNo: 1,
      businessKey: 'B01',
      description: 'Item 1',
      unitCode: 'M3',
      quantity: '3',
      unitPrice: '1234.5',
      roundingRule: 'HALF_UP',
      amountVnd: '3704',
      retentionPct: '5.0000',
      milestoneCode: 'M-1',
      milestoneDueOn: '2026-12-31',
      partyName: 'Liên danh',
    });
    expect(toBoqLine(rawLine(1, { rounding_rule: 'CEILING' }))).toBeUndefined();
    expect(toBoqLine(rawLine(1, { line_no: 'one' }))).toBeUndefined();
    expect(toBoqLine({ id: 'x' })).toBeUndefined();
    expect(toBoqLine('line')).toBeUndefined();
    expect(toBoqLine([])).toBeUndefined();
    expect(toBoqLine({ id: 'x', contract_revision_id: 'r', business_key: 'k', amount_vnd: '1', rounding_rule: 'UP', line_no: 1 })).toMatchObject({ contractId: '', description: '', quantity: '0', retentionPct: '0', revision: 0 });
  });

  it('picks the lines of one revision in the order of their numbers and adds their amounts exactly', () => {
    const lines = [rawLine(2, { amount_vnd: '99999999999999999999' }), rawLine(1), rawLine(3, { contract_revision_id: 'r2' })].flatMap((raw) => toBoqLine(raw) ?? []);
    expect(linesOf(lines, 'r1').map((line) => line.businessKey)).toEqual(['B01', 'B02']);
    expect(totalOf(linesOf(lines, 'r1'))).toBe('100000000000000003703');
    expect(totalOf([])).toBe('0');
    expect(totalOf([{ amountVnd: 'x' } as BoqLine])).toBe('0');
  });

  it('reconciles the amount of a revision with its lines in exact arithmetic, and says what it cannot judge', () => {
    expect(reconcile('3704', '3704', 1)).toEqual({ revisionAmount: '3704', linesTotal: '3704', difference: '0', lineCount: 1, matches: true });
    expect(reconcile('3704', '3703', 1)).toMatchObject({ difference: '-1', matches: false });
    expect(reconcile('3704', '3705', 2)).toMatchObject({ difference: '1', matches: false });
    expect(reconcile('3704', '0', 0)).toMatchObject({ difference: '-3704', matches: false });
    expect(reconcile('0', '0', 0)).toMatchObject({ matches: false });
    expect(reconcile('99999999999999999999', '99999999999999999998', 3)?.difference).toBe('-1');
    expect(reconcile('1.5', '1', 1)).toBeUndefined();
    expect(reconcile('1', 'x', 1)).toBeUndefined();
  });

  it('writes a decimal in the language of the screen without turning it into a float', () => {
    expect(decimalText('1234.5', 'vi')).toBe('1.234,5');
    expect(decimalText('1234.5', 'en')).toBe('1,234.5');
    expect(decimalText('3', 'vi')).toBe('3');
    expect(decimalText('0.000001', 'en')).toBe('0.000001');
    expect(decimalText('12345678901234567890.25', 'en')).toBe('12,345,678,901,234,567,890.25');
    expect(decimalText('1.x', 'en')).toBe('1');
  });

  it('links to the BOQ of a contract and of one of its revisions', () => {
    expect(boqLink('a b')).toBe('/ctr/ctr-04?id=a+b');
    expect(boqLink('c1', 'r1')).toBe('/ctr/ctr-04?id=c1&revision=r1');
  });
});

describe('reading a BOQ file', () => {
  it('reads the lines of a CSV file with the columns it names, leaving out the empty cells', () => {
    const parsed = parseBoqCsv(`${HEADER},rounding_rule,retention_pct\nB01,"Excavation, deep",M3,3,1234.5,DOWN,\nB02,Concrete,M3,2,500,,7.5\n`);
    expect(parsed).toEqual({
      ok: true,
      lines: [
        { business_key: 'B01', description: 'Excavation, deep', unit_code: 'M3', quantity: '3', unit_price: '1234.5', rounding_rule: 'DOWN' },
        { business_key: 'B02', description: 'Concrete', unit_code: 'M3', quantity: '2', unit_price: '500', retention_pct: '7.5' },
      ],
    });
  });

  it('takes a byte order mark, a semicolon or tab delimiter, CRLF, doubled quotes, a quoted line break and blank lines', () => {
    const semicolon = parseBoqCsv(`${BOM}${HEADER.replaceAll(',', ';')}\r\n\r\nB01;"Say ""hi""";M3;1;10\r\n`);
    expect(semicolon).toEqual({ ok: true, lines: [{ business_key: 'B01', description: 'Say "hi"', unit_code: 'M3', quantity: '1', unit_price: '10' }] });
    const tab = parseBoqCsv(`${HEADER.replaceAll(',', '\t')}\nB01\t"two\nlines"\tM3\t1\t10`);
    expect(tab).toEqual({ ok: true, lines: [{ business_key: 'B01', description: 'two\nlines', unit_code: 'M3', quantity: '1', unit_price: '10' }] });
    const mac = parseBoqCsv(`${HEADER}\rB01,x,M3,1,10\r`);
    expect(mac).toMatchObject({ ok: true });
    expect(parseBoqCsv(`${HEADER}\nB01,"",M3,1,10`)).toEqual({ ok: true, lines: [{ business_key: 'B01', unit_code: 'M3', quantity: '1', unit_price: '10' }] });
  });

  it('names what is wrong with a file that is not a BOQ', () => {
    expect(parseBoqCsv('')).toEqual({ ok: false, problem: 'empty' });
    expect(parseBoqCsv(HEADER)).toEqual({ ok: false, problem: 'empty' });
    expect(parseBoqCsv(`${HEADER},tax_identifier\nB01,x,M3,1,10,0123`)).toEqual({ ok: false, problem: 'unknownColumn', column: 'tax_identifier' });
    expect(parseBoqCsv('business_key,description,unit_code,quantity\nB01,x,M3,1')).toEqual({ ok: false, problem: 'missingColumn', column: 'unit_price' });
    expect(parseBoqCsv(`${HEADER}\nB01,"never closed,M3,1,10`)).toEqual({ ok: false, problem: 'unreadable' });
    const many = Array.from({ length: MAX_IMPORT_LINES + 1 }, (_unused, index) => `B${index},x,M3,1,10`).join('\n');
    expect(parseBoqCsv(`${HEADER}\n${many}`)).toEqual({ ok: false, problem: 'tooMany' });
    const exact = Array.from({ length: MAX_IMPORT_LINES }, (_unused, index) => `B${index},x,M3,1,10`).join('\n');
    expect(parseBoqCsv(`${HEADER}\n${exact}`)).toMatchObject({ ok: true });
  });
});

describe('preparing a chosen file', () => {
  const content = `${HEADER}\nB01,Excavation,M3,3,1234.5\n`;

  it('gives the body of the import with the SHA-256 of the file as it is and the lines it holds', async () => {
    const prepared = await prepareFile(file('boq.csv', content), 'APPEND');
    expect(prepared).toEqual({
      body: { mode: 'APPEND', file_sha256: createHash('sha256').update(content).digest('hex'), lines: [{ business_key: 'B01', description: 'Excavation', unit_code: 'M3', quantity: '3', unit_price: '1234.5' }] },
      problem: undefined,
      column: undefined,
      lineCount: 1,
    });
  });

  it('hashes the bytes of a file with a byte order mark, which the lines do not show', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(content)]);
    const prepared = await prepareFile(file('boq.csv', bytes), 'REPLACE');
    expect(prepared.body?.file_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(prepared.body?.lines).toHaveLength(1);
  });

  it('refuses what the screen can see is unusable: the name, the size, bytes that are not UTF-8, and a file that is not a BOQ', async () => {
    expect(await prepareFile(file('boq.xlsx', content), 'REPLACE')).toMatchObject({ body: undefined, problem: 'notCsv' });
    const big = file('boq.csv', content);
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    expect(await prepareFile(big, 'REPLACE')).toMatchObject({ problem: 'tooLarge' });
    expect(await prepareFile(file('boq.csv', Uint8Array.from([0xff, 0xfe, 0x00])), 'REPLACE')).toMatchObject({ problem: 'unreadable' });
    expect(await prepareFile(file('boq.csv', `${HEADER},nope\nB01,x,M3,1,1,2`), 'REPLACE')).toMatchObject({ problem: 'unknownColumn', column: 'nope' });
    expect(await prepareFile({ name: 'boq.csv', size: 10 } as File, 'REPLACE')).toMatchObject({ problem: 'unreadable' });
    expect(await prepareFile(file('BOQ.TXT', content), 'REPLACE')).toMatchObject({ problem: undefined });
  });

  it('hashes bytes as lower-case hex', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('what the import answers', () => {
  it('reads the figures of an import and refuses an answer without them', () => {
    expect(
      toImportResult({ import_id: 'i1', duplicate: false, lines_imported: 2, items_created: 1, retention_defaulted: 2, lines_total_vnd: '3704', revision_amount_vnd: '3704', difference_vnd: '0', balanced: true }),
    ).toEqual({ importId: 'i1', duplicate: false, linesImported: 2, itemsCreated: 1, retentionDefaulted: 2, linesTotal: '3704', revisionAmount: '3704', difference: '0', balanced: true });
    expect(toImportResult({ import_id: 'i1', lines_total_vnd: '1', revision_amount_vnd: '1', difference_vnd: '0' })).toMatchObject({ duplicate: false, linesImported: 0, balanced: false });
    expect(toImportResult({ resource_id: 'r' })).toBeUndefined();
    expect(toImportResult('no')).toBeUndefined();
  });

  const refused = (code: string, status: number, detail?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', detail, extensions });

  it('lists the faults of the rows when the server did, with the count of the rows', () => {
    const problem = describeImportProblem(
      refused('VALIDATION_FAILED', 422, 'lines', { errors: [{ row: 1, field: 'quantity', reason: 'invalidNumber' }, { row: 0, field: 'tax', reason: 'notAllowed' }, { row: 'x' }, 7], error_rows: 4 }),
    );
    expect(problem).toMatchObject({
      reason: 'rows',
      faultRows: 4,
      faults: [
        { row: 1, field: 'quantity', reason: 'invalidNumber' },
        { row: 0, field: 'tax', reason: 'notAllowed' },
      ],
    });
    expect(describeImportProblem(refused('VALIDATION_FAILED', 422, 'mode'))).toMatchObject({ reason: 'validation', field: 'mode', faults: [], faultRows: 0 });
  });

  it.each([
    ['BOQ_TOTAL_MISMATCH', 'totalMismatch'],
    ['BOQ_LINE_DUPLICATE', 'duplicate'],
    ['REVISION_NOT_DRAFT', 'notDraft'],
    ['CONTRACT_STATE_INVALID', 'stateInvalid'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['FILE_NOT_CLEAN', 'fileNotClean'],
    ['FILE_TYPE_NOT_ALLOWED', 'fileType'],
    ['PAYLOAD_TOO_LARGE', 'tooLarge'],
    ['FIELD_NOT_ALLOWED', 'validation'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeImportProblem(refused(code, 422)).reason).toBe(reason);
  });

  it('carries the figures of a total that does not match, and the rows of a repeated key', () => {
    expect(describeImportProblem(refused('BOQ_TOTAL_MISMATCH', 422, 'lines', { lines_total_vnd: '1001', revision_amount_vnd: '1000', difference_vnd: '1' })).figures).toEqual({ linesTotal: '1001', revisionAmount: '1000', difference: '1' });
    expect(describeImportProblem(refused('BOQ_TOTAL_MISMATCH', 422)).figures).toBeUndefined();
    expect(describeImportProblem(refused('BOQ_LINE_DUPLICATE', 409, 'lines', { rows: [2, 'x', 5] })).duplicateRows).toEqual([2, 5]);
    expect(describeImportProblem(new Error('network'))).toMatchObject({ reason: 'general', faults: [] });
  });
});
