import { ApiError } from '@machvon/api-client';
import { isDay, isUuid } from '../model';

/** LND-03: the households affected by a land recovery, their personal data masked and the one reading that opens it (ST-LND-002, LND 3.5, BR-LND-07, BR-LND-09). */
export const HOUSEHOLDS_PATH = '/lnd/lnd-03';

/** The permissions that gate the buttons of this screen; the server decides again on every request (the unit of the household included). */
export const WRITE_PERMISSION = 'land.household.write';
export const REVEAL_PERMISSION = 'lnd.pii.read';

export const LEGAL_BASES = ['PUBLIC_TASK_LAND_LAW', 'LEGAL_OBLIGATION', 'CONSENT'] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];

export const RIGHT_KINDS = ['OWNER', 'USER', 'LESSEE', 'OCCUPANT_NO_TITLE'] as const;
export type RightKind = (typeof RIGHT_KINDS)[number];

export const HOUSEHOLD_STATUSES = ['REGISTERED', 'INVENTORIED', 'PLAN_LISTED', 'COMPENSATED', 'RESETTLED', 'CLOSED', 'DISPUTED'] as const;
export type HouseholdStatus = (typeof HOUSEHOLD_STATUSES)[number];

export const TEXT_MAX_LENGTH = 2000;
export const MEMBER_MAX = 1000;
const NATIONAL_ID = /^(\d{9}|\d{12})$/;
const PHONE = /^\d{9,11}$/;
const SHARE = /^(\d{1,3})(\.\d{1,4})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** A parcel a household holds a right on. */
export interface HouseholdParcel {
  id: string;
  parcelId: string;
  parcelCode: string;
  rightKind: RightKind;
  sharePct: string;
}

/** One line of the households of a project: the personal data in its masked forms only, the sealed data not at all. */
export interface HouseholdLine {
  id: string;
  projectId: string;
  ownerUnitId: string;
  householdCode: string;
  headNameMasked: string;
  nationalIdMasked: string | null;
  phoneMasked: string | null;
  addressMasked: string | null;
  memberCount: number | null;
  policyBeneficiary: boolean;
  legalBasis: LegalBasis;
  legalBasisRef: string;
  consentRecordId: string | null;
  retentionUntil: string;
  dsrOpen: boolean;
  status: HouseholdStatus;
  parcels: HouseholdParcel[];
  version: number;
}

function toParcel(raw: unknown): HouseholdParcel[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const parcelId = text(row?.parcel_id);
  const parcelCode = text(row?.parcel_code);
  const rightKind = oneOf(RIGHT_KINDS, row?.right_kind);
  const share = text(row?.share_pct);
  return row === undefined || id === undefined || parcelId === undefined || parcelCode === undefined || rightKind === undefined || share === undefined ? [] : [{ id, parcelId, parcelCode, rightKind, sharePct: share }];
}

/** A line of the list; a row the screen cannot read is dropped rather than shown half. */
export function toHouseholdLine(raw: unknown): HouseholdLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const projectId = text(row?.project_id);
  const ownerUnitId = text(row?.owner_unit_id);
  const code = text(row?.household_code);
  const headName = text(row?.head_name_masked);
  const legalBasis = oneOf(LEGAL_BASES, row?.legal_basis);
  const legalBasisRef = text(row?.legal_basis_ref);
  const retention = text(row?.retention_until);
  const status = oneOf(HOUSEHOLD_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || projectId === undefined || ownerUnitId === undefined || code === undefined || headName === undefined) return undefined;
  if (legalBasis === undefined || legalBasisRef === undefined || retention === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    projectId,
    ownerUnitId,
    householdCode: code,
    headNameMasked: headName,
    nationalIdMasked: nullableText(row.national_id_masked),
    phoneMasked: nullableText(row.phone_masked),
    addressMasked: nullableText(row.address_masked),
    memberCount: whole(row.member_count) ?? null,
    policyBeneficiary: row.policy_beneficiary === true,
    legalBasis,
    legalBasisRef,
    consentRecordId: nullableText(row.consent_record_id),
    retentionUntil: retention,
    dsrOpen: row.dsr_open === true,
    status,
    parcels: Array.isArray(row.parcels) ? row.parcels.flatMap(toParcel) : [],
    version,
  };
}

