import { CONTRACTOR_EXPORT_COLUMNS, MAX_PERIOD_DAYS, assertExportRequest, assertSubmission, buildContractorExport } from '../src/ctr-export';
import type { ContractorExportColumn, ContractorExportRecord } from '../src/ctr-export';

type Cells = Partial<Record<Exclude<ContractorExportColumn, 'record_type'>, string>>;

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const REQUEST = { scope: 'BOTH', period_from: '2026-07-01', period_to: '2026-09-30', format: 'CSV' };
const evaluation = (sort: string, overrides: Cells & { contractId?: string } = {}): ContractorExportRecord => ({
  record_type: 'EVALUATION',
  contractId: 'contract-1',
  sort,
  contractor_tax_identifier: '0100100100',
  contractor_name: 'Công ty Cầu Đường 5',
  contract_code: 'HD-A-001',
  evaluation_kind: 'PERIODIC',
  period_label: '2026-Q3',
  revision: '1',
  score_quality: '80',
  score_schedule: '70',
  score_safety_env: '90',
  score_cooperation: '60',
  score_financial: '100',
  overall_score: '80.50',
  rating: 'GOOD',
  approved_on: '2026-09-15',
  ...overrides,
});
const violation = (sort: string, overrides: Cells & { contractId?: string } = {}): ContractorExportRecord => ({
  record_type: 'VIOLATION',
  contractId: 'contract-1',
  sort,
  contractor_tax_identifier: '0100100100',
  contractor_name: 'Công ty Cầu Đường 5',
  contract_code: 'HD-A-001',
  violation_kind: 'DELAY',
  severity: 'MAJOR',
  occurred_on: '2026-09-01',
  penalty_kind: 'LIQUIDATED_DAMAGES',
  penalty_amount_vnd: '150000000',
  decision_document_version_id: '00000000-0000-4000-8000-0000000000d1',
  confirmed_on: '2026-09-20',
  ...overrides,
});
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

