import { DomainError } from './errors.ts';
import { CLASSIFICATIONS } from './llm-registry.ts';
import type { Classification, Route } from './llm-registry.ts';

/**
 * Where the processing of an AI request may happen, by edition (eng-review R5, requirement AI.07, KT.02). The routing policy of the tenant (`llm-registry.ts`) says which route each class of data may take; this module says,
 * for the edition the process serves, whether a provider outside the customer servers (any route but SELF_HOSTED) may be used at all. The public edition keeps the routing policy as it is (`ALLOWED`). An edition that keeps
 * processing on the servers of the customer sets `EXCEPTION_REQUIRED`: an external provider is then used only while an approved exception of that provider stands, and it must have been attested (where its data rests, that it
 * does not train on it) before it can be activated. The policy is a value the process is started with: the enterprise package registers its own when the process serves that edition (the seam of the API loads it), and
 * the default is the public one. The exception itself (who asked, who approved, until when, every use) is data of the tenant (`ai_external_exception`); the rules about it are here, pure.
 */

export type ExternalRouting = 'ALLOWED' | 'EXCEPTION_REQUIRED';

export interface AiEditionPolicy {
  /** A short stable name of the policy, shown in the audit trail and on the screen of the exceptions. */
  readonly name: string;
  readonly externalRouting: ExternalRouting;
  /** A provider outside the customer servers cannot be activated before its data location and its no-training attestation are recorded. */
  readonly attestationRequired: boolean;
}

export const PUBLIC_AI_POLICY: AiEditionPolicy = Object.freeze({ name: 'public', externalRouting: 'ALLOWED', attestationRequired: false });

let current: AiEditionPolicy = PUBLIC_AI_POLICY;

/** The policy of the edition this process serves. */
export const aiEditionPolicy = (): AiEditionPolicy => current;

/** Sets the policy of the edition (the seam of an edition does it once at the start of the process). */
export function setAiEditionPolicy(policy: AiEditionPolicy): void {
  current = Object.freeze({ ...policy });
}

/** Back to the policy of the public edition (tests; a process never goes back). */
export function resetAiEditionPolicy(): void {
  current = PUBLIC_AI_POLICY;
}

/** A route is external when the data leaves the servers of the customer: every route but the one the customer hosts. */
export const isExternalRoute = (route: Route): boolean => route !== 'SELF_HOSTED';

export const EXCEPTION_MAX_DAYS = 90;
export const AI_EXCEPTION_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type AiExceptionStatus = (typeof AI_EXCEPTION_STATUSES)[number];

export interface ExceptionRecord {
  id: string;
  providerId: string;
  taskType: string | null;
  maxClassification: Classification;
  status: AiExceptionStatus;
  validFrom: Date | null;
  validUntil: Date | null;
}

export interface ExternalProbe {
  providerId: string;
  route: Route;
  taskType: string;
  classification: Classification;
  now: Date;
}

const rank = (level: Classification): number => CLASSIFICATIONS.indexOf(level);

/** Whether an exception covers a request: approved, inside its dates, for this provider, for this task (or any), and for data not above the class it was approved for. */
export function exceptionCovers(exception: ExceptionRecord, probe: ExternalProbe): boolean {
  return (
    exception.status === 'APPROVED' &&
    exception.providerId === probe.providerId &&
    (exception.taskType === null || exception.taskType === probe.taskType) &&
    rank(probe.classification) <= rank(exception.maxClassification) &&
    exception.validFrom !== null &&
    exception.validUntil !== null &&
    exception.validFrom.getTime() <= probe.now.getTime() &&
    probe.now.getTime() < exception.validUntil.getTime()
  );
}

