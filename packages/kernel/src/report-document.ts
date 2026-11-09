import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { evaluateFormula } from './report-formula.ts';
import type { FormulaValue } from './report-formula.ts';
import { cellRef, fillGrid, fillNarrative, groupDigits, headerRowsOf } from './report-layout.ts';
import type { FilledGrid, FilledNarrative, FormPeriod, GridCell, GridCellKind, GridMerge, LayoutRowKind, MoneyScale, NarrativeBlock, ReportFillData, ReportLayout, ReportLocale } from './report-layout.ts';

/**
 * ONE document model for the three writers of the report engine (ENT-4b, R26). A form is filled once: the grid (what the Excel writer keeps in the template) and the narrative (what the Word writer lays out) of the same
 * layout and the same data, with the hash of the layout that produced them. The writers read nothing else:
 *  - XLSX puts the grid into the template of the customer (formulas stay live),
 *  - DOCX lays the narrative out,
 *  - PDF prints `documentSheetOf(document)`, the same grid with its formulas evaluated and its numbers written the way the sheet shows them, followed by the same narrative.
 * So a figure, a word or a row cannot differ between the three files; the golden tests hold them to it.
 */
export interface ReportDocument {
  layoutCode: string;
  layoutVersion: string;
  /** The sha256 of the layout (and narrative skeleton) that made this document: an issued copy keeps it, so it can say which layout version it was made from. */
  layoutSha256: string;
  name: string;
  status: FilledGrid['status'];
  /** The words every output carries (the demo mark), or null. */
  stamp: string | null;
  period: FormPeriod;
  moneyScale: MoneyScale;
  locale: ReportLocale;
  headerMode: FilledGrid['headerMode'];
  grid: FilledGrid;
  /** The cells of the header rows: they are in the grid when the writer writes the header (`WRITE`) and in the layout alone when the template keeps its own (`KEEP`), so the PDF, which has no template, takes them from here. */
  headerCells: GridCell[];
  headerMerges: GridMerge[];
  narrative: FilledNarrative | null;
}

/** The hash of a layout as an issued copy records it: sha256 of the canonical JSON of the layout and of its narrative skeleton (keys sorted, undefined dropped), so the same layout always gives the same hash. */
export const layoutHashOf = (layout: ReportLayout, narrative: readonly NarrativeBlock[] | null): string => sha256Hex(canonicalJson({ layout, narrative }));

/** Fills the layout and the narrative of a form with the data of one period: the one document the three writers read. */
export function reportDocumentOf(layout: ReportLayout, narrative: readonly NarrativeBlock[] | null, data: ReportFillData): ReportDocument {
  const grid = fillGrid(layout, data);
  const filled = narrative === null ? null : fillNarrative(narrative, data, layout.moneyScale);
  const start = layout.startRow ?? 1;
  const headerRows = layout.columns.length === 0 ? [] : headerRowsOf(layout.columns);
  const headerCells: GridCell[] = [];
  const headerMerges: GridMerge[] = [];
  headerRows.forEach((row, level) => {
    const at = start + layout.preface.length + level;
    for (const cell of row.cells) {
      if (cell.binding.kind !== 'TEXT') continue;
      headerCells.push({ row: at, col: cell.col, kind: 'TEXT', text: cell.binding.text, source: null });
      const colSpan = cell.colSpan ?? 1;
      const rowSpan = cell.rowSpan ?? 1;
      if (colSpan > 1 || rowSpan > 1) headerMerges.push({ fromRow: at, fromCol: cell.col, toRow: at + rowSpan - 1, toCol: cell.col + colSpan - 1 });
    }
  });
  return {
    layoutCode: layout.code,
    layoutVersion: layout.version,
    layoutSha256: layoutHashOf(layout, narrative),
    name: layout.name,
    status: layout.status,
    stamp: grid.stamp,
    period: data.period,
    moneyScale: layout.moneyScale,
    locale: data.locale ?? 'vi',
    headerMode: layout.headerMode,
    grid,
    headerCells,
    headerMerges,
    narrative: filled,
  };
}

// ---- the sheet: what a reader sees --------------------------------------------------------------------------------------------------------------

export interface SheetCell {
  row: number;
  col: number;
  kind: GridCellKind;
  /** The text the sheet shows: words as written, numbers in the format of the cell, formulas as their value. Empty for an empty cell. */
  text: string;
  /** The number behind the text, for a number or an evaluated formula. */
  value: number | null;
  numeric: boolean;
  /** A word of a header row (it is drawn bold and centred). */
  header: boolean;
  colSpan: number;
  rowSpan: number;
}

export interface SheetRow {
  row: number;
  kind: LayoutRowKind;
  cells: SheetCell[];
}

export interface DocumentSheet {
  rows: SheetRow[];
  columns: number;
  /** The widths of the columns where the layout gave them (in characters, as the workbook says). */
  widths: Array<{ col: number; width: number }>;
  /** The formulas this module could not evaluate: the cell is printed empty and the caller reports it (a wrong number is never printed). */
  unevaluated: string[];
}

/** The number of decimal places of an Excel number format (`#,##0.0` is 1), whether it groups thousands and whether it is a percent. */
export function numFmtShape(numFmt: string | undefined): { decimals: number; grouped: boolean; percent: boolean; general: boolean } {
  if (numFmt === undefined || numFmt === '' || numFmt.toLowerCase() === 'general') return { decimals: 0, grouped: false, percent: false, general: true };
  const point = numFmt.indexOf('.');
  let decimals = 0;
  if (point >= 0) while (numFmt.charAt(point + 1 + decimals) === '0' || numFmt.charAt(point + 1 + decimals) === '#') decimals += 1;
  return { decimals, grouped: numFmt.includes(','), percent: numFmt.includes('%'), general: false };
}

