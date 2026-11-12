import { ApiError } from '@machvon/api-client';

/** Permissions of ADM-29 (x-permission in openapi.json): the settings need a grant over the whole tenant. */
export const READ_AUDIT_DETAIL_PERMISSION = 'adm.audit_detail.read';
export const MANAGE_AUDIT_DETAIL_PERMISSION = 'adm.audit_detail.manage';

export const MIN_BYTES = 1024;
export const MAX_BYTES = 262_144;
export const DEFAULT_BYTES = 16_384;
export const MAX_SENSITIVE_KEYS = 50;
export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 2000;
const RESOURCE_TYPE = /^[a-z][a-z0-9_]{1,79}$/;
const KEY_ENTRY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Classes of business object the enterprise edition writes a full before and after for; the server accepts any class name, these are the choices offered. */
export const SUGGESTED_CLASSES: readonly string[] = ['period_snapshot', 'plan_figure_revision', 'period_reopen', 'reporting_period', 'hpm_push', 'report_revision'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export interface PolicyView {
  id: string;
  resourceType: string;
  enabled: boolean;
  maxBytes: number;
  sensitiveKeys: string[];
  reason: string;
  version: number;
  updatedAt: string;
}

export function toPolicy(raw: unknown): PolicyView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const resourceType = text(raw.resource_type);
  if (id === undefined || resourceType === undefined || typeof raw.enabled !== 'boolean' || typeof raw.max_bytes !== 'number' || typeof raw.version !== 'number') return undefined;
  return {
    id,
    resourceType,
    enabled: raw.enabled,
    maxBytes: raw.max_bytes,
    sensitiveKeys: Array.isArray(raw.sensitive_keys) ? raw.sensitive_keys.filter((key): key is string => typeof key === 'string') : [],
    reason: text(raw.reason) ?? '',
    version: raw.version,
    updatedAt: text(raw.updated_at) ?? '',
  };
}

export function toPolicies(raw: unknown): PolicyView[] {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  return items.flatMap((item: unknown) => toPolicy(item) ?? []).sort((a, b) => a.resourceType.localeCompare(b.resourceType));
}

export interface DetailView {
  auditEventId: string;
  resourceType: string;
  before: unknown;
  after: unknown;
  sha256: string;
  bytes: number;
  redactedPaths: string[];
  truncated: boolean;
  changedPaths: string[];
  matchesSealedRow: boolean;
  createdAt: string;
}

export function toDetail(raw: unknown): DetailView | undefined {
  if (!isRecord(raw)) return undefined;
  const auditEventId = text(raw.audit_event_id);
  const sha256 = text(raw.sha256);
  if (auditEventId === undefined || sha256 === undefined || typeof raw.matches_sealed_row !== 'boolean') return undefined;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  return {
    auditEventId,
    resourceType: text(raw.resource_type) ?? '',
    before: raw.before ?? null,
    after: raw.after ?? null,
    sha256,
    bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
    redactedPaths: strings(raw.redacted_paths),
    truncated: raw.truncated === true,
    changedPaths: strings(raw.changed_paths),
    matchesSealedRow: raw.matches_sealed_row,
    createdAt: text(raw.created_at) ?? '',
  };
}

export interface PolicyForm {
  resourceType: string;
  enabled: boolean;
  maxBytes: string;
  sensitiveKeys: string;
  reason: string;
}

export const EMPTY_FORM: PolicyForm = { resourceType: '', enabled: true, maxBytes: String(DEFAULT_BYTES), sensitiveKeys: '', reason: '' };

export type FormField = 'resourceType' | 'maxBytes' | 'sensitiveKeys' | 'reason';
export type FormProblem = 'required' | 'format' | 'range' | 'tooMany';
export type FormErrors = Partial<Record<FormField, FormProblem>>;

/** The keys of the text box: separated by commas, spaces or lines; empty entries are dropped and a key is listed once. */
export function parseKeys(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).filter((entry) => entry !== ''))];
}

export function validateForm(form: PolicyForm): FormErrors {
  const errors: FormErrors = {};
  if (form.resourceType.trim() === '') errors.resourceType = 'required';
  else if (!RESOURCE_TYPE.test(form.resourceType.trim())) errors.resourceType = 'format';
  const bytes = Number(form.maxBytes);
  if (form.maxBytes.trim() === '' || !Number.isInteger(bytes)) errors.maxBytes = 'format';
  else if (bytes < MIN_BYTES || bytes > MAX_BYTES) errors.maxBytes = 'range';
  const keys = parseKeys(form.sensitiveKeys);
  if (keys.length > MAX_SENSITIVE_KEYS) errors.sensitiveKeys = 'tooMany';
  else if (keys.some((key) => !KEY_ENTRY.test(key))) errors.sensitiveKeys = 'format';
  if (form.reason.trim().length < REASON_MIN_LENGTH || form.reason.length > REASON_MAX_LENGTH) errors.reason = 'required';
  return errors;
}

export interface SaveBody {
  resource_type: string;
  enabled: boolean;
  max_bytes: number;
  sensitive_keys: string[];
  reason: string;
  expected_version: number;
}

export function toSaveBody(form: PolicyForm, current: PolicyView | undefined): SaveBody {
  return {
    resource_type: form.resourceType.trim(),
    enabled: form.enabled,
    max_bytes: Number(form.maxBytes),
    sensitive_keys: parseKeys(form.sensitiveKeys),
    reason: form.reason.trim(),
    expected_version: current?.version ?? 0,
  };
}

export function formOf(policy: PolicyView): PolicyForm {
  return { resourceType: policy.resourceType, enabled: policy.enabled, maxBytes: String(policy.maxBytes), sensitiveKeys: policy.sensitiveKeys.join(', '), reason: '' };
}

export type ProblemReason = 'invalid' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemReason {
  return error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general';
}

/** The pretty text of a stored value for the viewer: two-space JSON; the markers of redaction stay as they are. */
export function prettyValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}
