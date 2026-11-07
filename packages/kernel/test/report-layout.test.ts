import { DomainError } from '../src/errors';
import {
  DEMO_MARK,
  assertLayoutIssuable,
  assertStatusMove,
  cellRef,
  columnLetters,
  countsAsAcceptedForm,
  dataRowOf,
  decimalTextOf,
  defaultBasisOf,
  demoFormsOn,
  fillGrid,
  fillNarrative,
  groupDigits,
  headerRowsOf,
  numFmtOf,
  periodCode,
  periodLabel,
  REPORT_FORM_CATALOGUE,
  periodRange,
  resolveBasis,
  shiftDecimalLeft,
  stampOf,
  sumDecimalTexts,
  unitLine,
  validateLayout,
} from '../src/report-layout';
import type { FormPeriod, LayoutColumn, NarrativeBlock, ReportFillData, ReportLayout } from '../src/report-layout';

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.detail ?? ''}` : String(error);
  }
  return undefined;
};

const COLUMNS: LayoutColumn[] = [
  { col: 1, key: 'stt', header: ['STT'] },
  { col: 2, key: 'name', header: ['Dự án'], width: 30 },
  { col: 3, key: 'plan', header: ['Kế hoạch', 'Vốn NSNN'], format: { scale: 'MILLION_VND' } },
  { col: 4, key: 'plan_other', header: ['Kế hoạch', 'Vốn khác'], format: { scale: 'MILLION_VND' } },
  { col: 5, key: 'done', header: ['Giải ngân'], format: { scale: 'MILLION_VND', decimals: 1 } },
  { col: 6, key: 'start', header: ['Khởi công'], format: { kind: 'DATE' } },
];

const layout = (overrides: Partial<ReportLayout> = {}): ReportLayout => ({
  code: 'MONTHLY-GROUP',
  name: 'Báo cáo tháng',
  version: '1',
  status: 'READY',
  formRef: null,
  sheetName: 'Bao cao',
  startRow: 3,
  moneyScale: 'MILLION_VND',
  headerMode: 'WRITE',
  columns: COLUMNS,
  preface: [
    { kind: 'TITLE', cells: [{ col: 1, colSpan: 6, binding: { kind: 'META', key: 'ORG_NAME' } }] },
    { kind: 'TITLE', cells: [{ col: 1, colSpan: 3, binding: { kind: 'META', key: 'PERIOD_LABEL' } }, { col: 4, colSpan: 3, binding: { kind: 'META', key: 'UNIT_LABEL' } }] },
  ],
  body: [
    dataRowOf('projects', COLUMNS, { capacity: 2, numbered: 'stt' }),
    {
      kind: 'TOTAL',
      cells: [
        { col: 2, binding: { kind: 'TEXT', text: 'Cộng' } },
        { col: 3, binding: { kind: 'SUM', dataset: 'projects', field: 'plan' }, format: { scale: 'MILLION_VND' } },
        { col: 4, binding: { kind: 'FORMULA', formula: 'SUM(D{first:projects}:D{last:projects})' } },
        { col: 5, binding: { kind: 'COUNT', dataset: 'projects' } },
      ],
    },
    { kind: 'NOTE', cells: [{ col: 2, binding: { kind: 'INDICATOR', code: 'HOME-01' }, format: { decimals: 1 } }] },
  ],
  ...overrides,
});

const data = (overrides: Partial<ReportFillData> = {}): ReportFillData => ({
  period: { kind: 'MONTH', year: 2026, index: 10 },
  meta: { ORG_NAME: 'PVFCCo' },
  definitions: { 'HOME-01': { code: 'HOME-01', name: 'Tỷ lệ giải ngân', unit: 'PERCENT', decimals: 2, period: 'YEAR_TO_DATE', version: 3 } },
  figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: '61.2345', flags: [] }],
  datasets: {
    projects: [
      { name: 'Dự án A', plan: '1500000000', plan_other: '250000000', done: '1234567890', start: '2026-03-05' },
      { name: 'Dự án B', plan: '500000000', plan_other: null, done: '999999999', start: null },
      { name: 'Dự án C', plan: '1000000', plan_other: '1', done: '0', start: '2026-10-31' },
    ],
  },
  ...overrides,
});

describe('periods', () => {
  const cases: Array<[FormPeriod, string, string, string, string]> = [
    [{ kind: 'MONTH', year: 2026, index: 2 }, '2026-02-01', '2026-02-28', '2026-M02', 'Tháng 2 năm 2026'],
    [{ kind: 'MONTH', year: 2028, index: 2 }, '2028-02-01', '2028-02-29', '2028-M02', 'Tháng 2 năm 2028'],
    [{ kind: 'QUARTER', year: 2026, index: 3 }, '2026-07-01', '2026-09-30', '2026-Q3', 'Quý III năm 2026'],
    [{ kind: 'HALF_YEAR', year: 2026, index: 1 }, '2026-01-01', '2026-06-30', '2026-H1', '6 tháng đầu năm 2026'],
    [{ kind: 'HALF_YEAR', year: 2026, index: 2 }, '2026-07-01', '2026-12-31', '2026-H2', '6 tháng cuối năm 2026'],
    [{ kind: 'YEAR', year: 2026 }, '2026-01-01', '2026-12-31', '2026', 'Năm 2026'],
    [{ kind: 'AS_OF', year: 2026, day: '2026-10-31' }, '2026-01-01', '2026-10-31', '2026-10-31', 'Tính đến ngày 31/10/2026'],
  ];
  it.each(cases)('%j runs %s to %s, is called %s and reads %s', (period, from, to, code, label) => {
    expect(periodRange(period)).toEqual({ from, to });
    expect(periodCode(period)).toBe(code);
    expect(periodLabel(period)).toBe(label);
  });

  it('writes the English labels', () => {
    expect(periodLabel({ kind: 'MONTH', year: 2026, index: 10 }, 'en')).toBe('October 2026');
    expect(periodLabel({ kind: 'AS_OF', year: 2026, day: '2026-10-31' }, 'en')).toBe('As of 31/10/2026');
    expect(unitLine('BILLION_VND', 'en')).toBe('Unit: billion VND');
    expect(unitLine('MILLION_VND')).toBe('Đơn vị tính: triệu đồng');
  });

  it('refuses a period that is not what its kind says', () => {
    for (const bad of [
      { kind: 'MONTH', year: 2026, index: 13 },
      { kind: 'MONTH', year: 2026 },
      { kind: 'YEAR', year: 2026, index: 1 },
      { kind: 'AS_OF', year: 2026, day: '2026-02-30' },
      { kind: 'AS_OF', year: 2025, day: '2026-02-01' },
      { kind: 'QUARTER', year: 2026, index: 0 },
      { kind: 'WEEK', year: 2026, index: 1 },
    ] as unknown as FormPeriod[]) {
      expect(codeOf(() => periodRange(bad))).toBe('VALIDATION_FAILED:period');
    }
  });

  it('resolves every basis of a period', () => {
    const october: FormPeriod = { kind: 'MONTH', year: 2026, index: 10 };
    expect(resolveBasis('IN_PERIOD', october)).toEqual({ basis: 'IN_PERIOD', from: '2026-10-01', to: '2026-10-31' });
    expect(resolveBasis('YEAR_TO_DATE', october)).toEqual({ basis: 'YEAR_TO_DATE', from: '2026-01-01', to: '2026-10-31' });
    expect(resolveBasis('AS_OF_END', october)).toEqual({ basis: 'AS_OF_END', from: '2026-10-31', to: '2026-10-31' });
    expect(resolveBasis('FULL_YEAR', october)).toEqual({ basis: 'FULL_YEAR', from: '2026-01-01', to: '2026-12-31' });
    expect(resolveBasis('SAME_PERIOD_LAST_YEAR', october)).toEqual({ basis: 'SAME_PERIOD_LAST_YEAR', from: '2025-10-01', to: '2025-10-31' });
    expect(resolveBasis('PREVIOUS_PERIOD', october)).toEqual({ basis: 'PREVIOUS_PERIOD', from: '2026-09-01', to: '2026-09-30' });
    expect(resolveBasis('PREVIOUS_PERIOD', { kind: 'MONTH', year: 2026, index: 1 })).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolveBasis('PREVIOUS_PERIOD', { kind: 'QUARTER', year: 2026, index: 1 })).toMatchObject({ from: '2025-10-01', to: '2025-12-31' });
    expect(resolveBasis('PREVIOUS_PERIOD', { kind: 'HALF_YEAR', year: 2026, index: 2 })).toMatchObject({ from: '2026-01-01', to: '2026-06-30' });
    expect(resolveBasis('PREVIOUS_PERIOD', { kind: 'YEAR', year: 2026 })).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    // A leap day has no last year: 29 February reads as 28 February.
    expect(resolveBasis('SAME_PERIOD_LAST_YEAR', { kind: 'MONTH', year: 2028, index: 2 })).toMatchObject({ to: '2027-02-28' });
    expect(codeOf(() => resolveBasis('PREVIOUS_PERIOD', { kind: 'AS_OF', year: 2026, day: '2026-10-31' }))).toBe('VALIDATION_FAILED:period_basis');
    expect(codeOf(() => resolveBasis('NOPE' as never, october))).toBe('VALIDATION_FAILED:period_basis');
  });

  it('reads a KPI with the basis its period says', () => {
    expect(defaultBasisOf('YEAR_TO_DATE')).toBe('YEAR_TO_DATE');
    expect(defaultBasisOf('AS_OF_NOW')).toBe('AS_OF_END');
    expect(defaultBasisOf('MONTH')).toBe('IN_PERIOD');
  });
});

describe('exact numbers', () => {
  it('moves the point without a float', () => {
    expect(shiftDecimalLeft('1234567890', 6)).toBe('1234.567890');
    expect(shiftDecimalLeft('5', 6)).toBe('0.000005');
    expect(shiftDecimalLeft('-1500000000', 9)).toBe('-1.500000000');
    expect(shiftDecimalLeft('12.5', 3)).toBe('0.0125');
    expect(shiftDecimalLeft('12', 0)).toBe('12');
    expect(codeOf(() => shiftDecimalLeft('x', 3))).toBe('VALIDATION_FAILED:value');
  });
  it('adds without a float', () => {
    expect(sumDecimalTexts(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimalTexts(['1500000000', '-250000000.5'])).toBe('1249999999.5');
    expect(sumDecimalTexts(['-1', '1'])).toBe('0');
    expect(sumDecimalTexts(['-0.5', '-0.25'])).toBe('-0.75');
  });
  it('accepts plain decimals and numbers only', () => {
    expect(decimalTextOf(12)).toBe('12');
    expect(decimalTextOf(' 1.50 ')).toBe('1.50');
    expect(decimalTextOf('1e5')).toBeNull();
    expect(decimalTextOf(1e21)).toBeNull();
    expect(decimalTextOf(Number.NaN)).toBeNull();
    expect(decimalTextOf('')).toBeNull();
    expect(decimalTextOf(null)).toBeNull();
    expect(decimalTextOf(undefined)).toBeNull();
  });
  it('writes number formats and digit groups', () => {
    expect(numFmtOf(0)).toBe('#,##0');
    expect(numFmtOf(2)).toBe('#,##0.00');
    expect(groupDigits('1234567.89')).toBe('1.234.567,89');
    expect(groupDigits('-1234567.89', 'en')).toBe('-1,234,567.89');
    expect(groupDigits('999')).toBe('999');
  });
  it('names the columns of a sheet', () => {
    expect(columnLetters(1)).toBe('A');
    expect(columnLetters(26)).toBe('Z');
    expect(columnLetters(27)).toBe('AA');
    expect(columnLetters(256)).toBe('IV');
    expect(cellRef(12, 3)).toBe('C12');
  });
});

describe('headerRowsOf', () => {
  it('groups neighbours under one label and spans a short path down', () => {
    const rows = headerRowsOf(COLUMNS);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.cells.map((cell) => [cell.col, (cell.binding as { text: string }).text, cell.colSpan, cell.rowSpan])).toEqual([
      [1, 'STT', 1, 2],
      [2, 'Dự án', 1, 2],
      [3, 'Kế hoạch', 2, 1],
      [5, 'Giải ngân', 1, 2],
      [6, 'Khởi công', 1, 2],
    ]);
    expect(rows[1]?.cells.map((cell) => [cell.col, (cell.binding as { text: string }).text])).toEqual([
      [3, 'Vốn NSNN'],
      [4, 'Vốn khác'],
    ]);
  });
  it('does not merge labels across a gap in the columns', () => {
    const rows = headerRowsOf([
      { col: 1, key: 'a', header: ['G', 'x'] },
      { col: 3, key: 'b', header: ['G', 'y'] },
    ]);
    expect(rows[0]?.cells.map((cell) => cell.colSpan)).toEqual([1, 1]);
  });
  it('refuses an empty header path and returns nothing for no columns', () => {
    expect(headerRowsOf([])).toEqual([]);
    expect(codeOf(() => headerRowsOf([{ col: 1, key: 'a', header: [] }]))).toBe('VALIDATION_FAILED:column_header');
  });
});

describe('validateLayout', () => {
  const invalid = (overrides: Partial<ReportLayout>): string | undefined => codeOf(() => validateLayout(layout(overrides)));
  it('accepts the sample layout', () => {
    expect(invalid({})).toBeUndefined();
  });
  it('refuses what cannot be placed', () => {
    expect(invalid({ code: 'x' })).toBe('VALIDATION_FAILED:layout');
    expect(invalid({ status: 'LIVE' as never })).toBe('VALIDATION_FAILED:layout_status');
    expect(invalid({ moneyScale: 'EUR' as never })).toBe('VALIDATION_FAILED:money_scale');
    expect(invalid({ startRow: 0 })).toBe('VALIDATION_FAILED:start_row');
    expect(invalid({ columns: [...COLUMNS, { col: 1, key: 'dup', header: ['x'] }] })).toBe('VALIDATION_FAILED:columns');
    expect(invalid({ columns: [...COLUMNS, { col: 9, key: 'stt', header: ['x'] }] })).toBe('VALIDATION_FAILED:columns');
    expect(invalid({ columns: [{ col: 1, key: 'a', header: ['x'], width: 0 }] })).toBe('VALIDATION_FAILED:column_width');
    expect(invalid({ body: [{ kind: 'DATA', cells: [] }] })).toBe('VALIDATION_FAILED:dataset');
    expect(invalid({ body: [dataRowOf('a', COLUMNS), dataRowOf('a', COLUMNS)] })).toBe('VALIDATION_FAILED:dataset');
    expect(invalid({ body: [dataRowOf('a', COLUMNS, { capacity: 0 })] })).toBe('VALIDATION_FAILED:capacity');
    expect(invalid({ body: [{ kind: 'NOTE', dataset: 'a', cells: [] }] })).toBe('VALIDATION_FAILED:row_kind');
    expect(invalid({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 0, binding: { kind: 'TEXT', text: 'x' } }] }] })).toBe('VALIDATION_FAILED:cell');
    expect(invalid({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 1, colSpan: 2, binding: { kind: 'TEXT', text: 'x' } }, { col: 2, binding: { kind: 'TEXT', text: 'y' } }] }] })).toBe('VALIDATION_FAILED:cell_overlap');
    expect(invalid({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 1, rowSpan: 2, binding: { kind: 'TEXT', text: 'x' } }] }] })).toBe('VALIDATION_FAILED:cell_rowspan');
    expect(invalid({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'ROW_FIELD', field: 'x' } }] }] })).toBe('VALIDATION_FAILED:binding_row');
    expect(invalid({ preface: [], columns: [], body: [{ kind: 'TOTAL', cells: [{ col: 1, binding: { kind: 'SUM', dataset: 'none', field: 'x' } }] }] })).toBe('VALIDATION_FAILED:binding_dataset');
    expect(invalid({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'TEXT', text: 'x' }, format: { decimals: 9 } }] }] })).toBe('VALIDATION_FAILED:format');
    expect(invalid({ preface: [], columns: [], body: [] })).toBe('VALIDATION_FAILED:layout_rows');
  });
  it('refuses a row span that runs over a data row', () => {
    const bad = layout({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 1, rowSpan: 2, binding: { kind: 'TEXT', text: 'x' } }] }, dataRowOf('a', COLUMNS)] });
    expect(codeOf(() => validateLayout(bad))).toBe('VALIDATION_FAILED:cell_rowspan');
  });
  it('lets only a confirmed layout be issued', () => {
    expect(codeOf(() => assertLayoutIssuable(layout({ status: 'PENDING_EXTERNAL' })))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
    expect(codeOf(() => assertLayoutIssuable(layout({ status: 'DRAFT' })))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
    expect(codeOf(() => assertLayoutIssuable(layout({ status: 'READY' })))).toBeUndefined();
  });

  describe('DEMO forms (R18)', () => {
    const MARK_ROW = { kind: 'TITLE' as const, cells: [{ col: 1, colSpan: 6, binding: { kind: 'TEXT' as const, text: DEMO_MARK } }] };
    const demo = (overrides: Partial<ReportLayout> = {}): ReportLayout => layout({ status: 'DEMO', name: 'Báo cáo thử (mẫu demo)', preface: [MARK_ROW], ...overrides });

    it('may be issued only when demo mode is on', () => {
      expect(codeOf(() => assertLayoutIssuable(demo()))).toBe('TEMPLATE_UNCONFIRMED:demo_forms_off');
      expect(codeOf(() => assertLayoutIssuable(demo(), { demoMode: false }))).toBe('TEMPLATE_UNCONFIRMED:demo_forms_off');
      expect(codeOf(() => assertLayoutIssuable(demo(), { demoMode: true }))).toBeUndefined();
      // Demo mode does not make an unconfirmed or draft layout issuable.
      expect(codeOf(() => assertLayoutIssuable(layout({ status: 'PENDING_EXTERNAL' }), { demoMode: true }))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
      expect(codeOf(() => assertLayoutIssuable(layout({ status: 'DRAFT' }), { demoMode: true }))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
    });

    it('is an unofficial design: no form reference, a name that says demo, the mark in a cell of the preface', () => {
      expect(codeOf(() => validateLayout(demo()))).toBeUndefined();
      expect(codeOf(() => validateLayout(demo({ formRef: 'Quyết định 1/2026' })))).toBe('VALIDATION_FAILED:demo_layout');
      expect(codeOf(() => validateLayout(demo({ name: 'Báo cáo thử' })))).toBe('VALIDATION_FAILED:demo_layout');
      expect(codeOf(() => validateLayout(demo({ preface: [{ kind: 'TITLE', cells: [{ col: 1, binding: { kind: 'TEXT', text: 'x' } }] }] })))).toBe('VALIDATION_FAILED:demo_mark_missing');
    });

    it('stamps its grid and can never become READY or count as accepted', () => {
      expect(stampOf(demo())).toBe(DEMO_MARK);
      expect(stampOf(layout())).toBeNull();
      const grid = fillGrid(demo(), data());
      expect(grid.status).toBe('DEMO');
      expect(grid.stamp).toBe(DEMO_MARK);
      expect(fillGrid(layout(), data()).stamp).toBeNull();
      expect(countsAsAcceptedForm(demo())).toBe(false);
      expect(countsAsAcceptedForm(layout())).toBe(true);
      expect(codeOf(() => assertStatusMove('DEMO', 'READY'))).toBe('TEMPLATE_UNCONFIRMED:demo_not_ready');
      expect(codeOf(() => assertStatusMove('DEMO', 'DRAFT'))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
      expect(codeOf(() => assertStatusMove('DRAFT', 'READY'))).toBeUndefined();
      expect(codeOf(() => assertStatusMove('PENDING_EXTERNAL', 'READY'))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
      expect(codeOf(() => assertStatusMove('PENDING_EXTERNAL', 'DEMO'))).toBeUndefined();
      expect(codeOf(() => assertStatusMove('READY', 'DEMO'))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
    });
  });

  describe('demoFormsOn', () => {
    it('reads the environment first, then the rule, and is off by default', () => {
      expect(demoFormsOn()).toBe(false);
      expect(demoFormsOn({ env: {} })).toBe(false);
      expect(demoFormsOn({ ruleParams: { demo_forms: true } })).toBe(true);
      expect(demoFormsOn({ ruleParams: { demo_forms: false } })).toBe(false);
      expect(demoFormsOn({ env: { DEMO_FORMS: 'true' }, ruleParams: { demo_forms: false } })).toBe(true);
      expect(demoFormsOn({ env: { DEMO_FORMS: ' FALSE ' }, ruleParams: { demo_forms: true } })).toBe(false);
      expect(demoFormsOn({ env: { DEMO_FORMS: '  ' }, ruleParams: { demo_forms: true } })).toBe(true);
    });
    it('refuses a value that is neither true nor false', () => {
      expect(codeOf(() => demoFormsOn({ env: { DEMO_FORMS: 'yes' } }))).toBe('VALIDATION_FAILED:demo_forms');
      expect(codeOf(() => demoFormsOn({ env: { DEMO_FORMS: '1' } }))).toBe('VALIDATION_FAILED:demo_forms');
    });
  });
});

describe('fillGrid', () => {
  const cellAt = (grid: ReturnType<typeof fillGrid>, ref: string) => grid.cells.find((cell) => cellRef(cell.row, cell.col) === ref);

  it('places the rows, grows the data block and keeps the style rows of the template', () => {
    const grid = fillGrid(layout(), data());
    // Preface rows 3-4, header rows 5-6, data block rows 7-9 (capacity 2, three records), total 10, note 11.
    expect(grid.rows.map((row) => [row.row, row.templateRow, row.inserted, row.kind])).toEqual([
      [3, 3, false, 'TITLE'],
      [4, 4, false, 'TITLE'],
      [5, 5, false, 'HEADER'],
      [6, 6, false, 'HEADER'],
      [7, 7, false, 'DATA'],
      [8, 8, false, 'DATA'],
      [9, 8, true, 'DATA'],
      [10, 9, false, 'TOTAL'],
      [11, 10, false, 'NOTE'],
    ]);
  });

  it('fills records with the scale, the places and the dates of the form, and writes no 0 for no value', () => {
    const grid = fillGrid(layout(), data());
    expect(cellAt(grid, 'A7')).toMatchObject({ kind: 'NUMBER', number: '1' });
    expect(cellAt(grid, 'B7')).toMatchObject({ kind: 'TEXT', text: 'Dự án A' });
    expect(cellAt(grid, 'C7')).toMatchObject({ kind: 'NUMBER', number: '1500', numFmt: '#,##0' });
    expect(cellAt(grid, 'D7')).toMatchObject({ kind: 'NUMBER', number: '250' });
    expect(cellAt(grid, 'E7')).toMatchObject({ kind: 'NUMBER', number: '1234.6', numFmt: '#,##0.0' });
    expect(cellAt(grid, 'F7')).toMatchObject({ kind: 'TEXT', text: '05/03/2026' });
    expect(cellAt(grid, 'D8')).toMatchObject({ kind: 'EMPTY' });
    expect(cellAt(grid, 'F8')).toMatchObject({ kind: 'EMPTY' });
    expect(cellAt(grid, 'E9')).toMatchObject({ kind: 'NUMBER', number: '0.0' });
    // 1,000,000 dong is exactly 1 million; 1 dong is 0 million (rounded, not hidden).
    expect(cellAt(grid, 'C9')).toMatchObject({ number: '1' });
    expect(cellAt(grid, 'D9')).toMatchObject({ number: '0' });
  });

  it('gives the totals and the live formula of the data block', () => {
    const grid = fillGrid(layout(), data());
    expect(cellAt(grid, 'B10')).toMatchObject({ kind: 'TEXT', text: 'Cộng' });
    expect(cellAt(grid, 'C10')).toMatchObject({ kind: 'NUMBER', number: '2001', source: 'SUM:projects.plan' });
    expect(cellAt(grid, 'D10')).toMatchObject({ kind: 'FORMULA', formula: 'SUM(D7:D9)' });
    expect(cellAt(grid, 'E10')).toMatchObject({ kind: 'NUMBER', number: '3', source: 'COUNT:projects' });
  });

  it('reads an indicator with its definition and the basis of its period', () => {
    const grid = fillGrid(layout(), data());
    expect(cellAt(grid, 'B11')).toMatchObject({ kind: 'NUMBER', number: '61.2', source: 'INDICATOR:HOME-01@YEAR_TO_DATE' });
    expect(grid.issues).toEqual([]);
  });

  it('writes the facts of the report', () => {
    const grid = fillGrid(layout(), data());
    expect(cellAt(grid, 'A3')).toMatchObject({ kind: 'TEXT', text: 'PVFCCo' });
    expect(cellAt(grid, 'A4')).toMatchObject({ text: 'Tháng 10 năm 2026' });
    expect(cellAt(grid, 'D4')).toMatchObject({ text: 'Đơn vị tính: triệu đồng' });
    expect(grid.merges).toContainEqual({ fromRow: 3, fromCol: 1, toRow: 3, toCol: 6 });
    expect(grid.merges).toContainEqual({ fromRow: 5, fromCol: 3, toRow: 5, toCol: 4 });
    expect(grid.merges).toContainEqual({ fromRow: 5, fromCol: 1, toRow: 6, toCol: 1 });
    expect(grid.columnWidths).toEqual([{ col: 2, width: 30 }]);
  });

  it('leaves the header cells of the template alone in KEEP mode', () => {
    const grid = fillGrid(layout({ headerMode: 'KEEP' }), data());
    expect(grid.cells.some((cell) => cell.row === 5 || cell.row === 6)).toBe(false);
    expect(grid.merges.some((merge) => merge.fromRow === 5)).toBe(false);
    expect(grid.rows.filter((row) => row.kind === 'HEADER')).toHaveLength(2);
  });

  it('clears the reserved rows that hold no record, so a sample line of the template never stays', () => {
    const grid = fillGrid(layout(), data({ datasets: { projects: [{ name: 'Dự án A', plan: '1000000', plan_other: '0', done: '0', start: null }] } }));
    expect(grid.rows.filter((row) => row.kind === 'DATA')).toHaveLength(2);
    expect(grid.cells.filter((cell) => cell.row === 8).every((cell) => cell.kind === 'EMPTY')).toBe(true);
    expect(grid.cells.filter((cell) => cell.row === 8)).toHaveLength(6);
  });

  it('refuses to grow a form with a fixed number of lines', () => {
    const fixed = layout({ body: [dataRowOf('projects', COLUMNS, { capacity: 2, overflow: 'REFUSE' })] });
    expect(codeOf(() => fillGrid(fixed, data()))).toBe('VALIDATION_FAILED:dataset_overflow');
  });

  it('says what the data lacks as issues and empty cells', () => {
    const grid = fillGrid(
      layout(),
      data({
        meta: {},
        definitions: {},
        figures: [],
        datasets: {},
      }),
    );
    const codes = grid.issues.map((entry) => `${entry.ref}:${entry.code}`);
    expect(codes).toEqual(expect.arrayContaining(['A3:META_MISSING', 'B10:NO_DEFINITION', 'C9:DATASET_MISSING', 'E9:DATASET_MISSING', 'A7:DATASET_MISSING']));
    expect(cellAt(grid, 'B10')).toMatchObject({ kind: 'EMPTY' });
  });

  it('flags an indicator that has no figure, no value, or a flag, and one that is not a number', () => {
    const base = data();
    const flagged = fillGrid(layout(), { ...base, figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: '5', flags: ['NOT_CERTIFIED', 'STALE'] }] });
    expect(flagged.issues.map((entry) => entry.code)).toEqual(['NOT_CERTIFIED', 'STALE']);
    expect(cellAt(flagged, 'B11')).toMatchObject({ kind: 'NUMBER', number: '5.0' });
    const noFigure = fillGrid(layout(), { ...base, figures: [{ code: 'HOME-01', basis: 'IN_PERIOD', value: '5' }] });
    expect(noFigure.issues).toEqual([{ ref: 'B11', row: 11, col: 2, code: 'NO_FIGURE', detail: 'HOME-01@YEAR_TO_DATE' }]);
    const noValue = fillGrid(layout(), { ...base, figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: null }] });
    expect(noValue.issues.map((entry) => entry.code)).toEqual(['NO_DATA']);
    expect(cellAt(noValue, 'B11')).toMatchObject({ kind: 'EMPTY', source: 'INDICATOR:HOME-01@YEAR_TO_DATE' });
    const noDuplicate = fillGrid(layout(), { ...base, figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: null, flags: ['NO_DATA'] }] });
    expect(noDuplicate.issues.map((entry) => entry.code)).toEqual(['NO_DATA']);
    const text = fillGrid(layout(), { ...base, figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: 'abc' }] });
    expect(text.issues.map((entry) => entry.code)).toEqual(['NOT_A_NUMBER']);
  });

  it('flags a field that a record lacks and a value that is not a number, in a record and in a sum', () => {
    const grid = fillGrid(layout(), data({ datasets: { projects: [{ name: 'A', plan: 'many', plan_other: '1', start: null }] } }));
    const codes = grid.issues.map((entry) => `${entry.ref}:${entry.code}`);
    expect(codes).toEqual(expect.arrayContaining(['C7:NOT_A_NUMBER', 'E7:FIELD_MISSING', 'C9:NOT_A_NUMBER']));
  });

  it('scales a money indicator and keeps the places of a percent', () => {
    const money = layout({
      preface: [],
      columns: [],
      body: [{ kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'INDICATOR', code: 'PAY-01', basis: 'IN_PERIOD' } }, { col: 2, binding: { kind: 'INDICATOR', code: 'PAY-01', basis: 'IN_PERIOD' }, format: { scale: 'BILLION_VND', decimals: 3 } }, { col: 3, binding: { kind: 'INDICATOR', code: 'CNT-01', basis: 'IN_PERIOD' } }] }],
    });
    const grid = fillGrid(money, {
      ...data(),
      definitions: {
        'PAY-01': { code: 'PAY-01', name: 'Chi', unit: 'VND', decimals: 0, period: 'MONTH', version: 1 },
        'CNT-01': { code: 'CNT-01', name: 'Số', unit: 'COUNT', decimals: 0, period: 'MONTH', version: 1 },
      },
      figures: [
        { code: 'PAY-01', basis: 'IN_PERIOD', value: '12345678901' },
        { code: 'CNT-01', basis: 'IN_PERIOD', value: 7 },
      ],
    });
    expect(cellAt(grid, 'A3')).toMatchObject({ kind: 'NUMBER', number: '12346' });
    expect(cellAt(grid, 'B3')).toMatchObject({ kind: 'NUMBER', number: '12.346', numFmt: '#,##0.000' });
    expect(cellAt(grid, 'C3')).toMatchObject({ kind: 'NUMBER', number: '7' });
  });

  it('keeps a number format that the layout names', () => {
    const named = layout({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'INDICATOR', code: 'HOME-01' }, format: { numFmt: '0.0"%"' } }, { col: 2, binding: { kind: 'FORMULA', formula: '=A3*2' }, format: { numFmt: '0.0' } }] }] });
    const grid = fillGrid(named, data());
    expect(cellAt(grid, 'A3')).toMatchObject({ numFmt: '0.0"%"', number: '61.23' });
    expect(cellAt(grid, 'B3')).toMatchObject({ kind: 'FORMULA', formula: 'A3*2', numFmt: '0.0' });
  });

  it('refuses a formula that names a dataset the layout does not have, and a period that is not valid', () => {
    const bad = layout({ preface: [], columns: [], body: [{ kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'FORMULA', formula: 'SUM(A{first:nope}:A{last:nope})' } }] }] });
    expect(codeOf(() => fillGrid(bad, data()))).toBe('VALIDATION_FAILED:formula_dataset');
    expect(codeOf(() => fillGrid(layout(), data({ period: { kind: 'MONTH', year: 2026, index: 0 } })))).toBe('VALIDATION_FAILED:period');
  });

  it('gives the same grid for the same input', () => {
    expect(JSON.stringify(fillGrid(layout(), data()))).toBe(JSON.stringify(fillGrid(layout(), data())));
  });

  it('keeps a sum of nothing empty and a count of an empty dataset zero', () => {
    const grid = fillGrid(layout(), data({ datasets: { projects: [] } }));
    expect(cellAt(grid, 'C9')).toMatchObject({ kind: 'EMPTY' });
    expect(cellAt(grid, 'E9')).toMatchObject({ kind: 'NUMBER', number: '0' });
    expect(grid.issues.some((entry) => entry.code === 'DATASET_MISSING')).toBe(false);
  });
});

describe('fillNarrative', () => {
  const blocks: NarrativeBlock[] = [
    { type: 'HEADING', level: 1, text: 'Báo cáo {{meta:PERIOD_LABEL}}' },
    { type: 'PARAGRAPH', text: 'Giải ngân đạt {{indicator:HOME-01}}% kế hoạch; chi {{indicator:PAY-01@IN_PERIOD}} ({{meta:UNIT_LABEL}}). {{ không phải mã }}' },
    { type: 'LIST', ordered: false, items: ['Thiếu {{indicator:NONE}}', '{{meta:ORG_NAME}}'] },
    { type: 'TABLE', header: ['{{meta:PERIOD_CODE}}'], rows: [['{{indicator:CNT-01@PREVIOUS_PERIOD}}']] },
    { type: 'SIGNATURES', slots: [{ role: 'Người lập', name: '{{meta:PREPARER}}' }, { role: 'Người duyệt', name: null }] },
    { type: 'PAGE_BREAK' },
  ];

  it('writes the figures as the grid writes them and says what is missing', () => {
    const result = fillNarrative(blocks, { ...data(), meta: { ORG_NAME: 'PVFCCo' }, definitions: { ...data().definitions, 'PAY-01': { code: 'PAY-01', name: 'Chi', unit: 'VND', decimals: 0, period: 'MONTH', version: 1 }, 'CNT-01': { code: 'CNT-01', name: 'Số', unit: 'COUNT', decimals: 0, period: 'MONTH', version: 1 } }, figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: '61.2345', flags: ['STALE'] }, { code: 'PAY-01', basis: 'IN_PERIOD', value: '12345678901' }] }, 'MILLION_VND');
    expect(result.blocks[0]).toMatchObject({ text: 'Báo cáo Tháng 10 năm 2026' });
    expect(result.blocks[1]).toMatchObject({ text: 'Giải ngân đạt 61,23% kế hoạch; chi 12.346 (Đơn vị tính: triệu đồng). {{ không phải mã }}' });
    expect(result.blocks[2]).toMatchObject({ items: ['Thiếu —', 'PVFCCo'] });
    expect(result.blocks[3]).toMatchObject({ header: ['2026-M10'], rows: [['—']] });
    expect(result.blocks[4]).toMatchObject({ slots: [{ role: 'Người lập', name: '—' }, { role: 'Người duyệt', name: null }] });
    expect(result.blocks[5]).toEqual({ type: 'PAGE_BREAK' });
    expect(result.issues.map((entry) => `${entry.token}:${entry.code}`)).toEqual([
      '{{indicator:HOME-01}}:STALE',
      '{{indicator:NONE}}:NO_DEFINITION',
      '{{indicator:CNT-01@PREVIOUS_PERIOD}}:NO_FIGURE',
      '{{meta:PREPARER}}:META_MISSING',
    ]);
  });

  it('flags a figure with no value or a value that is not a number, and a basis that does not exist', () => {
    const base = data();
    const result = fillNarrative(
      [{ type: 'PARAGRAPH', text: '{{indicator:HOME-01}} {{indicator:HOME-01@IN_PERIOD}} {{indicator:HOME-01@WHENEVER}}' }],
      { ...base, figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: null }, { code: 'HOME-01', basis: 'IN_PERIOD', value: 'abc' }] },
      'VND',
    );
    expect(result.blocks[0]).toMatchObject({ text: '— — —' });
    expect(result.issues.map((entry) => entry.code)).toEqual(['NO_DATA', 'NOT_A_NUMBER', 'NO_FIGURE']);
  });

  it('writes money in the scale of the layout and English digits in English', () => {
    const base = data();
    const result = fillNarrative(
      [{ type: 'PARAGRAPH', text: '{{indicator:PAY-01}}' }],
      { ...base, locale: 'en', definitions: { 'PAY-01': { code: 'PAY-01', name: 'Chi', unit: 'VND', decimals: 0, period: 'MONTH', version: 1 } }, figures: [{ code: 'PAY-01', basis: 'IN_PERIOD', value: '12345678901234' }] },
      'BILLION_VND',
    );
    expect(result.blocks[0]).toMatchObject({ text: '12,345.68' });
  });
});

describe('formula row tokens', () => {
  it('reads {row}, {row-1} and {row+1} as the row of the cell and its neighbours', () => {
    const grid = fillGrid(
      layout({
        startRow: 5,
        preface: [],
        columns: [],
        body: [
          { kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'TEXT', text: 'x' } }] },
          { kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'FORMULA', formula: 'A{row-1}+A{row+1}+A{row}' } }] },
          { kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'FORMULA', formula: '=SUM(A{row-2}:A{row-1})' } }] },
        ],
      }),
      data(),
    );
    expect(grid.cells.filter((cell) => cell.kind === 'FORMULA').map((cell) => cell.formula)).toEqual(['A5+A7+A6', 'SUM(A5:A6)']);
  });
});

describe('REPORT_FORM_CATALOGUE', () => {
  it('lists the six forms of the first customer as demo designs, official acceptance still pending, with unique codes the layout accepts', () => {
    expect(REPORT_FORM_CATALOGUE).toHaveLength(6);
    expect(new Set(REPORT_FORM_CATALOGUE.map((entry) => entry.code)).size).toBe(6);
    for (const entry of REPORT_FORM_CATALOGUE) {
      expect(entry.status).toBe('DEMO');
      expect(entry.official).toBe('PENDING_EXTERNAL');
      expect(entry.name).toContain('mẫu demo');
      expect(entry.name).toContain('chờ mẫu chính thức');
      const pending = layout({ code: entry.code, status: 'PENDING_EXTERNAL', name: entry.name });
      expect(codeOf(() => validateLayout(pending))).toBeUndefined();
      expect(codeOf(() => assertLayoutIssuable(pending, { demoMode: true }))).toBe('TEMPLATE_UNCONFIRMED:layout_status');
    }
  });
});
