import { DomainError } from './errors.ts';

/**
 * Contract analytics (CA-1, plan "contract analytics foundation", eng-review R12, R16, R17): every indicator of the contract portfolio is defined ONCE, here, as a pure function over plain rows and as an entry in
 * `CTR_INDICATORS` that says what the number means (formula, numerator, denominator, unit, source tables, null policy). The database view `contract_fact`, the BI dataset `DS-CTR`, the portfolio endpoint, the
 * exports and the screens all read the meaning from here: a number that is computed anywhere else is a second definition of it.
 *
 * Rules that hold for all of them:
 *  - Money is whole dong as a decimal string (no float is ever involved); sums and ratios are BigInt, rounded half away from zero once, at the end.
 *  - A ratio is the sum of the numerators over the sum of the denominators of the rows, never the mean of the ratios of the rows (a single contract is a portfolio of one).
 *  - A denominator of zero (or a figure the row does not have) is `NOT_APPLICABLE` with its reason, never 0. Zero is a figure only when something was counted and came to zero.
 *  - The `*OfSums` functions take sums as the database gives them, so that the figure of the database and the figure of the rows are one function.
 */

// ---- the meaning of every indicator -----------------------------------------------------------------------------------------------------------------------

export const INDICATOR_UNITS = ['PERCENT', 'VND', 'DAYS', 'INDEX', 'COUNT'] as const;
export type IndicatorUnit = (typeof INDICATOR_UNITS)[number];

export const INDICATOR_CODES = [
  'BID_PRICE_VARIANCE',
  'CHANGE_GROWTH',
  'PAID_TO_ACCEPTED',
  'ACCEPTED_TO_REQUESTED',
  'ADVANCE_OUTSTANDING',
  'ADVANCE_OUTSTANDING_RATIO',
  'RETENTION_HELD',
  'RETENTION_RELEASED_RATIO',
  'DAYS_LATE',
  'GUARANTEE_COVERAGE',
  'TOP_N_SHARE',
  'HHI',
  'SINGLE_BIDDER_RATE',
] as const;
export type IndicatorCode = (typeof INDICATOR_CODES)[number];

/** What a number of the portfolio means. Written for the "i" button of a screen, the footnote of a report and the review of a metric file. */
export interface IndicatorDefinition {
  code: IndicatorCode;
  name: string;
  /** The formula in words and symbols, as it is read to a person who signs the report. */
  formula: string;
  numerator: string;
  /** Null for a figure that is not a ratio. */
  denominator: string | null;
  unit: IndicatorUnit;
  /** The tables (or views) the figures are read from. */
  sourceTables: readonly string[];
  /** What the figure is when there is nothing to compute it from. */
  nullPolicy: string;
}

const NULL_POLICY_RATIO = 'NOT_APPLICABLE with its reason when the denominator is zero or missing; never 0';

