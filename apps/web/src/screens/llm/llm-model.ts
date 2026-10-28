import { ApiError } from '@machvon/api-client';

export const PROVIDER_MANAGE = 'llm.provider.manage';
export const PROVIDER_APPROVE = 'llm.provider.approve';
export const POLICY_MANAGE = 'llm.policy.manage';
export const POLICY_APPROVE = 'llm.policy.approve';
export const KEY_MANAGE = 'llm.key.manage';

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const ROUTES = ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] as const;
export type Route = (typeof ROUTES)[number];
export const PROVIDER_STATUSES = ['PROPOSED', 'ACTIVE', 'SUSPENDED', 'RETIRED'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];
export const MODEL_STATUSES = ['PROPOSED', 'EVAL_PENDING', 'APPROVED', 'SUSPENDED', 'RETIRED'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];
export const POLICY_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export const CAPABILITIES = ['json_schema', 'tools', 'vision', 'reasoning'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The baseline no policy may widen (the same one the server keeps): international is for public data only, and important data goes to a model the tenant hosts itself. */
export const BASELINE: Readonly<Record<Classification, readonly Route[]>> = {
  PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'],
  INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  IMPORTANT_CORE: ['SELF_HOSTED'],
};

export type Matrix = Record<Classification, Route[]>;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => (typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined);

export interface Provider {
  id: string;
  code: string;
  name: string;
  region: string;
  route: Route;
  maxClassification: Classification;
  hasAgreement: boolean;
  d07Ref: string | null;
  status: ProviderStatus;
  createdBy: string;
  version: number;
}

/** A provider as the screens read it; an entry that lacks what they need is left out, never guessed. */
export function toProvider(raw: unknown): Provider | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.provider_code);
  const route = oneOf(ROUTES, row?.route_class);
  const max = oneOf(CLASSIFICATIONS, row?.max_classification);
  const status = oneOf(PROVIDER_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || code === undefined || route === undefined || max === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    code,
    name: text(row.name) ?? code,
    region: text(row.region_country) ?? '',
    route,
    maxClassification: max,
    hasAgreement: typeof row.data_agreement_document_id === 'string',
    d07Ref: nullableText(row.d07_approval_ref),
    status,
    createdBy: text(row.created_by) ?? '',
    version,
  };
}

export interface ModelEntry {
  id: string;
  providerId: string;
  modelId: string;
  modelVersion: string | null;
  contextWindow: number;
  maxOutput: number;
  maxClassification: Classification;
  capabilities: Capability[];
  status: ModelStatus;
}

export function toModel(raw: unknown): ModelEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const providerId = text(row?.provider_id);
  const modelId = text(row?.model_id);
  const max = oneOf(CLASSIFICATIONS, row?.max_classification);
  const status = oneOf(MODEL_STATUSES, row?.status);
  const contextWindow = whole(row?.context_window);
  const maxOutput = whole(row?.max_output);
  if (row === undefined || id === undefined || providerId === undefined || modelId === undefined || max === undefined || status === undefined || contextWindow === undefined || maxOutput === undefined) return undefined;
  const capabilities = asRecord(row.capabilities) ?? {};
  return { id, providerId, modelId, modelVersion: nullableText(row.model_version), contextWindow, maxOutput, maxClassification: max, capabilities: CAPABILITIES.filter((name) => capabilities[name] === true), status };
}

export interface PolicyEntry {
  id: string;
  revision: number;
  matrix: Matrix;
  internationalEnabled: boolean;
  d07Ref: string | null;
  legalBasis: string;
  effectiveFrom: string;
  status: PolicyStatus;
  createdBy: string;
  version: number;
}

/** A matrix as stored: every level has a list of known routes, and a level that is not there allows nothing. */
export function toMatrix(raw: unknown): Matrix {
  const row = asRecord(raw) ?? {};
  const matrix = {} as Matrix;
  for (const level of CLASSIFICATIONS) {
    const list = Array.isArray(row[level]) ? (row[level] as unknown[]) : [];
    matrix[level] = ROUTES.filter((route) => list.includes(route));
  }
  return matrix;
}

export function toPolicy(raw: unknown): PolicyEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const status = oneOf(POLICY_STATUSES, row?.status);
  const revision = whole(row?.revision);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || status === undefined || revision === undefined || version === undefined) return undefined;
  return {
    id,
    revision,
    matrix: toMatrix(row.matrix),
    internationalEnabled: row.international_enabled === true,
    d07Ref: nullableText(row.d07_approval_ref),
    legalBasis: text(row.legal_basis) ?? '',
    effectiveFrom: text(row.effective_from) ?? '',
    status,
    createdBy: text(row.created_by) ?? '',
    version,
  };
}

