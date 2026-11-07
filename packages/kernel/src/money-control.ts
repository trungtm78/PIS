import { DomainError } from './errors.ts';
import type { ChangeOrderTierParams } from './money-control-policy.ts';
import { percentScaled, targetRecovered, wholeVnd } from './pay-money.ts';

/**
 * The money control of a public investment project (lane B2 of the governance deepening): the availability of money down to the contract and its changes (G1-6), the contingency and the
 * management reserve as two ledgers (G1-7), the change orders in tiers with the funding they need (G1-8) and the recovery of the advances against what is left to pay (G1-11). Every figure is
 * whole dong over BigInt; every function is pure and takes its thresholds as arguments (they are data, read through `MoneyRuleReading`), so the cases run without a database.
 */

const SIGNED = /^-?(0|[1-9][0-9]{0,23})$/;
const refuse = (code: string, status: number, detail: string | undefined, extensions: Record<string, unknown>): DomainError => new DomainError(code, status, detail, { extensions });

const signed = (value: string, field: string): bigint => {
  if (!SIGNED.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason: 'NOT_A_WHOLE_AMOUNT' } });
  return BigInt(value);
};
const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/** A percent with up to two decimals as hundredths of a percent. */
export function pctHundredths(value: string): bigint {
  const match = /^(0|[1-9][0-9]{0,2})(?:\.([0-9]{1,2}))?$/.exec(value);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'pct', { extensions: { reason: 'NOT_A_PERCENT' } });
  return BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