export const CTR_INDICATORS: Readonly<Record<IndicatorCode, IndicatorDefinition>> = Object.freeze({
  BID_PRICE_VARIANCE: {
    code: 'BID_PRICE_VARIANCE',
    name: 'Bid versus contract price variance',
    formula: '(contract value at signing - winning bid) / winning bid x 100',
    numerator: 'sum(contract value at signing - winning bid)',
    denominator: 'sum(winning bid)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'contract_revision', 'bid_result'],
    nullPolicy: `${NULL_POLICY_RATIO}; a contract with no winning bid on record is left out of both sums`,
  },
  CHANGE_GROWTH: {
    code: 'CHANGE_GROWTH',
    name: 'Contract value growth through changes',
    formula: 'sum(approved change deltas) / original contract value x 100',
    numerator: 'sum(delta of approved changes, signed)',
    denominator: 'sum(original contract value)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'contract_revision', 'contract_change'],
    nullPolicy: NULL_POLICY_RATIO,
  },
  PAID_TO_ACCEPTED: {
    code: 'PAID_TO_ACCEPTED',
    name: 'Paid against accepted',
    formula: 'paid / accepted x 100',
    numerator: 'sum(paid)',
    denominator: 'sum(accepted)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'acceptance_record', 'payment_request'],
    nullPolicy: NULL_POLICY_RATIO,
  },
  ACCEPTED_TO_REQUESTED: {
    code: 'ACCEPTED_TO_REQUESTED',
    name: 'Accepted against requested',
    formula: 'accepted / requested x 100',
    numerator: 'sum(accepted)',
    denominator: 'sum(requested)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'acceptance_record', 'payment_request'],
    nullPolicy: NULL_POLICY_RATIO,
  },
  ADVANCE_OUTSTANDING: {
    code: 'ADVANCE_OUTSTANDING',
    name: 'Advance outstanding',
    formula: 'advance paid - advance recovered',
    numerator: 'sum(advance paid - advance recovered)',
    denominator: null,
    unit: 'VND',
    sourceTables: ['contract', 'advance_payment', 'payment_request'],
    nullPolicy: 'NOT_APPLICABLE when no row has an advance at all; zero when advances were paid and recovered in full',
  },
  ADVANCE_OUTSTANDING_RATIO: {
    code: 'ADVANCE_OUTSTANDING_RATIO',
    name: 'Advance outstanding share',
    formula: '(advance paid - advance recovered) / advance paid x 100',
    numerator: 'sum(advance paid - advance recovered)',
    denominator: 'sum(advance paid)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'advance_payment', 'payment_request'],
    nullPolicy: NULL_POLICY_RATIO,
  },
  RETENTION_HELD: {
    code: 'RETENTION_HELD',
    name: 'Retention held',
    formula: 'retention withheld - retention released',
    numerator: 'sum(retention withheld - retention released)',
    denominator: null,
    unit: 'VND',
    sourceTables: ['contract', 'payment_request', 'retention_release'],
    nullPolicy: 'NOT_APPLICABLE when no row has retention at all; zero when everything withheld was released',
  },
  RETENTION_RELEASED_RATIO: {
    code: 'RETENTION_RELEASED_RATIO',
    name: 'Retention released share',
    formula: 'retention released / retention withheld x 100',
    numerator: 'sum(retention released)',
    denominator: 'sum(retention withheld)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'payment_request', 'retention_release'],
    nullPolicy: NULL_POLICY_RATIO,
  },
  DAYS_LATE: {
    code: 'DAYS_LATE',
    name: 'Days late against the original completion date',
    formula: 'max(0, (completion date, or the as-of date while the contract is open) - original completion_due) in calendar days',
    numerator: 'calendar days between the original completion_due and the completion (or as-of) date, floored at 0',
    denominator: null,
    unit: 'DAYS',
    sourceTables: ['contract', 'contract_revision'],
    nullPolicy: 'NOT_APPLICABLE when the contract has no original completion_due; 0 means on time (or not yet due), never "unknown"',
  },
  GUARANTEE_COVERAGE: {
    code: 'GUARANTEE_COVERAGE',
    name: 'Guarantee coverage',
    formula: 'sum(valid guarantee amount) / sum(guarantee amount required) x 100',
    numerator: 'sum(guarantee amount in force on the as-of date)',
    denominator: 'sum(guarantee amount the contract requires)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'contract_guarantee'],
    nullPolicy: `${NULL_POLICY_RATIO}; a contract that requires no guarantee is left out of both sums`,
  },
  TOP_N_SHARE: {
    code: 'TOP_N_SHARE',
    name: 'Share of the largest groups (top 5 by default)',
    formula: 'sum(value of the N largest groups) / sum(value of all groups) x 100, on the value of ACTIVE contracts',
    numerator: 'sum(value of the N largest groups)',
    denominator: 'sum(value of all groups)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'contract_party', 'project', 'organization_unit', 'fund_source'],
    nullPolicy: 'NOT_APPLICABLE when there is no ACTIVE contract or their value is zero; never 0',
  },
  HHI: {
    code: 'HHI',
    name: 'Herfindahl-Hirschman index',
    formula: 'sum over groups of (share of the group in percent)^2, so 10000 / n <= HHI <= 10000 for n groups',
    numerator: 'sum(value of the group ^ 2) x 10000',
    denominator: '(sum(value of all groups)) ^ 2',
    unit: 'INDEX',
    sourceTables: ['contract', 'contract_party', 'project', 'organization_unit', 'fund_source'],
    nullPolicy: 'NOT_APPLICABLE when there is no ACTIVE contract or their value is zero; never 0',
  },
  SINGLE_BIDDER_RATE: {
    code: 'SINGLE_BIDDER_RATE',
    name: 'Single-bidder rate',
    formula: 'contracts whose package had exactly one bidder / contracts whose bidder count is known x 100',
    numerator: 'count(contracts with bidder count = 1)',
    denominator: 'count(contracts with a known bidder count)',
    unit: 'PERCENT',
    sourceTables: ['contract', 'bid_package', 'bid_proposal'],
    nullPolicy: `${NULL_POLICY_RATIO}; a contract with no bidder count on record is not counted`,
  },
});

// ---- the result every indicator gives ----------------------------------------------------------------------------------------------------------------------

export type NotApplicableReason =
  | 'ZERO_DENOMINATOR'
  | 'NO_ROWS'
  | 'NO_WINNING_BID'
  | 'NO_ADVANCE'
  | 'NO_RETENTION'
  | 'NO_ORIGINAL_DUE_DATE'
  | 'NO_GUARANTEE_REQUIRED'
  | 'NO_BIDDER_COUNT'
  | 'NO_ACTIVE_CONTRACT'
  | 'ZERO_TOTAL';

export interface IndicatorResult {
  code: IndicatorCode;
  unit: IndicatorUnit;
  /** A whole number (VND, DAYS, COUNT), or a decimal with two places (PERCENT, INDEX); null exactly when the status is NOT_APPLICABLE. */
  value: string | null;
  status: 'OK' | 'NOT_APPLICABLE';
  reason: NotApplicableReason | null;
  /** The two sums the value was made of (whole numbers, as text); null when the indicator has no such pair or none could be formed. */
  numerator: string | null;
  denominator: string | null;
}

const WHOLE = /^-?(0|[1-9]\d{0,23})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function whole(value: string, field: string): bigint {
  if (typeof value !== 'string' || !WHOLE.test(value)) throw invalid(field);
  return BigInt(value);
}

const optionalWhole = (value: string | null | undefined, field: string): bigint | null => (value === null || value === undefined ? null : whole(value, field));

