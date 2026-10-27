import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { ExportDocument } from '@machvon/kernel';
import { loadRendererResources } from '../doc/pdf-renderer';
import type { FontSet } from '../doc/pdf-renderer';

/** A4 landscape in points, as the pdf-lib sizes round it. */
const WIDTH = 841.89;
const HEIGHT = 595.28;
const MARGIN = 28;
const TITLE_SIZE = 12;
const HEADER_SIZE = 7.5;
const HEADER_LINE = 10;
const TABLE_SIZE = 6.5;
const ROW_HEIGHT = 10;
const FOOTER_SIZE = 7;
const FOOTER_LINE = 9;
const CELL_PADDING = 2;
/** What a column needs, by the width of its words: the names are long, the codes short, the money wide. */
const WEIGHTS: Readonly<Record<string, number>> = { label: 2.4, value: 3.2, unit: 1, source: 1.8, project_code: 1.1, project_name: 2.2, unit_code: 1, unit_name: 1.6, bucket: 1.1, budget_level: 0.9, rate_null_reason: 1.4, treasury_coverage: 0.9 };
const DEFAULT_WEIGHT = 1.2;

let cachedFonts: FontSet | undefined;
const fontsOf = (): FontSet => (cachedFonts ??= loadRendererResources().fonts);

/** The text cut to a width with an ellipsis, so that a long name never runs into the next column. */
function fitted(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 0 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A line broken into pieces that each fit the width, for a word that is longer than a column (an address, a code): nothing is cut off, it goes on the next line. */
function broken(line: string, font: PDFFont, size: number, width: number): string[] {
  if (font.widthOfTextAtSize(line, size) <= width) return [line];
  const pieces: string[] = [];
  let piece = '';
  for (const character of line) {
    if (piece !== '' && font.widthOfTextAtSize(piece + character, size) > width) {
      pieces.push(piece);
      piece = character;
    } else {
      piece += character;
    }
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

function wrapped(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

export interface PdfOptions {
  /** Fixes the dates the file carries, so that the same content is the same file. */
  stamp?: Date | undefined;
  /** A cell is written over as many lines as it needs, over as many pages as it needs, instead of cut with an ellipsis: for a table that holds the words of a report and not codes and figures. */
  wrap?: boolean | undefined;
}

/**
 * The PDF of an export (ST-DIS-016): the header block on the first page, the table over as many pages as it needs with its heading repeated, and on every page a footer that says the definitions await the
 * sign-off of D03 while they do, with the page number. The text is the one of the other formats; a column that is too narrow for a word shows it cut with an ellipsis, so the PDF is for reading and the CSV
 * or the workbook for working with the figures. The options fix the dates the file carries (the same content is then the same file) and ask for cells to be wrapped, not cut.
 */
export async function pdfOf(document: ExportDocument, options: PdfOptions = {}): Promise<Uint8Array> {
  const { stamp, wrap = false } = options;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts = fontsOf();
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  pdf.setTitle(document.title);
  pdf.setProducer('MACHVON');
  // The same content gives the same bytes when the caller names the day (a file is told apart by its hash); without it the file carries the time it was made.
  if (stamp !== undefined) {
    pdf.setCreationDate(stamp);
    pdf.setModificationDate(stamp);
  }

  const contentWidth = WIDTH - 2 * MARGIN;
  const weights = document.columns.map((column) => WEIGHTS[column.key] ?? DEFAULT_WEIGHT);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) => (contentWidth * weight) / total);
  const noticeLines = document.notice === null ? [] : wrapped(document.notice, bold, FOOTER_SIZE, contentWidth);
  const footerHeight = (noticeLines.length + 1) * FOOTER_LINE + 6;
  const bottom = MARGIN + footerHeight;

  const pages: PDFPage[] = [];
  const newPage = (): { page: PDFPage; y: number } => {
    const page = pdf.addPage([WIDTH, HEIGHT]);
    pages.push(page);
    return { page, y: HEIGHT - MARGIN };
  };

  const drawRow = (page: PDFPage, y: number, cells: readonly string[], font: PDFFont, fill: boolean): void => {
    if (fill) page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT + 2, width: contentWidth, height: ROW_HEIGHT, color: rgb(0.9, 0.92, 0.95) });
    let x = MARGIN;
    cells.forEach((cell, index) => {
      const width = (widths[index] as number) - 2 * CELL_PADDING;
      const text = fitted(cell, font, TABLE_SIZE, width);
      const numeric = document.columns[index]?.numeric === true;
      const at = numeric ? x + CELL_PADDING + width - font.widthOfTextAtSize(text, TABLE_SIZE) : x + CELL_PADDING;
      page.drawText(text, { x: at, y: y - ROW_HEIGHT + 4, size: TABLE_SIZE, font, color: rgb(0, 0, 0) });
      x += widths[index] as number;
    });
  };

  let { page, y } = newPage();
  page.drawText(document.title, { x: MARGIN, y: y - TITLE_SIZE, size: TITLE_SIZE, font: bold });
  y -= TITLE_SIZE + 8;
  for (const entry of document.header) {
    page.drawText(fitted(`${entry.label}: ${entry.value}`, regular, HEADER_SIZE, contentWidth), { x: MARGIN, y: y - HEADER_SIZE, size: HEADER_SIZE, font: regular });
    y -= HEADER_LINE;
  }
  y -= 6;
  const heading = document.columns.map((column) => column.label);
  drawRow(page, y, heading, bold, true);
  y -= ROW_HEIGHT;
  // A row that is written over several lines is several physical rows of the table, each of which may start a page.
  const physical = (row: readonly string[]): string[][] => {
    if (!wrap) return [[...row]];
    const parts = row.map((cell, index) => cell.split(/\r?\n/).flatMap((paragraph) => wrapped(paragraph, regular, TABLE_SIZE, (widths[index] as number) - 2 * CELL_PADDING).flatMap((line) => broken(line, regular, TABLE_SIZE, (widths[index] as number) - 2 * CELL_PADDING))));
    return Array.from({ length: Math.max(1, ...parts.map((lines) => lines.length)) }, (_, line) => parts.map((lines) => lines[line] ?? ''));
  };
  document.rows.flatMap(physical).forEach((row) => {
    if (y - ROW_HEIGHT < bottom) {
      ({ page, y } = newPage());
      drawRow(page, y, heading, bold, true);
      y -= ROW_HEIGHT;
    }
    drawRow(page, y, row, regular, false);
    y -= ROW_HEIGHT;
  });

  pages.forEach((each, index) => {
    let footerY = MARGIN + footerHeight - 6;
    each.drawLine({ start: { x: MARGIN, y: footerY + 2 }, end: { x: WIDTH - MARGIN, y: footerY + 2 }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
    for (const line of noticeLines) {
      footerY -= FOOTER_LINE;
      each.drawText(line, { x: MARGIN, y: footerY, size: FOOTER_SIZE, font: bold });
    }
    footerY -= FOOTER_LINE;
    each.drawText(`${document.header.find((entry) => entry.key === 'snapshot_id')?.value ?? ''} · ${index + 1}/${pages.length}`, { x: MARGIN, y: footerY, size: FOOTER_SIZE, font: regular });
  });
  return pdf.save({ useObjectStreams: false });
}