describe('the export of the records of the contractors (ST-CTR-015, UAT-AC315, UAT-PLAN-18, CXN-EXE-01)', () => {
  it('takes a scope, a period of days that is not backwards, and a format', () => {
    expect(assertExportRequest(REQUEST)).toEqual({ scope: 'BOTH', periodFrom: '2026-07-01', periodTo: '2026-09-30', format: 'CSV' });
    expect(assertExportRequest({ ...REQUEST, period_to: '2026-07-01', scope: 'VIOLATION', format: 'JSON' })).toMatchObject({ scope: 'VIOLATION', format: 'JSON', periodTo: '2026-07-01' });
    expect(refusal(() => assertExportRequest({ ...REQUEST, scope: 'ALL' })).detail).toBe('scope');
    expect(refusal(() => assertExportRequest({ ...REQUEST, format: 'XLSX' })).detail).toBe('format');
    for (const period_from of [undefined, '2026-02-30', '01/07/2026']) expect(refusal(() => assertExportRequest({ ...REQUEST, period_from })).detail).toBe('period_from');
    expect(refusal(() => assertExportRequest({ ...REQUEST, period_to: '2026-06-30' })).detail).toBe('period_to');
    expect(refusal(() => assertExportRequest({ ...REQUEST, period_to: 'x' })).detail).toBe('period_to');
    expect(MAX_PERIOD_DAYS).toBe(1830);
    expect(refusal(() => assertExportRequest({ ...REQUEST, period_from: '2020-01-01', period_to: '2026-01-01' })).detail).toBe('period_to');
    expect(assertExportRequest({ ...REQUEST, period_from: '2021-10-01', period_to: '2026-09-30' }).periodFrom).toBe('2021-10-01');
  });

  it('takes the receipt of a submission made by hand: a number, and a day that is not after today', () => {
    expect(assertSubmission({ submitted_ref: '  QG-2026-0001  ', submitted_on: '2026-10-01' }, '2026-10-30')).toEqual({ ref: 'QG-2026-0001', on: '2026-10-01' });
    expect(assertSubmission({ submitted_ref: 'A', submitted_on: '2026-10-30' }, '2026-10-30').on).toBe('2026-10-30');
    for (const submitted_ref of [undefined, '', '   ', 'x'.repeat(101), 5]) expect(refusal(() => assertSubmission({ submitted_ref, submitted_on: '2026-10-01' }, '2026-10-30')).detail).toBe('submitted_ref');
    expect(refusal(() => assertSubmission({ submitted_ref: 'A', submitted_on: '2026-10-31' }, '2026-10-30')).detail).toBe('submitted_on');
    expect(refusal(() => assertSubmission({ submitted_ref: 'A', submitted_on: '2026-13-01' }, '2026-10-30')).detail).toBe('submitted_on');
  });

  it('writes the same bytes, and so the same hash, for the same records in whatever order they come, and another hash for another record', () => {
    const records = [violation('2|b'), evaluation('1|a'), evaluation('1|c', { period_label: '2026-Q4' })];
    const first = buildContractorExport(records, 'CSV');
    const second = buildContractorExport([...records].reverse(), 'CSV');
    expect(second.sha256).toBe(first.sha256);
    expect(text(second.bytes)).toBe(text(first.bytes));
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.rows).toBe(3);
    expect(buildContractorExport([...records, evaluation('1|d')], 'CSV').sha256).not.toBe(first.sha256);
    expect(buildContractorExport(records, 'JSON').sha256).not.toBe(first.sha256);
  });

  it('names the contracts a file covers, each once and in order, whatever the order of the rows, and not in the bytes of the file', () => {
    const records = [violation('2|b', { contractId: 'contract-2' }), evaluation('1|a'), evaluation('1|c', { contractId: 'contract-2' })];
    expect(buildContractorExport(records, 'CSV').contractIds).toEqual(['contract-1', 'contract-2']);
    expect(buildContractorExport([...records].reverse(), 'JSON').contractIds).toEqual(['contract-1', 'contract-2']);
    expect(buildContractorExport(records, 'CSV').sha256).toBe(buildContractorExport(records.map((record) => ({ ...record, contractId: 'other' })), 'CSV').sha256);
  });

  it('writes a CSV with a byte-order mark, CRLF lines, the columns of the map in order, the evaluations before the violations, and the cells that do not apply empty', () => {
    const file = buildContractorExport([violation('2|b'), evaluation('1|a')], 'CSV');
    expect(file.contentType).toBe('text/csv');
    const lines = text(file.bytes).replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(CONTRACTOR_EXPORT_COLUMNS.join(','));
    expect(lines[1]?.split(',').slice(0, 6)).toEqual(['EVALUATION', '0100100100', 'Công ty Cầu Đường 5', 'HD-A-001', 'PERIODIC', '2026-Q3']);
    expect(lines[1]).toContain(',80.50,GOOD,2026-09-15,,,,,,,');
    expect(lines[2]?.startsWith('VIOLATION,')).toBe(true);
    expect(lines[2]).toContain('DELAY,MAJOR,2026-09-01,LIQUIDATED_DAMAGES,150000000,00000000-0000-4000-8000-0000000000d1,2026-09-20');
    expect(lines[3]).toBe('');
    expect(text(file.bytes).startsWith('\uFEFF')).toBe(true);
  });

  it('quotes what a comma or a quotation mark would break, and never lets a spreadsheet read a name as a formula', () => {
    const file = buildContractorExport([evaluation('1|a', { contractor_name: 'Liên danh "A, B"' }), evaluation('1|b', { contractor_name: '=HYPERLINK("http://x")' }), evaluation('1|c', { contractor_name: '-1+1' })], 'CSV');
    const body = text(file.bytes);
    expect(body).toContain('"Liên danh ""A, B"""');
    expect(body).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(body).toContain(",'-1+1,");
  });

  it('writes a JSON list of objects that carry only the columns that apply, and says how many rows there are', () => {
    const file = buildContractorExport([violation('2|b'), evaluation('1|a')], 'JSON');
    expect(file.contentType).toBe('application/json');
    const parsed = JSON.parse(text(file.bytes)) as Array<Record<string, string>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ record_type: 'EVALUATION', overall_score: '80.50', rating: 'GOOD' });
    expect(parsed[0]).not.toHaveProperty('severity');
    expect(parsed[1]).toMatchObject({ record_type: 'VIOLATION', severity: 'MAJOR', penalty_amount_vnd: '150000000' });
    expect(parsed[1]).not.toHaveProperty('score_quality');
    expect(parsed[0]).not.toHaveProperty('sort');
    expect(file.rows).toBe(2);
  });
});
