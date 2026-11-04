import { createHash } from 'node:crypto';
import { asUuid } from '@machvon/kernel';

/** The audiences of access tokens (IAM 3.4): the tenant plane and the control plane. */
export const TENANT_AUDIENCE = 'machvon-api';
export const CONTROL_AUDIENCE = 'machvon-control';

/** The audience of the token the PowerSync service accepts, and its lifetime: five minutes at most (design doc 04, section on mobile sync with PowerSync, A1). */
export const POWERSYNC_AUDIENCE = 'powersync';
export const POWERSYNC_TOKEN_TTL_SECONDS = 300;

/** Lifetime of a tenant access token (IAM 3.2). */
export const TENANT_TOKEN_TTL_SECONDS = 300;
/** The largest clock difference tolerated between the issuer and this server. */
export const MAX_CLOCK_SKEW_SECONDS = 60;
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;

const MAX_SUBJECT_LENGTH = 255;
const MAX_SESSION_ID_LENGTH = 128;

export function stringClaim(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= maxLength ? value : undefined;
}

export function subjectClaim(value: unknown): string | undefined {
  return stringClaim(value, MAX_SUBJECT_LENGTH);
}

export function sessionClaim(value: unknown): string | undefined {
  return stringClaim(value, MAX_SESSION_ID_LENGTH);
}

export function uuidClaim(value: unknown): string | undefined {
  return asUuid(value);
}

export function scopeVersionClaim(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** String entries of an array claim; anything else is an empty list. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Realm roles of an identity token (`realm_access.roles` in Keycloak). */
export function realmRoles(payload: Record<string, unknown>): string[] {
  const access = payload.realm_access;
  return typeof access === 'object' && access !== null ? stringList((access as { roles?: unknown }).roles) : [];
}

/**
 * A control principal has no membership: its identity subject is turned into a stable UUID (the first 16 bytes of a
 * SHA-256 over a fixed prefix and the subject, with the version and variant bits of a UUID), so the same person is
 * the same principal in the audit trail and different people never collide in practice.
 */
export function controlMembershipId(subject: string): string {
  const bytes = createHash('sha256').update(`machvon:control:${subject}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