/** `numerator / denominator` x `factor`, as an integer count of 10^-scale, rounded half away from zero; the denominator is not zero. */
function scaledQuotient(numerator: bigint, denominator: bigint, factor: bigint, scale: number): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const scaled = (n * factor * 10n ** BigInt(scale) * 2n + d) / (2n * d);
  return negative ? -scaled : scaled;
}

/** A count of 10^-scale as text with exactly `scale` places (`-0.00` is written `0.00`). */
function decimalText(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}

/** The percent with two decimals of a ratio of two whole numbers, half away from zero. */
export function analyticsPercent(numerator: bigint, denominator: bigint): string {
  return decimalText(scaledQuotient(numerator, denominator, 100n, 2), 2);
}

function na(code: IndicatorCode, reason: NotApplicableReason, numerator: bigint | null = null, denominator: bigint | null = null): IndicatorResult {
  return { code, unit: CTR_INDICATORS[code].unit, value: null, status: 'NOT_APPLICABLE', reason, numerator: numerator?.toString() ?? null, denominator: denominator?.toString() ?? null };
}

function ok(code: IndicatorCode, value: string, numerator: bigint | null = null, denominator: bigint | null = null): IndicatorResult {
  return { code, unit: CTR_INDICATORS[code].unit, value, status: 'OK', reason: null, numerator: numerator?.toString() ?? null, denominator: denominator?.toString() ?? null };
}

/** The one place a percent of two sums is made: a denominator of zero is NOT_APPLICABLE, with `emptyReason` when the caller had nothing to sum at all. */
function ratio(code: IndicatorCode, numerator: bigint, denominator: bigint, zeroReason: NotApplicableReason = 'ZERO_DENOMINATOR'): IndicatorResult {
  if (denominator === 0n) return na(code, zeroReason, numerator, denominator);
  return ok(code, analyticsPercent(numerator, denominator), numerator, denominator);
}

// ---- bid against contract price -------------------------------------------------------------------------------------------------------------------------

export interface BidVarianceRow {
  /** The value the contract was signed at (not the value after changes: those are CHANGE_GROWTH). */
  contractValueVnd: string;
  /** The bid that won the package; null when the contract does not come from a tendered package. */
  winningBidVnd: string | null;
}

export interface BidVarianceSums {
  contractValueVnd: string;
  winningBidVnd: string;
  /** How many rows had a winning bid. */
  rows: number;
}

/** BID_PRICE_VARIANCE = (contract value - winning bid) / winning bid, in percent; negative when the contract was signed below the bid. */
export function bidPriceVarianceOfSums(sums: BidVarianceSums): IndicatorResult {
  if (sums.rows === 0) return na('BID_PRICE_VARIANCE', 'NO_WINNING_BID');
  const bid = whole(sums.winningBidVnd, 'winning_bid_vnd');
  return ratio('BID_PRICE_VARIANCE', whole(sums.contractValueVnd, 'contract_value_vnd') - bid, bid);
}

export function bidPriceVariance(rows: readonly BidVarianceRow[]): IndicatorResult {
  let contract = 0n;
  let bid = 0n;
  let counted = 0;
  for (const row of rows) {
    const won = optionalWhole(row.winningBidVnd, 'winning_bid_vnd');
    if (won === null) continue;
    contract += whole(row.contractValueVnd, 'contract_value_vnd');
    bid += won;
    counted += 1;
  }
  return bidPriceVarianceOfSums({ contractValueVnd: contract.toString(), winningBidVnd: bid.toString(), rows: counted });
}

// ---- changes ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ChangeGrowthRow {
  originalValueVnd: string;
  /** The deltas (signed) of the changes that were approved; a change that was drafted, rejected or withdrawn is not here. */
  approvedDeltasVnd: readonly string[];
}

export interface ChangeGrowthSums {
  originalValueVnd: string;
  approvedDeltaVnd: string;
}

/** CHANGE_GROWTH = sum(approved deltas) / original value, in percent; a contract that was reduced is negative. */
export function changeGrowthOfSums(sums: ChangeGrowthSums): IndicatorResult {
  return ratio('CHANGE_GROWTH', whole(sums.approvedDeltaVnd, 'approved_delta_vnd'), whole(sums.originalValueVnd, 'original_value_vnd'));
}

export function changeGrowth(rows: readonly ChangeGrowthRow[]): IndicatorResult {
  if (rows.length === 0) return na('CHANGE_GROWTH', 'NO_ROWS');
  let original = 0n;
  let delta = 0n;
  for (const row of rows) {
    original += whole(row.originalValueVnd, 'original_value_vnd');
    for (const change of row.approvedDeltasVnd) delta += whole(change, 'approved_delta_vnd');
  }
  return changeGrowthOfSums({ originalValueVnd: original.toString(), approvedDeltaVnd: delta.toString() });
}

// ---- payment ---------------------------------------------------------------------------------------------------------------------------------------------

export interface PaymentProgressRow {
  requestedVnd: string;
  acceptedVnd: string;
  paidVnd: string;
}

export interface PaymentSums {
  requestedVnd: string;
  acceptedVnd: string;
  paidVnd: string;
}

export function paidToAcceptedOfSums(sums: PaymentSums): IndicatorResult {
  return ratio('PAID_TO_ACCEPTED', whole(sums.paidVnd, 'paid_vnd'), whole(sums.acceptedVnd, 'accepted_vnd'));
}

