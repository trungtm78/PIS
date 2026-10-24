import { ApiError } from '@machvon/api-client';

export const PROPOSE_PERMISSION = 'master.propose';
export const REVIEW_PERMISSION = 'master.review';
export const PUBLISH_PERMISSION = 'master.publish';

export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 2000;
export const TYPE_MAX_LENGTH = 50;
export const KEY_MAX_LENGTH = 100;
export const LABEL_MAX_LENGTH = 500;
export const LEGAL_BASIS_MAX_LENGTH = 2000;

export type RecordStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'EFFECTIVE' | 'RETIRED' | 'MERGED';
export type ChangeStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'CANCELLED';
export type ChangeKind = 'CREATE' | 'UPDATE' | 'RETIRE';

const RECORD_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'EFFECTIVE', 'RETIRED', 'MERGED'];
const CHANGE_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'APPLIED', 'CANCELLED'];
const CHANGE_KINDS: readonly string[] = ['CREATE', 'UPDATE', 'RETIRE'];

export type Namespace = 'PLATFORM' | 'TENANT';

export interface RecordView {
  id: string;
  namespace: Namespace;
  masterType: string;
  businessKey: string;
  status: RecordStatus;
  label: string | null;
  validFrom: string | null;
  validUntil: string | null;
  versionId: string | null;
  openChangeRequestId: string | null;
  version: number;
  /** What the version in force says (the catalogue screens list entries with their columns from one read). */
  revision: number | null;
  parentRecordId: string | null;
  legalBasis: string | null;
  attributes: Record<string, unknown>;
}

export interface Impact {
  counts: Record<string, number>;
  total: number;
}

export interface ChangeView {
  id: string;
  changeKind: ChangeKind;
  masterType: string;
  businessKey: string | null;
  namespace: Namespace;
  masterRecordId: string | null;
  recordVersion: number | null;
  status: ChangeStatus;
  proposed: Record<string, unknown>;
  before: Record<string, unknown> | null;
  reason: string;
  impact: Impact | null;
  effectiveFrom: string;
  createdBy: string;
  reviewedBy: string | null;
  decisionDocumentId: string | null;
  version: number;
}

export interface VersionView {
  id: string;
  masterRecordId: string;
  revision: number;
  label: string;
  attributes: Record<string, unknown>;
  parentRecordId: string | null;
  validFrom: string;
  validUntil: string | null;
  status: string;
  legalBasis: string | null;
  approvedBy: string | null;
  changeRequestId: string | null;
}

export interface UsageView {
  total: number;
  counts: Record<string, number>;
  samples: Array<{ reference: string; id: string }>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export function toRecord(raw: unknown): RecordView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const masterType = text(row.master_type);
  const businessKey = text(row.business_key);
  const status = text(row.status);
  const version = whole(row.version);
  if (id === undefined || masterType === undefined || businessKey === undefined || status === undefined || !RECORD_STATUSES.includes(status) || version === undefined) return undefined;
  return {
    id,
    namespace: row.namespace === 'PLATFORM' ? 'PLATFORM' : 'TENANT',
    masterType,
    businessKey,
    status: status as RecordStatus,
    label: nullableText(row.label),
    validFrom: nullableText(row.valid_from),
    validUntil: nullableText(row.valid_until),
    versionId: nullableText(row.version_id),
    openChangeRequestId: nullableText(row.open_change_request_id),
    version,
    revision: whole(row.revision) ?? null,
    parentRecordId: nullableText(row.parent_record_id),
    legalBasis: nullableText(row.legal_basis),
    attributes: asRecord(row.attributes) ?? {},
  };
}

function impactOf(value: unknown): Impact | null {
  const row = asRecord(value);
  const counts = asRecord(row?.counts);
  const total = whole(row?.total);
  if (row === undefined || counts === undefined || total === undefined) return null;
  return { counts: Object.fromEntries(Object.entries(counts).flatMap(([key, count]) => (typeof count === 'number' ? [[key, count]] : []))), total };
}

