import { ApiError } from '@machvon/api-client';

/** Permission of the export (x-permission of exportAuditLog in openapi.json); the viewer itself needs audit_event.read. */
export const EXPORT_AUDIT_PERMISSION = 'audit.export';
export const READ_AUDIT_PERMISSION = 'audit_event.read';
/** ADM 3.11: one export covers at most this many days. */
export const MAX_EXPORT_DAYS = 366;
export const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;
const MAX_FILTER_TEXT = 200;
const MAX_RESOURCE_TYPES = 50;
const RESOURCE_TYPE_NAME = /^[a-z][a-z0-9_]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILED';
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['SUCCESS', 'DENIED', 'FAILED'];

export type SealStatus = 'OK' | 'BROKEN' | 'STALE' | 'UNKNOWN';
const SEAL_STATUSES: readonly string[] = ['OK', 'BROKEN', 'STALE', 'UNKNOWN'];
const SEAL_REASONS = ['ROOT_MISMATCH', 'SEAL_HASH_MISMATCH', 'CHAIN_LINK_MISMATCH', 'UNSEALED_ROW_IN_GAP'] as const;
export type SealReason = (typeof SEAL_REASONS)[number];

export interface AuditEventView {
  id: string;
  seq: number;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  /** The diff as the server redacted it. */
  safeDiff: Record<string, unknown> | null;
  reason: string | null;
  outcome: AuditOutcome;
  classification: string;
  impersonatorId: string | null;
  onBehalfOfId: string | null;
  occurredAt: string;
  /** The seal that covers the event; null while it waits for the next run of the sealer. */
  sealHash: string | null;
}

export interface BrokenSeal {
  sealId: string;
  fromSeq: number;
  toSeq: number;
  reason: SealReason;
}

/** The kept verdict of the seal verification that the banner of the viewer shows. */
export interface SealView {
  status: SealStatus;
  checkedAt: string | null;
  seals: number | null;
  broken: BrokenSeal | null;
}

export interface AuditPage {
  events: AuditEventView[];
  nextCursor: string | undefined;
  seal: SealView;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One row of the audit read; a row that lacks what the table needs is dropped, never shown half. */
export function toAuditEvent(raw: unknown): AuditEventView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const actorId = text(raw.actor_id);
  const action = text(raw.action);
  const resourceType = text(raw.resource_type);
  const resourceId = text(raw.resource_id);
  const outcome = text(raw.outcome);
  const occurredAt = text(raw.occurred_at);
  if (id === undefined || actorId === undefined || action === undefined || resourceType === undefined || resourceId === undefined || occurredAt === undefined) return undefined;
  if (outcome === undefined || !(AUDIT_OUTCOMES as readonly string[]).includes(outcome) || typeof raw.seq !== 'number') return undefined;
  return {
    id,
    seq: raw.seq,
    actorId,
    action,
    resourceType,
    resourceId,
    safeDiff: isRecord(raw.safe_diff) ? raw.safe_diff : null,
    reason: nullableText(raw.reason),
    outcome: outcome as AuditOutcome,
    classification: text(raw.classification) ?? 'INTERNAL',
    impersonatorId: nullableText(raw.impersonator_id),
    onBehalfOfId: nullableText(raw.on_behalf_of_id),
    occurredAt,
    sealHash: nullableText(raw.seal_hash),
  };
}

const UNKNOWN_SEAL: SealView = { status: 'UNKNOWN', checkedAt: null, seals: null, broken: null };

function toBroken(raw: unknown): BrokenSeal | null {
  if (!isRecord(raw)) return null;
  const sealId = text(raw.seal_id);
  const reason = SEAL_REASONS.find((candidate) => candidate === raw.reason);
  if (sealId === undefined || reason === undefined || typeof raw.from_seq !== 'number' || typeof raw.to_seq !== 'number') return null;
  return { sealId, fromSeq: raw.from_seq, toSeq: raw.to_seq, reason };
}

/**
 * The kept verdict. A verdict the screen cannot read is UNKNOWN, never OK: a banner must not go quiet because an answer
 * changed shape. A BROKEN verdict that names no window is still BROKEN.
 */
export function toSealView(raw: unknown): SealView {
  if (!isRecord(raw)) return UNKNOWN_SEAL;
  const status = text(raw.status);
  if (status === undefined || !SEAL_STATUSES.includes(status)) return UNKNOWN_SEAL;
  return {
    status: status as SealStatus,
    checkedAt: nullableText(raw.checked_at),
    seals: typeof raw.seals === 'number' ? raw.seals : null,
    broken: toBroken(raw.broken),
  };
}