export function acceptedToRequestedOfSums(sums: PaymentSums): IndicatorResult {
  return ratio('ACCEPTED_TO_REQUESTED', whole(sums.acceptedVnd, 'accepted_vnd'), whole(sums.requestedVnd, 'requested_vnd'));
}

export function paymentSums(rows: readonly PaymentProgressRow[]): PaymentSums {
  let requested = 0n;
  let accepted = 0n;
  let paid = 0n;
  for (const row of rows) {
    requested += whole(row.requestedVnd, 'requested_vnd');
    accepted += whole(row.acceptedVnd, 'accepted_vnd');
    paid += whole(row.paidVnd, 'paid_vnd');
  }
  return { requestedVnd: requested.toString(), acceptedVnd: accepted.toString(), paidVnd: paid.toString() };
}

/** PAID_TO_ACCEPTED = paid / accepted; above 100 the contractor was paid for work nobody accepted yet. */
export const paidToAccepted = (rows: readonly PaymentProgressRow[]): IndicatorResult => paidToAcceptedOfSums(paymentSums(rows));
/** ACCEPTED_TO_REQUESTED = accepted / requested; below 100 the Investor accepted less than the contractor asked for. */
export const acceptedToRequested = (rows: readonly PaymentProgressRow[]): IndicatorResult => acceptedToRequestedOfSums(paymentSums(rows));

// ---- advance and retention --------------------------------------------------------------------------------------------------------------------------------

export interface AdvanceRow {
  /** Null when the contract has no advance at all. */
  advancePaidVnd: string | null;
  advanceRecoveredVnd: string | null;
}

export interface AdvanceSums {
  advancePaidVnd: string;
  advanceRecoveredVnd: string;
  /** How many rows had an advance. */
  rows: number;
}

export function advanceSums(rows: readonly AdvanceRow[]): AdvanceSums {
  let paid = 0n;
  let recovered = 0n;
  let counted = 0;
  for (const row of rows) {
    const given = optionalWhole(row.advancePaidVnd, 'advance_paid_vnd');
    if (given === null) continue;
    paid += given;
    recovered += optionalWhole(row.advanceRecoveredVnd, 'advance_recovered_vnd') ?? 0n;
    counted += 1;
  }
  return { advancePaidVnd: paid.toString(), advanceRecoveredVnd: recovered.toString(), rows: counted };
}

/** ADVANCE_OUTSTANDING = advance paid - advance recovered, in dong. */
export function advanceOutstandingOfSums(sums: AdvanceSums): IndicatorResult {
  if (sums.rows === 0) return na('ADVANCE_OUTSTANDING', 'NO_ADVANCE');
  const paid = whole(sums.advancePaidVnd, 'advance_paid_vnd');
  const outstanding = paid - whole(sums.advanceRecoveredVnd, 'advance_recovered_vnd');
  return ok('ADVANCE_OUTSTANDING', outstanding.toString(), outstanding, null);
}

/** ADVANCE_OUTSTANDING_RATIO = (advance paid - advance recovered) / advance paid, in percent. */
export function advanceOutstandingRatioOfSums(sums: AdvanceSums): IndicatorResult {
  if (sums.rows === 0) return na('ADVANCE_OUTSTANDING_RATIO', 'NO_ADVANCE');
  const paid = whole(sums.advancePaidVnd, 'advance_paid_vnd');
  return ratio('ADVANCE_OUTSTANDING_RATIO', paid - whole(sums.advanceRecoveredVnd, 'advance_recovered_vnd'), paid);
}

export const advanceOutstanding = (rows: readonly AdvanceRow[]): IndicatorResult => advanceOutstandingOfSums(advanceSums(rows));
export const advanceOutstandingRatio = (rows: readonly AdvanceRow[]): IndicatorResult => advanceOutstandingRatioOfSums(advanceSums(rows));

export interface RetentionRow {
  /** Null when the contract holds no retention. */
  retentionWithheldVnd: string | null;
  retentionReleasedVnd: string | null;
}

export interface RetentionSums {
  retentionWithheldVnd: string;
  retentionReleasedVnd: string;
  rows: number;
}

export function retentionSums(rows: readonly RetentionRow[]): RetentionSums {
  let withheld = 0n;
  let released = 0n;
  let counted = 0;
  for (const row of rows) {
    const held = optionalWhole(row.retentionWithheldVnd, 'retention_withheld_vnd');
    if (held === null) continue;
    withheld += held;
    released += optionalWhole(row.retentionReleasedVnd, 'retention_released_vnd') ?? 0n;
    counted += 1;
  }
  return { retentionWithheldVnd: withheld.toString(), retentionReleasedVnd: released.toString(), rows: counted };
}

/** RETENTION_HELD = retention withheld - retention released, in dong. */
export function retentionHeldOfSums(sums: RetentionSums): IndicatorResult {
  if (sums.rows === 0) return na('RETENTION_HELD', 'NO_RETENTION');
  const held = whole(sums.retentionWithheldVnd, 'retention_withheld_vnd') - whole(sums.retentionReleasedVnd, 'retention_released_vnd');
  return ok('RETENTION_HELD', held.toString(), held, null);
}

