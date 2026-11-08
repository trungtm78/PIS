import { MAX_SLOWDOWN, REFERENCE_BUDGET_MS, budgetFor, median, p95Of } from './support/perf-budget';

describe('the budget of a measured read, stretched by the speed of the machine', () => {
  it('keeps the reference budget on a machine as fast as the reference and on a faster one', () => {
    expect(budgetFor(100, 100)).toEqual({ factor: 1, budgetMs: REFERENCE_BUDGET_MS, tooSlow: false });
    expect(budgetFor(40, 100)).toEqual({ factor: 1, budgetMs: REFERENCE_BUDGET_MS, tooSlow: false });
  });

  it('stretches the budget in proportion to how much slower the machine measured', () => {
    expect(budgetFor(150, 100)).toEqual({ factor: 1.5, budgetMs: 1200, tooSlow: false });
    expect(budgetFor(250, 100).budgetMs).toBe(2000);
  });

  it('does not judge a machine more than three times slower than the reference', () => {
    expect(MAX_SLOWDOWN).toBe(3);
    expect(budgetFor(300, 100)).toEqual({ factor: 3, budgetMs: 2400, tooSlow: false });
    expect(budgetFor(301, 100)).toEqual({ factor: 3, budgetMs: 2400, tooSlow: true });
  });

  it('refuses a calibration that is not a positive finite timing', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => budgetFor(bad, 100)).toThrow(RangeError);
      expect(() => budgetFor(100, bad)).toThrow(RangeError);
    }
  });

  it('does not excuse a slow query: the stretch comes from the reference workload alone', () => {
    // On a machine as fast as the reference a query of 900 ms is over the budget; on one twice as slow (reference workload 200 ms for 100) a query that took 1,500 ms because of the machine passes and 1,700 ms does not.
    expect(900).toBeGreaterThan(budgetFor(100, 100).budgetMs);
    expect(1500).toBeLessThanOrEqual(budgetFor(200, 100).budgetMs);
    expect(1700).toBeGreaterThan(budgetFor(200, 100).budgetMs);
  });

  it('takes the median and the p95 of samples', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2);
    expect(() => median([])).toThrow(RangeError);
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(p95Of(samples)).toBe(19);
    expect(p95Of([7])).toBe(7);
    expect(p95Of([])).toBe(Number.POSITIVE_INFINITY);
  });
});
