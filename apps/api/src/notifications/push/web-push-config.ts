/**
 * The settings of the web-push channel: where the keys come from, how far the channel has been proven, and the limit of messages per tenant.
 *
 * Keys are never in the database, an audit row, a log or the repository. Each secret is read in this order: a file named by `<NAME>_FILE` (a secret mounted
 * by the platform; the last line break is cut), a vault reference named by `<NAME>_REF` (`secret://<environment>/<path>`, read as
 * `MACHVON_SECRET_<ENVIRONMENT>_<PATH>` until the vault of the platform is deployed), then the variable `<NAME>` itself.
 */
import { readFileSync } from 'node:fs';
import { MIN_RECEIPT_KEY_CHARACTERS } from './web-push-receipt';

export type Environment = Readonly<Record<string, string | undefined>>;
export type SecretFileReader = (path: string) => string | undefined;

const defaultReader: SecretFileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // A file that cannot be read means the secret is not set: the channel stays a stand-in rather than start with half a key.
    return undefined;
  }
};

/** `secret://<environment>/<path>` is the variable `MACHVON_SECRET_<ENVIRONMENT>_<PATH>`, the convention of the webhook secrets. */
export const secretVariable = (reference: string): string => `MACHVON_SECRET_${reference.replace(/^secret:\/\//, '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

const cleaned = (value: string | undefined): string | undefined => {
  const text = value?.replace(/\r?\n$/, '').trim();
  return text === undefined || text === '' ? undefined : text;
};

/** One secret of the deployment by the order in the header of this file. */
export function secretFromEnv(env: Environment, name: string, read: SecretFileReader = defaultReader): string | undefined {
  const file = env[`${name}_FILE`]?.trim();
  if (file !== undefined && file !== '') return cleaned(read(file));
  const reference = env[`${name}_REF`]?.trim();
  if (reference !== undefined && reference !== '') return cleaned(env[secretVariable(reference)]);
  return cleaned(env[name]);
}

/** The keys that verify a receipt (the first one signs): `MACHVON_WEBPUSH_RECEIPT_KEY`, several separated by commas while one is rotated. A key shorter than 32 characters counts as not set. */
export function receiptKeysFromEnv(env: Environment, read?: SecretFileReader): string[] {
  const raw = secretFromEnv(env, 'MACHVON_WEBPUSH_RECEIPT_KEY', read);
  if (raw === undefined) return [];
  const keys = raw.split(',').map((key) => key.trim());
  return keys.every((key) => key.length >= MIN_RECEIPT_KEY_CHARACTERS) ? keys : [];
}

// ---- how far the channel has been proven -------------------------------------------------------------------------------------------------------------

/**
 * `MOCK`: no VAPID key, the stand-in runs. `PENDING_SPIKE`: the keys are set and the real sender runs, but nobody has checked it against the push services
 * of the browsers (docs/runbooks/web-push-spike.md). `VERIFIED`: the operator has run the spike and said so with `MACHVON_WEBPUSH_SPIKE_VERIFIED=true`.
 */
export type WebPushState = 'MOCK' | 'PENDING_SPIKE' | 'VERIFIED';

export function webPushStateOf(configured: boolean, env: Environment): WebPushState {
  if (!configured) return 'MOCK';
  return env.MACHVON_WEBPUSH_SPIKE_VERIFIED?.trim().toLowerCase() === 'true' ? 'VERIFIED' : 'PENDING_SPIKE';
}

// ---- the limit per tenant -----------------------------------------------------------------------------------------------------------------------------

export const DEFAULT_TENANT_PER_MINUTE = 600;
const MAX_TENANTS = 10_000;

/**
 * A token bucket for each tenant: `perMinute` messages, refilled continuously, so one tenant that floods the push services cannot use up the quota of the
 * key (which is shared by every tenant of the process) and make the others wait. The bucket lives in the process; a deployment with several processes
 * allows `perMinute` for each of them.
 */
export class TenantRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number = DEFAULT_TENANT_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one message for the tenant, or says how many seconds to wait. */
  take(tenantId: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    const refillPerMs = this.perMinute / 60_000;
    const bucket = this.buckets.get(tenantId) ?? { tokens: this.perMinute, at: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.at) * refillPerMs);
    bucket.at = now;
    this.buckets.delete(tenantId);
    if (this.buckets.size >= MAX_TENANTS) this.buckets.delete(this.buckets.keys().next().value as string);
    this.buckets.set(tenantId, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)) };
  }
}

export function tenantLimitFromEnv(env: Environment): number {
  const value = Number(env.MACHVON_WEBPUSH_TENANT_PER_MINUTE);
  return Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : DEFAULT_TENANT_PER_MINUTE;
}
