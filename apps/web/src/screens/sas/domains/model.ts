import { ApiError } from '@machvon/api-client';

/** The permissions of SAS-05 (x-permission of the operations in openapi.json): the System Admin writes, the registry readers look. */
export const MANAGE_PERMISSION = 'system.tenant.manage';
export const READ_PERMISSION = 'system.tenant.read';

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
/** The same rule as `DomainAdd.hostname` in openapi.json: lower case labels, at least two, the last one letters only. */
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;

export type DomainKind = 'PLATFORM_SUBDOMAIN' | 'CUSTOM';
export type DomainStatus = 'PendingVerification' | 'Verified' | 'Active' | 'Failed' | 'Revoked';
export type TlsStatus = 'Pending' | 'Issued' | 'Renewing' | 'Failed';

export interface DomainView {
  id: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  tlsStatus: TlsStatus;
  tlsExpiresAt: string | undefined;
  verifiedAt: string | undefined;
  lastCheckedAt: string | undefined;
  challengeExpiresAt: string | undefined;
  revokedAt: string | undefined;
  reservedUntil: string | undefined;
  failureCode: string | undefined;
  /** Where the proof is published, for a custom domain that is not proved yet. */
  txtRecordName: string | undefined;
  createdAt: string;
  version: number;
}

export interface DomainPage {
  items: DomainView[];
  nextCursor: string | undefined;
}

/** What the platform answers when a domain is added: the TXT record to publish, given once. */
export interface ChallengeView {
  domainId: string;
  txtRecordName: string;
  txtRecordValue: string;
  expiresAt: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const STATUSES: readonly string[] = ['PendingVerification', 'Verified', 'Active', 'Failed', 'Revoked'];
const TLS_STATUSES: readonly string[] = ['Pending', 'Issued', 'Renewing', 'Failed'];

export function toDomain(raw: unknown): DomainView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.hostname !== 'string') return undefined;
  return {
    id: raw.id,
    hostname: raw.hostname,
    kind: raw.kind === 'PLATFORM_SUBDOMAIN' ? 'PLATFORM_SUBDOMAIN' : 'CUSTOM',
    status: STATUSES.includes(text(raw.status)) ? (raw.status as DomainStatus) : 'PendingVerification',
    tlsStatus: TLS_STATUSES.includes(text(raw.tls_status)) ? (raw.tls_status as TlsStatus) : 'Pending',
    tlsExpiresAt: optional(raw.tls_expires_at),
    verifiedAt: optional(raw.verified_at),
    lastCheckedAt: optional(raw.last_checked_at),
    challengeExpiresAt: optional(raw.challenge_expires_at),
    revokedAt: optional(raw.revoked_at),
    reservedUntil: optional(raw.reserved_until),
    failureCode: optional(raw.failure_code),
    txtRecordName: optional(raw.txt_record_name),
    createdAt: text(raw.created_at),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

export function toDomainPage(raw: unknown): DomainPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toDomain(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

export function toChallenge(raw: unknown): ChallengeView | undefined {
  if (!isRecord(raw) || typeof raw.domain_id !== 'string' || typeof raw.txt_record_name !== 'string') return undefined;
  return { domainId: raw.domain_id, txtRecordName: raw.txt_record_name, txtRecordValue: text(raw.txt_record_value), expiresAt: optional(raw.expires_at) };
}

/** A domain that is proved or about to be can be checked; a released one is final. */
export const canVerify = (view: Pick<DomainView, 'status' | 'kind'>): boolean => view.kind === 'CUSTOM' && (view.status === 'PendingVerification' || view.status === 'Failed');
export const canRemove = (view: Pick<DomainView, 'status'>): boolean => view.status !== 'Revoked';
/** Only a domain that is Verified or Active chooses the tenant at sign-in. */
export const choosesTenant = (view: Pick<DomainView, 'status'>): boolean => view.status === 'Verified' || view.status === 'Active';
/** The list is read quickly while a domain waits for its certificate, slowly otherwise. */
export const isSettling = (view: Pick<DomainView, 'status'>): boolean => view.status === 'Verified';

export const isHostnameValid = (value: string): boolean => HOSTNAME.test(value.trim());
export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

export type ProblemReason = 'taken' | 'reserved' | 'unverified' | 'conflict' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  DOMAIN_TAKEN: 'taken',
  DOMAIN_UNVERIFIED: 'unverified',
  VERSION_CONFLICT: 'conflict',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  const reason = error.code === 'DOMAIN_TAKEN' && error.extensions.reason === 'RESERVED' ? 'reserved' : (REASON_BY_CODE[error.code] ?? 'general');
  return { reason, field: error.detail };
}
