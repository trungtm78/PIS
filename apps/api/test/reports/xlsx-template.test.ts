import ExcelJS from 'exceljs';
import type { Buffer as ExcelBuffer } from 'exceljs';
import { zipSync } from 'fflate';
import { DEMO_MARK, DomainError, fillGrid } from '@machvon/kernel';
import { fillXlsxTemplate, parseRange, readXlsxMap, readXlsxMarks, shiftRows, translateRows } from '../../src/modules/reports/xlsx-template';
import type { XlsxSheetMap } from '../../src/modules/reports/xlsx-template';
import { sha256Hex } from '../../src/modules/reports/digest';
import { SHEET, buildTemplate, data, layout } from './template-fixture';

const failure = async (action: () => Promise<unknown> | unknown): Promise<string | undefined> => {
  try {
    await action();
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.detail ?? ''}` : String(error);
  }
  return undefined;
};

const sheetOf = (maps: XlsxSheetMap[], name = SHEET): XlsxSheetMap => {
  const map = maps.find((candidate) => candidate.name === name);
  if (map === undefined) throw new Error(`no sheet ${name}`);
  return map;
};

const ISSUED_AT = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));
const TEMPLATE_MERGES = ['A1:F1', 'A10:C10', 'A2:C2', 'A3:A4', 'B3:B4', 'C3:D3', 'D10:F10', 'D2:F2', 'E3:E4', 'F3:F4'].sort();

describe('references', () => {
  it('parses ranges', () => {
    expect(parseRange('B3:D5')).toEqual({ top: 3, left: 2, bottom: 5, right: 4 });
    expect(parseRange('$AA$10')).toEqual({ top: 10, left: 27, bottom: 10, right: 27 });
    expect(() => parseRange('3B')).toThrow(DomainError);
  });
  it('moves the references of a formula below an insertion and nothing else', () => {
    expect(shiftRows('SUM(D5:D6)', 7, 2)).toBe('SUM(D5:D6)');
    expect(shiftRows('SUM(D5:D8)+D7*$E$9', 7, 2)).toBe('SUM(D5:D10)+D9*$E$11');
    expect(shiftRows('"D9"&D9', 7, 1)).toBe('"D9"&D10');
    expect(shiftRows('Other!A9+LOG10(A9)+A9', 7, 1)).toBe('Other!A9+LOG10(A10)+A10');
    expect(shiftRows('D5:D6 F5:F9', 7, 3)).toBe('D5:D6 F5:F12');
  });
  it('copies a formula down, keeping absolute rows', () => {
    expect(translateRows('C6-D6', 1)).toBe('C7-D7');
    expect(translateRows('C6-$D$1+E$2', 2)).toBe('C8-$D$1+E$2');
  });
});

describe('fillXlsxTemplate', () => {
  let template: Uint8Array;
  let templateMap: XlsxSheetMap;
  beforeAll(async () => {
    template = await buildTemplate();
    templateMap = sheetOf(await readXlsxMap(template));
  });

  it('fills the reserved lines and keeps the layout of the template exactly', async () => {
    const grid = fillGrid(layout(), data(2));
    const out = await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT });
    const map = sheetOf(await readXlsxMap(out));

    // The values.
    expect(map.cells.A1?.value).toBe('Công ty Cổ phần Phân bón Dầu khí Cà Mau');
    expect(map.cells.A2?.value).toBe('Tháng 10 năm 2026');
    expect(map.cells.D2?.value).toBe('Đơn vị tính: triệu đồng');
    expect(map.cells.A5?.value).toBe(1);
    expect(map.cells.B5?.value).toBe('Dự án A');
    expect(map.cells.C5?.value).toBe(1500);
    expect(map.cells.D5?.value).toBe(250);
    expect(map.cells.E5?.value).toBe(1234.6);
    expect(map.cells.F5?.value).toBe('05/03/2026');
    expect(map.cells.A6?.value).toBe(2);
    expect(map.cells.B6?.value).toBe('Dự án B');
    expect(map.cells.C6?.value).toBe(500);
    expect(map.cells.D6?.value).toBeNull();
    expect(map.cells.E6?.value).toBe(1000);
    expect(map.cells.F6?.value).toBeNull();
    expect(map.cells.B7?.value).toBe('Cộng');
    expect(map.cells.C7?.value).toBe(2000);
    expect(map.cells.D7?.formula).toBe('SUM(D5:D6)');
    expect(map.cells.B8?.value).toBe(61.2);
    // The formulas of the template that the layout does not own are still there.
    expect(map.cells.G5?.formula).toBe('C5-D5');
    expect(map.cells.F11?.formula).toBe('D7*1');
    // The layout of the template: merges, widths, heights, the number formats it set, and every style.
    expect(map.merges).toEqual(TEMPLATE_MERGES);
    expect(map.columnWidths).toEqual(templateMap.columnWidths);
    expect(map.rowHeights).toEqual(templateMap.rowHeights);
    expect(map.cells.C5?.numFmt).toBe('#,##0');
    expect(map.cells.C6?.numFmt).toBe('0.00');
    expect(map.cells.E5?.numFmt).toBe('#,##0.0');
    for (const [address, entry] of Object.entries(templateMap.cells)) {
      expect({ address, style: map.cells[address]?.style }).toEqual({ address, style: entry.style });
      if (entry.mergedInto !== undefined) expect(map.cells[address]?.mergedInto).toBe(entry.mergedInto);
    }
  });

  it('writes a number format the template leaves General and keeps one the template sets, unless the layout wins', async () => {
    const grid = fillGrid(layout(), data(2));
    const keep = sheetOf(await readXlsxMap(await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT })));
    expect(keep.cells.C6?.numFmt).toBe('0.00');
    const win = sheetOf(await readXlsxMap(await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT, numFmtPolicy: 'LAYOUT_WINS' })));
    expect(win.cells.C6?.numFmt).toBe('#,##0');
  });

  it('clears a reserved line that holds no record, so the sample of the template never stays', async () => {
    const out = await fillXlsxTemplate(template, fillGrid(layout(), data(1)), { issuedAt: ISSUED_AT });
    const map = sheetOf(await readXlsxMap(out));
    expect(templateMap.cells.B6?.value).toBe('MẪU');
    expect(map.cells.B6?.value).toBeNull();
    expect(map.cells.B5?.value).toBe('Dự án A');
    expect(map.cells.C7?.value).toBe(1500);
  });

  it('grows the data block: new lines copy the style of the last reserved line, everything below moves with its merges, formulas, formats and height', async () => {
    const grid = fillGrid(layout(), data(4));
    expect(grid.rows.filter((row) => row.inserted).map((row) => row.row)).toEqual([7, 8]);
    const out = await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT });
    const map = sheetOf(await readXlsxMap(out));

    // Records in rows 5-8, the total in row 9, the note in row 10.
    expect([5, 6, 7, 8].map((row) => map.cells[`B${row}`]?.value)).toEqual(['Dự án A', 'Dự án B', 'Dự án C', 'Dự án D']);
    expect([5, 6, 7, 8].map((row) => map.cells[`A${row}`]?.value)).toEqual([1, 2, 3, 4]);
    expect(map.cells.C9?.value).toBe(4001);
    expect(map.cells.D9?.formula).toBe('SUM(D5:D8)');
    expect(map.cells.B9?.value).toBe('Cộng');
    expect(map.cells.B10?.value).toBe(61.2);
    // The new lines have the look of the line they copy (borders, fonts, alignment), a formula of their own row, and no sample.
    for (const column of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect({ column, style: map.cells[`${column}7`]?.style }).toEqual({ column, style: templateMap.cells[`${column}6`]?.style });
      expect({ column, style: map.cells[`${column}8`]?.style }).toEqual({ column, style: templateMap.cells[`${column}6`]?.style });
    }
    expect(map.cells.G7?.formula).toBe('C7-D7');
    expect(map.cells.G8?.formula).toBe('C8-D8');
    expect(map.cells.F7?.value).toBe('31/10/2026');
    // What was below the block moved down by two: the total row (look, height), the signature block (merges), and the formula that points at the total.
    for (const column of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect({ column, style: map.cells[`${column}9`]?.style }).toEqual({ column, style: templateMap.cells[`${column}7`]?.style });
    }
    expect(map.rowHeights['9']).toBe(30);
    expect(map.rowHeights['7']).toBeUndefined();
    expect(map.cells.A12?.value).toBe('Người lập');
    expect(map.cells.D12?.value).toBe('Người duyệt');
    expect(map.cells.F13?.formula).toBe('D9*1');
    expect(map.merges).toEqual(['A1:F1', 'A12:C12', 'A2:C2', 'A3:A4', 'B3:B4', 'C3:D3', 'D12:F12', 'D2:F2', 'E3:E4', 'F3:F4'].sort());
    expect(map.cells.B12?.mergedInto).toBe('A12');
    expect(map.cells.B12?.style).toBe(templateMap.cells.B10?.style);
    // The header is untouched.
    for (const address of ['A3', 'C3', 'C4', 'D4', 'E3']) expect(map.cells[address]).toEqual(templateMap.cells[address]);
    expect(map.columnWidths).toEqual(templateMap.columnWidths);
  });

  it('moves the print area, the conditional formats and the validations with the rows', async () => {
    const out = await fillXlsxTemplate(template, fillGrid(layout(), data(4)), { issuedAt: ISSUED_AT });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(out) as unknown as ExcelBuffer);
    const sheet = workbook.getWorksheet(SHEET);
    expect(sheet?.pageSetup.printArea).toBe('A1:F14');
    const validations = (sheet as unknown as { dataValidations: { model: Record<string, unknown> } }).dataValidations.model;
    expect(Object.keys(validations).sort()).toEqual(['C5', 'C6', 'C7', 'C8']);
    const formats = (sheet as unknown as { conditionalFormattings: Array<{ ref: string }> }).conditionalFormattings;
    expect(formats.map((format) => format.ref)).toEqual(['D5:D6']);
  });

  it('leaves the other sheets as they are', async () => {
    const out = await fillXlsxTemplate(template, fillGrid(layout(), data(4)), { issuedAt: ISSUED_AT });
    const maps = await readXlsxMap(out);
    expect(sheetOf(maps, 'Ghi chu')).toEqual(sheetOf(await readXlsxMap(template), 'Ghi chu'));
  });

  it('writes the header when the layout says WRITE', async () => {
    const grid = fillGrid(layout({ headerMode: 'WRITE' }), data(2));
    const map = sheetOf(await readXlsxMap(await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT })));
    expect(map.cells.C3?.value).toBe('Kế hoạch');
    expect(map.cells.D4?.value).toBe('Vốn khác');
    expect(map.merges).toEqual(TEMPLATE_MERGES);
  });

  it('sets the width of a column that the template leaves without one', async () => {
    const wide = layout({ columns: [{ col: 8, key: 'extra', header: ['Ghi chú'], width: 22 }], body: [] });
    const grid = fillGrid({ ...wide, preface: [], startRow: 20, headerMode: 'KEEP' }, data(0));
    const map = sheetOf(await readXlsxMap(await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT })));
    expect(map.columnWidths.H).toBe(22);
    expect(map.columnWidths.B).toBe(templateMap.columnWidths.B);
  });

  it('gives the same bytes and the same sha256 for the same template and grid, and other bytes for another period', async () => {
    const grid = fillGrid(layout(), data(3));
    const first = await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT });
    const second = await fillXlsxTemplate(template, grid, { issuedAt: ISSUED_AT });
    expect(sha256Hex(first)).toBe(sha256Hex(second));
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
    const other = await fillXlsxTemplate(template, fillGrid(layout(), data(3, { period: { kind: 'MONTH', year: 2026, index: 11 } })), { issuedAt: ISSUED_AT });
    expect(sha256Hex(other)).not.toBe(sha256Hex(first));
    const later = await fillXlsxTemplate(template, grid, { issuedAt: new Date(ISSUED_AT.getTime() + 86_400_000) });
    expect(sha256Hex(later)).not.toBe(sha256Hex(first));
  });

  it('names the creator when it is given', async () => {
    const out = await fillXlsxTemplate(template, fillGrid(layout(), data(1)), { issuedAt: ISSUED_AT, creator: 'MACHVON' });
    const { unzipSync } = await import('fflate');
    const core = new TextDecoder().decode(unzipSync(out)['docProps/core.xml']);
    expect(core).toContain('MACHVON');
    expect(core).toContain('2026-11-08T03:00:00');
  });

  it('refuses what it cannot keep or find', async () => {
    const grid = fillGrid(layout(), data(2));
    expect(await failure(() => fillXlsxTemplate(new Uint8Array([1, 2, 3, 4]), grid))).toBe('TEMPLATE_INVALID:zip');
    expect(await failure(() => fillXlsxTemplate(zipSync({ 'readme.txt': new Uint8Array([65]) }), grid))).toBe('TEMPLATE_INVALID:xlsx');
    expect(await failure(() => fillXlsxTemplate(template, { ...grid, sheetName: 'Missing' }))).toBe('TEMPLATE_INVALID:sheet');
    const { unzipSync } = await import('fflate');
    const withChart = zipSync({ ...unzipSync(template), 'xl/charts/chart1.xml': new Uint8Array([60, 47, 62]) });
    expect(await failure(() => fillXlsxTemplate(withChart, grid))).toBe('TEMPLATE_INVALID:unsupported_parts');
    const withMacros = zipSync({ ...unzipSync(template), 'xl/vbaProject.bin': new Uint8Array([1]) });
    expect(await failure(() => fillXlsxTemplate(withMacros, grid))).toBe('TEMPLATE_INVALID:unsupported_parts');
    expect(await failure(() => readXlsxMap(new Uint8Array([1, 2, 3])))).toBe('TEMPLATE_INVALID:zip');
  });

  it('refuses a merge that cuts across a merge of the template', async () => {
    const grid = fillGrid(layout(), data(2));
    const bad = { ...grid, merges: [...grid.merges, { fromRow: 3, fromCol: 2, toRow: 3, toCol: 3 }] };
    expect(await failure(() => fillXlsxTemplate(template, bad))).toBe('TEMPLATE_INVALID:merge_conflict');
  });

  it('merges a cell the template does not merge', async () => {
    const grid = fillGrid(layout(), data(2));
    const more = { ...grid, merges: [...grid.merges, { fromRow: 8, fromCol: 2, toRow: 8, toCol: 4 }] };
    const map = sheetOf(await readXlsxMap(await fillXlsxTemplate(template, more, { issuedAt: ISSUED_AT })));
    expect(map.merges).toContain('B8:D8');
  });

  it('refuses to insert above the second row', async () => {
    const grid = fillGrid(layout({ startRow: 1, preface: [], columns: [], body: [{ kind: 'DATA', dataset: 'projects', capacity: 1, cells: [{ col: 1, binding: { kind: 'ROW_FIELD', field: 'name' } }] }] }), data(2));
    // Row 1 is reserved, the second record is inserted at row 2: allowed. A grid whose first row is inserted cannot come from a layout, so the case is forced.
    const forced = { ...grid, rows: grid.rows.map((row) => (row.row === 1 ? { ...row, inserted: true } : row)) };
    expect(await failure(() => fillXlsxTemplate(template, forced))).toBe('TEMPLATE_INVALID:insert_position');
  });
});

describe('the mark of a DEMO form (R18)', () => {
  const MARK_ROW = { kind: 'TITLE' as const, cells: [{ col: 1, colSpan: 6, binding: { kind: 'TEXT' as const, text: DEMO_MARK } }] };
  const demoLayout = () => layout({ status: 'DEMO', name: 'Báo cáo thử (mẫu demo)', preface: [MARK_ROW, ...layout().preface.slice(1)] });

  it('is written into the print header, the print footer and the properties of the file, and nowhere for an official form', async () => {
    const template = await buildTemplate();
    const official = await readXlsxMarks(await fillXlsxTemplate(template, fillGrid(layout(), data(2)), { issuedAt: ISSUED_AT }));
    expect(official).toEqual({ subject: '', description: '', sheets: [{ name: SHEET, oddHeader: '', oddFooter: '' }, { name: 'Ghi chu', oddHeader: '', oddFooter: '' }] });

    const out = await fillXlsxTemplate(template, fillGrid(demoLayout(), data(2)), { issuedAt: ISSUED_AT });
    const marks = await readXlsxMarks(out);
    expect(marks.subject).toBe(DEMO_MARK);
    expect(marks.description).toBe(DEMO_MARK);
    expect(marks.sheets[0]?.oddHeader).toBe(`&C&"Times New Roman,Bold"&KC00000${DEMO_MARK}`);
    expect(marks.sheets[0]?.oddFooter).toBe(`&L&"Times New Roman,Bold"&KC00000${DEMO_MARK}`);
    // The other sheet is not touched.
    expect(marks.sheets[1]?.oddHeader).toBe('');
    expect(sheetOf(await readXlsxMap(out)).cells.A1?.value).toBe(DEMO_MARK);
  });

  it('is not repeated when the same file is filled again, and keeps what the template prints', async () => {
    const template = await buildTemplate();
    const once = await fillXlsxTemplate(template, fillGrid(demoLayout(), data(2)), { issuedAt: ISSUED_AT });
    const twice = await fillXlsxTemplate(once, fillGrid(demoLayout(), data(2)), { issuedAt: ISSUED_AT });
    const marks = await readXlsxMarks(twice);
    expect(marks.sheets[0]?.oddHeader.split(DEMO_MARK)).toHaveLength(2);
    expect(marks.sheets[0]?.oddFooter.split(DEMO_MARK)).toHaveLength(2);
    expect(marks.description.split(DEMO_MARK)).toHaveLength(2);

    // A template with its own header and footer keeps them, the mark is added to the centre and the left.
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(template) as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet(SHEET) as ExcelJS.Worksheet;
    sheet.headerFooter = { oddHeader: '&CCông ty&RTrang &P', oddFooter: '&RSố trang' };
    workbook.description = 'Mẫu của khách hàng';
    const own = new Uint8Array(await workbook.xlsx.writeBuffer());
    const merged = await readXlsxMarks(await fillXlsxTemplate(own, fillGrid(demoLayout(), data(2)), { issuedAt: ISSUED_AT }));
    expect(merged.sheets[0]?.oddHeader).toBe(`&C&"Times New Roman,Bold"&KC00000${DEMO_MARK} — Công ty&RTrang &P`);
    expect(merged.sheets[0]?.oddFooter).toBe(`&L&"Times New Roman,Bold"&KC00000${DEMO_MARK}&RSố trang`);
    expect(merged.description).toBe(`${DEMO_MARK}. Mẫu của khách hàng`);
  });

  it('gives the same bytes for the same inputs', async () => {
    const template = await buildTemplate();
    const one = await fillXlsxTemplate(template, fillGrid(demoLayout(), data(3)), { issuedAt: ISSUED_AT });
    const two = await fillXlsxTemplate(template, fillGrid(demoLayout(), data(3)), { issuedAt: ISSUED_AT });
    expect(sha256Hex(one)).toBe(sha256Hex(two));
  });

  it('refuses a file that is not a workbook when reading the marks', async () => {
    expect(await failure(() => readXlsxMarks(new Uint8Array([1, 2, 3])))).toBe('TEMPLATE_INVALID:zip');
    expect(await failure(() => readXlsxMarks(zipSync({ 'readme.txt': new Uint8Array([65]) })))).toBe('TEMPLATE_INVALID:xlsx');
  });
});
