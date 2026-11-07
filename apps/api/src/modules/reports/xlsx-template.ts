import ExcelJS from 'exceljs';
import { DomainError, cellRef, columnLetters } from '@machvon/kernel';
import type { FilledGrid, GridCell } from '@machvon/kernel';
import { normalizeZip, zipEntryNames } from './zip-normalize';

/**
 * Fills a customer's Excel template from a filled grid (RPT-1). The template is the form: its rows, columns, merged cells, number formats, fonts, borders, column widths and formulas stay as the customer made them; the
 * writer sets the cells the grid names, grows the data block (inserting rows that copy the style of the last reserved line, and moving what is below: merges, formulas, conditional formats, validations, the print area)
 * and clears the reserved lines that hold no record. The library is ExcelJS (MIT, pure JavaScript): it keeps what a form of numbers and words needs, and does NOT keep charts, pivot tables, slicers, embedded objects or
 * macros, so a template that holds any of those is refused rather than quietly changed.
 *
 * What the writer does not rewrite when it grows the data block: a formula that points into another sheet, defined names, and shared formulas (the template should write each formula out). The output is made
 * deterministic (a fixed zip order, fixed entry times, the document dates set to the time of the issue), so the same grid and template give the same bytes and the same sha256.
 */
export interface XlsxFillOptions {
  /** The time written into the document properties; the epoch when not given, so a test and a rerun give the same bytes. */
  issuedAt?: Date | undefined;
  /** TEMPLATE_WINS (the default) keeps a number format the template gives a cell; LAYOUT_WINS replaces it with the layout's. A cell with no format (General) takes the layout's in both. */
  numFmtPolicy?: 'TEMPLATE_WINS' | 'LAYOUT_WINS' | undefined;
  creator?: string | undefined;
}

const UNSUPPORTED = /^xl\/(charts|pivotTables|pivotCache|slicers|slicerCaches|embeddings|ctrlProps|activeX)\/|^xl\/vbaProject\.bin$/;
const refuse = (detail: string): never => {
  throw new DomainError('TEMPLATE_INVALID', 422, detail);
};

// ---- references -------------------------------------------------------------------------------------------------------------------------------

interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function columnNumber(letters: string): number {
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value;
}

/** `B3:D5` (or a single `B3`) as a box. */
export function parseRange(text: string): Box {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(text);
  if (match === null) return refuse('range');
  const left = columnNumber(match[1] as string);
  const top = Number(match[2]);
  return { top, left, bottom: match[4] === undefined ? top : Number(match[4]), right: match[3] === undefined ? left : columnNumber(match[3]) };
}

const rangeText = (box: Box): string => `${cellRef(box.top, box.left)}:${cellRef(box.bottom, box.right)}`;

const REFERENCE = /(^|[^A-Za-z0-9_.!'])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g;

/** Rewrites the row of every cell reference of a formula (or a list of ranges). Text between double quotes, references with a sheet name (`Other!A5`) and function names that look like a reference (`LOG10(`) are left alone. */
function mapRows(text: string, move: (row: number, absolute: boolean) => number): string {
  return text
    .split(/("(?:[^"]|"")*")/)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(REFERENCE, (_match, before: string, dollarColumn: string, column: string, dollarRow: string, row: string) => `${before}${dollarColumn}${column}${dollarRow}${move(Number(row), dollarRow === '$')}`),
    )
    .join('');
}

/** The references after `count` rows were inserted before row `at`: every reference to a row at or below `at` moves down, so a sum over a block grows when rows are inserted inside it. */
export const shiftRows = (text: string, at: number, count: number): string => mapRows(text, (row) => (row >= at ? row + count : row));

/** The formula of a row copied `delta` rows down: relative references move with it, absolute ones (`$5`) stay. */
export const translateRows = (text: string, delta: number): string => mapRows(text, (row, absolute) => (absolute ? row : row + delta));

// ---- inserting rows ---------------------------------------------------------------------------------------------------------------------------

interface CellSnapshot {
  value: ExcelJS.CellValue;
  style: Partial<ExcelJS.Style>;
}
interface RowSnapshot {
  height: number | undefined;
  hidden: boolean;
  outlineLevel: number;
  cells: Map<number, CellSnapshot>;
}

const cloneStyle = (style: Partial<ExcelJS.Style>): Partial<ExcelJS.Style> => structuredClone(style);

function snapshotSheet(sheet: ExcelJS.Worksheet): { rows: Map<number, RowSnapshot>; columns: number } {
  const rows = new Map<number, RowSnapshot>();
  let columns = 0;
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const snapshot: RowSnapshot = { height: row.height, hidden: row.hidden, outlineLevel: row.outlineLevel ?? 0, cells: new Map() };
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      columns = Math.max(columns, column);
      // A cell merged into another has no value of its own: the master holds it.
      snapshot.cells.set(column, { value: cell.type === ExcelJS.ValueType.Merge ? null : cell.value, style: cloneStyle(cell.style) });
    });
    rows.set(rowNumber, snapshot);
  });
  return { rows, columns };
}

