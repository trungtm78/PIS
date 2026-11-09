import { convertCurrency, fxRateFindings, fxRateInForce, periodEndFor } from './fx-rate.ts';
import type { CurrencyFormat, FxRate } from './fx-rate.ts';

const FORMATS: Record<string, CurrencyFormat> = {
  VND: { scale: 0, rounding: 'HALF_UP' },
  USD: { scale: 2, rounding: 'HALF_UP' },
  EUR: { scale: 2, rounding: 'HALF_UP' },
  JPY: { scale: 0, rounding: 'HALF_UP' },
};
const formatOf = (code: string): CurrencyFormat => FORMATS[code] ?? { scale: 2, rounding: 'HALF_UP' };

const rate = (overrides: Partial<FxRate> & Pick<FxRate, 'baseCurrency' | 'rate'>): FxRate => ({
  quoteCurrency: 'VND',
  rateKind: 'OFFICIAL_AVERAGE',
  periodKind: 'MONTH',
  validFrom: '2026-10-01',
  validUntil: '2026-11-01',
  source: 'SBV',
  sourceRef: 'SBV-2026-10',
  approvalRef: 'QD-123',
  ...overrides,
});

const TABLE: FxRate[] = [
  rate({ baseCurrency: 'USD', rate: '25000' }),
  rate({ baseCurrency: 'USD', rate: '25350', periodKind: 'DAY', validFrom: '2026-10-15', validUntil: '2026-10-16', sourceRef: 'SBV-2026-10-15' }),
  rate({ baseCurrency: 'EUR', rate: '29800.5' }),
  rate({ baseCurrency: 'JPY', rate: '168.25' }),
];

const convert = (amount: string, from: string, to: string, day: string, rates: readonly FxRate[] = TABLE) => convertCurrency({ amount, from, to, day, rateKind: 'OFFICIAL_AVERAGE', rates, formatOf });

describe('fxRateInForce', () => {
  it('prefers the narrowest period that covers the day', () => {
    expect(fxRateInForce(TABLE, 'USD', 'VND', 'OFFICIAL_AVERAGE', '2026-10-15')?.rate).toBe('25350');
    expect(fxRateInForce(TABLE, 'USD', 'VND', 'OFFICIAL_AVERAGE', '2026-10-16')?.rate).toBe('25000');
  });
  it('does not reach outside the period, the pair or the kind', () => {
    expect(fxRateInForce(TABLE, 'USD', 'VND', 'OFFICIAL_AVERAGE', '2026-11-01')).toBeUndefined();
    expect(fxRateInForce(TABLE, 'USD', 'VND', 'OFFICIAL_AVERAGE', '2026-09-30')).toBeUndefined();
    expect(fxRateInForce(TABLE, 'USD', 'VND', 'BUY', '2026-10-15')).toBeUndefined();
    expect(fxRateInForce(TABLE, 'VND', 'USD', 'OFFICIAL_AVERAGE', '2026-10-15')).toBeUndefined();
  });
  it('takes the latest start among equal periods', () => {
    const rates = [rate({ baseCurrency: 'USD', rate: '1', validUntil: null }), rate({ baseCurrency: 'USD', rate: '2', validFrom: '2026-10-05', validUntil: null })];
    expect(fxRateInForce(rates, 'USD', 'VND', 'OFFICIAL_AVERAGE', '2026-10-20')?.rate).toBe('2');
  });
});

