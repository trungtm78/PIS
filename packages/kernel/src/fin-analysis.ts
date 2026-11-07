import { DomainError } from './errors.ts';
import { canonicalJson, sha256Hex } from './canonical-json.ts';

/**
 * The financial analysis of an investment (lane FIN-1, customer requirement AI.06): net present value, internal rate of return, payback (simple and discounted), benefit/cost ratio, total cost of
 * ownership over the life cycle, scenarios (base, favourable, adverse as parameter deltas) and sensitivity (one-way, two-way, tornado, switching values).
 *
 * Every function here is pure and decimal-exact. Money is never a float: an amount is a decimal text with at most two decimals, held as a BigInt scaled by 10^6; a rate is a percent with at most four decimals,
 * held as a BigInt scaled by 10^4. Present values are rational numbers (BigInt over BigInt) and are rounded once, at the end, half away from zero, to the decimals the result states. One convention is the
 * exception and is stated as such: the mid-period convention discounts a flow of period t by (1 + r)^(t - 1/2), which is not rational, so the square root of (1 + r) is taken with an integer square root to
 * 36 decimals (exact when 1 + r is a perfect square of a decimal, for example r = 300%), and the result is then rounded as above.
 *
 * Nothing here is invented: the inputs come from the person who answers for them, the module only computes, and every result carries the text of its formula, an echo of its inputs and the list of the
 * assumptions that the formula makes. The AI assistant may explain a result later; it produces no input and no number (AI.06). The function that fingerprints a report ties the result to the formula
 * version, so a result frozen at approval can be checked again by anyone with the same inputs (KT.02 reference results: see packages/kernel/test/fixtures/fin).
 *
 * Tolerance rules for the reference cases: a result is a decimal text. Cases whose result is exact in the hand computation (r = 0, perfect-square mid-period rates, integer flows with a rate of 10% that
 * divide) are compared as text, character for character. Cases that a textbook states to a fixed number of decimals are compared after rounding the module's result to those decimals, and the rounding
 * of the module is half away from zero, to 2 decimals for money, 6 for an IRR in percent, 4 for payback periods and ratios.
 */

export const FIN_FORMULA_VERSION = 'fin-analysis/1.0.0';

export const FIN_MAX_PERIODS = 100;
export const FIN_MONEY_DECIMALS = 2;
export const FIN_RATE_DECIMALS = 4;
export const FIN_PCT_DELTA_DECIMALS = 2;
export const FIN_MAX_SCENARIOS = 10;

export const FIN_CONVENTIONS = ['END', 'MID'] as const;
export type FinConvention = (typeof FIN_CONVENTIONS)[number];

export const FIN_PERIOD_UNITS = ['YEAR', 'QUARTER', 'MONTH'] as const;
export type FinPeriodUnit = (typeof FIN_PERIOD_UNITS)[number];

/** The kinds of a line of the cash flow: benefits and the residual value come in, the other three are costs. */
export const FIN_LINE_KINDS = ['benefit', 'capex', 'opex', 'maintenance', 'residual'] as const;
export type FinLineKind = (typeof FIN_LINE_KINDS)[number];

export const FIN_PARAMETERS = ['discountRatePp', 'benefitPct', 'capexPct', 'opexPct', 'maintenancePct', 'residualPct', 'benefitDelayPeriods'] as const;
export type FinParameter = (typeof FIN_PARAMETERS)[number];

/** The deltas that make a scenario: percent changes of a kind of line, percentage points on the discount rate, and a delay of the benefits in whole periods. */
export interface FinDeltas {
  discountRatePp?: string;
  benefitPct?: string;
  capexPct?: string;
  opexPct?: string;
  maintenancePct?: string;
  residualPct?: string;
  benefitDelayPeriods?: string;
}

export interface FinLineInput {
  period: number;
  benefit?: string;
  capex?: string;
  opex?: string;
  maintenance?: string;
  residual?: string;
}

export interface FinModelInput {
  periodUnit: FinPeriodUnit;
  /** The discount rate per period, in percent, up to four decimals. */
  discountRatePct: string;
  convention: FinConvention;
  lines: readonly FinLineInput[];
}

export interface FinScenarioInput {
  code: string;
  label: string;
  deltas: FinDeltas;
}

export type FinMeasureCode = 'NPV' | 'IRR' | 'PAYBACK' | 'DISCOUNTED_PAYBACK' | 'BCR' | 'TCO';

export const FIN_REASONS = ['NO_SIGN_CHANGE', 'MULTIPLE_ROOTS', 'NO_ROOT_IN_RANGE', 'RATE_AT_OR_BELOW_MINUS_100', 'NOT_RECOVERED', 'NO_OUTLAY', 'NO_COSTS', 'HORIZON_ZERO', 'COMPONENT_ZERO'] as const;
export type FinReason = (typeof FIN_REASONS)[number];

/** Why a measure does not apply, in the words of the customer (the screen shows its own text from the i18n keys of the same codes). */
export const FIN_REASON_TEXT: Readonly<Record<FinReason, string>> = {
  NO_SIGN_CHANGE: 'Dòng tiền ròng không đổi dấu (không có cả khoản chi lẫn khoản thu), nên không có tỷ suất nội hoàn.',
  MULTIPLE_ROOTS: 'Dòng tiền đổi dấu nhiều lần và có nhiều hơn một tỷ suất làm NPV bằng 0; không chọn một tỷ suất nào, hãy dùng NPV.',
  NO_ROOT_IN_RANGE: 'Tỷ suất làm NPV bằng 0 nằm ngoài khoảng dò từ -99,9% đến 10.000%.',
  RATE_AT_OR_BELOW_MINUS_100: 'Tỷ lệ chiết khấu từ -100% trở xuống làm hệ số chiết khấu không xác định.',
  NOT_RECOVERED: 'Vốn chưa được thu hồi trong thời gian phân tích.',
  NO_OUTLAY: 'Không có khoản chi nào làm lũy kế âm, nên không có vốn để thu hồi.',
  NO_COSTS: 'Chi phí ròng quy về hiện tại không dương, tỷ số không xác định.',
  HORIZON_ZERO: 'Thời gian phân tích chỉ có kỳ 0, không có kỳ nào để quy đổi thành chi phí bình quân hằng kỳ.',
  COMPONENT_ZERO: 'Thành phần này bằng 0 ở mọi kỳ nên không có giá trị chuyển đổi.',
};

export interface FinAssumption {
  code: string;
  text: string;
}

export interface FinMeasure<V> {
  code: FinMeasureCode;
  status: 'OK' | 'NOT_APPLICABLE';
  value: V | null;
  reason: FinReason | null;
  /** Facts about the result that are not the value: the candidates of a multiple root, the bracket of an IRR, the cumulative of a payback. */
  detail: Record<string, unknown>;
  formula: string;
  inputs: Record<string, string>;
  assumptions: FinAssumption[];
}

