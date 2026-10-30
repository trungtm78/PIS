import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';

/**
 * The domains of a tenant (ST-SAS-017, SAS.md 3.4, BR-SAS-06): a hostname that opens the sign-in page with the tenant chosen. A custom domain is proven with a TXT record the System Admin asks the customer to publish; the platform
 * keeps the hash of the token, not the token. A domain gives a tenant no membership and no access: it only chooses the tenant that the sign-in starts from. The rules below are pure.
 */

/** A hostname the platform has released is held for this long before anybody may be given it again. */
export const DOMAIN_RESERVATION_DAYS = 90;
/** The proof of a custom domain must be published within this long of the request. */
export const CHALLENGE_TTL_DAYS = 7;
/** A verified custom domain is checked again this often. */
export const RECHECK_EVERY_DAYS = 7;
/** A certificate is renewed when it has this long left. */
export const TLS_RENEW_BEFORE_DAYS = 14;
/** The lifetime assumed for a certificate the ACME port issued (the port does not report one) [assumption]. */
export const TLS_LIFETIME_DAYS = 90;
export const VERIFY_LABEL = '_machvon-verify';
export const TOKEN_PREFIX = 'machvon-verify=';

const DAY_MS = 86_400_000;
export type DomainKind = 'PLATFORM_SUBDOMAIN' | 'CUSTOM';

/** Labels of the platform's own names that no tenant may take as a subdomain. */
const RESERVED_LABELS: ReadonlySet<string> = new Set(['www', 'api', 'admin', 'auth', 'login', 'sso', 'app', 'mail', 'smtp', 'imap', 'ftp', 'cdn', 'static', 'assets', 'status', 'support', 'docs', 'system', 'control', 'internal', 'idp', 'keycloak', 'machvon']);

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** The hostname as it is compared and stored: trimmed, lower case, no trailing dot; undefined when it is not a hostname of letters, digits and hyphens with at least two labels. */
export function normalizeHostname(raw: string): string | undefined {
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  if (host.length < 4 || host.length > 253) return undefined;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  // The last label is a name, not a number: an address is not a hostname.
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1] as string)) return undefined;
  return host;
}

/**
 * Whether the platform may give this hostname to a tenant as this kind of domain. A platform subdomain lives under the platform domain and is not one of the platform's own names; a custom domain does not, and is not
 * the platform domain's own name or under it. The answer is 422 `VALIDATION_FAILED` naming `hostname` (the hostname is not acceptable at all) or 409 `DOMAIN_TAKEN` (it is a name of the platform's: reserved).
 */
export function assertHostnameAllowed(hostname: string, kind: DomainKind, platformDomain: string): string {
  const host = normalizeHostname(hostname);
  if (host === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'hostname');
  const platform = platformDomain.toLowerCase();
  const underPlatform = host === platform || host.endsWith(`.${platform}`);
  if (kind === 'PLATFORM_SUBDOMAIN') {
    const label = host.slice(0, -(platform.length + 1));
    if (!host.endsWith(`.${platform}`) || label.includes('.')) throw new DomainError('VALIDATION_FAILED', 422, 'hostname');
    if (RESERVED_LABELS.has(label)) throw new DomainError('DOMAIN_TAKEN', 409, 'hostname', { extensions: { reason: 'RESERVED' } });
    return host;
  }
  // A custom domain under the platform's own domain would be a platform name in the hands of a tenant.
  if (underPlatform) throw new DomainError('DOMAIN_TAKEN', 409, 'hostname', { extensions: { reason: 'RESERVED' } });
  return host;
}

/** The name of the TXT record the customer publishes. */
export const challengeRecordName = (hostname: string): string => `${VERIFY_LABEL}.${hostname}`;

/** A new token for a challenge, and the hash that is kept in its place. The token is shown once. */
export function newChallenge(): { value: string; hash: string } {
  const value = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { value, hash: hashOf(value) };
}

export const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Whether one of the TXT values published at the name holds the token that was asked for (compared by its hash, in constant time; surrounding quotes and spaces are ignored). */
export function challengeAnswered(published: readonly string[], tokenHash: string): boolean {
  const wanted = Buffer.from(tokenHash, 'hex');
  return published.some((raw) => {
    const have = Buffer.from(hashOf(raw.trim().replace(/^"+|"+$/g, '').trim()), 'hex');
    return have.length === wanted.length && timingSafeEqual(have, wanted);
  });
}

export const challengeEndsAt = (from: Date): Date => new Date(from.getTime() + CHALLENGE_TTL_DAYS * DAY_MS);
export const reservedUntil = (revokedAt: Date): Date => new Date(revokedAt.getTime() + DOMAIN_RESERVATION_DAYS * DAY_MS);
/** Whether a hostname released at `revokedAt` is still held at `now`. */
export const isReserved = (revokedAt: Date, now: Date): boolean => now.getTime() < reservedUntil(revokedAt).getTime();
export const certificateEndsAt = (issuedAt: Date): Date => new Date(issuedAt.getTime() + TLS_LIFETIME_DAYS * DAY_MS);
export const needsRenewal = (endsAt: Date | null, now: Date): boolean => endsAt !== null && endsAt.getTime() - now.getTime() <= TLS_RENEW_BEFORE_DAYS * DAY_MS;
export const dueForRecheck = (lastCheckedAt: Date | null, now: Date): boolean => lastCheckedAt === null || now.getTime() - lastCheckedAt.getTime() >= RECHECK_EVERY_DAYS * DAY_MS;