/** What the list of policies says besides the rows: the baseline (told by the server) and the policy in force, if one was published. */
export interface PolicyBook {
  policies: PolicyEntry[];
  inForce: PolicyEntry | undefined;
}

export function toPolicyBook(rows: unknown[]): PolicyBook {
  const policies = rows.flatMap((raw) => toPolicy(raw) ?? []);
  return { policies, inForce: policies.find((policy) => policy.status === 'PUBLISHED') };
}

/** The matrix in force: the published one with the international route only where the tenant turned it on, or the baseline with that route off. */
export function matrixInForce(book: PolicyBook): Matrix {
  const base = {} as Matrix;
  for (const level of CLASSIFICATIONS) base[level] = BASELINE[level].filter((route) => route !== 'INTERNATIONAL');
  if (book.inForce === undefined) return base;
  const out = {} as Matrix;
  for (const level of CLASSIFICATIONS) out[level] = book.inForce.matrix[level].filter((route) => BASELINE[level].includes(route) && (route !== 'INTERNATIONAL' || book.inForce?.internationalEnabled === true));
  return out;
}

// ---- forms ----------------------------------------------------------------------------------------------------------------------------------

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProviderValues {
  code: string;
  name: string;
  region: string;
  route: Route;
  maxClassification: Classification;
  agreementDocumentId: string;
}
export const EMPTY_PROVIDER: ProviderValues = { code: '', name: '', region: 'VN', route: 'DOMESTIC_HOSTED', maxClassification: 'PUBLIC', agreementDocumentId: '' };
export type ProviderProblem = 'required' | 'invalidCode' | 'invalidCountry' | 'notVietnam' | 'internationalPublicOnly' | 'invalidDocument';
export type ProviderErrors = Partial<Record<'code' | 'name' | 'region' | 'maxClassification' | 'agreementDocumentId', ProviderProblem>>;

export function validateProvider(values: ProviderValues): ProviderErrors {
  const errors: ProviderErrors = {};
  if (!CODE.test(values.code.trim())) errors.code = values.code.trim() === '' ? 'required' : 'invalidCode';
  if (values.name.trim().length < 2) errors.name = 'required';
  if (!COUNTRY.test(values.region.trim())) errors.region = 'invalidCountry';
  else if (values.route !== 'INTERNATIONAL' && values.region.trim().toUpperCase() !== 'VN') errors.region = 'notVietnam';
  if (values.route === 'INTERNATIONAL' && values.maxClassification !== 'PUBLIC') errors.maxClassification = 'internationalPublicOnly';
  if (values.agreementDocumentId.trim() !== '' && !UUID.test(values.agreementDocumentId.trim())) errors.agreementDocumentId = 'invalidDocument';
  return errors;
}

export function providerBody(values: ProviderValues) {
  return {
    provider_code: values.code.trim(),
    name: values.name.trim(),
    region_country: values.region.trim().toUpperCase(),
    route_class: values.route,
    max_classification: values.maxClassification,
    ...(values.agreementDocumentId.trim() === '' ? {} : { data_agreement_document_id: values.agreementDocumentId.trim().toLowerCase() }),
  };
}

export interface ModelValues {
  providerId: string;
  modelId: string;
  modelVersion: string;
  contextWindow: string;
  maxOutput: string;
  maxClassification: Classification;
  capabilities: Capability[];
}
export const EMPTY_MODEL: ModelValues = { providerId: '', modelId: '', modelVersion: '', contextWindow: '8000', maxOutput: '1000', maxClassification: 'PUBLIC', capabilities: [] };
export type ModelProblem = 'required' | 'invalidNumber' | 'outputAboveWindow' | 'aboveProvider';
export type ModelErrors = Partial<Record<'providerId' | 'modelId' | 'contextWindow' | 'maxOutput' | 'maxClassification', ModelProblem>>;

const count = (value: string): number | undefined => (/^[0-9]{1,9}$/.test(value.trim()) && Number(value) > 0 ? Number(value) : undefined);

