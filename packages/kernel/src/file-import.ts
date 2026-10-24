import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';
import { subtractDecimal } from './decimal.ts';
import type { TabularFile } from './tabular-file.ts';

/** The most rows one file may carry through the framework: the file is judged and applied in one transaction (see docs/file-import.md). */
export const FILE_IMPORT_MAX_ROWS = 5000;
/** The longest business key; the database column carries the same limit. */
export const BUSINESS_KEY_MAX_LENGTH = 300;
/** The integer digits and the fraction digits of a measure; the column is numeric(30,6). */
export const MEASURE_MAX_INTEGER_DIGITS = 24;
export const MEASURE_MAX_FRACTION_DIGITS = 6;
/** What the quarantine keeps of a row: a masked preview of a few short values. */
export const PREVIEW_MAX_FIELDS = 30;
export const PREVIEW_MAX_VALUE_LENGTH = 200;
/** The code of the difference that the framework itself opens: a business key that came back with other content. */
export const DUPLICATE_CONFLICT_CODE = 'DUPLICATE_CONFLICT';
/** The codes with which the framework quarantines a row whose key or measure it cannot store. */
export const BUSINESS_KEY_INVALID_CODE = 'BUSINESS_KEY_INVALID';
export const MEASURE_INVALID_CODE = 'MEASURE_INVALID';

const CODE = /^[A-Z][A-Z0-9_]{0,49}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/;
const hasControlCharacter = (text: string): boolean => Array.from(text).some((character) => (character.codePointAt(0) ?? 0) < 0x20 || character.codePointAt(0) === 0x7f);
const MEASURE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** One row of the file as the format read it: the line it starts on (the first line of the file is 1) and its cells by column name. */
export interface SourceRow {
  line: number;
  values: Readonly<Record<string, string>>;
}

/** Why a row cannot be taken: a stable code the screen translates, and the field it is about. */
export interface Rejection {
  code: string;
  field: string;
}

/** A row the format accepts. */
export interface AcceptedRow<R> {
  /** What makes the row the same thing in every file: a statement number and date, a procurement code. */
  businessKey: string;
  /** The normalised content of the row: its SHA-256 tells a repeat of the row from the same key with other content. */
  fields: Readonly<Record<string, string>>;
  /** The typed row the module's apply step receives. */
  record: R;
  /** The decimal quantity the module certifies in its totals (an amount, an area), as an exact decimal string. */
  measure?: string;
}

export type RowJudgement<R> =
  | { accepted: true; row: AcceptedRow<R> }
  | { accepted: false; rejection: Rejection; businessKey?: string };

export const accept = <R>(row: AcceptedRow<R>): RowJudgement<R> => ({ accepted: true, row });
export const reject = <R = never>(code: string, field: string, businessKey?: string): RowJudgement<R> => ({
  accepted: false,
  rejection: { code, field },
  ...(businessKey === undefined ? {} : { businessKey }),
});

/**
 * The part of an adapter that knows one file layout and nothing else: it reads bytes into rows and judges one row at a time. It is pure
 * (no database, no clock), so a format is tested with a file and an expected list. The module that owns the data adds the part that
 * writes (see `FileImportAdapter` in the db package).
 */
export interface FileImportFormat<R> {
  /** The connector the file belongs to; the same name as the position in `integration_cursor`, for example TREASURY_STATEMENT_FILE. */
  readonly connectorCode: string;
  /** The version of the layout this format reads, kept with every import so a layout change is visible in the evidence. */
  readonly formatVersion: string;
  /** Reads the file. A file that cannot be read throws `DomainError('IMPORT_SCHEMA_INVALID', 422, 'file')`. */
  parse(bytes: Uint8Array): SourceRow[];
  /** Accepts or rejects one row. It never throws for bad data: a bad cell is a rejection with its code and field. */
  judge(row: SourceRow): RowJudgement<R>;
  /** The values of a rejected row that may be kept for a person to read (account numbers masked). Without it nothing of the row is kept. */
  mask?(values: Readonly<Record<string, string>>): Record<string, string>;
}

/** A difference between the file and what the module holds, or between two files. It becomes a reconciliation item with an owner. */
export interface Difference {
  /** What kind of difference: AMOUNT_MISMATCH, UNMATCHED_TRANSACTION. Upper case with underscores. */
  code: string;
  /** What the module holds and what the file says, as the text to show. Two decimals also give the signed difference. */
  expected?: string;
  actual?: string;
  detail?: string;
  /** Overrides the default time allowed to settle the item. */
  dueAfterSeconds?: number;
}

export interface PlannedAccepted<R> {
  line: number;
  accepted: true;
  row: AcceptedRow<R>;
  rowHash: string;
}

export interface PlannedRejected {
  line: number;
  accepted: false;
  rejection: Rejection;
  businessKey: string | null;
  rowHash: string;
  preview: Record<string, string> | null;
}

