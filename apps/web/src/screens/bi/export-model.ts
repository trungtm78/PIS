import { ApiError } from '@machvon/api-client';

export const EXPORTS_PATH = '/bi/bi-16';
export const SCHEDULES_PATH = '/bi/bi-12';
export const EXPORT_PERMISSION = 'bi.export';
export const SCHEDULE_PERMISSION = 'bi.export.schedule';

export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF', 'DOCX'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const SCHEDULE_FORMATS = ['CSV', 'XLSX', 'PDF', 'DOCX', 'LINK_ONLY'] as const;
export type ScheduleFormat = (typeof SCHEDULE_FORMATS)[number];
export const EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'READY', 'DENIED', 'FAILED', 'EXPIRED'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const SCHEDULE_STATUSES = ['ACTIVE', 'PAUSED', 'RETIRED'] as const;
export type ScheduleState = (typeof SCHEDULE_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECIPIENTS = 500;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

/** What an export or a schedule asks, as it was kept: the metric and the dimension (the rest of the spec is the server's). */
export interface Asked {
  metricId: string;
  dimension: string | null;
}

function askedOf(raw: unknown): Asked {
  const spec = isRecord(raw) ? raw : {};
  const dimensions = Array.isArray(spec.dimensions) ? spec.dimensions : [];
  return { metricId: text(spec.metric_version_id), dimension: typeof dimensions[0] === 'string' ? dimensions[0] : null };
}

export interface ExportJob {
  id: string;
  status: ExportStatus;
  format: ExportFormat;
  asOfPeriod: string;
  snapshotId: string;
  scopeDescription: string;
  rowCount: number | null;
  rowCap: number;
  truncated: boolean;
  deniedReason: string | null;
  scheduleId: string | null;
  expiresAt: string | null;
  createdAt: string;
  asked: Asked;
  version: number;
}

/** A job as the list shows it; a row without an id is dropped. */
export function toExportJob(raw: unknown): ExportJob | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    status: oneOf(raw.status, EXPORT_STATUSES, 'QUEUED'),
    format: oneOf(raw.format, EXPORT_FORMATS, 'CSV'),
    asOfPeriod: text(raw.as_of_period),
    snapshotId: text(raw.snapshot_id),
    scopeDescription: text(raw.scope_description),
    rowCount: typeof raw.row_count === 'number' ? raw.row_count : null,
    rowCap: typeof raw.row_cap === 'number' ? raw.row_cap : 0,
    truncated: raw.truncated === true,
    deniedReason: nullableText(raw.denied_reason),
    scheduleId: nullableText(raw.schedule_id),
    expiresAt: nullableText(raw.expires_at),
    createdAt: text(raw.created_at),
    asked: askedOf(raw.query_spec),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

/** The link to the file of a job that is READY and still within the right it was made under. */
export interface Download {
  url: string;
  expiresAt: string;
}

export function toDownload(raw: unknown): Download | undefined {
  const download = isRecord(raw) && isRecord(raw.download) ? raw.download : undefined;
  return download !== undefined && typeof download.url === 'string' ? { url: download.url, expiresAt: text(download.expires_at) } : undefined;
}

export interface ExportSchedule {
  id: string;
  cron: string;
  timezone: string;
  format: ScheduleFormat;
  recipients: string[];
  status: ScheduleState;
  lastRunAt: string | null;
  dashboardId: string | null;
  createdAt: string;
  asked: Asked;
}

export function toSchedule(raw: unknown): ExportSchedule | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    cron: text(raw.cron),
    timezone: text(raw.timezone),
    format: oneOf(raw.format, SCHEDULE_FORMATS, 'CSV'),
    recipients: Array.isArray(raw.recipients) ? raw.recipients.filter((id): id is string => typeof id === 'string') : [],
    status: oneOf(raw.status, SCHEDULE_STATUSES, 'ACTIVE'),
    lastRunAt: nullableText(raw.last_run_at),
    dashboardId: nullableText(raw.dashboard_id),
    createdAt: text(raw.created_at),
    asked: askedOf(raw.query_spec),
  };
}

// ---- the forms ---------------------------------------------------------------------------------------------------------------------------