/** A page of the audit read: the rows, the cursor of the next page and the seal verdict. */
export function toAuditPage(raw: unknown): AuditPage {
  const page = isRecord(raw) ? raw : {};
  const items = Array.isArray(page.items) ? page.items : [];
  return {
    events: items.flatMap((item) => toAuditEvent(item) ?? []),
    nextCursor: text(page.next_cursor),
    seal: toSealView(page.seal),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The filter bar.

/** What the person typed; the `datetime-local` inputs give `YYYY-MM-DDTHH:mm` in the local zone. */
export interface FilterValues {
  actorId: string;
  action: string;
  resourceType: string;
  outcome: '' | AuditOutcome;
  from: string;
  to: string;
}

export const EMPTY_FILTER: FilterValues = { actorId: '', action: '', resourceType: '', outcome: '', from: '', to: '' };

export type FilterField = keyof FilterValues;
export type FilterProblem = 'invalid' | 'order' | 'tooLong';
export type FilterErrors = Partial<Record<FilterField, FilterProblem>>;

function instantOf(local: string): number {
  return local === '' ? Number.NaN : new Date(local).getTime();
}

export function validateFilter(values: FilterValues): FilterErrors {
  const errors: FilterErrors = {};
  if (values.actorId.trim() !== '' && !UUID.test(values.actorId.trim())) errors.actorId = 'invalid';
  if (values.action.trim().length > MAX_FILTER_TEXT) errors.action = 'tooLong';
  if (values.resourceType.trim().length > MAX_FILTER_TEXT) errors.resourceType = 'tooLong';
  if (values.from !== '' && Number.isNaN(instantOf(values.from))) errors.from = 'invalid';
  if (values.to !== '' && Number.isNaN(instantOf(values.to))) errors.to = 'invalid';
  if (errors.from === undefined && errors.to === undefined && values.from !== '' && values.to !== '' && instantOf(values.to) <= instantOf(values.from)) errors.to = 'order';
  return errors;
}

/** The query of the read for filter values that passed `validateFilter`: only what was filled in. */
export function filterQuery(values: FilterValues): Record<string, string> {
  const query: Record<string, string> = {};
  if (values.actorId.trim() !== '') query.actor_id = values.actorId.trim().toLowerCase();
  if (values.action.trim() !== '') query.action = values.action.trim();
  if (values.resourceType.trim() !== '') query.resource_type = values.resourceType.trim();
  if (values.outcome !== '') query.outcome = values.outcome;
  if (values.from !== '') query.from = new Date(instantOf(values.from)).toISOString();
  if (values.to !== '') query.to = new Date(instantOf(values.to)).toISOString();
  return query;
}

export const hasFilter = (values: FilterValues): boolean => Object.keys(filterQuery(values)).length > 0;

// ---------------------------------------------------------------------------------------------------------------------------
// The export.

export type ExportFormat = 'CSV' | 'JSONL';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['CSV', 'JSONL'];

export interface ExportValues {
  from: string;
  to: string;
  format: ExportFormat;
  /** Comma separated names; empty means every type. */
  resourceTypes: string;
}

export const EMPTY_EXPORT: ExportValues = { from: '', to: '', format: 'JSONL', resourceTypes: '' };

export type ExportField = 'from' | 'to' | 'resourceTypes';
export type ExportProblem = 'required' | 'invalid' | 'order' | 'range';
export type ExportErrors = Partial<Record<ExportField, ExportProblem>>;

/** The resource type names of the box, trimmed, de-duplicated and in the order typed. */
export function resourceTypesOf(value: string): string[] {
  return [...new Set(value.split(',').map((name) => name.trim()).filter((name) => name !== ''))];
}

/** The same rules as the server (a period of at most 366 days, resource type names), so most mistakes never leave the form. */
export function validateExport(values: ExportValues): ExportErrors {
  const errors: ExportErrors = {};
  if (values.from === '') errors.from = 'required';
  else if (Number.isNaN(instantOf(values.from))) errors.from = 'invalid';
  if (values.to === '') errors.to = 'required';
  else if (Number.isNaN(instantOf(values.to))) errors.to = 'invalid';
  if (errors.from === undefined && errors.to === undefined) {
    const span = instantOf(values.to) - instantOf(values.from);
    if (span <= 0) errors.to = 'order';
    else if (span > MAX_EXPORT_DAYS * DAY_MS) errors.to = 'range';
  }
  const names = resourceTypesOf(values.resourceTypes);
  if (values.resourceTypes.trim() !== '' && (names.length > MAX_RESOURCE_TYPES || !names.every((name) => RESOURCE_TYPE_NAME.test(name)))) errors.resourceTypes = 'invalid';
  return errors;
}

export interface ExportBody {
  from: string;
  to: string;
  format: ExportFormat;
  resource_types?: string[];
}

/** The body of exportAuditLog for values that passed `validateExport`. */
export function exportBody(values: ExportValues): ExportBody {
  const names = resourceTypesOf(values.resourceTypes);
  return {
    from: new Date(instantOf(values.from)).toISOString(),
    to: new Date(instantOf(values.to)).toISOString(),
    format: values.format,
    ...(names.length === 0 ? {} : { resource_types: names }),
  };
}

/** What a finished export tells the person: the id of the export (the file is kept in the file store of the tenant). */
export interface ExportDone {
  exportId: string;
}

export function toExportDone(raw: unknown): ExportDone | undefined {
  if (!isRecord(raw)) return undefined;
  const exportId = text(raw.resource_id);
  return exportId === undefined ? undefined : { exportId };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Failures of the commands.

export type ProblemReason = 'rangeTooLarge' | 'invalid' | 'denied' | 'notClean' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  EXPORT_RANGE_TOO_LARGE: 'rangeTooLarge',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  FILE_NOT_CLEAN: 'notClean',
  SESSION_EXPIRED: 'session',
};

/** Maps the error of an export to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  return { reason: error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general' };
}

/** The first characters of a seal hash, which is long: enough to compare two by eye; the whole hash is in the title. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