// ---- Decimal arithmetic over BigInt ---------------------------------------------------------------------------------------------------

const MONEY_SCALE = 6;
const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE);
/** Digits after the point that the square root of the mid-period convention is taken to. */
const SQRT_DIGITS = 36;
const SQRT_FACTOR = 10n ** BigInt(SQRT_DIGITS);

const pow10 = (digits: number): bigint => 10n ** BigInt(digits);
const absOf = (value: bigint): bigint => (value < 0n ? -value : value);

/** A rational number; the denominator is always positive. */
export interface Frac {
  n: bigint;
  d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = absOf(a);
  let y = absOf(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

const frac = (n: bigint, d: bigint): Frac => {
  const g = gcd(n, d);
  const sign = d < 0n ? -1n : 1n;
  return g <= 1n ? { n: n * sign, d: d * sign } : { n: (n / g) * sign, d: (d / g) * sign };
};

const fracDiv = (a: Frac, b: Frac): Frac => frac(a.n * b.d, a.d * b.n);

/** Integer square root: the largest r with r * r <= n. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Division rounded half away from zero; `d` is positive. */
function roundDiv(n: bigint, d: bigint): bigint {
  const magnitude = absOf(n);
  let q = magnitude / d;
  if ((magnitude % d) * 2n >= d) q += 1n;
  return n < 0n ? -q : q;
}

/** A rational as a decimal text with exactly `decimals` decimals, rounded half away from zero; never "-0.00". */
export function decimalOf(value: Frac, decimals: number): string {
  const scaled = roundDiv(value.n * pow10(decimals), value.d);
  const sign = scaled < 0n ? '-' : '';
  const digits = absOf(scaled).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  return decimals === 0 ? `${sign}${whole}` : `${sign}${whole}.${digits.slice(digits.length - decimals)}`;
}

const invalid = (field: string, reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason } });
const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const MAX_INTEGER_DIGITS = 18;

/** A decimal text as an integer scaled by 10^decimals; refuses what is not a decimal, has more decimals than allowed or is too large to be an amount. */
export function parseScaled(text: unknown, decimals: number, field: string, signed: boolean): bigint {
  if (typeof text !== 'string') throw invalid(field, 'NOT_A_DECIMAL');
  const match = DECIMAL.exec(text);
  if (match === null) throw invalid(field, 'NOT_A_DECIMAL');
  const sign = match[1] as string;
  const whole = match[2] as string;
  const fraction = match[3] ?? '';
  if (fraction.length > decimals) throw invalid(field, 'TOO_MANY_DECIMALS');
  if (whole.length > MAX_INTEGER_DIGITS) throw invalid(field, 'TOO_LARGE');
  if (sign === '-' && !signed && /[1-9]/.test(whole + fraction)) throw invalid(field, 'MUST_NOT_BE_NEGATIVE');
  const value = BigInt(whole) * pow10(decimals) + BigInt(fraction.padEnd(decimals, '0') === '' ? '0' : fraction.padEnd(decimals, '0'));
  return sign === '-' ? -value : value;
}

// ---- The model ------------------------------------------------------------------------------------------------------------------------

export interface FinSeries {
  horizon: number;
  /** Every array has horizon + 1 entries, the value of a period times 10^6. */
  benefit: bigint[];
  capex: bigint[];
  opex: bigint[];
  maintenance: bigint[];
  residual: bigint[];
}

export interface FinExactModel {
  periodUnit: FinPeriodUnit;
  convention: FinConvention;
  /** Percent times 10^4. */
  ratePct4: bigint;
  series: FinSeries;
}

type Model = FinExactModel;

const zeros = (length: number): bigint[] => Array.from({ length }, () => 0n);
const RATE_LIMIT_PCT4 = 1000n * pow10(FIN_RATE_DECIMALS);

/** Checks a model and brings it to its exact form. 422 VALIDATION_FAILED names the field and the reason, never the value. */
export function normalizeModel(input: FinModelInput): Model {
  if (!(FIN_PERIOD_UNITS as readonly string[]).includes(input.periodUnit)) throw invalid('period_unit', 'UNKNOWN_PERIOD_UNIT');
  if (!(FIN_CONVENTIONS as readonly string[]).includes(input.convention)) throw invalid('convention', 'UNKNOWN_CONVENTION');
  const ratePct4 = parseScaled(input.discountRatePct, FIN_RATE_DECIMALS, 'discount_rate_pct', true);
  if (absOf(ratePct4) > RATE_LIMIT_PCT4) throw invalid('discount_rate_pct', 'OUT_OF_RANGE');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw invalid('lines', 'EMPTY');
  const seen = new Set<number>();
  let horizon = 0;
  input.lines.forEach((line, index) => {
    if (!Number.isInteger(line.period) || line.period < 0 || line.period > FIN_MAX_PERIODS) throw invalid(`lines[${index}].period`, 'OUT_OF_RANGE');
    if (seen.has(line.period)) throw invalid(`lines[${index}].period`, 'DUPLICATE_PERIOD');
    seen.add(line.period);
    horizon = Math.max(horizon, line.period);
  });
  const series: FinSeries = { horizon, benefit: zeros(horizon + 1), capex: zeros(horizon + 1), opex: zeros(horizon + 1), maintenance: zeros(horizon + 1), residual: zeros(horizon + 1) };
  input.lines.forEach((line, index) => {
    for (const kind of FIN_LINE_KINDS) {
      const text = line[kind];
      if (text === undefined || text === '') continue;
      (series[kind] as bigint[])[line.period] = parseScaled(text, FIN_MONEY_DECIMALS, `lines[${index}].${kind}`, false) * pow10(MONEY_SCALE - FIN_MONEY_DECIMALS);
    }
  });
  return { periodUnit: input.periodUnit, convention: input.convention, ratePct4, series };
}

const netOf = (series: FinSeries): bigint[] => series.benefit.map((_, t) => (series.benefit[t] as bigint) + (series.residual[t] as bigint) - (series.capex[t] as bigint) - (series.opex[t] as bigint) - (series.maintenance[t] as bigint));
const costOf = (series: FinSeries): bigint[] => series.capex.map((_, t) => (series.capex[t] as bigint) + (series.opex[t] as bigint) + (series.maintenance[t] as bigint));

const sumOf = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

/** An amount scaled by 10^6 as text with two decimals (exact when it came from an input; rounded half away from zero otherwise). */
const moneyText = (scaled: bigint): string => decimalOf({ n: scaled, d: MONEY_FACTOR }, FIN_MONEY_DECIMALS);
const rateText = (pct4: bigint): string => decimalOf({ n: pct4, d: pow10(FIN_RATE_DECIMALS) }, FIN_RATE_DECIMALS);

// ---- Present value --------------------------------------------------------------------------------------------------------------------

/** The rate as 1 + r = u / b, with u and b integers (b a power of ten). u is not positive when the rate is -100% or below. */
interface Rate {
  u: bigint;
  b: bigint;
}

