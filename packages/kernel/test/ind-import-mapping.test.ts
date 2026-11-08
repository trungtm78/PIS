import { DomainError } from '../src/errors';
import { canonicalDecimal, defaultGovernanceRule, figureFitsUnit, importMappingOf, indicatorImportFormat, mappingFitsHeaders, missingHeaders, parseNumberCell, planFileImport, scaledFigure, validateRuleParams } from '../src/index';
import type { ImportMapping } from '../src/index';

const bytes = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const sample = (code: 'SAMPLE_COLUMNS_FORM' | 'SAMPLE_ROWS_FORM'): ImportMapping => importMappingOf(defaultGovernanceRule('INDICATOR_IMPORT_MAPPING', code) as NonNullable<ReturnType<typeof defaultGovernanceRule>>);
const failure = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('numbers of a sheet', () => {
  it('reads the plain and the Vietnamese spelling and refuses anything that is not a number', () => {
    expect(parseNumberCell('1234.50', 'PLAIN')).toBe('1234.5');
    expect(parseNumberCell('-0.0', 'PLAIN')).toBe('0');
    expect(parseNumberCell('007', 'PLAIN')).toBe('7');
    expect(parseNumberCell('1.2345E7', 'PLAIN')).toBe('12345000');
    expect(parseNumberCell('1.5e-3', 'PLAIN')).toBe('0.0015');
    expect(parseNumberCell('1,234.5', 'PLAIN')).toBeUndefined();
    expect(parseNumberCell('1.234.567,89', 'VN')).toBe('1234567.89');
    expect(parseNumberCell('1234,5', 'VN')).toBe('1234.5');
    expect(parseNumberCell('-1.000', 'VN')).toBe('-1000');
    expect(parseNumberCell('1.23.4', 'VN')).toBeUndefined();
    expect(parseNumberCell('12,5%', 'VN')).toBeUndefined();
    expect(parseNumberCell('1.2345E99', 'PLAIN')).toBeUndefined();
    expect(parseNumberCell('', 'VN')).toBeUndefined();
    expect(parseNumberCell('abc', 'PLAIN')).toBeUndefined();
    expect(canonicalDecimal('-000.500')).toBe('-0.5');
  });

  it('puts a figure in the unit the register keeps and refuses one that does not fit the column', () => {
    expect(scaledFigure('1234.5', 'MILLION')).toEqual({ ok: true, value: '1234500000' });
    expect(scaledFigure('1.5', 'BILLION')).toEqual({ ok: true, value: '1500000000' });
    expect(scaledFigure('0.0000001', 'ONE')).toEqual({ ok: false, code: 'NUMBER_TOO_PRECISE' });
    expect(scaledFigure('99999999999999999999', 'BILLION')).toEqual({ ok: false, code: 'NUMBER_TOO_PRECISE' });
    expect(figureFitsUnit('1500', 'VND')).toBe(true);
    expect(figureFitsUnit('1500.5', 'VND')).toBe(false);
    expect(figureFitsUnit('12.25', 'PERCENT')).toBe(true);
  });
});

