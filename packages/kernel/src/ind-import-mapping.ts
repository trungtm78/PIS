import { DomainError } from './errors.ts';
import { accept, reject, sourceRowsOfTable } from './file-import.ts';
import type { FileImportFormat, RowJudgement, SourceRow } from './file-import.ts';
import { multiplyDecimal } from './decimal.ts';
import { IMPORT_LAYOUTS, IMPORT_SCALES, INDICATOR_IMPORT_RULE_TYPE, NUMBER_FORMATS, SCALE_FACTORS } from './ind-definitions.ts';
import type { ImportLayout, ImportScale, NumberFormat } from './ind-definitions.ts';
import { normalizeLabel } from './ind-dictionary.ts';
import { readTabularFile } from './tabular-file.ts';

/**
 * The import of an Excel or CSV form into indicator figures (IND-1): the pure half. A mapping (an `INDICATOR_IMPORT_MAPPING` rule: versioned, approved by someone other than its maker) says which column or
 * row of the customer's form is which indicator of the dictionary, in which unit the sheet is written and how its numbers are spelled. This module turns a mapping and the bytes of a file into rows the file
 * import framework can judge (the dry run reads the file exactly as the apply will), and never touches a database; what the dictionary and the register say about a row is for the db half.
 */

export const INDICATOR_IMPORT_CONNECTOR = 'INDICATOR_IMPORT';
export const INDICATOR_IMPORT_MAX_ROWS = 5000;

export interface ImportMappingLine {
  indicator: string;
  source: string;
  scale: ImportScale;
  required: boolean;
}

/** One mapping as a reader sees it. */
export interface ImportMapping {
  code: string;
  name: string;
  layout: ImportLayout;
  numberFormat: NumberFormat;
  projectColumn: string | null;
  periodColumn: string | null;
  labelColumn: string | null;
  valueColumn: string | null;
  lines: ImportMappingLine[];
  version: number;
  ruleId: string | null;
  origin: 'RULE' | 'DEFAULT';
  unverified: boolean;
}

const optionalText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value);

/** The mapping a resolved `INDICATOR_IMPORT_MAPPING` rule says. */
export function importMappingOf(resolved: { type: string; code: string; version: number; ruleId: string | null; source: 'RULE' | 'DEFAULT'; unverified: boolean; params: Record<string, unknown> }): ImportMapping {
  if (resolved.type !== INDICATOR_IMPORT_RULE_TYPE) throw new DomainError('VALIDATION_FAILED', 422, 'rule_type');
  const params = resolved.params;
  const layout = params['layout'];
  const format = params['number_format'];
  if (!isOneOf(IMPORT_LAYOUTS, layout) || !isOneOf(NUMBER_FORMATS, format) || !Array.isArray(params['lines'])) throw new DomainError('VALIDATION_FAILED', 422, 'params');
  const lines = (params['lines'] as Array<Record<string, unknown>>).map((line): ImportMappingLine => ({
    indicator: String(line['indicator']),
    source: String(line['source']),
    scale: isOneOf(IMPORT_SCALES, line['scale']) ? line['scale'] : 'ONE',
    required: line['required'] === true,
  }));
  return {
    code: resolved.code,
    name: typeof params['name'] === 'string' ? params['name'] : '',
    layout,
    numberFormat: format,
    projectColumn: optionalText(params['project_column']),
    periodColumn: optionalText(params['period_column']),
    labelColumn: optionalText(params['label_column']),
    valueColumn: optionalText(params['value_column']),
    lines,
    version: resolved.version,
    ruleId: resolved.ruleId,
    origin: resolved.source,
    unverified: resolved.unverified,
  };
}

// ---- numbers -------------------------------------------------------------------------------------------------------------------------------------------------------

const PLAIN = /^-?\d+(\.\d+)?$/;
const EXPONENT = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;
const VN_GROUPED = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/;
const VN_SIMPLE = /^-?\d+(,\d+)?$/;
const MAX_FRACTION = 6;
const MAX_INTEGER = 24;

/** A decimal text as a canonical one: no leading zero, no trailing zero of the fraction, no negative zero. */
export function canonicalDecimal(text: string): string {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const wholeKept = whole.replace(/^0+(?=\d)/, '');
  const fractionKept = fraction.replace(/0+$/, '');
  const body = fractionKept === '' ? wholeKept : `${wholeKept}.${fractionKept}`;
  return negative && body !== '0' ? `-${body}` : body;
}

