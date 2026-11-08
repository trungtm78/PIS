import { refusalOf } from '../../rpt/model';
import type { Translator } from '../../../i18n';

/** What the server answers for the lock list and for the signature of a copy (the shapes of period-report.controller.ts). */
export interface LockRule {
  version: number;
  unverified: boolean;
  lock_after: 'SIGNED' | 'ACCEPTED';
  signature_required_receivers: string[];
  unlock_reason_min_chars: number;
}

export interface LockRow {
  id: string;
  layout_code: string;
  period_code: string;
  issue_id: string;
  digest_sha256: string;
  locked_by: string;
  locked_at: string;
  open: boolean;
  unlocked_by: string | null;
  unlocked_at: string | null;
  unlock_reason: string | null;
  version: number;
}

export interface LockPage {
  as_of: string;
  items: LockRow[];
  has_more: boolean;
  rule: LockRule;
}

export interface SignatureRow {
  id: string;
  issue_id: string;
  digest_sha256: string;
  provider: 'REMOTE_CA' | 'LOCAL_AGENT' | 'MOCK';
  signer_id: string;
  certificate_fingerprint: string;
  cms_sha256: string;
  counts_for_delivery: boolean;
  signed_at: string;
}

export interface SignatureFacts {
  as_of: string;
  issue_id: string;
  layout_code: string;
  period_code: string;
  revision: number;
  digest_sha256: string;
  signed: boolean;
  signature: SignatureRow | null;
  open_session_id: string | null;
  period_lock: LockRow | null;
  signature_required_receivers: string[];
}

export interface CertificateRow {
  id: string;
  kind: string;
  holder_membership_id: string | null;
  fingerprint_sha256: string;
  subject_dn: string;
  status: string;
  valid_until: string;
}

export const MOF_PREFIX = 'MOF-DIS-';
export const isMofForm = (code: string): boolean => code.startsWith(MOF_PREFIX);

/** The permissions of the screens; a session whose permissions are not known yet shows the action and lets the server judge. */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

export type SignatureState = 'unsigned' | 'inProgress' | 'signed' | 'test';

/** The state of the signature of a copy: a signature of the MOCK provider is a test signature and never counts for the Ministry. */
export function signatureState(facts: Pick<SignatureFacts, 'signed' | 'signature' | 'open_session_id'> | undefined): SignatureState {
  if (facts === undefined) return 'unsigned';
  if (facts.signed && facts.signature !== null) return facts.signature.counts_for_delivery ? 'signed' : 'test';
  return facts.open_session_id === null ? 'unsigned' : 'inProgress';
}

/** A hash short enough for a table; the whole one is always shown where the reader compares it with a file. */
export const shortId = (id: string): string => id.slice(0, 8);

/** The one sentence a refused command is answered with; each refusal of the signature and the lock has its own words. */
export function signRefusalText(t: Translator['t'], error: unknown): string {
  const refusal = refusalOf(error);
  switch (refusal.code) {
    case 'SELF_APPROVAL_DENIED':
      return t('rpt.lock.error.selfApproval');
    case 'PERIOD_LOCKED':
      return t('rpt.lock.error.periodLocked');
    case 'REPORT_SIGNATURE_REQUIRED':
      return t('rpt.lock.error.signatureRequired');
    case 'CERTIFICATE_NOT_ACTIVE':
      return t('rpt.lock.error.certificate');
    case 'PROVIDER_UNAVAILABLE':
      return t('rpt.lock.error.provider');
    case 'SIGNING_SESSION_EXPIRED':
      return t('rpt.lock.error.sessionExpired');
    case 'SIGNATURE_INVALID':
      return t('rpt.lock.error.signatureInvalid');
    case 'PERIOD_LOCK_NOT_FOUND':
      return t('rpt.lock.error.lockNotFound');
    case 'REPORT_STATE_INVALID':
      return t('rpt.lock.error.stateInvalid');
    case 'REPORT_OUT_OF_DATE':
      return t('rpt.lock.error.outOfDate');
    case 'VERSION_CONFLICT':
      return t('rpt.lock.error.versionConflict');
    case 'SCOPE_DENIED':
      return t('rpt.lock.error.scope');
    case 'VALIDATION_FAILED':
      return t('rpt.lock.error.validation');
    default:
      return t('rpt.lock.error.generic');
  }
}

/** The status word of a completion answer: `PENDING` while the signer has not approved on their device. */
export const isPending = (status: string): boolean => status === 'PENDING';
