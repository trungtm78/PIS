import { ISSUE_MAX_ATTEMPTS, SUSPENSION_PROPOSAL_DAYS, invoiceCodeOf, invoiceTotals, priceForDays, isBillingPeriod, isInvoiceOverdue, nextIssueAttempt, priceLine, suspensionProposed, usageLine, vatOf } from '../src/sas-billing';
import type { MeteredFeature } from '../src/sas-billing';

describe('the money rules of the billing run (ST-SAS-011, BR-SAS-13 and BR-SAS-14)', () => {
  it('rounds the VAT of a line half up to whole VND, by category', () => {
    expect(vatOf('1000000', 'NOT_SUBJECT')).toBe('0');
    expect(vatOf('1000000', 'VAT_0')).toBe('0');
    expect(vatOf('1000000', 'VAT_8')).toBe('80000');
    expect(vatOf('1000000', 'VAT_10')).toBe('100000');
    // 5% of 10 is 0.5: half goes up. 8% of 6 is 0.48: down. 8% of 7 is 0.56: up.
    expect(vatOf('10', 'VAT_5')).toBe('1');
    expect(vatOf('6', 'VAT_8')).toBe('0');
    expect(vatOf('7', 'VAT_8')).toBe('1');
    expect(vatOf('0', 'VAT_10')).toBe('0');
  });

  it('gives a line that takes money off the VAT of its own size with the opposite sign', () => {
    expect(vatOf('-10', 'VAT_5')).toBe('-1');
    expect(vatOf('-7', 'VAT_8')).toBe('-1');
    expect(vatOf('-1000000', 'VAT_10')).toBe('-100000');
  });

  it('refuses what is not an amount of whole VND', () => {
    expect(() => vatOf('1.5', 'VAT_10')).toThrow(RangeError);
    expect(() => vatOf('', 'VAT_10')).toThrow(RangeError);
    expect(() => vatOf('1e3', 'VAT_10')).toThrow(RangeError);
  });

  it('adds the totals from the lines: the VAT is the sum of the VAT of each line, not the VAT of the sum', () => {
    const lines = [
      priceLine({ kind: 'SUBSCRIPTION', description: 'plan', amountVnd: '7', vatCategory: 'VAT_8' }),
      priceLine({ kind: 'USAGE', description: 'usage', amountVnd: '7', vatCategory: 'VAT_8' }),
      priceLine({ kind: 'ADJUSTMENT', description: 'proration', amountVnd: '-3', vatCategory: 'VAT_8' }),
    ];
    // 1 + 1 + 0 (-0.24 rounds to 0), where the VAT of 11 would be 1.
    expect(invoiceTotals(lines)).toEqual({ subtotalVnd: '11', vatVnd: '2', totalVnd: '13' });
    expect(invoiceTotals([])).toEqual({ subtotalVnd: '0', vatVnd: '0', totalVnd: '0' });
  });

  describe('the line of use beyond the limit', () => {
    const feature: MeteredFeature = { featureCode: 'ai_calls', meter: 'ai_call', limit: '1000', overagePriceVnd: '250' };

    it('prices the quantity beyond the limit and rounds half up to whole VND', () => {
      expect(usageLine(feature, '1200', 'NOT_SUBJECT')).toMatchObject({ kind: 'USAGE', amountVnd: '50000', quantity: '200', unitPriceVnd: '250', meter: 'ai_call' });
      expect(usageLine({ ...feature, overagePriceVnd: '3' }, '1000.5', 'VAT_10')?.amountVnd).toBe('2');
      expect(usageLine({ ...feature, overagePriceVnd: '3' }, '1000.1', 'VAT_10')).toBeUndefined();
    });

    it('bills nothing within the limit, at the limit, or when the feature has no overage price', () => {
      expect(usageLine(feature, '1000', 'NOT_SUBJECT')).toBeUndefined();
      expect(usageLine(feature, '999.999999', 'NOT_SUBJECT')).toBeUndefined();
      expect(usageLine({ ...feature, overagePriceVnd: null }, '5000', 'NOT_SUBJECT')).toBeUndefined();
    });

    it('refuses a quantity that is not a number', () => {
      expect(() => usageLine(feature, '-1', 'NOT_SUBJECT')).toThrow(RangeError);
    });
  });

  it('prices the days of a period that are billed, rounding down, and the whole period at the whole price', () => {
    expect(priceForDays('3100000', 17, 31)).toBe('1700000');
    expect(priceForDays('1000', 1, 3)).toBe('333');
    expect(priceForDays('1000', 31, 31)).toBe('1000');
    expect(priceForDays('1000', 0, 31)).toBe('0');
    expect(() => priceForDays('1000', 32, 31)).toThrow(RangeError);
    expect(() => priceForDays('1000', 1, 0)).toThrow(RangeError);
  });

  it('gives an invoice the same code for the same subscription and period, so that a second run finds the first', () => {
    const code = invoiceCodeOf('3fa85f64-5717-4562-b3fc-2c963f66afa6', '2026-11-01');
    expect(code).toBe('INV-20261101-3FA85F64');
    expect(invoiceCodeOf('3fa85f64-5717-4562-b3fc-2c963f66afa6', '2026-11-01')).toBe(code);
    expect(invoiceCodeOf('3fa85f64-5717-4562-b3fc-2c963f66afa6', '2026-12-01')).not.toBe(code);
    // The invoice that takes the place of a discarded draft of the period has the next revision, and a code is never used twice.
    expect(invoiceCodeOf('3fa85f64-5717-4562-b3fc-2c963f66afa6', '2026-11-01', 1)).toBe(code);
    expect(invoiceCodeOf('3fa85f64-5717-4562-b3fc-2c963f66afa6', '2026-11-01', 2)).toBe('INV-20261101-3FA85F64-2');
  });

  describe('the schedule of the provider that does not answer', () => {
    const first = new Date('2026-11-01T00:00:00Z');

    it('asks again after a wait that grows, and stops after five attempts', () => {
      const waits = [1, 2, 3, 4].map((n) => (nextIssueAttempt(n, first, first) as Date).getTime() - first.getTime());
      expect(waits).toEqual([10 * 60_000, 3_600_000, 4 * 3_600_000, 12 * 3_600_000]);
      expect(nextIssueAttempt(ISSUE_MAX_ATTEMPTS, first, first)).toBeNull();
    });

    it('stops when the next attempt would fall after 24 hours from the first', () => {
      // The fourth attempt failed 20 hours in: another 12 hours would be past the day.
      expect(nextIssueAttempt(4, first, new Date(first.getTime() + 20 * 3_600_000))).toBeNull();
      expect(nextIssueAttempt(4, first, new Date(first.getTime() + 11 * 3_600_000))).not.toBeNull();
    });

    it('does not schedule anything for an attempt that has not been made', () => {
      expect(nextIssueAttempt(0, first, first)).toBeNull();
    });
  });

  it('calls an invoice overdue the day after its due day, and proposes a suspension only after thirty days past due', () => {
    expect(isInvoiceOverdue('2026-11-15', '2026-11-15')).toBe(false);
    expect(isInvoiceOverdue('2026-11-15', '2026-11-16')).toBe(true);
    const since = new Date('2026-11-16T00:00:00Z');
    expect(suspensionProposed(since, new Date(since.getTime() + (SUSPENSION_PROPOSAL_DAYS * 86_400_000 - 1)))).toBe(false);
    expect(suspensionProposed(since, new Date(since.getTime() + SUSPENSION_PROPOSAL_DAYS * 86_400_000))).toBe(true);
  });

  it('accepts a period that has begun and is no longer than a year, and refuses the rest', () => {
    expect(isBillingPeriod({ start: '2026-02-01', end: '2026-02-28' }, '2026-03-05')).toBe(true);
    expect(isBillingPeriod({ start: '2026-03-05', end: '2026-03-05' }, '2026-03-05')).toBe(true);
    expect(isBillingPeriod({ start: '2025-03-06', end: '2026-03-05' }, '2026-03-05')).toBe(true);
    expect(isBillingPeriod({ start: '2026-02-28', end: '2026-02-01' }, '2026-03-05')).toBe(false);
    expect(isBillingPeriod({ start: '2026-03-06', end: '2026-03-31' }, '2026-03-05')).toBe(false);
    expect(isBillingPeriod({ start: '2025-03-04', end: '2026-03-05' }, '2026-03-05')).toBe(false);
    expect(isBillingPeriod({ start: '2026-02-30', end: '2026-03-01' }, '2026-03-05')).toBe(false);
  });
});
