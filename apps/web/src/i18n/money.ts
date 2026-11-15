import { translator } from './index';

/**
 * Money as a person reads it: ONE place that turns whole dong into text, for every screen of the web app (the phone has the same rule in
 * `apps/mobile/lib/core/format/money.dart`).
 *
 * An amount is a decimal string (or a bigint) of dong and is only ever handled as an integer: no float is made of it, so a figure of fifteen
 * or twenty-four digits loses no dong.
 *
 * THE RULE OF THE SHORT FORM (`compactMoney`, `<Money>`):
 *  - the unit is chosen by the size of the amount: from 1.000.000.000 it is "tỷ đồng", from 1.000.000 "triệu đồng", below that whole "đồng"
 *    with every digit ("950.000 đồng");
 *  - in tỷ and triệu the figure is rounded HALF AWAY FROM ZERO to two decimals and trailing zeros are dropped ("1,5 tỷ đồng", never "1,50");
 *  - a rounding that reaches 1.000 triệu is written in the next unit ("999.995.000" is "1 tỷ đồng", never "1.000 triệu đồng");
 *  - a negative amount carries a minus sign, and an amount that rounds to zero carries none; zero is "0 đồng";
 *  - no amount at all (null, undefined, an empty text) is a dash, never a zero; a text that is not an amount is shown as it came, never guessed;
 *  - Vietnamese groups thousands with a dot and has a decimal comma, English the other way round; the words of the units are catalogue keys.
 *
 * The short form is for reading at a glance. The exact amount stays one hover away (`fullMoney`, which `<Money>` puts in the `title` and in
 * the text a screen reader hears), and anything whose purpose is the exact figure (a ledger, a payment document, a field a person types in,
 * an export) uses `dongText` and is never shortened.
 */

export type MoneyUnit = 'dong' | 'million' | 'billion';
export type MoneyValue = string | bigint | null | undefined;

/** What stands where there is no amount. */
export const NO_MONEY = '—';

const MAX_DIGITS = 24;
const AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/;
const SIZE: Readonly<Record<MoneyUnit, bigint>> = { dong: 1n, million: 1_000_000n, billion: 1_000_000_000n };

const isEnglish = (locale: string): boolean => locale.toLowerCase().startsWith('en');
const groupMark = (locale: string): string => (isEnglish(locale) ? ',' : '.');
const decimalMark = (locale: string): string => (isEnglish(locale) ? '.' : ',');

/** The number of dong in one unit. */
export const dongPerUnit = (unit: MoneyUnit): bigint => SIZE[unit];

/**
 * The amount as an integer of dong, or null when the value is not an amount. A decimal string of the server ("1250000.00") is accepted; a
 * fraction of a dong is rounded half away from zero, since the dong has no smaller coin.
 */
export function parseDong(value: MoneyValue): bigint | null {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined) return null;
  const match = AMOUNT.exec(value.trim());
  if (match === null) return null;
  const [, sign = '', whole = '', fraction = ''] = match;
  if (whole.length > MAX_DIGITS) return null;
  const magnitude = BigInt(whole) + (fraction !== '' && fraction.charCodeAt(0) >= 53 ? 1n : 0n);
  return sign === '-' ? -magnitude : magnitude;
}

/** The magnitude of an integer with its thousands grouped by the mark of the language. */
export function groupDigits(value: bigint, locale: string = translator.getLocale()): string {
  const digits = (value < 0n ? -value : value).toString();
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, groupMark(locale));
}

/** The unit that fits an amount: the largest of tỷ and triệu in which it is at least 1, else dong. */
export function moneyUnitFor(amount: bigint): MoneyUnit {
  const magnitude = amount < 0n ? -amount : amount;
  if (magnitude >= SIZE.billion) return 'billion';
  if (magnitude >= SIZE.million) return 'million';
  return 'dong';
}

export interface MoneyOptions {
  /** The language of the marks; the active one when left out. */
  locale?: string;
  /** Force a unit (a column or a card that declares one); the amount is then never moved to another unit. */
  unit?: MoneyUnit;
  /** The most decimals of a figure in triệu or tỷ (2 when left out); dong never has any. */
  decimals?: number;
  /** Keep the trailing zeros, so the figures of a column line up ("214,70"). */
  fixed?: boolean;
  /** `half` rounds half away from zero (the default); `down` cuts, for a figure that must never say more than was published. */
  rounding?: 'half' | 'down';
  /** Write a plus sign before a rise. */
  signed?: boolean;
}