export type ExternalVerdict = { allowed: true; exceptionId: string | null } | { allowed: false; code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' };

/**
 * KT.02: whether a request may be sent over a route to a provider under the policy of the edition. A route on the servers of the customer is always allowed (the routing policy still applies). An external route is
 * allowed under `ALLOWED`, and under `EXCEPTION_REQUIRED` only when an exception covers it: the exception that does is named, so that its use is logged.
 */
export function externalVerdict(policy: AiEditionPolicy, probe: ExternalProbe, exceptions: readonly ExceptionRecord[]): ExternalVerdict {
  if (!isExternalRoute(probe.route) || policy.externalRouting === 'ALLOWED') return { allowed: true, exceptionId: null };
  const covering = exceptions.find((exception) => exceptionCovers(exception, probe));
  return covering === undefined ? { allowed: false, code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' } : { allowed: true, exceptionId: covering.id };
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK = /^[A-Z][A-Z0-9_]{1,59}$/;

export interface ExceptionRequestInput {
  providerId: unknown;
  taskType: unknown;
  maxClassification: unknown;
  reason: unknown;
  validDays: unknown;
}

export interface ExceptionRequest {
  providerId: string;
  taskType: string | null;
  maxClassification: Classification;
  reason: string;
  validDays: number;
}

/** What an exception is asked for: a provider, optionally one task, the highest class it should cover, a reason that says why (20 characters at least) and a number of days from 1 to 90. */
export function parseExceptionRequest(input: ExceptionRequestInput): ExceptionRequest {
  if (typeof input.providerId !== 'string' || !UUID.test(input.providerId)) throw invalid('provider_id');
  if (input.taskType !== undefined && input.taskType !== null && (typeof input.taskType !== 'string' || !TASK.test(input.taskType))) throw invalid('task_type');
  const level = CLASSIFICATIONS.find((candidate) => candidate === input.maxClassification);
  if (level === undefined) throw invalid('max_classification');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 20 || reason.length > 2000) throw invalid('reason');
  if (typeof input.validDays !== 'number' || !Number.isInteger(input.validDays) || input.validDays < 1 || input.validDays > EXCEPTION_MAX_DAYS) throw invalid('valid_days');
  return { providerId: input.providerId.toLowerCase(), taskType: typeof input.taskType === 'string' ? input.taskType : null, maxClassification: level, reason, validDays: input.validDays };
}

export interface ExceptionDecisionInput {
  decision: string;
  note: string | undefined;
  approvalRef: string | undefined | null;
  requestedBy: string;
  actor: string;
  requestedValidDays: number;
  providerMaxClassification: Classification;
  maxClassification: Classification;
  status: AiExceptionStatus;
  now: Date;
}

export interface AiExceptionDecision {
  status: 'APPROVED' | 'REJECTED';
  validFrom: Date | null;
  validUntil: Date | null;
  note: string | null;
  approvalRef: string | null;
}

const trimmed = (value: string | undefined | null): string => (value ?? '').trim();

/**
 * The decision about a request for an exception: only a request that is still open is decided; the person who asked does not decide it (SELF_APPROVAL_DENIED); an approval names the paper it rests on (a reference of
 * 3 to 300 characters) and starts now for the days that were asked; the class it covers cannot be above what the provider takes; a rejection says why.
 */
export function decideException(input: ExceptionDecisionInput): AiExceptionDecision {
  if (input.status !== 'REQUESTED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
  if (input.actor === input.requestedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  const note = trimmed(input.note);
  if (input.decision === 'REJECT') {
    if (note.length < 10 || note.length > 2000) throw invalid('note');
    return { status: 'REJECTED', validFrom: null, validUntil: null, note, approvalRef: null };
  }
  if (input.decision !== 'APPROVE') throw invalid('decision');
  const ref = trimmed(input.approvalRef);
  if (ref.length < 3 || ref.length > 300) throw invalid('approval_ref');
  if (note !== '' && (note.length < 10 || note.length > 2000)) throw invalid('note');
  if (rank(input.maxClassification) > rank(input.providerMaxClassification)) throw new DomainError('CLASSIFICATION_ABOVE_PROVIDER', 422, 'max_classification');
  const validUntil = new Date(input.now.getTime() + input.requestedValidDays * 86_400_000);
  return { status: 'APPROVED', validFrom: input.now, validUntil, note: note === '' ? null : note, approvalRef: ref };
}

/** Only an approved exception is revoked, with a reason that says why (10 characters at least); the one who approved it may revoke it, and so may anyone with the right. */
export function assertExceptionRevocable(status: AiExceptionStatus, reason: string | undefined): string {
  if (status !== 'APPROVED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
  const text = trimmed(reason);
  if (text.length < 10 || text.length > 2000) throw invalid('reason');
  return text;
}

export interface AttestationInput {
  dataLocationCountry: unknown;
  dataLocationDetail: unknown;
  noTrainingAttested: unknown;
  attestationRef: unknown;
  attestationDocumentId: unknown;
}

export interface Attestation {
  dataLocationCountry: string;
  dataLocationDetail: string | null;
  noTrainingAttested: boolean;
  attestationRef: string;
  attestationDocumentId: string | null;
}

/** The attestation of a provider: the country where its data rests (two capital letters), optionally the site, whether it trains on what it receives (a flag the person stakes their name on), and the paper that says so. */
export function parseAttestation(input: AttestationInput): Attestation {
  if (typeof input.dataLocationCountry !== 'string' || !/^[A-Z]{2}$/.test(input.dataLocationCountry)) throw invalid('data_location_country');
  const detail = input.dataLocationDetail === undefined || input.dataLocationDetail === null ? null : typeof input.dataLocationDetail === 'string' ? input.dataLocationDetail.trim() : undefined;
  if (detail === undefined || (detail !== null && (detail.length < 2 || detail.length > 300))) throw invalid('data_location_detail');
  if (typeof input.noTrainingAttested !== 'boolean') throw invalid('no_training_attested');
  const ref = typeof input.attestationRef === 'string' ? input.attestationRef.trim() : '';
  if (ref.length < 3 || ref.length > 300) throw invalid('attestation_ref');
  if (input.attestationDocumentId !== undefined && input.attestationDocumentId !== null && (typeof input.attestationDocumentId !== 'string' || !UUID.test(input.attestationDocumentId))) throw invalid('attestation_document_id');
  return {
    dataLocationCountry: input.dataLocationCountry,
    dataLocationDetail: detail,
    noTrainingAttested: input.noTrainingAttested,
    attestationRef: ref,
    attestationDocumentId: typeof input.attestationDocumentId === 'string' ? input.attestationDocumentId.toLowerCase() : null,
  };
}

export interface ProviderAttestationState {
  routeClass: Route;
  dataLocationCountry: string | null;
  noTrainingAttested: boolean;
}

/** Under a policy that requires it, a provider outside the customer servers is activated only with its data location and its no-training attestation on record (409 `PROVIDER_ATTESTATION_REQUIRED`). */
export function assertAttestedForActivation(policy: AiEditionPolicy, provider: ProviderAttestationState): void {
  if (!policy.attestationRequired || !isExternalRoute(provider.routeClass)) return;
  if (provider.dataLocationCountry === null || !provider.noTrainingAttested) throw new DomainError('PROVIDER_ATTESTATION_REQUIRED', 409, 'attestation');
}
