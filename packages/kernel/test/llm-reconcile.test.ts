import { RECONCILE_TOLERANCE_PERCENT, checkReconcile, compare, fromUnits, providerOfInvoice, toUnits } from '../src/llm-reconcile.ts';

const request = { invoiceRef: 'VN1-2026-11', invoiceAmount: '3180000', currency: 'VND', periodFrom: '2026-11-01', periodTo: '2026-11-30' };
const thrown = (run: () => unknown): { code: string; status: number; detail?: string } => {
  try {
    run();
  } catch (error) {
    return error as never;
  }
  throw new Error('nothing was thrown');
};

describe('the money of a reconciliation (ST-LLM-008, UAT-AC462)', () => {
  it('reads an amount to the eighth place as an integer and writes it back with the figures it needs', () => {
    expect(toUnits('3180000', 'amount')).toBe(318_000_000_000_000n);
    expect(toUnits('0.00000001', 'amount')).toBe(1n);
    expect(toUnits('-12.5', 'amount')).toBe(-1_250_000_000n);
    expect(toUnits('999999999999999999.99999999', 'amount')).toBe(99_999_999_999_999_999_999_999_999n);
    for (const [units, text] of [
      [318_000_000_000_000n, '3180000'],
      [1n, '0.00000001'],
      [-1_250_000_000n, '-12.5'],
      [0n, '0'],
    ] as const)
      expect(fromUnits(units)).toBe(text);
    for (const bad of ['', 'abc', '1.123456789', '1e5', '--1', '1,5', '1234567890123456789']) expect(thrown(() => toUnits(bad, 'invoice_amount')).detail).toBe('invoice_amount');
  });

  it('sets the invoice against the attempts: inside 0.5 percent of the invoice is reconciled, outside it is not, above and below', () => {
    expect(RECONCILE_TOLERANCE_PERCENT).toBe('0.50');
    const dong = (value: number): bigint => toUnits(String(value), 'x');
    // UAT-AC462: 3,180,000 against 3,120,000 is 60,000 (more than 15,900), against 3,172,000 it is 8,000.
    expect(compare(dong(3_180_000), dong(3_120_000))).toEqual({ variance: dong(60_000), withinTolerance: false });
    expect(compare(dong(3_180_000), dong(3_172_000))).toEqual({ variance: dong(8_000), withinTolerance: true });
    // The edge: 5,000 of 1,000,000 is exactly 0.5 percent; one cent more is not, and the invoice below the attempts is judged the same way.
    expect(compare(dong(1_000_000), dong(995_000)).withinTolerance).toBe(true);
    expect(compare(toUnits('1000000.01', 'x'), dong(995_000)).withinTolerance).toBe(false);
    expect(compare(dong(1_000_000), dong(1_005_000))).toEqual({ variance: dong(-5_000), withinTolerance: true });
    expect(compare(toUnits('999999.99', 'x'), dong(1_005_000)).withinTolerance).toBe(false);
    // An invoice of nothing agrees only with attempts of nothing.
    expect(compare(0n, 0n)).toEqual({ variance: 0n, withinTolerance: true });
    expect(compare(0n, 1n).withinTolerance).toBe(false);
  });
});

describe('the request of a reconciliation', () => {
  it('takes a reference, an amount, a currency and a period that is over', () => {
    expect(checkReconcile({ ...request, invoiceRef: ' VN1-2026-11 ' }, '2026-12-01')).toEqual({
      invoiceRef: 'VN1-2026-11',
      invoiceAmount: 318_000_000_000_000n,
      currency: 'VND',
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
    });
    expect(() => checkReconcile({ ...request, periodTo: '2026-11-30' }, '2026-11-30')).toThrow(expect.objectContaining({ code: 'RECONCILE_PERIOD_OPEN', status: 409 }));
    expect(thrown(() => checkReconcile(request, '2026-11-15')).code).toBe('RECONCILE_PERIOD_OPEN');
    expect(thrown(() => checkReconcile(request, '2026-11-30')).code).toBe('RECONCILE_PERIOD_OPEN');
    expect(() => checkReconcile(request, '2026-12-01')).not.toThrow();
  });

  it('refuses what is not a request, naming the field', () => {
    const today = '2027-06-01';
    for (const [over, field] of [
      [{ invoiceRef: '  ' }, 'invoice_ref'],
      [{ invoiceRef: 'x'.repeat(121) }, 'invoice_ref'],
      [{ invoiceAmount: 'ten' }, 'invoice_amount'],
      [{ invoiceAmount: '-1' }, 'invoice_amount'],
      [{ currency: 'vnd' }, 'currency'],
      [{ currency: 'VNDD' }, 'currency'],
      [{ periodFrom: '2026-02-30' }, 'period_from'],
      [{ periodFrom: 'soon' }, 'period_from'],
      [{ periodTo: '2026-13-01' }, 'period_to'],
      [{ periodFrom: '2026-11-30', periodTo: '2026-11-01' }, 'period_to'],
      [{ periodFrom: '2025-01-01', periodTo: '2026-11-30' }, 'period_to'],
    ] as const)
      expect(thrown(() => checkReconcile({ ...request, ...over }, today)).detail).toBe(field);
    // A period of a whole leap year is the longest.
    expect(() => checkReconcile({ ...request, periodFrom: '2024-01-01', periodTo: '2024-12-31' }, today)).not.toThrow();
  });
});

describe('the provider an invoice is for', () => {
  it('is the one whose code the reference is, or begins with followed by a dash; the longest of them', () => {
    const codes = ['VN1', 'VN1-LAB', 'VN2', 'OTHER'];
    expect(providerOfInvoice('VN1-2026-11', codes)).toBe('VN1');
    expect(providerOfInvoice('vn1', codes)).toBe('VN1');
    expect(providerOfInvoice('vn1-lab-2026-11', codes)).toBe('VN1-LAB');
    expect(providerOfInvoice(' VN2-A ', codes)).toBe('VN2');
    expect(providerOfInvoice('VN10-2026-11', codes)).toBeUndefined();
    expect(providerOfInvoice('XVN1-2026', codes)).toBeUndefined();
    expect(providerOfInvoice('2026-11', codes)).toBeUndefined();
  });
});
