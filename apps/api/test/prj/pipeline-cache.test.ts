import { InMemoryPipelineCache, PIPELINE_CACHE_TTL_SECONDS, pipelineVariant } from '../../src/modules/prj/pipeline-cache';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

describe('the cache of the pages of the project bank (ST-PRJ-002)', () => {
  it('keeps a page under the tenant and the stage for 60 seconds and forgets it after', async () => {
    let now = 1_000_000;
    const cache = new InMemoryPipelineCache(() => now);
    await cache.set(TENANT_A, 'PIPELINE', 'abc', '{"items":[]}');
    expect(cache.keys()).toEqual([`t:${TENANT_A}:prj:pipeline:PIPELINE:abc`]);
    expect(await cache.get(TENANT_A, 'PIPELINE', 'abc')).toBe('{"items":[]}');
    now += (PIPELINE_CACHE_TTL_SECONDS - 1) * 1000;
    expect(await cache.get(TENANT_A, 'PIPELINE', 'abc')).toBe('{"items":[]}');
    now += 1000;
    expect(await cache.get(TENANT_A, 'PIPELINE', 'abc')).toBeUndefined();
    expect(cache.keys()).toEqual([]);
    expect(PIPELINE_CACHE_TTL_SECONDS).toBe(60);
  });

  it('never gives a page of one tenant to another, and clears only the tenant that asks', async () => {
    const cache = new InMemoryPipelineCache();
    await cache.set(TENANT_A, 'PIPELINE', 'abc', 'a');
    await cache.set(TENANT_A, 'all', 'def', 'a-all');
    await cache.set(TENANT_B, 'PIPELINE', 'abc', 'b');
    expect(await cache.get(TENANT_B, 'PIPELINE', 'abc')).toBe('b');
    await cache.invalidate(TENANT_A);
    expect(await cache.get(TENANT_A, 'PIPELINE', 'abc')).toBeUndefined();
    expect(await cache.get(TENANT_A, 'all', 'def')).toBeUndefined();
    expect(await cache.get(TENANT_B, 'PIPELINE', 'abc')).toBe('b');
  });

  it('tells two pages apart by the scope, the group, the size and the cursor', () => {
    const base = { scopeSql: 'true', scopeParams: [] as unknown[], group: undefined as string | undefined, limit: 50, cursor: undefined as string | undefined };
    const variants = [
      pipelineVariant(base),
      pipelineVariant({ ...base, scopeSql: '(ou.path like $6)', scopeParams: ['/u1/%'] }),
      pipelineVariant({ ...base, scopeSql: '(ou.path like $6)', scopeParams: ['/u2/%'] }),
      pipelineVariant({ ...base, group: 'A' }),
      pipelineVariant({ ...base, limit: 20 }),
      pipelineVariant({ ...base, cursor: 'next' }),
    ];
    expect(new Set(variants).size).toBe(variants.length);
    expect(pipelineVariant(base)).toBe(pipelineVariant({ ...base }));
    expect(variants.every((variant) => /^[0-9a-f]{32}$/.test(variant))).toBe(true);
  });
});