export type PlannedRow<R> = PlannedAccepted<R> | PlannedRejected;

export interface FilePlan<R> {
  fileSha256: string;
  rows: PlannedRow<R>[];
}

export const fileSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The hash of the content of a row: the same content gives the same hash whatever the order of the cells. The framework hashes what it
 * is given; trimming and case rules belong to the format, which decides what counts as the same content.
 */
export function rowHash(fields: Readonly<Record<string, string>>): string {
  return sha256Hex(canonicalJson(fields));
}

/** True when the text is an exact decimal that the measure column holds. */
export function isStorableMeasure(value: string): boolean {
  if (!MEASURE.test(value)) return false;
  const [integer = '', fraction = ''] = value.replace('-', '').split('.');
  return integer.length <= MEASURE_MAX_INTEGER_DIGITS && fraction.length <= MEASURE_MAX_FRACTION_DIGITS;
}

/** The signed difference `actual - expected` when both are decimals, and null when either is not (a date, a name). */
export function signedDifference(expected: string | undefined, actual: string | undefined): string | null {
  if (expected === undefined || actual === undefined || !MEASURE.test(expected) || !MEASURE.test(actual)) return null;
  return subtractDecimal(actual, expected);
}

/** A format that returns a malformed code is a defect of the format, never of the file: it is not turned into a rejection. */
export function assertRejection(rejection: Rejection): void {
  if (!CODE.test(rejection.code) || !FIELD.test(rejection.field)) throw new Error(`file import format returned a malformed rejection ${rejection.code}/${rejection.field}`);
}

export function checkDifference(difference: Difference): void {
  if (!CODE.test(difference.code)) throw new Error(`file import difference code ${difference.code} is malformed`);
  if (difference.dueAfterSeconds !== undefined && (!Number.isInteger(difference.dueAfterSeconds) || difference.dueAfterSeconds < 0)) {
    throw new Error('file import difference has a negative or fractional due time');
  }
}

/** What the quarantine keeps of a row: the masked values, cut to a few short ones. Nothing when the format has no mask. */
export function maskedPreview<R>(format: FileImportFormat<R>, values: Readonly<Record<string, string>>): Record<string, string> | null {
  if (format.mask === undefined) return null;
  const masked = format.mask(values);
  const preview: Record<string, string> = {};
  for (const key of Object.keys(masked).slice(0, PREVIEW_MAX_FIELDS)) preview[key] = (masked[key] ?? '').slice(0, PREVIEW_MAX_VALUE_LENGTH);
  return preview;
}

/**
 * Reads and judges a whole file without touching anything: the identity of the file, then every row accepted with its hash or rejected
 * with its reason. A row the format accepts but the framework cannot store (a key that is empty or too long, a measure that is not an
 * exact decimal within the column) is rejected here with BUSINESS_KEY_INVALID or MEASURE_INVALID, never left to a database overflow.
 * An unreadable file, a file with no row and a file over the row limit throw before anything is judged.
 */
export function planFileImport<R>(format: FileImportFormat<R>, bytes: Uint8Array, maxRows: number = FILE_IMPORT_MAX_ROWS): FilePlan<R> {
  const source = format.parse(bytes);
  if (source.length === 0) throw new DomainError('IMPORT_EMPTY', 422, 'file');
  if (source.length > maxRows) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');
  const rows = source.map((row): PlannedRow<R> => {
    const judged = format.judge(row);
    const rejected = (rejection: Rejection, businessKey: string | null): PlannedRejected => {
      assertRejection(rejection);
      return { line: row.line, accepted: false, rejection, businessKey, rowHash: rowHash(row.values), preview: maskedPreview(format, row.values) };
    };
    if (!judged.accepted) return rejected(judged.rejection, judged.businessKey?.trim().slice(0, BUSINESS_KEY_MAX_LENGTH) || null);
    const key = judged.row.businessKey.trim();
    if (key === '' || key.length > BUSINESS_KEY_MAX_LENGTH || hasControlCharacter(key)) return rejected({ code: BUSINESS_KEY_INVALID_CODE, field: 'business_key' }, null);
    const measure = judged.row.measure;
    if (measure !== undefined && !isStorableMeasure(measure)) return rejected({ code: MEASURE_INVALID_CODE, field: 'measure' }, key);
    return { line: row.line, accepted: true, row: { ...judged.row, businessKey: key }, rowHash: rowHash(judged.row.fields) };
  });
  return { fileSha256: fileSha256(bytes), rows };
}

/** The rows of a parsed CSV or Excel table as source rows: the cells by column name, with the line each row starts on. */
export function sourceRowsOfTable(table: TabularFile): SourceRow[] {
  return table.rows.map((cells, index) => {
    const values: Record<string, string> = {};
    table.headers.forEach((header, column) => {
      values[header] = cells[column] ?? '';
    });
    return { line: table.lines[index] ?? index + 2, values };
  });
}
