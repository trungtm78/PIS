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
export type ChangeKind = 'CREATE' | 'UPDATE' | 'RETIRE' | 'SUCCESSION';

const RECORD_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'EFFECTIVE', 'RETIRED', 'MERGED'];
const CHANGE_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'APPLIED', 'CANCELLED'];
const CHANGE_KINDS: readonly string[] = ['CREATE', 'UPDATE', 'RETIRE', 'SUCCESSION'];

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
  /** What the tenant set on an entry of the platform through its alias (ST-MDM-002): a label to show and a place in the order. */
  aliasLabel: string | null;
  aliasOrder: number | null;
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

export const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
export const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
export const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

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
    aliasLabel: nullableText(row.alias_label),
    aliasOrder: whole(row.alias_order) ?? null,
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

export type FieldProblem = 'required' | 'tooLong' | 'tooShort' | 'invalidDate' | 'order' | 'invalidJson' | 'invalidCode' | 'invalidId' | 'definitionTooShort';

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
  | 'importHasErrors'
  | 'importEmpty'
  | 'alreadyApplied'
  | 'fileRefused'
  | 'duplicateCrosswalk'
  | 'duplicateTerm'
  | 'notOwner'
  | 'notFound'
  | 'successionCycle'
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
  IMPORT_HAS_ERRORS: 'importHasErrors',
  IMPORT_EMPTY: 'importEmpty',
  IMPORT_FILE_ALREADY_APPLIED: 'alreadyApplied',
  FILE_TYPE_NOT_ALLOWED: 'fileRefused',
  FILE_NOT_CLEAN: 'fileRefused',
  PAYLOAD_TOO_LARGE: 'fileRefused',
  SCAN_PENDING: 'fileRefused',
  CROSSWALK_DUPLICATE: 'duplicateCrosswalk',
  GLOSSARY_TERM_DUPLICATE: 'duplicateTerm',
  RESOURCE_NOT_FOUND: 'notFound',
  SUCCESSION_CYCLE: 'successionCycle',
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

// ---- bulk import (MDM-29) ----------------------------------------------------------------------------------------------------

export const IMPORT_PERMISSION = 'master.import';
export type ImportMode = 'ATOMIC' | 'PARTIAL';
export type ImportStatus = 'STAGED' | 'VALIDATED' | 'IN_REVIEW' | 'APPLIED' | 'FAILED' | 'CANCELLED';
const IMPORT_STATUSES: readonly string[] = ['STAGED', 'VALIDATED', 'IN_REVIEW', 'APPLIED', 'FAILED', 'CANCELLED'];

/** The file that was uploaded and read: where it is kept, its hash, and what the mapping step can choose from. */
export interface ImportFileView {
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  format: 'CSV' | 'XLSX';
  columns: string[];
  rowCount: number;
}

export interface RowErrorView {
  row: number;
  field: string;
  code: string;
}

export interface ImportBatchView {
  id: string;
  masterType: string;
  fileSha256: string;
  mode: ImportMode;
  status: ImportStatus;
  totalRows: number;
  errorRows: number;
  errors: RowErrorView[];
  appliedAt: string | null;
  /** Who applied the batch (null until it is applied): the person who may neither review nor publish it. */
  appliedBy: string | null;
  reviewedBy: string | null;
  createdBy: string;
  version: number;
  /** The change requests of the batch by status (only the read of one batch carries them). */
  changes: Record<string, number>;
}

export function toImportFile(raw: unknown): ImportFileView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const key = text(row.file_object_key);
  const sha = text(row.file_sha256);
  const size = whole(row.size_bytes);
  const rows = whole(row.row_count);
  const format = row.format === 'XLSX' ? 'XLSX' : row.format === 'CSV' ? 'CSV' : undefined;
  if (key === undefined || sha === undefined || size === undefined || rows === undefined || format === undefined || !Array.isArray(row.columns)) return undefined;
  return { fileObjectKey: key, fileSha256: sha, sizeBytes: size, format, columns: row.columns.filter((column): column is string => typeof column === 'string'), rowCount: rows };
}