export interface ExportForm {
  metricId: string;
  period: string;
  /** Empty for a single figure. */
  dimension: string;
  format: ExportFormat;
}

export const EMPTY_EXPORT: ExportForm = { metricId: '', period: '', dimension: '', format: 'CSV' };

export type ExportProblem = 'metricRequired' | 'periodRequired';

export function validateExport(form: ExportForm): { metric?: ExportProblem; period?: ExportProblem } {
  return { metric: form.metricId === '' ? 'metricRequired' : undefined, period: form.period.trim() === '' ? 'periodRequired' : undefined };
}

export const exportBody = (form: ExportForm): { query_spec: { metric_version_id: string; dimensions: string[] }; as_of_period: string; format: ExportFormat } => ({
  query_spec: { metric_version_id: form.metricId, dimensions: form.dimension === '' ? [] : [form.dimension] },
  as_of_period: form.period.trim(),
  format: form.format,
});

export interface ScheduleForm {
  metricId: string;
  dimension: string;
  cron: string;
  format: ScheduleFormat;
  /** The memberships that receive it, one for each line or separated by commas. */
  recipients: string;
}

export const EMPTY_SCHEDULE: ScheduleForm = { metricId: '', dimension: '', cron: '', format: 'CSV', recipients: '' };

export type ScheduleProblem = 'metricRequired' | 'cronRequired' | 'cronFields' | 'recipientsRequired' | 'recipientsInvalid' | 'recipientsMany';

/** The ids written in the box of the recipients: one for each line or separated by commas or spaces, each once. */
export const recipientsOf = (value: string): string[] => [
  ...new Set(
    value
      .split(/[\s,;]+/)
      .filter((id) => id !== '')
      .map((id) => id.toLowerCase()),
  ),
];

export function validateSchedule(form: ScheduleForm): { metric?: ScheduleProblem; cron?: ScheduleProblem; recipients?: ScheduleProblem } {
  const cron = form.cron.trim();
  const recipients = recipientsOf(form.recipients);
  return {
    metric: form.metricId === '' ? 'metricRequired' : undefined,
    // The five fields are the server's to judge; the screen only tells a box that is empty or has the wrong number of them.
    cron: cron === '' ? 'cronRequired' : cron.split(/\s+/).length === 5 ? undefined : 'cronFields',
    recipients: recipients.length === 0 ? 'recipientsRequired' : recipients.length > MAX_RECIPIENTS ? 'recipientsMany' : recipients.some((id) => !UUID.test(id)) ? 'recipientsInvalid' : undefined,
  };
}

export const scheduleBody = (form: ScheduleForm): { query_spec: { metric_version_id: string; dimensions: string[] }; cron: string; format: ScheduleFormat; recipients: string[] } => ({
  query_spec: { metric_version_id: form.metricId, dimensions: form.dimension === '' ? [] : [form.dimension] },
  cron: form.cron.trim(),
  format: form.format,
  recipients: recipientsOf(form.recipients),
});

// ---- what the server refused -------------------------------------------------------------------------------------------------------------

export type ExportReason = 'rowCap' | 'policy' | 'scope' | 'classification' | 'noSnapshot' | 'notCertified' | 'dimension' | 'expired' | 'cron' | 'recipient' | 'invalid' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ExportReason>> = {
  EXPORT_ROW_CAP_EXCEEDED: 'rowCap',
  ACCESS_POLICY_MISSING: 'policy',
  SCOPE_DENIED: 'scope',
  CLASSIFICATION_EXPORT_DENIED: 'classification',
  SNAPSHOT_NOT_FOUND: 'noSnapshot',
  METRIC_NOT_CERTIFIED: 'notCertified',
  DIMENSION_NOT_IN_DATASET: 'dimension',
  EXPORT_EXPIRED: 'expired',
  CRON_INVALID: 'cron',
  RECIPIENT_OUT_OF_TENANT: 'recipient',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
};

export const describeExportProblem = (error: unknown): ExportReason => (error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general');

/** The reason a job was refused, by the code the server kept on it (the same words as the refusal of a request). */
export const reasonOfJob = (deniedReason: string | null): ExportReason | undefined => (deniedReason === null ? undefined : (REASON_BY_CODE[deniedReason] ?? 'general'));
