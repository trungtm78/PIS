import { DomainError } from '../src/errors.ts';
import {
  assertBudgetDraft,
  assertPriceDraft,
  availableOf,
  costOf,
  crossesThreshold,
  decideReservation,
  estimateVnd,
  fromScaled,
  periodStartOf,
  settlementOf,
  toScaled,
} from '../src/llm-finops.ts';
import type { Price, ScopeBalance } from '../src/llm-finops.ts';

const thrown = (action: () => unknown): DomainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const PV1: Price = { inputPerMillion: '2.00', cachedPerMillion: '0.50', outputPerMillion: '8.00', cachedSemantics: 'INCLUDED_IN_INPUT', fxRateToVnd: '25400' };
const balance = (kind: ScopeBalance['kind'], limit: number, settled: number, reserved = 0, blocked = false): ScopeBalance => ({ kind, limitVnd: BigInt(limit), settledVnd: BigInt(settled), reservedOpenVnd: BigInt(reserved), blocked });

describe('the cost of an attempt (ST-LLM-003, LLM BR-LLM-04)', () => {
  it('AC-ST-LLM-003-3: UAT-AC461 costs 120,000 input of which 100,000 cached, and 10,000 output, at 2.00, 0.50 and 8.00 per million, as 0.17 USD and 4,318 VND, reasoning not added twice', () => {
    const cost = costOf({ inputTotal: 120_000, cachedInput: 100_000, outputTotal: 10_000 }, PV1);
    expect(cost).toEqual({ noncachedInput: 20_000, cost: '0.17000000', costVnd: '4318' });
  });

  it('AC-ST-LLM-003-3: UAT-AC461 gives the same figure when the price counts the cached tokens apart: 20,000 input and 100,000 cached', () => {
    const apart = costOf({ inputTotal: 20_000, cachedInput: 100_000, outputTotal: 10_000 }, { ...PV1, cachedSemantics: 'SEPARATE' });
    expect(apart).toEqual({ noncachedInput: 20_000, cost: '0.17000000', costVnd: '4318' });
  });

  it('rounds the dong half up, adds the fee of the tools, and keeps the cost to eight places', () => {
    // 1 token at 0.5 per million is 0.0000005 currency; at 1,000 dong it is 0.0005 dong: nothing; 1,000 tokens make 0.5 dong, which goes up.
    expect(costOf({ inputTotal: 1_000, cachedInput: 0, outputTotal: 0 }, { ...PV1, inputPerMillion: '0.50', fxRateToVnd: '1000' }).costVnd).toBe('1');
    expect(costOf({ inputTotal: 999, cachedInput: 0, outputTotal: 0 }, { ...PV1, inputPerMillion: '0.50', fxRateToVnd: '1000' }).costVnd).toBe('0');
    const withTool = costOf({ inputTotal: 0, cachedInput: 0, outputTotal: 0, toolFee: '0.01' }, PV1);
    expect(withTool).toEqual({ noncachedInput: 0, cost: '0.01000000', costVnd: '254' });
    expect(costOf({ inputTotal: 1, cachedInput: 0, outputTotal: 0 }, { ...PV1, inputPerMillion: '0.00000001' }).cost).toBe('0.00000000');
  });

  it('rounds the dong once, from the exact amount: a cost that is just below half a dong does not go up because its currency amount was rounded first', () => {
    // One token at 19.68503937 per million and 25,400 dong to the unit is 0.49999999998 dong.
    const price = { ...PV1, inputPerMillion: '19.68503937', fxRateToVnd: '25400' };
    expect(costOf({ inputTotal: 1, cachedInput: 0, outputTotal: 0 }, price)).toEqual({ noncachedInput: 1, cost: '0.00001969', costVnd: '0' });
    // The same figure just over half goes up.
    expect(costOf({ inputTotal: 1, cachedInput: 0, outputTotal: 0 }, { ...price, inputPerMillion: '19.68503938' }).costVnd).toBe('1');
    // The fee of the tools takes part in the exact amount.
    expect(costOf({ inputTotal: 0, cachedInput: 0, outputTotal: 0, toolFee: '0.00001968' }, { ...PV1, fxRateToVnd: '25400' }).costVnd).toBe('0');
    expect(costOf({ inputTotal: 0, cachedInput: 0, outputTotal: 0, toolFee: '0.00001970' }, { ...PV1, fxRateToVnd: '25400' }).costVnd).toBe('1');
  });

  it('refuses a fee of the tools that is negative or has more digits than the column holds', () => {
    const usage = { inputTotal: 1000, cachedInput: 0, outputTotal: 0 };
    expect(thrown(() => costOf({ ...usage, toolFee: '-0.01' }, PV1)).detail).toBe('tool_fee');
    expect(thrown(() => costOf({ ...usage, toolFee: '10000000000000000' }, PV1)).detail).toBe('tool_fee');
    expect(thrown(() => costOf({ ...usage, toolFee: 'abc' }, PV1)).detail).toBe('tool_fee');
    expect(costOf({ ...usage, toolFee: '0' }, PV1).costVnd).toBe(costOf(usage, PV1).costVnd);
  });

  it('refuses tokens that are not counts and cached tokens above the input when they are part of it', () => {
    expect(thrown(() => costOf({ inputTotal: -1, cachedInput: 0, outputTotal: 0 }, PV1)).detail).toBe('input_total');
    expect(thrown(() => costOf({ inputTotal: 1.5, cachedInput: 0, outputTotal: 0 }, PV1)).detail).toBe('input_total');
    expect(thrown(() => costOf({ inputTotal: 10, cachedInput: 11, outputTotal: 0 }, PV1)).detail).toBe('cached_input');
    expect(() => costOf({ inputTotal: 10, cachedInput: 11, outputTotal: 0 }, { ...PV1, cachedSemantics: 'SEPARATE' })).not.toThrow();
  });

  it('keeps a rate to eight places as it is and refuses what is not a decimal', () => {
    expect(fromScaled(toScaled('123.45678901'))).toBe('123.45678901');
    expect(fromScaled(toScaled('-0.5'))).toBe('-0.50000000');
    expect(() => toScaled('1e5')).toThrow();
    expect(() => toScaled('1.123456789')).toThrow();
  });

  it('estimates the most a request can cost: its input bound, its output cap and what the fallbacks may add', () => {
    expect(estimateVnd({ inputBound: 120_000, outputCap: 10_000 }, PV1)).toBe('8128');
    expect(estimateVnd({ inputBound: 120_000, outputCap: 10_000, fallbackCapVnd: '1000' }, PV1)).toBe('9128');
    // Never less than any mix of cached and uncached tokens can cost, also when the cached tokens are the dearer ones.
    const dearCached = { ...PV1, inputPerMillion: '1.00', cachedPerMillion: '2.00', outputPerMillion: '0', fxRateToVnd: '1' };
    expect(estimateVnd({ inputBound: 1_000_000, outputCap: 0 }, dearCached)).toBe('2');
    for (const cachedInput of [0, 400_000, 1_000_000]) {
      expect(BigInt(estimateVnd({ inputBound: 1_000_000, outputCap: 0 }, dearCached))).toBeGreaterThanOrEqual(BigInt(costOf({ inputTotal: 1_000_000, cachedInput, outputTotal: 0 }, dearCached).costVnd));
    }
    expect(BigInt(estimateVnd({ inputBound: 1_000_000, outputCap: 0 }, { ...dearCached, cachedSemantics: 'SEPARATE' }))).toBeGreaterThanOrEqual(BigInt(costOf({ inputTotal: 0, cachedInput: 1_000_000, outputTotal: 0 }, { ...dearCached, cachedSemantics: 'SEPARATE' }).costVnd));
  });
});