export function toImportBatch(raw: unknown): ImportBatchView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const masterType = text(row.master_type);
  const sha = text(row.file_sha256);
  const status = text(row.status);
  const totalRows = whole(row.total_rows);
  const errorRows = whole(row.error_rows);
  const version = whole(row.version);
  const createdBy = text(row.created_by);
  if (id === undefined || masterType === undefined || sha === undefined || status === undefined || !IMPORT_STATUSES.includes(status) || totalRows === undefined || errorRows === undefined || version === undefined || createdBy === undefined) {
    return undefined;
  }
  const errors = Array.isArray(row.errors)
    ? row.errors.flatMap((item): RowErrorView[] => {
        const error = asRecord(item);
        const line = whole(error?.row);
        const field = text(error?.field);
        const code = text(error?.code);
        return line === undefined || field === undefined || code === undefined ? [] : [{ row: line, field, code }];
      })
    : [];
  const changes = Object.fromEntries(Object.entries(asRecord(row.changes) ?? {}).flatMap(([name, count]) => (whole(count) === undefined ? [] : [[name, count as number]])));
  return {
    id,
    masterType,
    fileSha256: sha,
    mode: row.mode === 'PARTIAL' ? 'PARTIAL' : 'ATOMIC',
    status: status as ImportStatus,
    totalRows,
    errorRows,
    errors,
    appliedAt: nullableText(row.applied_at),
    appliedBy: nullableText(row.applied_by),
    reviewedBy: nullableText(row.reviewed_by),
    createdBy,
    version,
    changes,
  };
}

/** The columns of the file named for each part of an entry (an empty text: not used). */
export interface ImportMappingForm {
  key: string;
  label: string;
  valid_from: string;
  parent_key: string;
  valid_until: string;
  legal_basis: string;
  /** Attribute name → column. */
  attributes: Record<string, string>;
  /** The system and the code type that translate the columns that hold codes of another system (both, or none). */
  crosswalk_system: string;
  crosswalk_type: string;
  /** The columns that hold such codes: `parent_key` and `attributes.<name>`. */
  crosswalk_fields: string[];
}

export const EMPTY_MAPPING: ImportMappingForm = { key: '', label: '', valid_from: '', parent_key: '', valid_until: '', legal_basis: '', attributes: {}, crosswalk_system: '', crosswalk_type: '', crosswalk_fields: [] };

/** A name as a person writes it in a header, compared without case, accents or spacing. */
const plainName = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const MAPPING_ALIASES: Readonly<Record<'key' | 'label' | 'valid_from' | 'valid_until' | 'parent_key' | 'legal_basis', readonly string[]>> = {
  key: ['code', 'key', 'ma', 'business key', 'business_key', 'ma danh muc'],
  label: ['name', 'label', 'ten', 'ten danh muc'],
  valid_from: ['valid from', 'effective from', 'start', 'tu ngay', 'hieu luc tu'],
  valid_until: ['valid until', 'effective until', 'end', 'den ngay', 'hieu luc den'],
  parent_key: ['parent', 'parent key', 'ma cha', 'cap cha'],
  legal_basis: ['legal basis', 'basis', 'can cu', 'can cu phap ly'],
};

/** A first guess of the mapping from the headers of the file: the names that are usually used, and the names of the attributes of the type. */
export function suggestMapping(headers: readonly string[], attributeNames: readonly string[]): ImportMappingForm {
  const plain = headers.map((header) => [header, plainName(header)] as const);
  const find = (names: readonly string[]): string => plain.find(([, name]) => names.includes(name))?.[0] ?? '';
  const mapping: ImportMappingForm = { ...EMPTY_MAPPING, attributes: {}, crosswalk_fields: [] };
  for (const field of Object.keys(MAPPING_ALIASES) as Array<keyof typeof MAPPING_ALIASES>) mapping[field] = find(MAPPING_ALIASES[field]);
  for (const name of attributeNames) {
    const column = find([plainName(name)]);
    if (column !== '') mapping.attributes[name] = column;
  }
  return mapping;
}

