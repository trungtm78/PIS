import { assertThresholds, evaluateAvc, hundredthsOf } from '../src/cap-avc';
import type { AvcFigures, AvcThresholds } from '../src/cap-avc';

const figures = (allocated: string, committed = '0', disbursed = '0', reserved = '0'): AvcFigures => ({ allocatedVnd: allocated, reservedVnd: reserved, committedVnd: committed, disbursedVnd: disbursed });
const policy = (warnPct: string, blockPct: string, includeReservations = true): AvcThresholds => ({ policyId: 'p1', warnPct, blockPct, includeReservations });

describe('evaluateAvc (BR-CAP-06)', () => {
  it('is OK below the warning threshold, WARN from it up to and including the block threshold, and BLOCK above it', () => {
    const thresholds = policy('90', '100');
    expect(evaluateAvc(figures('1000', '899'), thresholds).state).toBe('OK');
    expect(evaluateAvc(figures('1000', '900'), thresholds).state).toBe('WARN');
    expect(evaluateAvc(figures('1000', '1000'), thresholds).state).toBe('WARN');
    expect(evaluateAvc(figures('1000', '1001'), thresholds)).toMatchObject({ state: 'BLOCK', reason: 'ABOVE_BLOCK' });
  });

  it('adds the amount asked for to what is used and reports the share after it, to two decimals, rounded down', () => {
    expect(evaluateAvc(figures('1000', '500'), policy('90', '100'), '395')).toMatchObject({ state: 'OK', consumptionPct: '89.50', usedVnd: '895' });
    expect(evaluateAvc(figures('3', '1'), policy('90', '100'))).toMatchObject({ consumptionPct: '33.33', usedVnd: '1' });
    expect(evaluateAvc(figures('1000'), policy('90', '100'), '0')).toMatchObject({ state: 'OK', consumptionPct: '0.00', availableVnd: '1000' });
  });

  it('lets exactly the allocation through at a block threshold of 100 and not one VND more, whatever the rounding of the percentage', () => {
    // 999,999,999,999 of 1,000,000,000,000 is 99.9999999999 percent: the shown 99.99 never decides.
    expect(evaluateAvc(figures('1000000000000', '999999999999'), policy('95', '100')).state).toBe('WARN');
    expect(evaluateAvc(figures('1000000000000', '1000000000000'), policy('95', '100')).state).toBe('WARN');
    expect(evaluateAvc(figures('1000000000000', '1000000000001'), policy('95', '100')).state).toBe('BLOCK');
  });

  it('blocks every use of an allocation of nothing (ZERO_ALLOCATION)', () => {
    expect(evaluateAvc(figures('0'), policy('90', '100'))).toMatchObject({ state: 'BLOCK', reason: 'ZERO_ALLOCATION', consumptionPct: '0.00', availableVnd: '0' });
    expect(evaluateAvc(figures('0'), policy('90', '100'), '1')).toMatchObject({ state: 'BLOCK', reason: 'ZERO_ALLOCATION' });
  });

  it('counts the reservations only when the policy does', () => {
    expect(evaluateAvc(figures('1000', '0', '0', '950'), policy('90', '100', true))).toMatchObject({ state: 'WARN', usedVnd: '950', availableVnd: '50' });
    expect(evaluateAvc(figures('1000', '0', '0', '950'), policy('90', '100', false))).toMatchObject({ state: 'OK', usedVnd: '0', availableVnd: '1000' });
  });

  it('never reports a negative amount available, and understands thresholds of one decimal place', () => {
    expect(evaluateAvc(figures('1000', '1200'), policy('90', '100')).availableVnd).toBe('0');
    const thresholds = policy('80.5', '99.25');
    expect(evaluateAvc(figures('10000', '8049'), thresholds).state).toBe('OK');
    expect(evaluateAvc(figures('10000', '8050'), thresholds).state).toBe('WARN');
    expect(evaluateAvc(figures('10000', '9925'), thresholds).state).toBe('WARN');
    expect(evaluateAvc(figures('10000', '9926'), thresholds).state).toBe('BLOCK');
  });

  it('refuses an amount that is not whole VND', () => {
    expect(() => evaluateAvc(figures('1000'), policy('90', '100'), '1.5')).toThrow();
    expect(() => evaluateAvc(figures('1000'), policy('90', '100'), '-1')).toThrow();
  });
});

describe('assertThresholds (AC-ST-CAP-005-2)', () => {
  it('takes a warning not above the block and a block of at most 100', () => {
    expect(assertThresholds('90', '100')).toEqual({ warn: 9000n, block: 10000n });
    expect(assertThresholds('0', '0')).toEqual({ warn: 0n, block: 0n });
    expect(assertThresholds('85.5', '85.5')).toEqual({ warn: 8550n, block: 8550n });
  });

  it.each([
    ['warn above block', '95', '90', 'warn_pct', 'WARN_ABOVE_BLOCK'],
    ['a block above 100', '90', '100.01', 'block_pct', 'ABOVE_100'],
    ['a block of 150', '90', '150', 'block_pct', 'ABOVE_100'],
    ['a warning above 100', '101', '101', 'warn_pct', 'ABOVE_100'],
    ['a text that is not a percentage', 'abc', '100', 'warn_pct', 'NOT_A_PERCENTAGE'],
    ['three decimals', '90', '99.999', 'block_pct', 'NOT_A_PERCENTAGE'],
    ['a negative number', '-1', '100', 'warn_pct', 'NOT_A_PERCENTAGE'],
  ])('refuses %s with 422 AVC_THRESHOLD_INVALID', (_name, warn, block, field, problem) => {
    expect.assertions(2);
    try {
      assertThresholds(warn, block);
    } catch (error) {
      const failure = error as { code: string; status: number; detail: string; extensions: Record<string, unknown> };
      expect([failure.code, failure.status, failure.detail]).toEqual(['AVC_THRESHOLD_INVALID', 422, field]);
      expect(failure.extensions).toEqual({ threshold_problem: problem });
    }
  });

  it('reads a percentage as hundredths and refuses what is not one', () => {
    expect(hundredthsOf('100')).toBe(10000n);
    expect(hundredthsOf('0.5')).toBe(50n);
    expect(hundredthsOf('12.34')).toBe(1234n);
    expect(() => hundredthsOf('1.234')).toThrow();
  });
});
