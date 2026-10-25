import { addDays, addMonthsClamped, billingPeriod, billingPeriodAt, cycleMonths, daysInPeriod, prorationOf } from '../src/index';

describe('cycleMonths', () => {
  it('is 1, 3 and 12 months, and a contract term is billed by the year', () => {
    expect(['MONTHLY', 'QUARTERLY', 'ANNUAL', 'CONTRACT_TERM'].map((cycle) => cycleMonths(cycle as 'MONTHLY'))).toEqual([1, 3, 12, 12]);
  });
});

describe('addMonthsClamped and addDays', () => {
  it('counts months from the anchor and clamps to the last day of a shorter month', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonthsClamped('2026-12-31', 12)).toBe('2027-12-31');
    expect(addMonthsClamped('2026-05-31', 0)).toBe('2026-05-31');
  });

  it('adds days across months, years and leap days, forwards and backwards', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2026-01-01', 0)).toBe('2026-01-01');
  });

  it('refuses what is not a calendar day', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '', '2026-1-1']) expect(() => addDays(bad, 1)).toThrow(RangeError);
  });
});

describe('billingPeriod', () => {
  it('starts each period where the one before ended and counts both ends', () => {
    expect(billingPeriod('2026-01-01', 'ANNUAL', 0)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(billingPeriod('2026-01-01', 'ANNUAL', 1)).toEqual({ start: '2027-01-01', end: '2027-12-31' });
    expect(billingPeriod('2026-01-01', 'QUARTERLY', 3)).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(billingPeriod('2026-01-01', 'MONTHLY', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('does not let an anchor on the 31st drift to the 28th after a short month', () => {
    expect(billingPeriod('2026-01-31', 'MONTHLY', 0)).toEqual({ start: '2026-01-31', end: '2026-02-27' });
    expect(billingPeriod('2026-01-31', 'MONTHLY', 1)).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    expect(billingPeriod('2026-01-31', 'MONTHLY', 2)).toEqual({ start: '2026-03-31', end: '2026-04-29' });
  });

  it('leaves no gap and no overlap between consecutive periods', () => {
    for (const cycle of ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const) {
      for (const anchor of ['2026-01-31', '2026-02-28', '2027-12-31', '2028-02-29']) {
        for (let index = 0; index < 30; index += 1) {
          expect(addDays(billingPeriod(anchor, cycle, index).end, 1)).toBe(billingPeriod(anchor, cycle, index + 1).start);
        }
      }
    }
  });
});

describe('billingPeriodAt', () => {
  it('finds the period that holds a day, at its first and last day and in between', () => {
    expect(billingPeriodAt('2026-01-01', 'ANNUAL', '2026-01-01')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(billingPeriodAt('2026-01-01', 'ANNUAL', '2026-12-31')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(billingPeriodAt('2026-01-01', 'ANNUAL', '2027-01-01')).toEqual({ start: '2027-01-01', end: '2027-12-31' });
    expect(billingPeriodAt('2026-01-01', 'ANNUAL', '2026-02-15')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('is nothing before the anchor', () => {
    expect(billingPeriodAt('2026-01-01', 'MONTHLY', '2025-12-31')).toBeUndefined();
  });

  it('agrees with the periods it is looked up from, for every day of three years, also for an anchor on the 31st', () => {
    for (const cycle of ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const) {
      for (const anchor of ['2026-01-31', '2026-03-15', '2028-02-29']) {
        for (let offset = 0; offset < 3 * 366; offset += 1) {
          const day = addDays(anchor, offset);
          const period = billingPeriodAt(anchor, cycle, day);
          expect(period).toBeDefined();
          if (period !== undefined) expect([period.start <= day, day <= period.end]).toEqual([true, true]);
        }
      }
    }
  });
});

describe('daysInPeriod', () => {
  it('counts both ends, in a leap year too', () => {
    expect(daysInPeriod({ start: '2026-01-01', end: '2026-12-31' })).toBe(365);
    expect(daysInPeriod({ start: '2028-01-01', end: '2028-12-31' })).toBe(366);
    expect(daysInPeriod({ start: '2026-02-01', end: '2026-02-28' })).toBe(28);
    expect(daysInPeriod({ start: '2026-02-01', end: '2026-02-01' })).toBe(1);
  });
});

describe('prorationOf (BR-SAS-08, UAT-AC155)', () => {
  const period = { start: '2026-01-01', end: '2026-12-31' };

  it('charges 320,000,000 VND for the upgrade of a 365-day year on day 46', () => {
    expect(prorationOf({ oldPriceVnd: '365000000', newPriceVnd: '730000000', today: '2026-02-15', period })).toEqual({ amountVnd: '320000000', usedDays: 45, remainingDays: 320, totalDays: 365 });
  });

  it('charges the whole difference on the first day and a fraction of a dong, so nothing, on the last', () => {
    expect(prorationOf({ oldPriceVnd: '100', newPriceVnd: '365', today: '2026-01-01', period }).amountVnd).toBe('265');
    expect(prorationOf({ oldPriceVnd: '100', newPriceVnd: '365', today: '2026-01-01', period }).remainingDays).toBe(365);
    expect(prorationOf({ oldPriceVnd: '100', newPriceVnd: '365', today: '2026-12-31', period }).remainingDays).toBe(1);
    expect(prorationOf({ oldPriceVnd: '100', newPriceVnd: '365', today: '2026-12-31', period }).amountVnd).toBe('0');
  });

  it('rounds down to the dong, never up', () => {
    // 1000 * 1/3 = 333.33..
    expect(prorationOf({ oldPriceVnd: '0', newPriceVnd: '1000', today: '2026-02-01', period: { start: '2026-02-01', end: '2026-02-03' } }).amountVnd).toBe('1000');
    expect(prorationOf({ oldPriceVnd: '0', newPriceVnd: '1000', today: '2026-02-02', period: { start: '2026-02-01', end: '2026-02-03' } }).amountVnd).toBe('666');
    expect(prorationOf({ oldPriceVnd: '0', newPriceVnd: '1000', today: '2026-02-03', period: { start: '2026-02-01', end: '2026-02-03' } }).amountVnd).toBe('333');
  });

  it('is exact for amounts beyond the safe range of a number', () => {
    const price = '9'.repeat(24);
    expect(prorationOf({ oldPriceVnd: '0', newPriceVnd: price, today: '2026-01-01', period }).amountVnd).toBe(price);
    expect(prorationOf({ oldPriceVnd: '0', newPriceVnd: price, today: '2026-07-02', period }).amountVnd).toBe(((BigInt(price) * 183n) / 365n).toString());
  });

  it('charges nothing for a plan that costs the same or less', () => {
    expect(prorationOf({ oldPriceVnd: '730', newPriceVnd: '365', today: '2026-02-15', period }).amountVnd).toBe('0');
    expect(prorationOf({ oldPriceVnd: '365', newPriceVnd: '365', today: '2026-02-15', period }).amountVnd).toBe('0');
  });

  it('counts a day before the period as none used, and a day after it as all used', () => {
    expect(prorationOf({ oldPriceVnd: '0', newPriceVnd: '365', today: '2025-12-01', period })).toMatchObject({ usedDays: 0, remainingDays: 365, amountVnd: '365' });
    expect(prorationOf({ oldPriceVnd: '0', newPriceVnd: '365', today: '2027-03-01', period })).toMatchObject({ usedDays: 365, remainingDays: 0, amountVnd: '0' });
  });

  it('refuses a price that is not whole VND', () => {
    for (const bad of ['-1', '1.5', '', 'abc', '1'.repeat(25)]) {
      expect(() => prorationOf({ oldPriceVnd: bad, newPriceVnd: '1', today: '2026-02-15', period })).toThrow(RangeError);
      expect(() => prorationOf({ oldPriceVnd: '1', newPriceVnd: bad, today: '2026-02-15', period })).toThrow(RangeError);
    }
  });
});
