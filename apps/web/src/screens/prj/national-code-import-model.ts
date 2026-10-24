import { ApiError } from '@machvon/api-client';

/** PRJ-21, the reconciliation file: upload, dry run, row errors, apply (ST-PRJ-004, PRJ 3.1 F7). The layout of the file is a working assumption (docs/prj-national-code-file.md). */

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

/** What the upload answers: the stored file, its hash and what it holds. */
export interface UploadedFile {
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  format: string;
  columns: string[];
  rowCount: number;
}

export function toUploadedFile(raw: unknown): UploadedFile | undefined {
  const body = asRecord(raw);
  const key = text(body?.file_object_key);
  const sha = text(body?.file_sha256);
  const size = whole(body?.size_bytes);
  const rows = whole(body?.row_count);
  if (body === undefined || key === undefined || sha === undefined || size === undefined || rows === undefined) return undefined;
  return { fileObjectKey: key, fileSha256: sha, sizeBytes: size, format: text(body.format) ?? '', columns: (Array.isArray(body.columns) ? body.columns : []).filter((name): name is string => typeof name === 'string'), rowCount: rows };
}

export type RowStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';
const ROW_STATUSES: readonly string[] = ['VALID', 'ERROR', 'DUPLICATE', 'CONFLICT'];

export interface ImportRow {
  line: number;
  internalCode: string | null;
  status: RowStatus;
  /** What an apply would do with a valid row: ASSIGN, UNCHANGED or MISMATCH. */
  outcome: string | null;
  /** The reason of a refusal and the field it is about. */
  code: string | null;
  field: string | null;
  nationalCode: string | null;
}

export interface ImportCounts {
  total: number;
  valid: number;
  duplicate: number;
  conflict: number;
  errors: number;
}

export interface ImportResult {
  dryRun: boolean;
  adapterStatus: string;
  alreadyApplied: boolean;
  counts: ImportCounts;
  rows: ImportRow[];
  truncated: boolean;
  /** An apply: how many projects got a code, and how many differences were opened. */
  assigned: number;
  differences: number;
}

function toRow(raw: unknown): ImportRow[] {
  const row = asRecord(raw);
  const line = whole(row?.line);
  const status = text(row?.status);
  if (row === undefined || line === undefined || status === undefined || !ROW_STATUSES.includes(status)) return [];
  const preview = asRecord(row.preview);
  return [{ line, internalCode: nullableText(row.internal_code), status: status as RowStatus, outcome: nullableText(row.outcome), code: nullableText(row.code), field: nullableText(row.field), nationalCode: nullableText(preview?.national_project_code) }];
}

/** The rows of an apply that were refused (the answer lists only those), read as error rows. */
function toErrorRow(raw: unknown): ImportRow[] {
  const row = asRecord(raw);
  const line = whole(row?.line);
  if (row === undefined || line === undefined) return [];
  const preview = asRecord(row.preview);
  return [{ line, internalCode: nullableText(row.internal_code), status: 'ERROR', outcome: null, code: nullableText(row.code), field: nullableText(row.field), nationalCode: nullableText(preview?.national_project_code) }];
}

/** The answer of the import command, a dry run or an apply, or the extensions of the problem that refused it (counts and errors). */
export function toImportResult(raw: unknown): ImportResult | undefined {
  const body = asRecord(raw);
  const counts = asRecord(body?.counts);
  const total = whole(counts?.total);
  if (body === undefined || counts === undefined || total === undefined) return undefined;
  const dryRun = body.dry_run === true;
  const rows = (Array.isArray(body.rows) ? body.rows : Array.isArray(body.errors) ? body.errors : []).flatMap(Array.isArray(body.rows) ? toRow : toErrorRow);
  return {
    dryRun,
    adapterStatus: text(asRecord(body.adapter)?.status) ?? 'PROPOSED',
    alreadyApplied: body.already_applied === true,
    counts: dryRun
      ? { total, valid: whole(counts.valid) ?? 0, duplicate: whole(counts.duplicate) ?? 0, conflict: whole(counts.conflict) ?? 0, errors: whole(counts.errors) ?? 0 }
      : { total, valid: whole(counts.applied) ?? 0, duplicate: whole(counts.duplicate) ?? 0, conflict: whole(counts.conflict) ?? 0, errors: whole(counts.quarantined) ?? 0 },
    rows,
    truncated: body.rows_truncated === true || body.errors_truncated === true,
    assigned: whole(body.assigned) ?? 0,
    differences: whole(counts.differencesOpened) ?? 0,
  };
}

/** The result a refused import carries in its problem (IMPORT_HAS_ERRORS answers the counts and the errors). */
export function resultOfProblem(error: unknown): ImportResult | undefined {
  return error instanceof ApiError ? toImportResult({ counts: error.extensions.counts, errors: error.extensions.errors, errors_truncated: error.extensions.errors_truncated }) : undefined;
}

export type ImportProblem = 'alreadyApplied' | 'hasErrors' | 'hashMismatch' | 'schemaInvalid' | 'empty' | 'fileRefused' | 'versionConflict' | 'notFound' | 'denied' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ImportProblem>> = {
  IMPORT_FILE_ALREADY_APPLIED: 'alreadyApplied',
  IMPORT_HAS_ERRORS: 'hasErrors',
  HASH_MISMATCH: 'hashMismatch',
  IMPORT_SCHEMA_INVALID: 'schemaInvalid',
  IMPORT_EMPTY: 'empty',
  FILE_TYPE_NOT_ALLOWED: 'fileRefused',
  FILE_NOT_CLEAN: 'fileRefused',
  PAYLOAD_TOO_LARGE: 'fileRefused',
  SCAN_PENDING: 'fileRefused',
  VERSION_CONFLICT: 'versionConflict',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

export function describeImportProblem(error: unknown): ImportProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}

export const IMPORT_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
