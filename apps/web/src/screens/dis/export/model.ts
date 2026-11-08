import { ApiError } from '@machvon/api-client';

export const EXPORT_PERMISSION = 'report.export';
/** The snapshots to choose from are read with the permission to read the figures. */
export const READ_PERMISSION = 'disbursement.read';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const FORMATS = ['XLSX', 'CSV', 'PDF', 'DOCX'] as const;
export type Format = (typeof FORMATS)[number];
export const SCALES = ['VND', 'MILLION_VND'] as const;
export type Scale = (typeof SCALES)[number];

/** The columns of the table of an export, in the order of the file; the server writes the columns that are named in this order whatever the order they are sent in. */
export const COLUMN_KEYS = [
  'project_code',
  'project_name',
  'unit_code',
  'unit_name',
  'bucket',
  'budget_level',
  'plan_pm_assigned_vnd',
  'plan_local_added_vnd',
  'plan_total_vnd',
  'disbursed_treasury_vnd',
  'disbursed_reported_vnd',
  'ctmtqg_subset_vnd',
  'rate_pm_pct',
  'rate_total_pct',
  'rate_null_reason',
  'treasury_coverage',
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export interface ExportForm {
  snapshotId: string;
  format: Format;
  scale: Scale;
  columns: readonly ColumnKey[];
}

export const initialForm = (): ExportForm => ({ snapshotId: '', format: 'XLSX', scale: 'VND', columns: COLUMN_KEYS });

export type FormProblem = 'snapshotRequired' | 'columnsRequired';
export function validateForm(form: ExportForm): FormProblem | undefined {
  if (form.snapshotId === '') return 'snapshotRequired';
  return form.columns.length === 0 ? 'columnsRequired' : undefined;
}

/** The request in the words of the contract: the columns are sent only when they are not all of them, and the scale only when it is not whole dong. */
export function exportBody(form: ExportForm): Record<string, unknown> {
  const all = form.columns.length === COLUMN_KEYS.length;
  return {
    snapshot_id: form.snapshotId,
    format: form.format,
    ...(form.scale === 'VND' ? {} : { unit_scale: form.scale }),
    ...(all ? {} : { columns: COLUMN_KEYS.filter((key) => form.columns.includes(key)) }),
  };
}

/** The link the server returned is a path of the API: it is resolved against the base the web app calls the API on (a proxy prefix such as /api, or another host), or it would reach the web server. */
export function linkOf(path: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The id of the export that a command answered with. */
export const exportIdOf = (done: unknown): string | undefined => text(asRecord(done)?.resource_id);

export interface Download {
  exportId: string;
  url: string;
  expiresAt: string;
  format: string;
  rows: number;
  fileSha256: string;
}

export function toDownload(raw: unknown): Download | undefined {
  const row = asRecord(raw);
  const exportId = text(row?.export_id);
  const url = text(row?.url);
  const expiresAt = text(row?.expires_at);
  if (row === undefined || exportId === undefined || url === undefined || expiresAt === undefined) return undefined;
  return { exportId, url, expiresAt, format: text(row.format) ?? '', rows: typeof row.rows === 'number' ? row.rows : 0, fileSha256: text(row.file_sha256) ?? '' };
}

export type ExportProblem = 'notFrozen' | 'rowCap' | 'scopeDenied' | 'validation' | 'notFound' | 'general';
const PROBLEM_BY_CODE: Readonly<Record<string, ExportProblem>> = {
  SNAPSHOT_NOT_FROZEN: 'notFrozen',
  EXPORT_ROW_CAP_EXCEEDED: 'rowCap',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};
export const describeExport = (error: unknown): ExportProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The export is a read of figures that leaves the system: it stays open while the tenant is read-only, and needs the permission. */
export const canExport = (permissions: readonly string[] | undefined): boolean => permissions === undefined || permissions.includes(EXPORT_PERMISSION);
/** A person who may export but not read the figures cannot choose a snapshot: the screen says which permission is missing and asks for nothing. */
export const canChoose = (permissions: readonly string[] | undefined): boolean => permissions === undefined || permissions.includes(READ_PERMISSION);