/** RETENTION_RELEASED_RATIO = retention released / retention withheld, in percent. */
export function retentionReleasedRatioOfSums(sums: RetentionSums): IndicatorResult {
  if (sums.rows === 0) return na('RETENTION_RELEASED_RATIO', 'NO_RETENTION');
  return ratio('RETENTION_RELEASED_RATIO', whole(sums.retentionReleasedVnd, 'retention_released_vnd'), whole(sums.retentionWithheldVnd, 'retention_withheld_vnd'));
}

export const retentionHeld = (rows: readonly RetentionRow[]): IndicatorResult => retentionHeldOfSums(retentionSums(rows));
export const retentionReleasedRatio = (rows: readonly RetentionRow[]): IndicatorResult => retentionReleasedRatioOfSums(retentionSums(rows));

// ---- schedule --------------------------------------------------------------------------------------------------------------------------------------------

export interface ScheduleRow {
  /** The completion date the contract was signed with; a later extension does not move it (that is what "original" means). Null when none was recorded. */
  originalDueDate: string | null;
  /** The day the contract was completed, if it was. */
  completedOn: string | null;
}

function dayNumber(value: string, field: string): number {
  const found = DATE.exec(value);
  if (found === null) throw invalid(field);
  const time = Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]));
  const date = new Date(time);
  if (date.toISOString().slice(0, 10) !== value) throw invalid(field);
  return Math.round(time / 86_400_000);
}

/** DAYS_LATE of one contract: days from the original due date to the day it was completed (or to `asOf` while it is open), never below 0. */
export function daysLate(row: ScheduleRow, asOf: string): IndicatorResult {
  if (row.originalDueDate === null) return na('DAYS_LATE', 'NO_ORIGINAL_DUE_DATE');
  const due = dayNumber(row.originalDueDate, 'original_due_date');
  const until = dayNumber(row.completedOn ?? asOf, row.completedOn === null ? 'as_of' : 'completed_on');
  const late = BigInt(Math.max(0, until - due));
  return ok('DAYS_LATE', late.toString(), late, null);
}

/** The latest of the contracts of a group, as the portfolio says it (the worst contract is the one the group is as late as). Contracts with no original due date are left out. */
export function maxDaysLate(rows: readonly ScheduleRow[], asOf: string): IndicatorResult {
  let worst: IndicatorResult | undefined;
  for (const row of rows) {
    const found = daysLate(row, asOf);
    if (found.status === 'NOT_APPLICABLE') continue;
    if (worst === undefined || BigInt(found.value as string) > BigInt(worst.value as string)) worst = found;
  }
  return worst ?? na('DAYS_LATE', rows.length === 0 ? 'NO_ROWS' : 'NO_ORIGINAL_DUE_DATE');
}

// ---- guarantee coverage ----------------------------------------------------------------------------------------------------------------------------------

export interface GuaranteeRow {
  /** What the contract requires (performance, advance guarantee); null when it requires none. */
  requiredVnd: string | null;
  /** What is in force on the as-of date (not expired, not released, not revoked). */
  validVnd: string | null;
}

export interface GuaranteeSums {
  requiredVnd: string;
  validVnd: string;
  rows: number;
}

export function guaranteeSums(rows: readonly GuaranteeRow[]): GuaranteeSums {
  let required = 0n;
  let valid = 0n;
  let counted = 0;
  for (const row of rows) {
    const need = optionalWhole(row.requiredVnd, 'required_vnd');
    if (need === null || need === 0n) continue;
    required += need;
    valid += optionalWhole(row.validVnd, 'valid_vnd') ?? 0n;
    counted += 1;
  }
  return { requiredVnd: required.toString(), validVnd: valid.toString(), rows: counted };
}

/** GUARANTEE_COVERAGE = guarantee in force / guarantee required, in percent; below 100 the Investor is exposed. */
export function guaranteeCoverageOfSums(sums: GuaranteeSums): IndicatorResult {
  if (sums.rows === 0) return na('GUARANTEE_COVERAGE', 'NO_GUARANTEE_REQUIRED');
  return ratio('GUARANTEE_COVERAGE', whole(sums.validVnd, 'valid_vnd'), whole(sums.requiredVnd, 'required_vnd'));
}

export const guaranteeCoverage = (rows: readonly GuaranteeRow[]): IndicatorResult => guaranteeCoverageOfSums(guaranteeSums(rows));

// ---- single bidder ---------------------------------------------------------------------------------------------------------------------------------------

export interface BidderRow {
  /** How many bidders the package of the contract had; null when it is not on record. */
  bidderCount: number | null;
}

export function singleBidderRateOfCounts(counts: { single: number; known: number }): IndicatorResult {
  if (counts.known === 0) return na('SINGLE_BIDDER_RATE', 'NO_BIDDER_COUNT');
  return ratio('SINGLE_BIDDER_RATE', BigInt(counts.single), BigInt(counts.known));
}

export function singleBidderRate(rows: readonly BidderRow[]): IndicatorResult {
  let single = 0;
  let known = 0;
  for (const row of rows) {
    if (row.bidderCount === null) continue;
    if (!Number.isInteger(row.bidderCount) || row.bidderCount < 1) throw invalid('bidder_count');
    known += 1;
    if (row.bidderCount === 1) single += 1;
  }
  return singleBidderRateOfCounts({ single, known });
}

