import { ApiError } from '@machvon/api-client';
import { CAPACITY_CLASSES, DEFAULT_WARN_PCT, capacityKindOf, evaluateCapacity } from '@machvon/kernel/src/log-capacity.ts';
import type { CapacityKind, CapacityState } from '@machvon/kernel/src/log-capacity.ts';

/** Permissions of ADM-30 (x-permission in openapi.json): the caps need a grant over the whole tenant. */
export const READ_CAPACITY_PERMISSION = 'adm.log_capacity.read';
export const MANAGE_CAPACITY_PERMISSION = 'adm.log_capacity.manage';

export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 2000;
export const MIN_BYTES = 1_048_576;
const MAX_ROWS = 1_000_000_000;
const MAX_BYTES = 1_000_000_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export interface CapPolicyView {
  id: string;
  recordClass: string;
  maxRows: number | null;
  maxBytes: number | null;
  warnPct: number;
  active: boolean;
  reason: string;
  version: number;
}

export interface ReadingView {
  recordClass: string;
  kind: CapacityKind;
  rows: number;
  bytes: number;
  bytesEstimated: boolean;
  eligibleRows: number;
  protectedRows: number;
  state: CapacityState;
  measuredAt: string;
}

export interface BatchView {
  id: string;
  recordClass: string;
  status: 'ARCHIVED' | 'PURGED';
  rows: number;
  bytes: number;
  fileSha256: string;
  createdAt: string;
}

export interface Overview {
  policies: CapPolicyView[];
  readings: ReadingView[];
  batches: BatchView[];
}

function toPolicy(raw: unknown): CapPolicyView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const recordClass = text(raw.record_class);
  const warnPct = count(raw.warn_pct);
  const version = count(raw.version);
  if (id === undefined || recordClass === undefined || warnPct === null || version === null || typeof raw.active !== 'boolean') return undefined;
  return { id, recordClass, maxRows: count(raw.max_rows), maxBytes: count(raw.max_bytes), warnPct, active: raw.active, reason: text(raw.reason) ?? '', version };
}

function toReading(raw: unknown): ReadingView | undefined {
  if (!isRecord(raw)) return undefined;
  const recordClass = text(raw.record_class);
  const rows = count(raw.rows);
  const bytes = count(raw.bytes);
  const state = raw.state;
  if (recordClass === undefined || rows === null || bytes === null || (state !== 'UNCAPPED' && state !== 'OK' && state !== 'NEAR' && state !== 'OVER')) return undefined;
  return {
    recordClass,
    kind: capacityKindOf(recordClass) ?? 'MONITOR_ONLY',
    rows,
    bytes,
    bytesEstimated: raw.bytes_estimated === true,
    eligibleRows: count(raw.eligible_rows) ?? 0,
    protectedRows: count(raw.protected_rows) ?? 0,
    state,
    measuredAt: text(raw.measured_at) ?? '',
  };
}

function toBatch(raw: unknown): BatchView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const recordClass = text(raw.record_class);
  const rows = count(raw.rows);
  if (id === undefined || recordClass === undefined || rows === null || (raw.status !== 'ARCHIVED' && raw.status !== 'PURGED')) return undefined;
  return { id, recordClass, status: raw.status, rows, bytes: count(raw.bytes) ?? 0, fileSha256: text(raw.file_sha256) ?? '', createdAt: text(raw.created_at) ?? '' };
}

export function toOverview(raw: unknown): Overview {
  const list = (name: string): unknown[] => (isRecord(raw) && Array.isArray(raw[name]) ? (raw[name] as unknown[]) : []);
  return {
    policies: list('policies').flatMap((item) => toPolicy(item) ?? []),
    readings: list('readings').flatMap((item) => toReading(item) ?? []),
    batches: list('batches').flatMap((item) => toBatch(item) ?? []),
  };
}

export interface ClassRow {
  recordClass: string;
  kind: CapacityKind;
  reading: ReadingView | undefined;
  policy: CapPolicyView | undefined;
  /** Share of the row cap and of the size cap in use, in percent; null where there is no cap or no reading. */
  rowsPct: number | null;
  bytesPct: number | null;
  state: CapacityState;
}

