import { PDFDocument, PDFPage } from 'pdf-lib';
import { cellRef, documentSheetOf, evaluateFormula, narrativeLinesOf, formDocumentOf } from '@machvon/kernel';
import type { FormulaValue, NarrativeBlock, ReportDocument, ReportFillData, ReportLayout } from '@machvon/kernel';
import { readDocxParagraphs, renderDocx } from '../../src/modules/reports/docx-render';
import { reportPdfOf } from '../../src/modules/reports/report-pdf';
import type { RenderedPdf } from '../../src/modules/reports/report-pdf';
import { fillXlsxTemplate, readXlsxMap } from '../../src/modules/reports/xlsx-template';
import type { XlsxSheetMap } from '../../src/modules/reports/xlsx-template';

/**
 * The check that the three writers of the report engine agree (ENT-4b, R26): the same layout and data become one document, the document becomes a workbook (in the template), a Word file and a PDF, and the three are
 * read back and held to each other: the cells (words, numbers, formulas), the words of the narrative and the number of pages. Used by the golden tests of the enterprise forms, the weekly form and a configured form.
 */
export interface ThreeWriters {
  document: ReportDocument;
  xlsx: Uint8Array;
  docx: Uint8Array | null;
  pdf: RenderedPdf;
  /** The text of every drawText call of the PDF, in order. */
  drawn: string[];
  /** Where each text was put on its page, with the size of the page, for the check that nothing is drawn outside the printable box. */
  placed: Array<{ text: string; x: number; y: number; size: number; pageWidth: number; pageHeight: number }>;
  workbook: XlsxSheetMap;
  template: XlsxSheetMap;
}

const squash = (text: string): string => text.replace(/\s+/g, '');

/** Fills the form three ways from one document. */
export async function writeAll(input: { layout: ReportLayout; narrative: readonly NarrativeBlock[] | null; data: ReportFillData; template: Uint8Array; issuedAt: Date }): Promise<ThreeWriters> {
  const document = formDocumentOf(input.layout, input.narrative, input.data);
  const xlsx = await fillXlsxTemplate(input.template, document.grid, { issuedAt: input.issuedAt, creator: 'MACHVON' });
  const docx = document.narrative === null ? null : await renderDocx(document.narrative.blocks, { title: document.name, creator: 'MACHVON', issuedAt: input.issuedAt, stamp: document.stamp, headerText: document.name });
  const drawn: string[] = [];
  const placed: ThreeWriters['placed'] = [];
  const original = PDFPage.prototype.drawText;
  const spy = jest.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, options) {
    drawn.push(text);
    const box = this.getSize();
    placed.push({ text, x: options?.x ?? 0, y: options?.y ?? 0, size: options?.size ?? 12, pageWidth: box.width, pageHeight: box.height });
    return original.call(this, text, options);
  });
  let pdf: RenderedPdf;
  try {
    pdf = await reportPdfOf(document, { issuedAt: input.issuedAt });
  } finally {
    spy.mockRestore();
  }
  const workbook = (await readXlsxMap(xlsx))[0] as XlsxSheetMap;
  const template = (await readXlsxMap(input.template))[0] as XlsxSheetMap;
  return { document, xlsx, docx, pdf, drawn, placed, workbook, template };
}

/** The value of a cell of the workbook as the evaluator wants it; a formula cell is worked out from the formula the file holds (a workbook has no cached values until a spreadsheet opens it). */
const lookupOf = (workbook: XlsxSheetMap) => {
  const memo = new Map<string, FormulaValue>();
  const lookup = (row: number, col: number): FormulaValue => {
    const ref = cellRef(row, col);
    const entry = workbook.cells[ref];
    if (entry === undefined) return null;
    if (entry.formula !== undefined) {
      if (!memo.has(ref)) {
        memo.set(ref, null);
        memo.set(ref, evaluateFormula(entry.formula, lookup) ?? null);
      }
      return memo.get(ref) ?? null;
    }
    return typeof entry.value === 'number' || typeof entry.value === 'string' ? entry.value : null;
  };
  return lookup;
};

export interface Disagreement {
  where: string;
  detail: string;
}

