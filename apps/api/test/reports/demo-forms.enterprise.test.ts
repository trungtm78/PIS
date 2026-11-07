import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { DEMO_MARK, REPORT_FORM_CATALOGUE, assertLayoutIssuable, cellRef, columnLetters, fillGrid, fillNarrative, headerRowsOf, issueMarksOf } from '@machvon/kernel';
import { DEMO_FORMS, demoFormOf, illustrativeFillData, templateFileName } from '@machvon/edition-enterprise/src/server.ts';
import type { DemoFormSpec } from '@machvon/edition-enterprise/src/server.ts';
import { readDocxHeaderFooter, readDocxParagraphs, renderDocx } from '../../src/modules/reports/docx-render';
import { sha256Hex } from '../../src/modules/reports/digest';
import { fillXlsxTemplate, readXlsxMap, readXlsxMarks } from '../../src/modules/reports/xlsx-template';
import type { XlsxSheetMap } from '../../src/modules/reports/xlsx-template';

/**
 * The demo forms of the enterprise edition through the report writers (RPT-1): each committed template (packages/edition-enterprise/templates/demo) is filled with the illustrative data (invented projects, labelled so)
 * and read back, and the file is held to the grid: every cell, every merge, the number formats, the print area, and the demo mark in the print header and footer, in the properties and in the first cell. The name of this
 * file ends in `.enterprise.test.ts`: it is one of the few sources that may name the enterprise package.
 */

const TEMPLATE_DIR = join(__dirname, '..', '..', '..', '..', 'packages', 'edition-enterprise', 'templates', 'demo');
const ISSUED_AT = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));
const MONTH = { kind: 'MONTH', year: 2026, index: 10 } as const;
const QUARTER = { kind: 'QUARTER', year: 2026, index: 3 } as const;
const periodOf = (form: DemoFormSpec) => (REPORT_FORM_CATALOGUE.find((entry) => entry.code === form.layout.code)?.period === 'QUARTER' ? QUARTER : MONTH);
const templateOf = (code: string, kind: 'xlsx' | 'docx' = 'xlsx'): Uint8Array => new Uint8Array(readFileSync(join(TEMPLATE_DIR, templateFileName(code, kind))));

const onlySheet = (maps: XlsxSheetMap[]): XlsxSheetMap => maps[0] as XlsxSheetMap;

