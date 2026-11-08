import { DEMO_MARK, REPORT_FORM_CATALOGUE, dataRowOf, headerRowsOf, validateLayout } from '@machvon/kernel/src/report-layout.ts';
import type { CellFormat, FormPeriodKind, LayoutCell, LayoutColumn, LayoutRow, NarrativeBlock, PeriodBasis, ReportLayout } from '@machvon/kernel/src/report-layout.ts';
import { fillText, textsOf } from './texts.ts';

/**
 * The shared builders of the six demo report forms (RPT-1, owner decision of 2026-11-08). The official forms of the customer have not arrived, so the system designs them: Vietnamese state-enterprise report
 * forms with a title block (parent group, the name of the enterprise, the form number), the title and period, the unit of account, a strip of the headline indicators (bound to the KPI codes of the enterprise
 * indicator pack), a two-level header, rows for each project grouped by kind (capital construction, purchase of assets, major repairs) with a subtotal for each group and a grand total, notes and the signature
 * block (preparer, checker, approver). The words are Vietnamese and live in `messages/forms.vi.json`; the layout, the bindings and the formulas are here.
 * Everything here is data of the layout (`ReportLayout`): no Excel and no Word is written in this folder except by `template-builder.ts`, and no number is a constant of the form.
 */

// ---- what a form is ---------------------------------------------------------------------------------------------------------------------------------

export type PrefaceRole = 'MARK' | 'HEAD_PARENT' | 'HEAD_ORG' | 'TITLE' | 'PERIOD' | 'UNIT' | 'KPI_LABEL' | 'KPI_VALUE';
export type BodyRole = 'GROUP' | 'DATA' | 'SUBTOTAL' | 'GRAND' | 'NOTE' | 'DATE' | 'SIGN_TITLE' | 'SIGN_HINT' | 'SPACER' | 'SIGN_NAME';
export type RowRole = PrefaceRole | 'HEADER' | BodyRole;

export interface DemoPrint {
  paper: 'A3' | 'A4';
  orientation: 'landscape';
}

/** One designed form: its layout, the narrative skeleton when it has a narrative part, how it prints, and the roles of its rows (what the template builder styles by). */
export interface DemoFormSpec {
  layout: ReportLayout;
  /** The narrative blocks (the Word narrative part) of the form, with `{{indicator:CODE@BASIS}}` and `{{meta:KEY}}` tokens; null when the form is a table only. */
  narrative: readonly NarrativeBlock[] | null;
  print: DemoPrint;
  prefaceRoles: readonly PrefaceRole[];
  bodyRoles: readonly BodyRole[];
  /** The datasets of the form, in the order of its groups, with the words of their group row. */
  groups: ReadonlyArray<{ dataset: string; title: string }>;
  /** Every indicator code the form is bound to (the strip). */
  indicatorCodes: readonly string[];
  /** The facts the form reads from `data.meta` (the derived ones, PERIOD_LABEL and UNIT_LABEL, are not listed). */
  metaKeys: readonly string[];
}

/** The facts every demo form reads from `data.meta`. */
export const FORM_META_KEYS = Object.freeze(['PARENT_NAME', 'ORG_NAME', 'REPORT_DATE_LINE', 'SIGN_PREPARER', 'SIGN_CHECKER', 'SIGN_APPROVER']);

// ---- the columns ------------------------------------------------------------------------------------------------------------------------------------

export type ColumnKey =
  | 'stt'
  | 'code'
  | 'name'
  | 'grp'
  | 'kind'
  | 'owner_unit'
  | 'tmdt'
  | 'plan_year'
  | 'plan_force'
  | 'est_p'
  | 'exec_p'
  | 'disb_p'
  | 'exec_ytd'
  | 'disb_ytd'
  | 'exec_start'
  | 'disb_start'
  | 'outlook'
  | 'rate_exec'
  | 'rate_disb'
  | 'rate_outlook'
  | 'cap_equity'
  | 'cap_debt'
  | 'cap_other'
  | 'status'
  | 'schedule'
  | 'cause'
  | 'issues'
  | 'next'
  | 'proposal';

const MONEY: CellFormat = { scale: 'MILLION_VND' };
const RATE: CellFormat = { numFmt: '#,##0.0' };

