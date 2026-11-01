import { ApiError } from '@machvon/api-client';

export const MANAGE_PERMISSION = 'adm.migration.manage';
export const APPROVE_PERMISSION = 'adm.migration.approve';
export const READ_PERMISSION = 'adm.migration.read';
/** How often a batch that is being validated or applied is read again. */
export const WORKING_REFRESH_MS = 5000;
/** The mappings the platform knows (the mapping of a real source waits for the decision on the source mapping). */
export const MAPPINGS = ['GENERIC-1', 'GENERIC-CHILD-1'] as const;

export const STATUSES = ['Uploaded', 'Validating', 'Validated', 'DryRunPassed', 'DryRunFailed', 'PendingApproval', 'Applying', 'Applied', 'Failed', 'RolledBack'] as const;
export type BatchStatus = (typeof STATUSES)[number];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export interface Totals {
  rows: number;
  amount: string;
}

export interface ControlTotals {
  expected: Totals | null;
  actual: Totals | null;
  matched: boolean | null;
}

export interface BatchError {
  rowNumber: number;
  lineNumber: number;
  field: string;
  code: string;
  message: string;
}

export interface Batch {
  id: string;
  sourceSystem: string;
  targetEntity: string;
  fileSha256: string;
  mappingVersion: string;
  rowCount: number;
  errorCount: number;
  status: BatchStatus;
  totals: ControlTotals;
  rowsApplied: number;
  failureCode: string | null;
  createdBy: string;
  approvedBy: string | null;
  appliedAt: string | null;
  rolledBackAt: string | null;
  rollbackReason: string | null;
  version: number;
  /** Only the batch that was opened has them. */
  errors: BatchError[];
}

const totalsOf = (value: unknown): Totals | null => (isRecord(value) && typeof value.rows === 'number' && typeof value.amount === 'string' ? { rows: value.rows, amount: value.amount } : null);

function toError(raw: unknown): BatchError[] {
  if (!isRecord(raw) || typeof raw.row_number !== 'number' || typeof raw.field !== 'string' || typeof raw.code !== 'string' || typeof raw.message !== 'string') return [];
  return [{ rowNumber: raw.row_number, lineNumber: count(raw.line_number), field: raw.field, code: raw.code, message: raw.message }];
}

export function toBatch(raw: unknown): Batch | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.source_system !== 'string' ||
    typeof raw.target_entity !== 'string' ||
    typeof raw.file_sha256 !== 'string' ||
    typeof raw.mapping_version !== 'string' ||
    typeof raw.created_by !== 'string' ||
    typeof raw.version !== 'number'
  )
    return undefined;
  const status = STATUSES.find((candidate) => candidate === raw.status);
  if (status === undefined) return undefined;
  const totals = isRecord(raw.control_totals) ? raw.control_totals : {};
  return {
    id: raw.id,
    sourceSystem: raw.source_system,
    targetEntity: raw.target_entity,
    fileSha256: raw.file_sha256,
    mappingVersion: raw.mapping_version,
    rowCount: count(raw.row_count),
    errorCount: count(raw.error_count),
    status,
    totals: { expected: totalsOf(totals.expected), actual: totalsOf(totals.actual), matched: typeof totals.matched === 'boolean' ? totals.matched : null },
    rowsApplied: count(raw.rows_applied),
    failureCode: text(raw.failure_code),
    createdBy: raw.created_by,
    approvedBy: text(raw.approved_by),
    appliedAt: text(raw.applied_at),
    rolledBackAt: text(raw.rolled_back_at),
    rollbackReason: text(raw.rollback_reason),
    version: raw.version,
    errors: Array.isArray(raw.errors) ? raw.errors.flatMap(toError) : [],
  };
}

/** What the upload answers: the id to register the file by, and what the server read of it. */
export interface UploadedFile {
  fileId: string;
  rows: number;
  columns: string[];
}

export function toUploadedFile(raw: unknown): UploadedFile | undefined {
  if (!isRecord(raw) || typeof raw.file_id !== 'string' || typeof raw.row_count !== 'number' || !Array.isArray(raw.columns)) return undefined;
  return { fileId: raw.file_id, rows: raw.row_count, columns: raw.columns.filter((column): column is string => typeof column === 'string') };
}

