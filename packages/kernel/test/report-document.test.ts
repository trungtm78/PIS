import { DIS_WEEKLY_LAYOUT, cellRef, dataRowOf, documentSheetOf, formatSheetNumber, layoutHashOf, narrativeLinesOf, numFmtShape, formDocumentOf, previewOfDocument, validateLayout } from '../src/index.ts';
import type { LayoutColumn, ReportFillData, ReportLayout } from '../src/index.ts';

const COLUMNS: LayoutColumn[] = [
  { col: 1, key: 'no', header: ['STT'], width: 6 },
  { col: 2, key: 'name', header: ['Project'], width: 30 },
  { col: 3, key: 'plan', header: ['Plan', 'Year'], width: 14, format: { kind: 'NUMBER', decimals: 0 } },
  { col: 4, key: 'done', header: ['Plan', 'Done'], width: 14, format: { kind: 'NUMBER', decimals: 0 } },
  { col: 5, key: 'rate', header: ['Rate'], width: 10 },
];

const LAYOUT: ReportLayout = {
  code: 'TEST-DOC',
  name: 'Test document',
  version: '1',
  status: 'READY',
  formRef: null,
  sheetName: 'S',
  moneyScale: 'VND',
  headerMode: 'KEEP',
  columns: COLUMNS,
  preface: [{ kind: 'TITLE', cells: [{ col: 1, binding: { kind: 'TEXT', text: 'Report' }, colSpan: 5 }] }],
  body: [
    dataRowOf('projects', COLUMNS, { capacity: 2, numbered: 'no' }),
    {
      kind: 'TOTAL',
      cells: [
        { col: 2, binding: { kind: 'TEXT', text: 'Total' } },
        { col: 3, binding: { kind: 'FORMULA', formula: 'SUM(C{first:projects}:C{last:projects})' }, format: { numFmt: '#,##0' } },
        { col: 4, binding: { kind: 'FORMULA', formula: 'SUM(D{first:projects}:D{last:projects})' }, format: { numFmt: '#,##0' } },
        { col: 5, binding: { kind: 'FORMULA', formula: 'IF(C{row}>0,ROUND(D{row}/C{row}*100,1),"")' }, format: { numFmt: '#,##0.0' } },
      ],
    },
  ],
};

const DATA: ReportFillData = {
  period: { kind: 'MONTH', year: 2026, index: 10 },
  meta: {},
  definitions: {},
  figures: [],
  datasets: {
    projects: [
      { name: 'A', plan: '1000', done: '250', rate: null },
      { name: 'B', plan: '2000', done: '500', rate: null },
      { name: 'C', plan: '1500', done: '1500', rate: null },
    ],
  },
};

describe('the one document model of the report writers (R26)', () => {
  const document = formDocumentOf(LAYOUT, null, DATA);
  const sheet = documentSheetOf(document);
  const textOf = (row: number, col: number): string | undefined => sheet.rows.find((one) => one.row === row)?.cells.find((cell) => cell.col === col)?.text;

  it('takes the header of a KEEP layout from the layout, with its merges, because the PDF has no template', () => {
    expect(document.headerMode).toBe('KEEP');
    expect(textOf(2, 3)).toBe('Plan');
    expect(textOf(3, 3)).toBe('Year');
    expect(textOf(2, 1)).toBe('STT');
    const planGroup = sheet.rows.find((row) => row.row === 2)?.cells.find((cell) => cell.col === 3);
    expect(planGroup?.colSpan).toBe(2);
    expect(planGroup?.header).toBe(true);
    const no = sheet.rows.find((row) => row.row === 2)?.cells.find((cell) => cell.col === 1);
    expect(no?.rowSpan).toBe(2);
  });

  it('evaluates the formulas of a grown data block and writes numbers in the format of the cell', () => {
    // Three records in two reserved lines: the block grew by one row, the total sits below the third.
    const total = document.grid.rows.find((row) => row.kind === 'TOTAL')?.row as number;
    expect(total).toBe(7);
    expect(textOf(total, 3)).toBe('4.500');
    expect(textOf(total, 4)).toBe('2.250');
    expect(textOf(total, 5)).toBe('50,0');
    expect(sheet.unevaluated).toEqual([]);
  });

  it('carries the hash of the layout, the same for the same layout and another for another', () => {
    expect(document.layoutSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(layoutHashOf(LAYOUT, null)).toBe(document.layoutSha256);
    expect(layoutHashOf({ ...LAYOUT, version: '2' }, null)).not.toBe(document.layoutSha256);
    // The order of the keys of an object does not change the hash.
    const reverse = (value: unknown): unknown => (Array.isArray(value) ? value.map(reverse) : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reverse(member)])) : value);
    const reordered = reverse(LAYOUT) as ReportLayout;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(LAYOUT)[0]);
    expect(layoutHashOf(reordered, null)).toBe(document.layoutSha256);
  });

  it('reports a formula it cannot evaluate and prints the cell empty, never a number it made up', () => {
    const broken: ReportLayout = { ...LAYOUT, body: [{ kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'FORMULA', formula: 'VLOOKUP(A1,A1:B2,2)' } }] }] };
    validateLayout(broken);
    const made = documentSheetOf(formDocumentOf(broken, null, DATA));
    expect(made.unevaluated).toEqual([cellRef(4, 1)]);
    expect(made.rows.find((row) => row.row === 4)?.cells[0]?.text).toBe('');
  });

  it('keeps one sheet row per grid row so the writers agree on the number of rows', () => {
    expect(sheet.rows.map((row) => row.row)).toEqual(document.grid.rows.map((row) => row.row));
  });
});