/** `part / whole` as a percent with two decimals, rounded down, as text; a whole of nothing has no share (null). For the screen: decisions compare whole numbers, never this text. */
export function sharePct(part: bigint, whole: bigint): string | null {
  if (whole <= 0n) return null;
  const hundredths = (abs(part) * 10_000n) / whole;
  return `${part < 0n ? '-' : ''}${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

// ---- G1-6: availability down to the contract ------------------------------------------------------------------------------------------

export interface ContractMoneyFigures {
  /** The price in force: the revision that is effective, not one that is only pending. */
  currentPriceVnd: string;
  /** The price the contract was signed at (the base revision). */
  originalPriceVnd: string;
  /** What the payment requests that were sent ask for, gross, and what was paid, gross. */
  requestedTotalVnd: string;
  paidTotalVnd: string;
  advancePaidVnd: string;
  advanceRecoveredVnd: string;
  /** Change orders that are evaluated or approved and do not yet price anything (pending revision), increases only. */
  pendingIncreaseVnd: string;
}

export interface ContractAvailability {
  currentPriceVnd: string;
  originalPriceVnd: string;
  /** The approved changes that are in force: price now less the price at signing (signed). */
  approvedVariationVnd: string;
  pendingIncreaseVnd: string;
  requestedTotalVnd: string;
  paidTotalVnd: string;
  advanceOutstandingVnd: string;
  /** The cash that left or is asked for: what was paid (gross) and the advances not yet recovered. */
  cashOutVnd: string;
  /** What may still be asked for in payment requests: the price less what is already requested (never below zero). */
  remainingPayableVnd: string;
  /** What may still leave the contract as cash, advances included. */
  cashHeadroomVnd: string;
  withinPrice: boolean;
  /** The share of the current price that is requested, two decimals; null for a price of nothing. */
  requestedPct: string | null;
}

/** The position of a contract against its price in force (CAP-17 extended to the contract): cumulative payments may not go above the current price, advances not yet recovered count as cash out. */
export function contractAvailability(figures: ContractMoneyFigures): ContractAvailability {
  const price = wholeVnd(figures.currentPriceVnd, 'current_price_vnd');
  const original = wholeVnd(figures.originalPriceVnd, 'original_price_vnd');
  const requested = wholeVnd(figures.requestedTotalVnd, 'requested_total_vnd');
  const paid = wholeVnd(figures.paidTotalVnd, 'paid_total_vnd');
  const advanceOut = wholeVnd(figures.advancePaidVnd, 'advance_paid_vnd') - wholeVnd(figures.advanceRecoveredVnd, 'advance_recovered_vnd');
  const outstanding = advanceOut > 0n ? advanceOut : 0n;
  const cashOut = paid + outstanding;
  const remaining = price > requested ? price - requested : 0n;
  const headroom = price > cashOut ? price - cashOut : 0n;
  return {
    currentPriceVnd: price.toString(),
    originalPriceVnd: original.toString(),
    approvedVariationVnd: (price - original).toString(),
    pendingIncreaseVnd: wholeVnd(figures.pendingIncreaseVnd, 'pending_increase_vnd').toString(),
    requestedTotalVnd: requested.toString(),
    paidTotalVnd: paid.toString(),
    advanceOutstandingVnd: outstanding.toString(),
    cashOutVnd: cashOut.toString(),
    remainingPayableVnd: remaining.toString(),
    cashHeadroomVnd: headroom.toString(),
    withinPrice: requested <= price && cashOut <= price,
    requestedPct: sharePct(requested, price),
  };
}

export type EacVerdict = 'WITHIN' | 'OVER';
export interface EacControl {
  verdict: EacVerdict;
  eacVnd: string;
  approvedTotalVnd: string;
  /** The funding gap against the approved total investment: how far the estimate at completion is above it (zero when within). */
  overByVnd: string;
  overPct: string | null;
  /** The estimate is above the approved total by more than the tolerance of the policy: the project needs an adjustment of the investment decision (URGENT). */
  raisesAlert: boolean;
}

/** The estimate at completion against the approved total investment (CAP/PRJ F03); `tolerancePct` is the policy's (default none). */
export function eacControl(eacVnd: string, approvedTotalVnd: string, tolerancePct: string): EacControl {
  const eac = wholeVnd(eacVnd, 'eac_vnd');
  const approved = wholeVnd(approvedTotalVnd, 'approved_total_vnd');
  const over = eac > approved ? eac - approved : 0n;
  // over / approved > tolerance / 10000  <=>  over * 10000 > tolerance * approved
  const raises = approved === 0n ? eac > 0n : over * 10_000n > pctHundredths(tolerancePct) * approved;
  return { verdict: over > 0n ? 'OVER' : 'WITHIN', eacVnd: eac.toString(), approvedTotalVnd: approved.toString(), overByVnd: over.toString(), overPct: sharePct(over, approved), raisesAlert: raises };
}

// ---- G1-7: contingency and management reserve ----------------------------------------------------------------------------------------

export const RESERVE_KINDS = ['CONTINGENCY', 'MGMT_RESERVE'] as const;
export type ReserveKind = (typeof RESERVE_KINDS)[number];
export const RESERVE_ENTRY_KINDS = ['FUND', 'DRAWDOWN'] as const;
export type ReserveEntryKind = (typeof RESERVE_ENTRY_KINDS)[number];

export const reserveKindOf = (value: unknown): ReserveKind | undefined => RESERVE_KINDS.find((kind) => kind === value);

export interface OpenRisk {
  /** The probability the risk happens, percent with up to two decimals. */
  probabilityPct: string;
  /** The cost if it happens, whole VND. */
  costImpactVnd: string;
}

/** The expected value of the open risks: the sum of probability times cost, rounded down once at the end, in whole VND. */
export function openRiskExpectedValue(risks: readonly OpenRisk[]): string {
  let scaled = 0n;
  for (const risk of risks) scaled += pctHundredths(risk.probabilityPct) * wholeVnd(risk.costImpactVnd, 'cost_impact_vnd');
  return (scaled / 10_000n).toString();
}

export interface ReserveCover {
  balanceVnd: string;
  expectedValueVnd: string;
  /** What the balance lacks to cover the expected value of the open risks, at the share the policy asks (zero when covered). */
  shortfallVnd: string;
  covered: boolean;
  /** The balance as a share of the expected value, two decimals; null when no risk is open. */
  coverPct: string | null;
}

/** The balance of the contingency against the expected value of the open risks: the alert goes when it is below `belowPct` of that value. */
export function reserveCover(balanceVnd: string, expectedValueVnd: string, belowPct: string): ReserveCover {
  const balance = wholeVnd(balanceVnd, 'balance_vnd');
  const ev = wholeVnd(expectedValueVnd, 'expected_value_vnd');
  const needed = (ev * pctHundredths(belowPct) + 9_999n) / 10_000n;
  const short = needed > balance ? needed - balance : 0n;
  return { balanceVnd: balance.toString(), expectedValueVnd: ev.toString(), shortfallVnd: short.toString(), covered: short === 0n, coverPct: ev === 0n ? null : sharePct(balance, ev) };
}

export interface DrawdownAsk {
  amountVnd: string;
  balanceVnd: string;
  riskId: string | null;
  changeRequestId: string | null;
}

/** A drawdown is for one risk or one change order, never both and never neither (422 `RESERVE_LINK_REQUIRED`), above nothing and within the balance (422 `RESERVE_BALANCE_INSUFFICIENT`). */
export function assertDrawdown(ask: DrawdownAsk): bigint {
  if ((ask.riskId === null) === (ask.changeRequestId === null)) throw refuse('RESERVE_LINK_REQUIRED', 422, 'risk_id', { has_risk: ask.riskId !== null, has_change_order: ask.changeRequestId !== null });
  const amount = wholeVnd(ask.amountVnd, 'amount_vnd');
  if (amount === 0n) throw new DomainError('VALIDATION_FAILED', 422, 'amount_vnd', { extensions: { reason: 'MUST_BE_POSITIVE' } });
  const balance = wholeVnd(ask.balanceVnd, 'balance_vnd');
  if (amount > balance) throw refuse('RESERVE_BALANCE_INSUFFICIENT', 422, 'amount_vnd', { balance_vnd: balance.toString(), exceeds_by_vnd: (amount - balance).toString() });
  return amount;
}

// ---- G1-8: tiered change orders --------------------------------------------------------------------------------------------------------

export type ChangeTier = 1 | 2 | 3;

export interface ChangeClassification {
  tier: ChangeTier;
  /** The signed cumulative variation against the original price after this change, whole VND. */
  cumulativeAfterVnd: string;
  /** The same as a share of the original price, two decimals (absolute); null for an original price of nothing. */
  cumulativePct: string | null;
  deltaPct: string | null;
  /** The cumulative variation reached the threshold of the policy: a check of the project adjustment is forced and the audit is told. */
  forcesAdjustment: boolean;
  /** The size that decides the authority (delegation of authority): the larger of this change and the cumulative variation, absolute. */
  authorityAmountVnd: string;
}

/** The tier of a change order by the thresholds of the policy: its size and the cumulative variation against the original price both stay within the band, or it is the next tier up. */
export function classifyChangeOrder(policy: ChangeOrderTierParams, facts: { deltaVnd: string; approvedCumulativeVnd: string; originalPriceVnd: string }): ChangeClassification {
  const delta = signed(facts.deltaVnd, 'delta_vnd');
  const original = wholeVnd(facts.originalPriceVnd, 'original_price_vnd');
  const after = signed(facts.approvedCumulativeVnd, 'approved_cumulative_vnd') + delta;
  const size = abs(delta);
  const cumulative = abs(after);
  // cumulative / original <= pct / 10000  <=>  cumulative * 10000 <= pct * original; an original of nothing leaves only the amounts to judge.
  const within = (maxPct: string): boolean => (original === 0n ? cumulative === 0n : cumulative * 10_000n <= pctHundredths(maxPct) * original);
  const [first, second] = policy.bands;
  const tier: ChangeTier = size <= BigInt(first.maxAmountVnd) && within(first.maxCumulativePct) ? 1 : size <= BigInt(second.maxAmountVnd) && within(second.maxCumulativePct) ? 2 : 3;
  const forces = original === 0n ? cumulative > 0n : cumulative * 10_000n >= pctHundredths(policy.projectAdjustmentPct) * original && cumulative > 0n;
  return {
    tier,
    cumulativeAfterVnd: after.toString(),
    cumulativePct: sharePct(cumulative, original),
    deltaPct: sharePct(size, original),
    forcesAdjustment: forces,
    authorityAmountVnd: (size > cumulative ? size : cumulative).toString(),
  };
}

export type FundingSource = 'RESERVE' | 'PROJECT_ADJUSTMENT';

export interface ChangeFunding {
  /** An increase needs a source; a decrease or no change needs none. */
  needsCover: boolean;
  covered: boolean;
  coveredBy: FundingSource | null;
  shortfallVnd: string;
}

/** Where an increase is paid from: drawdowns of the reserve that were approved for this change order and add up to the increase, or a project adjustment that was cleared (CTR F05 / CAP F04). */
export function changeFunding(policy: ChangeOrderTierParams, facts: { deltaVnd: string; approvedDrawdownVnd: string; adjustmentCleared: boolean }): ChangeFunding {
  const delta = signed(facts.deltaVnd, 'delta_vnd');
  if (delta <= 0n || !policy.requireReserveCover) return { needsCover: false, covered: true, coveredBy: null, shortfallVnd: '0' };
  if (facts.adjustmentCleared) return { needsCover: true, covered: true, coveredBy: 'PROJECT_ADJUSTMENT', shortfallVnd: '0' };
  const drawn = wholeVnd(facts.approvedDrawdownVnd, 'approved_drawdown_vnd');
  return drawn >= delta ? { needsCover: true, covered: true, coveredBy: 'RESERVE', shortfallVnd: '0' } : { needsCover: true, covered: false, coveredBy: null, shortfallVnd: (delta - drawn).toString() };
}

// ---- G1-11: advances against what is left to pay ---------------------------------------------------------------------------------------

export interface AdvancePosition {
  outstandingVnd: string;
  /** What future payment requests can still carry: the price less what is requested. */
  remainingPayableVnd: string;
  /** The advance owed is more than the payments left to pay can recover: the recovery cannot be completed (URGENT). */
  exceedsRemaining: boolean;
  /** By how much. */
  unrecoverableVnd: string;
}

/** The outstanding advance against the value left to pay: above it, no payment of the contract can take the advance back. */
export function advancePosition(outstandingVnd: string, remainingPayableVnd: string): AdvancePosition {
  const outstanding = wholeVnd(outstandingVnd, 'outstanding_vnd');
  const remaining = wholeVnd(remainingPayableVnd, 'remaining_payable_vnd');
  const excess = outstanding > remaining ? outstanding - remaining : 0n;
  return { outstandingVnd: outstanding.toString(), remainingPayableVnd: remaining.toString(), exceedsRemaining: excess > 0n, unrecoverableVnd: excess.toString() };
}

export interface RecoveryEvent {
  requestNo: string | null;
  /** The day the request was sent. */
  on: string;
  /** What the member asked to be paid up to and including this request, gross, and what had been recovered up to and including it. */
  grossCumVnd: string;
  recoveredCumVnd: string;
}

export interface RecoveryRow {
  kind: 'ACTUAL' | 'PLANNED';
  requestNo: string | null;
  on: string | null;
  /** The share of the threshold of recovery this row stands at (planned rows only). */
  atPct: number | null;
  grossCumVnd: string;
  plannedRecoveredVnd: string;
  /** Null for a planned row that has not been reached yet. */
  actualRecoveredVnd: string | null;
  /** What the recovery lacks against the formula at this row (never below zero). */
  behindVnd: string | null;
}

export interface RecoveryTableInput {
  paidVnd: string;
  workValueVnd: string;
  thresholdPct: string;
  events: readonly RecoveryEvent[];
  /** The gross the member has asked to be paid so far. */
  grossToDateVnd: string;
  recoveredVnd: string;
}

const MILESTONE_SHARES = [25, 50, 75, 100] as const;

/**
 * The planned against the actual recovery of one advance (PAY-07 extended): one row for each payment request that was sent (what the formula says should have been recovered at the gross it
 * reached, what was recovered), then the milestones of the threshold that the payments have not reached yet, as planned rows with nothing actual.
 */
export function recoveryTable(input: RecoveryTableInput): RecoveryRow[] {
  const rows: RecoveryRow[] = input.events.map((event) => {
    const planned = BigInt(targetRecovered(input.paidVnd, input.workValueVnd, input.thresholdPct, event.grossCumVnd));
    const actual = wholeVnd(event.recoveredCumVnd, 'recovered_cum_vnd');
    return { kind: 'ACTUAL', requestNo: event.requestNo, on: event.on, atPct: null, grossCumVnd: event.grossCumVnd, plannedRecoveredVnd: planned.toString(), actualRecoveredVnd: actual.toString(), behindVnd: (planned > actual ? planned - actual : 0n).toString() };
  });
  const work = wholeVnd(input.workValueVnd, 'work_value_vnd');
  const thresholdValue = (work * percentScaled(input.thresholdPct, 'recovery_threshold_pct')) / 1_000_000n;
  const gross = wholeVnd(input.grossToDateVnd, 'gross_to_date_vnd');
  for (const atPct of MILESTONE_SHARES) {
    const atGross = (thresholdValue * BigInt(atPct)) / 100n;
    if (atGross <= gross && atGross > 0n) continue;
    rows.push({ kind: 'PLANNED', requestNo: null, on: null, atPct, grossCumVnd: atGross.toString(), plannedRecoveredVnd: targetRecovered(input.paidVnd, input.workValueVnd, input.thresholdPct, atGross.toString()), actualRecoveredVnd: null, behindVnd: null });
  }
  return rows;
}

/** A final payment is refused while the advance is still owed after the recovery that very request makes (422 `FINAL_PAYMENT_ADVANCE_OUTSTANDING`). */
export function assertFinalPaymentClearsAdvance(outstandingAfterVnd: string, toleranceVnd: string): void {
  const left = wholeVnd(outstandingAfterVnd, 'outstanding_after_vnd');
  if (left > wholeVnd(toleranceVnd, 'tolerance_vnd')) throw refuse('FINAL_PAYMENT_ADVANCE_OUTSTANDING', 422, 'advance_id', { outstanding_after_vnd: left.toString() });
}
