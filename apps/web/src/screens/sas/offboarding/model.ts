import { ApiError } from '@machvon/api-client';

/** The permissions of SAS-17 (x-permission of the operations in openapi.json): the owner exports, the System Admin offboards and archives, the registry readers look. */
export const EXPORT_PERMISSION = 'tenant.export';
export const MANAGE_PERMISSION = 'system.tenant.manage';
export const READ_PERMISSION = 'system.tenant.read';

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const MIN_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 180;
export const DEFAULT_WINDOW_DAYS = 90;
export const MANIFEST_PATH = 'manifest.json';

export type ExportStatus = 'Requested' | 'Running' | 'Ready' | 'Delivered' | 'Failed' | 'Expired';
export type ExportScope = 'FULL' | 'BUSINESS_DATA_ONLY';
export type TenantStatus = 'Requested' | 'Provisioning' | 'Active' | 'Failed' | 'Suspended' | 'Offboarding' | 'Archived';

export interface ExportView {
  id: string;
  status: ExportStatus;
  scope: ExportScope;
  reason: string;
  requestedAt: string;
  readyAt: string | undefined;
  expiresAt: string | undefined;
  deliveredAt: string | undefined;
  fileCount: number | undefined;
  totalBytes: string | undefined;
  manifestSha256: string | undefined;
  filesDownloaded: string[];
  encrypted: boolean;
  errorCode: string | undefined;
  version: number;
}

export interface ExportPage {
  items: ExportView[];
  nextCursor: string | undefined;
  /** How many exports the tenant has asked for: the If-Match of the next request. */
  exportsVersion: number;
}

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  table: string | undefined;
  rows: number | undefined;
  encrypted: boolean;
}

export interface ManifestView {
  jobId: string;
  snapshotAt: string;
  scope: ExportScope;
  files: ManifestFile[];
  rowCounts: Record<string, number>;
  omittedColumns: Record<string, string[]>;
  /** Objects that rows refer to and no store returned. */
  missingFiles: string[];
  /** Objects that rows refer to and the antivirus has not passed. */
  withheldFiles: string[];
  /** Tables of the tenant that the export could not read. */
  unreadableTables: string[];
  keyFingerprint: string | undefined;
}

export interface LinkView {
  exportId: string;
  path: string;
  url: string;
  expiresAt: string;
  bytes: number;
  sha256: string;
}

export interface TenantExitView {
  status: TenantStatus;
  version: number;
  contractEndDate: string | undefined;
  exportWindowDays: number | undefined;
  exportWindowEndsAt: string | undefined;
  offboardingStartedAt: string | undefined;
  archivedAt: string | undefined;
  legalHoldsActive: number;
  exportDelivered: boolean;
  items: ExportView[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const STATUSES: readonly string[] = ['Requested', 'Running', 'Ready', 'Delivered', 'Failed', 'Expired'];
const TENANT_STATUSES: readonly string[] = ['Requested', 'Provisioning', 'Active', 'Failed', 'Suspended', 'Offboarding', 'Archived'];

export function toExport(raw: unknown): ExportView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    status: STATUSES.includes(text(raw.status)) ? (raw.status as ExportStatus) : 'Requested',
    scope: raw.scope === 'BUSINESS_DATA_ONLY' ? 'BUSINESS_DATA_ONLY' : 'FULL',
    reason: text(raw.reason),
    requestedAt: text(raw.requested_at),
    readyAt: optional(raw.ready_at),
    expiresAt: optional(raw.expires_at),
    deliveredAt: optional(raw.delivered_at),
    fileCount: count(raw.file_count),
    totalBytes: optional(raw.total_bytes),
    manifestSha256: optional(raw.manifest_sha256),
    filesDownloaded: Array.isArray(raw.files_downloaded) ? raw.files_downloaded.filter((item): item is string => typeof item === 'string') : [],
    encrypted: raw.encrypted === true,
    errorCode: optional(raw.error_code),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

const exportsOf = (raw: unknown): ExportView[] => (Array.isArray(raw) ? raw.flatMap((item) => toExport(item) ?? []) : []);

export function toExportPage(raw: unknown): ExportPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: exportsOf(view.items), nextCursor: optional(view.next_cursor), exportsVersion: typeof view.exports_version === 'number' ? view.exports_version : 0 };
}

