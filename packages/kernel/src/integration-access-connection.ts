import { machineCredentialState } from './open-api.ts';
import type { MachineAccountStatus, MachineCredentialState } from './open-api.ts';

/**
 * The "access" connector of the Integration Hub (INT-1): the credentials and the access side of the open interface (machine accounts of the open API, the logins of BI tools). It mirrors
 * `egp-connection.ts`: the code of the connector, its mode, and one pure function that turns what the store reads into the view the hub shows. Nothing here reads the database or the clock (`now` is passed in).
 * The hub adapts `ACCESS_CONNECTOR` and `accessConnectionView` to its own descriptor; the store side is `AccessOverviewReads` (packages/db/src/int-open-api-store.ts).
 */

export const ACCESS_CONNECTOR_CODE = 'access.open-api';
/** The consumers of the open interface: machines through the API, BI tools through database logins. */
export const ACCESS_CONSUMER_KINDS = ['MACHINE_ACCOUNT', 'BI_READER'] as const;
export type AccessConsumerKind = (typeof ACCESS_CONSUMER_KINDS)[number];

/** Why a consumer needs a look (the hub shows these as the reasons of its health). */
export const ACCESS_ATTENTION_CODES = ['EXPIRES_SOON', 'EXPIRED', 'SECRET_OVERDUE', 'RATE_LIMITED_RECENTLY', 'NEVER_USED'] as const;
export type AccessAttentionCode = (typeof ACCESS_ATTENTION_CODES)[number];

/** Our own operating choices (no law sets them), flagged unverified like the other defaults of the platform. */
export const ACCESS_DEFAULT_PARAMS = { expiresSoonDays: 14, secretMaxAgeDays: 365, rateLimitedWindowHours: 24, neverUsedAfterDays: 7 } as const;
export interface AccessParams {
  expiresSoonDays: number;
  secretMaxAgeDays: number;
  rateLimitedWindowHours: number;
  neverUsedAfterDays: number;
}

/** What the store reads about one machine account (the credential that is in use is the newest one that is not revoked). */
export interface AccessAccountFacts {
  id: string;
  name: string;
  status: MachineAccountStatus;
  scopes: readonly string[];
  ratePerMinute: number;
  expiresOn: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** The newest credential: when it was made, and its end/revocation times. */
  credential: { createdAt: Date; expiresAt: Date | null; revokedAt: Date | null; supersededAt: Date | null } | null;
  /** Calls refused by the rate limit inside the window of `AccessParams.rateLimitedWindowHours`. */
  rateLimitedCalls: number;
}

export interface AccessConsumerView {
  kind: AccessConsumerKind;
  id: string;
  name: string;
  status: string;
  scopes: readonly string[];
  rateLimitPerMinute: number | null;
  lastUsedAt: string | null;
  credentialState: MachineCredentialState | null;
  expiresOn: string | null;
  attention: AccessAttentionCode[];
}

export interface AccessConnectionView {
  connectorCode: typeof ACCESS_CONNECTOR_CODE;
  /** `NO_CONSUMERS` when nothing was ever opened (not an error: a tenant that never used the open interface), `ATTENTION` when a live consumer needs a look, else `HEALTHY`. */
  status: 'NO_CONSUMERS' | 'HEALTHY' | 'ATTENTION';
  consumers: AccessConsumerView[];
  counts: { machineAccounts: { ACTIVE: number; SUSPENDED: number; REVOKED: number }; biReaders: { ACTIVE: number; SUSPENDED: number; RETIRED: number } };
  attentionCount: number;
  lastUsedAt: string | null;
}

const DAY_MS = 86_400_000;

function attentionOf(account: AccessAccountFacts, now: Date, params: AccessParams): AccessAttentionCode[] {
  // A consumer that is suspended or revoked is a decision, not a thing to watch.
  if (account.status !== 'ACTIVE') return [];
  const found: AccessAttentionCode[] = [];
  const today = now.toISOString().slice(0, 10);
  if (account.expiresOn !== null) {
    if (account.expiresOn <= today) found.push('EXPIRED');
    else if (Date.parse(`${account.expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) <= params.expiresSoonDays * DAY_MS) found.push('EXPIRES_SOON');
  }
  if (account.credential !== null && now.getTime() - account.credential.createdAt.getTime() > params.secretMaxAgeDays * DAY_MS) found.push('SECRET_OVERDUE');
  if (account.rateLimitedCalls > 0) found.push('RATE_LIMITED_RECENTLY');
  if (account.lastUsedAt === null && now.getTime() - account.createdAt.getTime() > params.neverUsedAfterDays * DAY_MS) found.push('NEVER_USED');
  return found;
}

/** The view of the connector `access.open-api` for the hub: one entry per consumer, with its state and why it needs a look, and the status of the whole. */
export function accessConnectionView(input: { accounts: readonly AccessAccountFacts[]; readers: { ACTIVE: number; SUSPENDED: number; RETIRED: number }; now: Date; params?: AccessParams }): AccessConnectionView {
  const params = input.params ?? ACCESS_DEFAULT_PARAMS;
  const counts = { ACTIVE: 0, SUSPENDED: 0, REVOKED: 0 };
  const consumers: AccessConsumerView[] = input.accounts.map((account) => {
    counts[account.status] += 1;
    return {
      kind: 'MACHINE_ACCOUNT',
      id: account.id,
      name: account.name,
      status: account.status,
      scopes: account.scopes,
      rateLimitPerMinute: account.ratePerMinute,
      lastUsedAt: account.lastUsedAt === null ? null : account.lastUsedAt.toISOString(),
      credentialState: account.credential === null ? null : machineCredentialState(account.credential, input.now),
      expiresOn: account.expiresOn,
      attention: attentionOf(account, input.now, params),
    };
  });
  const attentionCount = consumers.filter((consumer) => consumer.attention.length > 0).length;
  const total = input.accounts.length + input.readers.ACTIVE + input.readers.SUSPENDED + input.readers.RETIRED;
  const used = input.accounts.flatMap((account) => (account.lastUsedAt === null ? [] : [account.lastUsedAt.getTime()]));
  return {
    connectorCode: ACCESS_CONNECTOR_CODE,
    status: total === 0 ? 'NO_CONSUMERS' : attentionCount > 0 ? 'ATTENTION' : 'HEALTHY',
    consumers,
    counts: { machineAccounts: counts, biReaders: { ...input.readers } },
    attentionCount,
    lastUsedAt: used.length === 0 ? null : new Date(Math.max(...used)).toISOString(),
  };
}
