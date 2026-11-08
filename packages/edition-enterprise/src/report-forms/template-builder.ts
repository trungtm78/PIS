import ExcelJS from 'exceljs';
import { AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, PageBreak, PageNumber, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType } from 'docx';
import type { ParagraphChild } from 'docx';
import { unzipSync, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { DEMO_MARK, cellRef, columnLetters, fillGrid, headerRowsOf, numFmtOf, unitLine } from '@machvon/kernel/src/report-layout.ts';
import type { FilledGrid, LayoutRow, NarrativeBlock, ReportLayout } from '@machvon/kernel/src/report-layout.ts';
import { formTexts, rowRolesOf } from './common.ts';
import type { DemoFormSpec, RowRole } from './common.ts';
import { DEMO_FORMS } from './forms.ts';
import { ENTERPRISE_KPI_SEEDS } from './rules.ts';
import { fillText, textsOf } from './texts.ts';

/**
 * Builds the demo templates of the six forms (RPT-1): an .xlsx TEMPLATE for each, written from the layout itself with ExcelJS (so the template and the layout cannot drift apart), and a .docx narrative skeleton
 * for the forms that have a narrative part. The workbook has the two-level header, merged title cells, number formats, the formulas of the subtotals, the grand total and the rates, the print setup (A3 landscape, fit to one
 * page wide, the header rows repeated, a print area) and the demo mark in the header and the footer and in a visible row. The bytes are deterministic: fixed dates and a normalised zip, so the same layout gives the same
 * file and `scripts/build-demo-templates.mjs --check` can tell when a committed template is stale. These files are TEMPLATES (no figures): the report writer fills them from a `FilledGrid`.
 */

/** The words the builder writes into the properties of a document and the page footer, from `messages/templates.vi.json`. */
interface TemplateTexts {
  creator: string;
  xlsxDescription: string;
  docxTitle: string;
  docxDescription: string;
  pageWord: string;
}
const TEXTS = textsOf<TemplateTexts>('templates');

const FONT = 'Times New Roman';
const THIN = { style: 'thin', color: { argb: 'FF000000' } } as const;
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const RED = 'FFC00000';
const GREY = 'FFD9D9D9';
const LIGHT = 'FFF2F2F2';
const MID = 'FFEDEDED';

/** The time written into every document the builder makes: the day of the owner's decision. */
export const TEMPLATE_DATE = new Date(Date.UTC(2026, 10, 8, 0, 0, 0));
/** Midnight of 1 January 2000 as a local time, so the zip date fields are the same on every machine (the same rule as the report writer). */
const ZIP_EPOCH = new Date(2000, 0, 1, 0, 0, 0);
const LEADING = ['[Content_Types].xml', '_rels/.rels'];
const rank = (name: string): number => {
  const index = LEADING.indexOf(name);
  return index === -1 ? LEADING.length : index;
};

function normalizeZip(bytes: Uint8Array, replace: Readonly<Record<string, (text: string) => string>> = {}): Uint8Array {
  const files = unzipSync(bytes);
  const names = Object.keys(files).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out: Zippable = {};
  for (const name of names) {
    let data = files[name] as Uint8Array;
    const change = replace[name];
    if (change !== undefined) data = new TextEncoder().encode(change(new TextDecoder().decode(data)));
    out[name] = [data, { level: 6, mtime: ZIP_EPOCH }];
  }
  return zipSync(out);
}

// ---- the workbook -----------------------------------------------------------------------------------------------------------------------------------

/** The layout with the facts and the figures taken out: a template holds the words of the form and the formulas, never the data of a period. */
function blankLayoutOf(layout: ReportLayout): ReportLayout {
  const unit = unitLine(layout.moneyScale);
  const blank = (row: LayoutRow): LayoutRow => ({
    ...row,
    cells: row.cells.map((cell) => {
      if (cell.binding.kind === 'META') return { ...cell, binding: { kind: 'TEXT', text: cell.binding.key === 'UNIT_LABEL' ? unit : '' } };
      if (cell.binding.kind === 'INDICATOR') return { ...cell, binding: { kind: 'TEXT', text: '' } };
      return cell;
    }),
  });
  // The template is where the header lives, so the builder writes it (a filled report keeps the template's header: the layouts say KEEP).
  return { ...layout, headerMode: 'WRITE', preface: layout.preface.map(blank), body: layout.body.map(blank) };
}

const numFmtOfCode = (code: string): string => {
  const seed = ENTERPRISE_KPI_SEEDS.find((candidate) => candidate.code === code);
  return seed?.unit === 'PERCENT' ? numFmtOf(1) : numFmtOf(0);
};

interface Look {
  font: Partial<ExcelJS.Font>;
  fill?: string;
  border: boolean;
  align: Partial<ExcelJS.Alignment>;
  height?: number;
}

const f = (size: number, extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size, ...extra });

