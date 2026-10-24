import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

export const CATALOG_MANAGE_PERMISSION = 'data.catalog.manage';
/** The members that can be chosen as owner or steward are read with this permission (IAM-02). */
export const MEMBER_READ_PERMISSION = 'membership.read';

export const CLASSIFICATION_LIST = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type Classification = (typeof CLASSIFICATION_LIST)[number];
const DATASET_STATUSES = ['DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED'] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];
const QUALITY_BADGES = ['NOT_ASSESSED', 'PASSED', 'WARNING', 'FAILED', 'STALE'] as const;
export type QualityBadge = (typeof QUALITY_BADGES)[number];

export interface DatasetView {
  id: string;
  datasetCode: string;
  title: string;
  domain: string;
  grain: string;
  producerModule: string;
  ownerId: string;
  ownerName: string | null;
  stewardId: string;
  stewardName: string | null;
  classification: Classification;
  isCritical: boolean;
  freshnessSloSeconds: number;
  contractRevision: number | null;
  status: DatasetStatus;
  qualityBadge: QualityBadge;
  /** The score of the latest finished run, null when none has finished: the dataset was not measured, which is not a score of 0. */
  qualityScore: string | null;
  qualityHardFail: boolean | null;
  /** When the latest finished run finished (ISO instant). */
  qualityRunAt: string | null;
  /** The working contract that rules and runs are written against, null while the dataset has none. */
  workingContractId: string | null;
  openIncidents: number;
  overdueIncidents: number;
  version: number;
}

export interface MemberOption {
  id: string;
  name: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((item) => item === value);

/** A dataset as the catalogue answers it; a row that does not have the shape is dropped rather than shown half-filled. */
export function toDataset(raw: unknown): DatasetView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const datasetCode = text(row.dataset_code);
  const title = text(row.title);
  const domain = text(row.domain);
  const grain = text(row.grain);
  const producerModule = text(row.producer_module);
  const ownerId = text(row.owner_user_id);
  const stewardId = text(row.steward_user_id);
  const classification = oneOf(CLASSIFICATION_LIST, row.classification);
  const status = oneOf(DATASET_STATUSES, row.status);
  const qualityBadge = oneOf(QUALITY_BADGES, row.quality_badge);
  const freshnessSloSeconds = whole(row.freshness_slo_seconds);
  const version = whole(row.version);
  if (
    id === undefined || datasetCode === undefined || title === undefined || domain === undefined || grain === undefined || producerModule === undefined || ownerId === undefined || stewardId === undefined ||
    classification === undefined || status === undefined || qualityBadge === undefined || freshnessSloSeconds === undefined || version === undefined || typeof row.is_critical !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    datasetCode,
    title,
    domain,
    grain,
    producerModule,
    ownerId,
    ownerName: nullableText(row.owner_name),
    stewardId,
    stewardName: nullableText(row.steward_name),
    classification,
    isCritical: row.is_critical,
    freshnessSloSeconds,
    contractRevision: whole(row.contract_revision) ?? null,
    status,
    qualityBadge,
    qualityScore: nullableText(row.quality_score),
    qualityHardFail: typeof row.quality_hard_fail === 'boolean' ? row.quality_hard_fail : null,
    qualityRunAt: nullableText(row.quality_run_at),
    workingContractId: nullableText(row.working_contract_id),
    openIncidents: whole(row.open_incidents) ?? 0,
    overdueIncidents: whole(row.overdue_incidents) ?? 0,
    version,
  };
}

/** A member that can own or steward a dataset: an active member of the staff with a name to show. */
export function toMember(raw: unknown): MemberOption | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const name = text(row.display_name);
  if (id === undefined || name === undefined || row.status !== 'Active') return undefined;
  if (row.membership_type !== undefined && row.membership_type !== 'STAFF') return undefined;
  return { id, name };
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

export type FreshnessUnit = 'days' | 'hours' | 'minutes' | 'seconds';

/** A freshness SLO in the largest unit that holds it exactly, so 86400 reads as one day and 5400 as 90 minutes. */
export function freshnessOf(seconds: number): { unit: FreshnessUnit; count: number } {
  if (seconds % SECONDS_PER_DAY === 0) return { unit: 'days', count: seconds / SECONDS_PER_DAY };
  if (seconds % SECONDS_PER_HOUR === 0) return { unit: 'hours', count: seconds / SECONDS_PER_HOUR };
  if (seconds % SECONDS_PER_MINUTE === 0) return { unit: 'minutes', count: seconds / SECONDS_PER_MINUTE };
  return { unit: 'seconds', count: seconds };
}

// ---- forms ----------------------------------------------------------------------------------------------------------

