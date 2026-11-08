import { ApiError } from '@machvon/api-client';

/** Permissions of ADM-12 (x-permission in openapi.json): a version is drafted by one person and published by another; the reads need no more than the read permission. */
export const READ_RETENTION_PERMISSION = 'adm.retention.read';
export const READ_HOLD_PERMISSION = 'legal_hold.read';
export const MANAGE_RETENTION_PERMISSION = 'adm.retention.manage';
export const APPROVE_RETENTION_PERMISSION = 'adm.retention.approve';
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 2000;
export const MIN_YEARS = 1;
export const MAX_YEARS = 100;
const MIN_LEGAL_BASIS = 5;
const MAX_LEGAL_BASIS = 500;

export type RetentionBasis = 'FROM_CREATED' | 'FROM_CLOSED' | 'FROM_CONTRACT_END' | 'PERMANENT';
export const RETENTION_BASES: readonly RetentionBasis[] = ['FROM_CREATED', 'FROM_CLOSED', 'FROM_CONTRACT_END', 'PERMANENT'];
export type EndAction = 'REVIEW_FOR_DESTRUCTION' | 'ARCHIVE_TRANSFER' | 'AUTO_PURGE_TECHNICAL';
export const END_ACTIONS: readonly EndAction[] = ['REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER', 'AUTO_PURGE_TECHNICAL'];
export type PolicyStatus = 'Draft' | 'Published' | 'Superseded';
const POLICY_STATUSES: readonly string[] = ['Draft', 'Published', 'Superseded'];

export type RecordKind = 'BUSINESS' | 'TECHNICAL';

/** The record classes a policy may name. The server holds the same lists (BR-ADM-11) and is the one that refuses; this only offers the choices. */
export const TECHNICAL_CLASSES: readonly string[] = ['idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'delivery_attempt'];
export const BUSINESS_CLASSES: readonly string[] = ['project_dossier', 'payment_dossier', 'contract_dossier', 'report_revision', 'audit_event'];
const BUSINESS_CLASS = /^(?:[a-z][a-z0-9_]*_dossier|report_revision|contract[a-z0-9_]*|payment[a-z0-9_]*|audit_event)$/;
const CLASS_NAME = /^[a-z][a-z0-9_]{1,79}$/;

export function recordKindOf(recordClass: string): RecordKind | undefined {
  if (TECHNICAL_CLASSES.includes(recordClass)) return 'TECHNICAL';
  return BUSINESS_CLASS.test(recordClass) ? 'BUSINESS' : undefined;
}

/** The end actions a class allows: a business record is reviewed or transferred, never purged by a job; a technical class is only purged. */
export function endActionsFor(recordClass: string): readonly EndAction[] {
  const kind = recordKindOf(recordClass);
  if (kind === 'TECHNICAL') return ['AUTO_PURGE_TECHNICAL'];
  if (kind === 'BUSINESS') return ['REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER'];
  return END_ACTIONS;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One retention policy version as the read of the register returns it. */
export interface PolicyView {
  id: string;
  recordClass: string;
  revision: number;
  retentionYears: number | null;
  retentionBasis: RetentionBasis;
  legalBasisRef: string;
  endAction: EndAction;
  effectiveFrom: string;
  status: PolicyStatus;
  createdBy: string;
  approvedBy: string | null;
  publishedAt: string | null;
  version: number;
}

export function toPolicy(raw: unknown): PolicyView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const recordClass = text(raw.record_class);
  const basis = text(raw.retention_basis);
  const endAction = text(raw.end_action);
  const status = text(raw.status);
  const legalBasisRef = text(raw.legal_basis_ref);
  const effectiveFrom = text(raw.effective_from);
  const createdBy = text(raw.created_by);
  if (id === undefined || recordClass === undefined || basis === undefined || endAction === undefined || status === undefined || legalBasisRef === undefined) return undefined;
  if (effectiveFrom === undefined || createdBy === undefined || typeof raw.revision !== 'number' || typeof raw.version !== 'number') return undefined;
  if (!(RETENTION_BASES as readonly string[]).includes(basis) || !(END_ACTIONS as readonly string[]).includes(endAction) || !POLICY_STATUSES.includes(status)) return undefined;
  return {
    id,
    recordClass,
    revision: raw.revision,
    retentionYears: typeof raw.retention_years === 'number' ? raw.retention_years : null,
    retentionBasis: basis as RetentionBasis,
    legalBasisRef,
    endAction: endAction as EndAction,
    effectiveFrom,
    status: status as PolicyStatus,
    createdBy,
    approvedBy: nullableText(raw.approved_by),
    publishedAt: nullableText(raw.published_at),
    version: raw.version,
  };
}

/** A record of a business class whose period has run out: it waits here for a person to decide; no job deletes it. */
export interface ReviewItemView {
  id: string;
  recordClass: string;
  resourceType: string;
  resourceId: string;
  basisDate: string;
  dueOn: string;
  endAction: EndAction;
}

export function toReviewItem(raw: unknown): ReviewItemView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const recordClass = text(raw.record_class);
  const resourceType = text(raw.resource_type);
  const resourceId = text(raw.resource_id);
  const basisDate = text(raw.basis_date);
  const dueOn = text(raw.due_on);
  const endAction = text(raw.end_action);
  if (id === undefined || recordClass === undefined || resourceType === undefined || resourceId === undefined || basisDate === undefined || dueOn === undefined || endAction === undefined) return undefined;
  if (!(END_ACTIONS as readonly string[]).includes(endAction)) return undefined;
  return { id, recordClass, resourceType, resourceId, basisDate, dueOn, endAction: endAction as EndAction };
}