export interface MoneyParts {
  /** The figure with the marks of the language and its sign ("1.234,5"). */
  number: string;
  unit: MoneyUnit;
  /** Whether the figure shows the amount whole, with no dong rounded away. */
  exact: boolean;
}

function scaled(magnitude: bigint, unit: MoneyUnit, places: number, rounding: 'half' | 'down'): bigint {
  const numerator = magnitude * 10n ** BigInt(places);
  return rounding === 'down' ? numerator / SIZE[unit] : (numerator * 2n + SIZE[unit]) / (SIZE[unit] * 2n);
}

/** An amount as a figure and the unit it is in; null when the value is not an amount. */
export function moneyParts(value: MoneyValue, options: MoneyOptions = {}): MoneyParts | null {
  const amount = parseDong(value);
  if (amount === null) return null;
  const locale = options.locale ?? translator.getLocale();
  const rounding = options.rounding ?? 'half';
  const decimals = options.decimals ?? 2;
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  let unit = options.unit ?? moneyUnitFor(amount);
  let places = unit === 'dong' ? 0 : decimals;
  let figure = scaled(magnitude, unit, places, rounding);
  if (options.unit === undefined && unit === 'million' && figure >= 1000n * 10n ** BigInt(places)) {
    unit = 'billion';
    places = decimals;
    figure = scaled(magnitude, unit, places, rounding);
  }
  const divisor = 10n ** BigInt(places);
  const whole = groupDigits(figure / divisor, locale);
  const padded = places === 0 ? '' : (figure % divisor).toString().padStart(places, '0');
  const fraction = options.fixed === true ? padded : padded.replace(/0+$/, '');
  const sign = figure === 0n ? '' : negative ? '-' : options.signed === true ? '+' : '';
  const number = fraction === '' ? `${sign}${whole}` : `${sign}${whole}${decimalMark(locale)}${fraction}`;
  return { number, unit, exact: figure * SIZE[unit] === magnitude * divisor };
}

/** Whether the text stands for no amount at all. */
const isNone = (value: MoneyValue): value is null | undefined | '' => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/** What is shown for a value that is not an amount: a dash for none, the text itself for anything else. */
const fallback = (value: MoneyValue): string => (isNone(value) ? NO_MONEY : String(value));

/**
 * The exact amount in whole dong with its thousands grouped and NO unit ("1.234.567.890"): for a ledger, a payment document, a column that
 * declares "đồng", and wherever the exact figure is the purpose.
 */
export function dongText(value: MoneyValue, locale: string = translator.getLocale(), signed = false): string {
  const parts = moneyParts(value, { locale, unit: 'dong', signed });
  return parts === null ? fallback(value) : parts.number;
}

/** The exact amount with its unit ("1.234.567.890 đồng"): the text of a tooltip and of a screen reader. */
export function fullMoney(value: MoneyValue, locale: string = translator.getLocale()): string {
  const parts = moneyParts(value, { locale, unit: 'dong' });
  return parts === null ? fallback(value) : translator.t('money.value.amount', { number: parts.number, unit: translator.t('money.unit.dong') });
}

/** The figure of an amount in a unit that the column or the card declares, with no unit after it ("214,71" under "ĐVT: tỷ đồng"). */
export function moneyInUnit(value: MoneyValue, unit: MoneyUnit, options: Omit<MoneyOptions, 'unit'> = {}): string {
  const parts = moneyParts(value, { ...options, unit });
  return parts === null ? fallback(value) : parts.number;
}

/** The short form of an amount with its unit ("1.234,5 tỷ đồng", "12,3 triệu đồng", "950.000 đồng"); see the rule at the top of the file. */
export function compactMoney(value: MoneyValue, options: MoneyOptions = {}): string {
  const parts = moneyParts(value, options);
  return parts === null ? fallback(value) : translator.t('money.value.amount', { number: parts.number, unit: translator.t(`money.unit.${parts.unit}`) });
}