/** Every place where the workbook, the Word file and the PDF of one document disagree; an empty list is agreement. */
export async function disagreements(made: ThreeWriters): Promise<Disagreement[]> {
  const out: Disagreement[] = [];
  const sheet = documentSheetOf(made.document);
  const placed = new Map(made.pdf.plan.cells.filter((cell) => !cell.repeat).map((cell) => [cellRef(cell.row, cell.col), cell] as const));
  const lookup = lookupOf(made.workbook);

  // 1. The cell map: every cell of the sheet is in the workbook as the document says and on a page of the PDF with the same words.
  const gridCells = new Map(made.document.grid.cells.map((cell) => [cellRef(cell.row, cell.col), cell] as const));
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const ref = cellRef(cell.row, cell.col);
      const lines = placed.get(ref)?.lines;
      if (lines === undefined) out.push({ where: `pdf ${ref}`, detail: 'cell not placed' });
      else if (squash(lines.join('')) !== squash(cell.text)) out.push({ where: `pdf ${ref}`, detail: `${JSON.stringify(lines)} is not ${JSON.stringify(cell.text)}` });
      const grid = gridCells.get(ref);
      const entry = made.workbook.cells[ref];
      if (grid === undefined) {
        // A header word of a template that keeps its own: the template holds the same word.
        const templateWord = made.template.cells[ref]?.value;
        if (cell.header && templateWord !== cell.text) out.push({ where: `template ${ref}`, detail: `${String(templateWord)} is not ${cell.text}` });
        continue;
      }
      if (grid.kind === 'TEXT' && entry?.value !== cell.text) out.push({ where: `xlsx ${ref}`, detail: `${String(entry?.value)} is not ${cell.text}` });
      if (grid.kind === 'NUMBER' && entry?.value !== Number(grid.number)) out.push({ where: `xlsx ${ref}`, detail: `${String(entry?.value)} is not ${String(grid.number)}` });
      if (grid.kind === 'EMPTY' && (entry?.value ?? null) !== null) out.push({ where: `xlsx ${ref}`, detail: 'should be empty' });
      if (grid.kind === 'FORMULA') {
        if (entry?.formula !== grid.formula) out.push({ where: `xlsx ${ref}`, detail: `${String(entry?.formula)} is not ${String(grid.formula)}` });
        // The formula as the file holds it, worked out over the numbers the file holds, is the value the PDF prints.
        const fromFile = evaluateFormula(entry?.formula ?? '', lookup);
        const shown = typeof fromFile === 'number' ? cell.value : null;
        if (typeof fromFile === 'number' && (shown === null || Math.abs(shown - fromFile) > 1e-9)) out.push({ where: `formula ${ref}`, detail: `${String(fromFile)} is not ${String(cell.value)}` });
        if (typeof fromFile === 'string' && cell.text !== fromFile) out.push({ where: `formula ${ref}`, detail: `${fromFile} is not ${cell.text}` });
      }
    }
  }
  if (sheet.unevaluated.length > 0) out.push({ where: 'formulas', detail: `not evaluated: ${sheet.unevaluated.join(',')}` });

  // 2. The words of the narrative: the Word file holds every line the document lists, the PDF printed them in the same order.
  const lines = narrativeLinesOf(made.document.narrative);
  if (made.docx === null) {
    if (lines.length > 0 || made.pdf.plan.narrative.length > 0) out.push({ where: 'narrative', detail: 'text without a Word file' });
  } else {
    const paragraphs = readDocxParagraphs(made.docx);
    const blocks = made.document.narrative?.blocks ?? [];
    const expectedParagraphs = blocks.flatMap((block) => (block.type === 'HEADING' || block.type === 'PARAGRAPH' ? [block.text] : block.type === 'LIST' ? block.items : block.type === 'TABLE' ? [...block.header, ...block.rows.flat()] : block.type === 'SIGNATURES' ? block.slots.map((slot) => slot.role) : []));
    for (const text of expectedParagraphs) if (text.trim() !== '' && !paragraphs.some((paragraph) => paragraph.includes(text))) out.push({ where: 'docx', detail: `missing ${text}` });
    if (JSON.stringify(made.pdf.plan.narrative.map((entry) => entry.text)) !== JSON.stringify(lines)) out.push({ where: 'pdf narrative', detail: 'lines differ from the document' });
  }

  // 3. The pages: the file has the pages the plan says, the sheet pages come first, every row is on a page in order, the header of a continuing table is repeated, the narrative follows.
  const loaded = await PDFDocument.load(made.pdf.bytes);
  if (loaded.getPageCount() !== made.pdf.plan.pages) out.push({ where: 'pages', detail: `${loaded.getPageCount()} is not ${made.pdf.plan.pages}` });
  let last = 0;
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const page = placed.get(cellRef(cell.row, cell.col))?.page ?? 0;
      if (cell.header) continue;
      if (page < last) out.push({ where: 'order', detail: `${cellRef(cell.row, cell.col)} is on page ${page} after page ${last}` });
      last = Math.max(last, page);
    }
  }
  if (last > made.pdf.plan.sheetPages) out.push({ where: 'pages', detail: 'a row beyond the sheet pages' });
  if (made.pdf.plan.narrative.some((entry) => entry.page <= made.pdf.plan.sheetPages)) out.push({ where: 'pages', detail: 'narrative on a sheet page' });
  const headers = sheet.rows.filter((row) => row.kind === 'HEADER');
  if (headers.length > 0) {
    const bodyPages = new Set(made.pdf.plan.cells.filter((cell) => !cell.repeat && !headers.some((row) => row.row === cell.row)).map((cell) => cell.page));
    const firstBody = Math.min(...bodyPages);
    for (const page of bodyPages) {
      const headerOnPage = made.pdf.plan.cells.some((cell) => cell.page === page && headers.some((row) => row.row === cell.row));
      if (page > firstBody && !headerOnPage) out.push({ where: 'header', detail: `page ${page} continues the table without its header` });
    }
  }
  // Every word the plan placed was really drawn.
  const drawnLeft = [...made.drawn];
  for (const cell of made.pdf.plan.cells) {
    for (const line of cell.lines) {
      if (line === '') continue;
      const at = drawnLeft.indexOf(line);
      if (at < 0) out.push({ where: 'drawn', detail: `${line} was not drawn` });
      else drawnLeft.splice(at, 1);
    }
  }
  return out;
}