const rateOf = (pct4: bigint): Rate => {
  const b = pow10(FIN_RATE_DECIMALS + 2);
  return { u: b + pct4, b };
};

const NO_DISCOUNT: Rate = { u: 1n, b: 1n };

/**
 * The cumulative present value after each period, as exact rationals (the real amount, not scaled). Over the common denominator u^t the cumulative of the end-of-period convention is
 * N_t = N_(t-1) * u + cf_t * b^t; the mid-period convention keeps the period 0 flow apart and multiplies the rest by the square root of u / b.
 */
function cumulativePresentValue(flows: readonly bigint[], rate: Rate, convention: FinConvention): Frac[] {
  const out: Frac[] = [];
  const sq = isqrt((rate.u * SQRT_FACTOR * SQRT_FACTOR) / rate.b);
  let later = 0n; // the sum of the flows of periods 1..t over u^t
  let upower = 1n;
  let bpower = 1n;
  for (let t = 0; t < flows.length; t += 1) {
    const flow = flows[t] as bigint;
    if (t === 0) {
      out.push(frac(flow, MONEY_FACTOR));
      continue;
    }
    upower *= rate.u;
    bpower *= rate.b;
    later = later * rate.u + flow * bpower;
    const first = (flows[0] as bigint) * upower;
    out.push(
      convention === 'END'
        ? frac(first + later, upower * MONEY_FACTOR)
        : frac(first * SQRT_FACTOR + sq * later, upower * SQRT_FACTOR * MONEY_FACTOR),
    );
  }
  return out;
}

/** The present value of the flows (the last element of the cumulative). */
function presentValue(flows: readonly bigint[], rate: Rate, convention: FinConvention): Frac {
  const cumulative = cumulativePresentValue(flows, rate, convention);
  return cumulative[cumulative.length - 1] as Frac;
}

/** The discount factor of period t as an exact rational: (b/u)^t, times the square root of u/b from period 1 on in the mid-period convention. */
function discountFactor(t: number, rate: Rate, convention: FinConvention): Frac {
  const base = frac(rate.b ** BigInt(t), rate.u ** BigInt(t));
  if (convention === 'END' || t === 0) return base;
  const sq = isqrt((rate.u * SQRT_FACTOR * SQRT_FACTOR) / rate.b);
  return frac(base.n * sq, base.d * SQRT_FACTOR);
}

// ---- Measures -------------------------------------------------------------------------------------------------------------------------

const ASSUMPTION = {
  END_PERIOD: { code: 'END_PERIOD', text: 'Mỗi dòng tiền phát sinh vào cuối kỳ của nó; kỳ 0 là hôm nay và không bị chiết khấu.' },
  MID_PERIOD: { code: 'MID_PERIOD', text: 'Dòng tiền của kỳ t phát sinh giữa kỳ và bị chiết khấu (t - 1/2) kỳ; kỳ 0 là hôm nay và không bị chiết khấu. Căn bậc hai lấy chính xác đến 36 chữ số thập phân.' },
  RATE_PER_PERIOD: { code: 'RATE_PER_PERIOD', text: 'Tỷ lệ chiết khấu tính cho một kỳ và không đổi trong suốt thời gian phân tích.' },
  EXACT_ARITHMETIC: { code: 'EXACT_ARITHMETIC', text: 'Tính bằng số thập phân chính xác (phân số số nguyên lớn); chỉ làm tròn một lần ở kết quả, theo nguyên tắc nửa ra xa số 0.' },
  IRR_ROOT: { code: 'IRR_ROOT', text: 'IRR là tỷ suất làm NPV bằng 0, tìm bằng cách dò dấu của NPV trên lưới từ -99,9% đến 10.000% rồi chia đôi khoảng; không phụ thuộc quy ước giữa kỳ hay cuối kỳ. Một nghiệm bội chẵn chạm trục mà không đổi dấu không bị phát hiện.' },
  IRR_UNIQUE: { code: 'IRR_UNIQUE', text: 'Chỉ báo IRR khi có đúng một nghiệm; có nhiều nghiệm thì không báo tỷ suất nào.' },
  PAYBACK_FIRST: { code: 'PAYBACK_FIRST', text: 'Hoàn vốn là lần đầu lũy kế quay lại không âm sau khi đã âm; dòng tiền trong một kỳ phát sinh đều nên phần lẻ của kỳ được nội suy tuyến tính.' },
  PAYBACK_DISCOUNTED: { code: 'PAYBACK_DISCOUNTED', text: 'Hoàn vốn có chiết khấu dùng giá trị hiện tại của từng kỳ theo cùng tỷ lệ và quy ước của NPV.' },
  BCR_NET_COST: { code: 'BCR_NET_COST', text: 'Chi phí ở mẫu số là vốn đầu tư, vận hành và bảo trì, trừ giá trị thu hồi; tử số là lợi ích.' },
  TCO_RESIDUAL: { code: 'TCO_RESIDUAL', text: 'Giá trị thu hồi làm giảm chi phí sở hữu; chi phí bình quân hằng kỳ là giá trị hiện tại chia cho hệ số niên kim của các kỳ 1..T.' },
} as const satisfies Record<string, FinAssumption>;

const conventionAssumption = (convention: FinConvention): FinAssumption => (convention === 'END' ? ASSUMPTION.END_PERIOD : ASSUMPTION.MID_PERIOD);

const base = (model: Model): Record<string, string> => ({ discount_rate_pct: rateText(model.ratePct4), convention: model.convention, period_unit: model.periodUnit, last_period: String(model.series.horizon) });

const flowsEcho = (flows: readonly bigint[]): string => flows.map(moneyText).join(' | ');

function notApplicable<V>(code: FinMeasureCode, reason: FinReason, formula: string, inputs: Record<string, string>, assumptions: FinAssumption[], detail: Record<string, unknown> = {}): FinMeasure<V> {
  return { code, status: 'NOT_APPLICABLE', value: null, reason, detail, formula, inputs, assumptions };
}

const NPV_FORMULA = 'NPV = Σ CF(t) / (1 + r)^t, t = 0..T, với CF(t) = lợi ích(t) + giá trị thu hồi(t) - vốn đầu tư(t) - vận hành(t) - bảo trì(t); giữa kỳ: số mũ là (t - 1/2) từ kỳ 1';

/** The net present value of the model. */
export function npvOf(model: Model): FinMeasure<string> {
  const flows = netOf(model.series);
  const rate = rateOf(model.ratePct4);
  const inputs = { ...base(model), net_flows: flowsEcho(flows) };
  const assumptions = [conventionAssumption(model.convention), ASSUMPTION.RATE_PER_PERIOD, ASSUMPTION.EXACT_ARITHMETIC];
  if (rate.u <= 0n) return notApplicable('NPV', 'RATE_AT_OR_BELOW_MINUS_100', NPV_FORMULA, inputs, assumptions);
  const exact = presentValue(flows, rate, model.convention);
  return { code: 'NPV', status: 'OK', value: decimalOf(exact, FIN_MONEY_DECIMALS), reason: null, detail: {}, formula: NPV_FORMULA, inputs, assumptions };
}

