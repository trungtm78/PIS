import { DIS_WEEKLY_LAYOUT, dataRowOf, headerRowsOf } from '@machvon/kernel';
import type { LayoutColumn, NarrativeBlock, ReportFillData, ReportLayout } from '@machvon/kernel';
import { PDFDocument } from 'pdf-lib';
import { sha256Hex } from '../../src/modules/reports/digest';
import { buildBlankTemplate } from '../../src/modules/reports/blank-template';
import { disagreements, writeAll } from './three-writers';

/** The PDF writer of the report engine (ENT-4b): the weekly form of the public edition, a form long enough to need several pages, and the rules of the writer. */

const ISSUED_AT = new Date(Date.UTC(2026, 10, 8, 0, 0, 0));

describe('the weekly report of the public edition in three files', () => {
  it('UAT-PLAN-3410: agrees across the workbook and the PDF, and the header words are written by the grid (WRITE)', async () => {
    const data: ReportFillData = {
      period: { kind: 'AS_OF', year: 2026, day: '2026-11-08' },
      meta: { ORG_NAME: 'Organisation', SNAPSHOT_LINE: 'Snapshot line' },
      definitions: {},
      figures: [],
      datasets: {},
    };
    const made = await writeAll({ layout: DIS_WEEKLY_LAYOUT, narrative: null, data, template: await buildBlankTemplate(DIS_WEEKLY_LAYOUT), issuedAt: ISSUED_AT });
    expect(await disagreements(made)).toEqual([]);
    expect(made.pdf.plan.pages).toBe(1);
    expect(made.document.stamp).toBeNull();
    expect(made.drawn.some((text) => text.startsWith('Organisation'))).toBe(true);
  });
});

const COLUMNS: LayoutColumn[] = [
  { col: 1, key: 'no', header: ['No'], width: 6 },
  { col: 2, key: 'name', header: ['Project'], width: 40 },
  { col: 3, key: 'plan', header: ['Plan', 'Year'], width: 14, format: { kind: 'NUMBER', decimals: 0 } },
  { col: 4, key: 'done', header: ['Plan', 'Done'], width: 14, format: { kind: 'NUMBER', decimals: 0 } },
];
const LONG: ReportLayout = {
  code: 'LONG-FORM',
  name: 'Long form',
  version: '1',
  status: 'READY',
  formRef: null,
  sheetName: 'S',
  moneyScale: 'VND',
  headerMode: 'WRITE',
  columns: COLUMNS,
  preface: [{ kind: 'TITLE', cells: [{ col: 1, binding: { kind: 'TEXT', text: 'Long form title' }, colSpan: 4 }] }],
  body: [
    dataRowOf('rows', COLUMNS, { capacity: 1, numbered: 'no' }),
    { kind: 'TOTAL', cells: [{ col: 2, binding: { kind: 'TEXT', text: 'Total' } }, { col: 3, binding: { kind: 'FORMULA', formula: 'SUM(C{first:rows}:C{last:rows})' }, format: { numFmt: '#,##0' } }] },
    { kind: 'NOTE', cells: [{ col: 1, binding: { kind: 'TEXT', text: 'A note that is long enough to be written over several lines of the merged cell because it keeps going, and going, and going, and going, and going, and going, and going on.' + ' and on and on'.repeat(30) }, colSpan: 4 }] },
  ],
};
const NARRATIVE: NarrativeBlock[] = [
  { type: 'HEADING', level: 1, text: 'Narrative' },
  { type: 'PARAGRAPH', text: 'First paragraph.' },
  { type: 'LIST', ordered: true, items: ['one', 'two'] },
  { type: 'PAGE_BREAK' },
  { type: 'PARAGRAPH', text: 'After the break.' },
  { type: 'SIGNATURES', slots: [{ role: 'Preparer', name: null }, { role: 'Approver', name: null }] },
];
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `Project ${index + 1}`, plan: String(1000 + index), done: String(index) }));
const dataOf = (count: number): ReportFillData => ({ period: { kind: 'MONTH', year: 2026, index: 10 }, meta: {}, definitions: {}, figures: [], datasets: { rows: rows(count) } });

