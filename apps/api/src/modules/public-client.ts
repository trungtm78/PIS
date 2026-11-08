import { createHash, randomBytes } from 'node:crypto';
import { DomainError, KeyedRateLimiter } from '@machvon/kernel';

/**
 * What the public surfaces of lane GOV-12 (the portal and the anonymous channel) know about the caller: an opaque key made of the address and a secret that exists only in the memory of this process, so the address is
 * never stored, never logged and cannot be recovered from the key; a restart changes every key. The key is used for one thing, a rate limit that is held in memory as well. Nothing here is written to the database.
 */
const PROCESS_SECRET = randomBytes(32);

interface RequestLike {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

/** The opaque key of a caller for one portal; the same caller gets the same key on one process and a different key on another portal. */
export function clientKeyOf(request: RequestLike, scope: string): string {
  const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  return createHash('sha256').update(PROCESS_SECRET).update(`\n${scope}\n${address}`).digest('hex');
}

const limiters = new Map<string, KeyedRateLimiter>();

/** A limiter for a purpose, a limit and a window; one is made for each distinct triple and kept for the life of the process. */
function limiterFor(purpose: string, limit: number, windowSeconds: number): KeyedRateLimiter {
  const name = `${purpose}:${limit}:${windowSeconds}`;
  let found = limiters.get(name);
  if (found === undefined) {
    found = new KeyedRateLimiter({ limit, windowSeconds });
    limiters.set(name, found);
  }
  return found;
}

/** Counts one call of the caller against the limit; over it, the answer is 429 RATE_LIMIT with Retry-After. */
export function consumeRate(purpose: string, key: string, limit: number, windowSeconds: number): void {
  const verdict = limiterFor(purpose, limit, windowSeconds).consume(key);
  if (!verdict.allowed) throw new DomainError('RATE_LIMIT', 429, undefined, { headers: { 'Retry-After': String(verdict.retryAfterSeconds) } });
}

/** Only for tests: forgets every counter. */
export function resetPublicLimiters(): void {
  limiters.clear();
}

/** The limit that applies to a caller before the portal is known (an address that is not a portal costs the caller the same as one that is). */
export const ANONYMOUS_RATE_PER_MINUTE = 120;