const LOOKS: Readonly<Record<RowRole, Look>> = {
  MARK: { font: f(12, { bold: true, color: { argb: RED } }), fill: 'FFFDECEC', border: false, align: { horizontal: 'center', vertical: 'middle' }, height: 22 },
  HEAD_PARENT: { font: f(11, { bold: true }), border: false, align: { horizontal: 'center', vertical: 'middle', wrapText: true }, height: 18 },
  HEAD_ORG: { font: f(12, { bold: true }), border: false, align: { horizontal: 'center', vertical: 'middle', wrapText: true }, height: 20 },
  TITLE: { font: f(14, { bold: true }), border: false, align: { horizontal: 'center', vertical: 'middle', wrapText: true }, height: 40 },
  PERIOD: { font: f(12, { bold: true, italic: true }), border: false, align: { horizontal: 'center', vertical: 'middle' }, height: 20 },
  UNIT: { font: f(11, { italic: true }), border: false, align: { horizontal: 'right', vertical: 'middle' }, height: 18 },
  KPI_LABEL: { font: f(10), fill: LIGHT, border: true, align: { horizontal: 'center', vertical: 'middle', wrapText: true }, height: 30 },
  KPI_VALUE: { font: f(12, { bold: true }), border: true, align: { horizontal: 'center', vertical: 'middle' }, height: 22 },
  HEADER: { font: f(11, { bold: true }), fill: GREY, border: true, align: { horizontal: 'center', vertical: 'middle', wrapText: true }, height: 34 },
  GROUP: { font: f(11, { bold: true }), fill: LIGHT, border: true, align: { horizontal: 'left', vertical: 'middle' }, height: 20 },
  DATA: { font: f(11), border: true, align: { vertical: 'top' } },
  SUBTOTAL: { font: f(11, { bold: true }), fill: MID, border: true, align: { horizontal: 'left', vertical: 'middle' }, height: 20 },
  GRAND: { font: f(11, { bold: true }), fill: GREY, border: true, align: { horizontal: 'left', vertical: 'middle' }, height: 22 },
  NOTE: { font: f(10, { italic: true }), border: false, align: { horizontal: 'left', vertical: 'top', wrapText: true } },
  DATE: { font: f(11, { italic: true }), border: false, align: { horizontal: 'center', vertical: 'middle' }, height: 24 },
  SIGN_TITLE: { font: f(11, { bold: true }), border: false, align: { horizontal: 'center', vertical: 'middle' }, height: 20 },
  SIGN_HINT: { font: f(10, { italic: true }), border: false, align: { horizontal: 'center', vertical: 'middle' }, height: 16 },
  SPACER: { font: f(11), border: false, align: {}, height: 30 },
  SIGN_NAME: { font: f(11, { bold: true }), border: false, align: { horizontal: 'center', vertical: 'middle' }, height: 22 },
};

const CENTERED_KEYS = new Set(['stt', 'code', 'grp', 'schedule']);

/** The Excel print header: the demo mark in red and bold, centred. */
export const stampHeader = (stamp: string): string => `&C&"${FONT},Bold"&KC00000${stamp}`;
/** The Excel print footer: the demo mark at the left, the page number at the right. */
export const stampFooter = (stamp: string): string => `&L&"${FONT},Italic"&KC00000${stamp}&R&"${FONT},Regular"${TEXTS.pageWord} &P / &N`;

const PAPER_SIZE = { A3: 8, A4: 9 } as const;

