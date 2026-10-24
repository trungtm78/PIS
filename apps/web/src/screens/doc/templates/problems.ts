import { ApiError } from '@machvon/api-client';

/** Why a template command failed, in the words of the library screen. */
export type ProblemReason =
  | 'conflict'
  | 'selfApproval'
  | 'stateInvalid'
  | 'rangeOverlap'
  | 'referenceRequired'
  | 'invalid'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** The server's name of the field the problem is about (`detail`), when it gave one. */
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VERSION_CONFLICT: 'conflict',
  SELF_APPROVAL_DENIED: 'selfApproval',
  TEMPLATE_STATE_INVALID: 'stateInvalid',
  TEMPLATE_RANGE_OVERLAP: 'rangeOverlap',
  CONFIRMATION_REF_REQUIRED: 'referenceRequired',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

/** Maps an error of a template command to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