/** The mapping as the request carries it: the parts that are not used are left out. */
export function mappingBody(form: ImportMappingForm): Record<string, unknown> {
  const body: Record<string, unknown> = { key: form.key, label: form.label, valid_from: form.valid_from };
  for (const field of ['parent_key', 'valid_until', 'legal_basis'] as const) if (form[field] !== '') body[field] = form[field];
  const attributes = Object.fromEntries(Object.entries(form.attributes).filter(([, column]) => column !== ''));
  if (Object.keys(attributes).length > 0) body.attributes = attributes;
  // A column can only be translated when it is mapped; the system and the code type go together.
  const fields = form.crosswalk_fields.filter((field) => (field === 'parent_key' ? form.parent_key !== '' : attributes[field.slice('attributes.'.length)] !== undefined));
  if (form.crosswalk_system.trim() !== '' && form.crosswalk_type.trim() !== '' && fields.length > 0) {
    body.crosswalk = { source_system: form.crosswalk_system.trim(), external_type: form.crosswalk_type.trim(), fields };
  }
  return body;
}

export const mappingComplete = (form: ImportMappingForm): boolean => form.key !== '' && form.label !== '' && form.valid_from !== '';

// ---- crosswalk and integration cursors (MDM-16, MDM-24) --------------------------------------------------------------------

export const MASTER_READ_PERMISSION = 'master.read';
export const CROSSWALK_PERMISSION = 'master.crosswalk.manage';
export const CURSOR_READ_PERMISSION = 'integration_cursor.read';
export const CURSOR_RESET_PERMISSION = 'integration.cursor.reset';
export const CURSOR_REASON_MIN_LENGTH = 10;
export const CROSSWALK_NAME_MAX_LENGTH = 50;
export const CROSSWALK_CODE_MAX_LENGTH = 100;

export type CrosswalkStatus = 'ACTIVE' | 'RETIRED';
export type CrosswalkMethod = 'MANUAL' | 'IMPORT' | 'RULE';
export type AdapterStatus = 'VERIFIED' | 'PROPOSED' | 'MOCK' | 'MISSING';
export type CursorStatus = 'ACTIVE' | 'PAUSED' | 'FAILED';

const CROSSWALK_STATUSES: readonly string[] = ['ACTIVE', 'RETIRED'];
const CROSSWALK_METHODS: readonly string[] = ['MANUAL', 'IMPORT', 'RULE'];
const ADAPTER_STATUSES: readonly string[] = ['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING'];
const CURSOR_STATUSES: readonly string[] = ['ACTIVE', 'PAUSED', 'FAILED'];
export const CROSSWALK_METHOD_LIST: readonly CrosswalkMethod[] = ['MANUAL', 'IMPORT', 'RULE'];

export interface CrosswalkView {
  id: string;
  masterRecordId: string;
  masterType: string;
  businessKey: string;
  sourceSystem: string;
  externalType: string;
  externalCode: string;
  validFrom: string;
  validUntil: string | null;
  matchMethod: CrosswalkMethod;
  confidence: number | null;
  status: CrosswalkStatus;
  version: number;
}

