import { ApiError } from '@machvon/api-client';

export type DraftReason =
  | 'conflict'
  | 'state'
  | 'formatCheck'
  | 'notAuthorised'
  | 'stateSecret'
  | 'templateNotEffective'
  | 'payloadInvalid'
  | 'selfApproval'
  | 'subjectRef'
  | 'numberAllocated'
  | 'invalid'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'duplicate'
  | 'general';

/** One thing the server found wrong with a draft: the field the screen marks and a code it explains. */
export interface Failure {
  field: string;
  code: string;
}

/** The DoA band that decided a refusal of the signer. */
export interface Threshold {
  documentType: string;
  amountVnd: string | null;
  amountMinVnd: string | null;
  amountMaxVnd: string | null;
  approverRoleId: string | null;
}

export interface DraftProblem {
  reason: DraftReason;
  field: string | undefined;
  failures: Failure[];
  /** Why the signer is not authorised (`ROLE_NOT_HELD`, `DELEGATION_EXPIRED`...). */
  authority: string | undefined;
  threshold: Threshold | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, DraftReason>> = {
  VERSION_CONFLICT: 'conflict',
  DOCUMENT_STATE_INVALID: 'state',
  FORMAT_CHECK_FAILED: 'formatCheck',
  SIGNER_NOT_AUTHORIZED: 'notAuthorised',
  STATE_SECRET_NOT_SUPPORTED: 'stateSecret',
  TEMPLATE_NOT_EFFECTIVE: 'templateNotEffective',
  PAYLOAD_SCHEMA_INVALID: 'payloadInvalid',
  SELF_APPROVAL_DENIED: 'selfApproval',
  SUBJECT_REF_INVALID: 'subjectRef',
  NUMBER_ALREADY_ALLOCATED: 'numberAllocated',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
  IDEMPOTENCY_CONFLICT: 'duplicate',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function failuresOf(value: unknown): Failure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (isRecord(item) && typeof item.field === 'string' && typeof item.code === 'string' ? [{ field: item.field, code: item.code }] : []));
}

function thresholdOf(value: unknown): Threshold | undefined {
  if (!isRecord(value)) return undefined;
  return {
    documentType: typeof value.document_type === 'string' ? value.document_type : '',
    amountVnd: optionalText(value.amount_vnd),
    amountMinVnd: optionalText(value.amount_min_vnd),
    amountMaxVnd: optionalText(value.amount_max_vnd),
    approverRoleId: optionalText(value.approver_role_id),
  };
}

/** Maps the failure of a drafting or review command to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): DraftProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, failures: [], authority: undefined, threshold: undefined };
  const extensions = error.extensions;
  return {
    reason: REASON_BY_CODE[error.code] ?? 'general',
    field: error.detail,
    failures: failuresOf(extensions.failures),
    authority: typeof extensions.reason === 'string' ? extensions.reason : undefined,
    threshold: thresholdOf(extensions.threshold),
  };
}
