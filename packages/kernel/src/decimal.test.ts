import { ROUNDING_MODES, addDecimal, compareDecimal, convertDecimal, roundDecimal, subtractDecimal } from './decimal.ts';
import type { RoundingMode } from './decimal.ts';

const problem = (work: () => unknown): { code: string; detail: string | undefined } | undefined => {
  try {
    work();
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return { code, detail };
  }
  return undefined;
};

describe('exact decimal rounding', () => {
  const cases: Array<[string, number, RoundingMode, string]> = [
    ['2.5', 0, 'HALF_UP', '3'],
    ['2.5', 0, 'HALF_EVEN', '2'],
    ['3.5', 0, 'HALF_EVEN', '4'],
    ['2.5', 0, 'DOWN', '2'],
    ['2.1', 0, 'UP', '3'],
    ['-2.5', 0, 'HALF_UP', '-3'],
    ['-2.5', 0, 'HALF_EVEN', '-2'],
    ['-2.9', 0, 'DOWN', '-2'],
    ['-2.1', 0, 'UP', '-3'],
    ['1.005', 2, 'HALF_UP', '1.01'],
    ['1.005', 2, 'HALF_EVEN', '1.00'],
    ['1.015', 2, 'HALF_EVEN', '1.02'],
    ['1.0049', 2, 'HALF_UP', '1.00'],
    ['0.001', 2, 'UP', '0.01'],
    ['-0.001', 2, 'HALF_UP', '0.00'],
    ['0', 2, 'HALF_UP', '0.00'],
    ['12', 3, 'HALF_UP', '12.000'],
    ['12.5', 3, 'DOWN', '12.500'],
    ['999.995', 2, 'HALF_UP', '1000.00'],
    ['123456789012345678.995', 2, 'HALF_UP', '123456789012345679.00'],
  ];
  it.each(cases)('rounds %s to %i digits by %s: %s', (value, scale, mode, expected) => {
    expect(roundDecimal(value, scale, mode)).toBe(expected);
  });

  it('never gives a negative zero and keeps a value that already fits', () => {
    expect(roundDecimal('-0.4', 0, 'HALF_UP')).toBe('0');
    expect(roundDecimal('-0.00', 2, 'DOWN')).toBe('0.00');
    expect(roundDecimal('1234.56', 2, 'HALF_UP')).toBe('1234.56');
    for (const mode of ROUNDING_MODES) expect(roundDecimal('7', 0, mode)).toBe('7');
  });

  it('refuses what is not a decimal, a scale or a mode that it knows, and a value with more digits than it will weigh', () => {
    expect(problem(() => roundDecimal('1e3', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
    expect(problem(() => roundDecimal('01', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
    expect(problem(() => roundDecimal('1.', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
    expect(problem(() => roundDecimal('', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
    expect(problem(() => roundDecimal(`0.${'1'.repeat(19)}`, 2, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
    expect(problem(() => roundDecimal('1', -1, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'rounding' });
    expect(problem(() => roundDecimal('1', 19, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'rounding' });
    expect(problem(() => roundDecimal('1', 1.5, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'rounding' });
    expect(problem(() => roundDecimal('1', 0, 'CEILING' as never))).toEqual({ code: 'VALIDATION_FAILED', detail: 'rounding' });
  });

  it('is monotonic and within one unit of the last digit of the exact value, whatever the mode', () => {
    const values = ['0.004', '0.005', '0.006', '1.994', '1.995', '1.996', '10.5', '10.49', '99.999'];
    for (const mode of ROUNDING_MODES) {
      let previous = -Infinity;
      for (const value of values.map(Number).sort((left, right) => left - right).map(String)) {
        const rounded = Number(roundDecimal(value, 2, mode));
        expect(Math.abs(rounded - Number(value))).toBeLessThanOrEqual(0.01 + 1e-9);
        expect(rounded).toBeGreaterThanOrEqual(previous);
        previous = rounded;
      }
    }
  });
});

describe('conversion between units of one dimension', () => {
  it('converts through the factors to the base unit and rounds to the scale of the target', () => {
    expect(convertDecimal('1', '1000', '1', 0, 'HALF_UP')).toBe('1000');
    expect(convertDecimal('2500', '1', '1000', 3, 'HALF_UP')).toBe('2.500');
    expect(convertDecimal('1', '10000', '1', 0, 'HALF_UP')).toBe('10000');
    expect(convertDecimal('1', '1', '3', 4, 'HALF_UP')).toBe('0.3333');
    expect(convertDecimal('2', '1', '3', 4, 'HALF_UP')).toBe('0.6667');
    expect(convertDecimal('-2', '1', '3', 4, 'DOWN')).toBe('-0.6666');
    expect(convertDecimal('0', '1', '3', 2, 'UP')).toBe('0.00');
  });

  it('lets a tie that the guard digits cannot see decide the way the exact value does', () => {
    // 1 / 8 = 0.125 exactly: a tie at 2 digits; 1 / 8.000000001 is a little less than the tie, 1 / 7.999999999 a little more.
    expect(convertDecimal('1', '1', '8', 2, 'HALF_EVEN')).toBe('0.12');
    expect(convertDecimal('1', '1', '8', 2, 'HALF_UP')).toBe('0.13');
    expect(convertDecimal('1', '1', '8.000000001', 2, 'HALF_UP')).toBe('0.12');
    expect(convertDecimal('1', '1', '7.999999999', 2, 'HALF_EVEN')).toBe('0.13');
    expect(convertDecimal('1', '1', '3', 2, 'UP')).toBe('0.34');
  });

  it('refuses a zero or negative factor, a bad scale and a bad amount', () => {
    expect(problem(() => convertDecimal('1', '0', '1', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'factor' });
    expect(problem(() => convertDecimal('1', '1', '0', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'factor' });
    expect(problem(() => convertDecimal('1', '-1', '1', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'factor' });
    expect(problem(() => convertDecimal('1', '1', '1', 99, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'rounding' });
    expect(problem(() => convertDecimal('1', '1', '1', 0, 'X' as never))).toEqual({ code: 'VALIDATION_FAILED', detail: 'rounding' });
    expect(problem(() => convertDecimal('abc', '1', '1', 0, 'HALF_UP'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
  });
});

describe('exact decimal sums and comparisons', () => {
  it('adds and subtracts without a float, keeping the larger scale', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(addDecimal('200000000', '-150000000')).toBe('50000000');
    expect(addDecimal('1.50', '2')).toBe('3.50');
    expect(subtractDecimal('1', '1.25')).toBe('-0.25');
    expect(subtractDecimal('0', '0')).toBe('0');
    expect(subtractDecimal('0', '-7')).toBe('7');
    expect(addDecimal('99999999999999999999.999999999', '0.000000001')).toBe('100000000000000000000.000000000');
  });

  it('compares by value whatever the scale', () => {
    expect(compareDecimal('1.0', '1')).toBe(0);
    expect(compareDecimal('-0', '0')).toBe(0);
    expect(compareDecimal('2', '10')).toBe(-1);
    expect(compareDecimal('0.001', '-5')).toBe(1);
  });

  it('refuses text that is not a decimal', () => {
    expect(problem(() => addDecimal('1,5', '1'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
    expect(problem(() => compareDecimal('1', ''))).toEqual({ code: 'VALIDATION_FAILED', detail: 'amount' });
  });
});
