import { ApiError } from '@machvon/api-client';

/** Why a command of DOC-08 failed, in the words of the screen. */
export type ProblemReason =
  | 'conflict'
  | 'state'
  | 'signature'
  | 'incremental'
  | 'chain'
  | 'time'
  | 'revocation'
  | 'template'
  | 'recipient'
  | 'channel'
  | 'distributionState'
  | 'receipt'
  | 'invalid'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** The server's name of the field the problem is about (`detail`), when it gave one. */
  field: string | undefined;
  /** The findings of a verification the server lists, so the screen can say which signature and what was found. */
  findings: string[];
}

/** Which command failed: a 503 means a revocation that could not be established when issuing, and a channel that is down when sending. */
export type ProblemContext = 'issue' | 'dispatch' | 'acknowledge' | 'retry';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VERSION_CONFLICT: 'conflict',
  DOCUMENT_STATE_INVALID: 'state',
  SIGNATURE_VERIFICATION_FAILED: 'signature',
  INCREMENTAL_CHANGES_NOT_ALLOWED: 'incremental',
  CERTIFICATE_CHAIN_UNTRUSTED: 'chain',
  SIGNING_TIME_UNPROVEN: 'time',
  TEMPLATE_PENDING_LEGAL_CONFIRMATION: 'template',
  RECIPIENT_INVALID: 'recipient',
  DISTRIBUTION_STATE_INVALID: 'distributionState',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** Maps the failure of a command to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown, context: ProblemContext): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, findings: [] };
  const findings = strings(error.extensions.findings);
  if (error.code === 'PROVIDER_UNAVAILABLE') return { reason: context === 'issue' ? 'revocation' : 'channel', field: error.detail, findings };
  if (error.code === 'VALIDATION_FAILED' && context === 'acknowledge' && error.detail === 'acknowledged_at') return { reason: 'receipt', field: error.detail, findings };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, findings };
}