/** A number written the way a cell of that format shows it, in the locale of the report (Vietnamese groups with a dot and has a decimal comma). */
export function formatSheetNumber(value: number, numFmt: string | undefined, locale: ReportLocale): string {
  const shape = numFmtShape(numFmt);
  if (shape.general) {
    const text = String(Number(value.toPrecision(12)));
    return locale === 'vi' ? text.replace('.', ',') : text;
  }
  const shown = shape.percent ? value * 100 : value;
  const fixed = shown.toFixed(shape.decimals);
  const negativeZero = /^-0(\.0+)?$/.test(fixed);
  const plain = negativeZero ? fixed.slice(1) : fixed;
  const grouped = shape.grouped ? groupDigits(plain, locale) : locale === 'vi' ? plain.replace('.', ',') : plain;
  return shape.percent ? `${grouped}%` : grouped;
}

/** A decimal text that the grid already rounded, written in the format of its cell. */
function formatDecimalText(text: string, numFmt: string | undefined, locale: ReportLocale): string {
  const shape = numFmtShape(numFmt);
  if (shape.general) return locale === 'vi' ? text.replace('.', ',') : text;
  if (shape.percent) return formatSheetNumber(Number(text), numFmt, locale);
  return shape.grouped ? groupDigits(text, locale) : locale === 'vi' ? text.replace('.', ',') : text;
}

/**
 * The sheet of a document: every row of the grid with its cells as a reader sees them. The formulas are evaluated over the cells of the grid (the workbook will show the same values), the numbers are written in
 * the format of their cell, a header word of a `KEEP` template comes from the layout. This is what the PDF prints, and what the golden tests compare with the workbook and the Word file.
 */
export function documentSheetOf(document: ReportDocument): DocumentSheet {
  const { grid, locale } = document;
  const byKey = new Map<string, GridCell>();
  const all = [...document.headerCells, ...grid.cells];
  for (const cell of all) byKey.set(cellRef(cell.row, cell.col), cell);
  const memo = new Map<string, FormulaValue | undefined>();
  const resolving = new Set<string>();
  const valueAt = (row: number, col: number): FormulaValue => {
    const key = cellRef(row, col);
    const cell = byKey.get(key);
    if (cell === undefined) return null;
    if (cell.kind === 'NUMBER') return Number(cell.number);
    if (cell.kind === 'TEXT') return cell.text ?? '';
    if (cell.kind === 'EMPTY') return null;
    if (memo.has(key)) return memo.get(key) ?? null;
    if (resolving.has(key)) return null;
    resolving.add(key);
    const value = evaluateFormula(cell.formula ?? '', valueAt);
    resolving.delete(key);
    memo.set(key, value);
    return value ?? null;
  };
  const merges = new Map<string, GridMerge>();
  for (const merge of [...document.headerMerges, ...grid.merges]) merges.set(cellRef(merge.fromRow, merge.fromCol), merge);
  const headerKeys = new Set(document.headerCells.map((cell) => cellRef(cell.row, cell.col)));
  const unevaluated: string[] = [];
  let columns = 0;
  const cellsByRow = new Map<number, SheetCell[]>();
  for (const cell of byKey.values()) {
    const key = cellRef(cell.row, cell.col);
    const merge = merges.get(key);
    const colSpan = merge === undefined ? 1 : merge.toCol - merge.fromCol + 1;
    const rowSpan = merge === undefined ? 1 : merge.toRow - merge.fromRow + 1;
    columns = Math.max(columns, cell.col + colSpan - 1);
    let text = '';
    let value: number | null = null;
    if (cell.kind === 'TEXT') {
      text = cell.text ?? '';
    } else if (cell.kind === 'NUMBER') {
      value = Number(cell.number);
      text = formatDecimalText(cell.number ?? '', cell.numFmt, locale);
    } else if (cell.kind === 'FORMULA') {
      const result = valueAt(cell.row, cell.col);
      if (memo.get(key) === undefined) {
        unevaluated.push(key);
      } else if (typeof result === 'number') {
        value = result;
        text = formatSheetNumber(result, cell.numFmt, locale);
      } else if (typeof result === 'string') {
        text = result;
      }
    }
    const shown: SheetCell = { row: cell.row, col: cell.col, kind: cell.kind, text, value, numeric: value !== null, header: headerKeys.has(key), colSpan, rowSpan };
    const row = cellsByRow.get(cell.row) ?? [];
    row.push(shown);
    cellsByRow.set(cell.row, row);
  }
  const rows: SheetRow[] = grid.rows.map((gridRow) => ({ row: gridRow.row, kind: gridRow.kind, cells: (cellsByRow.get(gridRow.row) ?? []).sort((a, b) => a.col - b.col) }));
  return { rows, columns, widths: grid.columnWidths, unevaluated };
}

/** The text of the narrative of a document, one entry per line, as the PDF and the Word file print it (headings, paragraphs, list items, table rows joined by " | ", signature roles). */
export function narrativeLinesOf(narrative: FilledNarrative | null): string[] {
  if (narrative === null) return [];
  const lines: string[] = [];
  for (const block of narrative.blocks) {
    if (block.type === 'HEADING' || block.type === 'PARAGRAPH') lines.push(block.text);
    else if (block.type === 'LIST') lines.push(...block.items);
    else if (block.type === 'TABLE') {
      lines.push(block.header.join(' | '));
      lines.push(...block.rows.map((row) => row.join(' | ')));
    } else if (block.type === 'SIGNATURES') lines.push(block.slots.map((slot) => slot.role).join(' | '));
  }
  return lines.filter((line) => line.trim() !== '');
}