/** The texts of the report forms: the headers of the columns, the words of the layout, the labels of the headline strip, the notes and the titles. */
export interface FormTexts {
  period: Readonly<Record<'MONTH' | 'QUARTER', string>>;
  columns: Readonly<Record<ColumnKey, readonly string[]>>;
  groups: Readonly<Record<string, string>>;
  layout: { formNo: string; subtotal: string; grandFlat: string; grand: string; signRoles: readonly string[]; signHint: string };
  strip: Readonly<Record<string, string>>;
  notes: Readonly<Record<string, string>>;
  titles: Readonly<Record<string, string>>;
}

/** The texts of `messages/forms.vi.json`, read once. */
export const formTexts = (): FormTexts => textsOf<FormTexts>('forms');

interface ColumnDef {
  width: number;
  money?: true;
  /** A rate column holds a live formula: the numerator and the denominator column. */
  rate?: { of: ColumnKey; over: ColumnKey };
}

/** The shape of each column (its width, whether it is money or a rate); the header words are in `messages/forms.vi.json` under the same key. */
const COLUMN_DEFS: Readonly<Record<ColumnKey, ColumnDef>> = {
  stt: { width: 5 },
  code: { width: 13 },
  name: { width: 40 },
  grp: { width: 7 },
  kind: { width: 16 },
  owner_unit: { width: 18 },
  tmdt: { width: 15, money: true },
  plan_year: { width: 14, money: true },
  plan_force: { width: 14, money: true },
  est_p: { width: 14, money: true },
  exec_p: { width: 14, money: true },
  disb_p: { width: 14, money: true },
  exec_ytd: { width: 14, money: true },
  disb_ytd: { width: 14, money: true },
  exec_start: { width: 14, money: true },
  disb_start: { width: 14, money: true },
  outlook: { width: 15, money: true },
  rate_exec: { width: 11, rate: { of: 'exec_ytd', over: 'plan_force' } },
  rate_disb: { width: 11, rate: { of: 'disb_ytd', over: 'plan_force' } },
  rate_outlook: { width: 12, rate: { of: 'outlook', over: 'plan_force' } },
  cap_equity: { width: 14, money: true },
  cap_debt: { width: 14, money: true },
  cap_other: { width: 12, money: true },
  status: { width: 38 },
  schedule: { width: 15 },
  cause: { width: 30 },
  issues: { width: 40 },
  next: { width: 30 },
  proposal: { width: 28 },
};

/** The money columns of a form (the ones a subtotal adds up). */
export const moneyColumnKeys = (keys: readonly ColumnKey[]): ColumnKey[] => keys.filter((key) => COLUMN_DEFS[key].money === true);

export function columnsOf(keys: readonly ColumnKey[], periodWord: string): LayoutColumn[] {
  return keys.map((key, index) => {
    const def = COLUMN_DEFS[key];
    const format = def.money === true ? MONEY : def.rate === undefined ? undefined : RATE;
    const header = formTexts().columns[key].map((text) => fillText(text, { period: periodWord }));
    return { col: index + 1, key, header, width: def.width, ...(format === undefined ? {} : { format }) };
  });
}

// ---- cells ------------------------------------------------------------------------------------------------------------------------------------------

const text = (col: number, value: string, colSpan = 1): LayoutCell => ({ col, binding: { kind: 'TEXT', text: value }, ...(colSpan > 1 ? { colSpan } : {}) });
const meta = (col: number, key: string, colSpan = 1): LayoutCell => ({ col, binding: { kind: 'META', key }, ...(colSpan > 1 ? { colSpan } : {}) });

const letterOf = (columns: readonly LayoutColumn[], key: string): string => {
  const column = columns.find((candidate) => candidate.key === key);
  if (column === undefined) throw new Error(`demo form: no column ${key}`);
  let rest = column.col;
  let letters = '';
  while (rest > 0) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
};

