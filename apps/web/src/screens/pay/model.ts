import { ApiError } from '@machvon/api-client';

/** The permission that starts an import (granted on the whole tenant: a file covers every project) and the one that reads it. */
export const IMPORT_PERMISSION = 'treasury.import';
export const IMPORT_READ_PERMISSION = 'treasury.import.read';

export const SOURCE_KINDS = ['STATEMENT_FILE', 'EXPORT_FILE'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type ImportStatus = 'APPLIED' | 'PARTIALLY_APPLIED';
export type RowOutcome = 'NEW' | 'DUPLICATE' | 'CONFLICT' | 'ERROR';
export type ImportResultKind = ImportStatus | 'ALREADY_IMPORTED';

const IMPORT_STATUSES: readonly string[] = ['APPLIED', 'PARTIALLY_APPLIED'];
const ROW_OUTCOMES: readonly string[] = ['NEW', 'DUPLICATE', 'CONFLICT', 'ERROR'];
const RESULT_KINDS: readonly string[] = ['APPLIED', 'PARTIALLY_APPLIED', 'ALREADY_IMPORTED'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ImportCounts {
  total: number;
  new: number;
  duplicate: number;
  conflict: number;
  error: number;
}

export interface AdapterView {
  connectorCode: string;
  formatVersion: string;
  /** The verdict on the layout: PROPOSED until the agency confirms it. */
  fileStatus: string;
  /** The verdict on a Treasury API: there is none for third parties. */
  apiStatus: string;
  connectorStatus: string;
  lastErrorCode: string | null;
  lastSuccessAt: string | null;
}

export interface RowView {
  rowNo: number;
  businessKey: string;
  outcome: RowOutcome;
  errorCode: string | null;
  treasuryTransactionId: string | null;
  /** The row as it was read, with the account number hidden. */
  masked: Record<string, string>;
}

export interface DifferenceView {
  id: string;
  code: string;
  businessKey: string;
  rowNo: number;
  expected: string | null;
  actual: string | null;
  difference: string | null;
  ownerMembershipId: string;
  ownerName: string | null;
  dueAt: string;
  status: 'OPEN' | 'RESOLVED';
}

export interface ImportView {
  id: string;
  sourceKind: SourceKind;
  fileName: string;
  fileSha256: string;
  statementDate: string | null;
  status: ImportStatus;
  counts: ImportCounts;
  importedBy: string;
  importedByName: string | null;
  importedAt: string;
  adapter: AdapterView;
  certifiedRows: number;
  certifiedAmountVnd: string;
  openDifferences: number;
  rows: RowView[];
  rowsTruncated: boolean;
  differences: DifferenceView[];
}

/** What the import command answered: the kind of result and the figures, or the first import when the file was taken before. */
export interface ImportAnswer {
  importId: string;
  result: ImportResultKind;
  counts: ImportCounts;
  differencesOpened: number;
}

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => text(value) ?? null;
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

function counts(raw: Raw): ImportCounts | undefined {
  const [total, created, duplicate, conflict, error] = [raw.row_total, raw.row_new, raw.row_duplicate, raw.row_conflict, raw.row_error].map(whole);
  return total === undefined || created === undefined || duplicate === undefined || conflict === undefined || error === undefined ? undefined : { total, new: created, duplicate, conflict, error };
}

function toAdapter(value: unknown): AdapterView | undefined {
  const raw = asRecord(value);
  const connectorCode = text(raw?.connector_code);
  const formatVersion = text(raw?.format_version);
  const fileStatus = text(raw?.file_status);
  const apiStatus = text(raw?.api_status);
  const connectorStatus = text(raw?.connector_status);
  if (raw === undefined || connectorCode === undefined || formatVersion === undefined || fileStatus === undefined || apiStatus === undefined || connectorStatus === undefined) return undefined;
  return { connectorCode, formatVersion, fileStatus, apiStatus, connectorStatus, lastErrorCode: nullableText(raw.last_error_code), lastSuccessAt: nullableText(raw.last_success_at) };
}

function toRow(value: unknown): RowView[] {
  const raw = asRecord(value);
  const rowNo = whole(raw?.row_no);
  const businessKey = text(raw?.business_key);
  const outcome = text(raw?.outcome);
  if (raw === undefined || rowNo === undefined || businessKey === undefined || outcome === undefined || !ROW_OUTCOMES.includes(outcome)) return [];
  const masked: Record<string, string> = {};
  for (const [key, shown] of Object.entries(asRecord(raw.raw_masked) ?? {})) if (typeof shown === 'string') masked[key] = shown;
  return [{ rowNo, businessKey, outcome: outcome as RowOutcome, errorCode: nullableText(raw.error_code), treasuryTransactionId: nullableText(raw.treasury_transaction_id), masked }];
}

function toDifference(value: unknown): DifferenceView[] {
  const raw = asRecord(value);
  const id = text(raw?.id);
  const code = text(raw?.code);
  const businessKey = text(raw?.business_key);
  const rowNo = whole(raw?.row_no);
  const owner = text(raw?.owner_membership_id);
  const dueAt = text(raw?.due_at);
  if (raw === undefined || id === undefined || code === undefined || businessKey === undefined || rowNo === undefined || owner === undefined || dueAt === undefined) return [];
  return [
    {
      id,
      code,
      businessKey,
      rowNo,
      expected: nullableText(raw.expected),
      actual: nullableText(raw.actual),
      difference: nullableText(raw.difference),
      ownerMembershipId: owner,
      ownerName: nullableText(raw.owner_name),
      dueAt,
      status: raw.status === 'RESOLVED' ? 'RESOLVED' : 'OPEN',
    },
  ];
}

/** An import as `getTreasuryImport` answers it; undefined for an answer that is not one. */
export function toImportView(value: unknown): ImportView | undefined {
  const raw = asRecord(value);
  const id = text(raw?.id);
  const sourceKind = text(raw?.source_kind);
  const status = text(raw?.status);
  const fileSha256 = text(raw?.file_sha256);
  const importedBy = text(raw?.imported_by);
  const importedAt = text(raw?.imported_at);
  const figures = raw === undefined ? undefined : counts(raw);
  const adapter = toAdapter(raw?.adapter);
  if (raw === undefined || id === undefined || sourceKind === undefined || !(SOURCE_KINDS as readonly string[]).includes(sourceKind)) return undefined;
  if (status === undefined || !IMPORT_STATUSES.includes(status) || fileSha256 === undefined || importedBy === undefined || importedAt === undefined || figures === undefined || adapter === undefined) return undefined;
  const certified = asRecord(raw.certified_total);
  return {
    id,
    sourceKind: sourceKind as SourceKind,
    fileName: text(raw.file_name) ?? '',
    fileSha256,
    statementDate: nullableText(raw.statement_date),
    status: status as ImportStatus,
    counts: figures,
    importedBy,
    importedByName: nullableText(raw.imported_by_name),
    importedAt,
    adapter,
    certifiedRows: whole(certified?.rows) ?? 0,
    certifiedAmountVnd: text(certified?.amount_vnd) ?? '0',
    openDifferences: whole(certified?.open_differences) ?? 0,
    rows: Array.isArray(raw.rows) ? raw.rows.flatMap(toRow) : [],
    rowsTruncated: raw.rows_truncated === true,
    differences: Array.isArray(raw.differences) ? raw.differences.flatMap(toDifference) : [],
  };
}

/** What `importTreasuryStatement` answered; undefined for an answer that is not one. */
export function toImportAnswer(value: unknown): ImportAnswer | undefined {
  const raw = asRecord(value);
  const importId = text(raw?.resource_id);
  const result = text(raw?.result);
  const figures = raw === undefined ? undefined : counts(raw);
  if (raw === undefined || importId === undefined || result === undefined || !RESULT_KINDS.includes(result) || figures === undefined) return undefined;
  return { importId, result: result as ImportResultKind, counts: figures, differencesOpened: whole(raw.differences_opened) ?? 0 };
}

/** The rows that went to the quarantine, in the order of the file. */
export const quarantinedRows = (view: ImportView): RowView[] => view.rows.filter((row) => row.outcome === 'ERROR');

/** The person who owns the work on a quarantined row: the owner of its open item, otherwise the person who imported the file. */
export function ownerOfRow(view: ImportView, row: RowView): { id: string; name: string | null } {
  const item = view.differences.find((candidate) => candidate.businessKey === row.businessKey);
  return item === undefined ? { id: view.importedBy, name: view.importedByName } : { id: item.ownerMembershipId, name: item.ownerName };
}

// ---- the file and the form -----------------------------------------------------------------------------------------------

/** A file the person picked, as the upload read it: where it is stored, its hash, and whether it has the columns of the layout. */
export interface StagedFile {
  fileObjectId: string;
  fileSha256: string;
  fileName: string;
  sizeBytes: number;
  format: 'CSV' | 'XLSX';
  columns: string[];
  rowCount: number;
  /** False when a required column is missing or two columns mean one field: the import would refuse the file. */
  layoutOk: boolean;
  /** The required fields that no column names, in the words of the database (`document_no`...). */
  missingColumns: string[];
}

/** What `uploadTreasuryStatementFile` answered; undefined for an answer that is not one. */
export function toStagedFile(value: unknown): StagedFile | undefined {
  const raw = asRecord(value);
  const fileObjectId = text(raw?.file_object_id);
  const fileSha256 = text(raw?.file_sha256);
  const fileName = text(raw?.file_name);
  const sizeBytes = whole(raw?.size_bytes);
  const rowCount = whole(raw?.row_count);
  const format = text(raw?.format);
  if (raw === undefined || fileObjectId === undefined || fileSha256 === undefined || fileName === undefined || sizeBytes === undefined || rowCount === undefined) return undefined;
  if ((format !== 'CSV' && format !== 'XLSX') || typeof raw.layout_ok !== 'boolean') return undefined;
  const strings = (items: unknown): string[] => (Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : []);
  return { fileObjectId, fileSha256, fileName, sizeBytes, format, columns: strings(raw.columns), rowCount, layoutOk: raw.layout_ok, missingColumns: strings(raw.missing_columns) };
}

export interface ImportForm {
  sourceKind: SourceKind;
  statementDate: string;
}

export type ImportField = 'file' | 'statementDate';
export type FormErrors = Partial<Record<ImportField, 'required' | 'invalid' | 'layout'>>;

export const EMPTY_IMPORT_FORM: ImportForm = { sourceKind: 'STATEMENT_FILE', statementDate: '' };

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** What is wrong before the import is sent: no file, a file without the columns of the layout, a date that is not a day. The server judges the rest. */
export function validateImport(form: ImportForm, file: StagedFile | undefined): FormErrors {
  const errors: FormErrors = {};
  const date = form.statementDate.trim();
  if (file === undefined) errors.file = 'required';
  else if (!file.layoutOk) errors.file = 'layout';
  if (date !== '' && !validDate(date)) errors.statementDate = 'invalid';
  return errors;
}

export interface ImportBody {
  file_object_id: string;
  file_sha256: string;
  source_kind: SourceKind;
  statement_date?: string;
  file_name: string;
}

/** The request as the contract wants it: the file by its stored id and hash (the name only as a label), the date only when one was given. */
export function importBody(form: ImportForm, file: StagedFile): ImportBody {
  const date = form.statementDate.trim();
  return {
    file_object_id: file.fileObjectId.toLowerCase(),
    file_sha256: file.fileSha256.toLowerCase(),
    source_kind: form.sourceKind,
    ...(date === '' ? {} : { statement_date: date }),
    file_name: file.fileName,
  };
}

/** One earlier import in the list: the header of an import without its lines. */
export interface ImportListItem {
  id: string;
  fileName: string;
  fileSha256: string;
  sourceKind: SourceKind;
  statementDate: string | null;
  status: ImportStatus;
  counts: ImportCounts;
  importedBy: string;
  importedByName: string | null;
  importedAt: string;
}

export function toImportListItem(value: unknown): ImportListItem[] {
  const raw = asRecord(value);
  const id = text(raw?.id);
  const sourceKind = text(raw?.source_kind);
  const status = text(raw?.status);
  const fileSha256 = text(raw?.file_sha256);
  const importedBy = text(raw?.imported_by);
  const importedAt = text(raw?.imported_at);
  const figures = raw === undefined ? undefined : counts(raw);
  if (raw === undefined || id === undefined || sourceKind === undefined || !(SOURCE_KINDS as readonly string[]).includes(sourceKind)) return [];
  if (status === undefined || !IMPORT_STATUSES.includes(status) || fileSha256 === undefined || importedBy === undefined || importedAt === undefined || figures === undefined) return [];
  return [
    {
      id,
      fileName: text(raw.file_name) ?? '',
      fileSha256,
      sourceKind: sourceKind as SourceKind,
      statementDate: nullableText(raw.statement_date),
      status: status as ImportStatus,
      counts: figures,
      importedBy,
      importedByName: nullableText(raw.imported_by_name),
      importedAt,
    },
  ];
}

// ---- problems ----------------------------------------------------------------------------------------------------------

export type ProblemReason = 'hashMismatch' | 'schemaInvalid' | 'fileNotClean' | 'scanPending' | 'notFound' | 'denied' | 'connectorStopped' | 'validation' | 'fileType' | 'tooLarge' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  HASH_MISMATCH: 'hashMismatch',
  TREASURY_IMPORT_SCHEMA_INVALID: 'schemaInvalid',
  FILE_NOT_CLEAN: 'fileNotClean',
  SCAN_PENDING: 'scanPending',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  STAGE_TRANSITION_DENIED: 'connectorStopped',
  VALIDATION_FAILED: 'validation',
  FILE_TYPE_NOT_ALLOWED: 'fileType',
  PAYLOAD_TOO_LARGE: 'tooLarge',
};

/** Maps the error of the import command to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

/** The amount of VND from its decimal string, the digits grouped by the language of the screen; a string is never turned into a float. */
export function amountText(amount: string, locale: string): string {
  return /^\d+$/.test(amount) ? new Intl.NumberFormat(locale).format(BigInt(amount)) : amount;
}

/** A signed difference in VND, with its sign shown. */
export function signedAmountText(amount: string, locale: string): string {
  const negative = amount.startsWith('-');
  const digits = negative ? amount.slice(1) : amount;
  const shown = amountText(digits, locale);
  return negative ? `-${shown}` : /^0+$/.test(digits) ? shown : `+${shown}`;
}

/** An instant as a person reads it, in the time zone of the business. */
export function instantText(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(date);
}

/** The import an address names: the id travels in the address (`?import=<id>`), so a link, a reload and the back button all keep it; anything that is not an id names none. */
export const isImportId =(value: string | null): value is string => value !== null && UUID.test(value);
