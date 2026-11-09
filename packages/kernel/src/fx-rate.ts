import { convertDecimal, compareDecimal, multiplyDecimal } from './decimal.ts';
import type { RoundingMode } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * Exchange rates (MD.03, ENT-4e). Amounts of the public edition stay whole dong in `*_vnd` columns and nothing there calls this file: it is the pure
 * helper of the enterprise catalogue `FX_RATE`, whose entries are effective-dated MDM versions (one per day or period) with their source and approval.
 *
 * A rate says: 1 unit of the base currency is `rate` units of the quote currency. All arithmetic is exact decimal (bigint behind decimal.ts), never a float,
 * and the result is rounded once, to the scale and with the mode of the target currency.
 */
export const FX_RATE_KINDS = ['OFFICIAL_AVERAGE', 'BUY', 'SELL', 'TRANSFER', 'CLOSING'] as const;
export type FxRateKind = (typeof FX_RATE_KINDS)[number];
export const FX_PERIOD_KINDS = ['DAY', 'MONTH', 'QUARTER', 'YEAR'] as const;
export type FxPeriodKind = (typeof FX_PERIOD_KINDS)[number];
export const FX_SOURCES = ['SBV', 'COMMERCIAL_BANK', 'PVN_GROUP', 'OTHER'] as const;
export type FxSource = (typeof FX_SOURCES)[number];
/** The currency the amounts of the system are kept in; a cross rate between two other currencies goes through it. */
export const FX_PIVOT_CURRENCY = 'VND';
export const FX_RATE_MAX_FRACTION_DIGITS = 8;

const RATE = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One effective-dated version of an exchange rate as the catalogue holds it. */
export interface FxRate {
  baseCurrency: string;
  quoteCurrency: string;
  /** Exact decimal string, at most eight digits after the point, greater than zero. */
  rate: string;
  rateKind: FxRateKind;
  periodKind: FxPeriodKind;
  /** First day (YYYY-MM-DD, day in Vietnam) the rate is in force. */
  validFrom: string;
  /** First day it is no longer in force; null while open. */
  validUntil: string | null;
  source: FxSource;
  sourceRef: string;
  /** The decision or minutes that fixed the rate; the catalogue publication adds who published it. */
  approvalRef: string | null;
}

export interface CurrencyFormat {
  scale: number;
  rounding: RoundingMode;
}

export type FxFindingCode = 'CURRENCY_FORMAT' | 'SAME_CURRENCY' | 'RATE_FORMAT' | 'RATE_ZERO' | 'PERIOD_NOT_ALIGNED' | 'SOURCE_REF_REQUIRED';
export interface FxFinding {
  field: string;
  code: FxFindingCode;
}

const rank = (kind: FxPeriodKind): number => FX_PERIOD_KINDS.indexOf(kind);

const parseDay = (value: string): Date => new Date(`${value}T00:00:00Z`);