export function toCrosswalk(raw: unknown): CrosswalkView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const masterRecordId = text(row.master_record_id);
  const masterType = text(row.master_type);
  const businessKey = text(row.business_key);
  const sourceSystem = text(row.source_system);
  const externalType = text(row.external_type);
  const externalCode = text(row.external_code);
  const validFrom = text(row.valid_from);
  const method = text(row.match_method);
  const status = text(row.status);
  const version = whole(row.version);
  if (
    id === undefined || masterRecordId === undefined || masterType === undefined || businessKey === undefined || sourceSystem === undefined || externalType === undefined || externalCode === undefined ||
    validFrom === undefined || method === undefined || !CROSSWALK_METHODS.includes(method) || status === undefined || !CROSSWALK_STATUSES.includes(status) || version === undefined
  ) {
    return undefined;
  }
  return {
    id,
    masterRecordId,
    masterType,
    businessKey,
    sourceSystem,
    externalType,
    externalCode,
    validFrom,
    validUntil: nullableText(row.valid_until),
    matchMethod: method as CrosswalkMethod,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    status: status as CrosswalkStatus,
    version,
  };
}

export interface CursorView {
  id: string;
  connectorCode: string;
  sourceScope: string;
  adapterStatus: AdapterStatus;
  status: CursorStatus;
  lastSuccessAt: string | null;
  lastFileSha256: string | null;
  lastErrorCode: string | null;
  resetReason: string | null;
  version: number;
  /** The position itself: only the read of one connector carries it. */
  position: Record<string, unknown> | null;
}

export function toCursor(raw: unknown): CursorView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const connectorCode = text(row.connector_code);
  const sourceScope = text(row.source_scope);
  const adapter = text(row.adapter_status);
  const status = text(row.status);
  const version = whole(row.version);
  if (id === undefined || connectorCode === undefined || sourceScope === undefined || adapter === undefined || !ADAPTER_STATUSES.includes(adapter) || status === undefined || !CURSOR_STATUSES.includes(status) || version === undefined) {
    return undefined;
  }
  return {
    id,
    connectorCode,
    sourceScope,
    adapterStatus: adapter as AdapterStatus,
    status: status as CursorStatus,
    lastSuccessAt: nullableText(row.last_success_at),
    lastFileSha256: nullableText(row.last_file_sha256),
    lastErrorCode: nullableText(row.last_error_code),
    resetReason: nullableText(row.reset_reason),
    version,
    position: asRecord(row.cursor_json) ?? null,
  };
}

export interface CrosswalkForm {
  masterType: string;
  businessKey: string;
  sourceSystem: string;
  externalType: string;
  externalCode: string;
  validFrom: string;
  matchMethod: CrosswalkMethod;
}

export const EMPTY_CROSSWALK_FORM: CrosswalkForm = { masterType: '', businessKey: '', sourceSystem: '', externalType: '', externalCode: '', validFrom: '', matchMethod: 'MANUAL' };
export type CrosswalkField = keyof CrosswalkForm;

export function validateCrosswalk(form: CrosswalkForm): FormErrors<CrosswalkField> {
  const errors: FormErrors<CrosswalkField> = {};
  const required = (field: CrosswalkField, value: string, max: number): void => {
    const problem = checkText(value.trim(), max, true);
    if (problem !== undefined) errors[field] = problem;
  };
  required('masterType', form.masterType, TYPE_MAX_LENGTH);
  required('businessKey', form.businessKey, KEY_MAX_LENGTH);
  required('sourceSystem', form.sourceSystem, CROSSWALK_NAME_MAX_LENGTH);
  required('externalType', form.externalType, CROSSWALK_NAME_MAX_LENGTH);
  required('externalCode', form.externalCode, CROSSWALK_CODE_MAX_LENGTH);
  if (form.validFrom === '') errors.validFrom = 'required';
  else if (!isCalendarDate(form.validFrom)) errors.validFrom = 'invalidDate';
  return errors;
}

export interface CursorResetForm {
  reason: string;
  position: string;
}

export type CursorResetField = keyof CursorResetForm;

/** The position of a reset is a JSON object, as the connector keeps it. */
export function validateCursorReset(form: CursorResetForm): FormErrors<CursorResetField> {
  const errors: FormErrors<CursorResetField> = {};
  const reason = form.reason.trim();
  if (reason === '') errors.reason = 'required';
  else if (reason.length < CURSOR_REASON_MIN_LENGTH) errors.reason = 'tooShort';
  else if (reason.length > REASON_MAX_LENGTH) errors.reason = 'tooLong';
  if (parseAttributes(form.position) === undefined) errors.position = 'invalidJson';
  return errors;
}

