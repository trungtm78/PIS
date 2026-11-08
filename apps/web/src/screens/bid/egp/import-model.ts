import { ApiError } from '@machvon/api-client';

/**
 * BID-24, the import runs of the files of the national e-procurement network (docs/egp-connector.md, sections 4, 8 and 9): upload, dry run with the verdict of every row, apply, history.
 * The layouts of the files are a working assumption (PENDING-EXTERNAL): the screen says so wherever the acceptance word is PENDING_EXTERNAL.
 */

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const count = (value: unknown): number => whole(value) ?? 0;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');

export const KINDS = ['KHLCNT', 'TBMT', 'RESULT', 'CONTRACTOR', 'RESTRICTION'] as const;
export type Kind = (typeof KINDS)[number];
export const kindOf = (value: unknown): Kind | undefined => KINDS.find((kind) => kind === value);

export type Acceptance = 'PENDING_EXTERNAL' | 'ACCEPTABLE';
const acceptanceOf = (value: unknown): Acceptance => (value === 'ACCEPTABLE' ? 'ACCEPTABLE' : 'PENDING_EXTERNAL');

/** The most a file may weigh (the upload limit of the shared pipeline), and what the file chooser offers. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The rows a dry run answers at most (the rest is counted, not listed). */
export const PREVIEW_ROW_LIMIT = 500;
export const HISTORY_PAGE_SIZE = 20;
export const PATH_CONNECTION = '/bid/bid-22';
export const PATH_MAPPING = '/bid/bid-23';

// ---------------------------------------------------------------------------------------------------------------------------------------- the connection

export interface LayoutColumn {
  name: string;
  kind: string;
  required: boolean;
  headerRequired: boolean;
  values: string[];
}
export interface Layout {
  kind: Kind;
  columns: LayoutColumn[];
}
export interface Connection {
  enabled: boolean;
  applyBlocked: boolean;
  layoutVersion: string;
  acceptance: Acceptance;
  layouts: Layout[];
  canPreview: boolean;
  canApply: boolean;
  asOf: string | null;
}

function toLayout(raw: unknown): Layout[] {
  const layout = asRecord(raw);
  const kind = kindOf(layout?.kind);
  if (layout === undefined || kind === undefined) return [];
  const columns = list(layout.columns).flatMap((item): LayoutColumn[] => {
    const column = asRecord(item);
    const name = text(column?.name);
    if (column === undefined || name === undefined) return [];
    return [{ name, kind: text(column.kind) ?? '', required: column.required === true, headerRequired: column.header_required === true, values: strings(column.values) }];
  });
  return [{ kind, columns }];
}

export function toConnection(raw: unknown): Connection | undefined {
  const body = asRecord(raw);
  if (body === undefined) return undefined;
  const actions = asRecord(body.actions);
  const health = asRecord(body.health);
  return {
    enabled: body.enabled === true,
    applyBlocked: health?.apply_blocked === true,
    layoutVersion: text(body.layout_version) ?? '',
    acceptance: acceptanceOf(body.acceptance),
    layouts: list(body.layouts).flatMap(toLayout),
    canPreview: actions?.preview === true,
    canApply: actions?.apply === true,
    asOf: nullableText(body.as_of),
  };
}

export type ColumnNeed = 'required' | 'header' | 'optional';
export const columnNeed = (column: LayoutColumn): ColumnNeed => (column.required ? 'required' : column.headerRequired ? 'header' : 'optional');

// ---------------------------------------------------------------------------------------------------------------------------------------- the upload

export interface UploadedFile {
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  format: string;
  columns: string[];
  rowCount: number;
  matchingKinds: Kind[];
}

export function toUploadedFile(raw: unknown): UploadedFile | undefined {
  const body = asRecord(raw);
  const key = text(body?.file_object_key);
  const sha = text(body?.file_sha256);
  const rows = whole(body?.row_count);
  if (body === undefined || key === undefined || sha === undefined || rows === undefined) return undefined;
  return {
    fileObjectKey: key,
    fileSha256: sha,
    sizeBytes: count(body.size_bytes),
    format: (text(body.format) ?? '').toUpperCase(),
    columns: strings(body.columns),
    rowCount: rows,
    matchingKinds: list(body.matching_kinds).flatMap((item) => kindOf(item) ?? []),
  };
}

