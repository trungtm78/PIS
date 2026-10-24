import { ApiError } from '@machvon/api-client';

/** The permissions that gate the buttons of the guarantee screen; the server decides again on every request (scope included). */
export const GUARANTEE_MANAGE_PERMISSION = 'guarantee.manage';
export const GUARANTEE_VERIFY_PERMISSION = 'guarantee.verify';
export const GUARANTEE_RELEASE_PERMISSION = 'guarantee.release';

export const GUARANTEES_PATH = '/ctr/ctr-05';

export const GUARANTEE_KINDS = ['PERFORMANCE', 'ADVANCE', 'WARRANTY', 'INSURANCE'] as const;
export type GuaranteeKind = (typeof GUARANTEE_KINDS)[number];
export const GUARANTEE_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'EXPIRED', 'RELEASED', 'CALLED', 'SUPERSEDED', 'REJECTED'] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];
/** The reminders before the expiry (CTR 3.5): the screen shows the last one that was sent. */
export const ALERT_LEVELS = [30, 15, 7, 0] as const;
/** The windows of the "expiring soon" view, in days. */
export const EXPIRING_WINDOWS = [30, 15, 7, 0] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT = /^(0|[1-9]\d{0,23})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;
export const ISSUER_MAX_LENGTH = 300;
export const NUMBER_MAX_LENGTH = 100;
export const TEXT_MAX_LENGTH = 2000;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const isOneOf = <T extends string>(values: readonly T[], value: string | undefined): value is T => value !== undefined && (values as readonly string[]).includes(value);

// ---- what the server answers ----------------------------------------------------------------------------------------

/** One guarantee of the register (CTR-05). The fields only the staff see are null/undefined for a guest contractor. */
export interface Guarantee {
  id: string;
  contractId: string;
  contractCode: string;
  kind: GuaranteeKind;
  issuer: string;
  guaranteeNo: string | null;
  partyName: string | null;
  /** An exact decimal string in VND. */
  amountVnd: string;
  validFrom: string | null;
  /** The calendar day, in Vietnam, on which the guarantee expires (the day the reminders and the expiry count by). */
  expiresOn: string;
  status: GuaranteeStatus;
  verificationStatus: string;
  /** The last reminder sent, in days before the expiry. */
  lastAlertDays: number | null;
  extendedFromId: string | null;
  version: number;
  registeredBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  /** What the contract still owes of its advance; only for a reader of the ledger. */
  advanceOutstandingVnd: string | undefined;
  /** Calendar days to the expiry, for the "expiring soon" view. */
  daysLeft: number | undefined;
}

export function toGuarantee(raw: unknown): Guarantee | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const kind = text(row.kind);
  const status = text(row.status);
  const amount = text(row.amount_vnd);
  const expiresOn = text(row.expires_on);
  const version = whole(row.version);
  if (id === undefined || amount === undefined || expiresOn === undefined || version === undefined || !isOneOf(GUARANTEE_KINDS, kind) || !isOneOf(GUARANTEE_STATUSES, status)) return undefined;
  return {
    id,
    contractId: text(row.contract_id) ?? '',
    contractCode: text(row.contract_code) ?? '',
    kind,
    issuer: text(row.issuer) ?? '',
    guaranteeNo: nullableText(row.guarantee_no),
    partyName: nullableText(row.party_name),
    amountVnd: amount,
    validFrom: nullableText(row.valid_from),
    expiresOn,
    status,
    verificationStatus: text(row.verification_status) ?? '',
    lastAlertDays: whole(row.last_alert_days) ?? null,
    extendedFromId: nullableText(row.extended_from_id),
    version,
    registeredBy: nullableText(row.registered_by),
    releasedAt: nullableText(row.released_at),
    releaseReason: nullableText(row.release_reason),
    advanceOutstandingVnd: text(row.advance_outstanding_vnd),
    daysLeft: whole(row.days_left),
  };
}