describe.each(DEMO_FORMS.map((form) => [form.layout.code, form] as const))('the demo form %s filled into its template', (_code, form) => {
  const data = illustrativeFillData(form, periodOf(form));
  const grid = fillGrid(form.layout, data);
  let out: Uint8Array;
  let templateMap: XlsxSheetMap;
  let map: XlsxSheetMap;

  beforeAll(async () => {
    templateMap = onlySheet(await readXlsxMap(templateOf(form.layout.code)));
    out = await fillXlsxTemplate(templateOf(form.layout.code), grid, { issuedAt: ISSUED_AT });
    map = onlySheet(await readXlsxMap(out));
  });

  it('holds every cell of the grid: words, numbers, formulas and cleared cells', () => {
    for (const cell of grid.cells) {
      const entry = map.cells[cellRef(cell.row, cell.col)];
      switch (cell.kind) {
        case 'TEXT':
          expect({ ref: cellRef(cell.row, cell.col), value: entry?.value }).toEqual({ ref: cellRef(cell.row, cell.col), value: cell.text });
          break;
        case 'NUMBER':
          expect({ ref: cellRef(cell.row, cell.col), value: entry?.value }).toEqual({ ref: cellRef(cell.row, cell.col), value: Number(cell.number) });
          expect(entry?.numFmt).toBe(cell.numFmt);
          break;
        case 'FORMULA':
          expect({ ref: cellRef(cell.row, cell.col), formula: entry?.formula }).toEqual({ ref: cellRef(cell.row, cell.col), formula: cell.formula });
          break;
        case 'EMPTY':
          expect({ ref: cellRef(cell.row, cell.col), value: entry?.value ?? null }).toEqual({ ref: cellRef(cell.row, cell.col), value: null });
          break;
      }
    }
  });

  it('keeps the header of the template, moves the merges with the rows and ends the print area at the last row', async () => {
    const preface = form.layout.preface.length;
    headerRowsOf(form.layout.columns).forEach((row, level) => {
      for (const cell of row.cells) {
        const ref = cellRef(preface + 1 + level, cell.col);
        expect(map.cells[ref]?.value).toBe((cell.binding as { text: string }).text);
        expect(templateMap.cells[ref]?.value).toBe((cell.binding as { text: string }).text);
      }
    });
    // Every merge of the form is there, at its row after the data blocks grew, and there is no other.
    // The header belongs to the template (the layout says KEEP), so its merges are the template's own, above the data and never moved.
    const headerRows = [preface + 1, preface + 2];
    const headerMerges = templateMap.merges.filter((range) => headerRows.includes(Number(/\d+/.exec(range)?.[0])));
    expect(headerMerges.length).toBeGreaterThan(8);
    const expected = [...grid.merges.map((merge) => `${cellRef(merge.fromRow, merge.fromCol)}:${cellRef(merge.toRow, merge.toCol)}`), ...headerMerges].sort();
    expect(map.merges).toEqual(expected);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(out) as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
    expect(sheet.pageSetup.printArea).toBe(`A1:${columnLetters(form.layout.columns.length)}${grid.rows.length}`);
    expect(sheet.pageSetup.paperSize).toBe(8);
    expect(sheet.pageSetup.orientation).toBe('landscape');
    expect(sheet.pageSetup.printTitlesRow).toBe(`${preface + 1}:${preface + 2}`);
    expect(templateMap.columnWidths).toEqual(map.columnWidths);
  });

  it('keeps the look of the data lines for the lines it added', () => {
    const dataRows = grid.rows.filter((row) => row.kind === 'DATA');
    const last = dataRows.filter((row) => row.inserted).slice(-1)[0];
    if (last === undefined) return;
    const copied = grid.rows.find((row) => row.row === last.row);
    expect(copied?.inserted).toBe(true);
    const moneyCol = (form.layout.columns.find((column) => column.key === 'plan_force') as { col: number }).col;
    const before = map.cells[cellRef(last.templateRow, moneyCol)];
    const added = map.cells[cellRef(last.row, moneyCol)];
    expect(added?.style).toBe(before?.style);
    expect(added?.numFmt).toBe('#,##0');
  });

  it('carries the demo mark in the first cell, the print header and footer and the properties, once', async () => {
    expect(map.cells.A1?.value).toBe(DEMO_MARK);
    const marks = await readXlsxMarks(out);
    expect(marks.subject).toBe(DEMO_MARK);
    expect(marks.description.split(DEMO_MARK)).toHaveLength(2);
    expect(marks.sheets[0]?.oddHeader.split(DEMO_MARK)).toHaveLength(2);
    expect(marks.sheets[0]?.oddFooter.split(DEMO_MARK)).toHaveLength(2);
    expect(grid.stamp).toBe(DEMO_MARK);
  });

  it('gives the same bytes for the same inputs', async () => {
    const again = await fillXlsxTemplate(templateOf(form.layout.code), fillGrid(form.layout, data), { issuedAt: ISSUED_AT });
    expect(sha256Hex(again)).toBe(sha256Hex(out));
  });

  it('cannot be issued in official mode, and carries its mark in the issued-copy metadata in demo mode', () => {
    expect(() => assertLayoutIssuable(form.layout)).toThrow(expect.objectContaining({ code: 'TEMPLATE_UNCONFIRMED', detail: 'demo_forms_off' }));
    expect(issueMarksOf(form.layout, { demoMode: true })).toEqual({ formStatus: 'DEMO', demoMark: DEMO_MARK });
  });
});

describe('the Word narrative of the demo forms', () => {
  for (const form of DEMO_FORMS.filter((candidate) => candidate.narrative !== null)) {
    it(`${form.layout.code}: renders with the figures of the register, the mark in every header and footer, and the same bytes twice`, async () => {
      const data = illustrativeFillData(form, periodOf(form));
      const grid = fillGrid(form.layout, data);
      const filled = fillNarrative(form.narrative ?? [], data, form.layout.moneyScale);
      expect(filled.issues).toEqual([]);
      const options = { title: form.layout.name, creator: 'MACHVON', issuedAt: ISSUED_AT, stamp: grid.stamp };
      const bytes = await renderDocx(filled.blocks, options);
      const paragraphs = readDocxParagraphs(bytes);
      expect(paragraphs[0]).toBe(DEMO_MARK);
      expect(paragraphs.join('\n')).not.toContain('{{');
      const { headers, footers } = readDocxHeaderFooter(bytes);
      expect(headers).toContain(DEMO_MARK);
      expect(footers.join('')).toContain(DEMO_MARK);
      expect(sha256Hex(bytes)).toBe(sha256Hex(await renderDocx(filled.blocks, options)));
      // The committed skeleton shows the same words with the tokens visible.
      const skeleton = readDocxParagraphs(templateOf(form.layout.code, 'docx'));
      expect(skeleton[0]).toBe(DEMO_MARK);
      expect(skeleton.join('\n')).toContain('{{indicator:ENT_PLAN_IN_FORCE@FULL_YEAR}}');
    });
  }

  it('is the narrative the catalogue says, for the four forms that have one', () => {
    expect((demoFormOf('PVN-QUARTERLY-F2') as DemoFormSpec).narrative).not.toBeNull();
    expect((demoFormOf('PVN-MONTHLY') as DemoFormSpec).narrative).toBeNull();
  });
});