// ---- concentration: the second stage of a two-stage aggregation --------------------------------------------------------------------------------------------

export const CONCENTRATION_DIMENSIONS = ['investor', 'unit', 'fund', 'contractor'] as const;
export type ConcentrationDimension = (typeof CONCENTRATION_DIMENSIONS)[number];

/** The status whose value counts for concentration: a draft is not exposure and a closed contract no longer is. */
export const ACTIVE_CONTRACT_STATUS = 'ACTIVE';
export const DEFAULT_TOP_N = 5;
/** The key of the group of contracts that have no value in the dimension: shown, so that the groups add up to the whole. */
export const UNCLASSIFIED_GROUP = '(none)';

export interface ContractPartyShare {
  contractorId: string;
  /** numeric(7,4) of the table, in percent: `12.5000`. */
  sharePct: string;
  status: string;
}

export interface ConcentrationRow {
  contractId: string;
  status: string;
  /** The current value of the contract (with its approved changes), whole dong. */
  valueVnd: string;
  investorKey: string | null;
  unitKey: string | null;
  fundKey: string | null;
  /** The lead or sole contractor, used when the contract has no party rows. */
  contractorId: string | null;
  /** The parties of a joint venture: the value of the contract is attributed to each by its share. */
  parties?: readonly ContractPartyShare[] | undefined;
}

export interface ConcentrationGroup {
  key: string;
  valueVnd: string;
  /** Percent with two decimals of the total of the groups. */
  sharePct: string;
}

export interface Concentration {
  dimension: ConcentrationDimension;
  topN: number;
  /** Groups largest first (equal values by key), all of them. */
  groups: ConcentrationGroup[];
  totalVnd: string;
  top: IndicatorResult;
  hhi: IndicatorResult;
  /** Contracts of a joint venture whose party shares do not add up to 100: their value was spread in proportion to the shares given, and a person should look at them. */
  shareAnomalies: string[];
}

const PARTY_SHARE = /^(0|[1-9]\d{0,2})(\.\d{1,4})?$/;

function shareScaled(value: string): bigint {
  if (typeof value !== 'string' || !PARTY_SHARE.test(value)) throw invalid('share_pct');
  const [integer = '0', fraction = ''] = value.split('.');
  const scaled = BigInt(integer) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  // The table says 0 < share <= 100.
  if (scaled <= 0n || scaled > 1_000_000n) throw invalid('share_pct');
  return scaled;
}

/**
 * Spreads `total` over `weights` by the method of the largest remainder, so the parts add up to the total exactly (a joint venture of three at a third each does not lose or invent a dong); equal remainders go to
 * the earlier key, so the spread is the same on every run.
 */
export function spreadByWeight(total: bigint, weights: ReadonlyArray<{ key: string; weight: bigint }>): Array<{ key: string; amount: bigint }> {
  const sum = weights.reduce((acc, item) => acc + item.weight, 0n);
  if (sum <= 0n) throw invalid('share_pct');
  const parts = weights.map((item) => ({ key: item.key, amount: (total * item.weight) / sum, remainder: (total * item.weight) % sum }));
  let left = total - parts.reduce((acc, part) => acc + part.amount, 0n);
  const order = [...parts.keys()].sort((a, b) => {
    const x = parts[a] as { remainder: bigint; key: string };
    const y = parts[b] as { remainder: bigint; key: string };
    return x.remainder === y.remainder ? (x.key < y.key ? -1 : x.key > y.key ? 1 : a - b) : x.remainder > y.remainder ? -1 : 1;
  });
  for (const index of order) {
    if (left === 0n) break;
    (parts[index] as { amount: bigint }).amount += 1n;
    left -= 1n;
  }
  return parts.map((part) => ({ key: part.key, amount: part.amount }));
}

/** The value of a contract by contractor: the whole value to its sole contractor, or spread over the active parties of a joint venture by their shares. */
function contractorValues(row: ConcentrationRow, value: bigint): { values: Array<{ key: string; amount: bigint }>; anomaly: boolean } {
  const parties = (row.parties ?? []).filter((party) => party.status === 'ACTIVE');
  if (parties.length === 0) return { values: [{ key: row.contractorId ?? UNCLASSIFIED_GROUP, amount: value }], anomaly: false };
  const weights = new Map<string, bigint>();
  for (const party of parties) weights.set(party.contractorId, (weights.get(party.contractorId) ?? 0n) + shareScaled(party.sharePct));
  const list = [...weights.entries()].map(([key, weight]) => ({ key, weight }));
  const sum = list.reduce((acc, item) => acc + item.weight, 0n);
  return { values: spreadByWeight(value, list), anomaly: sum !== 1_000_000n };
}

/**
 * TOP_N_SHARE and HHI over the ACTIVE value of the contracts, per investor, unit, fund or contractor. The first stage groups the value (a contract of a joint venture is attributed to its contractors by
 * `contract_party.share_pct`, the other dimensions take the value whole); the second stage reads the groups: top N share = sum of the N largest / total, HHI = sum of (share in percent) squared, from 10000 / n for n equal
 * groups to 10000 for one. Both are made from the exact values, never from rounded shares.
 */
