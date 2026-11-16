import { dongText } from '../../../i18n/money';

const AMOUNT_DIGITS = 24;

/** A whole amount of dong written exactly, its thousands grouped by the mark of the language and no unit: the one formatter of `i18n/money.ts`, for a figure whose purpose is the exact amount. */
export const formatVnd = (amount: string): string => dongText(amount);

/** The digits of an amount typed with or without separators ("1.250.000.000", "1,250,000,000", "1 250 000 000"); anything else, a sign and a fraction included, is not an amount. */
export function digitsOf(typed: string): string | undefined {
  const compact = typed.trim().replace(/[.,\s]/g, '');
  if (!/^[0-9]+$/.test(compact) || compact.length > AMOUNT_DIGITS) return undefined;
  return BigInt(compact).toString();
}