export type FieldProblem = 'required' | 'tooLong' | 'tooShort' | 'invalidNumber' | 'invalidModule' | 'sameAsOwner';
export type FormErrors<Field extends string> = Partial<Record<Field, FieldProblem>>;

export interface RegisterForm {
  datasetCode: string;
  title: string;
  domain: string;
  grain: string;
  producerModule: string;
  ownerId: string;
  stewardId: string;
  classification: Classification;
  isCritical: boolean;
  freshnessHours: string;
}

export type RegisterField = keyof RegisterForm;

export const EMPTY_REGISTER_FORM: RegisterForm = {
  datasetCode: '',
  title: '',
  domain: '',
  grain: '',
  producerModule: '',
  ownerId: '',
  stewardId: '',
  classification: 'INTERNAL',
  isCritical: false,
  freshnessHours: '24',
};

export interface OwnershipForm {
  ownerId: string;
  stewardId: string;
  reason: string;
}

export type OwnershipField = keyof OwnershipForm;

const MODULE_CODE = /^[A-Z][A-Z0-9]{1,9}$/;
const WHOLE_NUMBER = /^[1-9][0-9]{0,5}$/;
const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 1000;
const LIMITS = { datasetCode: 80, title: 300, domain: 60, grain: 200 } as const;
const MIN_LENGTH = 2;

function checkText(value: string, max: number): FieldProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (trimmed.length < MIN_LENGTH) return 'tooShort';
  return trimmed.length > max ? 'tooLong' : undefined;
}

/** The pair rule of a critical dataset (DGV 3.1 F1): one person is not both its owner and its steward. */
function checkPair(isCritical: boolean, ownerId: string, stewardId: string): FormErrors<'ownerId' | 'stewardId'> {
  const errors: FormErrors<'ownerId' | 'stewardId'> = {};
  if (ownerId === '') errors.ownerId = 'required';
  if (stewardId === '') errors.stewardId = 'required';
  else if (isCritical && stewardId === ownerId) errors.stewardId = 'sameAsOwner';
  return errors;
}

export function validateRegister(form: RegisterForm): FormErrors<RegisterField> {
  const errors: FormErrors<RegisterField> = {};
  const set = (field: RegisterField, problem: FieldProblem | undefined): void => {
    if (problem !== undefined) errors[field] = problem;
  };
  set('datasetCode', checkText(form.datasetCode, LIMITS.datasetCode));
  set('title', checkText(form.title, LIMITS.title));
  set('domain', checkText(form.domain, LIMITS.domain));
  set('grain', checkText(form.grain, LIMITS.grain));
  if (form.producerModule.trim() === '') errors.producerModule = 'required';
  else if (!MODULE_CODE.test(form.producerModule.trim())) errors.producerModule = 'invalidModule';
  if (!WHOLE_NUMBER.test(form.freshnessHours.trim())) errors.freshnessHours = 'invalidNumber';
  return { ...errors, ...checkPair(form.isCritical, form.ownerId, form.stewardId) };
}

export function validateOwnership(form: OwnershipForm, isCritical: boolean): FormErrors<OwnershipField> {
  const errors: FormErrors<OwnershipField> = checkPair(isCritical, form.ownerId, form.stewardId);
  const reason = form.reason.trim();
  if (reason === '') errors.reason = 'required';
  else if (reason.length < REASON_MIN_LENGTH) errors.reason = 'tooShort';
  else if (reason.length > REASON_MAX_LENGTH) errors.reason = 'tooLong';
  return errors;
}

/** The request body of a registration, from a form that passed `validateRegister`. */
export type RegisterBody = components['schemas']['DgvDatasetRegister'];

export function registerBody(form: RegisterForm): RegisterBody {
  return {
    dataset_code: form.datasetCode.trim(),
    title: form.title.trim(),
    domain: form.domain.trim(),
    grain: form.grain.trim(),
    producer_module: form.producerModule.trim(),
    owner_user_id: form.ownerId,
    steward_user_id: form.stewardId,
    classification: form.classification,
    is_critical: form.isCritical,
    freshness_slo_seconds: Number(form.freshnessHours.trim()) * SECONDS_PER_HOUR,
  };
}

// ---- refusals -------------------------------------------------------------------------------------------------------

export type ProblemReason = 'ownerStewardSame' | 'duplicateCode' | 'versionConflict' | 'validation' | 'notFound' | 'retired' | 'denied' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  OWNER_STEWARD_SAME: 'ownerStewardSame',
  DATASET_CODE_DUPLICATE: 'duplicateCode',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  STAGE_TRANSITION_DENIED: 'retired',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

/** Maps the error of a command of these screens to what they show; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