/** Inserts `count` blank rows before row `at`; they take the style and the height of row `at - 1`. Everything from row `at` down moves, with its merges, formulas, formats and validations. */
function insertRows(sheet: ExcelJS.Worksheet, at: number, count: number): void {
  if (at < 2) refuse('insert_position');
  const { rows, columns } = snapshotSheet(sheet);
  const lastRow = sheet.rowCount;
  const merges = (sheet.model.merges ?? []).map((range) => parseRange(range));
  // Unmerging resets the style of the merged-away cells, so the styles come back from the snapshot after the merges are made again.
  for (const box of merges) sheet.unMergeCells(rangeText(box));

  const restore = (rowNumber: number, source: RowSnapshot | undefined): void => {
    const row = sheet.getRow(rowNumber);
    row.height = source?.height as number;
    row.hidden = source?.hidden ?? false;
    row.outlineLevel = source?.outlineLevel ?? 0;
    for (let column = 1; column <= columns; column += 1) {
      const target = sheet.getCell(rowNumber, column);
      const cell = source?.cells.get(column);
      target.value = cell?.value ?? null;
      target.style = cell === undefined ? {} : cloneStyle(cell.style);
    }
  };
  for (let rowNumber = lastRow; rowNumber >= at; rowNumber -= 1) restore(rowNumber + count, rows.get(rowNumber));
  const template = rows.get(at - 1);
  for (let rowNumber = at; rowNumber < at + count; rowNumber += 1) {
    restore(rowNumber, template);
    for (let column = 1; column <= columns; column += 1) sheet.getCell(rowNumber, column).value = null;
  }

  for (const box of merges) {
    const moved = { top: box.top >= at ? box.top + count : box.top, bottom: box.bottom >= at ? box.bottom + count : box.bottom, left: box.left, right: box.right };
    sheet.mergeCellsWithoutStyle(rangeText(moved));
  }
  // The merged-away cells lost their style when they were unmerged; give back what the snapshot holds (above the insertion nothing moved, below it everything moved by `count`).
  for (const box of merges) {
    for (let rowNumber = box.top; rowNumber <= box.bottom; rowNumber += 1) {
      for (let column = box.left; column <= box.right; column += 1) {
        const cell = rows.get(rowNumber)?.cells.get(column);
        if (cell !== undefined) sheet.getCell(rowNumber >= at ? rowNumber + count : rowNumber, column).style = cloneStyle(cell.style);
      }
    }
  }

  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      if (typeof value === 'object' && value !== null && 'formula' in value && typeof value.formula === 'string') cell.value = { formula: shiftRows(value.formula, at, count) } as ExcelJS.CellFormulaValue;
    });
  });
  // A new line keeps what the line it copies computes (a formula of its own row), moved to its row, and holds no other value.
  for (let rowNumber = at; rowNumber < at + count; rowNumber += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const value = template?.cells.get(column)?.value;
      if (typeof value === 'object' && value !== null && 'formula' in value && typeof value.formula === 'string') {
        sheet.getCell(rowNumber, column).value = { formula: translateRows(value.formula, rowNumber - (at - 1)) } as ExcelJS.CellFormulaValue;
      }
    }
  }
  const formats = (sheet as unknown as { conditionalFormattings: Array<{ ref: string }> }).conditionalFormattings;
  for (const format of formats) format.ref = shiftRows(format.ref, at, count);
  if (typeof sheet.pageSetup.printArea === 'string' && sheet.pageSetup.printArea !== '') sheet.pageSetup.printArea = shiftRows(sheet.pageSetup.printArea, at, count);

  // Validations are kept per cell address: move those below the insertion, and give the new rows the ones of the row they copy.
  const validations = (sheet as unknown as { dataValidations: { model: Record<string, ExcelJS.DataValidation> } }).dataValidations;
  const moved: Record<string, ExcelJS.DataValidation> = {};
  for (const [address, rule] of Object.entries(validations.model)) {
    const box = parseRange(address);
    moved[cellRef(box.top >= at ? box.top + count : box.top, box.left)] = rule;
    if (box.top === at - 1) for (let rowNumber = at; rowNumber < at + count; rowNumber += 1) moved[cellRef(rowNumber, box.left)] = rule;
  }
  validations.model = moved;
}

// ---- the mark of a form that is not an official one ----------------------------------------------------------------------------------------

