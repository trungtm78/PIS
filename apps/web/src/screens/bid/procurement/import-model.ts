import { ApiError } from '@machvon/api-client';

/** BID-19, the file of the national bidding system: upload, dry run, row errors, apply (ST-BID-005, BID 3 F8). The layout of the file is a working assumption (docs/bid-procurement-file.md). */

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export type RowStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';
const ROW_STATUSES: readonly string[] = ['VALID', 'ERROR', 'DUPLICATE', 'CONFLICT'];

export interface ImportRow {
  line: number;
  packageCode: string | null;
  milestoneKind: string | null;
  status: RowStatus;
  /** What an apply would do with a valid row: CREATE, FILL, UNCHANGED, MILESTONE_MISMATCH or CODE_MISMATCH. */
  outcome: string | null;
  /** The reason of a refusal and the field it is about. */
  code: string | null;
  field: string | null;
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
  /** An apply: how many milestones the file wrote, and how many differences were opened. */
  written: number;
  differences: number;
}

function toRow(raw: unknown, errorOnly: boolean): ImportRow[] {
  const row = asRecord(raw);
  const line = whole(row?.line);
  const status = errorOnly ? 'ERROR' : text(row?.status);
  if (row === undefined || line === undefined || status === undefined || !ROW_STATUSES.includes(status)) return [];
  const preview = asRecord(row.preview);
  return [
    {
      line,
      packageCode: nullableText(preview?.package_code),
      milestoneKind: nullableText(preview?.milestone_kind),
      status: status as RowStatus,
      outcome: errorOnly ? null : nullableText(row.outcome),
      code: nullableText(row.code),
      field: nullableText(row.field),
    },
  ];
}

/** The answer of the import command, a dry run or an apply, or the extensions of the problem that refused it (counts and errors). */
export function toImportResult(raw: unknown): ImportResult | undefined {
  const body = asRecord(raw);
  const counts = asRecord(body?.counts);
  const total = whole(counts?.total);
  if (body === undefined || counts === undefined || total === undefined) return undefined;
  const dryRun = body.mode === 'DRY_RUN';
  const fromRows = Array.isArray(body.rows);
  const list = fromRows ? (body.rows as unknown[]) : Array.isArray(body.errors) ? (body.errors as unknown[]) : [];
  return {
    dryRun,
    adapterStatus: text(asRecord(body.adapter)?.status) ?? 'PROPOSED',
    alreadyApplied: body.already_applied === true,
    counts: dryRun
      ? { total, valid: whole(counts.valid) ?? 0, duplicate: whole(counts.duplicate) ?? 0, conflict: whole(counts.conflict) ?? 0, errors: whole(counts.errors) ?? 0 }
      : { total, valid: whole(counts.applied) ?? 0, duplicate: whole(counts.duplicate) ?? 0, conflict: whole(counts.conflict) ?? 0, errors: whole(counts.quarantined) ?? 0 },
    rows: list.flatMap((item) => toRow(item, !fromRows)),
    truncated: body.rows_truncated === true || body.errors_truncated === true,
    written: whole(body.milestones_written) ?? 0,
    differences: whole(counts.differencesOpened) ?? 0,
  };
}

/** The result a refused import carries in its problem (IMPORT_HAS_ERRORS answers the counts and the errors). */
export function resultOfProblem(error: unknown): ImportResult | undefined {
  return error instanceof ApiError ? toImportResult({ counts: error.extensions.counts, errors: error.extensions.errors, errors_truncated: error.extensions.errors_truncated }) : undefined;
}

export type ImportProblem = 'alreadyApplied' | 'hasErrors' | 'hashMismatch' | 'schemaInvalid' | 'empty' | 'fileRefused' | 'notFound' | 'denied' | 'general';

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
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

export function describeImportProblem(error: unknown): ImportProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}

export const IMPORT_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