/** The reason for ending a mapping: as long as the reason of any other change of master data. */
export const validateRetireReason = (value: string): FieldProblem | undefined => checkReason(value);

// ---- glossary of business terms (MDM-34) -------------------------------------------------------------------------------------

export const GLOSSARY_READ_PERMISSION = 'glossary.read';
export const GLOSSARY_PROPOSE_PERMISSION = 'glossary.propose';
export const GLOSSARY_APPROVE_PERMISSION = 'glossary.approve';
export const DISBURSEMENT_DOMAIN = 'DISBURSEMENT';
/** The terms the disbursement figures stand on (DIS BR-DIS-03, 05, 06, 12): the definitions are signed (D03) when every one has a published revision. */
export const DISBURSEMENT_REQUIRED_TERMS: readonly string[] = ['GIAI_NGAN_PERIOD', 'GIAI_NGAN_YTD', 'GIAI_NGAN_PTD', 'MAU_SO_KH_TTG_GIAO', 'MAU_SO_KH_TONG'];

export const GLOSSARY_CODE_MAX_LENGTH = 80;
export const GLOSSARY_DOMAIN_MAX_LENGTH = 50;
export const GLOSSARY_TERM_MAX_LENGTH = 300;
export const GLOSSARY_DEFINITION_MIN_LENGTH = 20;
export const GLOSSARY_DEFINITION_MAX_LENGTH = 2000;
export const GLOSSARY_FORMULA_MAX_LENGTH = 120;
const GLOSSARY_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MEMBERSHIP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GlossaryStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'PUBLISHED' | 'DEPRECATED' | 'REJECTED';
export const GLOSSARY_STATUS_LIST: readonly GlossaryStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'DEPRECATED', 'REJECTED'];

export interface GlossaryTermView {
  id: string;
  termCode: string;
  termVi: string;
  definition: string;
  formulaRef: string | null;
  domain: string;
  ownerMembershipId: string;
  legalBasis: string | null;
  revision: number;
  status: GlossaryStatus;
  effectiveFrom: string | null;
  supersedesId: string | null;
  createdBy: string;
  decisionReason: string | null;
  version: number;
}

export function toGlossaryTerm(raw: unknown): GlossaryTermView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const termCode = text(row.term_code);
  const termVi = text(row.term_vi);
  const definition = text(row.definition);
  const domain = text(row.domain);
  const owner = text(row.owner_membership_id);
  const revision = whole(row.revision);
  const status = text(row.status);
  const createdBy = text(row.created_by);
  const version = whole(row.version);
  if (
    id === undefined || termCode === undefined || termVi === undefined || definition === undefined || domain === undefined || owner === undefined || revision === undefined ||
    status === undefined || !GLOSSARY_STATUS_LIST.includes(status as GlossaryStatus) || createdBy === undefined || version === undefined
  ) {
    return undefined;
  }
  return {
    id,
    termCode,
    termVi,
    definition,
    formulaRef: nullableText(row.formula_ref),
    domain,
    ownerMembershipId: owner,
    legalBasis: nullableText(row.legal_basis),
    revision,
    status: status as GlossaryStatus,
    effectiveFrom: nullableText(row.effective_from),
    supersedesId: nullableText(row.supersedes_id),
    createdBy,
    decisionReason: nullableText(row.decision_reason),
    version,
  };
}

/** Whether the definitions of a domain are signed: the domain has required terms and every one of them has a PUBLISHED revision. */
export interface DefinitionState {
  signed: boolean;
  /** The required terms that have no PUBLISHED revision. */
  missing: string[];
}