function lastColumnOf(grid: FilledGrid, layout: ReportLayout): number {
  return Math.max(...layout.columns.map((column) => column.col), ...grid.cells.map((cell) => cell.col));
}

/** The bytes of the .xlsx template of a demo form. */
export async function buildXlsxTemplate(form: DemoFormSpec): Promise<Uint8Array> {
  const layout = blankLayoutOf(form.layout);
  // One empty record per dataset, so that each block keeps one line with its formulas (the line a filled report copies when it grows).
  const datasets = Object.fromEntries(form.groups.map((group) => [group.dataset, [{}]]));
  const grid = fillGrid(layout, { period: { kind: 'MONTH', year: 2026, index: 1 }, meta: {}, definitions: {}, figures: [], datasets });
  const roles = rowRolesOf(form);
  // The rows of the layout in the order of the grid (a data block of one line is one row).
  const source: LayoutRow[] = [...form.layout.preface, ...headerRowsOf(form.layout.columns), ...form.layout.body];
  if (roles.length !== grid.rows.length) throw new Error(`demo template ${layout.code}: the roles do not match the rows`);
  const lastCol = lastColumnOf(grid, layout);
  const lastRow = grid.rows.length;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = TEXTS.creator;
  workbook.lastModifiedBy = TEXTS.creator;
  workbook.created = TEMPLATE_DATE;
  workbook.modified = TEMPLATE_DATE;
  workbook.title = layout.name;
  workbook.subject = DEMO_MARK;
  workbook.description = fillText(TEXTS.xlsxDescription, { mark: DEMO_MARK, code: layout.code });
  const sheet = workbook.addWorksheet(layout.sheetName, { views: [{ showGridLines: false }] });
  for (const { col, width } of grid.columnWidths) sheet.getColumn(col).width = width;

  // Look of every row: the cells of a table row all get the border and the fill, so that a merge keeps them.
  const columnByCol = new Map(layout.columns.map((column) => [column.col, column]));
  grid.rows.forEach((row, index) => {
    const role = roles[index] as RowRole;
    const look = LOOKS[role];
    const target = sheet.getRow(row.row);
    if (look.height !== undefined) target.height = look.height;
    if (role === 'NOTE') {
      const binding = (source[index] as LayoutRow).cells[0]?.binding;
      const chars = binding?.kind === 'TEXT' ? binding.text.length : 0;
      const width = grid.columnWidths.reduce((sum, item) => sum + item.width, 0);
      target.height = 14 * Math.max(1, Math.ceil(chars / (width * 1.05)));
    }
    const styleCells = look.border || role === 'MARK';
    if (!styleCells) return;
    for (let col = 1; col <= lastCol; col += 1) {
      const cell = sheet.getCell(row.row, col);
      cell.font = look.font;
      cell.alignment = look.align;
      if (look.fill !== undefined) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: look.fill } };
      if (look.border) cell.border = BOX;
      if (role === 'DATA') {
        const column = columnByCol.get(col);
        const numeric = column?.format !== undefined;
        cell.alignment = { vertical: 'top', wrapText: !numeric, horizontal: numeric ? 'right' : CENTERED_KEYS.has(column?.key ?? '') ? 'center' : 'left' };
        if (column?.format !== undefined) cell.numFmt = column.format.numFmt ?? numFmtOf(column.format.decimals ?? 0);
      }
    }
  });

  // Values, formulas and the formats of the formula cells. In a data line only the formulas stay (a sample value must never survive in a template).
  for (const cell of grid.cells) {
    const index = cell.row - 1;
    const role = roles[index] as RowRole;
    const target = sheet.getCell(cell.row, cell.col);
    const look = LOOKS[role];
    if (cell.kind === 'FORMULA') {
      target.value = { formula: cell.formula as string } as ExcelJS.CellFormulaValue;
      if (cell.numFmt !== undefined) target.numFmt = cell.numFmt;
      if (!look.border) {
        target.font = look.font;
        target.alignment = look.align;
      }
      if (role !== 'DATA') target.alignment = { horizontal: 'right', vertical: 'middle' };
      continue;
    }
    if (role === 'DATA') continue;
    if (cell.kind === 'TEXT' && cell.text !== undefined && cell.text !== '') target.value = cell.text;
    if (!look.border) {
      target.font = look.font;
      target.alignment = look.align;
      if (look.fill !== undefined) target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: look.fill } };
    }
    if (role === 'KPI_VALUE') {
      const binding = (source[index] as LayoutRow).cells.find((candidate) => candidate.col === cell.col)?.binding;
      target.numFmt = numFmtOfCode(binding?.kind === 'INDICATOR' ? binding.code : '');
    }
  }
  // The label cells of the total rows and the numeric cells of the KPI strip read left or centred; the totals' numbers read right.
  for (const merge of grid.merges) sheet.mergeCells(`${cellRef(merge.fromRow, merge.fromCol)}:${cellRef(merge.toRow, merge.toCol)}`);

  // The data lines hold their numbers in the column's format and the cell of a text column is left aligned: done above. Total rows: number formats of the money cells.
  grid.rows.forEach((row, index) => {
    const role = roles[index] as RowRole;
    if (role !== 'SUBTOTAL' && role !== 'GRAND') return;
    for (const cell of grid.cells) {
      if (cell.row === row.row && cell.kind === 'FORMULA') sheet.getCell(cell.row, cell.col).alignment = { horizontal: 'right', vertical: 'middle' };
    }
  });

  // The signature block keeps its look in the merged cells too.
  sheet.pageSetup = {
    paperSize: PAPER_SIZE[form.print.paper] as ExcelJS.PaperSize,
    orientation: form.print.orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    printArea: `A1:${columnLetters(lastCol)}${lastRow}`,
    printTitlesRow: `${layout.preface.length + 1}:${layout.preface.length + roles.filter((role) => role === 'HEADER').length}`,
    margins: { left: 0.4, right: 0.4, top: 0.7, bottom: 0.7, header: 0.3, footer: 0.3 },
  };
  sheet.headerFooter.oddHeader = stampHeader(DEMO_MARK);
  sheet.headerFooter.oddFooter = stampFooter(DEMO_MARK);

  const written = await workbook.xlsx.writeBuffer();
  return normalizeZip(new Uint8Array(written as ArrayBuffer));
}

