import { DomainError } from './errors.ts';

/**
 * The registry of the AI gateway (ST-LLM-001, LLM 3 F2, BR-LLM-01): the providers a tenant may send data to, the models they serve, and the matrix that says which route each class of data may take. The matrix has a
 * baseline that no policy may widen: confidential, important and personal data never go to an international model, and important data goes only to a model the tenant hosts itself.
 */
export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const ROUTES = ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] as const;
export type Route = (typeof ROUTES)[number];
export type Matrix = Partial<Record<Classification, Route[]>>;

/** The matrix nobody may widen. PUBLIC may go international only when a published policy turns the route on (with the approval of D07). */
export const BASELINE_MATRIX: Readonly<Record<Classification, readonly Route[]>> = {
  PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'],
  INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'],
  IMPORTANT_CORE: ['SELF_HOSTED'],
};

const invalidMatrix = (field: string): DomainError => new DomainError('POLICY_MATRIX_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isClassification = (value: string): value is Classification => (CLASSIFICATIONS as readonly string[]).includes(value);
const isRoute = (value: unknown): value is Route => typeof value === 'string' && (ROUTES as readonly string[]).includes(value);
const blank = (value: string | undefined | null): boolean => value === undefined || value === null || value.trim() === '';

/** A matrix as the request gives it: levels of the classification that name a list of known routes, each once. A level that is left out is not in the matrix (and a policy without it cannot be published). */
export function parseMatrix(raw: unknown): Matrix {
  if (!isRecord(raw)) throw invalidMatrix('matrix');
  const matrix: Matrix = {};
  for (const [level, routes] of Object.entries(raw)) {
    if (!isClassification(level)) throw invalidMatrix(level);
    if (!Array.isArray(routes) || !routes.every(isRoute) || new Set(routes).size !== routes.length) throw invalidMatrix(level);
    matrix[level] = [...routes];
  }
  return matrix;
}

export interface PolicyDraftInput {
  matrix: unknown;
  internationalEnabled: boolean;
  d07ApprovalRef: string | undefined | null;
}

/** What a draft must be to be kept: a matrix, and the approval of D07 when the international route is turned on. A matrix that names the route while it is off says two things at once. */
export function assertPolicyDraft(input: PolicyDraftInput): Matrix {
  const matrix = parseMatrix(input.matrix);
  if (input.internationalEnabled && blank(input.d07ApprovalRef)) throw new DomainError('D07_APPROVAL_REQUIRED', 422, 'd07_approval_ref');
  if (!input.internationalEnabled) {
    const level = CLASSIFICATIONS.find((candidate) => matrix[candidate]?.includes('INTERNATIONAL'));
    if (level !== undefined) throw invalidMatrix(level);
  }
  return matrix;
}

export interface PublishedPolicy {
  matrix: Matrix;
  internationalEnabled: boolean;
}

/** The levels of the classification where a policy is wider than the baseline, or leaves out what the baseline fixes (a level with no line; the line of important data, which is only the self-hosted route). */
export function baselineViolations(policy: PublishedPolicy): Classification[] {
  const found: Classification[] = [];
  for (const level of CLASSIFICATIONS) {
    const routes = policy.matrix[level];
    const allowed = BASELINE_MATRIX[level];
    if (routes === undefined || routes.some((route) => !allowed.includes(route))) found.push(level);
    else if (level === 'IMPORTANT_CORE' && !(routes.length === 1 && routes[0] === 'SELF_HOSTED')) found.push(level);
    else if (level === 'PUBLIC' && routes.includes('INTERNATIONAL') && !policy.internationalEnabled) found.push(level);
  }
  return found;
}

export interface PublishInput extends PublishedPolicy {
  createdBy: string;
  effectiveFrom: Date;
  actor: string;
  now: Date;
}

/** The guards of publishing: the baseline first (what is told to anyone who tries), then the person, then the date. */
export function assertPublishable(input: PublishInput): void {
  const weakened = baselineViolations(input);
  if (weakened.length > 0) throw new DomainError('POLICY_WEAKENS_BASELINE', 422, weakened.join(','));
  if (input.actor === input.createdBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  // A policy is in force when it is published: a date that has not come yet is a draft that waits.
  if (input.effectiveFrom.getTime() > input.now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
}

/** The routes a class of data may take: those of the published policy, or the baseline with the international route off when no policy has been published. */
export function routesFor(level: Classification, policy: PublishedPolicy | undefined): Route[] {
  const base = BASELINE_MATRIX[level].filter((route) => route !== 'INTERNATIONAL');
  if (policy === undefined) return [...base];
  const chosen = policy.matrix[level] ?? [];
  return chosen.filter((route) => BASELINE_MATRIX[level].includes(route) && (route !== 'INTERNATIONAL' || policy.internationalEnabled));
}

// ---- providers and models ----------------------------------------------------------------------------------------------------------------------

export interface ProviderInput {
  providerCode: string;
  regionCountry: string;
  routeClass: Route;
  maxClassification: Classification;
}

/** An international provider takes public data only; every other route is in Viet Nam (the database says the same in ai_provider_intl_chk and ai_provider_vn_chk). */
export function assertProviderRegistration(input: ProviderInput): void {
  if (input.routeClass === 'INTERNATIONAL') {
    if (input.maxClassification !== 'PUBLIC') throw new DomainError('INTERNATIONAL_CLASSIFICATION_NOT_ALLOWED', 422, 'max_classification');
  } else if (input.regionCountry !== 'VN') {
    throw new DomainError('VALIDATION_FAILED', 422, 'region_country');
  }
}

export interface ActivationInput {
  routeClass: Route;
  maxClassification: Classification;
  d07ApprovalRef: string | undefined | null;
  dataAgreementDocumentId: string | null;
  registeredBy: string;
  actor: string;
}

/**
 * What a provider needs to become ACTIVE: the approval of D07 when it is international, the data agreement when it takes more than public data, and another person than the one who registered it. The conditions
 * on the request come before the person, so that the missing paper is told first.
 */
export function assertActivation(input: ActivationInput): void {
  if (input.routeClass === 'INTERNATIONAL' && blank(input.d07ApprovalRef)) throw new DomainError('D07_APPROVAL_REQUIRED', 422, 'd07_approval_ref');
  if (input.maxClassification !== 'PUBLIC' && input.dataAgreementDocumentId === null) throw new DomainError('DATA_AGREEMENT_REQUIRED', 422, 'data_agreement_document_id');
  if (input.actor === input.registeredBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

export interface ModelInput {
  providerMax: Classification;
  maxClassification: Classification;
  contextWindow: number;
  maxOutput: number;
  capabilities: unknown;
}

/** A model takes no more than its provider does, has a window that can hold its output, and declares what it can do as an object. */
export function assertModelRegistration(input: ModelInput): void {
  if (CLASSIFICATIONS.indexOf(input.maxClassification) > CLASSIFICATIONS.indexOf(input.providerMax)) throw new DomainError('CLASSIFICATION_ABOVE_PROVIDER', 422, 'max_classification');
  if (!Number.isInteger(input.contextWindow) || input.contextWindow < 1) throw new DomainError('VALIDATION_FAILED', 422, 'context_window');
  if (!Number.isInteger(input.maxOutput) || input.maxOutput < 1 || input.maxOutput > input.contextWindow) throw new DomainError('VALIDATION_FAILED', 422, 'max_output');
  if (!isRecord(input.capabilities)) throw new DomainError('VALIDATION_FAILED', 422, 'capabilities');
}
