import { DomainError, accept, readTabularFile, reject } from '@machvon/kernel';
import type { FileImportFormat, RowJudgement, SourceRow } from '@machvon/kernel';

/** The connector whose position `integration_cursor` keeps (ST-MDM-007); the same name as in the baseline of every tenant. */
export const TREASURY_CONNECTOR_CODE = 'TREASURY_STATEMENT_FILE';
/** The provider of a transaction that came from a statement file (`treasury_import.provider` has the same default). */
export const TREASURY_FILE_PROVIDER = 'KBNN_FILE';
/**
 * The version of the layout below. The real layout of the Treasury statement is unknown until the agency gives anonymised samples
 * (R-PAY-04), so this layout is a WORKING ASSUMPTION and the adapter stays PROPOSED: it is kept with every import as evidence of what
 * was read, and a different layout is a new version, not an edit (docs/pay-treasury-import.md).
 */
export const TREASURY_FORMAT_VERSION = 'ASSUMED-2026.1';

/** The logical fields of one statement row, in the words of the database; the file may call them anything the column map names. */
export const TREASURY_FIELDS = ['document_no', 'document_date', 'project_code', 'treasury_office_code', 'amount_vnd', 'confirmed_at', 'direction', 'payee_account'] as const;
export type TreasuryField = (typeof TREASURY_FIELDS)[number];
/** A statement row without these is not a statement row: the file is refused as a whole when a column is missing. */
export const REQUIRED_FIELDS: readonly TreasuryField[] = ['document_no', 'document_date', 'project_code', 'treasury_office_code', 'amount_vnd', 'confirmed_at'];

/** The headers each field may carry in the file. The map is configuration: a layout that differs from the assumed one is a different map, not new code. */
export type TreasuryColumnMap = Readonly<Record<TreasuryField, readonly string[]>>;

export const DEFAULT_TREASURY_COLUMNS: TreasuryColumnMap = {
  document_no: ['document_no', 'so_chung_tu'],
  document_date: ['document_date', 'ngay_chung_tu'],
  project_code: ['project_code', 'ma_du_an'],
  treasury_office_code: ['treasury_office_code', 'ma_kbnn'],
  amount_vnd: ['amount_vnd', 'so_tien'],
  confirmed_at: ['confirmed_at', 'ngay_hach_toan'],
  direction: ['direction', 'loai_giao_dich'],
  payee_account: ['payee_account', 'so_tai_khoan'],
};

/** One accepted statement row, typed. The amount is whole VND as a digit string: no float exists between the file and the column. */
export interface TreasuryStatementRow {
  documentNo: string;
  documentDate: string;
  projectCode: string;
  officeCode: string;
  amountVnd: string;
  /** UTC instant, ISO 8601 with milliseconds. */
  confirmedAt: string;
  direction: 'PAYMENT';
}

/** The longest value of the text fields; the crosswalk keeps codes to 100 characters, and a business key has 300 in all. */
const MAX_TEXT = 100;
const MAX_AMOUNT_DIGITS = 24;
const VIETNAM_OFFSET = '+07:00';
const hasControlCharacter = (text: string): boolean => Array.from(text).some((character) => (character.codePointAt(0) ?? 0) < 0x20 || character.codePointAt(0) === 0x7f);

/** A header as it is compared: without accents, lower case, words joined by an underscore (the Vietnamese header for "voucher number" is `so_chung_tu`). */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, 'd') // the Vietnamese letter d-with-stroke, lower and upper case
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** A short text that may sit in a business key: trimmed, not empty, no control character and no `|` (the separator of the key). */
function keyPart(value: string | undefined): string | undefined {
  const text = (value ?? '').trim();
  return text === '' || text.length > MAX_TEXT || hasControlCharacter(text) || text.includes('|') ? undefined : text;
}