/** An exponent form (`1.2345E7`, as a spreadsheet may write a large number) as a plain decimal text, or undefined when the exponent is absurd. */
function plainOfExponent(text: string): string | undefined {
  const match = EXPONENT.exec(text);
  if (match === null) return undefined;
  const [, sign = '', whole = '0', fraction = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 40) return undefined;
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  let body: string;
  if (point <= 0) body = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) body = `${digits}${'0'.repeat(point - digits.length)}`;
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}${body}`;
}

/**
 * The number a cell says as a canonical decimal text, or undefined when the cell is not a number in the spelling of the mapping. `PLAIN` reads 1234.56 (and an exponent form); `VN` reads 1.234,56 and 1234,56.
 * A group sign in the wrong place, two signs, a percent sign, a currency word are all "not a number": the row is refused, never guessed at.
 */
export function parseNumberCell(cell: string, format: NumberFormat): string | undefined {
  const text = cell.replace(/[\u00a0\u202f\u2009 ]/g, '');
  if (text === '') return undefined;
  if (format === 'VN') {
    if (!VN_GROUPED.test(text) && !VN_SIMPLE.test(text)) return undefined;
    return canonicalDecimal(text.replaceAll('.', '').replace(',', '.'));
  }
  const exponent = plainOfExponent(text);
  const plain = exponent ?? text;
  return PLAIN.test(plain) ? canonicalDecimal(plain) : undefined;
}

export type ScaleOutcome = { ok: true; value: string } | { ok: false; code: 'NUMBER_TOO_PRECISE' };

/** The figure in the unit the register keeps (whole dong for money): the sheet's number times the factor of its scale, kept only when the result fits the column (24 integer digits, 6 fraction digits). */
export function scaledFigure(value: string, scale: ImportScale): ScaleOutcome {
  const scaled = canonicalDecimal(multiplyDecimal(value, SCALE_FACTORS[scale]));
  const [whole = '', fraction = ''] = (scaled.startsWith('-') ? scaled.slice(1) : scaled).split('.');
  if (whole.length > MAX_INTEGER || fraction.length > MAX_FRACTION) return { ok: false, code: 'NUMBER_TOO_PRECISE' };
  return { ok: true, value: scaled };
}

/** Whether a figure fits the unit of its indicator: money is whole dong, a percent or a ratio keeps up to six places. */
export function figureFitsUnit(value: string, unit: string): boolean {
  if (unit === 'VND' || unit === 'COUNT') return !value.includes('.');
  return true;
}

// ---- the format ------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a row of a form says once it is read: the project and the period it is for and the figures it carries (in the unit the register keeps). */
export interface ImportRecord {
  projectCode: string;
  periodCode: string;
  figures: Array<{ indicator: string; value: string }>;
}

/** The project and the period the request names, for a form that does not carry them. */
export interface ImportContext {
  projectCode?: string | undefined;
  periodCode?: string | undefined;
}

const cell = (values: Readonly<Record<string, string>>, header: string): string => (values[normalizeLabel(header)] ?? '').trim();

/** The headers of the file with their normalised names (a header that repeats after normalising is a file the mapping cannot read: 422 IMPORT_SCHEMA_INVALID). */
function normalizedTable(bytes: Uint8Array): { headers: string[]; rows: SourceRow[] } {
  const table = readTabularFile(bytes);
  const headers = table.headers.map(normalizeLabel);
  const named = headers.filter((header) => header !== '');
  if (new Set(named).size !== named.length) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { duplicate_columns: true } });
  return { headers, rows: sourceRowsOfTable({ ...table, headers }) };
}

const schemaInvalid = (extensions: Record<string, unknown>): DomainError => new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions });

/** The headers a mapping cannot do without, for the file at hand: the columns of its layout and the column of each required line. */
export function missingHeaders(mapping: ImportMapping, headers: readonly string[]): string[] {
  const present = new Set(headers.map(normalizeLabel));
  const needed: string[] = [];
  if (mapping.layout === 'ROWS') {
    if (mapping.labelColumn !== null) needed.push(mapping.labelColumn);
    if (mapping.valueColumn !== null) needed.push(mapping.valueColumn);
  } else {
    if (mapping.projectColumn !== null) needed.push(mapping.projectColumn);
    if (mapping.periodColumn !== null) needed.push(mapping.periodColumn);
    for (const line of mapping.lines) if (line.required) needed.push(line.source);
  }
  const missing = needed.filter((header) => !present.has(normalizeLabel(header)));
  if (mapping.layout === 'COLUMNS' && !mapping.lines.some((line) => present.has(normalizeLabel(line.source)))) missing.push(...mapping.lines.slice(0, 1).map((line) => line.source));
  return [...new Set(missing)];
}

/** Whether a mapping reads a file with these headers (the screen offers the mappings that do). */
export const mappingFitsHeaders = (mapping: ImportMapping, headers: readonly string[]): boolean => missingHeaders(mapping, headers).length === 0;

/** The format of one mapping, for one request: the file import framework reads and judges a file through it. Pure: the same mapping and the same bytes always give the same rows. */
export function indicatorImportFormat(mapping: ImportMapping, context: ImportContext = {}): FileImportFormat<ImportRecord> {
  const bySource = new Map(mapping.lines.map((line) => [normalizeLabel(line.source), line]));
  return {
    connectorCode: INDICATOR_IMPORT_CONNECTOR,
    formatVersion: `${mapping.code}.v${mapping.version}`.slice(0, 40),

    parse(bytes: Uint8Array): SourceRow[] {
      const { headers, rows } = normalizedTable(bytes);
      const missing = missingHeaders(mapping, headers);
      if (missing.length > 0) throw schemaInvalid({ missing_columns: missing });
      if (mapping.layout === 'COLUMNS') return rows;
      const label = normalizeLabel(mapping.labelColumn ?? '');
      const kept = rows.filter((row) => bySource.has(normalizeLabel(row.values[label] ?? '')));
      const seen = new Map<string, number>();
      for (const row of kept) {
        const key = normalizeLabel(row.values[label] ?? '');
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      // A label twice in one sheet would give two values to one figure: the mapping does not fit this file.
      const twice = [...seen].filter(([, count]) => count > 1).map(([key]) => bySource.get(key)?.source ?? key);
      if (twice.length > 0) throw schemaInvalid({ duplicate_rows: twice });
      const absent = mapping.lines.filter((line) => line.required && !seen.has(normalizeLabel(line.source))).map((line) => line.source);
      if (absent.length > 0) throw schemaInvalid({ missing_rows: absent });
      return kept;
    },

    judge(row: SourceRow): RowJudgement<ImportRecord> {
      const fromFile = (header: string | null): string => (header === null ? '' : cell(row.values, header));
      const projectCell = fromFile(mapping.projectColumn);
      const periodCell = fromFile(mapping.periodColumn);
      if (projectCell !== '' && context.projectCode !== undefined && projectCell !== context.projectCode) return reject('PROJECT_MISMATCH', 'project');
      if (periodCell !== '' && context.periodCode !== undefined && periodCell !== context.periodCode) return reject('PERIOD_MISMATCH', 'period');
      const projectCode = projectCell !== '' ? projectCell : (context.projectCode ?? '');
      const periodCode = periodCell !== '' ? periodCell : (context.periodCode ?? '');
      if (projectCode === '') return reject('PROJECT_MISSING', 'project');
      if (periodCode === '') return reject('PERIOD_MISSING', 'period', projectCode);
      const figures: ImportRecord['figures'] = [];
      const fields: Record<string, string> = { project: projectCode, period: periodCode };
      const lines = mapping.layout === 'ROWS' ? [bySource.get(normalizeLabel(cell(row.values, mapping.labelColumn ?? '')))] : mapping.lines;
      for (const line of lines) {
        if (line === undefined) return reject('LABEL_UNMAPPED', 'label', projectCode);
        const raw = mapping.layout === 'ROWS' ? cell(row.values, mapping.valueColumn ?? '') : cell(row.values, line.source);
        if (raw === '') {
          if (line.required) return reject('VALUE_REQUIRED', line.indicator, `${projectCode}|${periodCode}`);
          continue;
        }
        const number = parseNumberCell(raw, mapping.numberFormat);
        if (number === undefined) return reject('NUMBER_INVALID', line.indicator, `${projectCode}|${periodCode}`);
        const scaled = scaledFigure(number, line.scale);
        if (!scaled.ok) return reject(scaled.code, line.indicator, `${projectCode}|${periodCode}`);
        figures.push({ indicator: line.indicator, value: scaled.value });
        fields[line.indicator] = scaled.value;
      }
      if (figures.length === 0) return reject('ROW_EMPTY', 'row', `${projectCode}|${periodCode}`);
      const key = mapping.layout === 'ROWS' ? `${projectCode}|${periodCode}|${figures[0]?.indicator ?? ''}` : `${projectCode}|${periodCode}`;
      return accept({ businessKey: key, fields, record: { projectCode, periodCode, figures } });
    },

    mask: (values) => ({ ...values }),
  };
}
