import { SummaryCache } from '../../src/modules/ctr/summary-cache';

describe('the cache of the summary of a contract (ST-CTR-004)', () => {
  it('keys an entry by the tenant, the contract and its version', () => {
    expect(SummaryCache.keyOf('t1', 'c1', 3)).toBe('t1:c1:3');
    expect(SummaryCache.keyOf('t1', 'c1', 4)).not.toBe(SummaryCache.keyOf('t1', 'c1', 3));
    expect(SummaryCache.keyOf('t2', 'c1', 3)).not.toBe(SummaryCache.keyOf('t1', 'c1', 3));
  });

  it('returns what was stored until the time to live has passed, and not after', () => {
    let clock = 1_000;
    const cache = new SummaryCache<string>(60_000, 10, () => clock);
    cache.set('a', 'first');
    expect(cache.get('a')).toBe('first');
    clock += 59_999;
    expect(cache.get('a')).toBe('first');
    clock += 1;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('starts the time again when an entry is written again, and has nothing for a key it never saw', () => {
    let clock = 0;
    const cache = new SummaryCache<number>(100, 10, () => clock);
    expect(cache.get('x')).toBeUndefined();
    cache.set('x', 1);
    clock = 90;
    cache.set('x', 2);
    clock = 150;
    expect(cache.get('x')).toBe(2);
  });

  it('drops the entries under a prefix and none of the others', () => {
    const cache = new SummaryCache<number>(60_000, 10, () => 0);
    cache.set('t:a:pay:ledger:c1:v1:x', 1);
    cache.set('t:a:pay:ledger:c1:v2:y', 2);
    cache.set('t:a:pay:ledger:c2:v1:x', 3);
    expect(cache.deletePrefix('t:a:pay:ledger:c1:')).toBe(2);
    expect(cache.get('t:a:pay:ledger:c1:v1:x')).toBeUndefined();
    expect(cache.get('t:a:pay:ledger:c2:v1:x')).toBe(3);
    expect(cache.deletePrefix('t:a:pay:ledger:c9:')).toBe(0);
  });

  it('keeps the most recent entries only: the oldest leaves when the capacity is full', () => {
    const cache = new SummaryCache<number>(60_000, 2, () => 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 3);
    cache.set('c', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(3);
    expect(cache.get('c')).toBe(4);
    expect(cache.size).toBe(2);
  });

  it('uses a minute and a thousand entries unless told otherwise', () => {
    const cache = new SummaryCache<number>();
    for (let n = 0; n < 1100; n += 1) cache.set(String(n), n);
    expect(cache.size).toBe(1000);
    expect(cache.get('0')).toBeUndefined();
    expect(cache.get('1099')).toBe(1099);
  });
});