export type KindFit = 'fits' | 'other' | 'none';
/** Whether the file has the required columns of the chosen kind; the kinds it does fit are told, the choice is never changed for the person. */
export const kindFit = (uploaded: UploadedFile, kind: Kind): KindFit => (uploaded.matchingKinds.includes(kind) ? 'fits' : uploaded.matchingKinds.length === 0 ? 'none' : 'other');

export const tooLarge = (file: { size: number }): boolean => file.size > MAX_FILE_BYTES;

// ---------------------------------------------------------------------------------------------------------------------------------------- the rows

export type RowStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';
export const ROW_STATUSES: readonly RowStatus[] = ['VALID', 'ERROR', 'DUPLICATE', 'CONFLICT'];
export type Outcome = 'RECORD' | 'RECORD_AND_PROPOSE' | 'RECORD_AND_DIFFERENCE';
const OUTCOMES: readonly string[] = ['RECORD', 'RECORD_AND_PROPOSE', 'RECORD_AND_DIFFERENCE'];

/** The reasons a row of a file can be refused or ignored (docs/egp-connector.md, section 4.6), as the server writes them. */
export const ROW_CODES = [
  'FIELD_REQUIRED',
  'FIELD_TOO_LONG',
  'CHARACTER_INVALID',
  'ENUM_INVALID',
  'DAY_INVALID',
  'MOMENT_INVALID',
  'MONEY_INVALID',
  'INTEGER_INVALID',
  'TAX_CODE_INVALID',
  'BID_DATES_ORDER_INVALID',
  'AWARD_FIELDS_REQUIRED',
  'AWARD_FIELDS_NOT_ALLOWED',
  'RESULT_DATES_ORDER_INVALID',
  'VALID_RANGE_INVALID',
  'SCOPE_REQUIRED',
  'ROW_DUPLICATE',
  'ROW_CONFLICT',
] as const;

/** `FIELD_TOO_LONG` is `fieldTooLong`: the segment of the translation key. */
export const camelOf = (code: string): string => code.toLowerCase().replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

const ROW_CODE_KEYS: ReadonlySet<string> = new Set(ROW_CODES.map(camelOf));

/** The last segment of the translation key of a row code: the camel form of a known code, `other` for any other. */
export const rowCodeKey = (code: string | null): string => {
  if (code === null) return 'other';
  const key = camelOf(code);
  return ROW_CODE_KEYS.has(key) ? key : 'other';
};

export interface PreviewRow {
  line: number;
  businessKey: string | null;
  status: RowStatus;
  code: string | null;
  field: string | null;
  outcome: Outcome | null;
  preview: Record<string, string> | null;
}

const previewCells = (value: unknown): Record<string, string> | null => {
  const cells = asRecord(value);
  if (cells === undefined) return null;
  const entries = Object.entries(cells).flatMap(([key, cell]): Array<[string, string]> => (typeof cell === 'string' ? [[key, cell]] : typeof cell === 'number' ? [[key, String(cell)]] : []));
  return Object.fromEntries(entries);
};

function toRow(raw: unknown): PreviewRow[] {
  const row = asRecord(raw);
  const line = whole(row?.line);
  const status = ROW_STATUSES.find((value) => value === row?.status);
  if (row === undefined || line === undefined || status === undefined) return [];
  const outcome = OUTCOMES.includes(row.outcome as string) ? (row.outcome as Outcome) : null;
  return [{ line, businessKey: nullableText(row.business_key), status, code: nullableText(row.code), field: nullableText(row.field), outcome, preview: previewCells(row.preview) }];
}

/** The code a row stands under: what the server said, or the word of the verdict for a repeat or a clash. */
export const effectiveCode = (row: PreviewRow): string | null => row.code ?? (row.status === 'DUPLICATE' ? 'ROW_DUPLICATE' : row.status === 'CONFLICT' ? 'ROW_CONFLICT' : null);