/** The exact net present value, or null when the rate does not allow one. */
function npvExact(model: Model): Frac | null {
  const rate = rateOf(model.ratePct4);
  return rate.u <= 0n ? null : presentValue(netOf(model.series), rate, model.convention);
}

// ---- IRR --------------------------------------------------------------------------------------------------------------------------------

const IRR_FORMULA = 'IRR là r sao cho NPV(r) = Σ CF(t) / (1 + r)^t = 0';
/** The grid of the scan, in thousandths of the rate: every 0.1% from -99.9% to 100%, every 1% to 1000%, every 10% to 10000%. */
const GRID: readonly number[] = (() => {
  const out: number[] = [];
  for (let m = -999; m <= 1000; m += 1) out.push(m);
  for (let m = 1010; m <= 10000; m += 10) out.push(m);
  for (let m = 10100; m <= 100000; m += 100) out.push(m);
  return out;
})();

/** The sign of the sum of cf(t) * v^t * u^(T-t) (the sign of the NPV at the rate u/v - 1 when u > 0), by Horner's rule; flows are already multiplied by v^t. */
function signAt(scaled: readonly bigint[], u: bigint): -1 | 0 | 1 {
  let acc = 0n;
  for (const term of scaled) acc = acc * u + term;
  return acc === 0n ? 0 : acc < 0n ? -1 : 1;
}

const scaledByPower = (flows: readonly bigint[], v: bigint): bigint[] => {
  let power = 1n;
  return flows.map((flow, t) => {
    if (t > 0) power *= v;
    return flow * power;
  });
};

interface RootBracket {
  /** The rate at both ends in thousandths of the rate; equal when the grid hit the root. */
  lo: number;
  hi: number;
}

const changes = (flows: readonly bigint[]): number => {
  let count = 0;
  let last = 0;
  for (const flow of flows) {
    const sign = flow === 0n ? 0 : flow < 0n ? -1 : 1;
    if (sign === 0) continue;
    if (last !== 0 && sign !== last) count += 1;
    last = sign;
  }
  return count;
};

/** Refines a bracket to a rate in the scale 10^12 by bisection on the exact sign; returns the rate as a rational of that scale. */
function refine(flows: readonly bigint[], bracket: RootBracket): { numerator: bigint; lo: bigint; hi: bigint } {
  const scale = 10n ** 12n;
  const v = scale;
  const scaled = scaledByPower(flows, v);
  let lo = BigInt(bracket.lo) * 10n ** 9n;
  let hi = BigInt(bracket.hi) * 10n ** 9n;
  if (lo === hi) return { numerator: lo, lo, hi };
  const signLo = signAt(scaled, scale + lo);
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const sign = signAt(scaled, scale + mid);
    if (sign === 0) return { numerator: mid, lo: mid, hi: mid };
    if (sign === signLo) lo = mid;
    else hi = mid;
  }
  return { numerator: lo, lo, hi };
}

const irrPctText = (numerator: bigint): string => decimalOf({ n: numerator * 100n, d: 10n ** 12n }, 6);

/** The internal rate of return of the net flows. */
export function irrOf(model: Model): FinMeasure<string> {
  const flows = netOf(model.series);
  const inputs = { ...base(model), net_flows: flowsEcho(flows) };
  const assumptions = [ASSUMPTION.IRR_ROOT, ASSUMPTION.IRR_UNIQUE, ASSUMPTION.EXACT_ARITHMETIC];
  const na = (reason: FinReason, detail: Record<string, unknown> = {}): FinMeasure<string> => notApplicable('IRR', reason, IRR_FORMULA, inputs, assumptions, detail);
  if (changes(flows) === 0) return na('NO_SIGN_CHANGE', { sign_changes: 0 });
  const scaled = scaledByPower(flows, 1000n);
  const brackets: RootBracket[] = [];
  let previous = 0;
  let previousAt = 0;
  let zeroSince = false;
  for (const m of GRID) {
    const sign = signAt(scaled, 1000n + BigInt(m));
    if (sign === 0) {
      brackets.push({ lo: m, hi: m });
      zeroSince = true;
      continue;
    }
    if (previous !== 0 && sign !== previous && !zeroSince) brackets.push({ lo: previousAt, hi: m });
    previous = sign;
    previousAt = m;
    zeroSince = false;
  }
  const signChanges = changes(flows);
  if (brackets.length === 0) return na('NO_ROOT_IN_RANGE', { sign_changes: signChanges });
  if (brackets.length > 1) {
    const candidates = brackets.map((bracket) => irrPctText(refine(flows, bracket).numerator));
    return na('MULTIPLE_ROOTS', { sign_changes: signChanges, candidates_pct: candidates });
  }
  const root = refine(flows, brackets[0] as RootBracket);
  return {
    code: 'IRR',
    status: 'OK',
    value: irrPctText(root.numerator),
    reason: null,
    detail: { sign_changes: signChanges, bracket_pct: [irrPctText(root.lo), irrPctText(root.hi)], method: 'grid scan then bisection on the exact sign of the NPV' },
    formula: IRR_FORMULA,
    inputs,
    assumptions,
  };
}

// ---- Payback --------------------------------------------------------------------------------------------------------------------------

const PAYBACK_FORMULA = 'Hoàn vốn = (T - 1) + |lũy kế(T - 1)| / dòng tiền(T), với T là kỳ đầu tiên lũy kế quay lại không âm sau khi đã âm';
const DISCOUNTED_PAYBACK_FORMULA = 'Hoàn vốn có chiết khấu = (T - 1) + |lũy kế PV(T - 1)| / PV dòng tiền(T), với PV(t) = CF(t) / (1 + r)^t';

