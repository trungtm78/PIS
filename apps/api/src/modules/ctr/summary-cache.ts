/**
 * A small cache with a time to live (ST-CTR-004, getContractSummary): the summary of a contract is read far more often than it changes, and it is keyed by the tenant, the contract and its
 * version, so the move of the contract to its next version is an invalidation by itself. The time to live bounds what the version cannot see (the ledger totals that other modules move).
 * The store holds the most recent entries only; an entry never leaves the process.
 */
export class SummaryCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = 60_000,
    private readonly capacity: number = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  static keyOf(tenantId: string, contractId: string, version: number): string {
    return `${tenantId}:${contractId}:${version}`;
  }

  get(key: string): T | undefined {
    const found = this.entries.get(key);
    if (found === undefined) return undefined;
    if (found.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return found.value;
  }

  set(key: string, value: T): void {
    // A key is written again at the end of the order, so the oldest entry is the first one the map holds.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drops every entry whose key starts with the prefix (what an event about one contract invalidates); gives the number dropped. */
  deletePrefix(prefix: string): number {
    let dropped = 0;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  get size(): number {
    return this.entries.size;
  }
}