export function toManifest(raw: unknown): ManifestView | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.files)) return undefined;
  const files = raw.files.flatMap((item): ManifestFile[] => {
    if (!isRecord(item) || typeof item.path !== 'string') return [];
    return [{ path: item.path, bytes: typeof item.bytes === 'number' ? item.bytes : 0, sha256: text(item.sha256), table: optional(item.table), rows: count(item.rows), encrypted: isRecord(item.encryption) }];
  });
  const counts: Record<string, number> = {};
  if (isRecord(raw.row_counts)) for (const [table, rows] of Object.entries(raw.row_counts)) if (typeof rows === 'number') counts[table] = rows;
  const omitted: Record<string, string[]> = {};
  if (isRecord(raw.omitted_columns)) for (const [table, columns] of Object.entries(raw.omitted_columns)) if (Array.isArray(columns)) omitted[table] = columns.filter((column): column is string => typeof column === 'string');
  return {
    jobId: text(raw.job_id),
    snapshotAt: text(raw.snapshot_at),
    scope: raw.scope === 'BUSINESS_DATA_ONLY' ? 'BUSINESS_DATA_ONLY' : 'FULL',
    files,
    rowCounts: counts,
    omittedColumns: omitted,
    missingFiles: Array.isArray(raw.missing_files) ? raw.missing_files.filter((item): item is string => typeof item === 'string') : [],
    withheldFiles: Array.isArray(raw.withheld_files) ? raw.withheld_files.filter((item): item is string => typeof item === 'string') : [],
    unreadableTables: Array.isArray(raw.unreadable_tables) ? raw.unreadable_tables.filter((item): item is string => typeof item === 'string') : [],
    keyFingerprint: optional(raw.encryption_key_fingerprint),
  };
}

export function toLink(raw: unknown): LinkView | undefined {
  if (!isRecord(raw) || typeof raw.url !== 'string' || typeof raw.path !== 'string') return undefined;
  return { exportId: text(raw.export_id), path: raw.path, url: raw.url, expiresAt: text(raw.expires_at), bytes: typeof raw.bytes === 'number' ? raw.bytes : 0, sha256: text(raw.sha256) };
}

export function toTenantExit(raw: unknown): TenantExitView | undefined {
  if (!isRecord(raw) || !TENANT_STATUSES.includes(text(raw.tenant_status))) return undefined;
  return {
    status: raw.tenant_status as TenantStatus,
    version: typeof raw.tenant_version === 'number' ? raw.tenant_version : 0,
    contractEndDate: optional(raw.contract_end_date),
    exportWindowDays: count(raw.export_window_days),
    exportWindowEndsAt: optional(raw.export_window_ends_at),
    offboardingStartedAt: optional(raw.offboarding_started_at),
    archivedAt: optional(raw.archived_at),
    legalHoldsActive: typeof raw.legal_holds_active === 'number' ? raw.legal_holds_active : 0,
    exportDelivered: raw.export_delivered === true,
    items: exportsOf(raw.items),
    nextCursor: optional(raw.next_cursor),
  };
}

/** An export that is still being made: the list is read again while one is. */
export const isPending = (view: Pick<ExportView, 'status'>): boolean => view.status === 'Requested' || view.status === 'Running';
/** A file of a Ready or Delivered export can be asked for while its 72 hours last. */
export const isServable = (view: Pick<ExportView, 'status' | 'expiresAt'>, now: Date): boolean => (view.status === 'Ready' || view.status === 'Delivered') && view.expiresAt !== undefined && new Date(view.expiresAt).getTime() > now.getTime();
/** The share of the files of the export that were downloaded, for the progress shown (the manifest counts as a file). */
export const downloadedOf = (view: Pick<ExportView, 'filesDownloaded' | 'fileCount'>): string => `${view.filesDownloaded.length}/${view.fileCount ?? 0}`;

/** Offboarding can start from these states; archiving and renewing only from Offboarding. */
export const canOffboard = (status: TenantStatus): boolean => status === 'Active' || status === 'Suspended';
export const canArchive = (status: TenantStatus): boolean => status === 'Offboarding';

export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;
export const isWindowValid = (days: number): boolean => Number.isInteger(days) && days >= MIN_WINDOW_DAYS && days <= MAX_WINDOW_DAYS;
export const isDateValid = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const looksLikePublicKey = (pem: string): boolean => /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem.trim());

export type ProblemReason = 'running' | 'conflict' | 'notConfirmed' | 'state' | 'expired' | 'key' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  EXPORT_ALREADY_RUNNING: 'running',
  VERSION_CONFLICT: 'conflict',
  EXPORT_NOT_CONFIRMED: 'notConfirmed',
  TENANT_STATE_INVALID: 'state',
  EXPORT_STATE_INVALID: 'state',
  EXPORT_EXPIRED: 'expired',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  const reason = error.code === 'VALIDATION_FAILED' && error.detail === 'encryption_public_key_pem' ? 'key' : (REASON_BY_CODE[error.code] ?? 'general');
  return { reason, field: error.detail };
}