export function validateModel(values: ModelValues, providers: readonly Provider[]): ModelErrors {
  const errors: ModelErrors = {};
  const provider = providers.find((candidate) => candidate.id === values.providerId);
  if (provider === undefined) errors.providerId = 'required';
  if (values.modelId.trim().length < 2) errors.modelId = 'required';
  const window = count(values.contextWindow);
  const output = count(values.maxOutput);
  if (window === undefined) errors.contextWindow = 'invalidNumber';
  if (output === undefined) errors.maxOutput = 'invalidNumber';
  else if (window !== undefined && output > window) errors.maxOutput = 'outputAboveWindow';
  if (provider !== undefined && CLASSIFICATIONS.indexOf(values.maxClassification) > CLASSIFICATIONS.indexOf(provider.maxClassification)) errors.maxClassification = 'aboveProvider';
  return errors;
}

export function modelBody(values: ModelValues) {
  const capabilities: Record<string, boolean> = {};
  for (const name of values.capabilities) capabilities[name] = true;
  return {
    provider_id: values.providerId,
    model_id: values.modelId.trim(),
    ...(values.modelVersion.trim() === '' ? {} : { model_version: values.modelVersion.trim() }),
    capabilities: capabilities as Record<string, never>,
    context_window: Number(values.contextWindow),
    max_output: Number(values.maxOutput),
    max_classification: values.maxClassification,
  };
}

export interface PolicyValues {
  matrix: Matrix;
  internationalEnabled: boolean;
  d07Ref: string;
  legalBasis: string;
  effectiveFrom: string;
}
export type PolicyProblem = 'required' | 'needsD07' | 'invalidDate' | 'importantCore';
export type PolicyErrors = Partial<Record<'legalBasis' | 'd07Ref' | 'effectiveFrom' | 'matrix', PolicyProblem>>;

/** The form begins from the matrix in force, so that a draft changes what is meant to change. */
export function initialPolicy(matrix: Matrix, today: string): PolicyValues {
  const copy = {} as Matrix;
  for (const level of CLASSIFICATIONS) copy[level] = [...matrix[level]];
  return { matrix: copy, internationalEnabled: false, d07Ref: '', legalBasis: '', effectiveFrom: today };
}

export function validatePolicy(values: PolicyValues): PolicyErrors {
  const errors: PolicyErrors = {};
  if (values.legalBasis.trim().length < 3) errors.legalBasis = 'required';
  if (values.internationalEnabled && values.d07Ref.trim() === '') errors.d07Ref = 'needsD07';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.effectiveFrom) || Number.isNaN(Date.parse(values.effectiveFrom))) errors.effectiveFrom = 'invalidDate';
  const core = values.matrix.IMPORTANT_CORE;
  if (core.length !== 1 || core[0] !== 'SELF_HOSTED') errors.matrix = 'importantCore';
  return errors;
}

export function policyBody(values: PolicyValues) {
  const matrix: Record<string, string[]> = {};
  for (const level of CLASSIFICATIONS) {
    // The international route is named only while the tenant has it on (the server says the same).
    matrix[level] = values.matrix[level].filter((route) => route !== 'INTERNATIONAL' || values.internationalEnabled);
  }
  return {
    matrix: matrix as Record<string, never>,
    international_enabled: values.internationalEnabled,
    ...(values.internationalEnabled ? { d07_approval_ref: values.d07Ref.trim() } : {}),
    legal_basis: values.legalBasis.trim(),
    effective_from: new Date(`${values.effectiveFrom}T00:00:00.000Z`).toISOString(),
  };
}

// ---- virtual keys ---------------------------------------------------------------------------------------------------------------------------

export const KEY_SCOPES = ['TENANT', 'UNIT', 'PROJECT', 'SERVICE'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];
export const KEY_STATUSES = ['ACTIVE', 'ROTATING', 'REVOKED'] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

/** A key as it is shown: the alias, the fingerprint and the state. The server sends nothing else of the secret, and nothing here could show it. */
export interface KeyEntry {
  id: string;
  alias: string;
  fingerprint: string;
  scope: KeyScope;
  modelIds: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: KeyStatus;
  expiresAt: string;
  rotatedFromId: string | null;
  revokedReason: string | null;
  version: number;
}

const rate = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);

export function toKey(raw: unknown): KeyEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const alias = text(row?.key_alias);
  const fingerprint = text(row?.fingerprint);
  const scope = oneOf(KEY_SCOPES, row?.scope_kind);
  const status = oneOf(KEY_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || alias === undefined || fingerprint === undefined || scope === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    alias,
    fingerprint,
    scope,
    modelIds: Array.isArray(row.allowed_model_ids) ? row.allowed_model_ids.filter((entry): entry is string => typeof entry === 'string') : [],
    rpmLimit: rate(row.rpm_limit),
    tpmLimit: rate(row.tpm_limit),
    status,
    expiresAt: text(row.expires_at) ?? '',
    rotatedFromId: nullableText(row.rotated_from_id),
    revokedReason: nullableText(row.revoked_reason),
    version,
  };
}

