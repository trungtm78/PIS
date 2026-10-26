import type { DomainError } from '../src/errors.ts';
import { IMPORT_FAULTS, REQUIRED_COLUMNS, faultedRowsOf, mappingOf, parseReportImport } from '../src/dis-import.ts';
import type { TabularFile } from '../src/tabular-file.ts';

const HEADERS = ['project_code', 'cy_central', 'cy_central_ctmtqg', 'cy_local', 'cy_local_ctmtqg', 'co_central', 'co_central_ctmtqg', 'co_local', 'co_local_ctmtqg', 'other_central', 'other_local', 'total_cumulative_vnd', 'construction_vnd', 'acceptance_vnd', 'treasury_submitted_vnd', 'preparing_dossier_vnd', 'physical_progress_pct', 'negative_delta_explanation'];

/** FX-DIS-001: 100/200/30/70/0/20 million and 40 million of CTMTQG in the year plan of the central budget. */
const fx = (code: string, over: Record<string, string> = {}): string[] => {
  const base: Record<string, string> = {
    project_code: code,
    cy_central: '100000000',
    cy_central_ctmtqg: '40000000',
    cy_local: '200000000',
    cy_local_ctmtqg: '',
    co_central: '30000000',
    co_central_ctmtqg: '',
    co_local: '70000000',
    co_local_ctmtqg: '',
    other_central: '0',
    other_local: '20000000',
    total_cumulative_vnd: '420000000',
    construction_vnd: '',
    acceptance_vnd: '',
    treasury_submitted_vnd: '',
    preparing_dossier_vnd: '',
    physical_progress_pct: '',
    negative_delta_explanation: '',
    ...over,
  };
  return HEADERS.map((header) => base[header] as string);
};
const file = (rows: string[][], headers: string[] = HEADERS): TabularFile => ({ format: 'XLSX', headers, rows, lines: rows.map((_, index) => index + 2) });
const faultsOf = (rows: string[][]) => parseReportImport('DIS-WEEKLY-1', file(rows)).faults.map((fault) => [fault.line, fault.projectCode, fault.field, fault.code]);