function paybackOf(model: Model, discounted: boolean): FinMeasure<string> {
  const code: FinMeasureCode = discounted ? 'DISCOUNTED_PAYBACK' : 'PAYBACK';
  const formula = discounted ? DISCOUNTED_PAYBACK_FORMULA : PAYBACK_FORMULA;
  const flows = netOf(model.series);
  const rate = discounted ? rateOf(model.ratePct4) : NO_DISCOUNT;
  const inputs: Record<string, string> = discounted ? { ...base(model), net_flows: flowsEcho(flows) } : { period_unit: model.periodUnit, last_period: String(model.series.horizon), net_flows: flowsEcho(flows) };
  const assumptions: FinAssumption[] = discounted ? [ASSUMPTION.PAYBACK_FIRST, ASSUMPTION.PAYBACK_DISCOUNTED, conventionAssumption(model.convention), ASSUMPTION.EXACT_ARITHMETIC] : [ASSUMPTION.PAYBACK_FIRST, ASSUMPTION.EXACT_ARITHMETIC];
  if (rate.u <= 0n) return notApplicable(code, 'RATE_AT_OR_BELOW_MINUS_100', formula, inputs, assumptions);
  const cumulative = cumulativePresentValue(flows, rate, discounted ? model.convention : 'END');
  const firstNegative = cumulative.findIndex((value) => value.n < 0n);
  if (firstNegative < 0) return notApplicable(code, 'NO_OUTLAY', formula, inputs, assumptions);
  let at = -1;
  for (let t = firstNegative + 1; t < cumulative.length; t += 1) {
    if ((cumulative[t] as Frac).n >= 0n) {
      at = t;
      break;
    }
  }
  const last = cumulative[cumulative.length - 1] as Frac;
  if (at < 0) return notApplicable(code, 'NOT_RECOVERED', formula, inputs, assumptions, { cumulative_at_end: decimalOf(last, FIN_MONEY_DECIMALS) });
  const before = cumulative[at - 1] as Frac;
  const after = cumulative[at] as Frac;
  // fraction = -before / (after - before) = -n1 * d2 / (n2 * d1 - n1 * d2)
  const numerator = -before.n * after.d;
  const denominator = after.n * before.d - before.n * after.d;
  const whole = BigInt(at - 1);
  const value: Frac = frac(whole * denominator + numerator, denominator);
  const reverts = cumulative.slice(at + 1).some((later) => later.n < 0n);
  return {
    code,
    status: 'OK',
    value: decimalOf(value, 4),
    reason: null,
    detail: { recovered_in_period: at, cumulative_before: decimalOf(before, FIN_MONEY_DECIMALS), cumulative_after: decimalOf(after, FIN_MONEY_DECIMALS), falls_below_zero_again: reverts },
    formula,
    inputs,
    assumptions,
  };
}

// ---- Benefit/cost ratio and total cost of ownership -----------------------------------------------------------------------------------------

const BCR_FORMULA = 'B/C = PV(lợi ích) / (PV(vốn đầu tư) + PV(vận hành) + PV(bảo trì) - PV(giá trị thu hồi))';

export function bcrOf(model: Model): FinMeasure<string> {
  const rate = rateOf(model.ratePct4);
  const inputs = base(model);
  const assumptions = [ASSUMPTION.BCR_NET_COST, conventionAssumption(model.convention), ASSUMPTION.RATE_PER_PERIOD, ASSUMPTION.EXACT_ARITHMETIC];
  if (rate.u <= 0n) return notApplicable('BCR', 'RATE_AT_OR_BELOW_MINUS_100', BCR_FORMULA, inputs, assumptions);
  const pv = (flows: readonly bigint[]): Frac => presentValue(flows, rate, model.convention);
  const benefits = pv(model.series.benefit);
  const netCost = pv(costOf(model.series).map((cost, t) => cost - (model.series.residual[t] as bigint)));
  if (netCost.n <= 0n) return notApplicable('BCR', 'NO_COSTS', BCR_FORMULA, inputs, assumptions, { pv_benefits: decimalOf(benefits, FIN_MONEY_DECIMALS), pv_net_cost: decimalOf(netCost, FIN_MONEY_DECIMALS) });
  return {
    code: 'BCR',
    status: 'OK',
    value: decimalOf(fracDiv(benefits, netCost), 4),
    reason: null,
    detail: { pv_benefits: decimalOf(benefits, FIN_MONEY_DECIMALS), pv_net_cost: decimalOf(netCost, FIN_MONEY_DECIMALS) },
    formula: BCR_FORMULA,
    inputs,
    assumptions,
  };
}

export interface FinTco {
  nominalTotal: string;
  presentValueTotal: string;
  /** The present value of the total cost spread over the periods 1..T as a level cost; null for a horizon of one period 0. */
  equivalentPerPeriod: string | null;
  byKind: Record<'capex' | 'opex' | 'maintenance' | 'residual', { nominal: string; presentValue: string }>;
  capexSharePct: string | null;
}

const TCO_FORMULA = 'TCO = Σ (vốn đầu tư(t) + vận hành(t) + bảo trì(t) - giá trị thu hồi(t)) / (1 + r)^t; chi phí bình quân hằng kỳ = PV(TCO) / Σ 1 / (1 + r)^t, t = 1..T';

export function tcoOf(model: Model): FinMeasure<FinTco> {
  const rate = rateOf(model.ratePct4);
  const inputs = base(model);
  const assumptions = [ASSUMPTION.TCO_RESIDUAL, conventionAssumption(model.convention), ASSUMPTION.RATE_PER_PERIOD, ASSUMPTION.EXACT_ARITHMETIC];
  if (rate.u <= 0n) return notApplicable('TCO', 'RATE_AT_OR_BELOW_MINUS_100', TCO_FORMULA, inputs, assumptions);
  const { series } = model;
  const pv = (flows: readonly bigint[]): Frac => presentValue(flows, rate, model.convention);
  const kinds = { capex: series.capex, opex: series.opex, maintenance: series.maintenance, residual: series.residual } as const;
  const byKind = Object.fromEntries(
    (Object.keys(kinds) as Array<keyof typeof kinds>).map((kind) => [kind, { nominal: moneyText(sumOf(kinds[kind])), presentValue: decimalOf(pv(kinds[kind]), FIN_MONEY_DECIMALS) }]),
  ) as FinTco['byKind'];
  const total = costOf(series).map((cost, t) => cost - (series.residual[t] as bigint));
  const present = pv(total);
  const level = series.horizon === 0 ? null : pv(series.benefit.map((_, t) => (t === 0 ? 0n : MONEY_FACTOR)));
  const grossPv = pv(costOf(series));
  return {
    code: 'TCO',
    status: 'OK',
    value: {
      nominalTotal: moneyText(sumOf(total)),
      presentValueTotal: decimalOf(present, FIN_MONEY_DECIMALS),
      equivalentPerPeriod: level === null || level.n <= 0n ? null : decimalOf(fracDiv(present, level), FIN_MONEY_DECIMALS),
      byKind,
      capexSharePct: grossPv.n <= 0n ? null : decimalOf(fracDiv({ n: pv(series.capex).n * 100n, d: pv(series.capex).d }, grossPv), 2),
    },
    reason: null,
    detail: {},
    formula: TCO_FORMULA,
    inputs,
    assumptions,
  };
}

// ---- The table of the cash flow -------------------------------------------------------------------------------------------------------

export interface FinTableRow {
  period: number;
  benefit: string;
  capex: string;
  opex: string;
  maintenance: string;
  residual: string;
  net: string;
  /** The discount factor to 8 decimals; null when the rate does not allow one. */
  factor: string | null;
  presentValue: string | null;
  cumulativeNet: string;
  cumulativePresentValue: string | null;
}