export function concentrationOf(rows: readonly ConcentrationRow[], dimension: ConcentrationDimension, topN: number = DEFAULT_TOP_N): Concentration {
  if (!Number.isInteger(topN) || topN < 1 || topN > 1000) throw invalid('top_n');
  if (!CONCENTRATION_DIMENSIONS.includes(dimension)) throw invalid('dimension');
  const grouped = new Map<string, bigint>();
  const anomalies: string[] = [];
  let counted = 0;
  for (const row of rows) {
    if (row.status !== ACTIVE_CONTRACT_STATUS) continue;
    const value = whole(row.valueVnd, 'value_vnd');
    if (value < 0n) throw invalid('value_vnd');
    counted += 1;
    if (dimension === 'contractor') {
      const spread = contractorValues(row, value);
      if (spread.anomaly) anomalies.push(row.contractId);
      for (const part of spread.values) grouped.set(part.key, (grouped.get(part.key) ?? 0n) + part.amount);
    } else {
      const key = (dimension === 'investor' ? row.investorKey : dimension === 'unit' ? row.unitKey : row.fundKey) ?? UNCLASSIFIED_GROUP;
      grouped.set(key, (grouped.get(key) ?? 0n) + value);
    }
  }
  const total = [...grouped.values()].reduce((acc, value) => acc + value, 0n);
  const ordered = [...grouped.entries()].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[1] > b[1] ? -1 : 1));
  const empty = counted === 0 ? 'NO_ACTIVE_CONTRACT' : 'ZERO_TOTAL';
  const groups: ConcentrationGroup[] = ordered.map(([key, value]) => ({ key, valueVnd: value.toString(), sharePct: total === 0n ? '0.00' : analyticsPercent(value, total) }));
  const result = { dimension, topN, groups, totalVnd: total.toString(), shareAnomalies: anomalies.sort() };
  if (total === 0n) return { ...result, top: na('TOP_N_SHARE', empty), hhi: na('HHI', empty) };
  const topValue = ordered.slice(0, topN).reduce((acc, [, value]) => acc + value, 0n);
  return { ...result, top: ok('TOP_N_SHARE', analyticsPercent(topValue, total), topValue, total), hhi: hhiOfValues(ordered.map(([, value]) => value)) };
}

/** HHI of group values: sum(value^2) x 10000 / total^2 = sum of the squares of the shares in percent, two decimals, half away from zero. */
export function hhiOfValues(values: readonly bigint[]): IndicatorResult {
  const total = values.reduce((acc, value) => acc + value, 0n);
  if (total <= 0n) return na('HHI', values.length === 0 ? 'NO_ROWS' : 'ZERO_TOTAL');
  const squares = values.reduce((acc, value) => acc + value * value, 0n);
  return ok('HHI', decimalText(scaledQuotient(squares, total * total, 10_000n, 2), 2), squares * 10_000n, total * total);
}

// ---- the health of a contract, red, amber, green ---------------------------------------------------------------------------------------------------------------

export const RAG_LEVELS = ['GREEN', 'AMBER', 'RED'] as const;
export type RagLevel = (typeof RAG_LEVELS)[number];

export const RAG_DIMENSIONS = ['DAYS_LATE', 'CHANGE_GROWTH', 'GUARANTEE_COVERAGE', 'PAID_TO_ACCEPTED'] as const;
export type RagDimension = (typeof RAG_DIMENSIONS)[number];

export const CONTRACT_HEALTH_RAG_RULE = 'CONTRACT_HEALTH_RAG';

/** The params of the rule `CONTRACT_HEALTH_RAG`: for the indicators where more is worse, amber starts at `amber` and red at `red`; for the coverage, where less is worse, amber is below `amber` and red below `red`. */
export interface ContractHealthRagParams {
  days_late_amber: number;
  days_late_red: number;
  change_growth_amber_pct: number;
  change_growth_red_pct: number;
  guarantee_coverage_amber_pct: number;
  guarantee_coverage_red_pct: number;
  paid_to_accepted_amber_pct: number;
  paid_to_accepted_red_pct: number;
}

/**
 * The thresholds until the rule registry (governance-rules) holds `CONTRACT_HEALTH_RAG`. They are provisional proposals awaiting the confirmation of the business owner, not law: any legal ceiling on a change or a
 * payment is configuration flagged unverified until a lawyer signs it, and these numbers claim none.
 */
export function contractHealthDefaults(): ContractHealthRagParams {
  return {
    days_late_amber: 1,
    days_late_red: 30,
    change_growth_amber_pct: 5,
    change_growth_red_pct: 10,
    guarantee_coverage_amber_pct: 100,
    guarantee_coverage_red_pct: 80,
    paid_to_accepted_amber_pct: 100,
    paid_to_accepted_red_pct: 110,
  };
}

const RAG_PARAM_KEYS = Object.keys(contractHealthDefaults()) as ReadonlyArray<keyof ContractHealthRagParams>;
const paramProblem = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);

