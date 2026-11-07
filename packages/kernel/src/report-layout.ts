import { DomainError } from './errors.ts';
import { roundDecimalText } from './kpi-register.ts';
import type { FigureFlag, KpiPeriod, KpiUnit } from './kpi-register.ts';

/**
 * The report engine's pure model (RPT-1): a report form is a grid with EXACT rows and columns, and every cell of it either says a fixed word or is bound to a figure: an indicator of the KPI register (by code and
 * period basis), a field of a dataset, a sum or a count of one, a formula, or a fact of the report (organisation, period, unit of account). `fillGrid` turns a layout and the data of one period into a `FilledGrid`: a list
 * of cells at rows and columns of the sheet, with merges, number formats and the issues found on the way. No file is read or written here: the Excel template and the Word document are written by `apps/api/src/modules/reports`
 * from the grid, so the same grid gives the same file, and the grid itself is what an issued copy can be audited against.
 *
 * Rules that the grid keeps for every channel: a figure with no value is an EMPTY cell and an issue, never 0; money is scaled and rounded by whole numbers (no float), as `roundDecimalText` does for the web and the phone;
 * a figure without a definition in the register is not shown; the flags of a figure (not certified, stale...) travel with the cell as issues so the copy can print its caveats.
 */

// ---- periods ------------------------------------------------------------------------------------------------------------------------------------

export const REPORT_PERIOD_KINDS = ['MONTH', 'QUARTER', 'HALF_YEAR', 'YEAR', 'AS_OF'] as const;
export type FormPeriodKind = (typeof REPORT_PERIOD_KINDS)[number];

/** The period a report is for. `index` is the month (1-12), quarter (1-4) or half (1-2); `day` is the cut-off day of an AS_OF report (its year is the year of the day). */
export interface FormPeriod {
  kind: FormPeriodKind;
  year: number;
  index?: number | undefined;
  day?: string | undefined;
}

/** How a figure is cut from the period: the period itself, from the start of the year, a point in time at its end, the whole year, the same period a year ago, the period before. */
export const PERIOD_BASES = ['IN_PERIOD', 'YEAR_TO_DATE', 'AS_OF_END', 'FULL_YEAR', 'SAME_PERIOD_LAST_YEAR', 'PREVIOUS_PERIOD'] as const;
export type PeriodBasis = (typeof PERIOD_BASES)[number];