const STAMP_FONT = '&"Times New Roman,Bold"&KC00000';

/**
 * Puts the stamp of the grid (the demo mark) in the print header and the print footer of the sheet and in the properties of the workbook, keeping what the template already prints there; a template that already carries
 * the stamp is left as it is, so the same template filled twice does not repeat it.
 */
function applyStamp(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, stamp: string): void {
  // A sheet loaded from a file with no print header or footer has none (null), not an empty object.
  const current = sheet.headerFooter ?? {};
  const header = current.oddHeader ?? '';
  const footer = current.oddFooter ?? '';
  sheet.headerFooter = {
    ...current,
    oddHeader: header.includes(stamp) ? header : header === '' ? `&C${STAMP_FONT}${stamp}` : header.includes('&C') ? header.replace('&C', `&C${STAMP_FONT}${stamp} — `) : `${header}&C${STAMP_FONT}${stamp}`,
    oddFooter: footer.includes(stamp) ? footer : footer === '' ? `&L${STAMP_FONT}${stamp}` : footer.includes('&L') ? footer.replace('&L', `&L${STAMP_FONT}${stamp} — `) : `&L${STAMP_FONT}${stamp}${footer}`,
  };
  workbook.subject = stamp;
  if (!(workbook.description ?? '').includes(stamp)) workbook.description = (workbook.description ?? '') === '' ? stamp : `${stamp}. ${workbook.description}`;
}

// ---- filling ------------------------------------------------------------------------------------------------------------------------------------

function applyCell(sheet: ExcelJS.Worksheet, cell: GridCell, policy: 'TEMPLATE_WINS' | 'LAYOUT_WINS'): void {
  const target = sheet.getCell(cell.row, cell.col);
  switch (cell.kind) {
    case 'TEXT':
      target.value = cell.text ?? '';
      break;
    case 'NUMBER':
      target.value = Number(cell.number);
      break;
    case 'FORMULA':
      target.value = { formula: cell.formula as string } as ExcelJS.CellFormulaValue;
      break;
    case 'EMPTY':
      target.value = null;
      break;
  }
  if ((cell.kind === 'NUMBER' || cell.kind === 'FORMULA') && cell.numFmt !== undefined) {
    const current = target.numFmt;
    // A new style object: the style of a loaded cell is shared with every cell of the same look, and must not change under them.
    if (policy === 'LAYOUT_WINS' || current === undefined || current === '' || current === 'General') target.style = { ...cloneStyle(target.style), numFmt: cell.numFmt };
  }
}

/**
 * Fills `templateBytes` with the grid and returns the bytes of the new workbook. Throws TEMPLATE_INVALID (422) for bytes that are not an xlsx, a template with a part this writer cannot keep, a sheet that is not
 * there, or merges of the grid that cut across merges of the template.
 */
export async function fillXlsxTemplate(templateBytes: Uint8Array, grid: FilledGrid, options: XlsxFillOptions = {}): Promise<Uint8Array> {
  const names = zipEntryNames(templateBytes);
  if (!names.includes('xl/workbook.xml')) refuse('xlsx');
  if (names.some((name) => UNSUPPORTED.test(name))) refuse('unsupported_parts');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(templateBytes) as unknown as ExcelJS.Buffer);
  } catch {
    return refuse('xlsx');
  }
  const sheet = workbook.getWorksheet(grid.sheetName);
  if (sheet === undefined) return refuse('sheet');

  // Rows the template does not have (the data block grew) are inserted first, from the top, so that the rows of the grid are where the grid says.
  let index = 0;
  while (index < grid.rows.length) {
    const row = grid.rows[index];
    if (row?.inserted !== true) {
      index += 1;
      continue;
    }
    let count = 0;
    while (grid.rows[index + count]?.inserted === true) count += 1;
    insertRows(sheet, row.row, count);
    index += count;
  }

  const policy = options.numFmtPolicy ?? 'TEMPLATE_WINS';
  for (const cell of grid.cells) applyCell(sheet, cell, policy);

  const existing = (sheet.model.merges ?? []).map((range) => parseRange(range));
  for (const merge of grid.merges) {
    const box: Box = { top: merge.fromRow, left: merge.fromCol, bottom: merge.toRow, right: merge.toCol };
    if (existing.some((other) => other.top === box.top && other.left === box.left && other.bottom === box.bottom && other.right === box.right)) continue;
    if (existing.some((other) => other.top <= box.bottom && box.top <= other.bottom && other.left <= box.right && box.left <= other.right)) refuse('merge_conflict');
    sheet.mergeCells(rangeText(box));
    existing.push(box);
  }

  for (const { col, width } of grid.columnWidths) {
    const column = sheet.getColumn(col);
    if (column.width === undefined) column.width = width;
  }

  if (grid.stamp !== null) applyStamp(workbook, sheet, grid.stamp);

  const issuedAt = options.issuedAt ?? new Date(0);
  workbook.created = issuedAt;
  workbook.modified = issuedAt;
  if (options.creator !== undefined) {
    workbook.creator = options.creator;
    workbook.lastModifiedBy = options.creator;
  }
  // Formulas of the template and of the grid have no cached result: Excel computes them when it opens the file.
  workbook.calcProperties = { ...workbook.calcProperties, fullCalcOnLoad: true };

  const written = await workbook.xlsx.writeBuffer();
  return normalizeZip(new Uint8Array(written as ArrayBuffer));
}

