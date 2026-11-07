import ExcelJS from 'exceljs';
import { dataRowOf } from '@machvon/kernel';
import type { LayoutColumn, ReportFillData, ReportLayout } from '@machvon/kernel';

/**
 * The fixtures of the report engine tests. The template is built here, with ExcelJS, so that the tests need no binary file: a small form with merged title and header cells, a two-level header, two reserved lines with
 * borders, formats and a formula of their own row, a total row with a formula, a note row, a signature block below (the part that has to move when the data block grows), a conditional format, a validation, a print area,
 * column widths and row heights.
 */
export const SHEET = 'Bao cao';

const THIN = { style: 'thin', color: { argb: 'FF000000' } } as const;
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };

export async function buildTemplate(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(Date.UTC(2020, 0, 1));
  const sheet = workbook.addWorksheet(SHEET);
  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 34;
  for (const column of [3, 4, 5]) sheet.getColumn(column).width = 16;
  sheet.getColumn(6).width = 14;

  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = 'TEMPLATE TITLE';
  sheet.getCell('A1').font = { name: 'Times New Roman', size: 14, bold: true };
  sheet.getCell('A1').alignment = { horizontal: 'center' };
  sheet.mergeCells('A2:C2');
  sheet.mergeCells('D2:F2');
  sheet.getCell('D2').alignment = { horizontal: 'right' };

  // Header rows 3-4 (two levels).
  sheet.mergeCells('A3:A4');
  sheet.mergeCells('B3:B4');
  sheet.mergeCells('C3:D3');
  sheet.mergeCells('E3:E4');
  sheet.mergeCells('F3:F4');
  const headers: Array<[string, string]> = [['A3', 'STT'], ['B3', 'Dự án'], ['C3', 'Kế hoạch'], ['C4', 'Vốn NSNN'], ['D4', 'Vốn khác'], ['E3', 'Giải ngân'], ['F3', 'Khởi công']];
  for (const [address, text] of headers) sheet.getCell(address).value = text;
  for (let row = 3; row <= 4; row += 1) {
    for (let column = 1; column <= 6; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.border = BOX;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      cell.font = { name: 'Times New Roman', size: 12, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
  }
  sheet.getRow(3).height = 24;

  // Two reserved data lines (5-6); a sample value that must never survive, and a formula of the line's own row in G.
  for (const row of [5, 6]) {
    for (let column = 1; column <= 7; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.border = BOX;
      cell.font = { name: 'Times New Roman', size: 12 };
    }
    sheet.getCell(row, 2).value = 'MẪU';
    sheet.getCell(row, 2).alignment = { wrapText: true };
    sheet.getCell(row, 3).numFmt = row === 5 ? '#,##0' : '0.00';
    sheet.getCell(row, 4).numFmt = '#,##0';
    sheet.getCell(row, 7).value = { formula: `C${row}-D${row}`, result: 0 };
  }
  sheet.getCell('F5').alignment = { horizontal: 'center' };
  sheet.getCell('F6').alignment = { horizontal: 'center' };

  // Total row 7 (tall, bold, with a formula that the layout rewrites).
  for (let column = 1; column <= 7; column += 1) {
    const cell = sheet.getCell(7, column);
    cell.border = BOX;
    cell.font = { name: 'Times New Roman', size: 12, bold: true };
    cell.numFmt = column === 3 || column === 4 ? '#,##0' : 'General';
  }
  sheet.getCell('D7').value = { formula: 'SUM(D5:D6)', result: 0 };
  sheet.getRow(7).height = 30;

  // Note row 8 and the signature block (rows 10-11), below the data block.
  sheet.getCell('B8').font = { name: 'Times New Roman', size: 11, italic: true };
  sheet.mergeCells('A10:C10');
  sheet.mergeCells('D10:F10');
  sheet.getCell('A10').value = 'Người lập';
  sheet.getCell('D10').value = 'Người duyệt';
  for (const address of ['A10', 'D10']) sheet.getCell(address).alignment = { horizontal: 'center' };
  for (const address of ['A10', 'B10', 'C10']) sheet.getCell(address).border = { bottom: THIN };
  sheet.getCell('F11').value = { formula: 'D7*1', result: 0 };

  sheet.addConditionalFormatting({ ref: 'D5:D6', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 1, style: { font: { bold: true } } }] });
  sheet.getCell('C5').dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], allowBlank: true };
  sheet.getCell('C6').dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], allowBlank: true };
  sheet.pageSetup.printArea = 'A1:F12';

  // A second sheet that the writer must not touch.
  const other = workbook.addWorksheet('Ghi chu');
  other.getCell('A1').value = 'Untouched';
  other.getCell('A1').font = { bold: true };

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export const COLUMNS: LayoutColumn[] = [
  { col: 1, key: 'stt', header: ['STT'] },
  { col: 2, key: 'name', header: ['Dự án'] },
  { col: 3, key: 'plan', header: ['Kế hoạch', 'Vốn NSNN'], format: { scale: 'MILLION_VND' } },
  { col: 4, key: 'plan_other', header: ['Kế hoạch', 'Vốn khác'], format: { scale: 'MILLION_VND' } },
  { col: 5, key: 'done', header: ['Giải ngân'], format: { scale: 'MILLION_VND', decimals: 1 } },
  { col: 6, key: 'start', header: ['Khởi công'], format: { kind: 'DATE' } },
];

export const layout = (overrides: Partial<ReportLayout> = {}): ReportLayout => ({
  code: 'MONTHLY-GROUP',
  name: 'Báo cáo tháng gửi Tập đoàn',
  version: '1',
  status: 'READY',
  formRef: null,
  sheetName: SHEET,
  moneyScale: 'MILLION_VND',
  headerMode: 'KEEP',
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
      ],
    },
    { kind: 'NOTE', cells: [{ col: 2, binding: { kind: 'INDICATOR', code: 'HOME-01' }, format: { decimals: 1 } }] },
  ],
  ...overrides,
});

export const PROJECTS = [
  { name: 'Dự án A', plan: '1500000000', plan_other: '250000000', done: '1234567890', start: '2026-03-05' },
  { name: 'Dự án B', plan: '500000000', plan_other: null, done: '999999999', start: null },
  { name: 'Dự án C', plan: '1000000', plan_other: '1000000', done: '0', start: '2026-10-31' },
  { name: 'Dự án D', plan: '2000000000', plan_other: '3000000', done: '1', start: '2026-01-02' },
];

export const data = (records = PROJECTS.length, overrides: Partial<ReportFillData> = {}): ReportFillData => ({
  period: { kind: 'MONTH', year: 2026, index: 10 },
  meta: { ORG_NAME: 'Công ty Cổ phần Phân bón Dầu khí Cà Mau' },
  definitions: { 'HOME-01': { code: 'HOME-01', name: 'Tỷ lệ giải ngân', unit: 'PERCENT', decimals: 2, period: 'YEAR_TO_DATE', version: 3 } },
  figures: [{ code: 'HOME-01', basis: 'YEAR_TO_DATE', value: '61.2345' }],
  datasets: { projects: PROJECTS.slice(0, records) },
  ...overrides,
});
