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
