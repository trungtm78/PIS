/** How long an answer is served from the cache: the snapshot it is of does not change, so this only bounds the memory and how long a revoked scope could still be answered (its key has the scope in it). */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * The cache of the answers of BI (BI BR-BI-07). The key is made by `queryCacheKey`: it has the tenant, the metrics, the query, the snapshot and the scope hash in it, so a cached answer is shared by no one whose tenant,
 * scope, snapshot or query differs. In the process of the server; a restart empties it, which only costs a query.
 */
export class BiQueryCache {
  private readonly entries = new Map<string, Entry<unknown>>();

  get<T>(key: string, now: Date): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now.getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, now: Date): void {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now.getTime() + TTL_MS });
  }

  get size(): number {
    return this.entries.size;
  }
}