/** The calendar day, in Vietnam, of an instant: `YYYY-MM-DD`. */
export const vietnamDay = (instant: Date): string => new Date(instant.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The days left of a guarantee as of `now` (the server's `days_left` when the read gave it). */
export const daysLeftOf = (guarantee: Guarantee, now: Date): number => guarantee.daysLeft ?? daysBetween(vietnamDay(now), guarantee.expiresOn);

/** Whether the person who registered the guarantee is the person signed in: the same person cannot verify or release it. */
export const isOwnRegistration = (guarantee: Guarantee, membershipId: string | undefined): boolean => membershipId !== undefined && guarantee.registeredBy?.toLowerCase() === membershipId.toLowerCase();

/** The statuses from which each command can be taken (CTR section 4); the server judges again. */
export const canVerify = (guarantee: Guarantee): boolean => guarantee.status === 'PENDING_VERIFICATION';
export const canExtend = (guarantee: Guarantee): boolean => guarantee.status === 'ACTIVE';
export const canRelease = (guarantee: Guarantee): boolean => guarantee.status === 'ACTIVE' || guarantee.status === 'EXPIRED';

export interface GuaranteeFilter {
  query: string;
  status: GuaranteeStatus | '';
  kind: GuaranteeKind | '';
}

export const EMPTY_FILTER: GuaranteeFilter = { query: '', status: '', kind: '' };

export function filterGuarantees(guarantees: readonly Guarantee[], filter: GuaranteeFilter, contractId: string | undefined): Guarantee[] {
  const query = filter.query.trim().toLowerCase();
  return guarantees.filter(
    (guarantee) =>
      (contractId === undefined || guarantee.contractId === contractId) &&
      (filter.status === '' || guarantee.status === filter.status) &&
      (filter.kind === '' || guarantee.kind === filter.kind) &&
      (query === '' || guarantee.issuer.toLowerCase().includes(query) || (guarantee.guaranteeNo ?? '').toLowerCase().includes(query) || guarantee.contractCode.toLowerCase().includes(query)),
  );
}

export const guaranteesLink = (contractId?: string): string => (contractId === undefined ? GUARANTEES_PATH : `${GUARANTEES_PATH}?${new URLSearchParams({ id: contractId }).toString()}`);

// ---- the forms ---------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooLong' | 'invalidAmount' | 'zeroAmount' | 'invalidId' | 'invalidDate' | 'endBeforeStart' | 'notLater';

/** The expiry of a guarantee is the end of the day it is typed on, in Vietnam time (the day the reminders and the expiry count by). */
export const endOfDay = (day: string): string => `${day}T23:59:00+07:00`;

export interface RegisterForm {
  kind: GuaranteeKind;
  partyId: string;
  issuer: string;
  guaranteeNo: string;
  amount: string;
  validFrom: string;
  expiresOn: string;
  documentVersionId: string;
}

export const EMPTY_REGISTER: RegisterForm = { kind: 'PERFORMANCE', partyId: '', issuer: '', guaranteeNo: '', amount: '', validFrom: '', expiresOn: '', documentVersionId: '' };

function textProblem(value: string, max: number): FormProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  return trimmed.length > max ? 'tooLong' : undefined;
}

const dateProblem = (value: string): FormProblem | undefined => {
  if (value === '') return 'required';
  return DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? undefined : 'invalidDate';
};

const idProblem = (value: string): FormProblem | undefined => {
  if (value.trim() === '') return 'required';
  return UUID.test(value.trim()) ? undefined : 'invalidId';
};

export function validateRegister(form: RegisterForm): Partial<Record<keyof RegisterForm, FormProblem>> {
  const problems: Partial<Record<keyof RegisterForm, FormProblem>> = {};
  const issuer = textProblem(form.issuer, ISSUER_MAX_LENGTH);
  if (issuer !== undefined) problems.issuer = issuer;
  const number = textProblem(form.guaranteeNo, NUMBER_MAX_LENGTH);
  if (number !== undefined) problems.guaranteeNo = number;
  const amount = form.amount.trim();
  if (amount === '') problems.amount = 'required';
  else if (!AMOUNT.test(amount)) problems.amount = 'invalidAmount';
  else if (BigInt(amount) === 0n) problems.amount = 'zeroAmount';
  const start = dateProblem(form.validFrom);
  if (start !== undefined) problems.validFrom = start;
  const end = dateProblem(form.expiresOn);
  if (end !== undefined) problems.expiresOn = end;
  else if (start === undefined && form.expiresOn < form.validFrom) problems.expiresOn = 'endBeforeStart';
  const document = idProblem(form.documentVersionId);
  if (document !== undefined) problems.documentVersionId = document;
  if (form.partyId !== '' && !UUID.test(form.partyId)) problems.partyId = 'invalidId';
  return problems;
}

export function registerBody(form: RegisterForm) {
  return {
    kind: form.kind,
    issuer: form.issuer.trim(),
    guarantee_no: form.guaranteeNo.trim(),
    amount_vnd: String(BigInt(form.amount.trim())),
    valid_from: form.validFrom,
    expires_at: endOfDay(form.expiresOn),
    document_version_id: form.documentVersionId.trim(),
    ...(form.partyId === '' ? {} : { party_id: form.partyId }),
  };
}

export type RegisterBody = ReturnType<typeof registerBody>;

export interface VerifyForm {
  outcome: 'VERIFIED' | 'FAILED';
  method: string;
  evidenceId: string;
}

export const EMPTY_VERIFY: VerifyForm = { outcome: 'VERIFIED', method: '', evidenceId: '' };

export function validateVerify(form: VerifyForm): Partial<Record<keyof VerifyForm, FormProblem>> {
  const problems: Partial<Record<keyof VerifyForm, FormProblem>> = {};
  const method = textProblem(form.method, TEXT_MAX_LENGTH);
  if (method !== undefined) problems.method = method;
  const evidence = idProblem(form.evidenceId);
  if (evidence !== undefined) problems.evidenceId = evidence;
  return problems;
}

export const verifyBody = (form: VerifyForm) => ({ outcome: form.outcome, method: form.method.trim(), evidence_document_version_id: form.evidenceId.trim() });
export type VerifyBody = ReturnType<typeof verifyBody>;

export interface ExtendForm {
  expiresOn: string;
  guaranteeNo: string;
  documentVersionId: string;
}

export const EMPTY_EXTEND: ExtendForm = { expiresOn: '', guaranteeNo: '', documentVersionId: '' };

/** The new expiry must come after the day the guarantee being replaced expires on. */
export function validateExtend(form: ExtendForm, currentExpiresOn: string): Partial<Record<keyof ExtendForm, FormProblem>> {
  const problems: Partial<Record<keyof ExtendForm, FormProblem>> = {};
  const day = dateProblem(form.expiresOn);
  if (day !== undefined) problems.expiresOn = day;
  else if (form.expiresOn <= currentExpiresOn) problems.expiresOn = 'notLater';
  const number = textProblem(form.guaranteeNo, NUMBER_MAX_LENGTH);
  if (number !== undefined) problems.guaranteeNo = number;
  const document = idProblem(form.documentVersionId);
  if (document !== undefined) problems.documentVersionId = document;
  return problems;
}

export const extendBody = (form: ExtendForm) => ({ new_expires_at: endOfDay(form.expiresOn), new_guarantee_no: form.guaranteeNo.trim(), document_version_id: form.documentVersionId.trim() });
export type ExtendBody = ReturnType<typeof extendBody>;

export interface ReleaseForm {
  evidenceId: string;
  reason: string;
}

export const EMPTY_RELEASE: ReleaseForm = { evidenceId: '', reason: '' };

export function validateRelease(form: ReleaseForm): Partial<Record<keyof ReleaseForm, FormProblem>> {
  const problems: Partial<Record<keyof ReleaseForm, FormProblem>> = {};
  const evidence = idProblem(form.evidenceId);
  if (evidence !== undefined) problems.evidenceId = evidence;
  const reason = textProblem(form.reason, TEXT_MAX_LENGTH);
  if (reason !== undefined) problems.reason = reason;
  return problems;
}

export const releaseBody = (form: ReleaseForm) => ({ release_evidence_id: form.evidenceId.trim(), reason: form.reason.trim() });
export type ReleaseBody = ReturnType<typeof releaseBody>;

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'duplicate'
  | 'selfApproval'
  | 'stateInvalid'
  | 'contractState'
  | 'releaseCondition'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** For a release refused while an advance is owed: what is still owed, an exact decimal string in VND. */
  advanceOutstanding: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  GUARANTEE_DUPLICATE: 'duplicate',
  SELF_APPROVAL_DENIED: 'selfApproval',
  GUARANTEE_STATE_INVALID: 'stateInvalid',
  CONTRACT_STATE_INVALID: 'contractState',
  RELEASE_CONDITION_NOT_MET: 'releaseCondition',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, advanceOutstanding: undefined };
  const outstanding = error.extensions.advance_outstanding_vnd;
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, advanceOutstanding: typeof outstanding === 'string' ? outstanding : undefined };
}