export type HoldKind = 'INSPECTION' | 'AUDIT' | 'LITIGATION' | 'INVESTIGATION' | 'CONTRACT_END';
export type HoldScopeKind = 'TENANT' | 'UNIT' | 'PROJECT' | 'CONTRACT' | 'RESOURCE';
const HOLD_KINDS: readonly string[] = ['INSPECTION', 'AUDIT', 'LITIGATION', 'INVESTIGATION', 'CONTRACT_END'];
const HOLD_SCOPES: readonly string[] = ['TENANT', 'UNIT', 'PROJECT', 'CONTRACT', 'RESOURCE'];

/** A legal hold as the register of ST-ADM-003 returns it (the authority reference is masked for a caller who may not manage holds). */
export interface HoldView {
  id: string;
  holdKind: HoldKind;
  status: 'Active' | 'Released';
  scopeKind: HoldScopeKind;
  scopeCount: number;
  authorityReference: string;
  reason: string;
  effectiveAt: string;
  /** The version the release is made under (`If-Match`), when the register row carries one. */
  version?: number;
}

export function toHold(raw: unknown): HoldView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const kind = text(raw.hold_kind);
  const status = text(raw.status);
  const authorityReference = text(raw.authority_reference);
  const reason = text(raw.reason);
  const effectiveAt = text(raw.effective_at);
  const scope = raw.resource_scope;
  if (id === undefined || kind === undefined || !HOLD_KINDS.includes(kind) || (status !== 'Active' && status !== 'Released')) return undefined;
  if (authorityReference === undefined || reason === undefined || effectiveAt === undefined || !isRecord(scope)) return undefined;
  const scopeKind = text(scope.kind);
  if (scopeKind === undefined || !HOLD_SCOPES.includes(scopeKind)) return undefined;
  return {
    id,
    holdKind: kind as HoldKind,
    status,
    scopeKind: scopeKind as HoldScopeKind,
    scopeCount: Array.isArray(scope.ids) ? scope.ids.length : 0,
    authorityReference,
    reason,
    effectiveAt,
    ...(typeof raw.version === 'number' ? { version: raw.version } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The form of a draft.

export interface DraftValues {
  recordClass: string;
  retentionBasis: RetentionBasis;
  retentionYears: string;
  endAction: EndAction;
  legalBasisRef: string;
  effectiveFrom: string;
}

export const EMPTY_DRAFT: DraftValues = {
  recordClass: '',
  retentionBasis: 'FROM_CREATED',
  retentionYears: '',
  endAction: 'REVIEW_FOR_DESTRUCTION',
  legalBasisRef: '',
  effectiveFrom: '',
};

export type DraftField = keyof DraftValues;
export type DraftProblem = 'required' | 'classUnknown' | 'classFormat' | 'endAction' | 'basis' | 'yearsRequired' | 'yearsNotAllowed' | 'yearsRange' | 'legalBasis' | 'date';
export type DraftErrors = Partial<Record<DraftField, DraftProblem>>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The rules of BR-ADM-11 that the form can state, so that the mistakes a person can see never leave the screen. */
export function validateDraft(values: DraftValues): DraftErrors {
  const errors: DraftErrors = {};
  const recordClass = values.recordClass.trim();
  const kind = CLASS_NAME.test(recordClass) ? recordKindOf(recordClass) : undefined;
  if (recordClass === '') errors.recordClass = 'required';
  else if (!CLASS_NAME.test(recordClass)) errors.recordClass = 'classFormat';
  else if (kind === undefined) errors.recordClass = 'classUnknown';
  if (kind !== undefined && !endActionsFor(recordClass).includes(values.endAction)) errors.endAction = 'endAction';
  if (kind === 'TECHNICAL' && values.retentionBasis !== 'FROM_CREATED' && values.retentionBasis !== 'PERMANENT') errors.retentionBasis = 'basis';
  const years = values.retentionYears.trim();
  if (values.retentionBasis === 'PERMANENT') {
    if (years !== '') errors.retentionYears = 'yearsNotAllowed';
  } else if (years === '') errors.retentionYears = 'yearsRequired';
  else if (!/^\d{1,3}$/.test(years) || Number(years) < MIN_YEARS || Number(years) > MAX_YEARS) errors.retentionYears = 'yearsRange';
  const legalBasis = values.legalBasisRef.trim();
  if (legalBasis.length < MIN_LEGAL_BASIS || legalBasis.length > MAX_LEGAL_BASIS) errors.legalBasisRef = 'legalBasis';
  if (!isRealDay(values.effectiveFrom)) errors.effectiveFrom = 'date';
  return errors;
}

export interface DraftBody {
  record_class: string;
  retention_years?: number;
  retention_basis: RetentionBasis;
  legal_basis_ref: string;
  end_action: EndAction;
  effective_from: string;
}

/** The body of createRetentionPolicyVersion for values that passed `validateDraft`. */
export function draftBody(values: DraftValues): DraftBody {
  return {
    record_class: values.recordClass.trim(),
    ...(values.retentionBasis === 'PERMANENT' ? {} : { retention_years: Number(values.retentionYears.trim()) }),
    retention_basis: values.retentionBasis,
    legal_basis_ref: values.legalBasisRef.trim(),
    end_action: values.endAction,
    effective_from: values.effectiveFrom,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Failures of the commands.

export type FindingCode =
  | 'CLASS_FORMAT'
  | 'CLASS_UNKNOWN'
  | 'END_ACTION_NOT_ALLOWED'
  | 'BASIS_NOT_ALLOWED'
  | 'YEARS_REQUIRED'
  | 'YEARS_NOT_ALLOWED'
  | 'YEARS_RANGE'
  | 'LEGAL_BASIS_REQUIRED'
  | 'DATE_INVALID'
  | 'DATE_FUTURE'
  | 'BELOW_PLATFORM_BASELINE';
const FINDING_CODES: readonly string[] = [
  'CLASS_FORMAT',
  'CLASS_UNKNOWN',
  'END_ACTION_NOT_ALLOWED',
  'BASIS_NOT_ALLOWED',
  'YEARS_REQUIRED',
  'YEARS_NOT_ALLOWED',
  'YEARS_RANGE',
  'LEGAL_BASIS_REQUIRED',
  'DATE_INVALID',
  'DATE_FUTURE',
  'BELOW_PLATFORM_BASELINE',
];

export interface Finding {
  field: string;
  code: FindingCode;
}

export type ProblemReason = 'invalid' | 'conflict' | 'selfApproval' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** The findings the server listed for RETENTION_POLICY_INVALID, in its order. */
  findings: Finding[];
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  RETENTION_POLICY_INVALID: 'invalid',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  VERSION_CONFLICT: 'conflict',
  SELF_APPROVAL_DENIED: 'selfApproval',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

function findingsOf(error: ApiError): Finding[] {
  const listed = error.extensions.errors;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.field !== 'string' || typeof entry.code !== 'string' || !FINDING_CODES.includes(entry.code)) return [];
    return [{ field: entry.field, code: entry.code as FindingCode }];
  });
}

/** Maps the error of a command of ADM-12 to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', findings: [] };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', findings: findingsOf(error) };
}

/** The order of the register: by class, a class's versions newest first. */
export function inRegisterOrder(policies: readonly PolicyView[]): PolicyView[] {
  return [...policies].sort((a, b) => a.recordClass.localeCompare(b.recordClass) || b.revision - a.revision);
}
