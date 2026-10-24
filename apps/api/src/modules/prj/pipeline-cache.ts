import { createHash } from 'node:crypto';
import { tenantKey } from '@machvon/kernel';

/** How long a page of the project bank may be served from memory (PRJ 3.1 section 9: `t:{tenant}:prj:pipeline:{stage}`, 60 seconds). */
export const PIPELINE_CACHE_TTL_SECONDS = 60;

const PREFIX_PARTS = ['prj', 'pipeline'] as const;

/**
 * The cache of the pages of the project bank. A page depends on the stage asked for and on the scope of the caller, so the key is the stage
 * with a digest of everything else that decides the page; two callers whose scopes differ never share an entry. A change of the stage of
 * any project of the tenant clears every entry of the tenant, and the time to live bounds how long a change made by another process matters.
 */
export interface PipelineCache {
  get(tenantId: string, stage: string, variant: string): Promise<string | undefined>;
  set(tenantId: string, stage: string, variant: string, value: string): Promise<void>;
  invalidate(tenantId: string): Promise<void>;
}

/** The digest that tells two pages of one stage apart: the scope predicate, its parameters, the filter, the size and the cursor. */
export function pipelineVariant(parts: { scopeSql: string; scopeParams: readonly unknown[]; group: string | undefined; limit: number; cursor: string | undefined }): string {
  return createHash('sha256').update(JSON.stringify([parts.scopeSql, parts.scopeParams, parts.group ?? null, parts.limit, parts.cursor ?? null])).digest('hex').slice(0, 32);
}

/** In-process cache; a shared one replaces it behind the same port when the API runs on more than one node. */
export class InMemoryPipelineCache implements PipelineCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlSeconds: number = PIPELINE_CACHE_TTL_SECONDS,
  ) {}

  async get(tenantId: string, stage: string, variant: string): Promise<string | undefined> {
    const key = tenantKey(tenantId, ...PREFIX_PARTS, stage, variant);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(tenantId: string, stage: string, variant: string, value: string): Promise<void> {
    this.entries.set(tenantKey(tenantId, ...PREFIX_PARTS, stage, variant), { value, expiresAt: this.now() + this.ttlSeconds * 1000 });
  }

  async invalidate(tenantId: string): Promise<void> {
    const prefix = `${tenantKey(tenantId, ...PREFIX_PARTS)}:`;
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  /** The stored keys, for tests that check the tenant prefix. */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}

/** The cache of this process, used where none is bound: the commands, the reads and the consumer of events share it. */
export const SHARED_PIPELINE_CACHE: PipelineCache = new InMemoryPipelineCache();
