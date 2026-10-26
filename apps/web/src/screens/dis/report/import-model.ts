import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

/** DIS-10: the bulk import of weekly reports from a workbook (ST-DIS-008, DIS 3 F1). */
export const IMPORT_PATH = '/dis/dis-10';
export const IMPORT_PERMISSION = 'report.import';
/** The only layout that is known until the real workbook is sampled (D04): the synthetic template. */
export const MAPPING_VERSION = 'DIS-WEEKLY-1';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

export const IMPORT_STATUSES = ['DRY_RUN', 'VALIDATED', 'APPLIED', 'FAILED', 'CANCELLED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** A fault of a row: the line of the file, the project it names, the column and a stable code. */
export interface ImportFault {
  line: number;
  projectCode: string | null;
  field: string;
  code: string;
}

export interface ImportBatch {
  id: string;
  periodId: string;
  fileSha256: string;
  mappingVersion: string;
  status: ImportStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  faults: ImportFault[];
  draftsCreated: number;
  draftsUpdated: number;
  version: number;
}

export function toImportBatch(raw: unknown): ImportBatch | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const periodId = text(row?.period_id);
  const sha = text(row?.file_sha256);
  const status = IMPORT_STATUSES.find((candidate) => candidate === row?.status);
  const total = whole(row?.total_rows);
  const valid = whole(row?.valid_rows);
  const errors = whole(row?.error_rows);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || periodId === undefined || sha === undefined || status === undefined || total === undefined || valid === undefined || errors === undefined || version === undefined) return undefined;
  const faults = (Array.isArray(row.errors) ? row.errors : []).flatMap((item): ImportFault[] => {
    const fault = asRecord(item);
    const line = whole(fault?.line);
    const field = text(fault?.field);
    const code = text(fault?.code);
    return fault === undefined || line === undefined || field === undefined || code === undefined ? [] : [{ line, projectCode: text(fault.project_code) ?? null, field, code }];
  });
  return { id, periodId, fileSha256: sha, mappingVersion: text(row.mapping_version) ?? MAPPING_VERSION, status, totalRows: total, validRows: valid, errorRows: errors, faults, draftsCreated: whole(row.drafts_created) ?? 0, draftsUpdated: whole(row.drafts_updated) ?? 0, version };
}

/** A file the upload door took: what the dry run names. */
export interface StoredWorkbook {
  fileObjectKey: string;
  fileSha256: string;
  rowCount: number;
  columns: string[];
  fileName: string;
}

export function toStoredWorkbook(raw: unknown, fileName: string): StoredWorkbook | undefined {
  const row = asRecord(raw);
  const key = text(row?.file_object_key);
  const sha = text(row?.file_sha256);
  const rows = whole(row?.row_count);
  if (row === undefined || key === undefined || sha === undefined || rows === undefined) return undefined;
  return { fileObjectKey: key, fileSha256: sha, rowCount: rows, columns: (Array.isArray(row.columns) ? row.columns : []).filter((column): column is string => typeof column === 'string'), fileName };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const canImport = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(IMPORT_PERMISSION)) && mode !== 'READ_ONLY';

/** The batch can be applied: every row was in order. */
export const canApply = (batch: ImportBatch): boolean => batch.status === 'VALIDATED' && batch.errorRows === 0;

export type ImportRequest = components['schemas']['DisImportRequest'];

export function importRequest(periodId: string, file: StoredWorkbook): ImportRequest {
  return { period_id: periodId, file_object_key: file.fileObjectKey, file_sha256: file.fileSha256, mapping_version: MAPPING_VERSION };
}

/** The faults of a batch that a filter lets through: one code or all, and a text that is part of the project code. */
export function filterFaults(faults: readonly ImportFault[], code: string, project: string): ImportFault[] {
  const wanted = project.trim().toLowerCase();
  return faults.filter((fault) => (code === '' || fault.code === code) && (wanted === '' || (fault.projectCode ?? '').toLowerCase().includes(wanted)));
}

/** The codes the faults of a batch carry, each once, for the filter. */
export const codesOf = (faults: readonly ImportFault[]): string[] => [...new Set(faults.map((fault) => fault.code))].sort();

export type ImportProblem =
  | 'alreadyApplied'
  | 'hasErrors'
  | 'mappingUnknown'
  | 'schemaInvalid'
  | 'periodLocked'
  | 'versionConflict'
  | 'scopeDenied'
  | 'fileInfected'
  | 'fileType'
  | 'fileTooLarge'
  | 'scanPending'
  | 'validation'
  | 'notFound'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ImportProblem>> = {
  IMPORT_FILE_ALREADY_APPLIED: 'alreadyApplied',
  IMPORT_HAS_ERRORS: 'hasErrors',
  MAPPING_VERSION_UNKNOWN: 'mappingUnknown',
  IMPORT_SCHEMA_INVALID: 'schemaInvalid',
  PERIOD_LOCKED: 'periodLocked',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  FILE_NOT_CLEAN: 'fileInfected',
  FILE_TYPE_NOT_ALLOWED: 'fileType',
  PAYLOAD_TOO_LARGE: 'fileTooLarge',
  SCAN_PENDING: 'scanPending',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeImport = (error: unknown): ImportProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The id of the batch a command answered with. */
export function importIdOf(done: unknown): string | undefined {
  const id = asRecord(done)?.resource_id;
  return typeof id === 'string' ? id : undefined;
}