export function tableOf(model: Model): FinTableRow[] {
  const flows = netOf(model.series);
  const rate = rateOf(model.ratePct4);
  const cumulativeNet = cumulativePresentValue(flows, NO_DISCOUNT, 'END');
  const cumulativePv = rate.u <= 0n ? null : cumulativePresentValue(flows, rate, model.convention);
  return flows.map((flow, t) => {
    const factor = rate.u <= 0n ? null : discountFactor(t, rate, model.convention);
    return {
      period: t,
      benefit: moneyText(model.series.benefit[t] as bigint),
      capex: moneyText(model.series.capex[t] as bigint),
      opex: moneyText(model.series.opex[t] as bigint),
      maintenance: moneyText(model.series.maintenance[t] as bigint),
      residual: moneyText(model.series.residual[t] as bigint),
      net: moneyText(flow),
      factor: factor === null ? null : decimalOf(factor, 8),
      presentValue: factor === null ? null : decimalOf(frac(factor.n * flow, factor.d * MONEY_FACTOR), FIN_MONEY_DECIMALS),
      cumulativeNet: decimalOf(cumulativeNet[t] as Frac, FIN_MONEY_DECIMALS),
      cumulativePresentValue: cumulativePv === null ? null : decimalOf(cumulativePv[t] as Frac, FIN_MONEY_DECIMALS),
    };
  });
}

// ---- One analysis ---------------------------------------------------------------------------------------------------------------------

export interface FinAnalysis {
  table: FinTableRow[];
  npv: FinMeasure<string>;
  irr: FinMeasure<string>;
  payback: FinMeasure<string>;
  discountedPayback: FinMeasure<string>;
  bcr: FinMeasure<string>;
  tco: FinMeasure<FinTco>;
}

export function analyse(input: FinModelInput): FinAnalysis {
  return analyseModel(normalizeModel(input));
}

function analyseModel(model: Model): FinAnalysis {
  return { table: tableOf(model), npv: npvOf(model), irr: irrOf(model), payback: paybackOf(model, false), discountedPayback: paybackOf(model, true), bcr: bcrOf(model), tco: tcoOf(model) };
}

/** The figures of one case in a row of a table: the value of each measure or the reason it does not apply. */
export interface FinHeadline {
  npv: string | null;
  irrPct: string | null;
  irrReason: FinReason | null;
  paybackPeriods: string | null;
  paybackReason: FinReason | null;
  discountedPaybackPeriods: string | null;
  discountedPaybackReason: FinReason | null;
  bcr: string | null;
  bcrReason: FinReason | null;
  tcoPresentValue: string | null;
}

function headlineOf(model: Model): FinHeadline {
  const npv = npvOf(model);
  const irr = irrOf(model);
  const payback = paybackOf(model, false);
  const discounted = paybackOf(model, true);
  const bcr = bcrOf(model);
  const tco = tcoOf(model);
  return {
    npv: npv.value,
    irrPct: irr.value,
    irrReason: irr.reason,
    paybackPeriods: payback.value,
    paybackReason: payback.reason,
    discountedPaybackPeriods: discounted.value,
    discountedPaybackReason: discounted.reason,
    bcr: bcr.value,
    bcrReason: bcr.reason,
    tcoPresentValue: tco.value === null ? null : tco.value.presentValueTotal,
  };
}

// ---- Deltas, scenarios and sensitivity -------------------------------------------------------------------------------------------------

const PCT_PARAMETERS = ['benefitPct', 'capexPct', 'opexPct', 'maintenancePct', 'residualPct'] as const;
type PctParameter = (typeof PCT_PARAMETERS)[number];
const KIND_OF: Readonly<Record<PctParameter, 'benefit' | 'capex' | 'opex' | 'maintenance' | 'residual'>> = { benefitPct: 'benefit', capexPct: 'capex', opexPct: 'opex', maintenancePct: 'maintenance', residualPct: 'residual' };
const PCT_LIMIT = 1000n * 100n;

/** The deltas of a scenario in exact form: percent changes in hundredths of a percent, the rate change in ten-thousandths of a percent, the delay in whole periods. */
interface ExactDeltas {
  pct: Record<PctParameter, bigint>;
  rate4: bigint;
  delay: number;
}

function exactDeltas(deltas: FinDeltas, field: string): ExactDeltas {
  const pct = { benefitPct: 0n, capexPct: 0n, opexPct: 0n, maintenancePct: 0n, residualPct: 0n } as Record<PctParameter, bigint>;
  for (const key of PCT_PARAMETERS) {
    const text = deltas[key];
    if (text === undefined || text === '') continue;
    const value = parseScaled(text, FIN_PCT_DELTA_DECIMALS, `${field}.${key}`, true);
    if (value < -100n * 100n || value > PCT_LIMIT) throw invalid(`${field}.${key}`, 'OUT_OF_RANGE');
    pct[key] = value;
  }
  const ratePp = deltas.discountRatePp;
  const rate4 = ratePp === undefined || ratePp === '' ? 0n : parseScaled(ratePp, FIN_RATE_DECIMALS, `${field}.discountRatePp`, true);
  if (absOf(rate4) > RATE_LIMIT_PCT4) throw invalid(`${field}.discountRatePp`, 'OUT_OF_RANGE');
  const delayText = deltas.benefitDelayPeriods;
  let delay = 0;
  if (delayText !== undefined && delayText !== '') {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(delayText) || Number(delayText) > FIN_MAX_PERIODS) throw invalid(`${field}.benefitDelayPeriods`, 'OUT_OF_RANGE');
    delay = Number(delayText);
  }
  for (const key of Object.keys(deltas)) if (!(FIN_PARAMETERS as readonly string[]).includes(key)) throw invalid(`${field}.${key}`, 'UNKNOWN_PARAMETER');
  return { pct, rate4, delay };
}

const addDeltas = (a: ExactDeltas, b: ExactDeltas): ExactDeltas => ({
  pct: Object.fromEntries(PCT_PARAMETERS.map((key) => [key, a.pct[key] + b.pct[key]])) as Record<PctParameter, bigint>,
  rate4: a.rate4 + b.rate4,
  delay: a.delay + b.delay,
});

const NO_DELTAS: ExactDeltas = { pct: { benefitPct: 0n, capexPct: 0n, opexPct: 0n, maintenancePct: 0n, residualPct: 0n }, rate4: 0n, delay: 0 };

/** The model with the deltas applied once to the inputs; a percent change is an exact multiplication, a delay shifts the benefits to later periods and drops what goes past the last period. */
function applyDeltas(model: Model, deltas: ExactDeltas, field: string): Model {
  const series: FinSeries = { ...model.series };
  for (const key of PCT_PARAMETERS) {
    const kind = KIND_OF[key];
    const factor = 10_000n + deltas.pct[key];
    if (factor < 0n) throw invalid(`${field}.${key}`, 'OUT_OF_RANGE');
    series[kind] = (model.series[kind] as bigint[]).map((value) => {
      const product = value * factor;
      // Inputs have two decimals, so a value is a multiple of 10^4 and the product is a multiple of the divisor.
      return product / 10_000n;
    });
  }
  if (deltas.delay > 0) {
    series.benefit = series.benefit.map((_, t) => (t - deltas.delay >= 0 ? (series.benefit[t - deltas.delay] as bigint) : 0n));
  }
  return { ...model, ratePct4: model.ratePct4 + deltas.rate4, series };
}