export interface KeyValues {
  alias: string;
  scope: KeyScope;
  modelIds: string[];
  expiresOn: string;
  rpmLimit: string;
  tpmLimit: string;
}
export const EMPTY_KEY: KeyValues = { alias: '', scope: 'TENANT', modelIds: [], expiresOn: '', rpmLimit: '', tpmLimit: '' };
export type KeyProblem = 'required' | 'invalidAlias' | 'invalidDate' | 'pastDate' | 'invalidNumber' | 'needsModel';
export type KeyErrors = Partial<Record<'alias' | 'expiresOn' | 'rpmLimit' | 'tpmLimit' | 'modelIds', KeyProblem>>;

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;

export function validateKey(values: KeyValues, today: string): KeyErrors {
  const errors: KeyErrors = {};
  if (values.alias.trim() === '') errors.alias = 'required';
  else if (!ALIAS.test(values.alias.trim())) errors.alias = 'invalidAlias';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.expiresOn) || Number.isNaN(Date.parse(values.expiresOn))) errors.expiresOn = 'invalidDate';
  else if (values.expiresOn <= today) errors.expiresOn = 'pastDate';
  // A key that reaches no model serves nothing: the screen asks for at least one.
  if (values.modelIds.length === 0) errors.modelIds = 'needsModel';
  for (const [field, value] of [['rpmLimit', values.rpmLimit], ['tpmLimit', values.tpmLimit]] as const) {
    if (value.trim() !== '' && (!/^[0-9]{1,8}$/.test(value.trim()) || Number(value) < 1)) errors[field] = 'invalidNumber';
  }
  return errors;
}

export function keyBody(values: KeyValues) {
  return {
    key_alias: values.alias.trim(),
    scope_kind: values.scope,
    allowed_model_ids: values.modelIds,
    expires_at: new Date(`${values.expiresOn}T23:59:59.000+07:00`).toISOString(),
    ...(values.rpmLimit.trim() === '' ? {} : { rpm_limit: Number(values.rpmLimit) }),
    ...(values.tpmLimit.trim() === '' ? {} : { tpm_limit: Number(values.tpmLimit) }),
  };
}

export const MIN_REVOKE_REASON = 10;

// ---- refusals -------------------------------------------------------------------------------------------------------------------------------

export type LlmReason =
  | 'internationalPublicOnly'
  | 'needsD07'
  | 'needsAgreement'
  | 'selfApproval'
  | 'duplicateProvider'
  | 'duplicateModel'
  | 'aboveProvider'
  | 'aliasDuplicate'
  | 'keyState'
  | 'modelNotApproved'
  | 'unavailable'
  | 'matrixInvalid'
  | 'weakensBaseline'
  | 'stale'
  | 'state'
  | 'invalid'
  | 'denied'
  | 'session'
  | 'general';

const REASON_BY_CODE: Readonly<Record<string, LlmReason>> = {
  INTERNATIONAL_CLASSIFICATION_NOT_ALLOWED: 'internationalPublicOnly',
  D07_APPROVAL_REQUIRED: 'needsD07',
  DATA_AGREEMENT_REQUIRED: 'needsAgreement',
  SELF_APPROVAL_DENIED: 'selfApproval',
  PROVIDER_CODE_DUPLICATE: 'duplicateProvider',
  MODEL_DUPLICATE: 'duplicateModel',
  CLASSIFICATION_ABOVE_PROVIDER: 'aboveProvider',
  KEY_ALIAS_DUPLICATE: 'aliasDuplicate',
  KEY_STATE_INVALID: 'keyState',
  MODEL_NOT_APPROVED: 'modelNotApproved',
  PROVIDER_UNAVAILABLE: 'unavailable',
  POLICY_MATRIX_INVALID: 'matrixInvalid',
  POLICY_WEAKENS_BASELINE: 'weakensBaseline',
  VERSION_CONFLICT: 'stale',
  STAGE_TRANSITION_DENIED: 'state',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

export function describeLlmProblem(error: unknown): { reason: LlmReason; detail: string } {
  if (!(error instanceof ApiError)) return { reason: 'general', detail: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', detail: error.detail ?? '' };
}
