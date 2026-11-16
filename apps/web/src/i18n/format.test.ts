import { afterEach, describe, expect, it } from 'vitest';
import { dayMonthYear, decimalText, formatPercent } from './format';
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

  it('writes a percent with two decimals in the marks of the language, rounded on the digits of the text', () => {
    expect(formatPercent('96.5414')).toBe('96,54%');
    expect(formatPercent('37.6233')).toBe('37,62%');
    expect(formatPercent('37.625')).toBe('37,63%');
    expect(formatPercent('-37.625')).toBe('-37,63%');
    expect(formatPercent('60')).toBe('60%');
    expect(formatPercent('45.0000')).toBe('45%');
    expect(formatPercent('197.5000')).toBe('197,5%');
    expect(formatPercent('60', 2, 'vi', true)).toBe('60,00%');
    expect(formatPercent('99.999')).toBe('100%');
    expect(formatPercent('-0.001')).toBe('0%');
    expect(formatPercent('1234.5')).toBe('1.234,5%');
    expect(formatPercent(14)).toBe('14%');
    expect(formatPercent(8.125, 1)).toBe('8,1%');
    expect(formatPercent('12.5', 0)).toBe('13%');
    expect(formatPercent(null)).toBe('–');
    expect(formatPercent('')).toBe('–');
    expect(formatPercent('n/a')).toBe('n/a');
    expect(formatPercent(Number.NaN)).toBe('–');
    translator.setLocale('en');
    expect(formatPercent('96.5414')).toBe('96.54%');
    expect(formatPercent('1234.5')).toBe('1,234.5%');
  });
});