function isoDateOf(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

/** A calendar date as `YYYY-MM-DD` or `DD/MM/YYYY`; anything else, or a day that does not exist, is undefined. */
export function statementDate(value: string | undefined): string | undefined {
  const text = (value ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) return isoDateOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const vietnamese = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  return vietnamese === null ? undefined : isoDateOf(Number(vietnamese[3]), Number(vietnamese[2]), Number(vietnamese[1]));
}

/**
 * The moment the Treasury booked the payment, as a UTC instant: a date alone is the start of that day in Vietnam, a time without an offset is
 * Vietnam time. This is the date that counts as disbursed (CV 16437/BTC-DTPT, CXN-03), so a guess is never made: a value that does not read is undefined.
 */
export function statementInstant(value: string | undefined): string | undefined {
  const text = (value ?? '').trim();
  const day = statementDate(text);
  if (day !== undefined) return new Date(`${day}T00:00:00.000${VIETNAM_OFFSET}`).toISOString();
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (match === null || statementDate(match[1]) === undefined) return undefined;
  const instant = new Date(`${match[1]}T${match[2]}${match[3] ?? VIETNAM_OFFSET}`);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/**
 * Whole VND as a digit string, or undefined: plain digits or digits grouped by thousands with a dot, a comma or a space ("1.250.000"), and
 * nothing else. A fraction, a sign, a zero and a figure wider than the column are all refused: the file is never rounded into a different amount.
 */
export function wholeVnd(value: string | undefined): string | undefined {
  const text = (value ?? '').replace(/\u00a0/g, ' ').trim();
  const plain = /^\d+$/.test(text) ? text : /^\d{1,3}(?:[., ]\d{3})+$/.test(text) ? text.replace(/[., ]/g, '') : undefined;
  return plain !== undefined && /^[1-9]\d*$/.test(plain) && plain.length <= MAX_AMOUNT_DIGITS ? plain : undefined;
}

/** The identity of a transaction wherever it came from (PAY 3.3): the provider, the voucher, its date and the project. */
export function treasuryBusinessKey(provider: string, documentNo: string, documentDate: string, projectCode: string): string {
  return [provider, documentNo, documentDate, projectCode].join('|');
}

const invalidSchema = (): DomainError => new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');

/** For each field the index of its column, or undefined; two columns that both mean one field make the file ambiguous and unreadable. */
function columnIndexes(headers: readonly string[], columns: TreasuryColumnMap): Map<TreasuryField, number> {
  const names = headers.map(normalizeHeader);
  const found = new Map<TreasuryField, number>();
  for (const field of TREASURY_FIELDS) {
    const wanted = new Set(columns[field].map(normalizeHeader));
    const at = names.flatMap((name, index) => (wanted.has(name) ? [index] : []));
    if (at.length > 1) throw invalidSchema();
    if (at[0] !== undefined) found.set(field, at[0]);
  }
  if (REQUIRED_FIELDS.some((field) => !found.has(field))) throw invalidSchema();
  return found;
}

export interface TreasuryLayoutCheck {
  /** True when the headers have every required field exactly once: the file can be imported. */
  ok: boolean;
  /** The required fields that no header names, in the words of the database (`document_no`...). */
  missing: TreasuryField[];
}

/** Whether the headers of a file are those of the layout, so that a person is told before the import what the file lacks. */
export function checkTreasuryLayout(headers: readonly string[], options: TreasuryFormatOptions = {}): TreasuryLayoutCheck {
  const columns: TreasuryColumnMap = { ...DEFAULT_TREASURY_COLUMNS, ...options.columns };
  const names = headers.map(normalizeHeader);
  const missing: TreasuryField[] = [];
  let ambiguous = false;
  for (const field of TREASURY_FIELDS) {
    const wanted = new Set(columns[field].map(normalizeHeader));
    const found = names.filter((name) => wanted.has(name)).length;
    if (found > 1) ambiguous = true;
    if (found === 0 && REQUIRED_FIELDS.includes(field)) missing.push(field);
  }
  return { ok: missing.length === 0 && !ambiguous, missing };
}

/** What a person may read of a refused row: the voucher and the money, and the account number only by its last three digits. */
function maskedValues(values: Readonly<Record<string, string>>): Record<string, string> {
  const preview: Record<string, string> = {};
  for (const field of TREASURY_FIELDS) {
    if (field === 'payee_account') continue;
    preview[field] = values[field] ?? '';
  }
  const account = (values.payee_account ?? '').trim();
  if (account !== '') preview.payee_account = `***${account.slice(-3)}`;
  return preview;
}

export interface TreasuryFormatOptions {
  /** The headers of the file; the assumed layout when none is given. */
  columns?: Partial<TreasuryColumnMap>;
}

/**
 * The pure half of the Treasury statement adapter: it reads the bytes of a CSV or Excel file into rows with the words of the database and judges
 * one row at a time. It knows no database and no clock, so it is tested with a file and an expected list. The layout is PROPOSED: the
 * agency has published none (PAY 7, adapter PROPOSED, API MISSING); the headers are a configuration, and everything else a row must be
 * (a voucher number, a real date, a project code, an office code, a whole positive amount, a booking time) is what any layout needs.
 */
export function createTreasuryStatementFormat(options: TreasuryFormatOptions = {}): FileImportFormat<TreasuryStatementRow> {
  const columns: TreasuryColumnMap = { ...DEFAULT_TREASURY_COLUMNS, ...options.columns };
  return {
    connectorCode: TREASURY_CONNECTOR_CODE,
    formatVersion: TREASURY_FORMAT_VERSION,
    parse(bytes): SourceRow[] {
      let table;
      try {
        table = readTabularFile(bytes);
      } catch (error) {
        // A file that is not a table at all is a file in the wrong layout, whatever the reader calls it.
        if (error instanceof DomainError) throw invalidSchema();
        throw error;
      }
      const indexes = columnIndexes(table.headers, columns);
      return table.rows.map((cells, row) => {
        const values: Record<string, string> = {};
        for (const [field, index] of indexes) values[field] = cells[index] ?? '';
        return { line: table.lines[row] ?? row + 2, values };
      });
    },
    judge(row): RowJudgement<TreasuryStatementRow> {
      const { values } = row;
      const documentNo = keyPart(values.document_no);
      const documentDate = statementDate(values.document_date);
      const projectCode = keyPart(values.project_code);
      const keyed = documentNo !== undefined && documentDate !== undefined && projectCode !== undefined;
      const key = keyed ? treasuryBusinessKey(TREASURY_FILE_PROVIDER, documentNo, documentDate, projectCode) : undefined;
      // A row with no voucher number at all says so (MISSING_DOCUMENT_NO, FR-PAY-13); a number that is there but cannot be part of a key is DOCUMENT_NO_INVALID.
      if (documentNo === undefined) return reject(String(values.document_no ?? '').trim() === '' ? 'MISSING_DOCUMENT_NO' : 'DOCUMENT_NO_INVALID', 'document_no');
      if (documentDate === undefined) return reject('DOCUMENT_DATE_INVALID', 'document_date');
      if (projectCode === undefined) return reject('PROJECT_CODE_INVALID', 'project_code');
      const officeCode = keyPart(values.treasury_office_code);
      if (officeCode === undefined) return reject('OFFICE_CODE_INVALID', 'treasury_office_code', key);
      const amountVnd = wholeVnd(values.amount_vnd);
      if (amountVnd === undefined) return reject('AMOUNT_INVALID', 'amount_vnd', key);
      const confirmedAt = statementInstant(values.confirmed_at);
      if (confirmedAt === undefined) return reject('CONFIRMED_AT_INVALID', 'confirmed_at', key);
      const direction = (values.direction ?? '').trim().toUpperCase();
      // A refund is the other leg of a reversal (PAY 3.4): it names the payment it undoes, which this layout has no column for.
      if (direction === 'REFUND') return reject('REFUND_UNSUPPORTED', 'direction', key);
      if (direction !== '' && direction !== 'PAYMENT') return reject('DIRECTION_INVALID', 'direction', key);
      return accept({
        businessKey: treasuryBusinessKey(TREASURY_FILE_PROVIDER, documentNo, documentDate, projectCode),
        fields: {
          document_no: documentNo,
          document_date: documentDate,
          project_code: projectCode,
          treasury_office_code: officeCode,
          amount_vnd: amountVnd,
          confirmed_at: confirmedAt,
          direction: 'PAYMENT',
        },
        record: { documentNo, documentDate, projectCode, officeCode, amountVnd, confirmedAt, direction: 'PAYMENT' },
        measure: amountVnd,
      });
    },
    mask: maskedValues,
  };
}