/** The personal data of one household in the clear, as the one reading answers it; it is kept in the dialog that asked for it and nowhere else. */
export interface HouseholdIdentity {
  householdCode: string;
  headName: string;
  nationalId: string | null;
  phone: string | null;
  addressText: string | null;
}

export function toIdentity(raw: unknown): HouseholdIdentity | undefined {
  const row = asRecord(raw);
  const code = text(row?.household_code);
  const headName = text(row?.head_name);
  return row === undefined || code === undefined || headName === undefined
    ? undefined
    : { householdCode: code, headName, nationalId: nullableText(row.national_id), phone: nullableText(row.phone), addressText: nullableText(row.address_text) };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

export const canWrite = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(WRITE_PERMISSION)) && mode !== 'READ_ONLY';
export const canReveal = (permissions: readonly string[] | undefined): boolean => permissions === undefined || permissions.includes(REVEAL_PERMISSION);

export interface HouseholdFilter {
  query: string;
  status: '' | HouseholdStatus;
}

export const EMPTY_FILTER: HouseholdFilter = { query: '', status: '' };

/** The households that match the filter: the query is looked for in the code, the masked name and the masked address, ignoring capitals; the list keeps the order of the read. */
export function filterHouseholds(households: readonly HouseholdLine[], filter: HouseholdFilter): HouseholdLine[] {
  const query = filter.query.trim().toLowerCase();
  return households.filter(
    (household) =>
      (filter.status === '' || household.status === filter.status) &&
      (query === '' || [household.householdCode, household.headNameMasked, household.addressMasked ?? ''].some((value) => value.toLowerCase().includes(query))),
  );
}

export type FormProblem = 'required' | 'tooLong' | 'invalid' | 'past';

export interface RegisterForm {
  ownerUnitId: string;
  headName: string;
  nationalId: string;
  phone: string;
  addressText: string;
  memberCount: string;
  policyBeneficiary: boolean;
  legalBasis: '' | LegalBasis;
  legalBasisRef: string;
  consentRecordId: string;
  retentionUntil: string;
}

export const EMPTY_REGISTER_FORM: RegisterForm = {
  ownerUnitId: '',
  headName: '',
  nationalId: '',
  phone: '',
  addressText: '',
  memberCount: '',
  policyBeneficiary: false,
  legalBasis: '',
  legalBasisRef: '',
  consentRecordId: '',
  retentionUntil: '',
};

const digitsOf = (value: string): string => value.replace(/[\s-]/g, '');
const phoneOf = (value: string): string => {
  const compact = value.replace(/[\s.()-]/g, '');
  return compact.startsWith('+84') ? `0${compact.slice(3)}` : compact;
};

/** What is wrong with the form before anything is sent; the server judges the same rules again, and the unit of the caller. */
export function validateRegister(form: RegisterForm, today: string): Partial<Record<keyof RegisterForm, FormProblem>> {
  const problems: Partial<Record<keyof RegisterForm, FormProblem>> = {};
  if (form.ownerUnitId === '') problems.ownerUnitId = 'required';
  const name = form.headName.trim();
  if (name === '') problems.headName = 'required';
  else if (name.length > TEXT_MAX_LENGTH) problems.headName = 'tooLong';
  else if (CONTROL.test(name)) problems.headName = 'invalid';
  if (form.nationalId.trim() !== '' && !NATIONAL_ID.test(digitsOf(form.nationalId.trim()))) problems.nationalId = 'invalid';
  if (form.phone.trim() !== '' && !PHONE.test(phoneOf(form.phone.trim()))) problems.phone = 'invalid';
  const address = form.addressText.trim();
  if (address.length > TEXT_MAX_LENGTH) problems.addressText = 'tooLong';
  else if (CONTROL.test(address)) problems.addressText = 'invalid';
  const members = form.memberCount.trim();
  if (members !== '' && !(/^\d{1,4}$/.test(members) && Number(members) >= 1 && Number(members) <= MEMBER_MAX)) problems.memberCount = 'invalid';
  if (form.legalBasis === '') problems.legalBasis = 'required';
  const reference = form.legalBasisRef.trim();
  if (reference === '') problems.legalBasisRef = 'required';
  else if (reference.length > TEXT_MAX_LENGTH) problems.legalBasisRef = 'tooLong';
  else if (CONTROL.test(reference)) problems.legalBasisRef = 'invalid';
  const consent = form.consentRecordId.trim();
  if (form.legalBasis === 'CONSENT' && consent === '') problems.consentRecordId = 'required';
  else if (consent !== '' && !isUuid(consent)) problems.consentRecordId = 'invalid';
  const until = form.retentionUntil.trim();
  if (until === '') problems.retentionUntil = 'required';
  else if (!isDay(until)) problems.retentionUntil = 'invalid';
  else if (until < today) problems.retentionUntil = 'past';
  return problems;
}