// ---- the narrative skeleton ----------------------------------------------------------------------------------------------------------------------

const ALIGN = { LEFT: AlignmentType.LEFT, CENTER: AlignmentType.CENTER, RIGHT: AlignmentType.RIGHT, JUSTIFY: AlignmentType.JUSTIFIED } as const;
const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const LINE = { style: BorderStyle.SINGLE, size: 4, color: '000000' } as const;
const NUMBERED = 'demo-numbered';
const twips = (mm: number): number => Math.round((mm * 1440) / 25.4);

const cell = (text: string, options: { bold?: boolean; width: number; shade?: boolean; borders: boolean; center?: boolean }): TableCell =>
  new TableCell({
    width: { size: options.width, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: options.shade === true ? { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' } : undefined,
    borders: options.borders ? { top: LINE, bottom: LINE, left: LINE, right: LINE } : { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
    children: [new Paragraph({ alignment: options.center === true ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text, bold: options.bold === true })] })],
  });

function blocksOf(blocks: readonly NarrativeBlock[]): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  let instance = 0;
  for (const block of blocks) {
    switch (block.type) {
      case 'HEADING':
        out.push(new Paragraph({ heading: HEADINGS[block.level], alignment: block.level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text: block.text, bold: true })], spacing: { before: 240, after: 120 } }));
        break;
      case 'PARAGRAPH':
        out.push(new Paragraph({ alignment: ALIGN[block.align ?? 'JUSTIFY'], spacing: { after: 120 }, children: [new TextRun({ text: block.text, bold: block.bold === true, italics: block.italic === true, color: block.text === DEMO_MARK ? 'C00000' : undefined })] }));
        break;
      case 'LIST':
        if (block.ordered) instance += 1;
        for (const item of block.items) out.push(new Paragraph({ numbering: { reference: NUMBERED, level: 0, instance }, children: [new TextRun({ text: item })] }));
        break;
      case 'TABLE': {
        const widths = block.widths ?? block.header.map(() => 100 / block.header.length);
        const total = widths.reduce((sum, width) => sum + width, 0);
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: block.header.map((text, index) => cell(text, { bold: true, shade: true, borders: true, center: true, width: ((widths[index] as number) / total) * 100 })) }),
              ...block.rows.map((row) => new TableRow({ children: row.map((text, index) => cell(text, { borders: true, width: ((widths[index] as number) / total) * 100 })) })),
            ],
          }),
          new Paragraph({ children: [] }),
        );
        break;
      }
      case 'PAGE_BREAK':
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'SIGNATURES': {
        const width = 100 / block.slots.length;
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
            rows: [
              new TableRow({
                cantSplit: true,
                children: block.slots.map(
                  (slot) =>
                    new TableCell({
                      width: { size: width, type: WidthType.PERCENTAGE },
                      borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
                      children: [
                        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: slot.role, bold: true })] }),
                        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: formTexts().layout.signHint, italics: true, size: 22 })] }),
                        new Paragraph({ children: [new TextRun({ text: '' })], spacing: { before: 900 } }),
                        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: slot.name ?? '', bold: true })] }),
                      ],
                    }),
                ),
              }),
            ],
          }),
          new Paragraph({ children: [] }),
        );
        break;
      }
    }
  }
  return out;
}