describe('the weekly form of the public edition as a document', () => {
  it('is a WRITE layout: the header words are in the grid and the document adds none of its own', () => {
    const document = formDocumentOf(DIS_WEEKLY_LAYOUT, null, { period: { kind: 'AS_OF', year: 2026, day: '2026-11-08' }, meta: { ORG_NAME: 'Org', SNAPSHOT_LINE: 'Line' }, definitions: {}, figures: [], datasets: {} });
    expect(document.headerMode).toBe('WRITE');
    expect(document.headerCells.length).toBeGreaterThan(0);
    const sheet = documentSheetOf(document);
    expect(sheet.rows[0]?.cells[0]?.text).toBeDefined();
  });
});

describe('number formats and narrative lines', () => {
  it('reads the places, the grouping and the percent of an Excel format', () => {
    expect(numFmtShape('#,##0.0')).toEqual({ decimals: 1, grouped: true, percent: false, general: false });
    expect(numFmtShape('0.00%')).toEqual({ decimals: 2, grouped: false, percent: true, general: false });
    expect(numFmtShape(undefined).general).toBe(true);
  });

  it('writes a number the way the sheet shows it in each locale', () => {
    expect(formatSheetNumber(1234567.891, '#,##0.00', 'vi')).toBe('1.234.567,89');
    expect(formatSheetNumber(1234567.891, '#,##0.00', 'en')).toBe('1,234,567.89');
    expect(formatSheetNumber(0.256, '0.0%', 'vi')).toBe('25,6%');
    expect(formatSheetNumber(1234.5, '0', 'vi')).toBe('1235');
    expect(formatSheetNumber(12.5, undefined, 'vi')).toBe('12,5');
    expect(formatSheetNumber(-0.0001, '#,##0.0', 'vi')).toBe('0,0');
  });

  it('lists the lines of a narrative in reading order', () => {
    const lines = narrativeLinesOf({
      blocks: [
        { type: 'HEADING', level: 1, text: 'H' },
        { type: 'PARAGRAPH', text: 'P' },
        { type: 'LIST', ordered: false, items: ['i1', 'i2'] },
        { type: 'TABLE', header: ['a', 'b'], rows: [['1', '2']] },
        { type: 'SIGNATURES', slots: [{ role: 'x', name: null }, { role: 'y', name: null }] },
        { type: 'PAGE_BREAK' },
      ],
      issues: [],
    });
    expect(lines).toEqual(['H', 'P', 'i1', 'i2', 'a | b', '1 | 2', 'x | y']);
    expect(narrativeLinesOf(null)).toEqual([]);
  });
});

describe('the preview of a document shows values, not formulas, and keeps the merges (DEMO-04)', () => {
  const preview = previewOfDocument(formDocumentOf(LAYOUT, null, DATA));
  const cell = (row: number, col: number) => preview.rows.find((one) => one.row === row)?.cells.find((one) => one.col === col);

  it('evaluates the rate formula of the total row and writes it with its one decimal and the thousands grouped', () => {
    const total = preview.rows.find((one) => one.kind === 'TOTAL');
    expect(total).toBeDefined();
    const row = total?.row ?? 0;
    expect(cell(row, 3)?.text).toBe('4.500');
    expect(cell(row, 4)?.text).toBe('2.250');
    expect(cell(row, 5)?.text).toBe('50,0');
    for (const one of preview.rows) for (const shown of one.cells) expect(shown.text.startsWith('=')).toBe(false);
  });

  it('gives a merged cell its span, so the title is not squeezed into one column', () => {
    expect(cell(1, 1)?.text).toBe('Report');
    expect(cell(1, 1)?.col_span).toBe(5);
    expect(preview.columns).toBe(5);
    expect(cell(1, 2)?.col_span).toBeUndefined();
  });

  it('leaves a formula it cannot evaluate empty and never prints its text', () => {
    const broken: ReportLayout = { ...LAYOUT, body: [{ kind: 'TOTAL', cells: [{ col: 3, binding: { kind: 'FORMULA', formula: 'NOSUCH(A1)' }, format: { numFmt: '#,##0' } }] }] };
    const shown = previewOfDocument(formDocumentOf(broken, null, DATA));
    const texts = shown.rows.flatMap((one) => one.cells.map((c) => c.text));
    expect(texts.some((text) => text.includes('NOSUCH'))).toBe(false);
  });
});