// ---- reading back (golden tests, and the check of an issued copy) ----------------------------------------------------------------------------

export interface XlsxCellEntry {
  value: string | number | boolean | null;
  formula?: string;
  numFmt: string;
  /** The look of the cell: font, fill, borders and alignment as one stable text. */
  style: string;
  /** The master cell, for a cell that is merged into another. */
  mergedInto?: string;
}

export interface XlsxSheetMap {
  name: string;
  cells: Record<string, XlsxCellEntry>;
  merges: string[];
  columnWidths: Record<string, number>;
  rowHeights: Record<string, number>;
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => [key, sorted(item)]));
  return value;
};

function styleKey(style: Partial<ExcelJS.Style>): string {
  const { font, fill, border, alignment } = style;
  return JSON.stringify(sorted({ font, fill, border, alignment }));
}

function plainValue(cell: ExcelJS.Cell): { value: XlsxCellEntry['value']; formula?: string } {
  const raw = cell.value;
  if (raw === null || raw === undefined) return { value: null };
  if (raw instanceof Date) return { value: raw.toISOString() };
  if (typeof raw === 'object') {
    if ('formula' in raw && typeof raw.formula === 'string') return { value: null, formula: raw.formula };
    if ('richText' in raw) return { value: raw.richText.map((part) => part.text).join('') };
    if ('text' in raw) return { value: String(raw.text) };
    return { value: JSON.stringify(sorted(raw)) };
  }
  return { value: raw };
}

/**
 * The content and the look of every sheet as plain data: the value or formula, number format and style of each cell that has any, the merges, the column widths and the row heights. Two workbooks that look the same
 * give equal maps, which is what the golden tests compare, and what a reader can use to check a stored copy against its grid.
 */
export async function readXlsxMap(bytes: Uint8Array): Promise<XlsxSheetMap[]> {
  if (!zipEntryNames(bytes).includes('xl/workbook.xml')) refuse('xlsx');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch {
    return refuse('xlsx');
  }
  return workbook.worksheets.map((sheet) => {
    const cells: Record<string, XlsxCellEntry> = {};
    const rowHeights: Record<string, number> = {};
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (row.height !== undefined && row.height !== null) rowHeights[String(rowNumber)] = row.height;
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        const address = cellRef(rowNumber, column);
        const style = styleKey(cell.style);
        const merged = cell.type === ExcelJS.ValueType.Merge;
        const { value, formula } = merged ? { value: null, formula: undefined } : plainValue(cell);
        if (value === null && formula === undefined && !merged && style === '{}') return;
        cells[address] = { value, ...(formula === undefined ? {} : { formula }), numFmt: cell.numFmt ?? 'General', style, ...(merged ? { mergedInto: cell.master.address } : {}) };
      });
    });
    const columnWidths: Record<string, number> = {};
    for (let column = 1; column <= Math.max(sheet.columnCount, sheet.columns?.length ?? 0); column += 1) {
      const width = sheet.getColumn(column).width;
      if (width !== undefined && width !== null) columnWidths[columnLetters(column)] = width;
    }
    return { name: sheet.name, cells, merges: [...(sheet.model.merges ?? [])].sort(), columnWidths, rowHeights };
  });
}

/** What a copy prints and carries as a mark: the print header and footer of each sheet and the subject and description of the workbook (the check that a demo copy carries its mark). */
export async function readXlsxMarks(bytes: Uint8Array): Promise<{ subject: string; description: string; sheets: Array<{ name: string; oddHeader: string; oddFooter: string }> }> {
  if (!zipEntryNames(bytes).includes('xl/workbook.xml')) refuse('xlsx');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch {
    return refuse('xlsx');
  }
  return {
    subject: workbook.subject ?? '',
    description: workbook.description ?? '',
    sheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, oddHeader: sheet.headerFooter?.oddHeader ?? '', oddFooter: sheet.headerFooter?.oddFooter ?? '' })),
  };
}
