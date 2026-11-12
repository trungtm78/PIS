import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { ENT4B_TEXT, documentSheetOf, periodCode } from '@machvon/kernel';
import type { DocumentSheet, ReportDocument, SheetCell, SheetRow } from '@machvon/kernel';
import { broken, fontsOf, wrapped } from '../dis/export-pdf';
import { documentProducer } from '../../editions/product-identity';

/**
 * The PDF writer of the report engine (ENT-4b, R26). It is the third writer of the one `ReportDocument`: the Excel writer keeps the grid in the template of the customer, the Word writer lays the narrative out, and this one
 * prints the sheet of the document (formulas evaluated, numbers in the format of their cell, the header words of a form whose template keeps its own) followed by the narrative. It reuses the primitives of the PDF of the
 * exports (`dis/export-pdf.ts`: the embedded Tinos fonts and the wrapping of a word that is longer than a column) and adds what a form needs and a plain table does not: merged cells, header rows that repeat on every page,
 * rows kept whole across a page break, the mark of a demo form on every page and a footer that names the layout version and its hash.
 *
 * The bytes depend on the document and the day it names (never on the clock), so the same document is the same file with the same sha256. `plan` says where each cell and each line of the narrative went, so a test can hold
 * the three files of a report to each other (cells, words, number of pages) without reading text back out of a PDF.
 */

const MARGIN = 28;
const PAD = 2.5;
const SIZE = 7.5;
const LINE = 9.5;
const ROW_PAD = 3;
const HEADER_SIZE = 8;
const FOOTER_SIZE = 7;
const FOOTER_LINE = 9;
const A4 = { width: 595.28, height: 841.89 } as const;
const A3 = { width: 841.89, height: 1190.55 } as const;
/** More columns than the first limit and the page is turned on its side; more than the second and it is A3, as the workbook templates of the wide forms are. */
const LANDSCAPE_FROM = 6;
const A3_FROM = 10;
const DEFAULT_WIDTH_CHARS = 14;
const NARRATIVE = { left: 85, right: 42, top: 57, bottom: 57, size: 12, heading: [16, 14, 13] as const, indent: 14 };
const MAX_CELL_LINES = 80;
const FILL_HEADER = rgb(0.9, 0.92, 0.95);
const FILL_TOTAL = rgb(0.95, 0.95, 0.95);
const BORDER = rgb(0.45, 0.45, 0.45);
const RED = rgb(0.75, 0.05, 0.05);

export interface PdfReportOptions {
  /** The day the file carries as its dates, so that the same document is the same file. */
  issuedAt: Date;
  creator?: string | undefined;
}

export interface PlacedCell {
  row: number;
  col: number;
  page: number;
  /** The lines the cell was written over, in order. */
  lines: string[];
  /** True for the header of the table drawn again at the top of a page that continues it. */
  repeat: boolean;
}

export interface PdfPlan {
  /** The number of pages of the file. */
  pages: number;
  /** The pages that hold the sheet (the narrative follows on its own pages). */
  sheetPages: number;
  cells: PlacedCell[];
  /** The narrative, one entry per line of `narrativeLinesOf`, in order, with the page it landed on. */
  narrative: Array<{ page: number; text: string }>;
  /** The formulas the document could not evaluate (printed empty). */
  unevaluated: string[];
}

export interface RenderedPdf {
  bytes: Uint8Array;
  plan: PdfPlan;
}

interface Target {
  page: PDFPage;
  width: number;
  height: number;
  /** 1-based number in the file. */
  number: number;
}

type Align = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';

const fill = (template: string, values: Record<string, string | number>): string => template.replace(/\{([a-z]+)\}/g, (_match, key: string) => String(values[key] ?? ''));

function pageSizeOf(columns: number): { width: number; height: number } {
  if (columns > A3_FROM) return { width: A3.height, height: A3.width };
  if (columns > LANDSCAPE_FROM) return { width: A4.height, height: A4.width };
  return { width: A4.width, height: A4.height };
}

