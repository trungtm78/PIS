import { ApiError } from '@machvon/api-client';

/** Why a command of DOC-19 failed, in the words of the screen. */
export type ProblemReason = 'conflict' | 'state' | 'open' | 'basis' | 'selfApproval' | 'approver' | 'invalid' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** The server's name of the field the problem is about (`detail`), when it gave one. */
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VERSION_CONFLICT: 'conflict',
  DOCUMENT_STATE_INVALID: 'state',
  REPLACEMENT_ALREADY_OPEN: 'open',
  CORRECTION_ALREADY_OPEN: 'open',
  RECALL_BASIS_REQUIRED: 'basis',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

/** Maps the failure of a command to what the screen shows; a refused approver is told apart from a field that is simply invalid. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  if (error.code === 'VALIDATION_FAILED' && error.detail === 'approver_user_id') return { reason: 'approver', field: error.detail };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