export function toChange(raw: unknown): ChangeView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const kind = text(row.change_kind);
  const status = text(row.status);
  const masterType = text(row.master_type);
  const effectiveFrom = text(row.effective_from);
  const createdBy = text(row.created_by);
  const version = whole(row.version);
  if (
    id === undefined ||
    kind === undefined ||
    !CHANGE_KINDS.includes(kind) ||
    status === undefined ||
    !CHANGE_STATUSES.includes(status) ||
    masterType === undefined ||
    effectiveFrom === undefined ||
    createdBy === undefined ||
    version === undefined
  ) {
    return undefined;
  }
  return {
    id,
    changeKind: kind as ChangeKind,
    masterType,
    businessKey: nullableText(row.business_key),
    namespace: row.master_record_namespace === 'PLATFORM' ? 'PLATFORM' : 'TENANT',
    masterRecordId: nullableText(row.master_record_id),
    recordVersion: whole(row.master_record_version) ?? null,
    status: status as ChangeStatus,
    proposed: asRecord(row.proposed) ?? {},
    before: asRecord(row.before) ?? null,
    reason: text(row.reason) ?? '',
    impact: impactOf(row.impact),
    effectiveFrom,
    createdBy,
    reviewedBy: nullableText(row.reviewed_by),
    decisionDocumentId: nullableText(row.decision_document_id),
    version,
  };
}

export function toVersion(raw: unknown): VersionView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const masterRecordId = text(row.master_record_id);
  const label = text(row.label);
  const validFrom = text(row.valid_from);
  const revision = whole(row.revision);
  if (id === undefined || masterRecordId === undefined || label === undefined || validFrom === undefined || revision === undefined) return undefined;
  return {
    id,
    masterRecordId,
    revision,
    label,
    attributes: asRecord(row.attributes) ?? {},
    parentRecordId: nullableText(row.parent_record_id),
    validFrom,
    validUntil: nullableText(row.valid_until),
    status: text(row.status) ?? '',
    legalBasis: nullableText(row.legal_basis),
    approvedBy: nullableText(row.approved_by),
    changeRequestId: nullableText(row.change_request_id),
  };
}

export function toUsage(raw: unknown): UsageView | undefined {
  const row = asRecord(raw);
  const total = whole(row?.total);
  const counts = impactOf({ counts: row?.counts, total });
  if (row === undefined || counts === null) return undefined;
  const samples = Array.isArray(row.samples)
    ? row.samples.flatMap((sample) => {
        const entry = asRecord(sample);
        const reference = text(entry?.reference);
        const id = text(entry?.id);
        return reference === undefined || id === undefined ? [] : [{ reference, id }];
      })
    : [];
  return { total: counts.total, counts: counts.counts, samples };
}

export type TypeScope = 'PLATFORM_ONLY' | 'PLATFORM_WITH_TENANT_EXTENSION' | 'TENANT_ONLY';
const TYPE_SCOPES: readonly string[] = ['PLATFORM_ONLY', 'PLATFORM_WITH_TENANT_EXTENSION', 'TENANT_ONLY'];

export interface PolicyView {
  masterType: string;
  scope: TypeScope;
  retireRequiresSuccessor: boolean;
  locked: boolean;
  source: 'BASELINE' | 'TENANT';
  platformRecords: number;
  tenantRecords: number;
}

export function toPolicy(raw: unknown): PolicyView | undefined {
  const row = asRecord(raw);
  const masterType = text(row?.master_type);
  const scope = text(row?.scope);
  const source = text(row?.source);
  const platformRecords = whole(row?.platform_records);
  const tenantRecords = whole(row?.tenant_records);
  if (
    row === undefined ||
    masterType === undefined ||
    scope === undefined ||
    !TYPE_SCOPES.includes(scope) ||
    (source !== 'BASELINE' && source !== 'TENANT') ||
    platformRecords === undefined ||
    tenantRecords === undefined
  ) {
    return undefined;
  }
  return { masterType, scope: scope as TypeScope, retireRequiresSuccessor: row.retire_requires_successor === true, locked: row.locked === true, source, platformRecords, tenantRecords };
}

// ---- what changed between two versions ------------------------------------------------------------------------------

export type ChangedField = 'label' | 'attributes' | 'parent' | 'validity' | 'legalBasis';

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  const row = asRecord(value);
  if (row === undefined) return value;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, sortKeys(row[key])]));
}