describe('the reservation against the budgets of a request (ST-LLM-003, LLM BR-LLM-05)', () => {
  it('AC-ST-LLM-003-1: UAT-AC18 holds a request that fits in what is left at every scope and names the first scope that cannot take it', () => {
    expect(availableOf(balance('TENANT', 1_000_000, 300_000))).toBe(700_000n);
    expect(decideReservation([balance('TENANT', 1_000_000, 300_000)], 400_000n)).toEqual({ ok: true });
    expect(decideReservation([balance('TENANT', 1_000_000, 300_000, 400_000)], 400_000n)).toEqual({ ok: false, scope: 'TENANT', reason: 'EXCEEDED', shortBy: 100_000n });
    // The scopes are judged in the order they are locked, whatever order they come in.
    const decision = decideReservation([balance('UNIT', 100_000, 20_000), balance('TENANT', 1_000_000, 0)], 90_000n);
    expect(decision).toEqual({ ok: false, scope: 'UNIT', reason: 'EXCEEDED', shortBy: 10_000n });
  });

  it('AC-ST-LLM-003-2: UAT-AC460 lets exactly the estimate through at the last dong and refuses one dong more', () => {
    expect(decideReservation([balance('UNIT', 80_000, 0)], 80_000n).ok).toBe(true);
    expect(decideReservation([balance('UNIT', 80_000, 0)], 80_001n)).toMatchObject({ ok: false, scope: 'UNIT' });
  });

  it('refuses a scope that is blocked, whatever is left in it', () => {
    expect(decideReservation([balance('PROJECT', 1_000_000, 0, 0, true)], 1n)).toMatchObject({ ok: false, scope: 'PROJECT', reason: 'BLOCKED' });
  });

  it('AC-ST-LLM-003-1: UAT-AC18 releases what was reserved and not used, and calls actual above reserved an exception that leaves the numbers as they are', () => {
    expect(settlementOf({ reserved: 400_000n, actual: 180_000n })).toEqual({ released: 220_000n, exception: false });
    expect(settlementOf({ reserved: 100n, actual: 100n })).toEqual({ released: 0n, exception: false });
    expect(settlementOf({ reserved: 100n, actual: 101n })).toEqual({ released: 0n, exception: true });
  });
});