/** A batch that is being validated or applied is carried out by the job: the screen reads it again until it stops. */
export const isWorking = (status: BatchStatus | undefined): boolean => status === 'Validating' || status === 'Applying';
export const canDryRun = (status: BatchStatus): boolean => status === 'Uploaded' || status === 'DryRunFailed' || status === 'Failed';
export const canApply = (status: BatchStatus): boolean => status === 'DryRunPassed';
export const canRollback = (status: BatchStatus): boolean => status === 'Applied';

// --- the registration --------------------------------------------------------------------------------------------------------------------------

export interface RegisterForm {
  sourceSystem: string;
  targetEntity: string;
  fileId: string;
  mappingVersion: string;
}

export type RegisterField = keyof RegisterForm;
export type FormProblem = 'required' | 'invalid';
export const EMPTY_REGISTER: RegisterForm = { sourceSystem: '', targetEntity: '', fileId: '', mappingVersion: MAPPINGS[0] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRegister(form: RegisterForm): Partial<Record<RegisterField, FormProblem>> {
  const problems: Partial<Record<RegisterField, FormProblem>> = {};
  if (form.sourceSystem.trim() === '') problems.sourceSystem = 'required';
  else if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/.test(form.sourceSystem.trim())) problems.sourceSystem = 'invalid';
  if (form.targetEntity.trim() === '') problems.targetEntity = 'required';
  else if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(form.targetEntity.trim())) problems.targetEntity = 'invalid';
  if (form.fileId.trim() === '') problems.fileId = 'required';
  else if (!UUID.test(form.fileId.trim())) problems.fileId = 'invalid';
  return problems;
}

export function registerBody(form: RegisterForm): Record<string, unknown> {
  return { source_system: form.sourceSystem.trim(), target_entity: form.targetEntity.trim(), file_id: form.fileId.trim().toLowerCase(), mapping_version: form.mappingVersion };
}

/** The reason that goes with a dry run, an apply or a rollback: 10 to 2000 characters. */
export function reasonProblem(reason: string): FormProblem | undefined {
  const trimmed = reason.trim();
  if (trimmed === '') return 'required';
  return trimmed.length < 10 || trimmed.length > 2000 ? 'invalid' : undefined;
}

// --- the error file ----------------------------------------------------------------------------------------------------------------------------

/** A cell of the file: quoted when it holds a comma, a quote or a line, and never read as a formula by a spreadsheet. */
function cell(value: string | number): string {
  const content = String(value);
  const safe = /^[=+\-@\t\r]/.test(content) ? `'${content}` : content;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The errors of a dry run as a CSV the person can mend the file by: the row, the line of the file, the column, the code and what is wrong. */
export function errorsCsv(errors: readonly BatchError[]): string {
  const lines = ['row_number,line_number,field,code,message', ...errors.map((error) => [error.rowNumber, error.lineNumber, error.field, error.code, error.message].map(cell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

// --- refusals ----------------------------------------------------------------------------------------------------------------------------------

export type MigrationReason = 'file' | 'duplicate' | 'state' | 'applied' | 'dependents' | 'self' | 'scope' | 'stale' | 'notFound' | 'validation' | 'general';

const REASON_BY_CODE: Readonly<Record<string, MigrationReason>> = {
  FILE_TYPE_NOT_ALLOWED: 'file',
  FILE_NOT_CLEAN: 'file',
  SCAN_PENDING: 'file',
  PAYLOAD_TOO_LARGE: 'file',
  MIGRATION_FILE_ALREADY_REGISTERED: 'duplicate',
  MIGRATION_STATE_INVALID: 'state',
  MIGRATION_FILE_ALREADY_APPLIED: 'applied',
  MIGRATION_DEPENDENTS_EXIST: 'dependents',
  SELF_APPROVAL_DENIED: 'self',
  SCOPE_DENIED: 'scope',
  VERSION_CONFLICT: 'stale',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
};

export interface MigrationProblem {
  reason: MigrationReason;
  detail: string;
}

export function describeProblem(error: unknown): MigrationProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', detail: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', detail: error.detail ?? '' };
}
