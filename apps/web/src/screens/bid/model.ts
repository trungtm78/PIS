import { ApiError } from '@machvon/api-client';

/** The permissions that gate the buttons of these screens; the server decides again on every request. */
export const READ_PERMISSION = 'contractor.read';
export const MANAGE_PERMISSION = 'bid.contractor.manage';
export const VERIFY_PERMISSION = 'bid.contractor.verify';

export const LIST_PATH = '/bid/bid-01';
export const PROFILE_PATH = '/bid/bid-02';
/** The screen of master data where a duplicate is merged (MDM-37): the registry never merges two contractors itself. */
export const MERGE_PATH = '/mdm/mdm-37';

export const VERIFICATION_STATUSES = ['UNVERIFIED', 'VERIFIED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_BASES = ['EVIDENCE_DOCUMENT', 'EVIDENCE_DOCUMENT_AND_LOOKUP'] as const;
export type VerificationBasis = (typeof VERIFICATION_BASES)[number];

export const ADAPTER_STATUSES = ['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING'] as const;
export type AdapterStatus = (typeof ADAPTER_STATUSES)[number];

export const LOOKUP_OUTCOMES = ['MATCH', 'NOT_FOUND', 'NAME_MISMATCH', 'UNAVAILABLE'] as const;
export type LookupOutcome = (typeof LOOKUP_OUTCOMES)[number];

export const RESTRICTION_KINDS = ['DEBARMENT', 'SUSPENSION', 'WARNING'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export const RESTRICTION_SOURCES = ['NATIONAL_E_PROCUREMENT_IMPORT', 'DECISION'] as const;
export type RestrictionSource = (typeof RESTRICTION_SOURCES)[number];

export const DECISIONS = ['VERIFIED', 'REJECTED'] as const;
export type Decision = (typeof DECISIONS)[number];

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 500;
export const FORM_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 1000;
const TAX_IDENTIFIER = /^\d{10}(-?\d{3})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <Value extends string>(list: readonly Value[], value: unknown): Value | undefined => list.find((candidate) => candidate === value);

export interface LookupView {
  adapterStatus: AdapterStatus;
  outcome: LookupOutcome;
  checkedAt: string;
}

export interface RestrictionView {
  id: string;
  kind: RestrictionKind;
  source: RestrictionSource | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  /** The decision and the note are for those who hold the full right to read; the others get neither. */
  decisionDocumentId: string | null;
  note: string | null;
}

/** One line of the registry (BID-01). */
export interface ContractorLine {
  id: string;
  taxIdentifier: string;
  taxIdentifierMasked: boolean;
  legalName: string;
  legalForm: string | null;
  verificationStatus: VerificationStatus;
  verificationBasis: VerificationBasis | null;
  lookup: LookupView | null;
  masterRecordId: string | null;
  contractCount: number;
  verifiedAt: string | null;
  restrictionInForce: RestrictionView | null;
  version: number;
}

/** The profile of one contractor (BID-02). */
export interface ContractorView extends ContractorLine {
  profileDocumentId: string | null;
  verifiedBy: string | null;
  verificationEvidenceDocumentId: string | null;
  restrictions: RestrictionView[];
}

function toLookup(raw: unknown): LookupView | null {
  const record = asRecord(raw);
  const adapterStatus = oneOf(ADAPTER_STATUSES, record?.adapter_status);
  const outcome = oneOf(LOOKUP_OUTCOMES, record?.outcome);
  const checkedAt = text(record?.checked_at);
  return adapterStatus === undefined || outcome === undefined || checkedAt === undefined ? null : { adapterStatus, outcome, checkedAt };
}

function toRestriction(raw: unknown): RestrictionView | undefined {
  const record = asRecord(raw);
  const id = text(record?.id);
  const kind = oneOf(RESTRICTION_KINDS, record?.kind);
  const effectiveFrom = text(record?.effective_from);
  if (record === undefined || id === undefined || kind === undefined || effectiveFrom === undefined) return undefined;
  return {
    id,
    kind,
    source: oneOf(RESTRICTION_SOURCES, record.source) ?? null,
    effectiveFrom,
    effectiveUntil: nullableText(record.effective_until),
    decisionDocumentId: nullableText(record.decision_document_id),
    note: nullableText(record.note),
  };
}

/** A line of the registry from a read; an answer that is not a contractor of the contract is dropped. */
export function toContractorLine(raw: unknown): ContractorLine | undefined {
  const record = asRecord(raw);
  const id = text(record?.id);
  const taxIdentifier = text(record?.tax_identifier);
  const legalName = text(record?.legal_name);
  const verificationStatus = oneOf(VERIFICATION_STATUSES, record?.verification_status);
  const version = whole(record?.version);
  if (record === undefined || id === undefined || taxIdentifier === undefined || legalName === undefined || verificationStatus === undefined || version === undefined) return undefined;
  return {
    id,
    taxIdentifier,
    taxIdentifierMasked: record.tax_identifier_masked === true,
    legalName,
    legalForm: nullableText(record.legal_form),
    verificationStatus,
    verificationBasis: oneOf(VERIFICATION_BASES, record.verification_basis) ?? null,
    lookup: toLookup(record.identity_lookup),
    masterRecordId: nullableText(record.master_record_id),
    contractCount: whole(record.contract_count) ?? 0,
    verifiedAt: nullableText(record.verified_at),
    restrictionInForce: toRestriction(record.restriction_in_force) ?? null,
    version,
  };
}

export function toContractorView(raw: unknown): ContractorView | undefined {
  const line = toContractorLine(raw);
  const record = asRecord(raw);
  if (line === undefined || record === undefined) return undefined;
  return {
    ...line,
    profileDocumentId: nullableText(record.profile_document_id),
    verifiedBy: nullableText(record.verified_by),
    verificationEvidenceDocumentId: nullableText(record.verification_evidence_document_id),
    restrictions: (Array.isArray(record.restrictions) ? record.restrictions : []).flatMap((item) => toRestriction(item) ?? []),
  };
}

export function profileLink(id: string): string {
  return `${PROFILE_PATH}?id=${id}`;
}

// ---- filtering --------------------------------------------------------------------------------------------------------

export interface ListFilter {
  query: string;
  status: VerificationStatus | '';
  restrictedOnly: boolean;
}

export const EMPTY_FILTER: ListFilter = { query: '', status: '', restrictedOnly: false };

/** The contractors that match the filter: text in the name or the tax id as it is shown, a status, and only those with a restriction in force. */
export function filterContractors(contractors: readonly ContractorLine[], filter: ListFilter): ContractorLine[] {
  const needle = filter.query.trim().toLowerCase();
  return contractors.filter(
    (contractor) =>
      (needle === '' || `${contractor.legalName} ${contractor.taxIdentifier}`.toLowerCase().includes(needle)) &&
      (filter.status === '' || contractor.verificationStatus === filter.status) &&
      (!filter.restrictedOnly || contractor.restrictionInForce !== null),
  );
}

// ---- forms ------------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidTaxId' | 'invalidId' | 'invalidDate' | 'order';
export type FormErrors<Field extends string> = Partial<Record<Field, FieldProblem>>;

export interface RegisterForm {
  taxIdentifier: string;
  legalName: string;
  legalForm: string;
  profileDocumentId: string;
}
export type RegisterField = keyof RegisterForm;
export const EMPTY_REGISTER_FORM: RegisterForm = { taxIdentifier: '', legalName: '', legalForm: '', profileDocumentId: '' };

function checkId(value: string): FieldProblem | undefined {
  if (value.trim() === '') return 'required';
  return UUID.test(value.trim()) ? undefined : 'invalidId';
}

function checkName(value: string, min: number, max: number): FieldProblem | undefined {
  const length = value.trim().length;
  if (length === 0) return 'required';
  if (length < min) return 'tooShort';
  return length > max ? 'tooLong' : undefined;
}

function checkDate(value: string): FieldProblem | undefined {
  if (value.trim() === '') return 'required';
  return DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? undefined : 'invalidDate';
}

function collect<Field extends string>(checks: ReadonlyArray<readonly [Field, FieldProblem | undefined]>): FormErrors<Field> {
  const errors: FormErrors<Field> = {};
  for (const [field, problem] of checks) if (problem !== undefined) errors[field] = problem;
  return errors;
}

export function validateRegister(form: RegisterForm): FormErrors<RegisterField> {
  const taxIdentifier = form.taxIdentifier.replace(/\s+/g, '');
  return collect<RegisterField>([
    ['taxIdentifier', taxIdentifier === '' ? 'required' : TAX_IDENTIFIER.test(taxIdentifier) ? undefined : 'invalidTaxId'],
    ['legalName', checkName(form.legalName, NAME_MIN_LENGTH, NAME_MAX_LENGTH)],
    ['legalForm', form.legalForm.trim().length > FORM_MAX_LENGTH ? 'tooLong' : undefined],
    ['profileDocumentId', checkId(form.profileDocumentId)],
  ]);
}

/** The body of registerContractor: the allowlist of the contract, with the optional form left out when it is empty. */
export function registerBody(form: RegisterForm): { tax_identifier: string; legal_name: string; legal_form?: string; profile_document_id: string } {
  const legalForm = form.legalForm.trim();
  return {
    tax_identifier: form.taxIdentifier.replace(/\s+/g, ''),
    legal_name: form.legalName.trim(),
    ...(legalForm === '' ? {} : { legal_form: legalForm }),
    profile_document_id: form.profileDocumentId.trim(),
  };
}

export interface VerifyForm {
  decision: Decision;
  evidenceDocumentId: string;
}
export type VerifyField = 'evidenceDocumentId';
export const EMPTY_VERIFY_FORM: VerifyForm = { decision: 'VERIFIED', evidenceDocumentId: '' };

export function validateVerify(form: VerifyForm): FormErrors<VerifyField> {
  return collect<VerifyField>([['evidenceDocumentId', checkId(form.evidenceDocumentId)]]);
}

export interface RestrictionForm {
  kind: RestrictionKind;
  effectiveFrom: string;
  effectiveUntil: string;
  decisionDocumentId: string;
  note: string;
}
export type RestrictionField = Exclude<keyof RestrictionForm, 'kind'>;
export const EMPTY_RESTRICTION_FORM: RestrictionForm = { kind: 'DEBARMENT', effectiveFrom: '', effectiveUntil: '', decisionDocumentId: '', note: '' };

export function validateRestriction(form: RestrictionForm): FormErrors<RestrictionField> {
  const until = form.effectiveUntil.trim();
  const untilProblem = until === '' ? undefined : (checkDate(until) ?? (checkDate(form.effectiveFrom) === undefined && until < form.effectiveFrom ? 'order' : undefined));
  return collect<RestrictionField>([
    ['effectiveFrom', checkDate(form.effectiveFrom)],
    ['effectiveUntil', untilProblem],
    ['decisionDocumentId', checkId(form.decisionDocumentId)],
    ['note', form.note.trim().length > NOTE_MAX_LENGTH ? 'tooLong' : undefined],
  ]);
}

export function restrictionBody(form: RestrictionForm): { kind: RestrictionKind; effective_from: string; effective_until?: string; decision_document_id: string; note?: string } {
  const until = form.effectiveUntil.trim();
  const note = form.note.trim();
  return {
    kind: form.kind,
    effective_from: form.effectiveFrom,
    ...(until === '' ? {} : { effective_until: until }),
    decision_document_id: form.decisionDocumentId.trim(),
    ...(note === '' ? {} : { note }),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'taxIdInvalid'
  | 'alreadyVerified'
  | 'duplicateVerified'
  | 'selfApproval'
  | 'versionConflict'
  | 'stageDenied'
  | 'decisionNotEffective'
  | 'adapterContradicts'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  TAX_ID_INVALID: 'taxIdInvalid',
  CONTRACTOR_ALREADY_VERIFIED: 'alreadyVerified',
  TAX_ID_DUPLICATE_VERIFIED: 'duplicateVerified',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  DECISION_DOCUMENT_NOT_EFFECTIVE: 'decisionNotEffective',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** The verified contractor that holds the tax id, when the refusal names it (the duplicate goes to the merge in master data). */
  verifiedContractorId?: string | undefined;
}

/** The contractor the refusal names as the one already verified with the tax id. */
function verifiedHolderOf(error: ApiError): string | undefined {
  const suggestion = asRecord(error.extensions.merge_suggestion);
  return text(suggestion?.verified_contractor_id) ?? text(error.extensions.existing_contractor_id);
}

/**
 * Maps the error of a command of these screens to what they show; an unknown failure is the general message. A tax id the official register
 * contradicts is the same code as one that is not well formed, told apart by the screen that asked (a verification, not a registration).
 */
export function describeProblem(error: unknown, asking: 'register' | 'verify' | 'restrict' = 'register'): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  const reason = REASON_BY_CODE[error.code] ?? 'general';
  const verifiedContractorId = verifiedHolderOf(error);
  return {
    reason: reason === 'taxIdInvalid' && asking === 'verify' ? 'adapterContradicts' : reason,
    field: error.detail,
    ...(verifiedContractorId === undefined ? {} : { verifiedContractorId }),
  };
}
