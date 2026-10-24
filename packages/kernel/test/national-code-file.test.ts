import { DomainError } from '../src/errors';
import { planFileImport } from '../src/file-import';
import { NATIONAL_CODE_ADAPTER_STATUS, NATIONAL_CODE_CONNECTOR, NATIONAL_CODE_FORMAT_VERSION, nationalCodeFileFormat } from '../src/national-code-file';

const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

function refusal(work: () => unknown): { code: string; status: number; detail?: string | undefined } {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, detail: error.detail };
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('the file of the national project codes (ST-PRJ-004, working assumption of the layout)', () => {
  it('names the connector of the baseline, a layout version that says it is an assumption, and the adapter status PROPOSED', () => {
    expect(nationalCodeFileFormat.connectorCode).toBe(NATIONAL_CODE_CONNECTOR);
    expect(NATIONAL_CODE_CONNECTOR).toBe('NATIONAL_PIM_FILE');
    expect(nationalCodeFileFormat.formatVersion).toBe(NATIONAL_CODE_FORMAT_VERSION);
    expect(NATIONAL_CODE_FORMAT_VERSION).toContain('ASSUMPTION');
    expect(NATIONAL_CODE_ADAPTER_STATUS).toBe('PROPOSED');
  });

  it('AC-ST-PRJ-004-2: three rows with one national code twice give two valid rows and NATIONAL_CODE_DUPLICATE on the later one', () => {
    const plan = planFileImport(nationalCodeFileFormat, csv('internal_code,national_project_code', 'DA-001,7000001', 'DA-002,7000002', 'DA-003,7000001'));
    expect(plan.rows.map((row) => [row.line, row.accepted, row.accepted ? row.row.businessKey : row.rejection.code])).toEqual([
      [2, true, 'DA-001'],
      [3, true, 'DA-002'],
      [4, false, 'NATIONAL_CODE_DUPLICATE'],
    ]);
    const refused = plan.rows[2];
    expect(refused?.accepted === false && refused.rejection).toEqual({ code: 'NATIONAL_CODE_DUPLICATE', field: 'national_project_code' });
    expect(refused?.accepted === false && refused.businessKey).toBe('DA-003');
    expect(refused?.accepted === false && refused.preview).toEqual({ internal_code: 'DA-003', national_project_code: '7000001' });
  });

  it('reads the headers without regard to case and space, a semicolon file, and ignores the columns it does not know', () => {
    const plan = planFileImport(nationalCodeFileFormat, csv(' Internal_Code ; NATIONAL_PROJECT_CODE ;Ten du an', 'DA-001; 7000001 ;Cầu', 'DA-002;7000002;Đường'));
    expect(plan.rows.map((row) => row.accepted && row.row.fields)).toEqual([
      { internal_code: 'DA-001', national_project_code: '7000001' },
      { internal_code: 'DA-002', national_project_code: '7000002' },
    ]);
    expect(plan.rows[0]?.accepted && plan.rows[0].row.record).toEqual({ internalCode: 'DA-001', nationalCode: '7000001' });
  });

  it('refuses a file that lacks one of the two columns as IMPORT_SCHEMA_INVALID, and one with no row as IMPORT_EMPTY', () => {
    expect(refusal(() => planFileImport(nationalCodeFileFormat, csv('internal_code,name', 'DA-001,Cầu')))).toEqual({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'file' });
    expect(refusal(() => planFileImport(nationalCodeFileFormat, csv('national_project_code,name', '7000001,Cầu')))).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID' });
    expect(refusal(() => planFileImport(nationalCodeFileFormat, csv('internal_code,national_project_code')))).toMatchObject({ code: 'IMPORT_EMPTY', status: 422 });
  });

  it('judges a row by its cells: empty cells, a code that is too long, a code with a control character', () => {
    const long = 'X'.repeat(51);
    const plan = planFileImport(nationalCodeFileFormat, csv('internal_code,national_project_code', ',7000001', 'DA-002,', `${long},7000003`, 'DA-004,7000004\u0007', `DA-005,${long}`, ' DA-006 , 7000006 '));
    expect(plan.rows.map((row) => (row.accepted ? ['OK', row.row.businessKey] : [row.rejection.code, row.rejection.field, row.businessKey]))).toEqual([
      ['INTERNAL_CODE_EMPTY', 'internal_code', null],
      ['NATIONAL_CODE_EMPTY', 'national_project_code', 'DA-002'],
      ['CODE_INVALID', 'internal_code', long],
      ['CODE_INVALID', 'national_project_code', 'DA-004'],
      ['CODE_INVALID', 'national_project_code', 'DA-005'],
      ['OK', 'DA-006'],
    ]);
  });

  it('keeps the first of two rows that repeat a code and refuses every later one, whatever the order of the keys', () => {
    const plan = planFileImport(nationalCodeFileFormat, csv('internal_code,national_project_code', 'DA-009,7000001', 'DA-001,7000001', 'DA-005,7000001'));
    expect(plan.rows.map((row) => row.accepted)).toEqual([true, false, false]);
  });
});