/** Only the disbursement domain has a sign-off (D03); any other domain has nothing to sign. */
export function definitionState(terms: readonly GlossaryTermView[], domain: string): DefinitionState | undefined {
  if (domain !== DISBURSEMENT_DOMAIN) return undefined;
  const published = new Set(terms.filter((term) => term.domain === domain && term.status === 'PUBLISHED').map((term) => term.termCode));
  const missing = DISBURSEMENT_REQUIRED_TERMS.filter((code) => !published.has(code));
  return { signed: missing.length === 0, missing };
}

export interface GlossaryForm {
  termCode: string;
  termVi: string;
  definition: string;
  formulaRef: string;
  domain: string;
  ownerMembershipId: string;
  legalBasis: string;
}

export const EMPTY_GLOSSARY_FORM: GlossaryForm = { termCode: '', termVi: '', definition: '', formulaRef: '', domain: '', ownerMembershipId: '', legalBasis: '' };
export type GlossaryField = keyof GlossaryForm;

/** The form of the next revision of a published term: its words as they stand, to be changed; the code and the domain stay (the server holds them). */
export function reviseForm(term: GlossaryTermView): GlossaryForm {
  return {
    termCode: term.termCode,
    termVi: term.termVi,
    definition: term.definition,
    formulaRef: term.formulaRef ?? '',
    domain: term.domain,
    ownerMembershipId: term.ownerMembershipId,
    legalBasis: term.legalBasis ?? '',
  };
}

export function validateGlossary(form: GlossaryForm): FormErrors<GlossaryField> {
  const errors: FormErrors<GlossaryField> = {};
  const code = (field: 'termCode' | 'domain', value: string, max: number): void => {
    const trimmed = value.trim();
    if (trimmed === '') errors[field] = 'required';
    else if (trimmed.length > max) errors[field] = 'tooLong';
    else if (!GLOSSARY_CODE_PATTERN.test(trimmed)) errors[field] = 'invalidCode';
  };
  const optional = (field: GlossaryField, value: string, max: number): void => {
    const problem = checkText(value, max, false);
    if (problem !== undefined) errors[field] = problem;
  };
  code('termCode', form.termCode, GLOSSARY_CODE_MAX_LENGTH);
  code('domain', form.domain, GLOSSARY_DOMAIN_MAX_LENGTH);
  const term = checkText(form.termVi, GLOSSARY_TERM_MAX_LENGTH, true);
  if (term !== undefined) errors.termVi = term;
  const definition = form.definition.trim();
  if (definition === '') errors.definition = 'required';
  else if (definition.length < GLOSSARY_DEFINITION_MIN_LENGTH) errors.definition = 'definitionTooShort';
  else if (definition.length > GLOSSARY_DEFINITION_MAX_LENGTH) errors.definition = 'tooLong';
  optional('formulaRef', form.formulaRef, GLOSSARY_FORMULA_MAX_LENGTH);
  optional('legalBasis', form.legalBasis, LEGAL_BASIS_MAX_LENGTH);
  const owner = form.ownerMembershipId.trim();
  if (owner === '') errors.ownerMembershipId = 'required';
  else if (!MEMBERSHIP_ID_PATTERN.test(owner)) errors.ownerMembershipId = 'invalidId';
  return errors;
}

/** The reason of a decision on a term: as long as the reason of any other decision of master data. */
export const validateDecisionReason = (value: string): FieldProblem | undefined => checkReason(value);

/**
 * What a command on a term refuses with. A person who holds the permission to decide but is not the owner named on the term is refused with
 * SCOPE_DENIED; on this screen that is a sentence of its own (the owner of the term decides it), not the general lack of permission.
 */
export function describeGlossaryProblem(error: unknown): ProblemView {
  if (error instanceof ApiError && error.code === 'SCOPE_DENIED') return { reason: 'notOwner', field: undefined };
  return describeProblem(error);
}

/** The reserved system of the alias a tenant sets on an entry of the platform: a label to show (LABEL) or a place in the order (ORDER). */
export const TENANT_ALIAS_SYSTEM = 'TENANT_ALIAS';
