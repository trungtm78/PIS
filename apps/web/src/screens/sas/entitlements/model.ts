import { ApiError } from '@machvon/api-client';
import { FEATURE_CODES } from '../plan/model';

/** The permissions of the override part of SAS-25 (x-permission of the operations in openapi.json). */
export const MANAGE_OVERRIDES_PERMISSION = 'system.billing.manage';

export const OVERRIDE_STATUSES = ['PendingApproval', 'Active', 'Revoked', 'Expired', 'Rejected'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

export interface OverrideEntry {
  id: string;
  featureCode: string;
  enabled: boolean;
  limitValue: string | undefined;
  reason: string;
  validFrom: string;
  validUntil: string;
  status: OverrideStatus;
  requestedBy: string;
  approvedBy: string | undefined;
  version: number;
}

export interface OverridePage {
  items: OverrideEntry[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function toOverride(raw: unknown): OverrideEntry | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return {
    id: row.id,
    featureCode: text(row.feature_code),
    enabled: row.enabled === true,
    limitValue: optionalText(row.limit_value),
    reason: text(row.reason),
    validFrom: text(row.valid_from),
    validUntil: text(row.valid_until),
    status: OVERRIDE_STATUSES.find((candidate) => candidate === row.status) ?? 'PendingApproval',
    requestedBy: text(row.requested_by),
    approvedBy: optionalText(row.approved_by),
    version: typeof row.version === 'number' && Number.isFinite(row.version) ? row.version : 0,
  };
}

export function toOverridePage(raw: unknown): OverridePage {
  const page: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(page.items) ? page.items.flatMap((entry) => toOverride(entry) ?? []) : [],
    nextCursor: typeof page.next_cursor === 'string' ? page.next_cursor : undefined,
  };
}

/** Whether the person may decide the request: it waits, and it is not their own (four eyes: the server and the database refuse the same). */
export const mayDecide = (entry: OverrideEntry, membershipId: string | undefined): boolean =>
  entry.status === 'PendingApproval' && membershipId !== undefined && entry.requestedBy.toLowerCase() !== membershipId.toLowerCase();

/** An override that waits or is in force may be ended early. */
export const mayRevoke = (entry: OverrideEntry): boolean => entry.status === 'PendingApproval' || entry.status === 'Active';

// ---- the form ---------------------------------------------------------------------------------------------------------

export interface OverrideForm {
  featureCode: string;
  enabled: boolean;
  limitValue: string;
  /** `datetime-local` text of the browser: a wall-clock time without zone, read as UTC. */
  validFrom: string;
  validUntil: string;
  reason: string;
}

export const EMPTY_OVERRIDE_FORM: OverrideForm = {
  featureCode: '',
  enabled: false,
  limitValue: '',
  validFrom: '',
  validUntil: '',
  reason: '',
};

export type OverrideField = 'featureCode' | 'limitValue' | 'validFrom' | 'validUntil' | 'reason';
export type OverrideFieldProblem = 'required' | 'notDateTime' | 'notNumber' | 'limitNeedsEnabled' | 'windowInvalid' | 'alreadyEnded' | 'tooLong' | 'tooFarAhead' | 'reasonLength';

export const OVERRIDE_FEATURES: readonly string[] = FEATURE_CODES;
export const MIN_OVERRIDE_REASON = 10;
export const MAX_OVERRIDE_REASON = 2000;
/** The same bounds as the server (kernel `overrideIssues`): an exception for a year at most, decided at most 90 days before it starts. */
export const MAX_OVERRIDE_DAYS = 366;
export const MAX_OVERRIDE_LEAD_DAYS = 90;
const DAY_MS = 86_400_000;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const LIMIT = /^[0-9]{1,18}(\.[0-9]{1,6})?$/;

/** The instant a `datetime-local` text means (read as UTC), or NaN. */
export function instantOf(value: string): number {
  return DATE_TIME.test(value) ? Date.parse(`${value}${value.length === 16 ? ':00' : ''}Z`) : Number.NaN;
}

export function validateOverrideForm(form: OverrideForm, now: Date): Partial<Record<OverrideField, OverrideFieldProblem>> {
  const problems: Partial<Record<OverrideField, OverrideFieldProblem>> = {};
  if (form.featureCode === '') problems.featureCode = 'required';
  const limit = form.limitValue.trim();
  if (limit !== '') {
    if (!LIMIT.test(limit)) problems.limitValue = 'notNumber';
    else if (!form.enabled) problems.limitValue = 'limitNeedsEnabled';
  }
  const [from, until] = [instantOf(form.validFrom), instantOf(form.validUntil)];
  if (form.validFrom === '') problems.validFrom = 'required';
  else if (Number.isNaN(from)) problems.validFrom = 'notDateTime';
  if (form.validUntil === '') problems.validUntil = 'required';
  else if (Number.isNaN(until)) problems.validUntil = 'notDateTime';
  if (problems.validFrom === undefined && problems.validUntil === undefined) {
    if (from >= until) problems.validUntil = 'windowInvalid';
    else if (until <= now.getTime()) problems.validUntil = 'alreadyEnded';
    else if (until - from > MAX_OVERRIDE_DAYS * DAY_MS) problems.validUntil = 'tooLong';
    if (from > now.getTime() + MAX_OVERRIDE_LEAD_DAYS * DAY_MS) problems.validFrom = 'tooFarAhead';
  }
  const reason = form.reason.trim();
  if (reason.length < MIN_OVERRIDE_REASON || reason.length > MAX_OVERRIDE_REASON) problems.reason = 'reasonLength';
  return problems;
}

/** The body of `requestEntitlementOverride` for a form that passed `validateOverrideForm`. */
export function overrideBody(form: OverrideForm): Record<string, unknown> {
  return {
    feature_code: form.featureCode,
    enabled: form.enabled,
    ...(form.limitValue.trim() === '' ? {} : { limit_value: form.limitValue.trim() }),
    valid_from: new Date(instantOf(form.validFrom)).toISOString(),
    valid_until: new Date(instantOf(form.validUntil)).toISOString(),
    reason: form.reason.trim(),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type OverrideProblemReason = 'selfApproval' | 'featureUnknown' | 'stageDenied' | 'conflict' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';

export interface OverrideProblem {
  reason: OverrideProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, OverrideProblemReason>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  FEATURE_UNKNOWN: 'featureUnknown',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  VERSION_CONFLICT: 'conflict',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeOverrideProblem(error: unknown): OverrideProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return {
    reason: REASON_BY_CODE[error.code] ?? 'general',
    field: error.detail,
  };
}
