import { afterEach, describe, expect, it } from 'vitest';
import { translator } from './index';
import { compactMoney, dongText, fullMoney, groupDigits, moneyInUnit, moneyParts, moneyUnitFor, parseDong } from './money';

afterEach(() => translator.setLocale('vi'));

describe('the shared money formatter', () => {
  it('chooses the unit at the boundaries of one million and one billion', () => {
    expect(compactMoney('999999')).toBe('999.999 đồng');
    expect(compactMoney('1000000')).toBe('1 triệu đồng');
    expect(compactMoney('999999999')).toBe('1 tỷ đồng');
    expect(compactMoney('999994999')).toBe('999,99 triệu đồng');
    expect(compactMoney('999995000')).toBe('1 tỷ đồng');
    expect(compactMoney('1000000000')).toBe('1 tỷ đồng');
    expect(moneyUnitFor(999_999n)).toBe('dong');
    expect(moneyUnitFor(-1_000_000n)).toBe('million');
    expect(moneyUnitFor(1_000_000_000n)).toBe('billion');
  });

  it('writes tỷ and triệu with at most two decimals, the comma of Vietnamese and no trailing zero', () => {
    expect(compactMoney('1234500000000')).toBe('1.234,5 tỷ đồng');
    expect(compactMoney('12300000')).toBe('12,3 triệu đồng');
    expect(compactMoney('950000')).toBe('950.000 đồng');
    expect(compactMoney('1234567890')).toBe('1,23 tỷ đồng');
    expect(compactMoney('2000000000')).toBe('2 tỷ đồng');
    expect(compactMoney('1500000')).toBe('1,5 triệu đồng');
  });

  it('rounds half away from zero, by integers', () => {
    expect(compactMoney('1004999999')).toBe('1 tỷ đồng');
    expect(compactMoney('1005000000')).toBe('1,01 tỷ đồng');
    expect(compactMoney('-1005000000')).toBe('-1,01 tỷ đồng');
    expect(compactMoney('1234999')).toBe('1,23 triệu đồng');
    expect(compactMoney('1235000')).toBe('1,24 triệu đồng');
    expect(compactMoney('1250000', { decimals: 1 })).toBe('1,3 triệu đồng');
    expect(moneyInUnit('1999999999', 'billion', { rounding: 'down' })).toBe('1,99');
  });

  it('keeps every digit of an amount of fifteen digits and more: no float is made of it', () => {
    expect(compactMoney('123456789012345')).toBe('123.456,79 tỷ đồng');
    expect(fullMoney('123456789012345')).toBe('123.456.789.012.345 đồng');
    expect(dongText('900719925474099312345')).toBe('900.719.925.474.099.312.345');
    expect(compactMoney('900719925474099312345')).toBe('900.719.925.474,1 tỷ đồng');
    expect(compactMoney(9007199254740993n)).toBe('9.007.199,25 tỷ đồng');
    expect(fullMoney(9007199254740993n)).toBe('9.007.199.254.740.993 đồng');
  });

  it('carries the sign of a fall, none for an amount that rounds to zero, and a plus only when asked', () => {
    expect(compactMoney('-2500000000')).toBe('-2,5 tỷ đồng');
    expect(compactMoney('-950000')).toBe('-950.000 đồng');
    expect(compactMoney('0')).toBe('0 đồng');
    expect(compactMoney('-0')).toBe('0 đồng');
    expect(compactMoney('2500000', { signed: true })).toBe('+2,5 triệu đồng');
    expect(compactMoney('0', { signed: true })).toBe('0 đồng');
    expect(moneyInUnit('-4000000', 'billion')).toBe('0');
    expect(dongText('1250000', 'vi', true)).toBe('+1.250.000');
  });

  it('shows a dash for no amount and leaves a text that is not an amount as it came', () => {
    expect(compactMoney(null)).toBe('—');
    expect(compactMoney(undefined)).toBe('—');
    expect(compactMoney('')).toBe('—');
    expect(compactMoney('  ')).toBe('—');
    expect(fullMoney(null)).toBe('—');
    expect(dongText(null)).toBe('—');
    expect(compactMoney('n/a')).toBe('n/a');
    expect(dongText('12abc')).toBe('12abc');
    expect(moneyParts('1e9')).toBeNull();
    expect(parseDong('1'.repeat(25))).toBeNull();
  });

  it('reads the decimal string of the server and rounds a fraction of a dong half away from zero', () => {
    expect(parseDong('1250000.00')).toBe(1250000n);
    expect(parseDong('1250000.49')).toBe(1250000n);
    expect(parseDong('1250000.50')).toBe(1250001n);
    expect(parseDong('-1250000.50')).toBe(-1250001n);
    expect(dongText('1250000.00')).toBe('1.250.000');
  });

  it('writes a figure in a declared unit with no unit after it, fixed decimals on demand', () => {
    expect(moneyInUnit('214705000000', 'billion', { fixed: true })).toBe('214,71');
    expect(moneyInUnit('214700000000', 'billion', { fixed: true })).toBe('214,70');
    expect(moneyInUnit('214700000000', 'billion')).toBe('214,7');
    expect(moneyInUnit('1500000000', 'million')).toBe('1.500');
    expect(moneyInUnit('1250000', 'million', { decimals: 6 })).toBe('1,25');
    expect(moneyInUnit('1500000000', 'dong')).toBe('1.500.000.000');
    expect(moneyInUnit(null, 'billion')).toBe('—');
  });

  it('says whether a figure shows the amount whole', () => {
    expect(moneyParts('1500000000')).toEqual({ number: '1,5', unit: 'billion', exact: true });
    expect(moneyParts('1500000001')).toEqual({ number: '1,5', unit: 'billion', exact: false });
    expect(moneyParts('999')).toEqual({ number: '999', unit: 'dong', exact: true });
  });

  it('uses the marks and the words of English', () => {
    translator.setLocale('en');
    expect(compactMoney('1234500000000')).toBe('1,234.5 billion VND');
    expect(compactMoney('12300000')).toBe('12.3 million VND');
    expect(compactMoney('950000')).toBe('950,000 VND');
    expect(fullMoney('1234567890')).toBe('1,234,567,890 VND');
    expect(groupDigits(1234567n)).toBe('1,234,567');
    expect(groupDigits(1234567n, 'vi')).toBe('1.234.567');
  });
});
