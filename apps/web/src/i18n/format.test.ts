import { afterEach, describe, expect, it } from 'vitest';
import { dayMonthYear, decimalText } from './format';
import { translator } from './index';

afterEach(() => translator.setLocale('vi'));

describe('the shared formatters', () => {
  it('writes a decimal with the comma of Vietnamese and the point of English, at most two decimals, no trailing zero', () => {
    expect(decimalText(8.06)).toBe('8,06');
    expect(decimalText(82.5)).toBe('82,5');
    expect(decimalText(82)).toBe('82');
    expect(decimalText(34.156)).toBe('34,16');
    expect(decimalText(100, 2, 'en')).toBe('100');
    expect(decimalText(8.06, 2, 'en')).toBe('8.06');
    expect(decimalText(0.5, 1)).toBe('0,5');
    expect(decimalText(Number.NaN)).toBe('–');
  });

  it('follows the language the person reads in', () => {
    translator.setLocale('en');
    expect(decimalText(8.06)).toBe('8.06');
  });

  it('writes a day as day/month/year and never guesses one', () => {
    expect(dayMonthYear('2026-11-13')).toBe('13/11/2026');
    expect(dayMonthYear('2026-11-13T02:00:00.000Z')).toBe('13/11/2026');
    expect(dayMonthYear(null)).toBe('–');
    expect(dayMonthYear(undefined)).toBe('–');
    expect(dayMonthYear('soon')).toBe('–');
  });
});