/** The fields that differ between two versions of one entry, in the order the history shows them. */
export function changedFields(before: VersionView | undefined, after: VersionView): ChangedField[] {
  if (before === undefined) return ['label', 'attributes', 'parent', 'validity', 'legalBasis'].filter((field) => field !== 'legalBasis' || after.legalBasis !== null) as ChangedField[];
  const changed: ChangedField[] = [];
  if (before.label !== after.label) changed.push('label');
  if (!sameJson(before.attributes, after.attributes)) changed.push('attributes');
  if (before.parentRecordId !== after.parentRecordId) changed.push('parent');
  if (before.validFrom !== after.validFrom || before.validUntil !== after.validUntil) changed.push('validity');
  if (before.legalBasis !== after.legalBasis) changed.push('legalBasis');
  return changed;
}

/** The text a person reads for one field of a version. */
export function fieldValue(version: VersionView, field: ChangedField): string {
  switch (field) {
    case 'label':
      return version.label;
    case 'attributes':
      return JSON.stringify(sortKeys(version.attributes));
    case 'parent':
      return version.parentRecordId ?? '';
    case 'validity':
      return `${version.validFrom} → ${version.validUntil ?? ''}`.trim();
    case 'legalBasis':
      return version.legalBasis ?? '';
  }
}

// ---- forms ----------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooLong' | 'tooShort' | 'invalidDate' | 'order' | 'invalidJson';

export interface RecordForm {
  masterType: string;
  businessKey: string;
  label: string;
  parentRecordId: string;
  validFrom: string;
  validUntil: string;
  legalBasis: string;
  attributes: string;
  reason: string;
}

export const EMPTY_RECORD_FORM: RecordForm = { masterType: '', businessKey: '', label: '', parentRecordId: '', validFrom: '', validUntil: '', legalBasis: '', attributes: '{}', reason: '' };
export type FormErrors<Field extends string> = Partial<Record<Field, FieldProblem>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // A month or a day that does not exist is an invalid time (month 13) or another date (February 30th rolls into March).
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The attributes text as an object, or undefined when it is not one. */
export function parseAttributes(value: string): Record<string, unknown> | undefined {
  if (value.trim() === '') return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function checkText(value: string, max: number, required: boolean): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  return trimmed.length > max ? 'tooLong' : undefined;
}

function checkReason(value: string): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (trimmed.length < REASON_MIN_LENGTH) return 'tooShort';
  return trimmed.length > REASON_MAX_LENGTH ? 'tooLong' : undefined;
}

function checkDates(validFrom: string, validUntil: string): Partial<Record<'validFrom' | 'validUntil', FieldProblem>> {
  const problems: Partial<Record<'validFrom' | 'validUntil', FieldProblem>> = {};
  if (validFrom === '') problems.validFrom = 'required';
  else if (!isCalendarDate(validFrom)) problems.validFrom = 'invalidDate';
  if (validUntil !== '') {
    if (!isCalendarDate(validUntil)) problems.validUntil = 'invalidDate';
    else if (problems.validFrom === undefined && validUntil <= validFrom) problems.validUntil = 'order';
  }
  return problems;
}

export type RecordField = keyof RecordForm;

export function validateNewRecord(form: RecordForm): FormErrors<RecordField> {
  const errors: FormErrors<RecordField> = {};
  const set = (field: RecordField, problem: FieldProblem | undefined): void => {
    if (problem !== undefined) errors[field] = problem;
  };
  set('masterType', checkText(form.masterType, TYPE_MAX_LENGTH, true));
  set('businessKey', checkText(form.businessKey, KEY_MAX_LENGTH, true));
  set('label', checkText(form.label, LABEL_MAX_LENGTH, true));
  set('legalBasis', checkText(form.legalBasis, LEGAL_BASIS_MAX_LENGTH, false));
  set('reason', checkReason(form.reason));
  Object.assign(errors, checkDates(form.validFrom, form.validUntil));
  if (parseAttributes(form.attributes) === undefined) errors.attributes = 'invalidJson';
  return errors;
}

export interface EditForm {
  label: string;
  attributes: string;
  parentRecordId: string;
  effectiveFrom: string;
  validUntil: string;
  legalBasis: string;
  reason: string;
}

export type EditField = keyof EditForm;