describe('the format of a mapping, layout by columns', () => {
  const mapping = sample('SAMPLE_COLUMNS_FORM');
  const header = 'Mã dự án,Kỳ báo cáo,Tổng mức đầu tư,Vốn chủ sở hữu,Vốn vay,Tổng nguồn vốn,Lũy kế từ đầu năm';

  it('reads the sample mapping as a rule with a version and an origin', () => {
    expect(mapping).toMatchObject({ code: 'SAMPLE_COLUMNS_FORM', layout: 'COLUMNS', numberFormat: 'VN', origin: 'DEFAULT', unverified: true, version: 0 });
    expect(mapping.lines).toHaveLength(5);
    expect(mapping.lines[0]).toEqual({ indicator: 'TOTAL_INVESTMENT', source: 'Tổng mức đầu tư', scale: 'MILLION', required: false });
  });

  it('reads a file: one record for each row with the figures in dong', () => {
    const plan = planFileImport(indicatorImportFormat(mapping), bytes(header, 'DA-01,2026-10,"1.000,5","400","600,5","1.000,5",250', 'DA-02,2026-10,,,,,"12"'));
    expect(plan.rows).toHaveLength(2);
    const [first, second] = plan.rows;
    expect(first).toMatchObject({ accepted: true });
    if (first?.accepted !== true || second?.accepted !== true) throw new Error('both rows are accepted');
    expect(first.row.businessKey).toBe('DA-01|2026-10');
    expect(first.row.record.figures).toEqual([
      { indicator: 'TOTAL_INVESTMENT', value: '1000500000' },
      { indicator: 'EQUITY_CAPITAL', value: '400000000' },
      { indicator: 'LOAN_CAPITAL', value: '600500000' },
      { indicator: 'TOTAL_FUNDING', value: '1000500000' },
      { indicator: 'CUMULATIVE_YTD', value: '250000000' },
    ]);
    expect(second.row.record.figures).toEqual([{ indicator: 'CUMULATIVE_YTD', value: '12000000' }]);
    expect(plan.rows[0]?.line).toBe(2);
    expect(plan.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same plan for the same bytes and a different row hash when a figure changes', () => {
    const one = planFileImport(indicatorImportFormat(mapping), bytes(header, 'DA-01,2026-10,10,,,,'));
    const again = planFileImport(indicatorImportFormat(mapping), bytes(header, 'DA-01,2026-10,10,,,,'));
    const other = planFileImport(indicatorImportFormat(mapping), bytes(header, 'DA-01,2026-10,11,,,,'));
    expect(again).toEqual(one);
    expect(other.rows[0]).toMatchObject({ accepted: true });
    expect((other.rows[0] as { rowHash: string }).rowHash).not.toBe((one.rows[0] as { rowHash: string }).rowHash);
  });

  it('quarantines a row with the code and the field: the project, the period, a number, a row with nothing', () => {
    const plan = planFileImport(indicatorImportFormat(mapping), bytes(header, ',2026-10,1,,,,', 'DA-03,,1,,,,', 'DA-04,2026-10,1x,,,,', 'DA-05,2026-10,,,,,', 'DA-06,2026-10,"0,0000001",,,,'));
    const reasons = plan.rows.map((row) => (row.accepted ? 'OK' : `${row.rejection.code}:${row.rejection.field}`));
    expect(reasons).toEqual(['PROJECT_MISSING:project', 'PERIOD_MISSING:period', 'NUMBER_INVALID:TOTAL_INVESTMENT', 'ROW_EMPTY:row', 'OK']);
    // the last row says 0,0000001 million = 0.1 dong, which fits for the column; a number with too many places after scaling is refused
    const precise = planFileImport(indicatorImportFormat({ ...mapping, lines: mapping.lines.map((line) => ({ ...line, scale: 'ONE' as const })) }), bytes(header, 'DA-06,2026-10,"0,0000001",,,,'));
    expect(precise.rows[0]).toMatchObject({ accepted: false, rejection: { code: 'NUMBER_TOO_PRECISE', field: 'TOTAL_INVESTMENT' } });
  });

  it('takes the project and the period of the request when the form does not carry them, and refuses a row that says otherwise', () => {
    const bare: ImportMapping = { ...mapping, projectColumn: null, periodColumn: null };
    const header2 = 'Tổng mức đầu tư';
    const plan = planFileImport(indicatorImportFormat(bare, { projectCode: 'DA-01', periodCode: '2026-10' }), bytes(header2, '5'));
    expect((plan.rows[0] as { row: { businessKey: string } }).row.businessKey).toBe('DA-01|2026-10');
    expect(planFileImport(indicatorImportFormat(bare), bytes(header2, '5')).rows[0]).toMatchObject({ accepted: false, rejection: { code: 'PROJECT_MISSING' } });
    const clash = planFileImport(indicatorImportFormat(mapping, { projectCode: 'DA-09' }), bytes(header, 'DA-01,2026-10,5,,,,'));
    expect(clash.rows[0]).toMatchObject({ accepted: false, rejection: { code: 'PROJECT_MISMATCH' } });
  });

  it('refuses a file the mapping cannot read as a whole: a missing column, a repeated header, a file with nothing mapped', () => {
    const missing = failure(() => planFileImport(indicatorImportFormat(mapping), bytes('Mã dự án,Tổng mức đầu tư', 'DA-01,5')));
    expect(missing).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', status: 422 });
    expect(missing.extensions).toEqual({ missing_columns: ['Kỳ báo cáo'] });
    expect(failure(() => planFileImport(indicatorImportFormat(mapping), bytes('Mã dự án,Kỳ báo cáo,Vốn vay,vốn  vay', 'DA-01,2026-10,5,6'))).extensions).toEqual({ duplicate_columns: true });
    expect(failure(() => planFileImport(indicatorImportFormat(mapping), bytes('Mã dự án,Kỳ báo cáo,Cột khác', 'DA-01,2026-10,5'))).extensions).toEqual({ missing_columns: ['Tổng mức đầu tư'] });
    expect(failure(() => planFileImport(indicatorImportFormat(mapping), bytes(header))).code).toBe('IMPORT_EMPTY');
  });

  it('requires the columns of the lines marked required and matches headers without case or extra spaces', () => {
    const strict: ImportMapping = { ...mapping, lines: mapping.lines.map((line, index) => ({ ...line, required: index === 4 })) };
    expect(missingHeaders(strict, ['Mã dự án', 'Kỳ báo cáo', 'Tổng mức đầu tư'])).toEqual(['Lũy kế từ đầu năm']);
    expect(mappingFitsHeaders(strict, ['  MÃ DỰ ÁN ', 'kỳ  báo cáo', 'lũy kế từ đầu năm'])).toBe(true);
    const plan = planFileImport(indicatorImportFormat(strict), bytes('mã dự án,kỳ báo cáo,LŨY KẾ TỪ ĐẦU NĂM', 'DA-01,2026-10,5', 'DA-02,2026-10,'));
    expect(plan.rows.map((row) => (row.accepted ? 'OK' : row.rejection.code))).toEqual(['OK', 'VALUE_REQUIRED']);
  });
});

describe('the format of a mapping, layout by rows', () => {
  const mapping = sample('SAMPLE_ROWS_FORM');
  const context = { projectCode: 'DA-01', periodCode: '2026-10' };

  it('reads one record for each mapped label, ignores the others and keys a row by its indicator', () => {
    const plan = planFileImport(indicatorImportFormat(mapping, context), bytes('Chỉ tiêu,Giá trị,Ghi chú', 'Tổng mức đầu tư,"2.000",a', 'Tiêu đề khác,5,b', 'vốn  vay,"750,5",c'));
    expect(plan.rows).toHaveLength(2);
    const [first, second] = plan.rows;
    if (first?.accepted !== true || second?.accepted !== true) throw new Error('both rows are accepted');
    expect(first.row.businessKey).toBe('DA-01|2026-10|TOTAL_INVESTMENT');
    expect(first.row.record.figures).toEqual([{ indicator: 'TOTAL_INVESTMENT', value: '2000000000' }]);
    expect(second.row.record.figures).toEqual([{ indicator: 'LOAN_CAPITAL', value: '750500000' }]);
    expect(first.line).toBe(2);
    expect(second.line).toBe(4);
  });

  it('refuses a file where a label repeats or a required label is absent, and a blank value is a row of nothing', () => {
    expect(failure(() => planFileImport(indicatorImportFormat(mapping, context), bytes('Chỉ tiêu,Giá trị', 'Vốn vay,1', 'Vốn vay,2'))).extensions).toEqual({ duplicate_rows: ['Vốn vay'] });
    const strict: ImportMapping = { ...mapping, lines: mapping.lines.map((line, index) => ({ ...line, required: index === 0 })) };
    expect(failure(() => planFileImport(indicatorImportFormat(strict, context), bytes('Chỉ tiêu,Giá trị', 'Vốn vay,1'))).extensions).toEqual({ missing_rows: ['Tổng mức đầu tư'] });
    expect(planFileImport(indicatorImportFormat(mapping, context), bytes('Chỉ tiêu,Giá trị', 'Vốn vay,')).rows[0]).toMatchObject({ accepted: false, rejection: { code: 'ROW_EMPTY' } });
    expect(failure(() => planFileImport(indicatorImportFormat(mapping, context), bytes('Chỉ tiêu,Khác', 'Vốn vay,1'))).extensions).toEqual({ missing_columns: ['Giá trị'] });
    expect(failure(() => planFileImport(indicatorImportFormat(mapping, context), bytes('Chỉ tiêu,Giá trị', 'Dòng lạ,1'))).code).toBe('IMPORT_EMPTY');
    expect(planFileImport(indicatorImportFormat(mapping), bytes('Chỉ tiêu,Giá trị', 'Vốn vay,1')).rows[0]).toMatchObject({ accepted: false, rejection: { code: 'PROJECT_MISSING' } });
  });

  it('carries the version in the format version, so the evidence of an import names the mapping that read it', () => {
    expect(indicatorImportFormat({ ...mapping, version: 4 }).formatVersion).toBe('SAMPLE_ROWS_FORM.v4');
    expect(indicatorImportFormat(mapping).connectorCode).toBe('INDICATOR_IMPORT');
  });
});

describe('the rule type of a mapping', () => {
  const lines = [{ indicator: 'TOTAL_INVESTMENT', source: 'A' }];
  const refused = (overrides: Record<string, unknown>): string | undefined => {
    try {
      validateRuleParams('INDICATOR_IMPORT_MAPPING', { name: 'Form', layout: 'COLUMNS', number_format: 'PLAIN', lines, ...overrides });
      return undefined;
    } catch (error) {
      return error instanceof DomainError ? error.detail : 'other';
    }
  };

  it('accepts a mapping and says which member is wrong in one that cannot be', () => {
    expect(refused({})).toBeUndefined();
    expect(refused({ layout: 'ROWS' })).toBe('label_column');
    expect(refused({ layout: 'ROWS', label_column: 'L' })).toBe('value_column');
    expect(refused({ layout: 'ROWS', label_column: 'L', value_column: ' l ' })).toBe('value_column');
    expect(refused({ layout: 'ROWS', label_column: 'L', value_column: 'V', project_column: 'P' })).toBe('project_column');
    expect(refused({ label_column: 'L' })).toBe('label_column');
    expect(refused({ project_column: 'P', period_column: ' p' })).toBe('period_column');
    expect(refused({ lines: [...lines, { indicator: 'TOTAL_INVESTMENT', source: 'B' }] })).toBe('lines[1].indicator');
    expect(refused({ lines: [...lines, { indicator: 'PLAN_YEAR', source: ' a ' }] })).toBe('lines[1].source');
    expect(refused({ lines: [] })).toBe('lines');
    expect(refused({ lines: [{ indicator: 'lower', source: 'A' }] })).toBe('lines[0].indicator');
    expect(refused({ number_format: 'EU' })).toBe('number_format');
    expect(refused({ lines: [{ indicator: 'PLAN_YEAR', source: 'A', scale: 'TRILLION' }] })).toBe('lines[0].scale');
  });
});

describe('the problems of a mapping against the dictionary', () => {
  it('names a line that points at an indicator nobody defined or one that is derived, and none for the sample mappings', async () => {
    const { INDICATOR_SEEDS, indicatorOf, mappingProblems, resolveGovernanceRule } = await import('../src/index');
    const entries = INDICATOR_SEEDS.map((seed) => indicatorOf(resolveGovernanceRule([], 'KPI_DEFINITION', seed.code, '2026-11-08') as NonNullable<ReturnType<typeof resolveGovernanceRule>>));
    expect(mappingProblems(sample('SAMPLE_COLUMNS_FORM'), entries)).toEqual([]);
    expect(mappingProblems(sample('SAMPLE_ROWS_FORM'), entries)).toEqual([]);
    const broken: ImportMapping = { ...sample('SAMPLE_COLUMNS_FORM'), lines: [{ indicator: 'NO_SUCH', source: 'A', scale: 'ONE', required: false }, { indicator: 'REMAINING_YEAR', source: 'B', scale: 'ONE', required: false }, { indicator: 'PLAN_YEAR', source: 'C', scale: 'ONE', required: false }] };
    expect(mappingProblems(broken, entries)).toEqual([
      { code: 'INDICATOR_UNKNOWN', indicator: 'NO_SUCH', line: 0 },
      { code: 'INDICATOR_NOT_ENTERABLE', indicator: 'REMAINING_YEAR', line: 1 },
    ]);
  });
});