export interface FinScenarioResult {
  code: string;
  label: string;
  deltas: FinDeltas;
  headline: FinHeadline;
}

const SCENARIO_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

export { FIN_DEFAULT_SCENARIOS } from './fin-defaults.ts';

export function assertScenarios(scenarios: readonly FinScenarioInput[]): void {
  if (scenarios.length > FIN_MAX_SCENARIOS) throw invalid('scenarios', 'TOO_MANY');
  const seen = new Set<string>(['BASE']);
  scenarios.forEach((scenario, index) => {
    if (!SCENARIO_CODE.test(scenario.code)) throw invalid(`scenarios[${index}].code`, 'NOT_A_CODE');
    if (seen.has(scenario.code)) throw invalid(`scenarios[${index}].code`, 'DUPLICATE_CODE');
    seen.add(scenario.code);
    if (typeof scenario.label !== 'string' || scenario.label.trim() === '' || scenario.label.length > 120) throw invalid(`scenarios[${index}].label`, 'EMPTY');
    exactDeltas(scenario.deltas, `scenarios[${index}].deltas`);
  });
}

function runScenarios(model: Model, scenarios: readonly FinScenarioInput[]): FinScenarioResult[] {
  assertScenarios(scenarios);
  const base: FinScenarioResult = { code: 'BASE', label: 'Cơ sở', deltas: {}, headline: headlineOf(model) };
  return [
    base,
    ...scenarios.map((scenario, index): FinScenarioResult => ({ code: scenario.code, label: scenario.label, deltas: scenario.deltas, headline: headlineOf(applyDeltas(model, exactDeltas(scenario.deltas, `scenarios[${index}].deltas`), `scenarios[${index}].deltas`)) })),
  ];
}

export interface FinSensitivityConfig {
  /** The points of a one-way table for each parameter: percent changes, points of rate and whole periods of delay, as texts. */
  oneWay?: Partial<Record<FinParameter, readonly string[]>>;
  /** The two-way table: two parameters and their points. */
  twoWay?: { x: FinParameter; xPoints: readonly string[]; y: FinParameter; yPoints: readonly string[] };
  /** How far each parameter goes either side in the tornado. */
  tornado?: { pctSwing?: string; ratePpSwing?: string; delaySwing?: string };
  /** The deltas of a scenario the sensitivity is run around (default: the base case). */
  around?: FinDeltas;
}

export const FIN_DEFAULT_SENSITIVITY: Required<Omit<FinSensitivityConfig, 'around'>> = {
  oneWay: {
    benefitPct: ['-20', '-10', '0', '10', '20'],
    capexPct: ['-20', '-10', '0', '10', '20'],
    opexPct: ['-20', '-10', '0', '10', '20'],
    maintenancePct: ['-20', '-10', '0', '10', '20'],
    residualPct: ['-20', '-10', '0', '10', '20'],
    discountRatePp: ['-2', '-1', '0', '1', '2'],
    benefitDelayPeriods: ['0', '1', '2'],
  },
  twoWay: { x: 'benefitPct', xPoints: ['-20', '-10', '0', '10', '20'], y: 'capexPct', yPoints: ['-20', '-10', '0', '10', '20'] },
  tornado: { pctSwing: '10', ratePpSwing: '1', delaySwing: '1' },
};

export interface FinOneWayPoint {
  delta: string;
  headline: FinHeadline;
}

export interface FinOneWayTable {
  parameter: FinParameter;
  points: FinOneWayPoint[];
}

export interface FinTwoWayTable {
  x: FinParameter;
  y: FinParameter;
  xPoints: string[];
  yPoints: string[];
  /** The NPV of each cell; rows follow `yPoints`, columns follow `xPoints`; null when the rate does not allow an NPV. */
  npv: Array<Array<string | null>>;
}

export interface FinTornadoBar {
  parameter: FinParameter;
  low: { delta: string; npv: string | null };
  high: { delta: string; npv: string | null };
  /** The absolute difference between the two NPVs; null when either does not exist. */
  swing: string | null;
}

export interface FinSwitchingValue {
  parameter: PctParameter;
  status: 'OK' | 'NOT_APPLICABLE';
  /** The percent change of this line that makes the NPV exactly zero while everything else stays; null when it does not exist. */
  pct: string | null;
  reason: FinReason | null;
}

const deltaOf = (parameter: FinParameter, value: string): FinDeltas => ({ [parameter]: value }) as FinDeltas;
const addEcho = (around: ExactDeltas, parameter: FinParameter, value: string, field: string): ExactDeltas => addDeltas(around, exactDeltas(deltaOf(parameter, value), field));

function oneWay(model: Model, around: ExactDeltas, parameter: FinParameter, points: readonly string[]): FinOneWayTable {
  return { parameter, points: points.map((delta) => ({ delta, headline: headlineOf(applyDeltas(model, addEcho(around, parameter, delta, `one_way.${parameter}`), `one_way.${parameter}`)) })) };
}

function twoWay(model: Model, around: ExactDeltas, config: NonNullable<FinSensitivityConfig['twoWay']>): FinTwoWayTable {
  if (config.x === config.y) throw invalid('two_way', 'SAME_PARAMETER');
  const npv = config.yPoints.map((y) =>
    config.xPoints.map((x) => {
      const exact = addDeltas(addEcho(around, config.x, x, 'two_way.x'), addEcho(NO_DELTAS, config.y, y, 'two_way.y'));
      const value = npvExact(applyDeltas(model, exact, 'two_way'));
      return value === null ? null : decimalOf(value, FIN_MONEY_DECIMALS);
    }),
  );
  return { x: config.x, y: config.y, xPoints: [...config.xPoints], yPoints: [...config.yPoints], npv };
}