export function validateEdit(form: EditForm, currentValidFrom: string | null): FormErrors<EditField> {
  const errors: FormErrors<EditField> = {};
  const set = (field: EditField, problem: FieldProblem | undefined): void => {
    if (problem !== undefined) errors[field] = problem;
  };
  set('label', checkText(form.label, LABEL_MAX_LENGTH, true));
  set('legalBasis', checkText(form.legalBasis, LEGAL_BASIS_MAX_LENGTH, false));
  set('reason', checkReason(form.reason));
  if (form.effectiveFrom === '') errors.effectiveFrom = 'required';
  else if (!isCalendarDate(form.effectiveFrom)) errors.effectiveFrom = 'invalidDate';
  else if (currentValidFrom !== null && form.effectiveFrom <= currentValidFrom) errors.effectiveFrom = 'order';
  if (form.validUntil !== '') {
    if (!isCalendarDate(form.validUntil)) errors.validUntil = 'invalidDate';
    else if (errors.effectiveFrom === undefined && form.validUntil <= form.effectiveFrom) errors.validUntil = 'order';
  }
  if (parseAttributes(form.attributes) === undefined) errors.attributes = 'invalidJson';
  return errors;
}

export interface RetireForm {
  effectiveFrom: string;
  successorRecordId: string;
  reason: string;
}

export type RetireField = keyof RetireForm;

/** A retirement needs a date after the start of the version in force, a reason, and a successor when the entry is in use or its type requires one. */
export function validateRetire(form: RetireForm, currentValidFrom: string | null, successorRequired: boolean): FormErrors<RetireField> {
  const errors: FormErrors<RetireField> = {};
  if (form.effectiveFrom === '') errors.effectiveFrom = 'required';
  else if (!isCalendarDate(form.effectiveFrom)) errors.effectiveFrom = 'invalidDate';
  else if (currentValidFrom !== null && form.effectiveFrom <= currentValidFrom) errors.effectiveFrom = 'order';
  const reason = checkReason(form.reason);
  if (reason !== undefined) errors.reason = reason;
  if (successorRequired && form.successorRecordId === '') errors.successorRecordId = 'required';
  return errors;
}

// ---- problems of the commands -----------------------------------------------------------------------------------------

export type ProblemReason =
  | 'duplicateKey'
  | 'policyLocked'
  | 'inUse'
  | 'overlap'
  | 'selfApproval'
  | 'versionConflict'
  | 'impactNotComputed'
  | 'notApproved'
  | 'stageDenied'
  | 'validation'
  | 'denied'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  DUPLICATE_KEY: 'duplicateKey',
  POLICY_LOCKED: 'policyLocked',
  MASTER_IN_USE: 'inUse',
  EFFECTIVE_RANGE_OVERLAP: 'overlap',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  IMPACT_NOT_COMPUTED: 'impactNotComputed',
  CHANGE_NOT_APPROVED: 'notApproved',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

/** Maps the error of a command of these screens to what they show; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

/**
 * The record that a link names: the type and the business key travel in the address, the id is looked up. The same type and key can
 * exist in both namespaces (identity includes the namespace), so a link to an entry of the platform says so; without `ns` it is the tenant's.
 */
export function recordLink(path: string, masterType: string, businessKey: string, namespace: Namespace = 'TENANT'): string {
  const params = new URLSearchParams({ type: masterType, key: businessKey });
  if (namespace === 'PLATFORM') params.set('ns', 'PLATFORM');
  return `${path}?${params.toString()}`;
}

/** The namespace an address names: the platform's only when it says so. */
export function namespaceOf(value: string | null): Namespace {
  return value === 'PLATFORM' ? 'PLATFORM' : 'TENANT';
}

export type ProposalField = 'label' | 'attributes' | 'parent' | 'validUntil' | 'legalBasis' | 'successor';

export interface ProposalRow {
  field: ProposalField;
  before: string | null;
  after: string;
}

const PROPOSAL_KEYS: ReadonlyArray<readonly [ProposalField, string]> = [
  ['label', 'label'],
  ['attributes', 'attributes'],
  ['parent', 'parent_record_id'],
  ['validUntil', 'valid_until'],
  ['legalBasis', 'legal_basis'],
  ['successor', 'successor_record_id'],
];

const shown = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(sortKeys(value)));

/** What a change request would change, field by field: the values of the version in force beside the ones it proposes (all of them for a new entry). */
export function proposalRows(before: Record<string, unknown> | null, proposed: Record<string, unknown>): ProposalRow[] {
  return PROPOSAL_KEYS.flatMap(([field, key]) => {
    // A field the proposal does not name stays as it is; one it names as null is cleared.
    if (before !== null && proposed[key] === undefined) return [];
    const after = shown(proposed[key]);
    const was = before === null ? null : shown(before[key]);
    if (before === null ? after === '' : was === after) return [];
    return [{ field, before: was, after }];
  });
}