describe('the weekly report workbook (ST-DIS-008, mapping DIS-WEEKLY-1)', () => {
  it('reads a row that is in order into the six cells of the form, the CTMTQG inside the four sources that have it', () => {
    const parsed = parseReportImport('DIS-WEEKLY-1', file([fx('DA-001')]));
    expect(parsed).toMatchObject({ totalRows: 1, faults: [] });
    const row = parsed.rows[0];
    expect(row).toMatchObject({ line: 2, projectCode: 'DA-001', progress: undefined, explanation: null });
    expect(row?.cells.map((cell) => [cell.bucket, cell.budgetLevel, cell.cumulativeVnd, cell.ctmtqgVnd])).toEqual([
      ['CURRENT_YEAR', 'CENTRAL', '100000000', '40000000'],
      ['CURRENT_YEAR', 'LOCAL', '200000000', null],
      ['CARRYOVER', 'CENTRAL', '30000000', null],
      ['CARRYOVER', 'LOCAL', '70000000', null],
      ['OTHER', 'CENTRAL', '0', null],
      ['OTHER', 'LOCAL', '20000000', null],
    ]);
  });

  it('reads the volumes when they are given together, the explanation of a fall, and the column names whatever their case', () => {
    const headers = HEADERS.map((header) => (header === 'project_code' ? ' Project_Code ' : header));
    const parsed = parseReportImport(
      'DIS-WEEKLY-1',
      file([fx('DA-001', { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5', negative_delta_explanation: 'The payment was returned.' })], headers),
    );
    expect(parsed.faults).toEqual([]);
    expect(parsed.rows[0]?.progress).toMatchObject({ constructionVnd: '300000000', physicalProgressPct: '37.50' });
    expect(parsed.rows[0]?.explanation).toBe('The payment was returned.');
  });

  it('AC-ST-DIS-008-1 / UAT-AC258: tells the row of a CTMTQG above its cell (SUBSET_EXCEEDS_PARENT) and the row that is not an amount, at their lines and columns, and still returns the 18 others', () => {
    const rows = Array.from({ length: 20 }, (_, index) => fx(`DA-${String(index + 1).padStart(3, '0')}`));
    rows[8] = fx('DA-009', { cy_central_ctmtqg: '150000000' });
    rows[4] = fx('DA-005', { cy_local: 'abc', total_cumulative_vnd: '' });
    const parsed = parseReportImport('DIS-WEEKLY-1', file(rows));
    expect(parsed.faults.map((fault) => [fault.line, fault.projectCode, fault.field, fault.code])).toEqual([
      [6, 'DA-005', 'cy_local', IMPORT_FAULTS.amountInvalid],
      [10, 'DA-009', 'cy_central_ctmtqg', IMPORT_FAULTS.subsetExceeds],
    ]);
    expect(parsed.totalRows).toBe(20);
    expect(parsed.rows).toHaveLength(18);
    expect(faultedRowsOf(parsed.faults)).toBe(2);
  });

  it('AC-ST-DIS-008-2 / DQ01: a project named twice is refused in both rows (it is not told which one is meant), an amount that does not agree with the total column too, and a row with no project', () => {
    expect(faultsOf([fx('DA-001'), fx('DA-002'), fx('DA-001', { cy_local: '1' , total_cumulative_vnd: '220000001' })])).toEqual([
      [2, 'DA-001', 'project_code', IMPORT_FAULTS.projectDuplicate],
      [4, 'DA-001', 'project_code', IMPORT_FAULTS.projectDuplicate],
    ]);
    expect(faultsOf([fx('DA-001', { total_cumulative_vnd: '419999999' })])).toEqual([[2, 'DA-001', 'total_cumulative_vnd', IMPORT_FAULTS.totalMismatch]]);
    expect(faultsOf([fx('')])).toEqual([[2, null, 'project_code', IMPORT_FAULTS.projectRequired]]);
    // The total column is optional.
    expect(faultsOf([fx('DA-001', { total_cumulative_vnd: '' })])).toEqual([]);
  });

  it('puts every fault of a row, not the first: a row can be wrong in several columns, and it counts as one row', () => {
    const parsed = parseReportImport('DIS-WEEKLY-1', file([fx('DA-001', { cy_central: '-1', co_central_ctmtqg: '99999999999', construction_vnd: '100', negative_delta_explanation: 'short' })]));
    expect(parsed.faults.map((fault) => [fault.field, fault.code])).toEqual([
      ['cy_central', IMPORT_FAULTS.amountInvalid],
      ['co_central_ctmtqg', IMPORT_FAULTS.subsetExceeds],
      ['acceptance_vnd', IMPORT_FAULTS.volumesInvalid],
      ['negative_delta_explanation', IMPORT_FAULTS.explanationInvalid],
    ]);
    expect(faultedRowsOf(parsed.faults)).toBe(1);
    expect(parsed.rows).toEqual([]);
  });

  it('refuses a file that lacks a column of the layout (422 IMPORT_SCHEMA_INVALID naming them) and a layout that is not known (422 MAPPING_VERSION_UNKNOWN)', () => {
    const lacking = (): void => void parseReportImport('DIS-WEEKLY-1', file([], HEADERS.filter((header) => header !== 'cy_local' && header !== 'other_local')));
    try {
      lacking();
      throw new Error('expected a refusal');
    } catch (error) {
      const e = error as DomainError;
      expect([e.code, e.status, e.detail, e.extensions]).toEqual(['IMPORT_SCHEMA_INVALID', 422, 'file', { missing_columns: ['cy_local', 'other_local'] }]);
    }
    expect(() => mappingOf('DIS-WEEKLY-9')).toThrow(expect.objectContaining({ code: 'MAPPING_VERSION_UNKNOWN', status: 422, detail: 'mapping_version' }));
    expect(() => parseReportImport('', file([]))).toThrow(expect.objectContaining({ code: 'MAPPING_VERSION_UNKNOWN' }));
    expect(REQUIRED_COLUMNS).toHaveLength(7);
  });

  it('keeps the line of the source of each row (a blank line is counted, not read) and reads an empty file as no rows', () => {
    const table: TabularFile = { format: 'CSV', headers: HEADERS, rows: [fx('DA-001'), fx('DA-002', { cy_local: 'x' })], lines: [2, 7] };
    expect(parseReportImport('DIS-WEEKLY-1', table).faults).toMatchObject([{ line: 7, projectCode: 'DA-002', field: 'cy_local' }]);
    expect(parseReportImport('DIS-WEEKLY-1', file([]))).toEqual({ totalRows: 0, rows: [], faults: [] });
  });
});
