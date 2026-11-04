import { DomainError } from './errors.ts';

/**
 * The money of the AI gateway (ST-LLM-003, LLM F3, BR-LLM-04, BR-LLM-05, BR-LLM-07, BR-LLM-13): what an attempt costs, from the tokens it used and the price in force; which budgets a request is held against and what is left in each;
 * and when a budget crosses its soft threshold. All of it is exact: rates are decimal strings of up to eight places and are never held in floating point.
 */
export const BUDGET_SCOPE_ORDER = ['TENANT', 'UNIT', 'PROJECT', 'USER'] as const;
export type BudgetScope = (typeof BUDGET_SCOPE_ORDER)[number];
export const BUDGET_PERIODS = ['MONTH', 'QUARTER', 'YEAR'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export type CachedSemantics = 'INCLUDED_IN_INPUT' | 'SEPARATE';

const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);
const MILLION = 1_000_000n;
const DECIMAL = /^-?[0-9]{1,18}(\.[0-9]{1,8})?$/;
// What numeric(24,8) holds: 16 digits before the point. A rate or an exchange rate beyond it would fail in the database.
const STORED_RATE = /^[0-9]{1,16}(\.[0-9]{1,8})?$/;
const MAX_COST = 10n ** 24n;

/** A decimal string as an integer count of 1e-8: nothing is lost because nothing is rounded. */
export function toScaled(value: string): bigint {
  if (!DECIMAL.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const scaled = BigInt(whole) * ONE + BigInt(fraction.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

/** An integer count of 1e-8 as a decimal string with eight places. */
export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`;
}

/** Division of non-negative integers, rounded half up. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export interface Price {
  inputPerMillion: string;
  cachedPerMillion: string;
  outputPerMillion: string;
  cachedSemantics: CachedSemantics;
  fxRateToVnd: string;
}

export interface Usage {
  inputTotal: number;
  cachedInput: number;
  outputTotal: number;
  /** Reasoning tokens are in `outputTotal` when the price says so; they are never added a second time. */
  toolFee?: string;
}

export interface AttemptCost {
  noncachedInput: number;
  /** In the currency of the price, to eight places. */
  cost: string;
  /** In dong, rounded half up. */
  costVnd: string;
}

const whole = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value < 0) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

/**
 * BR-LLM-04. `noncached = input_total - cached_input` when the price includes the cached tokens in the input, and `input_total` when it counts them apart;
 * `cost = noncached * input_rate + cached * cached_rate + output_total * output_rate + tool_fee` (rates per million tokens); `cost_vnd = round_half_up(cost * fx, 0)`.
 */
export function costOf(usage: Usage, price: Price): AttemptCost {
  const inputTotal = whole(usage.inputTotal, 'input_total');
  const cachedInput = whole(usage.cachedInput, 'cached_input');
  const outputTotal = whole(usage.outputTotal, 'output_total');
  if (price.cachedSemantics === 'INCLUDED_IN_INPUT' && cachedInput > inputTotal) throw new DomainError('VALIDATION_FAILED', 422, 'cached_input');
  const noncached = price.cachedSemantics === 'INCLUDED_IN_INPUT' ? inputTotal - cachedInput : inputTotal;
  // Every term is tokens * rate, in 1e-8 of the currency per million tokens: the sum is divided by a million once, at the end.
  const perMillion = BigInt(noncached) * toScaled(price.inputPerMillion) + BigInt(cachedInput) * toScaled(price.cachedPerMillion) + BigInt(outputTotal) * toScaled(price.outputPerMillion);
  // A fee is not negative: a negative one would take dong off the settled amount and give the budget room back.
  if (!STORED_RATE.test(usage.toolFee ?? '0')) throw new DomainError('VALIDATION_FAILED', 422, 'tool_fee');
  const toolFee = toScaled(usage.toolFee ?? '0');
  // The currency amount is kept to eight places for the record; the dong are worked out from the exact amount (tokens * rate, tool fee, exchange rate), rounded once.
  const exact = perMillion + toolFee * MILLION;
  const cost = divideHalfUp(exact, MILLION);
  const costVnd = divideHalfUp(exact * toScaled(price.fxRateToVnd), MILLION * ONE * ONE);
  // A cost the columns cannot hold (numeric(24,8) for the currency, numeric(24,0) for the dong) is refused here and not left to the database.
  if (cost >= MAX_COST || costVnd >= MAX_COST) throw new DomainError('VALIDATION_FAILED', 422, 'cost');
  return { noncachedInput: noncached, cost: fromScaled(cost), costVnd: costVnd.toString() };
}

/** The most a request can cost: its input bound at the input price, its output cap at the output price, and what the fallback attempts may add (BR-LLM-05). In dong. */
export function estimateVnd(input: { inputBound: number; outputCap: number; fallbackCapVnd?: string }, price: Price): string {
  // The input is priced at the higher of its two rates: a price may make the cached tokens dearer than the others, and the estimate must hold whatever the mix turns out to be.
  const dearer = toScaled(price.cachedPerMillion) > toScaled(price.inputPerMillion) ? price.cachedPerMillion : price.inputPerMillion;
  const base = costOf({ inputTotal: input.inputBound, cachedInput: 0, outputTotal: input.outputCap }, { ...price, inputPerMillion: dearer });
  return (BigInt(base.costVnd) + BigInt(input.fallbackCapVnd ?? '0')).toString();
}

export interface ScopeBalance {
  kind: BudgetScope;
  limitVnd: bigint;
  settledVnd: bigint;
  reservedOpenVnd: bigint;
  blocked: boolean;
}

export const availableOf = (balance: ScopeBalance): bigint => balance.limitVnd - balance.settledVnd - balance.reservedOpenVnd;

export type ReserveDecision = { ok: true } | { ok: false; scope: BudgetScope; reason: 'EXCEEDED' | 'BLOCKED'; shortBy: bigint };

/** BR-LLM-05: a request is held when its estimate fits in what is left at every scope it belongs to; the first scope, in lock order, that cannot take it is the one named. */
export function decideReservation(balances: readonly ScopeBalance[], estimate: bigint): ReserveDecision {
  const ordered = [...balances].sort((a, b) => BUDGET_SCOPE_ORDER.indexOf(a.kind) - BUDGET_SCOPE_ORDER.indexOf(b.kind));
  for (const balance of ordered) {
    if (balance.blocked) return { ok: false, scope: balance.kind, reason: 'BLOCKED', shortBy: estimate };
    const available = availableOf(balance);
    if (estimate > available) return { ok: false, scope: balance.kind, reason: 'EXCEEDED', shortBy: estimate - available };
  }
  return { ok: true };
}

/** The first day of the budget period that holds the day given (days are `YYYY-MM-DD` in Vietnam time). */
export function periodStartOf(period: BudgetPeriod, day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const first = period === 'YEAR' ? 1 : period === 'QUARTER' ? Math.floor((month - 1) / 3) * 3 + 1 : month;
  return `${String(year).padStart(4, '0')}-${String(first).padStart(2, '0')}-01`;
}

/** BR-LLM-07: the soft threshold is crossed by a settlement that takes the settled amount from below it to or above it; one event for each period, by the key of the counter. */
export function crossesThreshold(settledBefore: bigint, settledAfter: bigint, limit: bigint, percent: number): boolean {
  if (limit <= 0n) return false;
  const line = (limit * BigInt(percent) + 99n) / 100n;
  return settledBefore < line && settledAfter >= line;
}

export interface SettlementShape {
  reserved: bigint;
  actual: bigint;
}

/** What settling does to a counter: the reservation leaves the open amount; the actual cost joins the settled one; what was reserved and not used is released. Actual above reserved is an exception: the numbers stand and the scope is blocked. */
export function settlementOf(shape: SettlementShape): { released: bigint; exception: boolean } {
  return shape.actual > shape.reserved ? { released: 0n, exception: true } : { released: shape.reserved - shape.actual, exception: false };
}

// ---- budgets and price versions -------------------------------------------------------------------------------------------------------------------

export interface BudgetDraft {
  scopeKind: string;
  scopeRefId: string | null;
  period: string;
  limitVnd: string;
  softThresholdPct: number;
  maxRequestsPerDay: number | null;
  maxConcurrent: number | null;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export function assertBudgetDraft(draft: BudgetDraft): void {
  if (!(BUDGET_SCOPE_ORDER as readonly string[]).includes(draft.scopeKind)) throw invalid('scope_kind');
  if ((draft.scopeKind === 'TENANT') !== (draft.scopeRefId === null)) throw invalid('scope_ref_id');
  if (!(BUDGET_PERIODS as readonly string[]).includes(draft.period)) throw invalid('period');
  if (!/^[0-9]{1,24}$/.test(draft.limitVnd)) throw invalid('limit_vnd');
  if (!Number.isInteger(draft.softThresholdPct) || draft.softThresholdPct < 1 || draft.softThresholdPct > 100) throw invalid('soft_threshold_pct');
  for (const [field, value] of [['max_requests_per_day', draft.maxRequestsPerDay], ['max_concurrent', draft.maxConcurrent]] as const) {
    // The columns are 32-bit integers: more than they hold would fail in the database.
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)) throw invalid(field);
  }
}

export interface PriceDraft {
  provider: string;
  currency: string;
  inputPerMillion: string;
  cachedPerMillion: string;
  outputPerMillion: string;
  fxRateToVnd: string;
  sourceUrl: string;
}

/** BR-LLM-13: a price has its source; rates and the exchange rate are not negative; an exchange rate is above zero. */
export function assertPriceDraft(draft: PriceDraft): void {
  if (!/^https?:\/\/\S{3,}$/i.test(draft.sourceUrl.trim())) throw new DomainError('SOURCE_URL_REQUIRED', 422, 'source_url');
  if (!/^[A-Z]{3}$/.test(draft.currency)) throw invalid('currency');
  for (const [field, value] of [['input_per_million', draft.inputPerMillion], ['cached_per_million', draft.cachedPerMillion], ['output_per_million', draft.outputPerMillion]] as const) {
    if (!STORED_RATE.test(value)) throw invalid(field);
  }
  if (!STORED_RATE.test(draft.fxRateToVnd) || toScaled(draft.fxRateToVnd) <= 0n) throw invalid('fx_rate_to_vnd');
}
