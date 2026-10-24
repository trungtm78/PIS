import { DomainError } from './errors.ts';

export const ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
/** Digits after the point that a value may carry before it is rounded: a bound on the work, far beyond any currency or unit. */
const MAX_FRACTION_DIGITS = 18;
const MAX_SCALE = 18;

interface Parsed {
  negative: boolean;
  /** The value times 10^scale as an integer, in magnitude. */
  units: bigint;
  scale: number;
}

function parse(value: string): Parsed {
  if (!DECIMAL.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  if (fraction.length > MAX_FRACTION_DIGITS) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  return { negative, units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function render(negative: boolean, units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const text = scale === 0 ? whole : `${whole}.${digits.slice(digits.length - scale)}`;
  return negative && units !== 0n ? `-${text}` : text;
}

/** Divides `numerator` by `10^drop` and rounds the quotient by `mode` (the sign is handled by the caller: the rounding is on the magnitude). */
function roundDown(numerator: bigint, drop: number, mode: RoundingMode): bigint {
  const divisor = 10n ** BigInt(drop);
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder === 0n) return quotient;
  switch (mode) {
    case 'DOWN':
      return quotient;
    case 'UP':
      return quotient + 1n;
    case 'HALF_UP':
      return remainder * 2n >= divisor ? quotient + 1n : quotient;
    case 'HALF_EVEN': {
      const twice = remainder * 2n;
      if (twice === divisor) return quotient % 2n === 0n ? quotient : quotient + 1n;
      return twice > divisor ? quotient + 1n : quotient;
    }
  }
}

/**
 * Rounds a decimal string to `scale` digits after the point, exactly (no float is ever involved), and writes it with exactly that many
 * digits. `DOWN` and `UP` go toward and away from zero, `HALF_UP` rounds ties away from zero, `HALF_EVEN` to the even digit.
 */
export function roundDecimal(value: string, scale: number, mode: RoundingMode): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE || !ROUNDING_MODES.includes(mode)) throw new DomainError('VALIDATION_FAILED', 422, 'rounding');
  const { negative, units, scale: own } = parse(value);
  if (own <= scale) return render(negative, units * 10n ** BigInt(scale - own), scale);
  return render(negative, roundDown(units, own - scale, mode), scale);
}

/**
 * Converts an amount between two units of the same dimension through their factors to the base unit (`1 KM` is `1000` of `M`), then
 * rounds to the scale of the target unit. The factors are decimal strings; the conversion is one exact multiplication and one division.
 */
export function convertDecimal(value: string, fromFactor: string, toFactor: string, scale: number, mode: RoundingMode): string {
  const amount = parse(value);
  const from = parse(fromFactor);
  const to = parse(toFactor);
  if (from.negative || to.negative || from.units === 0n || to.units === 0n) throw new DomainError('VALIDATION_FAILED', 422, 'factor');
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE || !ROUNDING_MODES.includes(mode)) throw new DomainError('VALIDATION_FAILED', 422, 'rounding');
  // value * from / to, with every operand scaled to an integer; the result carries `scale + guard` digits before the final rounding.
  const guard = 6;
  const numerator = amount.units * from.units * 10n ** BigInt(to.scale + scale + guard);
  const denominator = to.units * 10n ** BigInt(amount.scale + from.scale);
  const wide = numerator / denominator;
  const exact = numerator % denominator === 0n;
  // A remainder below the guard digits still decides a tie: it makes the value strictly more than the half it looks like.
  const widened = exact ? wide : wide * 10n + 1n;
  const rounded = roundDown(widened, exact ? guard : guard + 1, mode);
  return render(amount.negative, rounded, scale);
}

interface Aligned {
  left: bigint;
  right: bigint;
  scale: number;
}

/** Writes both operands as signed integers over one common power of ten, so that sums and comparisons are exact. */
function align(a: string, b: string): Aligned {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const left = x.units * 10n ** BigInt(scale - x.scale);
  const right = y.units * 10n ** BigInt(scale - y.scale);
  return { left: x.negative ? -left : left, right: y.negative ? -right : right, scale };
}

function renderSigned(value: bigint, scale: number): string {
  return render(value < 0n, value < 0n ? -value : value, scale);
}

/** Exact sum of two decimal strings, written with the larger of the two scales. */
export function addDecimal(a: string, b: string): string {
  const { left, right, scale } = align(a, b);
  return renderSigned(left + right, scale);
}

/** Exact difference `a - b` of two decimal strings, written with the larger of the two scales. */
export function subtractDecimal(a: string, b: string): string {
  const { left, right, scale } = align(a, b);
  return renderSigned(left - right, scale);
}

/** -1, 0 or 1 as `a` is less than, equal to or greater than `b`; scales do not matter (`1.0` equals `1`). */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const { left, right } = align(a, b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