function tornado(model: Model, around: ExactDeltas, config: NonNullable<FinSensitivityConfig['tornado']>): FinTornadoBar[] {
  const pct = config.pctSwing ?? '10';
  const rate = config.ratePpSwing ?? '1';
  const delay = config.delaySwing ?? '1';
  const negate = (text: string): string => (text.startsWith('-') ? text.slice(1) : `-${text}`);
  const bars = FIN_PARAMETERS.map((parameter) => {
    const [lowDelta, highDelta] = parameter === 'benefitDelayPeriods' ? ['0', delay] : parameter === 'discountRatePp' ? [negate(rate), rate] : [negate(pct), pct];
    const at = (delta: string): Frac | null => npvExact(applyDeltas(model, addEcho(around, parameter, delta, `tornado.${parameter}`), `tornado.${parameter}`));
    const low = at(lowDelta);
    const high = at(highDelta);
    const swing = low === null || high === null ? null : frac(absOf(high.n * low.d - low.n * high.d), high.d * low.d);
    return { parameter, swing, bar: { parameter, low: { delta: lowDelta, npv: low === null ? null : decimalOf(low, FIN_MONEY_DECIMALS) }, high: { delta: highDelta, npv: high === null ? null : decimalOf(high, FIN_MONEY_DECIMALS) }, swing: swing === null ? null : decimalOf(swing, FIN_MONEY_DECIMALS) } satisfies FinTornadoBar };
  });
  const order = (parameter: FinParameter): number => FIN_PARAMETERS.indexOf(parameter);
  bars.sort((a, b) => {
    if (a.swing === null || b.swing === null) return a.swing === b.swing ? order(a.parameter) - order(b.parameter) : a.swing === null ? 1 : -1;
    const compared = b.swing.n * a.swing.d - a.swing.n * b.swing.d;
    return compared === 0n ? order(a.parameter) - order(b.parameter) : compared > 0n ? 1 : -1;
  });
  return bars.map((entry) => entry.bar);
}

/**
 * The switching value of each line: the NPV is affine in the multiplier of a line, so the change that brings it to zero is exact, NPV(m) = NPV(0) + (pct / 100) * PV(line), solved for pct. It is the
 * "how wrong can this input be before the project stops paying" figure of an appraisal.
 */
function switchingValues(model: Model): FinSwitchingValue[] {
  const rate = rateOf(model.ratePct4);
  const base = npvExact(model);
  return PCT_PARAMETERS.map((parameter): FinSwitchingValue => {
    if (base === null || rate.u <= 0n) return { parameter, status: 'NOT_APPLICABLE', pct: null, reason: 'RATE_AT_OR_BELOW_MINUS_100' };
    const kind = KIND_OF[parameter];
    const sign = kind === 'benefit' || kind === 'residual' ? 1n : -1n;
    const line = presentValue(model.series[kind] as bigint[], rate, model.convention);
    if (line.n === 0n) return { parameter, status: 'NOT_APPLICABLE', pct: null, reason: 'COMPONENT_ZERO' };
    const slope = frac(line.n * sign, line.d * 100n);
    return { parameter, status: 'OK', pct: decimalOf(fracDiv({ n: -base.n, d: base.d }, slope), 2), reason: null };
  });
}

// ---- The report -------------------------------------------------------------------------------------------------------------------------

export interface FinReportInput {
  model: FinModelInput;
  scenarios: readonly FinScenarioInput[];
  sensitivity?: FinSensitivityConfig;
}

export interface FinReport {
  formulaVersion: string;
  /** The inputs as the module read them: the exact model and the scenarios. */
  inputs: { model: FinModelInput; scenarios: FinScenarioInput[]; sensitivity: FinSensitivityConfig };
  analysis: FinAnalysis;
  scenarios: FinScenarioResult[];
  oneWay: FinOneWayTable[];
  twoWay: FinTwoWayTable;
  tornado: FinTornadoBar[];
  switching: FinSwitchingValue[];
}

const PARAMETER_TEXT = new Set<string>(FIN_PARAMETERS);

function resolveSensitivity(config: FinSensitivityConfig | undefined): Required<Omit<FinSensitivityConfig, 'around'>> & { around: FinDeltas } {
  const oneWayInput = config?.oneWay ?? FIN_DEFAULT_SENSITIVITY.oneWay;
  for (const key of Object.keys(oneWayInput)) if (!PARAMETER_TEXT.has(key)) throw invalid(`sensitivity.one_way.${key}`, 'UNKNOWN_PARAMETER');
  const twoWayInput = config?.twoWay ?? FIN_DEFAULT_SENSITIVITY.twoWay;
  for (const field of ['x', 'y'] as const) if (!PARAMETER_TEXT.has(twoWayInput[field])) throw invalid(`sensitivity.two_way.${field}`, 'UNKNOWN_PARAMETER');
  const points = [...Object.values(oneWayInput).map((list) => list?.length ?? 0), twoWayInput.xPoints.length, twoWayInput.yPoints.length];
  if (points.some((count) => count === 0 || count > 15)) throw invalid('sensitivity', 'POINTS_OUT_OF_RANGE');
  return { oneWay: oneWayInput, twoWay: twoWayInput, tornado: config?.tornado ?? FIN_DEFAULT_SENSITIVITY.tornado, around: config?.around ?? {} };
}

/** Everything the appraisal says, computed once from the inputs: no number in it comes from anywhere else. */
export function buildReport(input: FinReportInput): FinReport {
  const model = normalizeModel(input.model);
  const config = resolveSensitivity(input.sensitivity);
  const around = exactDeltas(config.around, 'sensitivity.around');
  const oneWayTables = (Object.keys(config.oneWay) as FinParameter[])
    .sort((a, b) => FIN_PARAMETERS.indexOf(a) - FIN_PARAMETERS.indexOf(b))
    .map((parameter) => oneWay(model, around, parameter, config.oneWay[parameter] as readonly string[]));
  return {
    formulaVersion: FIN_FORMULA_VERSION,
    inputs: { model: canonicalModel(input.model), scenarios: [...input.scenarios], sensitivity: { oneWay: config.oneWay, twoWay: config.twoWay, tornado: config.tornado, around: config.around } },
    analysis: analyseModel(model),
    scenarios: runScenarios(model, input.scenarios),
    oneWay: oneWayTables,
    twoWay: twoWay(model, around, config.twoWay),
    tornado: tornado(model, around, config.tornado),
    switching: switchingValues(model),
  };
}

/** The fingerprint of a report: the formula version, the inputs it was computed from and everything it says. The same inputs under the same formula version give the same hash anywhere. */
export function reportHash(report: FinReport): string {
  return sha256Hex(canonicalJson(report));
}

/** The fingerprint of the inputs alone, to tell whether a stored result still belongs to them. */
export function inputsHash(input: FinReportInput): string {
  return sha256Hex(canonicalJson({ formulaVersion: FIN_FORMULA_VERSION, model: canonicalModel(input.model), scenarios: input.scenarios, sensitivity: input.sensitivity ?? null }));
}

/** The lines of the model in the order of their periods with the amounts as written, for hashing and for the export: the same inputs in another order are the same inputs. */
export function canonicalModel(input: FinModelInput): FinModelInput {
  return {
    periodUnit: input.periodUnit,
    discountRatePct: input.discountRatePct,
    convention: input.convention,
    lines: [...input.lines].sort((a, b) => a.period - b.period).map((line) => {
      const out: FinLineInput = { period: line.period };
      for (const kind of FIN_LINE_KINDS) {
        const text = line[kind];
        if (text !== undefined && text !== '') out[kind] = text;
      }
      return out;
    }),
  };
}