/** One row per log class, in the order of the platform: the last reading, the cap in force and the shares of it in use. */
export function classRows(overview: Overview): ClassRow[] {
  return CAPACITY_CLASSES.map((recordClass) => {
    const reading = overview.readings.find((item) => item.recordClass === recordClass);
    const policy = overview.policies.find((item) => item.recordClass === recordClass && item.active);
    const evaluation = reading === undefined || policy === undefined ? undefined : evaluateCapacity(policy, reading);
    return {
      recordClass,
      kind: capacityKindOf(recordClass) ?? 'MONITOR_ONLY',
      reading,
      policy,
      rowsPct: evaluation?.rowsPct ?? null,
      bytesPct: evaluation?.bytesPct ?? null,
      state: evaluation?.state ?? reading?.state ?? 'UNCAPPED',
    };
  });
}

export interface CapForm {
  recordClass: string;
  maxRows: string;
  maxBytes: string;
  warnPct: string;
  active: boolean;
  reason: string;
}

export const emptyForm = (recordClass: string): CapForm => ({ recordClass, maxRows: '', maxBytes: '', warnPct: String(DEFAULT_WARN_PCT), active: true, reason: '' });

export function formOf(policy: CapPolicyView): CapForm {
  return {
    recordClass: policy.recordClass,
    maxRows: policy.maxRows === null ? '' : String(policy.maxRows),
    maxBytes: policy.maxBytes === null ? '' : String(policy.maxBytes),
    warnPct: String(policy.warnPct),
    active: policy.active,
    reason: '',
  };
}

export type CapField = 'limit' | 'maxRows' | 'maxBytes' | 'warnPct' | 'reason';
export type CapProblem = 'required' | 'format' | 'range';
export type CapErrors = Partial<Record<CapField, CapProblem>>;

const wholeNumber = (value: string): number | undefined => (/^[0-9]{1,15}$/.test(value.trim()) ? Number(value.trim()) : undefined);

export function validateCap(form: CapForm): CapErrors {
  const errors: CapErrors = {};
  const rows = form.maxRows.trim() === '' ? null : wholeNumber(form.maxRows);
  const bytes = form.maxBytes.trim() === '' ? null : wholeNumber(form.maxBytes);
  if (rows === undefined) errors.maxRows = 'format';
  else if (rows !== null && (rows < 1 || rows > MAX_ROWS)) errors.maxRows = 'range';
  if (bytes === undefined) errors.maxBytes = 'format';
  else if (bytes !== null && (bytes < MIN_BYTES || bytes > MAX_BYTES)) errors.maxBytes = 'range';
  if (rows === null && bytes === null) errors.limit = 'required';
  const warn = wholeNumber(form.warnPct);
  if (warn === undefined) errors.warnPct = 'format';
  else if (warn < 50 || warn > 99) errors.warnPct = 'range';
  if (form.reason.trim().length < REASON_MIN_LENGTH || form.reason.length > REASON_MAX_LENGTH) errors.reason = 'required';
  return errors;
}

export interface SaveBody {
  record_class: string;
  max_rows: number | null;
  max_bytes: number | null;
  warn_pct: number;
  active: boolean;
  reason: string;
  expected_version: number;
}

export function toSaveBody(form: CapForm, current: CapPolicyView | undefined): SaveBody {
  return {
    record_class: form.recordClass,
    max_rows: form.maxRows.trim() === '' ? null : Number(form.maxRows.trim()),
    max_bytes: form.maxBytes.trim() === '' ? null : Number(form.maxBytes.trim()),
    warn_pct: Number(form.warnPct.trim()),
    active: form.active,
    reason: form.reason.trim(),
    expected_version: current?.version ?? 0,
  };
}

export type ProblemReason = 'invalid' | 'belowProtected' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';

/** Maps the error of the save to what the screen shows; the server lists its findings in `errors`, and one of them says the cap is below what the retention rule protects. */
export function describeProblem(error: unknown): ProblemReason {
  if (!(error instanceof ApiError)) return 'general';
  const listed = error.extensions.errors;
  if (Array.isArray(listed) && listed.some((entry) => isRecord(entry) && entry.code === 'BELOW_PROTECTED_ROWS')) return 'belowProtected';
  switch (error.code) {
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
      return 'invalid';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}

/** Bytes written for people: 1,024-based units with one decimal above a kibibyte. */
export function byteText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}