/** Whether `YYYY-MM-DD` names a day of the calendar. */
function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = parseDay(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** The days a period of the kind spans from `validFrom`: the length the catalogue expects (`validUntil` is the first day after it). */
export function periodEndFor(kind: FxPeriodKind, validFrom: string): string {
  const start = parseDay(validFrom);
  const next = new Date(start);
  if (kind === 'DAY') next.setUTCDate(next.getUTCDate() + 1);
  else if (kind === 'MONTH') next.setUTCMonth(next.getUTCMonth() + 1);
  else if (kind === 'QUARTER') next.setUTCMonth(next.getUTCMonth() + 3);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * The rules of a rate that the catalogue form cannot state: three-letter upper-case currency codes that differ, a positive exact rate with at most eight
 * digits after the point, a period that starts on the first day of its month, quarter or year and ends on the next such day (a DAY period is one day), and
 * the reference of the source.
 */
export function fxRateFindings(rate: Pick<FxRate, 'baseCurrency' | 'quoteCurrency' | 'rate' | 'periodKind' | 'validFrom' | 'validUntil' | 'sourceRef'>): FxFinding[] {
  const found: FxFinding[] = [];
  if (!CURRENCY.test(rate.baseCurrency)) found.push({ field: 'base_currency', code: 'CURRENCY_FORMAT' });
  if (!CURRENCY.test(rate.quoteCurrency)) found.push({ field: 'quote_currency', code: 'CURRENCY_FORMAT' });
  if (CURRENCY.test(rate.baseCurrency) && rate.baseCurrency === rate.quoteCurrency) found.push({ field: 'quote_currency', code: 'SAME_CURRENCY' });
  if (!RATE.test(rate.rate)) found.push({ field: 'rate', code: 'RATE_FORMAT' });
  else if (compareDecimal(rate.rate, '0') === 0) found.push({ field: 'rate', code: 'RATE_ZERO' });
  if (rate.sourceRef.trim() === '') found.push({ field: 'source_ref', code: 'SOURCE_REF_REQUIRED' });
  if (!isDay(rate.validFrom)) {
    found.push({ field: 'valid_from', code: 'PERIOD_NOT_ALIGNED' });
  } else {
    const start = parseDay(rate.validFrom);
    const alignedStart =
      rate.periodKind === 'DAY' ||
      (rate.periodKind === 'MONTH' && start.getUTCDate() === 1) ||
      (rate.periodKind === 'QUARTER' && start.getUTCDate() === 1 && start.getUTCMonth() % 3 === 0) ||
      (rate.periodKind === 'YEAR' && start.getUTCDate() === 1 && start.getUTCMonth() === 0);
    if (!alignedStart || rate.validUntil === null || rate.validUntil !== periodEndFor(rate.periodKind, rate.validFrom)) found.push({ field: 'valid_until', code: 'PERIOD_NOT_ALIGNED' });
  }
  return found;
}

/**
 * The rate in force for a pair, a kind and a day: among the versions of exactly that pair and kind that cover the day, the one of the narrowest period (a daily
 * rate wins over a monthly one), then the latest start. `undefined` when none covers the day: a caller must say so, never fall back to an older rate silently.
 */
export function fxRateInForce(rates: readonly FxRate[], baseCurrency: string, quoteCurrency: string, rateKind: FxRateKind, day: string): FxRate | undefined {
  const covering = rates.filter(
    (rate) => rate.baseCurrency === baseCurrency && rate.quoteCurrency === quoteCurrency && rate.rateKind === rateKind && rate.validFrom <= day && (rate.validUntil === null || day < rate.validUntil),
  );
  covering.sort((left, right) => rank(left.periodKind) - rank(right.periodKind) || (left.validFrom < right.validFrom ? 1 : left.validFrom > right.validFrom ? -1 : 0));
  return covering[0];
}

export type FxMethod = 'IDENTITY' | 'DIRECT' | 'INVERSE' | 'CROSS';

export interface FxLeg {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  rateKind: FxRateKind;
  periodKind: FxPeriodKind;
  validFrom: string;
  source: FxSource;
  sourceRef: string;
  /** `FORWARD` multiplies by the rate, `INVERTED` divides by it. */
  direction: 'FORWARD' | 'INVERTED';
}

export interface FxConversion {
  /** The converted amount, written with the scale of the target currency. */
  amount: string;
  method: FxMethod;
  /** The rates used, in order, so that a figure can show how it was computed (formula, source, as-of). */
  legs: FxLeg[];
}

const leg = (rate: FxRate, direction: FxLeg['direction']): FxLeg => ({
  baseCurrency: rate.baseCurrency,
  quoteCurrency: rate.quoteCurrency,
  rate: rate.rate,
  rateKind: rate.rateKind,
  periodKind: rate.periodKind,
  validFrom: rate.validFrom,
  source: rate.source,
  sourceRef: rate.sourceRef,
  direction,
});

export interface ConvertRequest {
  amount: string;
  from: string;
  to: string;
  /** The day (Vietnam) whose rate applies. */
  day: string;
  rateKind: FxRateKind;
  rates: readonly FxRate[];
  /** Scale and rounding of each currency the result may be in. */
  formatOf: (currency: string) => CurrencyFormat;
}

/** The step from one currency to the next: `FORWARD` rate (base to quote) or `INVERTED` (quote to base), as a numerator and a denominator. */
function step(rates: readonly FxRate[], from: string, to: string, kind: FxRateKind, day: string): FxLeg | undefined {
  const direct = fxRateInForce(rates, from, to, kind, day);
  if (direct !== undefined) return leg(direct, 'FORWARD');
  const inverse = fxRateInForce(rates, to, from, kind, day);
  return inverse === undefined ? undefined : leg(inverse, 'INVERTED');
}

const numerator = (item: FxLeg): string => (item.direction === 'FORWARD' ? item.rate : '1');
const denominator = (item: FxLeg): string => (item.direction === 'FORWARD' ? '1' : item.rate);

/**
 * Converts an amount between two currencies with the rates in force on a day. The same currency is the identity (rounded to its scale). Otherwise the pair's
 * own rate is used, forward or inverted; failing that the amount crosses through VND (`from` to VND to `to`), the two legs multiplied exactly and the result
 * rounded once. A missing rate is a 422 `VALIDATION_FAILED` whose field names the missing pair (`rate:USD/VND`): there is no silent fallback to an older rate.
 */
export function convertCurrency(request: ConvertRequest): FxConversion {
  for (const code of [request.from, request.to]) if (!CURRENCY.test(code)) throw new DomainError('VALIDATION_FAILED', 422, 'currency');
  if (!isDay(request.day)) throw new DomainError('VALIDATION_FAILED', 422, 'day');
  const target = request.formatOf(request.to);
  if (request.from === request.to) return { amount: convertDecimal(request.amount, '1', '1', target.scale, target.rounding), method: 'IDENTITY', legs: [] };
  const single = step(request.rates, request.from, request.to, request.rateKind, request.day);
  if (single !== undefined) {
    return { amount: convertDecimal(request.amount, numerator(single), denominator(single), target.scale, target.rounding), method: single.direction === 'FORWARD' ? 'DIRECT' : 'INVERSE', legs: [single] };
  }
  if (request.from === FX_PIVOT_CURRENCY || request.to === FX_PIVOT_CURRENCY) throw new DomainError('VALIDATION_FAILED', 422, `rate:${request.from}/${request.to}`);
  const first = step(request.rates, request.from, FX_PIVOT_CURRENCY, request.rateKind, request.day);
  const second = step(request.rates, FX_PIVOT_CURRENCY, request.to, request.rateKind, request.day);
  if (first === undefined) throw new DomainError('VALIDATION_FAILED', 422, `rate:${request.from}/${FX_PIVOT_CURRENCY}`);
  if (second === undefined) throw new DomainError('VALIDATION_FAILED', 422, `rate:${FX_PIVOT_CURRENCY}/${request.to}`);
  const top = multiplyDecimal(numerator(first), numerator(second));
  const bottom = multiplyDecimal(denominator(first), denominator(second));
  return { amount: convertDecimal(request.amount, top, bottom, target.scale, target.rounding), method: 'CROSS', legs: [first, second] };
}