describe('a form that needs several pages', () => {
  it('repeats the header of the table on each page it continues on, keeps the pages in order and agrees with the workbook', async () => {
    const template = await buildBlankTemplate(LONG);
    const started = Date.now();
    const made = await writeAll({ layout: LONG, narrative: NARRATIVE, data: dataOf(120), template, issuedAt: ISSUED_AT });
    // The budget of the customer for a report is 20 seconds (HT.05, docs/qa/perf-budget.json); all three files of a long form are far inside it.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await disagreements(made)).toEqual([]);
    expect(made.pdf.plan.sheetPages).toBeGreaterThan(2);
    const headerRowNumbers = new Set(made.document.grid.rows.filter((row) => row.kind === 'HEADER').map((row) => row.row));
    const headerPages = new Set(made.pdf.plan.cells.filter((cell) => headerRowNumbers.has(cell.row)).map((cell) => cell.page));
    expect(headerPages.size).toBe(made.pdf.plan.sheetPages);
    // The narrative starts on a page of its own after the sheet and its page break makes one more.
    expect(made.pdf.plan.narrative[0]?.page).toBe(made.pdf.plan.sheetPages + 1);
    expect(made.pdf.plan.narrative[made.pdf.plan.narrative.length - 1]?.page).toBe(made.pdf.plan.sheetPages + 2);
    expect(made.pdf.plan.pages).toBe(made.pdf.plan.sheetPages + 2);
    const loaded = await PDFDocument.load(made.pdf.bytes);
    expect(loaded.getPageCount()).toBe(made.pdf.plan.pages);
  }, 120_000);

  it('writes a long note over several lines inside its merged cell and numbers the pages', async () => {
    const made = await writeAll({ layout: LONG, narrative: null, data: dataOf(2), template: await buildBlankTemplate(LONG), issuedAt: ISSUED_AT });
    const note = made.pdf.plan.cells.find((cell) => cell.lines.join(' ').startsWith('A note that is long'));
    expect(note?.lines.length).toBeGreaterThan(1);
    expect(made.drawn).toContain('Trang 1/1');
  });

  it('gives the same bytes for the same document and other bytes for other data', async () => {
    const template = await buildBlankTemplate(LONG);
    const one = await writeAll({ layout: LONG, narrative: null, data: dataOf(3), template, issuedAt: ISSUED_AT });
    const two = await writeAll({ layout: LONG, narrative: null, data: dataOf(3), template, issuedAt: ISSUED_AT });
    const three = await writeAll({ layout: LONG, narrative: null, data: dataOf(4), template, issuedAt: ISSUED_AT });
    expect(sha256Hex(one.pdf.bytes)).toBe(sha256Hex(two.pdf.bytes));
    expect(sha256Hex(three.pdf.bytes)).not.toBe(sha256Hex(one.pdf.bytes));
    expect(headerRowsOf(LONG.columns)).toHaveLength(2);
  });

  it('draws every text inside the printable box of its page', async () => {
    const made = await writeAll({ layout: LONG, narrative: NARRATIVE, data: dataOf(120), template: await buildBlankTemplate(LONG), issuedAt: ISSUED_AT });
    expect(made.placed.length).toBeGreaterThan(100);
    for (const one of made.placed) {
      expect(one.x).toBeGreaterThanOrEqual(27);
      expect(one.y).toBeGreaterThanOrEqual(27);
      expect(one.y + one.size).toBeLessThanOrEqual(one.pageHeight - 20);
    }
  }, 120_000);

  it('is told apart from a workbook that disagrees: a changed number in the workbook shows up', async () => {
    const made = await writeAll({ layout: LONG, narrative: null, data: dataOf(3), template: await buildBlankTemplate(LONG), issuedAt: ISSUED_AT });
    const cell = made.workbook.cells.C4;
    expect(cell?.value).toBe(1000);
    // The check can fail: with another number in the workbook the cell map no longer agrees.
    made.workbook.cells.C4 = { ...(cell as NonNullable<typeof cell>), value: 999 };
    const found = await disagreements(made);
    expect(found.some((one) => one.where === 'xlsx C4')).toBe(true);
  });
});