describe('convertCurrency (golden)', () => {
  it.each([
    ['100.00', 'USD', 'VND', '2026-10-15', '2535000', 'DIRECT'],
    ['100.00', 'USD', 'VND', '2026-10-16', '2500000', 'DIRECT'],
    ['1000000', 'VND', 'USD', '2026-10-15', '39.45', 'INVERSE'],
    ['1234567', 'JPY', 'VND', '2026-10-15', '207715898', 'DIRECT'],
    ['100.00', 'EUR', 'USD', '2026-10-15', '117.56', 'CROSS'],
    ['100.00', 'USD', 'USD', '2026-10-15', '100.00', 'IDENTITY'],
    ['-100.00', 'USD', 'VND', '2026-10-15', '-2535000', 'DIRECT'],
  ])('%s %s -> %s on %s = %s (%s)', (amount, from, to, day, expected, method) => {
    const out = convert(amount, from, to, day);
    expect(out.amount).toBe(expected);
    expect(out.method).toBe(method);
  });

  it('rounds once, with the mode of the target currency', () => {
    const down = { ...FORMATS, USD: { scale: 2, rounding: 'DOWN' as const } };
    const out = convertCurrency({ amount: '1000000', from: 'VND', to: 'USD', day: '2026-10-15', rateKind: 'OFFICIAL_AVERAGE', rates: TABLE, formatOf: (code) => down[code] ?? formatOf(code) });
    expect(out.amount).toBe('39.44');
  });

  it('states the rates it used so a figure can show how it was computed', () => {
    const out = convert('100.00', 'EUR', 'USD', '2026-10-15');
    expect(out.legs.map((leg) => `${leg.baseCurrency}/${leg.quoteCurrency}:${leg.direction}:${leg.sourceRef}`)).toEqual(['EUR/VND:FORWARD:SBV-2026-10', 'USD/VND:INVERTED:SBV-2026-10-15']);
  });

  it('comes back to the start within the scale (round trip)', () => {
    for (const amount of ['123.45', '0.01', '99999.99', '1.00']) {
      const there = convert(amount, 'USD', 'VND', '2026-10-15').amount;
      expect(convert(there, 'VND', 'USD', '2026-10-15').amount).toBe(Number(amount).toFixed(2));
    }
  });

  it('is exact where a float is not (0.1 + 0.2 style sums of conversions)', () => {
    const a = convert('0.10', 'USD', 'VND', '2026-10-15', [rate({ baseCurrency: 'USD', rate: '3', validUntil: null })]).amount;
    expect(a).toBe('0');
    const exact = convertCurrency({ amount: '0.30', from: 'USD', to: 'EUR', day: '2026-10-01', rateKind: 'OFFICIAL_AVERAGE', rates: [rate({ baseCurrency: 'USD', quoteCurrency: 'EUR', rate: '1.1', validUntil: null })], formatOf });
    expect(exact.amount).toBe('0.33');
  });

  it('refuses a missing rate and names the pair, never using an older rate', () => {
    expect(() => convert('1', 'USD', 'VND', '2026-12-01')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'rate:USD/VND' }));
    expect(() => convert('1', 'GBP', 'USD', '2026-10-15')).toThrow(expect.objectContaining({ detail: 'rate:GBP/VND' }));
    expect(() => convert('1', 'USD', 'GBP', '2026-10-15')).toThrow(expect.objectContaining({ detail: 'rate:VND/GBP' }));
  });

  it('refuses a bad currency code or day', () => {
    expect(() => convert('1', 'usd', 'VND', '2026-10-15')).toThrow();
    expect(() => convert('1', 'USD', 'VND', '2026-13-01')).toThrow();
  });
});

describe('periods and findings', () => {
  it('ends each kind of period on the next aligned day', () => {
    expect(periodEndFor('DAY', '2026-12-31')).toBe('2027-01-01');
    expect(periodEndFor('MONTH', '2026-12-01')).toBe('2027-01-01');
    expect(periodEndFor('QUARTER', '2026-10-01')).toBe('2027-01-01');
    expect(periodEndFor('YEAR', '2026-01-01')).toBe('2027-01-01');
  });

  const ok = { baseCurrency: 'USD', quoteCurrency: 'VND', rate: '25350.1234', periodKind: 'MONTH' as const, validFrom: '2026-10-01', validUntil: '2026-11-01', sourceRef: 'SBV-1' };
  it('accepts an aligned rate', () => expect(fxRateFindings(ok)).toEqual([]));
  it('refuses a float-like or zero rate, equal currencies and a missing source', () => {
    const codes = (patch: object) => fxRateFindings({ ...ok, ...patch }).map((f) => f.code);
    expect(codes({ rate: '1e3' })).toEqual(['RATE_FORMAT']);
    expect(codes({ rate: '0.000000001' })).toEqual(['RATE_FORMAT']);
    expect(codes({ rate: '0' })).toEqual(['RATE_ZERO']);
    expect(codes({ quoteCurrency: 'USD' })).toEqual(['SAME_CURRENCY']);
    expect(codes({ sourceRef: ' ' })).toEqual(['SOURCE_REF_REQUIRED']);
  });
  it('refuses a period that does not start and end on its boundaries', () => {
    const codes = (patch: object) => fxRateFindings({ ...ok, ...patch }).map((f) => f.code);
    expect(codes({ validFrom: '2026-10-02', validUntil: '2026-11-02' })).toEqual(['PERIOD_NOT_ALIGNED']);
    expect(codes({ periodKind: 'QUARTER', validFrom: '2026-11-01', validUntil: '2027-02-01' })).toEqual(['PERIOD_NOT_ALIGNED']);
    expect(codes({ validUntil: '2026-12-01' })).toEqual(['PERIOD_NOT_ALIGNED']);
    expect(codes({ validUntil: null })).toEqual(['PERIOD_NOT_ALIGNED']);
    expect(codes({ validFrom: '2026-02-30' })).toEqual(['PERIOD_NOT_ALIGNED']);
  });
});
