import { ApiError } from '@machvon/api-client';

export type SignedReason =
  | 'signatureInvalid'
  | 'chainUntrusted'
  | 'timeUnproven'
  | 'contentMismatch'
  | 'numberTaken'
  | 'modeMismatch'
  | 'registerClosed'
  | 'yearMismatch'
  | 'symbolFormat'
  | 'notPdf'
  | 'scanPending'
  | 'notClean'
  | 'tooLarge'
  | 'selfUpload'
  | 'notAuthorised'
  | 'conflict'
  | 'state'
  | 'invalid'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'duplicate'
  | 'general';

export interface SignedProblem {
  reason: SignedReason;
  field: string | undefined;
  /** What the server found in the file (`SIGNING_TIME_UNPROVEN`, `LEADER_FIELD_REQUIRED`...). */
  findings: string[];
  /** Why the signer is not the person who signed (`SIGNER_IDENTITY_MISMATCH`...). */
  authority: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, SignedReason>> = {
  SIGNATURE_INVALID: 'signatureInvalid',
  CERTIFICATE_CHAIN_UNTRUSTED: 'chainUntrusted',
  SIGNING_TIME_UNPROVEN: 'timeUnproven',
  SIGNED_CONTENT_MISMATCH: 'contentMismatch',
  NUMBER_ALREADY_REGISTERED: 'numberTaken',
  REGISTER_MODE_MISMATCH: 'modeMismatch',
  REGISTER_NOT_OPEN: 'registerClosed',
  REGISTER_YEAR_MISMATCH: 'yearMismatch',
  SYMBOL_FORMAT_INVALID: 'symbolFormat',
  UPLOAD_NOT_PDF: 'notPdf',
  FILE_TYPE_NOT_ALLOWED: 'notPdf',
  SCAN_PENDING: 'scanPending',
  FILE_NOT_CLEAN: 'notClean',
  PAYLOAD_TOO_LARGE: 'tooLarge',
  SELF_APPROVAL_DENIED: 'selfUpload',
  SIGNER_NOT_AUTHORIZED: 'notAuthorised',
  VERSION_CONFLICT: 'conflict',
  DOCUMENT_STATE_INVALID: 'state',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
  IDEMPOTENCY_CONFLICT: 'duplicate',
};

/** Maps the failure of an upload or of a command that takes the file to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): SignedProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, findings: [], authority: undefined };
  const extensions = error.extensions;
  return {
    reason: REASON_BY_CODE[error.code] ?? 'general',
    field: error.detail,
    findings: Array.isArray(extensions.findings) ? extensions.findings.filter((finding): finding is string => typeof finding === 'string') : [],
    authority: typeof extensions.reason === 'string' ? extensions.reason : undefined,
  };
}