export interface RegisterBody {
  project_id: string;
  owner_unit_id: string;
  head_name: string;
  legal_basis: LegalBasis;
  legal_basis_ref: string;
  retention_until: string;
  national_id?: string;
  phone?: string;
  address_text?: string;
  member_count?: number;
  policy_beneficiary?: boolean;
  consent_record_id?: string;
}

export function registerBody(projectId: string, form: RegisterForm): RegisterBody {
  const body: RegisterBody = {
    project_id: projectId,
    owner_unit_id: form.ownerUnitId,
    head_name: form.headName.trim(),
    legal_basis: form.legalBasis as LegalBasis,
    legal_basis_ref: form.legalBasisRef.trim(),
    retention_until: form.retentionUntil.trim(),
  };
  if (form.nationalId.trim() !== '') body.national_id = digitsOf(form.nationalId.trim());
  if (form.phone.trim() !== '') body.phone = phoneOf(form.phone.trim());
  if (form.addressText.trim() !== '') body.address_text = form.addressText.trim();
  if (form.memberCount.trim() !== '') body.member_count = Number(form.memberCount.trim());
  if (form.policyBeneficiary) body.policy_beneficiary = true;
  if (form.consentRecordId.trim() !== '') body.consent_record_id = form.consentRecordId.trim().toLowerCase();
  return body;
}

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 300;

/** What is wrong with the reason given for opening personal data: it is words of at least ten characters, kept in the trail beside the reading. */
export function validateReason(reason: string): FormProblem | undefined {
  const text = reason.trim();
  if (text === '') return 'required';
  if (text.length > REASON_MAX_LENGTH) return 'tooLong';
  return text.length < REASON_MIN_LENGTH || CONTROL.test(text) ? 'invalid' : undefined;
}

export interface LinkForm {
  parcelId: string;
  rightKind: '' | RightKind;
  sharePct: string;
  titleDocumentVersionId: string;
}

export const EMPTY_LINK_FORM: LinkForm = { parcelId: '', rightKind: '', sharePct: '100', titleDocumentVersionId: '' };

export function validateLink(form: LinkForm): Partial<Record<keyof LinkForm, FormProblem>> {
  const problems: Partial<Record<keyof LinkForm, FormProblem>> = {};
  if (form.parcelId === '') problems.parcelId = 'required';
  if (form.rightKind === '') problems.rightKind = 'required';
  const share = form.sharePct.trim();
  if (share === '') problems.sharePct = 'required';
  else if (!SHARE.test(share) || Number(share) <= 0 || Number(share) > 100) problems.sharePct = 'invalid';
  const document = form.titleDocumentVersionId.trim();
  if (document !== '' && !isUuid(document)) problems.titleDocumentVersionId = 'invalid';
  return problems;
}

export interface LinkBody {
  parcel_id: string;
  right_kind: RightKind;
  share_pct: string;
  title_document_version_id?: string;
}

export function linkBody(form: LinkForm): LinkBody {
  const body: LinkBody = { parcel_id: form.parcelId, right_kind: form.rightKind as RightKind, share_pct: form.sharePct.trim() };
  if (form.titleDocumentVersionId.trim() !== '') body.title_document_version_id = form.titleDocumentVersionId.trim().toLowerCase();
  return body;
}

export type CommandProblem =
  | 'legalBasisRequired'
  | 'consentRequired'
  | 'householdDuplicate'
  | 'linkDuplicate'
  | 'shareExceeded'
  | 'documentNotClean'
  | 'sealUnavailable'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  LEGAL_BASIS_REQUIRED: 'legalBasisRequired',
  CONSENT_REQUIRED: 'consentRequired',
  HOUSEHOLD_DUPLICATE: 'householdDuplicate',
  LINK_DUPLICATE: 'linkDuplicate',
  SHARE_EXCEEDS_100: 'shareExceeded',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  PROVIDER_UNAVAILABLE: 'sealUnavailable',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command or of the reading to what a dialog shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): CommandProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
