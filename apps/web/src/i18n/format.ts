import { translator } from './index';
import type { Locale } from './index';

/**
 * The shared formatters of figures and days a person reads. A screen never joins digits by hand: a decimal is written with the mark of the language (a comma in Vietnamese, a point in English) and a day as
 * day/month/year, so the same score reads 8,06 on every screen and on the phone.
 */

const DECIMAL_MARK: Readonly<Record<Locale, string>> = { vi: ',', en: '.' };
const DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** A number with at most `digits` decimals, trailing zeros dropped, in the decimal mark of the language (the active one unless `locale` is given). */
export function decimalText(value: number, digits = 2, locale: Locale = translator.getLocale()): string {
  if (!Number.isFinite(value)) return '–';
  const fixed = value.toFixed(digits);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed.replace('.', DECIMAL_MARK[locale]);
}

/** A day of the form `yyyy-mm-dd` (or an instant that starts with one) as `dd/mm/yyyy`; anything else, and no day at all, is a dash: a date is never guessed. */
export function dayMonthYear(value: string | null | undefined): string {
  const match = value === null || value === undefined ? null : DAY.exec(value);
  return match === null ? '–' : `${match[3]}/${match[2]}/${match[1]}`;
}

const PERCENT = /^(-?)(\d+)(?:\.(\d+))?$/;
const GROUP_MARK: Readonly<Record<Locale, string>> = { vi: '.', en: ',' };

/**
 * A percent as a person reads it: "96,54%" in Vietnamese, "96.54%" in English. The figure is the decimal text of the server ("96.5414") or a number; it is rounded HALF AWAY FROM ZERO to
 * `digits` decimals at most (two unless told otherwise) on the digits of the text, never through a float; trailing zeros are dropped ("45%", "197,5%") unless `fixed` asks to keep them. The
 * thousands are grouped. No figure (null, undefined, an empty text) is a dash and a text that is not a number is shown as it came: a rate is never guessed and never 0%.
 */
export function formatPercent(value: string | number | null | undefined, digits = 2, locale: Locale = translator.getLocale(), fixed = false): string {
  if (value === null || value === undefined || value === '') return '–';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(Math.max(digits + 2, 6)) : '') : value.trim();
  const match = PERCENT.exec(text);
  if (match === null) return typeof value === 'number' ? '–' : value;
  const [, sign = '', whole = '', fraction = ''] = match;
  const kept = fraction.padEnd(digits, '0').slice(0, digits);
  const up = fraction.length > digits && fraction.charCodeAt(digits) >= 53;
  const scaled = BigInt(whole + kept) + (up ? 1n : 0n);
  const divisor = 10n ** BigInt(digits);
  const grouped = (scaled / divisor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_MARK[locale]);
  const padded = digits === 0 ? '' : (scaled % divisor).toString().padStart(digits, '0');
  const shown = fixed ? padded : padded.replace(/0+$/, '');
  const decimals = shown === '' ? '' : `${DECIMAL_MARK[locale]}${shown}`;
  return `${sign === '-' && scaled !== 0n ? '-' : ''}${grouped}${decimals}%`;
}

/** The percent of a text of the server: a decimal text is written by `formatPercent`; a text that is already written for a person ("60,00") keeps its digits and gets the sign. */
export function percentOfText(text: string, digits = 2, locale: Locale = translator.getLocale()): string {
  return PERCENT.test(text.trim()) ? formatPercent(text, digits, locale) : `${text}%`;
}

const PERCENT_IN_TEXT = /(-?\d+(?:\.\d+)?)%/g;

/**
 * A sentence that the server wrote ("Tỷ lệ giải ngân 37.62%, ngưỡng 45.0000%") with every percent in it rewritten by `formatPercent` ("37,62%", "45%"). The words are left as they came: only a
 * number that is immediately followed by the sign is touched.
 */
export function percentsInText(text: string, digits = 2, locale: Locale = translator.getLocale()): string {
  return text.replace(PERCENT_IN_TEXT, (_whole, figure: string) => formatPercent(figure, digits, locale));
}