export type StatusFilter = '' | RowStatus;
export const filterRows = (rows: readonly PreviewRow[], status: StatusFilter): PreviewRow[] => (status === '' ? [...rows] : rows.filter((row) => row.status === status));

export interface RowError {
  line: number;
  businessKey: string | null;
  code: string;
  field: string | null;
  preview: Record<string, string> | null;
}

function toRowError(raw: unknown): RowError[] {
  const row = asRecord(raw);
  const line = whole(row?.line);
  if (row === undefined || line === undefined) return [];
  return [{ line, businessKey: nullableText(row.business_key), code: text(row.code) ?? '', field: nullableText(row.field), preview: previewCells(row.preview) }];
}

/** A masked preview as "column: value" pieces for a cell; the server already left out names and addresses. */
export const previewPairs = (preview: Record<string, string> | null): Array<{ key: string; value: string }> => Object.entries(preview ?? {}).map(([key, value]) => ({ key, value }));

// ---------------------------------------------------------------------------------------------------------------------------------------- the dry run and the apply

export interface PreviewCounts {
  total: number;
  valid: number;
  errors: number;
  duplicate: number;
  conflict: number;
}

export interface Preview {
  kind: Kind;
  layoutVersion: string;
  acceptance: Acceptance;
  fileSha256: string;
  alreadyApplied: boolean;
  connectionEnabled: boolean;
  counts: PreviewCounts;
  rows: PreviewRow[];
  rowsTruncated: boolean;
  /** When the answer came: the "as of" of the figures of the dry run. */
  ranAt: string;
}

export function toPreview(raw: unknown, ranAt: string): Preview | undefined {
  const body = asRecord(raw);
  const counts = asRecord(body?.counts);
  const kind = kindOf(body?.kind);
  const total = whole(counts?.total);
  if (body === undefined || counts === undefined || kind === undefined || total === undefined) return undefined;
  return {
    kind,
    layoutVersion: text(body.layout_version) ?? '',
    acceptance: acceptanceOf(body.acceptance),
    fileSha256: text(body.file_sha256) ?? '',
    alreadyApplied: body.already_applied === true,
    connectionEnabled: body.connection_enabled !== false,
    counts: { total, valid: count(counts.valid), errors: count(counts.errors), duplicate: count(counts.duplicate), conflict: count(counts.conflict) },
    rows: list(body.rows).flatMap(toRow),
    rowsTruncated: body.rows_truncated === true,
    ranAt,
  };
}

export interface ApplyCounts {
  total: number;
  applied: number;
  duplicate: number;
  conflict: number;
  quarantined: number;
  differencesOpened: number;
}

const toApplyCounts = (value: unknown): ApplyCounts | undefined => {
  const counts = asRecord(value);
  const total = whole(counts?.total);
  if (counts === undefined || total === undefined) return undefined;
  return {
    total,
    applied: count(counts.applied),
    duplicate: count(counts.duplicate),
    conflict: count(counts.conflict),
    quarantined: count(counts.quarantined),
    differencesOpened: count(counts.differences_opened ?? counts.differencesOpened),
  };
};

export interface Applied {
  runId: string | null;
  kind: Kind | null;
  layoutVersion: string;
  acceptance: Acceptance;
  fileSha256: string;
  counts: ApplyCounts;
  mappingsProposed: number;
  restrictionsWritten: number;
  errors: RowError[];
  errorsTruncated: boolean;
  /** The apply was refused with IMPORT_HAS_ERRORS: nothing was taken, the errors say why. */
  refused: boolean;
}

