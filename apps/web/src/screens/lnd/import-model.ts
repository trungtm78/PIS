import { ApiError } from '@machvon/api-client';

/** The parcel list file of LND-02: upload, layout check, import (ST-LND-001, LND 3.1 step 1, AC-ST-LND-001-2). The layout is a working assumption. */

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []);

export const IMPORT_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * What the upload answers: the stored file and its hash. A file whose columns are not those of the layout is never stored (see `columnsOfProblem`): the door
 * refuses a column that a parcel must not carry before the file is kept anywhere.
 */
export interface UploadedFile {
  fileObjectId: string;
  fileSha256: string;
  sizeBytes: number;
  format: string;
  columns: string[];
  rowCount: number;
}

export function toUploadedFile(raw: unknown): UploadedFile | undefined {
  const body = asRecord(raw);
  const id = text(body?.file_object_id);
  const sha = text(body?.file_sha256);
  const size = whole(body?.size_bytes);
  const rows = whole(body?.row_count);
  if (body === undefined || id === undefined || sha === undefined || size === undefined || rows === undefined) return undefined;
  return {
    fileObjectId: id,
    fileSha256: sha,
    sizeBytes: size,
    format: text(body.format) ?? '',
    columns: names(body.columns),
    rowCount: rows,
  };
}

/** What a refusal of the upload says about the columns: the ones a parcel must not carry and the ones the layout needs and the file lacks. */
export interface ColumnProblems {
  unknown: string[];
  missing: string[];
}

export function columnsOfProblem(error: unknown): ColumnProblems {
  const extensions = error instanceof ApiError ? error.extensions : {};
  return { unknown: names(extensions.unknown_columns), missing: names(extensions.missing_columns) };
}

export type ImportOutcome = 'APPLIED' | 'PARTIALLY_APPLIED' | 'ALREADY_IMPORTED';

export interface ImportResult {
  outcome: ImportOutcome;
  total: number;
  created: number;
  duplicate: number;
  conflict: number;
  refused: number;
}

/** The answer of the import: what became of the rows. The same file twice answers ALREADY_IMPORTED with the counts of the first time. */
export function toImportResult(raw: unknown): ImportResult | undefined {
  const body = asRecord(raw);
  const outcome = text(body?.result);
  const total = whole(body?.row_total);
  if (body === undefined || (outcome !== 'APPLIED' && outcome !== 'PARTIALLY_APPLIED' && outcome !== 'ALREADY_IMPORTED') || total === undefined) return undefined;
  return { outcome, total, created: whole(body.row_created) ?? 0, duplicate: whole(body.row_duplicate) ?? 0, conflict: whole(body.row_conflict) ?? 0, refused: whole(body.row_refused) ?? 0 };
}

export type ImportProblem = 'hashMismatch' | 'schemaInvalid' | 'empty' | 'fileRefused' | 'notFound' | 'denied' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ImportProblem>> = {
  HASH_MISMATCH: 'hashMismatch',
  IMPORT_SCHEMA_INVALID: 'schemaInvalid',
  IMPORT_EMPTY: 'empty',
  FILE_TYPE_NOT_ALLOWED: 'fileRefused',
  FILE_NOT_CLEAN: 'fileRefused',
  PAYLOAD_TOO_LARGE: 'fileRefused',
  SCAN_PENDING: 'fileRefused',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

export function describeImportProblem(error: unknown): ImportProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