const W3CDTF = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The bytes of the .docx narrative skeleton of a demo form that has a narrative part: the tokens stay visible, the demo mark is in the first paragraph and in the header and footer of every page. */
export async function buildDocxSkeleton(form: DemoFormSpec): Promise<Uint8Array> {
  if (form.narrative === null) throw new Error(`demo form ${form.layout.code} has no narrative part`);
  const footer: ParagraphChild[] = [new TextRun({ text: `${DEMO_MARK} — `, size: 20, color: 'C00000' }), new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 20 })];
  const document = new Document({
    creator: TEXTS.creator,
    lastModifiedBy: TEXTS.creator,
    title: fillText(TEXTS.docxTitle, { name: form.layout.name }),
    subject: DEMO_MARK,
    description: fillText(TEXTS.docxDescription, { mark: DEMO_MARK, code: form.layout.code }),
    styles: {
      default: { document: { run: { font: FONT, size: 26 }, paragraph: { spacing: { line: 312 } } } },
      paragraphStyles: [1, 2, 3].map((level) => ({ id: `Heading${level}`, name: `heading ${level}`, basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 26 + (level === 1 ? 4 : level === 2 ? 2 : 0), bold: true } })),
    },
    numbering: { config: [{ reference: NUMBERED, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838, orientation: 'portrait' }, margin: { top: twips(20), bottom: twips(20), left: twips(30), right: twips(15) } } },
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: DEMO_MARK, size: 20, bold: true, color: 'C00000' })] })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: footer })] }) },
        children: blocksOf(form.narrative),
      },
    ],
  });
  const written = await Packer.toBuffer(document);
  const stamp = W3CDTF(TEMPLATE_DATE);
  return normalizeZip(new Uint8Array(written), {
    'docProps/core.xml': (text) => text.replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${stamp}$2`).replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${stamp}$2`),
  });
}

// ---- all of them -------------------------------------------------------------------------------------------------------------------------------------

export interface TemplateFile {
  /** The file name inside `templates/demo/`. */
  name: string;
  code: string;
  kind: 'xlsx' | 'docx';
  bytes: Uint8Array;
}

export const templateFileName = (code: string, kind: 'xlsx' | 'docx'): string => `${code}.demo.${kind}`;

/** Every template file of the six forms, in the order of the catalogue: the workbook of each, then the Word skeleton of the forms that have one. */
export async function buildDemoTemplates(): Promise<TemplateFile[]> {
  const files: TemplateFile[] = [];
  for (const form of DEMO_FORMS) {
    const code = form.layout.code;
    files.push({ name: templateFileName(code, 'xlsx'), code, kind: 'xlsx', bytes: await buildXlsxTemplate(form) });
    if (form.narrative !== null) files.push({ name: templateFileName(code, 'docx'), code, kind: 'docx', bytes: await buildDocxSkeleton(form) });
  }
  return files;
}