export function toApplied(raw: unknown): Applied | undefined {
  const body = asRecord(raw);
  const counts = toApplyCounts(body?.counts);
  if (body === undefined || counts === undefined) return undefined;
  return {
    runId: nullableText(body.resource_id),
    kind: kindOf(body.kind) ?? null,
    layoutVersion: text(body.layout_version) ?? '',
    acceptance: acceptanceOf(body.acceptance),
    fileSha256: text(body.file_sha256) ?? '',
    counts,
    mappingsProposed: count(body.mappings_proposed),
    restrictionsWritten: count(body.restrictions_written),
    errors: list(body.errors).flatMap(toRowError),
    errorsTruncated: body.errors_truncated === true,
    refused: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------- the problems

export type ProblemKind =
  | 'alreadyApplied'
  | 'connectionDisabled'
  | 'hasErrors'
  | 'hashMismatch'
  | 'schemaInvalid'
  | 'empty'
  | 'layoutUnknown'
  | 'fileRefused'
  | 'tooLarge'
  | 'scanPending'
  | 'validation'
  | 'notFound'
  | 'scopeDenied'
  | 'denied'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ProblemKind>> = {
  IMPORT_FILE_ALREADY_APPLIED: 'alreadyApplied',
  EGP_CONNECTION_DISABLED: 'connectionDisabled',
  IMPORT_HAS_ERRORS: 'hasErrors',
  HASH_MISMATCH: 'hashMismatch',
  IMPORT_SCHEMA_INVALID: 'schemaInvalid',
  IMPORT_EMPTY: 'empty',
  EGP_LAYOUT_VERSION_UNKNOWN: 'layoutUnknown',
  FILE_TYPE_NOT_ALLOWED: 'fileRefused',
  FILE_NOT_CLEAN: 'fileRefused',
  PAYLOAD_TOO_LARGE: 'tooLarge',
  SCAN_PENDING: 'scanPending',
  VALIDATION_FAILED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'scopeDenied',
};

export interface Problem {
  kind: ProblemKind;
  /** IMPORT_SCHEMA_INVALID: the required columns the file does not have. */
  missingColumns: string[];
  /** EGP_LAYOUT_VERSION_UNKNOWN: the version asked for and the ones the module reads. */
  layoutVersion: string;
  supported: string[];
  /** The machine code of the answer, for a word the screen has no sentence for. */
  code: string;
}

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', missingColumns: [], layoutVersion: '', supported: [], code: '' };
  const known = PROBLEM_BY_CODE[error.code];
  const kind: ProblemKind = known ?? (error.status === 403 ? 'denied' : 'general');
  return {
    kind,
    missingColumns: strings(error.extensions.missing_columns),
    layoutVersion: text(error.extensions.layout_version) ?? '',
    supported: strings(error.extensions.supported),
    code: error.code,
  };
}

/** Whether the answer is information the person can act on (the file was loaded before), not a failure of the system. */
export const isInformation = (problem: Problem): boolean => problem.kind === 'alreadyApplied';

/** The refusal IMPORT_HAS_ERRORS: nothing could be taken; the answer carries the counts and the errors of the rows. */
export function refusedApply(error: unknown): Applied | undefined {
  if (!(error instanceof ApiError) || error.code !== 'IMPORT_HAS_ERRORS') return undefined;
  const applied = toApplied({ counts: error.extensions.counts, errors: error.extensions.errors, errors_truncated: error.extensions.errors_truncated });
  return applied === undefined ? undefined : { ...applied, refused: true };
}

/** Whether a failure is the refusal of the scope or the permission (a 403): the lists and the apply say "forbidden" instead of "error". */
export const isForbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403;

// ---------------------------------------------------------------------------------------------------------------------------------------- the gates

export type ApplyBlock = 'noPreview' | 'noValid' | 'alreadyApplied' | 'connectionDisabled' | 'noAuthority' | 'done' | 'working';

export interface ApplyGateInput {
  preview: Preview | undefined;
  /** The dry run was made on the file that is now stored (the person did not change file or kind since). */
  previewIsCurrent: boolean;
  canApply: boolean;
  /** The connection is switched off, or the health of the connector blocks the apply. */
  connectionBlocked: boolean;
  applied: boolean;
  working: boolean;
}

/** "Apply" is open only after a dry run of that same file with a valid row, a file not loaded before, an enabled connection and the right to apply; otherwise the reason. */
export function applyGate(input: ApplyGateInput): ApplyBlock | null {
  if (input.applied) return 'done';
  if (input.working) return 'working';
  if (input.preview === undefined || !input.previewIsCurrent) return 'noPreview';
  if (input.preview.alreadyApplied) return 'alreadyApplied';
  if (input.connectionBlocked || !input.preview.connectionEnabled) return 'connectionDisabled';
  if (!input.canApply) return 'noAuthority';
  if (input.preview.counts.valid < 1) return 'noValid';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------- the history

export type RunStatus = 'IMPORTING' | 'APPLIED' | 'FAILED';
const RUN_STATUSES: readonly string[] = ['IMPORTING', 'APPLIED', 'FAILED'];

export interface Run {
  id: string;
  kind: Kind;
  layoutVersion: string;
  acceptance: Acceptance;
  fileSha256: string;
  status: RunStatus;
  errorCode: string | null;
  counts: ApplyCounts;
  openDifferences: number;
  importedBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function toRun(raw: unknown): Run | undefined {
  const run = asRecord(raw);
  const id = text(run?.id);
  const kind = kindOf(run?.kind);
  const counts = toApplyCounts(run?.counts);
  const status = RUN_STATUSES.find((value) => value === run?.status);
  if (run === undefined || id === undefined || kind === undefined || counts === undefined || status === undefined) return undefined;
  return {
    id,
    kind,
    layoutVersion: text(run.layout_version) ?? '',
    acceptance: acceptanceOf(run.acceptance),
    fileSha256: text(run.file_sha256) ?? '',
    status: status as RunStatus,
    errorCode: nullableText(run.error_code),
    counts,
    openDifferences: count(run.open_differences),
    importedBy: nullableText(run.imported_by_name),
    createdAt: text(run.created_at) ?? '',
    completedAt: nullableText(run.completed_at),
  };
}

export interface RunPage {
  items: Run[];
  nextCursor: string | null;
  asOf: string | null;
}

export function toRunPage(raw: unknown): RunPage {
  const body = asRecord(raw);
  return { items: list(body?.items).flatMap((item) => toRun(item) ?? []), nextCursor: nullableText(body?.next_cursor), asOf: nullableText(body?.as_of) };
}

export interface RunDetail {
  run: Run;
  errors: RowError[];
  errorsTruncated: boolean;
  asOf: string | null;
}

export function toRunDetail(raw: unknown): RunDetail | undefined {
  const body = asRecord(raw);
  const run = toRun(body?.run);
  if (body === undefined || run === undefined) return undefined;
  return { run, errors: list(body.errors).flatMap(toRowError), errorsTruncated: body.errors_truncated === true, asOf: nullableText(body.as_of) };
}

/** The error code of a failed run as a problem kind, so that the words of the screen say why; `general` when the code is not one the screen knows. */
export const failureKind = (code: string | null): ProblemKind | null => (code === null ? null : (PROBLEM_BY_CODE[code] ?? null));

// ---------------------------------------------------------------------------------------------------------------------------------------- words and figures

/** The first twelve characters of a file hash: enough to tell two files apart on a list. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

const pad = (value: number): string => String(value).padStart(2, '0');

/** A moment as a Vietnam wall-clock `YYYY-MM-DD HH:mm` (UTC+7); empty for none or for a text that is not a moment. */
export function vietnamDateTime(moment: string | null | undefined): string {
  if (moment === null || moment === undefined) return '';
  const at = Date.parse(moment);
  if (Number.isNaN(at)) return '';
  const local = new Date(at + 7 * 3_600_000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** A size in the unit a person reads: kilobytes below a megabyte, else megabytes with one decimal. */
export function sizeText(bytes: number, locale: string): { value: string; unit: 'KB' | 'MB' } {
  if (bytes < 1024 * 1024) return { value: Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale), unit: 'KB' };
  return { value: (Math.round((bytes / (1024 * 1024)) * 10) / 10).toLocaleString(locale, { maximumFractionDigits: 1 }), unit: 'MB' };
}