export interface DayRange {
  from: string;
  to: string;
}
export interface ResolvedBasis extends DayRange {
  basis: PeriodBasis;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (value: number): string => String(value).padStart(2, '0');
const pad4 = (value: number): string => String(value).padStart(4, '0');
const isoDay = (year: number, month: number, day: number): string => `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

function parseDay(value: string | undefined): { year: number; month: number; day: number } {
  const match = value === undefined ? null : ISO_DAY.exec(value);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  return { year, month, day };
}

const INDEX_LIMIT: Record<FormPeriodKind, number> = { MONTH: 12, QUARTER: 4, HALF_YEAR: 2, YEAR: 0, AS_OF: 0 };

/** The period must be what its kind says: a month has an index of 1 to 12, a year has none, an AS_OF has a valid day. */
export function assertReportPeriod(period: FormPeriod): void {
  if (!(REPORT_PERIOD_KINDS as readonly string[]).includes(period.kind)) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  if (!Number.isInteger(period.year) || period.year < 1900 || period.year > 2999) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  if (period.kind === 'AS_OF') {
    if (parseDay(period.day).year !== period.year || period.index !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'period');
    return;
  }
  if (period.day !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  const limit = INDEX_LIMIT[period.kind];
  if (limit === 0 ? period.index !== undefined : !Number.isInteger(period.index) || (period.index as number) < 1 || (period.index as number) > limit) throw new DomainError('VALIDATION_FAILED', 422, 'period');
}

/** The first and last day of the period; an AS_OF report counts from the first day of its year to its day. */
export function periodRange(period: FormPeriod): DayRange {
  assertReportPeriod(period);
  const { year } = period;
  switch (period.kind) {
    case 'MONTH': {
      const month = period.index as number;
      return { from: isoDay(year, month, 1), to: isoDay(year, month, daysInMonth(year, month)) };
    }
    case 'QUARTER': {
      const first = ((period.index as number) - 1) * 3 + 1;
      return { from: isoDay(year, first, 1), to: isoDay(year, first + 2, daysInMonth(year, first + 2)) };
    }
    case 'HALF_YEAR': {
      const first = ((period.index as number) - 1) * 6 + 1;
      return { from: isoDay(year, first, 1), to: isoDay(year, first + 5, daysInMonth(year, first + 5)) };
    }
    case 'YEAR':
      return { from: isoDay(year, 1, 1), to: isoDay(year, 12, 31) };
    case 'AS_OF':
      return { from: isoDay(year, 1, 1), to: period.day as string };
  }
}

/** The code of the period in a file name and a key: `2026-M10`, `2026-Q3`, `2026-H1`, `2026`, `2026-10-31`. */
export function periodCode(period: FormPeriod): string {
  assertReportPeriod(period);
  switch (period.kind) {
    case 'MONTH':
      return `${period.year}-M${pad2(period.index as number)}`;
    case 'QUARTER':
      return `${period.year}-Q${period.index}`;
    case 'HALF_YEAR':
      return `${period.year}-H${period.index}`;
    case 'YEAR':
      return String(period.year);
    case 'AS_OF':
      return period.day as string;
  }
}

const ROMAN = ['', 'I', 'II', 'III', 'IV'];
const dmy = (day: string): string => {
  const { year, month, day: d } = parseDay(day);
  return `${pad2(d)}/${pad2(month)}/${pad4(year)}`;
};

export type ReportLocale = 'vi' | 'en';

/** The words a form prints for its period: "Tháng 10 năm 2026", "Quý III năm 2026", "6 tháng đầu năm 2026", "Năm 2026", "Tính đến ngày 31/10/2026". */
export function periodLabel(period: FormPeriod, locale: ReportLocale = 'vi'): string {
  assertReportPeriod(period);
  const vi = locale === 'vi';
  switch (period.kind) {
    case 'MONTH':
      return vi ? `Tháng ${period.index} năm ${period.year}` : `${new Date(Date.UTC(2000, (period.index as number) - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${period.year}`;
    case 'QUARTER':
      return vi ? `Quý ${ROMAN[period.index as number]} năm ${period.year}` : `Q${period.index} ${period.year}`;
    case 'HALF_YEAR':
      return vi ? (period.index === 1 ? `6 tháng đầu năm ${period.year}` : `6 tháng cuối năm ${period.year}`) : `H${period.index} ${period.year}`;
    case 'YEAR':
      return vi ? `Năm ${period.year}` : `Year ${period.year}`;
    case 'AS_OF':
      return vi ? `Tính đến ngày ${dmy(period.day as string)}` : `As of ${dmy(period.day as string)}`;
  }
}

function shiftYear(day: string, years: number): string {
  const { year, month, day: d } = parseDay(day);
  return isoDay(year + years, month, Math.min(d, daysInMonth(year + years, month)));
}

function previousPeriod(period: FormPeriod): FormPeriod {
  const index = period.index as number;
  switch (period.kind) {
    case 'MONTH':
      return index === 1 ? { kind: 'MONTH', year: period.year - 1, index: 12 } : { kind: 'MONTH', year: period.year, index: index - 1 };
    case 'QUARTER':
      return index === 1 ? { kind: 'QUARTER', year: period.year - 1, index: 4 } : { kind: 'QUARTER', year: period.year, index: index - 1 };
    case 'HALF_YEAR':
      return index === 1 ? { kind: 'HALF_YEAR', year: period.year - 1, index: 2 } : { kind: 'HALF_YEAR', year: period.year, index: 1 };
    case 'YEAR':
      return { kind: 'YEAR', year: period.year - 1 };
    case 'AS_OF':
      throw new DomainError('VALIDATION_FAILED', 422, 'period_basis');
  }
}

/** The days a basis stands for in the period of a report. An AS_OF report has no previous period (it is a point of a year): ask for the same period of last year. */
export function resolveBasis(basis: PeriodBasis, period: FormPeriod): ResolvedBasis {
  const own = periodRange(period);
  switch (basis) {
    case 'IN_PERIOD':
      return { basis, ...own };
    case 'YEAR_TO_DATE':
      return { basis, from: isoDay(period.year, 1, 1), to: own.to };
    case 'AS_OF_END':
      return { basis, from: own.to, to: own.to };
    case 'FULL_YEAR':
      return { basis, from: isoDay(period.year, 1, 1), to: isoDay(period.year, 12, 31) };
    case 'SAME_PERIOD_LAST_YEAR':
      return { basis, from: shiftYear(own.from, -1), to: shiftYear(own.to, -1) };
    case 'PREVIOUS_PERIOD':
      return { basis, ...periodRange(previousPeriod(period)) };
    default:
      throw new DomainError('VALIDATION_FAILED', 422, 'period_basis');
  }
}

/** The basis a KPI is read with when the cell does not say: its own period in the register (a year-to-date figure is read year to date, a point-in-time one at the end of the period). */
export function defaultBasisOf(period: KpiPeriod): PeriodBasis {
  return period === 'YEAR_TO_DATE' ? 'YEAR_TO_DATE' : period === 'AS_OF_NOW' ? 'AS_OF_END' : 'IN_PERIOD';
}

// ---- units and number formats ------------------------------------------------------------------------------------------------------------------

/** The scale money is written in (ĐVT): dong, thousand, million or billion dong. The source of every money figure is whole dong. */
export const MONEY_SCALES = ['VND', 'THOUSAND_VND', 'MILLION_VND', 'BILLION_VND'] as const;
export type MoneyScale = (typeof MONEY_SCALES)[number];
const SCALE_PLACES: Record<MoneyScale, number> = { VND: 0, THOUSAND_VND: 3, MILLION_VND: 6, BILLION_VND: 9 };
/** Places kept when the cell does not say: whole dong, thousand and million, two places for a billion. */
const SCALE_DECIMALS: Record<MoneyScale, number> = { VND: 0, THOUSAND_VND: 0, MILLION_VND: 0, BILLION_VND: 2 };
const SCALE_LABEL: Record<ReportLocale, Record<MoneyScale, string>> = {
  vi: { VND: 'đồng', THOUSAND_VND: 'nghìn đồng', MILLION_VND: 'triệu đồng', BILLION_VND: 'tỷ đồng' },
  en: { VND: 'VND', THOUSAND_VND: 'thousand VND', MILLION_VND: 'million VND', BILLION_VND: 'billion VND' },
};

export const moneyScaleLabel = (scale: MoneyScale, locale: ReportLocale = 'vi'): string => SCALE_LABEL[locale][scale];
export const isMoneyScale = (value: unknown): value is MoneyScale => (MONEY_SCALES as readonly unknown[]).includes(value);

/** The text a form prints for its unit of account: "Đơn vị tính: triệu đồng". */
export const unitLine = (scale: MoneyScale, locale: ReportLocale = 'vi'): string => `${locale === 'vi' ? 'Đơn vị tính' : 'Unit'}: ${moneyScaleLabel(scale, locale)}`;

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** A decimal text, or null when the value is not a plain decimal: a JS number is accepted when it prints without an exponent. */
export function decimalTextOf(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim();
  return DECIMAL.test(text) ? text : null;
}

/** Moves the decimal point left by `places`, exactly (no float): 1234567890 by 6 is 1234.56789. */
export function shiftDecimalLeft(value: string, places: number): string {
  if (!DECIMAL.test(value) || !Number.isInteger(places) || places < 0) throw new DomainError('VALIDATION_FAILED', 422, 'value');
  if (places === 0) return value;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const digits = whole.padStart(places + 1, '0');
  const head = digits.slice(0, digits.length - places);
  const tail = `${digits.slice(digits.length - places)}${fraction}`;
  const body = `${head}.${tail}`;
  return negative ? `-${body}` : body;
}

/** Adds decimal texts exactly. */
export function sumDecimalTexts(values: readonly string[]): string {
  let places = 0;
  for (const value of values) places = Math.max(places, (value.split('.')[1] ?? '').length);
  let total = 0n;
  for (const value of values) {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
    const scaled = BigInt(`${whole}${fraction.padEnd(places, '0')}`);
    total += negative ? -scaled : scaled;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(places + 1, '0');
  const body = places === 0 ? digits : `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
  return negative ? `-${body}` : body;
}

/** How the cell is written: text, a number (with the scale of money and the places kept) or a day. `numFmt` is an Excel number format that wins over the one built from the places. */
export interface CellFormat {
  kind?: 'TEXT' | 'NUMBER' | 'DATE' | undefined;
  /** For a money figure: the scale it is shown in; falls back to the layout's. A figure that is not money (a percent, a count) has no scale. */
  money?: boolean | undefined;
  scale?: MoneyScale | undefined;
  decimals?: number | undefined;
  numFmt?: string | undefined;
}

/** The Excel number format of a number with `decimals` places and a thousands separator: `#,##0`, `#,##0.00`. */
export const numFmtOf = (decimals: number): string => (decimals <= 0 ? '#,##0' : `#,##0.${'0'.repeat(decimals)}`);

// ---- the layout --------------------------------------------------------------------------------------------------------------------------------

/**
 * What a cell shows. TEXT is a fixed word; META a fact of the report (`ORG_NAME`, `UNIT_LABEL` and `PERIOD_LABEL` and `PERIOD_CODE` are derived, anything else comes from `data.meta`); INDICATOR a figure of the KPI register for
 * a period basis; ROW_FIELD a field of the record of this row (a DATA row repeats once per record); ROW_NUMBER the 1-based number of the record (STT); SUM and COUNT the total of a dataset; FORMULA an Excel formula kept live
 * in the file (`{first:dataset}` and `{last:dataset}` are the first and last row of the dataset block, `{row}` this row, `{row-1}` the row above it).
 */
export type CellBinding =
  | { kind: 'TEXT'; text: string }
  | { kind: 'META'; key: string }
  | { kind: 'INDICATOR'; code: string; basis?: PeriodBasis | undefined }
  | { kind: 'ROW_FIELD'; field: string }
  | { kind: 'ROW_NUMBER' }
  | { kind: 'SUM'; dataset: string; field: string }
  | { kind: 'COUNT'; dataset: string }
  | { kind: 'FORMULA'; formula: string };

export interface LayoutCell {
  col: number;
  binding: CellBinding;
  format?: CellFormat | undefined;
  colSpan?: number | undefined;
  rowSpan?: number | undefined;
}

export type LayoutRowKind = 'TITLE' | 'HEADER' | 'DATA' | 'TOTAL' | 'NOTE';

/** One row of the grid. A DATA row names its dataset and reserves `capacity` rows of the template (default 1); with more records the grid grows (`EXPAND`, the default) or the fill is refused (`REFUSE`, for a form with a fixed number of lines). */
export interface LayoutRow {
  kind: LayoutRowKind;
  cells: LayoutCell[];
  dataset?: string | undefined;
  capacity?: number | undefined;
  overflow?: 'EXPAND' | 'REFUSE' | undefined;
}

/** A column of the form, with its header as a path from the top level (`['Kế hoạch năm', 'Vốn NSNN']`): neighbours with the same upper path form a column group and merge. */
export interface LayoutColumn {
  col: number;
  key: string;
  header: string[];
  width?: number | undefined;
  format?: CellFormat | undefined;
}

/**
 * PENDING_EXTERNAL: the official template has not arrived, the layout is built from its description and cannot be issued; DRAFT: being worked; READY: matches the confirmed official template; DEMO: a form the system
 * designed itself ("mẫu demo do hệ thống thiết kế, chưa phải mẫu chính thức") that may be issued only while demo forms are switched on, carries the demo mark on every output, and can never become READY or count as
 * accepted (rule R18): the official form is always a NEW layout (version) with a form reference, never a DEMO layout promoted.
 */
export const LAYOUT_STATUSES = ['PENDING_EXTERNAL', 'DEMO', 'DRAFT', 'READY'] as const;
export type LayoutStatus = (typeof LAYOUT_STATUSES)[number];

/** The words printed on every output of a DEMO form (header and footer of the file, a visible row of the sheet, the metadata of the issued copy). */
export const DEMO_MARK = 'MẪU DEMO — chờ mẫu chính thức';
/** The governance rule type that says whether demo forms may be issued (param `demo_forms`, code `DEFAULT`); the environment variable DEMO_FORMS overrides it. */
export const REPORT_FORM_MODE_RULE_TYPE = 'REPORT_FORM_MODE';
export const DEMO_FORMS_ENV = 'DEMO_FORMS';

export interface ReportLayout {
  code: string;
  name: string;
  version: string;
  status: LayoutStatus;
  /** The reference of the official form (a decision, a circular, a letter), or null when the form is not official. */
  formRef: string | null;
  sheetName: string;
  /** The first row of the grid in the sheet (1-based, default 1). */
  startRow?: number | undefined;
  moneyScale: MoneyScale;
  /** KEEP leaves the header cells of the template as they are; WRITE writes the column headers into them. */
  headerMode: 'KEEP' | 'WRITE';
  columns: LayoutColumn[];
  /** Rows above the header (title, organisation, period, unit of account). */
  preface: LayoutRow[];
  /** Rows below the header: data rows, total rows and notes. */
  body: LayoutRow[];
}

export const GRID_ROW_CAP = 50_000;
export const GRID_COLUMN_CAP = 256;
const DATA_CAPACITY_CAP = 5_000;
const LAYOUT_CODE = /^[A-Z][A-Z0-9_-]{1,39}$/;

const positive = (value: number | undefined, fallback: number): number => (value === undefined ? fallback : value);
const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const fail = (detail: string): never => {
  throw new DomainError('VALIDATION_FAILED', 422, detail);
};

/** The header rows of the columns: a label that is the upper path of several neighbouring columns spans them, a path shorter than the deepest spans down. */
export function headerRowsOf(columns: readonly LayoutColumn[]): LayoutRow[] {
  if (columns.length === 0) return [];
  const sorted = [...columns].sort((a, b) => a.col - b.col);
  for (const column of sorted) if (column.header.length === 0) fail('column_header');
  const depth = Math.max(...sorted.map((column) => column.header.length));
  const rows: LayoutRow[] = [];
  for (let level = 0; level < depth; level += 1) {
    const cells: LayoutCell[] = [];
    let index = 0;
    while (index < sorted.length) {
      const column = sorted[index] as LayoutColumn;
      if (level >= column.header.length) {
        index += 1;
        continue;
      }
      const leaf = level === column.header.length - 1;
      let span = 1;
      if (!leaf) {
        const prefix = column.header.slice(0, level + 1).join('\u0000');
        for (;;) {
          const previous = sorted[index + span - 1] as LayoutColumn;
          const next = sorted[index + span];
          if (next === undefined || next.col !== previous.col + 1 || next.header.length <= level + 1 || next.header.slice(0, level + 1).join('\u0000') !== prefix) break;
          span += 1;
        }
      }
      cells.push({ col: column.col, binding: { kind: 'TEXT', text: column.header[level] as string }, colSpan: span, rowSpan: leaf ? depth - level : 1 });
      index += span;
    }
    rows.push({ kind: 'HEADER', cells });
  }
  return rows;
}

/** A DATA row for a dataset whose fields are the keys of the columns, each cell with the format of its column. */
export function dataRowOf(dataset: string, columns: readonly LayoutColumn[], options: { capacity?: number; overflow?: 'EXPAND' | 'REFUSE'; numbered?: string } = {}): LayoutRow {
  const cells: LayoutCell[] = columns.map((column) => {
    const binding: CellBinding = options.numbered !== undefined && column.key === options.numbered ? { kind: 'ROW_NUMBER' } : { kind: 'ROW_FIELD', field: column.key };
    return { col: column.col, binding, ...(column.format === undefined ? {} : { format: column.format }) };
  });
  return { kind: 'DATA', dataset, cells, ...(options.capacity === undefined ? {} : { capacity: options.capacity }), ...(options.overflow === undefined ? {} : { overflow: options.overflow }) };
}

const rowsOf = (layout: ReportLayout): LayoutRow[] => [...layout.preface, ...(layout.columns.length === 0 ? [] : headerRowsOf(layout.columns)), ...layout.body];

/** The layout must be a grid that can be placed: positive integer columns and spans, no two cells on the same square, one DATA row per dataset, totals that name a dataset the layout has. */
export function validateLayout(layout: ReportLayout): void {
  if (!LAYOUT_CODE.test(layout.code) || layout.name.trim() === '' || layout.version.trim() === '' || layout.sheetName.trim() === '') fail('layout');
  if (!(LAYOUT_STATUSES as readonly string[]).includes(layout.status)) fail('layout_status');
  if (!isMoneyScale(layout.moneyScale)) fail('money_scale');
  if (layout.status === 'DEMO') {
    // A demo form is never an official one: no form reference, a name that says so, and the demo mark in a visible cell of the preface.
    if (layout.formRef !== null || !layout.name.toLowerCase().includes('mẫu demo')) fail('demo_layout');
    const marked = layout.preface.some((row) => row.cells.some((cell) => cell.binding.kind === 'TEXT' && cell.binding.text.includes(DEMO_MARK)));
    if (!marked) fail('demo_mark_missing');
  }
  if (layout.startRow !== undefined && !isPositiveInt(layout.startRow)) fail('start_row');
  const seenColumns = new Set<number>();
  const seenKeys = new Set<string>();
  for (const column of layout.columns) {
    if (!isPositiveInt(column.col) || column.col > GRID_COLUMN_CAP || seenColumns.has(column.col) || seenKeys.has(column.key) || column.key === '') fail('columns');
    seenColumns.add(column.col);
    seenKeys.add(column.key);
    if (column.width !== undefined && !(column.width > 0 && column.width <= 255)) fail('column_width');
  }
  const rows = rowsOf(layout);
  const datasets = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'DATA') continue;
    if (row.dataset === undefined || row.dataset === '' || datasets.has(row.dataset)) fail('dataset');
    datasets.add(row.dataset as string);
    if (row.capacity !== undefined && (!isPositiveInt(row.capacity) || row.capacity > DATA_CAPACITY_CAP)) fail('capacity');
  }
  const occupied = new Set<string>();
  rows.forEach((row, rowIndex) => {
    if (row.kind !== 'DATA' && (row.dataset !== undefined || row.capacity !== undefined)) fail('row_kind');
    for (const cell of row.cells) {
      const colSpan = positive(cell.colSpan, 1);
      const rowSpan = positive(cell.rowSpan, 1);
      if (!isPositiveInt(cell.col) || !isPositiveInt(colSpan) || !isPositiveInt(rowSpan) || cell.col + colSpan - 1 > GRID_COLUMN_CAP) fail('cell');
      if (row.kind === 'DATA' && rowSpan !== 1) fail('cell_rowspan');
      if (rowIndex + rowSpan > rows.length) fail('cell_rowspan');
      for (let down = 0; down < rowSpan; down += 1) {
        if (down > 0 && (rows[rowIndex + down] as LayoutRow).kind === 'DATA') fail('cell_rowspan');
        for (let across = 0; across < colSpan; across += 1) {
          const key = `${rowIndex + down}:${cell.col + across}`;
          if (occupied.has(key)) fail('cell_overlap');
          occupied.add(key);
        }
      }
      const binding = cell.binding;
      if ((binding.kind === 'ROW_FIELD' || binding.kind === 'ROW_NUMBER') && row.kind !== 'DATA') fail('binding_row');
      if ((binding.kind === 'SUM' || binding.kind === 'COUNT') && !datasets.has(binding.dataset)) fail('binding_dataset');
      if (cell.format?.decimals !== undefined && !(Number.isInteger(cell.format.decimals) && cell.format.decimals >= 0 && cell.format.decimals <= 6)) fail('format');
      if (cell.format?.scale !== undefined && !isMoneyScale(cell.format.scale)) fail('format');
    }
  });
  if (rows.length === 0) fail('layout_rows');
}

export interface IssuableOptions {
  /** Whether demo forms may be issued now (`demoFormsOn`); false when not said. */
  demoMode?: boolean | undefined;
}

/**
 * A layout may be used for an issued copy only when it matches the confirmed official template (READY). A DEMO layout may be issued only when demo mode is on (TEMPLATE_UNCONFIRMED, detail `demo_forms_off`
 * otherwise); a layout waiting for the official template (PENDING_EXTERNAL) or still a draft is refused (detail `layout_status`).
 */
export function assertLayoutIssuable(layout: ReportLayout, options: IssuableOptions = {}): void {
  if (layout.status === 'READY') return;
  if (layout.status === 'DEMO') {
    if (options.demoMode === true) return;
    throw new DomainError('TEMPLATE_UNCONFIRMED', 409, 'demo_forms_off');
  }
  throw new DomainError('TEMPLATE_UNCONFIRMED', 409, 'layout_status');
}

/** The words a DEMO layout stamps on its outputs; null for any other layout. */
export const stampOf = (layout: Pick<ReportLayout, 'status'>): string | null => (layout.status === 'DEMO' ? DEMO_MARK : null);

/**
 * Whether demo forms are on: the environment variable `DEMO_FORMS` (`true` or `false`) wins; without it the value of the governance rule `REPORT_FORM_MODE` (param `demo_forms`) is used; with neither, off. A value
 * of the variable that is neither `true` nor `false` is refused (VALIDATION_FAILED, `demo_forms`), so a typo can never switch demo forms on or off by accident.
 */
export function demoFormsOn(input: { env?: Readonly<Record<string, string | undefined>> | undefined; ruleParams?: Readonly<Record<string, unknown>> | undefined } = {}): boolean {
  const raw = input.env?.[DEMO_FORMS_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const value = raw.trim().toLowerCase();
    if (value !== 'true' && value !== 'false') fail('demo_forms');
    return value === 'true';
  }
  return input.ruleParams?.demo_forms === true;
}

const STATUS_MOVES: Readonly<Record<LayoutStatus, readonly LayoutStatus[]>> = {
  PENDING_EXTERNAL: ['DRAFT', 'DEMO'],
  // The official form arrives as a new layout; a demo layout is never promoted (R18).
  DEMO: [],
  DRAFT: ['READY', 'PENDING_EXTERNAL'],
  READY: ['DRAFT'],
};

/** The refusal of a status change the rules do not allow: a move from DEMO to READY is TEMPLATE_UNCONFIRMED `demo_not_ready` (R18); any other move outside the table is `layout_status`. */
export function assertStatusMove(from: LayoutStatus, to: LayoutStatus): void {
  if (from === 'DEMO' && to === 'READY') throw new DomainError('TEMPLATE_UNCONFIRMED', 409, 'demo_not_ready');
  if (!STATUS_MOVES[from].includes(to)) throw new DomainError('TEMPLATE_UNCONFIRMED', 409, 'layout_status');
}

/** Whether a layout counts as an accepted (official) form: only READY does; a DEMO form never does. */
export const countsAsAcceptedForm = (layout: Pick<ReportLayout, 'status'>): boolean => layout.status === 'READY';

// ---- the data of one period ----------------------------------------------------------------------------------------------------------------------

export type ReportScalar = string | number | null;

/** What the register says about an indicator, as the report needs it: its unit, places and period (its name, formula and source are printed with the copy). */
export interface ReportIndicatorDefinition {
  code: string;
  name: string;
  unit: KpiUnit;
  decimals: number;
  period: KpiPeriod;
  version: number;
  formula?: string | undefined;
  source?: string | undefined;
  unverified?: boolean | undefined;
}

/** One figure of an indicator for one basis. A value of null is "no data": the cell stays empty and says why. */
export interface ReportFigure {
  code: string;
  basis: PeriodBasis;
  value: ReportScalar;
  flags?: readonly FigureFlag[] | undefined;
  asOf?: string | null | undefined;
}

export interface ReportFillData {
  period: FormPeriod;
  locale?: ReportLocale | undefined;
  meta: Readonly<Record<string, string>>;
  definitions: Readonly<Record<string, ReportIndicatorDefinition>>;
  figures: readonly ReportFigure[];
  datasets: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, ReportScalar>>>>>;
}

// ---- the filled grid ---------------------------------------------------------------------------------------------------------------------------

export type GridCellKind = 'TEXT' | 'NUMBER' | 'FORMULA' | 'EMPTY';

/** One cell of the filled grid. A NUMBER carries the decimal text after scaling and rounding; the writer turns it into a number of the file. EMPTY clears the cell (a figure with no value, or a reserved row left unused). */
export interface GridCell {
  row: number;
  col: number;
  kind: GridCellKind;
  text?: string | undefined;
  number?: string | undefined;
  formula?: string | undefined;
  numFmt?: string | undefined;
  /** Where the value comes from, for the audit of the copy: `INDICATOR:CODE@BASIS`, `SUM:dataset.field`, `COUNT:dataset`; null for fixed words and facts. */
  source: string | null;
}

export interface GridMerge {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
}

/** A row of the sheet: `templateRow` is the row of the template it takes its style from; `inserted` says the template has no such row (the data block grew) and the writer inserts it. */
export interface GridRow {
  row: number;
  templateRow: number;
  inserted: boolean;
  kind: LayoutRowKind;
}

export type GridIssueCode = FigureFlag | 'NO_FIGURE' | 'NO_DEFINITION' | 'NOT_A_NUMBER' | 'DATASET_MISSING' | 'META_MISSING' | 'FIELD_MISSING';

export interface GridIssue {
  ref: string;
  row: number;
  col: number;
  code: GridIssueCode;
  detail: string | null;
}

export interface FilledGrid {
  layoutCode: string;
  layoutVersion: string;
  /** The status of the layout the grid was made from; the writers and the issued copy read it. */
  status: LayoutStatus;
  /** The words every output of the grid carries (header and footer): the demo mark for a DEMO layout, null otherwise. */
  stamp: string | null;
  sheetName: string;
  headerMode: 'KEEP' | 'WRITE';
  period: FormPeriod;
  moneyScale: MoneyScale;
  rows: GridRow[];
  cells: GridCell[];
  merges: GridMerge[];
  columnWidths: Array<{ col: number; width: number }>;
  issues: GridIssue[];
}

/** The A1 name of a column: 1 is A, 27 is AA. */
export function columnLetters(col: number): string {
  let rest = col;
  let letters = '';
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

export const cellRef = (row: number, col: number): string => `${columnLetters(col)}${row}`;

interface Placed {
  layoutRow: LayoutRow;
  row: number;
  templateRow: number;
  inserted: boolean;
  /** Index (0-based) of the record this row shows, or -1 when the row is not a record row (a reserved row left unused, or not a DATA row). */
  record: number;
  unusedReserved: boolean;
}

function dateText(value: string): string | null {
  const match = ISO_DAY.exec(value);
  return match === null ? null : `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Fills the layout with the data of one period. Pure and deterministic: the same layout and data give the same grid. Throws VALIDATION_FAILED for a layout that is not a grid, and for a DATA row set to REFUSE whose dataset
 * has more records than the form has lines; everything the data fails to give (a figure with no value, a dataset that is missing) is an issue of the grid and an empty cell, so the copy can say what it lacks.
 */
export function fillGrid(layout: ReportLayout, data: ReportFillData): FilledGrid {
  validateLayout(layout);
  assertReportPeriod(data.period);
  const locale: ReportLocale = data.locale ?? 'vi';
  const rows = rowsOf(layout);
  const start = layout.startRow ?? 1;

  // Pass 1: where every row of the sheet goes.
  const placed: Placed[] = [];
  const blocks = new Map<string, { first: number; last: number }>();
  let outRow = start;
  let templateCursor = start;
  for (const layoutRow of rows) {
    if (layoutRow.kind !== 'DATA') {
      placed.push({ layoutRow, row: outRow, templateRow: templateCursor, inserted: false, record: -1, unusedReserved: false });
      outRow += 1;
      templateCursor += 1;
      continue;
    }
    const dataset = layoutRow.dataset as string;
    const capacity = layoutRow.capacity ?? 1;
    const records = data.datasets[dataset]?.length ?? 0;
    if (records > capacity && layoutRow.overflow === 'REFUSE') fail('dataset_overflow');
    const total = Math.max(records, capacity);
    blocks.set(dataset, { first: outRow, last: outRow + total - 1 });
    for (let index = 0; index < total; index += 1) {
      const reserved = index < capacity;
      placed.push({ layoutRow, row: outRow + index, templateRow: reserved ? templateCursor + index : templateCursor + capacity - 1, inserted: !reserved, record: index < records ? index : -1, unusedReserved: index >= records });
    }
    outRow += total;
    templateCursor += capacity;
  }
  if (outRow - start > GRID_ROW_CAP) fail('grid_rows');

  const cells: GridCell[] = [];
  const merges: GridMerge[] = [];
  const issues: GridIssue[] = [];
  const figures = new Map<string, ReportFigure>();
  for (const figure of data.figures) figures.set(`${figure.code}|${figure.basis}`, figure);

  const issue = (row: number, col: number, code: GridIssueCode, detail: string | null): void => {
    issues.push({ ref: cellRef(row, col), row, col, code, detail });
  };

  /** A number as the cell writes it: scaled and rounded by whole numbers. Null when the value is not a number. */
  const numberCell = (raw: ReportScalar | undefined, format: CellFormat | undefined, fallbackDecimals: number | null, money: boolean): { number: string; numFmt: string } | null => {
    const text = decimalTextOf(raw);
    if (text === null) return null;
    let value = text;
    let decimals = format?.decimals ?? fallbackDecimals ?? 0;
    if (money) {
      const scale = format?.scale ?? layout.moneyScale;
      value = shiftDecimalLeft(text, SCALE_PLACES[scale]);
      decimals = format?.decimals ?? SCALE_DECIMALS[scale];
    }
    return { number: roundDecimalText(value, decimals), numFmt: format?.numFmt ?? numFmtOf(decimals) };
  };

  const textOrNumber = (placement: Placed, cell: LayoutCell, raw: ReportScalar | undefined, source: string | null, fallbackDecimals: number | null, fallbackMoney: boolean): GridCell => {
    const { row } = placement;
    const base = { row, col: cell.col, source };
    const format = cell.format;
    const money = format?.money ?? (format?.scale !== undefined || fallbackMoney);
    const kind = format?.kind ?? (fallbackDecimals !== null || money || format?.decimals !== undefined ? 'NUMBER' : 'TEXT');
    if (raw === null || raw === undefined || raw === '') return { ...base, kind: 'EMPTY' };
    if (kind === 'NUMBER') {
      const made = numberCell(raw, format, fallbackDecimals, money);
      if (made === null) {
        issue(row, cell.col, 'NOT_A_NUMBER', null);
        return { ...base, kind: 'EMPTY' };
      }
      return { ...base, kind: 'NUMBER', number: made.number, numFmt: made.numFmt };
    }
    if (kind === 'DATE') {
      const shown = typeof raw === 'string' ? dateText(raw) : null;
      return shown === null ? { ...base, kind: 'TEXT', text: String(raw) } : { ...base, kind: 'TEXT', text: shown };
    }
    return { ...base, kind: 'TEXT', text: String(raw) };
  };

  const evaluate = (placement: Placed, cell: LayoutCell): GridCell => {
    const { row } = placement;
    const binding = cell.binding;
    const empty = (source: string | null): GridCell => ({ row, col: cell.col, kind: 'EMPTY', source });
    switch (binding.kind) {
      case 'TEXT':
        return { row, col: cell.col, kind: 'TEXT', text: binding.text, source: null };
      case 'META': {
        let value: string | undefined;
        if (binding.key === 'PERIOD_LABEL') value = periodLabel(data.period, locale);
        else if (binding.key === 'PERIOD_CODE') value = periodCode(data.period);
        else if (binding.key === 'UNIT_LABEL') value = unitLine(layout.moneyScale, locale);
        else value = data.meta[binding.key];
        if (value === undefined || value === '') {
          issue(row, cell.col, 'META_MISSING', binding.key);
          return empty(null);
        }
        return { row, col: cell.col, kind: 'TEXT', text: value, source: null };
      }
      case 'INDICATOR': {
        const definition = data.definitions[binding.code];
        if (definition === undefined) {
          issue(row, cell.col, 'NO_DEFINITION', binding.code);
          return empty(null);
        }
        const basis = binding.basis ?? defaultBasisOf(definition.period);
        const source = `INDICATOR:${binding.code}@${basis}`;
        const figure = figures.get(`${binding.code}|${basis}`);
        if (figure === undefined) {
          issue(row, cell.col, 'NO_FIGURE', `${binding.code}@${basis}`);
          return empty(source);
        }
        for (const flag of figure.flags ?? []) issue(row, cell.col, flag, binding.code);
        if (figure.value === null || figure.value === undefined) {
          if (!(figure.flags ?? []).includes('NO_DATA')) issue(row, cell.col, 'NO_DATA', binding.code);
          return empty(source);
        }
        const isMoney = definition.unit === 'VND';
        const places = definition.unit === 'PERCENT' || definition.unit === 'RATIO' || definition.unit === 'DAYS' ? definition.decimals : 0;
        const made = numberCell(figure.value, cell.format, places, isMoney);
        if (made === null) {
          issue(row, cell.col, 'NOT_A_NUMBER', binding.code);
          return empty(source);
        }
        return { row, col: cell.col, kind: 'NUMBER', number: made.number, numFmt: made.numFmt, source };
      }
      case 'ROW_FIELD': {
        const record = placement.record < 0 ? undefined : data.datasets[placement.layoutRow.dataset as string]?.[placement.record];
        if (record === undefined) return empty(null);
        if (!(binding.field in record)) {
          issue(row, cell.col, 'FIELD_MISSING', binding.field);
          return empty(null);
        }
        return textOrNumber(placement, cell, record[binding.field], null, null, false);
      }
      case 'ROW_NUMBER':
        return placement.record < 0 ? empty(null) : { row, col: cell.col, kind: 'NUMBER', number: String(placement.record + 1), numFmt: '0', source: null };
      case 'SUM': {
        const records = data.datasets[binding.dataset];
        const source = `SUM:${binding.dataset}.${binding.field}`;
        if (records === undefined) {
          issue(row, cell.col, 'DATASET_MISSING', binding.dataset);
          return empty(source);
        }
        const values: string[] = [];
        for (const record of records) {
          const raw = record[binding.field];
          if (raw === null || raw === undefined || raw === '') continue;
          const text = decimalTextOf(raw);
          if (text === null) {
            issue(row, cell.col, 'NOT_A_NUMBER', binding.field);
            return empty(source);
          }
          values.push(text);
        }
        if (values.length === 0) return empty(source);
        const made = numberCell(sumDecimalTexts(values), cell.format, null, cell.format?.money ?? cell.format?.scale !== undefined);
        return made === null ? empty(source) : { row, col: cell.col, kind: 'NUMBER', number: made.number, numFmt: made.numFmt, source };
      }
      case 'COUNT': {
        const records = data.datasets[binding.dataset];
        if (records === undefined) {
          issue(row, cell.col, 'DATASET_MISSING', binding.dataset);
          return empty(`COUNT:${binding.dataset}`);
        }
        return { row, col: cell.col, kind: 'NUMBER', number: String(records.length), numFmt: '0', source: `COUNT:${binding.dataset}` };
      }
      case 'FORMULA': {
        const formula = binding.formula
          .replace(/\{first:([A-Za-z0-9_.-]+)\}/g, (_match, name: string) => String(blocks.get(name)?.first ?? fail('formula_dataset')))
          .replace(/\{last:([A-Za-z0-9_.-]+)\}/g, (_match, name: string) => String(blocks.get(name)?.last ?? fail('formula_dataset')))
          .replace(/\{row([+-]\d+)?\}/g, (_match, offset: string | undefined) => String(row + (offset === undefined ? 0 : Number(offset))));
        return { row, col: cell.col, kind: 'FORMULA', formula: formula.startsWith('=') ? formula.slice(1) : formula, ...(cell.format?.numFmt === undefined ? {} : { numFmt: cell.format.numFmt }), source: null };
      }
    }
  };

  for (const [dataset, block] of blocks) {
    if (data.datasets[dataset] === undefined) issue(block.first, rows.find((row) => row.dataset === dataset)?.cells[0]?.col ?? 1, 'DATASET_MISSING', dataset);
  }

  const headerRowCount = layout.columns.length === 0 ? 0 : headerRowsOf(layout.columns).length;
  const headerStart = layout.preface.length;
  const gridRows: GridRow[] = [];
  placed.forEach((placement, index) => {
    gridRows.push({ row: placement.row, templateRow: placement.templateRow, inserted: placement.inserted, kind: placement.layoutRow.kind });
    const isHeader = index >= headerStart && index < headerStart + headerRowCount;
    for (const cell of placement.layoutRow.cells) {
      const colSpan = positive(cell.colSpan, 1);
      const rowSpan = positive(cell.rowSpan, 1);
      // A reserved row that holds no record clears its bound cells, so a sample line of the template never stays in a report.
      const written = placement.unusedReserved && placement.layoutRow.kind === 'DATA' ? ({ row: placement.row, col: cell.col, kind: 'EMPTY', source: null } as GridCell) : evaluate(placement, cell);
      if (!(isHeader && layout.headerMode === 'KEEP')) {
        cells.push(written);
        if (colSpan > 1 || rowSpan > 1) merges.push({ fromRow: placement.row, fromCol: cell.col, toRow: placement.row + rowSpan - 1, toCol: cell.col + colSpan - 1 });
      }
    }
  });

  const columnWidths = layout.columns.flatMap((column) => (column.width === undefined ? [] : [{ col: column.col, width: column.width }]));
  return { layoutCode: layout.code, layoutVersion: layout.version, status: layout.status, stamp: stampOf(layout), sheetName: layout.sheetName, headerMode: layout.headerMode, period: data.period, moneyScale: layout.moneyScale, rows: gridRows, cells, merges, columnWidths, issues };
}

// ---- narrative (Word) --------------------------------------------------------------------------------------------------------------------------

/**
 * The narrative part of a report (thuyết minh): blocks that the Word writer lays out. Text may carry tokens `{{indicator:CODE}}` or `{{indicator:CODE@BASIS}}` and `{{meta:KEY}}`: `fillNarrative` replaces them with the
 * figure written as the grid writes it, so a sentence and a table can never give two numbers for one indicator. `{{` that is not a token is left as written.
 */
export type NarrativeBlock =
  | { type: 'HEADING'; level: 1 | 2 | 3; text: string }
  | { type: 'PARAGRAPH'; text: string; align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY' | undefined; bold?: boolean | undefined; italic?: boolean | undefined }
  | { type: 'LIST'; ordered: boolean; items: string[] }
  | { type: 'TABLE'; header: string[]; rows: string[][]; widths?: number[] | undefined }
  | { type: 'PAGE_BREAK' }
  | { type: 'SIGNATURES'; slots: Array<{ role: string; name: string | null }> };

export interface NarrativeIssue {
  token: string;
  code: GridIssueCode;
}

export interface FilledNarrative {
  blocks: NarrativeBlock[];
  issues: NarrativeIssue[];
}

const TOKEN = /\{\{(indicator|meta):([^{}@]+?)(?:@([A-Z_]+))?\}\}/g;

/** Resolves the tokens of every text of the blocks; an unresolved token leaves a visible "—" and an issue, never a made-up number. */
export function fillNarrative(blocks: readonly NarrativeBlock[], data: ReportFillData, moneyScale: MoneyScale): FilledNarrative {
  assertReportPeriod(data.period);
  const locale: ReportLocale = data.locale ?? 'vi';
  const figures = new Map<string, ReportFigure>();
  for (const figure of data.figures) figures.set(`${figure.code}|${figure.basis}`, figure);
  const issues: NarrativeIssue[] = [];
  const resolve = (text: string): string =>
    text.replace(TOKEN, (token: string, kind: string, key: string, basisText: string | undefined) => {
      const name = key.trim();
      if (kind === 'meta') {
        const value = name === 'PERIOD_LABEL' ? periodLabel(data.period, locale) : name === 'PERIOD_CODE' ? periodCode(data.period) : name === 'UNIT_LABEL' ? unitLine(moneyScale, locale) : data.meta[name];
        if (value === undefined || value === '') {
          issues.push({ token, code: 'META_MISSING' });
          return '—';
        }
        return value;
      }
      const definition = data.definitions[name];
      if (definition === undefined) {
        issues.push({ token, code: 'NO_DEFINITION' });
        return '—';
      }
      const basis = (basisText ?? defaultBasisOf(definition.period)) as PeriodBasis;
      const figure = (PERIOD_BASES as readonly string[]).includes(basis) ? figures.get(`${name}|${basis}`) : undefined;
      if (figure === undefined) {
        issues.push({ token, code: 'NO_FIGURE' });
        return '—';
      }
      for (const flag of figure.flags ?? []) issues.push({ token, code: flag });
      const raw = decimalTextOf(figure.value);
      if (raw === null) {
        issues.push({ token, code: figure.value === null ? 'NO_DATA' : 'NOT_A_NUMBER' });
        return '—';
      }
      if (definition.unit === 'VND') return groupDigits(roundDecimalText(shiftDecimalLeft(raw, SCALE_PLACES[moneyScale]), SCALE_DECIMALS[moneyScale]), locale);
      const places = definition.unit === 'PERCENT' || definition.unit === 'RATIO' || definition.unit === 'DAYS' ? definition.decimals : 0;
      return groupDigits(roundDecimalText(raw, places), locale);
    });
  const out: NarrativeBlock[] = blocks.map((block): NarrativeBlock => {
    switch (block.type) {
      case 'HEADING':
        return { ...block, text: resolve(block.text) };
      case 'PARAGRAPH':
        return { ...block, text: resolve(block.text) };
      case 'LIST':
        return { ...block, items: block.items.map(resolve) };
      case 'TABLE':
        return { ...block, header: block.header.map(resolve), rows: block.rows.map((row) => row.map(resolve)) };
      case 'SIGNATURES':
        return { ...block, slots: block.slots.map((slot) => ({ role: resolve(slot.role), name: slot.name === null ? null : resolve(slot.name) })) };
      case 'PAGE_BREAK':
        return block;
    }
  });
  return { blocks: out, issues };
}

/** The digits of a decimal text in groups of three: Vietnamese writes 1.234.567,89 and English 1,234,567.89. */
export function groupDigits(value: string, locale: ReportLocale = 'vi'): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction] = (negative ? value.slice(1) : value).split('.');
  const group = locale === 'vi' ? '.' : ',';
  const point = locale === 'vi' ? ',' : '.';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `${point}${fraction}`}`;
}

// ---- the forms the first customer asked for ------------------------------------------------------------------------------------------------------

/**
 * The six forms of the enterprise edition (ENT-1 and RPT-1 plan, "6 biểu mẫu báo cáo"). The official templates have not arrived, so for the demo stage the system designs the six forms itself: each is listed as DEMO
 * ("mẫu demo do hệ thống thiết kế, chưa phải mẫu chính thức"), issuable only in demo mode and stamped with the demo mark. `official` is the acceptance of the form by the customer and stays PENDING_EXTERNAL until the
 * official template arrives and the owner confirms it matches (R18): the catalogue never says a demo form is accepted. The names say "chờ mẫu chính thức" and are never offered as an official form.
 */
export interface ReportFormEntry {
  code: string;
  name: string;
  receiver: string;
  period: FormPeriodKind;
  /** What the form is now: a DEMO design of ours. */
  status: 'DEMO';
  /** The acceptance of the official form: still waiting. */
  official: 'PENDING_EXTERNAL';
}

export const REPORT_FORM_CATALOGUE: readonly ReportFormEntry[] = Object.freeze([
  { code: 'PVN-MONTHLY', name: 'Báo cáo tháng gửi Tập đoàn (mẫu demo, chờ mẫu chính thức)', receiver: 'PVN', period: 'MONTH', status: 'DEMO', official: 'PENDING_EXTERNAL' },
  { code: 'PVN-QUARTERLY-F2', name: 'Báo cáo quý gửi Tập đoàn, Biểu 2 (mẫu demo, chờ mẫu chính thức)', receiver: 'PVN', period: 'QUARTER', status: 'DEMO', official: 'PENDING_EXTERNAL' },
  { code: 'HPM-MONTHLY', name: 'Báo cáo tháng theo định dạng HPM (mẫu demo, chờ mẫu chính thức)', receiver: 'HPM', period: 'MONTH', status: 'DEMO', official: 'PENDING_EXTERNAL' },
  { code: 'COMMITTEE-PERIODIC', name: 'Báo cáo định kỳ Ủy ban Đầu tư phát triển và Khoa học công nghệ (mẫu demo, chờ mẫu chính thức)', receiver: 'UB-DTPT-KHCN', period: 'QUARTER', status: 'DEMO', official: 'PENDING_EXTERNAL' },
  { code: 'INVEST-STEERING', name: 'Báo cáo giao ban đầu tư (mẫu demo, chờ mẫu chính thức)', receiver: 'BAN-KHDT', period: 'MONTH', status: 'DEMO', official: 'PENDING_EXTERNAL' },
  { code: 'PLANT-PHU-MY', name: 'Báo cáo Nhà máy Đạm Phú Mỹ (mẫu demo, chờ mẫu chính thức)', receiver: 'NMD-PM', period: 'MONTH', status: 'DEMO', official: 'PENDING_EXTERNAL' },
] satisfies readonly ReportFormEntry[]);