/** The widths of the columns in points: the widths of the layout (in characters) share the printable width; a column without one takes the default. */
function columnWidthsOf(sheet: DocumentSheet, contentWidth: number): number[] {
  const weights = Array.from({ length: sheet.columns }, (_, index) => sheet.widths.find((one) => one.col === index + 1)?.width ?? DEFAULT_WIDTH_CHARS);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => (contentWidth * weight) / total);
}

/** A text over the lines a width allows: its own lines first, then its words, then the words that are longer than the width. A cell never grows past a page. */
function linesOf(text: string, font: PDFFont, size: number, width: number): string[] {
  if (text === '') return [''];
  const lines = text.split(/\r?\n/).flatMap((paragraph) => (paragraph.trim() === '' ? [''] : wrapped(paragraph, font, size, width).flatMap((line) => broken(line, font, size, width))));
  return lines.length > MAX_CELL_LINES ? [...lines.slice(0, MAX_CELL_LINES - 1), `${(lines[MAX_CELL_LINES - 1] ?? '').slice(0, -1)}…`] : lines;
}

interface LaidRow {
  row: SheetRow;
  height: number;
  cells: Array<{ cell: SheetCell; x: number; width: number; lines: string[]; font: PDFFont }>;
}

export async function reportPdfOf(document: ReportDocument, options: PdfReportOptions): Promise<RenderedPdf> {
  const sheet = documentSheetOf(document);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts = fontsOf();
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  pdf.setTitle(document.name);
  pdf.setProducer(documentProducer());
  pdf.setCreator(options.creator ?? documentProducer());
  pdf.setSubject(`${document.layoutCode} ${document.layoutVersion} ${periodCode(document.period)}`);
  if (document.stamp !== null) pdf.setKeywords([document.stamp]);
  pdf.setCreationDate(options.issuedAt);
  pdf.setModificationDate(options.issuedAt);

  const size = pageSizeOf(sheet.columns);
  const contentWidth = size.width - 2 * MARGIN;
  const widths = columnWidthsOf(sheet, contentWidth);
  const columnX = widths.reduce<number[]>((acc, width, index) => [...acc, (acc[index] ?? MARGIN) + width], [MARGIN]);
  const spanWidth = (col: number, span: number): number => (columnX[Math.min(col - 1 + span, widths.length)] ?? MARGIN + contentWidth) - (columnX[col - 1] ?? MARGIN);

  // The footer, from the bottom up: the layout line and the page number, then the mark of a demo form, then the note about formulas that could not be worked out.
  const footerLines = 1 + (document.stamp === null ? 0 : 1) + (sheet.unevaluated.length > 0 ? 1 : 0);
  const bottom = MARGIN + footerLines * FOOTER_LINE + 8;
  const top = size.height - MARGIN - (document.stamp === null ? 0 : HEADER_SIZE + 6);

  const pages: Target[] = [];
  const newPage = (kind: 'SHEET' | 'NARRATIVE'): Target => {
    const dimension = kind === 'SHEET' ? size : A4;
    const added = pdf.addPage([dimension.width, dimension.height]);
    const target: Target = { page: added, width: dimension.width, height: dimension.height, number: pages.length + 1 };
    pages.push(target);
    return target;
  };

  const laidOut = (row: SheetRow): LaidRow => {
    const cells = row.cells.map((cell) => {
      const width = spanWidth(cell.col, cell.colSpan);
      const font = row.kind === 'TOTAL' || cell.header || row.kind === 'TITLE' ? bold : regular;
      return { cell, x: columnX[cell.col - 1] ?? MARGIN, width, font, lines: linesOf(cell.text, font, SIZE, width - 2 * PAD) };
    });
    // A cell that spans several rows does not make its first row taller: its words are placed over the rows it covers, and each row is as tall as its own words need.
    const lineCount = Math.max(1, ...cells.filter((one) => one.cell.rowSpan === 1).map((one) => one.lines.length));
    return { row, height: lineCount * LINE + ROW_PAD, cells };
  };

  const plan: PdfPlan = { pages: 0, sheetPages: 0, cells: [], narrative: [], unevaluated: sheet.unevaluated };
  const laid = sheet.rows.map(laidOut);
  const heightOfRow = new Map(laid.map((one) => [one.row.row, one.height] as const));
  const spanHeight = (row: number, rowSpan: number): number => Array.from({ length: rowSpan }, (_, index) => heightOfRow.get(row + index) ?? LINE + ROW_PAD).reduce((sum, height) => sum + height, 0);
  const headerRows = laid.filter((one) => one.row.kind === 'HEADER');
  const headerHeight = headerRows.reduce((sum, one) => sum + one.height, 0);
  const headerIds = new Set(headerRows.map((one) => one.row.row));

  let current = newPage('SHEET');
  let y = top;

  const drawRow = (target: Target, at: number, one: LaidRow, repeat: boolean): void => {
    const kind = one.row.kind;
    const bordered = kind === 'HEADER' || kind === 'DATA' || kind === 'TOTAL';
    // Rectangles first (fills and borders), words after, so a border never covers a word.
    if (bordered) {
      for (const { cell, x, width } of one.cells) {
        const height = spanHeight(cell.row, cell.rowSpan);
        const color = kind === 'HEADER' ? FILL_HEADER : kind === 'TOTAL' ? FILL_TOTAL : undefined;
        target.page.drawRectangle({ x, y: at - height, width, height, borderColor: BORDER, borderWidth: 0.5, ...(color === undefined ? {} : { color }) });
      }
    }
    for (const { cell, x, width, lines, font } of one.cells) {
      const centred = cell.header || (kind === 'TITLE' && cell.colSpan > 1);
      const room = spanHeight(cell.row, cell.rowSpan);
      const lift = cell.header && cell.rowSpan > 1 ? (room - (lines.length * LINE + ROW_PAD)) / 2 : 0;
      lines.forEach((line, index) => {
        if (line === '') return;
        const textWidth = font.widthOfTextAtSize(line, SIZE);
        const free = Math.max(0, width - 2 * PAD - textWidth);
        const dx = cell.numeric ? free : centred ? free / 2 : 0;
        target.page.drawText(line, { x: x + PAD + dx, y: at - 1.5 - 7 - lift - index * LINE, size: SIZE, font });
      });
      plan.cells.push({ row: cell.row, col: cell.col, page: target.number, lines, repeat });
    }
  };

  const drawHeaderBlock = (repeat: boolean): void => {
    for (const one of headerRows) {
      drawRow(current, y, one, repeat);
      y -= one.height;
    }
  };

  let headerDrawn = false;
  for (const one of laid) {
    if (headerIds.has(one.row.row)) {
      // The header rows are kept together: all of them move to a new page when they do not fit.
      if (!headerDrawn) {
        if (y - headerHeight < bottom) {
          current = newPage('SHEET');
          y = top;
        }
        drawHeaderBlock(false);
        headerDrawn = true;
      }
      continue;
    }
    if (y - one.height < bottom) {
      current = newPage('SHEET');
      y = top;
      // A page that continues the table starts with its header rows again.
      if (headerDrawn && headerRows.length > 0 && one.row.kind !== 'TITLE') drawHeaderBlock(true);
    }
    drawRow(current, y, one, false);
    y -= one.height;
  }
  plan.sheetPages = pages.length;

  // The narrative: portrait pages of its own after the sheet, laid out the way the Word file does.
  if (document.narrative !== null && document.narrative.blocks.some((block) => block.type !== 'PAGE_BREAK')) {
    const cursor = { page: newPage('NARRATIVE'), y: A4.height - NARRATIVE.top };
    const floor = Math.max(NARRATIVE.bottom, bottom);
    const contentW = A4.width - NARRATIVE.left - NARRATIVE.right;
    const turn = (): void => {
      cursor.page = newPage('NARRATIVE');
      cursor.y = A4.height - NARRATIVE.top;
    };
    /** Writes a text over the lines it needs; `record` is the line the plan keeps for it (the text as the Word file and the preview list it). */
    const write = (text: string, font: PDFFont, fontSize: number, align: Align, indent: number, record: string | null): void => {
      const lineHeight = fontSize * 1.3;
      const lines = linesOf(text, font, fontSize, contentW - indent);
      let first = true;
      for (const line of lines) {
        if (cursor.y - lineHeight < floor) turn();
        if (first && record !== null && record.trim() !== '') plan.narrative.push({ page: cursor.page.number, text: record });
        first = false;
        if (line !== '') {
          const free = Math.max(0, contentW - indent - font.widthOfTextAtSize(line, fontSize));
          cursor.page.page.drawText(line, { x: NARRATIVE.left + indent + (align === 'CENTER' ? free / 2 : align === 'RIGHT' ? free : 0), y: cursor.y - fontSize, size: fontSize, font });
        }
        cursor.y -= lineHeight;
      }
      cursor.y -= 3;
    };
    for (const block of document.narrative.blocks) {
      if (block.type === 'HEADING') write(block.text, bold, NARRATIVE.heading[block.level - 1] ?? NARRATIVE.size, 'LEFT', 0, block.text);
      else if (block.type === 'PARAGRAPH') write(block.text, block.bold === true ? bold : regular, NARRATIVE.size, block.align ?? 'LEFT', 0, block.text);
      else if (block.type === 'LIST') block.items.forEach((item, index) => write(`${block.ordered ? `${index + 1}.` : '-'} ${item}`, regular, NARRATIVE.size, 'LEFT', NARRATIVE.indent, item));
      else if (block.type === 'TABLE') {
        const asLine = (row: readonly string[]): string => row.join(' | ');
        write(asLine(block.header), bold, NARRATIVE.size - 1, 'LEFT', 0, asLine(block.header));
        for (const row of block.rows) write(asLine(row), regular, NARRATIVE.size - 1, 'LEFT', 0, asLine(row));
      } else if (block.type === 'SIGNATURES') {
        const roles = block.slots.map((slot) => slot.role).join(' | ');
        write(roles, bold, NARRATIVE.size, 'CENTER', 0, roles);
      } else {
        turn();
      }
    }
  }

  // The mark and the footer of every page, now that the number of pages is known.
  plan.pages = pages.length;
  const layoutLine = `${fill(ENT4B_TEXT.pdf_layout, { code: document.layoutCode, version: document.layoutVersion })} · ${fill(ENT4B_TEXT.pdf_period, { period: periodCode(document.period) })} · ${fill(ENT4B_TEXT.pdf_hash, { hash: document.layoutSha256.slice(0, 12) })}`;
  for (const each of pages) {
    const right = each.width - MARGIN;
    if (document.stamp !== null) {
      const width = bold.widthOfTextAtSize(document.stamp, HEADER_SIZE);
      each.page.drawText(document.stamp, { x: (each.width - width) / 2, y: each.height - MARGIN - HEADER_SIZE + 2, size: HEADER_SIZE, font: bold, color: RED });
    }
    let at = MARGIN;
    const pageText = fill(ENT4B_TEXT.pdf_page, { page: each.number, pages: pages.length });
    each.page.drawText(layoutLine, { x: MARGIN, y: at, size: FOOTER_SIZE, font: regular });
    each.page.drawText(pageText, { x: right - regular.widthOfTextAtSize(pageText, FOOTER_SIZE), y: at, size: FOOTER_SIZE, font: regular });
    at += FOOTER_LINE;
    if (document.stamp !== null) {
      each.page.drawText(document.stamp, { x: MARGIN, y: at, size: FOOTER_SIZE, font: bold, color: RED });
      at += FOOTER_LINE;
    }
    if (sheet.unevaluated.length > 0) {
      each.page.drawText(ENT4B_TEXT.pdf_unevaluated, { x: MARGIN, y: at, size: FOOTER_SIZE, font: bold });
      at += FOOTER_LINE;
    }
    each.page.drawLine({ start: { x: MARGIN, y: at - 2 }, end: { x: right, y: at - 2 }, thickness: 0.5, color: BORDER });
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, plan };
}