describe('periods and the soft threshold (ST-LLM-003, LLM BR-LLM-07)', () => {
  it('begins a month, a quarter and a year on their first day', () => {
    expect(periodStartOf('MONTH', '2026-10-28')).toBe('2026-10-01');
    expect(periodStartOf('QUARTER', '2026-11-15')).toBe('2026-10-01');
    expect(periodStartOf('QUARTER', '2026-03-31')).toBe('2026-01-01');
    expect(periodStartOf('YEAR', '2026-12-31')).toBe('2026-01-01');
  });

  it('AC-ST-LLM-003-6: UAT-AC469 crosses 80 percent of a million at 800,000, once, by the settlement that gets there', () => {
    expect(crossesThreshold(790_000n, 810_000n, 1_000_000n, 80)).toBe(true);
    expect(crossesThreshold(810_000n, 830_000n, 1_000_000n, 80)).toBe(false);
    expect(crossesThreshold(790_000n, 799_999n, 1_000_000n, 80)).toBe(false);
    expect(crossesThreshold(790_000n, 800_000n, 1_000_000n, 80)).toBe(true);
    expect(crossesThreshold(0n, 1n, 0n, 80)).toBe(false);
    expect(crossesThreshold(0n, 1n, 3n, 50)).toBe(false);
    expect(crossesThreshold(0n, 2n, 3n, 50)).toBe(true);
  });
});

describe('budgets and price versions (ST-LLM-003)', () => {
  const draft: { scopeKind: string; scopeRefId: string | null; period: string; limitVnd: string; softThresholdPct: number; maxRequestsPerDay: number | null; maxConcurrent: number | null } = { scopeKind: 'TENANT', scopeRefId: null, period: 'MONTH', limitVnd: '1000000', softThresholdPct: 80, maxRequestsPerDay: null, maxConcurrent: null };

  it('takes a tenant budget with no reference and any other with one, and refuses the rest', () => {
    expect(() => assertBudgetDraft(draft)).not.toThrow();
    expect(() => assertBudgetDraft({ ...draft, scopeKind: 'UNIT', scopeRefId: 'u1' })).not.toThrow();
    const field = (change: Partial<typeof draft>) => thrown(() => assertBudgetDraft({ ...draft, ...change })).detail;
    expect(field({ scopeKind: 'UNIT' })).toBe('scope_ref_id');
    expect(field({ scopeRefId: 'u1' })).toBe('scope_ref_id');
    expect(field({ scopeKind: 'TEAM' })).toBe('scope_kind');
    expect(field({ period: 'WEEK' })).toBe('period');
    expect(field({ limitVnd: '-5' })).toBe('limit_vnd');
    expect(field({ softThresholdPct: 0 })).toBe('soft_threshold_pct');
    expect(field({ softThresholdPct: 101 })).toBe('soft_threshold_pct');
    expect(field({ maxConcurrent: 0 })).toBe('max_concurrent');
    expect(field({ maxRequestsPerDay: 1.5 })).toBe('max_requests_per_day');
    expect(field({ maxConcurrent: 2_147_483_648 })).toBe('max_concurrent');
    expect(field({ maxRequestsPerDay: 2_147_483_648 })).toBe('max_requests_per_day');
    expect(() => assertBudgetDraft({ ...draft, maxConcurrent: 2_147_483_647 })).not.toThrow();
  });

  it('AC-ST-LLM-003-3: UAT-AC461 asks a price for its source, and for rates and an exchange rate that are numbers', () => {
    const price = { provider: 'p', currency: 'USD', inputPerMillion: '2.00', cachedPerMillion: '0.50', outputPerMillion: '8.00', fxRateToVnd: '25400', sourceUrl: 'https://provider.example/pricing' };
    expect(() => assertPriceDraft(price)).not.toThrow();
    expect(thrown(() => assertPriceDraft({ ...price, sourceUrl: 'pricing page' })).code).toBe('SOURCE_URL_REQUIRED');
    expect(thrown(() => assertPriceDraft({ ...price, currency: 'usd' })).detail).toBe('currency');
    expect(thrown(() => assertPriceDraft({ ...price, inputPerMillion: '-1' })).detail).toBe('input_per_million');
    expect(thrown(() => assertPriceDraft({ ...price, outputPerMillion: 'abc' })).detail).toBe('output_per_million');
    expect(thrown(() => assertPriceDraft({ ...price, fxRateToVnd: '0' })).detail).toBe('fx_rate_to_vnd');
    // What the columns cannot hold is refused before it reaches them: 16 digits before the point, 8 after.
    expect(() => assertPriceDraft({ ...price, inputPerMillion: '9999999999999999.99999999' })).not.toThrow();
    expect(thrown(() => assertPriceDraft({ ...price, inputPerMillion: '10000000000000000' })).detail).toBe('input_per_million');
    expect(thrown(() => assertPriceDraft({ ...price, fxRateToVnd: '10000000000000000' })).detail).toBe('fx_rate_to_vnd');
    expect(thrown(() => costOf({ inputTotal: 9_000_000_000_000, cachedInput: 0, outputTotal: 0 }, { ...PV1, inputPerMillion: '9999999999999999', fxRateToVnd: '9999999999999999' })).detail).toBe('cost');
  });
});