/** The live formula of a rate column: the numerator over the denominator in percent, one place, empty when the denominator is not above zero. */
const rateFormula = (columns: readonly LayoutColumn[], key: ColumnKey): string => {
  const rate = COLUMN_DEFS[key].rate;
  if (rate === undefined) throw new Error(`demo form: ${key} is not a rate`);
  const top = letterOf(columns, rate.of);
  const bottom = letterOf(columns, rate.over);
  return `IF(${bottom}{row}>0,ROUND(${top}{row}/${bottom}{row}*100,1),"")`;
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

// ---- the form ---------------------------------------------------------------------------------------------------------------------------------------

export interface StripItem {
  label: string;
  code: string;
  basis: PeriodBasis;
}

export interface TableFormDef {
  code: string;
  sheetName: string;
  /** The words of the title, upper case, without the period. */
  title: string;
  /** The number the form prints in the corner of its title block. */
  formNo: string;
  period: Extract<FormPeriodKind, 'MONTH' | 'QUARTER'>;
  keys: readonly ColumnKey[];
  groups: ReadonlyArray<{ dataset: string; title: string }>;
  strip: readonly StripItem[];
  notes: readonly string[];
  print: DemoPrint;
  narrative?: readonly NarrativeBlock[] | null;
  /** One block of rows with no group row and no subtotal (a flat list for a system to read, as the HPM form is). */
  flat?: boolean;
}

const spanRows = (n: number, parts: number): Array<{ from: number; span: number }> => {
  const base = Math.floor(n / parts);
  const extra = n % parts;
  let from = 1;
  return Array.from({ length: parts }, (_, index) => {
    const span = base + (index < extra ? 1 : 0);
    const placed = { from, span };
    from += span;
    return placed;
  });
};

/** The preface: the demo mark, the title block, the title, the period, the unit of account and the strip of headline indicators. */
function prefaceOf(def: TableFormDef, columnCount: number): { rows: LayoutRow[]; roles: PrefaceRole[] } {
  const n = columnCount;
  const left = Math.max(3, Math.floor(n * 0.3));
  const right = Math.max(3, Math.floor(n * 0.22));
  const rows: LayoutRow[] = [];
  const roles: PrefaceRole[] = [];
  const push = (role: PrefaceRole, cells: LayoutCell[]): void => {
    rows.push({ kind: 'TITLE', cells });
    roles.push(role);
  };
  push('MARK', [text(1, DEMO_MARK, n)]);
  push('HEAD_PARENT', [meta(1, 'PARENT_NAME', left), text(n - right + 1, fillText(formTexts().layout.formNo, { formNo: def.formNo }), right)]);
  push('HEAD_ORG', [meta(1, 'ORG_NAME', left)]);
  push('TITLE', [text(1, def.title, n)]);
  push('PERIOD', [meta(1, 'PERIOD_LABEL', n)]);
  push('UNIT', [meta(n - right + 1, 'UNIT_LABEL', right)]);
  const spans = spanRows(n, def.strip.length);
  push(
    'KPI_LABEL',
    def.strip.map((item, index) => text((spans[index] as { from: number }).from, item.label, (spans[index] as { span: number }).span)),
  );
  push(
    'KPI_VALUE',
    def.strip.map((item, index) => ({ col: (spans[index] as { from: number }).from, colSpan: (spans[index] as { span: number }).span, binding: { kind: 'INDICATOR', code: item.code, basis: item.basis } })),
  );
  return { rows, roles };
}

export function buildTableForm(def: TableFormDef): DemoFormSpec {
  const entry = REPORT_FORM_CATALOGUE.find((candidate) => candidate.code === def.code);
  if (entry === undefined || entry.period !== def.period) throw new Error(`demo form ${def.code} is not in the catalogue for its period`);
  const texts = formTexts();
  const periodWord = texts.period[def.period];
  const columns = columnsOf(def.keys, periodWord);
  const n = columns.length;
  const { rows: prefaceRows, roles: prefaceRoles } = prefaceOf(def, n);
  const money = moneyColumnKeys(def.keys);
  const rates = def.keys.filter((key) => COLUMN_DEFS[key].rate !== undefined);
  const col = (key: ColumnKey): number => (columns.find((candidate) => candidate.key === key) as LayoutColumn).col;

  const body: LayoutRow[] = [];
  const roles: BodyRole[] = [];
  const push = (role: BodyRole, row: LayoutRow): void => {
    body.push(row);
    roles.push(role);
  };
  const labelWidth = Math.min(4, n);

  // Subtotal and total rows: sums of the money columns over the block(s) of rows, rates as live formulas of the row's own cells.
  const totalRow = (label: string, datasets: readonly string[]): LayoutRow => {
    const cells: LayoutCell[] = [text(1, label, labelWidth)];
    for (const key of money) {
      const letter = letterOf(columns, key);
      const ranges = datasets.map((dataset) => `${letter}{first:${dataset}}:${letter}{last:${dataset}}`).join(',');
      cells.push({ col: col(key), binding: { kind: 'FORMULA', formula: `SUM(${ranges})` }, format: { numFmt: '#,##0' } });
    }
    for (const key of rates) cells.push({ col: col(key), binding: { kind: 'FORMULA', formula: rateFormula(columns, key) }, format: RATE });
    return { kind: 'TOTAL', cells: cells.sort((a, b) => a.col - b.col) };
  };

  const flat = def.flat === true;
  if (flat && def.groups.length !== 1) throw new Error(`demo form ${def.code}: a flat form has one block`);
  def.groups.forEach((group, index) => {
    const numeral = ROMAN[index] as string;
    if (!flat) push('GROUP', { kind: 'NOTE', cells: [text(1, `${numeral}. ${group.title}`, n)] });
    const data = dataRowOf(group.dataset, columns, { capacity: 1, overflow: 'EXPAND', numbered: 'stt' });
    // A rate column is a live formula of the row, not a field of the record.
    data.cells = data.cells.map((cell) => {
      const key = columns.find((candidate) => candidate.col === cell.col)?.key as ColumnKey;
      return COLUMN_DEFS[key].rate === undefined ? cell : { col: cell.col, binding: { kind: 'FORMULA', formula: rateFormula(columns, key) }, format: RATE };
    });
    push('DATA', data);
    if (!flat) push('SUBTOTAL', totalRow(fillText(texts.layout.subtotal, { numeral }), [group.dataset]));
  });
  push('GRAND', totalRow(flat ? texts.layout.grandFlat : fillText(texts.layout.grand, { sum: def.groups.map((_, index) => ROMAN[index]).join(' + ') }), def.groups.map((group) => group.dataset)));

  for (const note of def.notes) push('NOTE', { kind: 'NOTE', cells: [text(1, note, n)] });

  // The signature block: the date line at the right, then the three roles with a line to sign and the name below.
  const thirds = spanRows(n, 3);
  const dateSpan = Math.max(4, Math.floor(n / 3));
  push('DATE', { kind: 'NOTE', cells: [meta(n - dateSpan + 1, 'REPORT_DATE_LINE', dateSpan)] });
  push('SIGN_TITLE', { kind: 'NOTE', cells: texts.layout.signRoles.map((role, index) => text((thirds[index] as { from: number }).from, role, (thirds[index] as { span: number }).span)) });
  push('SIGN_HINT', { kind: 'NOTE', cells: thirds.map((third) => text(third.from, texts.layout.signHint, third.span)) });
  push('SPACER', { kind: 'NOTE', cells: [] });
  push('SPACER', { kind: 'NOTE', cells: [] });
  push('SIGN_NAME', { kind: 'NOTE', cells: ['SIGN_PREPARER', 'SIGN_CHECKER', 'SIGN_APPROVER'].map((key, index) => meta((thirds[index] as { from: number }).from, key, (thirds[index] as { span: number }).span)) });

  const layout: ReportLayout = {
    code: def.code,
    name: entry.name,
    version: '1',
    status: 'DEMO',
    formRef: null,
    sheetName: def.sheetName,
    moneyScale: 'MILLION_VND',
    headerMode: 'KEEP',
    columns,
    preface: prefaceRows,
    body,
  };
  validateLayout(layout);
  return {
    layout,
    narrative: def.narrative ?? null,
    print: def.print,
    prefaceRoles,
    bodyRoles: roles,
    groups: def.groups,
    indicatorCodes: [...new Set(def.strip.map((item) => item.code))],
    metaKeys: FORM_META_KEYS,
  };
}

/** The roles of every row of the layout in the order of the grid: preface, header (as many rows as the deepest column header), body. */
export function rowRolesOf(form: DemoFormSpec): RowRole[] {
  return [...form.prefaceRoles, ...headerRowsOf(form.layout.columns).map((): RowRole => 'HEADER'), ...form.bodyRoles];
}