/** The params of the rule, judged: every key is there, no key is unknown, every number is finite, whole days and percents with at most two decimals, and the line from amber to red goes the way the indicator is bad. */
export function contractHealthRagParams(raw: unknown): ContractHealthRagParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw paramProblem('params');
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !(RAG_PARAM_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) throw paramProblem(unknown);
  for (const key of RAG_PARAM_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000 || Math.round(value * 100) / 100 !== value) throw paramProblem(key);
  }
  const params = record as unknown as ContractHealthRagParams;
  if (!Number.isInteger(params.days_late_amber)) throw paramProblem('days_late_amber');
  if (!Number.isInteger(params.days_late_red)) throw paramProblem('days_late_red');
  if (params.days_late_red < params.days_late_amber) throw paramProblem('days_late_red');
  if (params.change_growth_red_pct < params.change_growth_amber_pct) throw paramProblem('change_growth_red_pct');
  if (params.guarantee_coverage_red_pct > params.guarantee_coverage_amber_pct) throw paramProblem('guarantee_coverage_red_pct');
  if (params.paid_to_accepted_red_pct < params.paid_to_accepted_amber_pct) throw paramProblem('paid_to_accepted_red_pct');
  return { ...params };
}

export interface ContractHealthInput {
  daysLate: IndicatorResult;
  changeGrowth: IndicatorResult;
  guaranteeCoverage: IndicatorResult;
  paidToAccepted: IndicatorResult;
}

export interface RagReading {
  dimension: RagDimension;
  /** Null when the indicator is NOT_APPLICABLE: it neither raises nor lowers the contract. */
  level: RagLevel | null;
  value: string | null;
  /** The thresholds the value was held to, as the rule gave them (for the explanation of the colour). */
  amber: number;
  red: number;
  direction: 'HIGHER_IS_WORSE' | 'LOWER_IS_WORSE';
}

export interface ContractHealth {
  /** The worst level among the indicators that apply; null when none applies (the contract has no colour, which is not green). */
  level: RagLevel | null;
  readings: RagReading[];
  /** The dimensions that gave the level, worst first (what to look at). */
  drivers: RagDimension[];
  ruleCode: typeof CONTRACT_HEALTH_RAG_RULE;
}

/** Percent text with two decimals as hundredths. */
const hundredths = (value: string): bigint => BigInt(value.replace('.', ''));

function levelOf(value: string, amber: number, red: number, direction: RagReading['direction']): RagLevel {
  const at = hundredths(value);
  const amberAt = BigInt(Math.round(amber * 100));
  const redAt = BigInt(Math.round(red * 100));
  if (direction === 'HIGHER_IS_WORSE') return at >= redAt ? 'RED' : at >= amberAt ? 'AMBER' : 'GREEN';
  return at < redAt ? 'RED' : at < amberAt ? 'AMBER' : 'GREEN';
}

const RANK: Readonly<Record<RagLevel, number>> = { GREEN: 0, AMBER: 1, RED: 2 };

/**
 * The colour of a contract by the rule `CONTRACT_HEALTH_RAG` (BR: a contract is as bad as its worst indicator that applies). Days late are whole days (amber from `days_late_amber`, red from `days_late_red`); growth is
 * held at amber from its threshold and red from its own, coverage is amber below 100 percent and red below its threshold, paid over accepted amber from its threshold and red from its own. An indicator that is
 * NOT_APPLICABLE is left out, and when all are the contract has no colour.
 */
export function contractHealthRag(input: ContractHealthInput, rawParams: unknown = contractHealthDefaults()): ContractHealth {
  const params = contractHealthRagParams(rawParams);
  const specs: Array<{ dimension: RagDimension; result: IndicatorResult; amber: number; red: number; direction: RagReading['direction']; scale: number }> = [
    { dimension: 'DAYS_LATE', result: input.daysLate, amber: params.days_late_amber, red: params.days_late_red, direction: 'HIGHER_IS_WORSE', scale: 0 },
    { dimension: 'CHANGE_GROWTH', result: input.changeGrowth, amber: params.change_growth_amber_pct, red: params.change_growth_red_pct, direction: 'HIGHER_IS_WORSE', scale: 2 },
    { dimension: 'GUARANTEE_COVERAGE', result: input.guaranteeCoverage, amber: params.guarantee_coverage_amber_pct, red: params.guarantee_coverage_red_pct, direction: 'LOWER_IS_WORSE', scale: 2 },
    { dimension: 'PAID_TO_ACCEPTED', result: input.paidToAccepted, amber: params.paid_to_accepted_amber_pct, red: params.paid_to_accepted_red_pct, direction: 'HIGHER_IS_WORSE', scale: 2 },
  ];
  const readings: RagReading[] = specs.map((spec) => {
    const value = spec.result.status === 'OK' ? spec.result.value : null;
    // Days are whole: they are read as hundredths of a day so the same comparison holds for all.
    const comparable = value === null ? null : spec.scale === 0 ? `${value}.00` : value;
    return { dimension: spec.dimension, level: comparable === null ? null : levelOf(comparable, spec.amber, spec.red, spec.direction), value, amber: spec.amber, red: spec.red, direction: spec.direction };
  });
  const present = readings.filter((reading): reading is RagReading & { level: RagLevel } => reading.level !== null);
  if (present.length === 0) return { level: null, readings, drivers: [], ruleCode: CONTRACT_HEALTH_RAG_RULE };
  const worst = present.reduce((level, reading) => (RANK[reading.level] > RANK[level] ? reading.level : level), 'GREEN' as RagLevel);
  const drivers = present.filter((reading) => reading.level === worst && worst !== 'GREEN').map((reading) => reading.dimension);
  return { level: worst, readings, drivers, ruleCode: CONTRACT_HEALTH_RAG_RULE };
}
