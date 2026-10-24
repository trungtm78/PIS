import { isIsoDate, periodsOverlap, shiftDays } from './effective-period.ts';
import type { EffectivePeriod } from './effective-period.ts';

const period = (from: string, until: string | null): EffectivePeriod => ({ from, until });

describe('effective periods of dated legal data (inclusive last day)', () => {
  it.each([
    ['2026-02-28', true],
    ['2028-02-29', true],
    ['2026-02-29', false],
    ['2026-13-01', false],
    ['2026-1-1', false],
    ['', false],
  ])('reads %s as a real day: %s', (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });

  it('moves a day across month, year and leap-day boundaries', () => {
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it.each([
    ['sharing the last day', period('2026-01-01', '2026-12-31'), period('2026-12-31', null), true],
    ['starting the day after the last day', period('2026-01-01', '2026-12-31'), period('2027-01-01', null), false],
    ['one open-ended inside the other', period('2026-01-01', null), period('2026-06-01', '2026-06-30'), true],
    ['two open-ended', period('2026-01-01', null), period('2030-01-01', null), true],
    ['an open-ended one that begins after a closed one ends', period('2030-01-01', null), period('2026-01-01', '2026-12-31'), false],
    ['a single day inside a period', period('2026-06-15', '2026-06-15'), period('2026-01-01', '2026-12-31'), true],
  ])('%s: overlap is %s, whichever side is asked', (_name, left, right, expected) => {
    expect(periodsOverlap(left, right)).toBe(expected);
    expect(periodsOverlap(right, left)).toBe(expected);
  });
});
