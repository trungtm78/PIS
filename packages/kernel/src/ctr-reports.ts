import { DomainError } from './errors.ts';
import {
  CTR_INDICATORS,
  DEFAULT_TOP_N,
  acceptedToRequestedOfSums,
  advanceOutstandingOfSums,
  advanceOutstandingRatioOfSums,
  analyticsPercent,
  bidPriceVarianceOfSums,
  changeGrowthOfSums,
  concentrationOf,
  contractHealthRag,
  contractHealthDefaults,
  guaranteeCoverageOfSums,
  paidToAcceptedOfSums,
  retentionHeldOfSums,
  retentionReleasedRatioOfSums,
  singleBidderRateOfCounts,
} from './ctr-analytics.ts';
import type { ConcentrationDimension, ContractHealth, ContractPartyShare, IndicatorCode, IndicatorResult, NotApplicableReason } from './ctr-analytics.ts';
import type { ExportColumn, ExportDocument, ExportHeaderEntry } from './dis-export.ts';
import { message } from './messages.ts';

/**
 * The reports of the contract portfolio (CA-1, part 2; plan "nen phan tich hop dong"): the first seven of the catalogue (R1 to R7) and the concentration and load of the contractors (R14). Every report is a table of rows
 * (one per contract, or one per group for R14), a totals row, and, where it helps, a breakdown whose groups are totals of their own contracts. The figures are the ones of `ctr-analytics.ts` (one definition per indicator); this
 * file only says which columns a report has, how a row is made from the row of the fact `contract_fact`, and how a totals row is made from SUMS (the database adds the columns up, the kernel judges the ratios: a ratio of a
 * total is the sum of the numerators over the sum of the denominators, never the mean of the ratios of the rows). It is pure: the same facts give the same report, to the dong.
 */

// ---- the catalogue --------------------------------------------------------------------------------------------------------------------------------------------

export const CTR_REPORT_CODES = ['bid-variance', 'portfolio-status', 'schedule-delay', 'payment-three-way', 'advance-ageing', 'retention-guarantee', 'change-growth', 'contractor-concentration'] as const;
export type CtrReportCode = (typeof CTR_REPORT_CODES)[number];

export const isCtrReportCode = (value: unknown): value is CtrReportCode => typeof value === 'string' && (CTR_REPORT_CODES as readonly string[]).includes(value);

export type ColumnKind = 'TEXT' | 'MONEY' | 'PERCENT' | 'DAYS' | 'COUNT' | 'DATE' | 'RAG' | 'INDEX' | 'FLAG';

/** Why a cell has no figure (a zero is a figure; this is not one). */
export type CellReason = NotApplicableReason | 'LEDGER_DENIED' | 'NOT_IN_SNAPSHOT' | 'NO_DATE' | 'NO_PAYMENT';

export interface ReportColumn {
  key: string;
  kind: ColumnKind;
  /** The figure is read from the ledger of the contract: a reader without `ledger.read` over the contract gets no figure (and the total leaves the contract out). */
  ledger: boolean;
  /** The indicator whose definition (formula, numerator, denominator) the "i" of the column shows. */
  indicator: IndicatorCode | null;
  /** Whether the column of the totals row is a sum, a ratio of sums, the largest or nothing. */
  total: 'SUM' | 'RATIO' | 'MAX' | null;
}

const col = (key: string, kind: ColumnKind, extra: Partial<Omit<ReportColumn, 'key' | 'kind'>> = {}): ReportColumn => ({ key, kind, ledger: false, indicator: null, total: null, ...extra });
const money = (key: string, extra: Partial<Omit<ReportColumn, 'key' | 'kind'>> = {}): ReportColumn => col(key, 'MONEY', { total: 'SUM', ...extra });
const ledgerMoney = (key: string): ReportColumn => money(key, { ledger: true });

const IDENTITY: ReportColumn[] = [col('code', 'TEXT'), col('title', 'TEXT'), col('project_code', 'TEXT'), col('contractor_name', 'TEXT'), col('unit_name', 'TEXT'), col('contract_status', 'TEXT')];

export const REPORT_COLUMNS: Readonly<Record<Exclude<CtrReportCode, 'contractor-concentration'>, readonly ReportColumn[]>> = {
  'bid-variance': [
    ...IDENTITY,
    money('winning_bid_vnd', { total: 'SUM' }),
    money('original_value_vnd'),
    col('bid_variance_vnd', 'MONEY', { total: 'SUM' }),
    col('bid_variance_pct', 'PERCENT', { total: 'RATIO', indicator: 'BID_PRICE_VARIANCE' }),
    col('bidder_count', 'COUNT'),
    col('single_bidder', 'FLAG', { total: 'RATIO', indicator: 'SINGLE_BIDDER_RATE' }),
  ],
  'portfolio-status': [
    ...IDENTITY,
    money('contract_value_vnd'),
    money('original_value_vnd'),
    money('approved_change_delta_vnd'),
    col('change_growth_pct', 'PERCENT', { total: 'RATIO', indicator: 'CHANGE_GROWTH' }),
    ledgerMoney('accepted_vnd'),
    ledgerMoney('paid_vnd'),
    col('paid_to_accepted_pct', 'PERCENT', { ledger: true, total: 'RATIO', indicator: 'PAID_TO_ACCEPTED' }),
    col('days_late', 'DAYS', { total: 'MAX', indicator: 'DAYS_LATE' }),
    col('health', 'RAG'),
  ],
  'schedule-delay': [
    ...IDENTITY,
    col('original_due_date', 'DATE'),
    col('approved_extension_days', 'DAYS', { total: 'SUM' }),
    col('completed_on', 'DATE'),
    col('days_late', 'DAYS', { total: 'MAX', indicator: 'DAYS_LATE' }),
    col('milestone_count', 'COUNT', { total: 'SUM' }),
    col('milestone_past_due_count', 'COUNT', { total: 'SUM' }),
  ],
  'payment-three-way': [
    ...IDENTITY,
    ledgerMoney('requested_vnd'),
    ledgerMoney('measured_vnd'),
    ledgerMoney('accepted_vnd'),
    ledgerMoney('paid_vnd'),
    col('accepted_to_requested_pct', 'PERCENT', { ledger: true, total: 'RATIO', indicator: 'ACCEPTED_TO_REQUESTED' }),
    col('paid_to_accepted_pct', 'PERCENT', { ledger: true, total: 'RATIO', indicator: 'PAID_TO_ACCEPTED' }),
    col('acceptance_to_request_days_max', 'DAYS', { total: 'MAX' }),
    col('request_to_treasury_days_max', 'DAYS', { total: 'MAX' }),
    col('payment_clock', 'TEXT'),
  ],
  'advance-ageing': [
    ...IDENTITY,
    ledgerMoney('advance_paid_vnd'),
    ledgerMoney('advance_recovered_vnd'),
    ledgerMoney('advance_outstanding_vnd'),
    col('advance_outstanding_pct', 'PERCENT', { ledger: true, total: 'RATIO', indicator: 'ADVANCE_OUTSTANDING_RATIO' }),
    col('progress_pct', 'PERCENT', { ledger: true }),
    col('first_advance_on', 'DATE'),
    col('age_days', 'DAYS', { total: 'MAX' }),
    col('age_bucket', 'TEXT'),
  ],
  'retention-guarantee': [
    ...IDENTITY,
    ledgerMoney('retention_withheld_vnd'),
    ledgerMoney('retention_released_vnd'),
    ledgerMoney('retention_held_vnd'),
    col('retention_released_pct', 'PERCENT', { ledger: true, total: 'RATIO', indicator: 'RETENTION_RELEASED_RATIO' }),
    money('guarantee_required_vnd'),
    money('guarantee_valid_vnd'),
    col('guarantee_coverage_pct', 'PERCENT', { total: 'RATIO', indicator: 'GUARANTEE_COVERAGE' }),
    col('guarantee_exposure_vnd', 'MONEY', { total: 'SUM' }),
    col('guarantee_next_expiry_on', 'DATE'),
  ],
  'change-growth': [
    ...IDENTITY,
    money('original_value_vnd'),
    money('approved_change_delta_vnd'),
    col('change_growth_pct', 'PERCENT', { total: 'RATIO', indicator: 'CHANGE_GROWTH' }),
    col('approved_change_count', 'COUNT', { total: 'SUM' }),
    col('max_change_tier', 'COUNT', { total: 'MAX' }),
    col('max_cumulative_variation_pct', 'PERCENT', { total: 'MAX' }),
  ],
};

/** The report the "i" of a column explains: the indicator it comes from, or null. */
export const indicatorOfColumn = (report: CtrReportCode, key: string): IndicatorCode | null => (report === 'contractor-concentration' ? null : (REPORT_COLUMNS[report].find((column) => column.key === key)?.indicator ?? null));

/** The reports of the catalogue: its reference in the plan (R1 to R7, R14), what it breaks down by, and whether it has a series (a trend is a BI series over DS-CTR, never an endpoint of its own). */
export const REPORT_CATALOGUE: Readonly<Record<CtrReportCode, { ref: string; breakdown: string | null; indicators: readonly IndicatorCode[] }>> = {
  'bid-variance': { ref: 'R1', breakdown: 'bidder_band', indicators: ['BID_PRICE_VARIANCE', 'SINGLE_BIDDER_RATE'] },
  'portfolio-status': { ref: 'R2', breakdown: 'contract_status', indicators: ['CHANGE_GROWTH', 'PAID_TO_ACCEPTED', 'DAYS_LATE'] },
  'schedule-delay': { ref: 'R3', breakdown: 'delay_band', indicators: ['DAYS_LATE'] },
  'payment-three-way': { ref: 'R4', breakdown: null, indicators: ['ACCEPTED_TO_REQUESTED', 'PAID_TO_ACCEPTED'] },
  'advance-ageing': { ref: 'R5', breakdown: 'age_bucket', indicators: ['ADVANCE_OUTSTANDING', 'ADVANCE_OUTSTANDING_RATIO'] },
  'retention-guarantee': { ref: 'R6', breakdown: 'contract_status', indicators: ['RETENTION_HELD', 'RETENTION_RELEASED_RATIO', 'GUARANTEE_COVERAGE'] },
  'change-growth': { ref: 'R7', breakdown: 'change_tier', indicators: ['CHANGE_GROWTH'] },
  'contractor-concentration': { ref: 'R14', breakdown: null, indicators: ['TOP_N_SHARE', 'HHI', 'SINGLE_BIDDER_RATE'] },
};

/** The groups a breakdown has, in the order they are shown (the key of a group is also what the database cuts by). */
export const BREAKDOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  bidder_band: ['ONE', 'TWO_THREE', 'FOUR_PLUS', 'UNKNOWN'],
  contract_status: ['DRAFT', 'IN_REVIEW', 'SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'COMPLETED', 'CLOSED', 'CANCELLED'],
  delay_band: ['NOT_LATE', 'LATE_1_30', 'LATE_31_90', 'LATE_OVER_90', 'NOT_APPLICABLE'],
  age_bucket: ['UP_TO_90', 'D91_180', 'D181_365', 'OVER_365'],
  change_tier: ['NONE', 'TIER_1', 'TIER_2', 'TIER_3'],
};

// ---- the fact: the row of `contract_fact`, with the names a person reads ------------------------------------------------------------------------------------------

/** A row of the view `contract_fact` (money whole dong as text), with the labels of the project, the contractor and the unit. */
export interface ContractFact {
  id: string;
  code: string;
  title: string | null;
  contractStatus: string;
  contractType: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  packageId: string;
  contractorId: string;
  contractorName: string | null;
  isJointVenture: boolean;
  unitId: string;
  unitName: string;
  investorId: string | null;
  fundSourceVersionId: string | null;
  signedOn: string | null;
  originalDueDate: string | null;
  completedOn: string | null;
  terminatedOn: string | null;
  approvedExtensionDays: number;
  milestoneCount: number;
  milestonePastDueCount: number;
  contractValueVnd: string;
  originalValueVnd: string;
  approvedChangeDeltaVnd: string;
  approvedChangeCount: number;
  maxChangeTier: number | null;
  maxCumulativeVariationPct: string | null;
  winningBidVnd: string | null;
  bidderCount: number | null;
  requestedVnd: string;
  acceptedVnd: string;
  paidVnd: string;
  advancePaidVnd: string;
  advanceRecoveredVnd: string;
  retentionWithheldVnd: string;
  retentionReleasedVnd: string;
  guaranteeRequiredVnd: string | null;
  guaranteeValidVnd: string | null;
  guaranteeNextExpiryOn: string | null;
  measuredVnd: string;
  firstAdvanceOn: string | null;
  lastAcceptanceOn: string | null;
  acceptanceToRequestDaysMax: number | null;
  requestToTreasuryDaysMax: number | null;
  paymentsSentCount: number;
  openNcrCount: number;
  projectOpenIssueCount: number;
  auditFindingCount: number;
  daysLate: number | null;
  asOfDate: string;
  /** Whether the reader holds `ledger.read` over this contract. */
  ledgerOk: boolean;
}

export type CellValue = string | number | null;

export interface ReportRow {
  id: string;
  cells: Record<string, CellValue>;
  /** Why a cell has no figure. */
  na: Record<string, CellReason>;
  /** The colour of the contract (portfolio report only). */
  health?: ContractHealth | undefined;
}

// ---- the rule of the clock of a payment ---------------------------------------------------------------------------------------------------------------------------

export const PAYMENT_CLOCK_RULE = 'CONTRACT_PAYMENT_CLOCK';

/** The params of the rule `CONTRACT_PAYMENT_CLOCK`: the days (calendar) a payment may take at each of its two steps. */
export interface PaymentClockParams {
  acceptance_to_request_days: number;
  request_to_treasury_days: number;
}

/** Provisional values awaiting the confirmation of the business owner and a lawyer: not law (any legal period is configuration flagged unverified until it is signed). */
export const paymentClockDefaults = (): PaymentClockParams => ({ acceptance_to_request_days: 14, request_to_treasury_days: 7 });

export function paymentClockParams(raw: unknown): PaymentClockParams {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('params');
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== 'acceptance_to_request_days' && key !== 'request_to_treasury_days') throw bad(key);
  for (const key of ['acceptance_to_request_days', 'request_to_treasury_days'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365) throw bad(key);
  }
  return { acceptance_to_request_days: record.acceptance_to_request_days as number, request_to_treasury_days: record.request_to_treasury_days as number };
}

export type PaymentClockStatus = 'WITHIN' | 'LATE' | 'NO_PAYMENT';

/** A contract is on its payment clock when its worst request took no more days than the rule allows at both steps; a contract with no request to judge is `NO_PAYMENT`, never "within". */
export function paymentClockOf(fact: Pick<ContractFact, 'acceptanceToRequestDaysMax' | 'requestToTreasuryDaysMax'>, params: PaymentClockParams): PaymentClockStatus {
  if (fact.acceptanceToRequestDaysMax === null && fact.requestToTreasuryDaysMax === null) return 'NO_PAYMENT';
  const late =
    (fact.acceptanceToRequestDaysMax !== null && fact.acceptanceToRequestDaysMax > params.acceptance_to_request_days) ||
    (fact.requestToTreasuryDaysMax !== null && fact.requestToTreasuryDaysMax > params.request_to_treasury_days);
  return late ? 'LATE' : 'WITHIN';
}

// ---- the helpers -----------------------------------------------------------------------------------------------------------------------------------------------

const big = (value: string | null): bigint => (value === null ? 0n : BigInt(value));
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(value: string, field: string): number {
  const found = DAY.exec(value);
  if (found === null) throw new DomainError('VALIDATION_FAILED', 422, field);
  return Math.round(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])) / 86_400_000);
}

const NEVER_IN_FORCE = ['DRAFT', 'IN_REVIEW', 'CANCELLED'];

/** DAYS_LATE of a fact: from the original due date to the day it was completed or terminated, or to the as-of day while it is open; none for a contract that was never in force. Whole days, never below 0. */
export function daysLateOfFact(fact: Pick<ContractFact, 'originalDueDate' | 'completedOn' | 'terminatedOn' | 'contractStatus'>, asOf: string): { value: number | null; reason: CellReason | null } {
  if (NEVER_IN_FORCE.includes(fact.contractStatus)) return { value: null, reason: 'NO_ROWS' };
  if (fact.originalDueDate === null) return { value: null, reason: 'NO_ORIGINAL_DUE_DATE' };
  const until = fact.completedOn ?? fact.terminatedOn ?? asOf;
  return { value: Math.max(0, dayNumber(until, 'as_of') - dayNumber(fact.originalDueDate, 'original_due_date')), reason: null };
}

const ageOf = (from: string | null, asOf: string): number | null => (from === null ? null : Math.max(0, dayNumber(asOf, 'as_of') - dayNumber(from, 'first_advance_on')));

export function ageBucketOf(age: number | null): string | null {
  if (age === null) return null;
  return age <= 90 ? 'UP_TO_90' : age <= 180 ? 'D91_180' : age <= 365 ? 'D181_365' : 'OVER_365';
}

export function delayBandOf(days: number | null): string {
  if (days === null) return 'NOT_APPLICABLE';
  return days === 0 ? 'NOT_LATE' : days <= 30 ? 'LATE_1_30' : days <= 90 ? 'LATE_31_90' : 'LATE_OVER_90';
}

export function bidderBandOf(count: number | null): string {
  return count === null ? 'UNKNOWN' : count === 1 ? 'ONE' : count <= 3 ? 'TWO_THREE' : 'FOUR_PLUS';
}

export const tierBandOf = (tier: number | null): string => (tier === null ? 'NONE' : `TIER_${tier}`);

const pctOf = (numerator: bigint, denominator: bigint): string | null => (denominator === 0n ? null : analyticsPercent(numerator, denominator));
const text = (value: string | null | undefined): CellValue => value ?? null;

function setIndicator(row: ReportRow, key: string, result: IndicatorResult): void {
  row.cells[key] = result.value;
  if (result.status === 'NOT_APPLICABLE' && result.reason !== null) row.na[key] = result.reason;
}

/** The figures a row of a report is made of, from the fact; the ratios are the indicators of `ctr-analytics.ts` applied to a portfolio of one contract. */
export function indicatorsOfFact(fact: ContractFact): {
  bid: IndicatorResult;
  growth: IndicatorResult;
  paidToAccepted: IndicatorResult;
  acceptedToRequested: IndicatorResult;
  advanceRatio: IndicatorResult;
  retentionReleased: IndicatorResult;
  guarantee: IndicatorResult;
} {
  const advanceRows = big(fact.advancePaidVnd) > 0n ? 1 : 0;
  const retentionRows = big(fact.retentionWithheldVnd) > 0n ? 1 : 0;
  const guaranteeRows = fact.guaranteeRequiredVnd !== null && big(fact.guaranteeRequiredVnd) > 0n ? 1 : 0;
  return {
    bid: bidPriceVarianceOfSums({ contractValueVnd: fact.winningBidVnd === null ? '0' : fact.originalValueVnd, winningBidVnd: fact.winningBidVnd ?? '0', rows: fact.winningBidVnd === null ? 0 : 1 }),
    growth: changeGrowthOfSums({ originalValueVnd: fact.originalValueVnd, approvedDeltaVnd: fact.approvedChangeDeltaVnd }),
    paidToAccepted: paidToAcceptedOfSums({ requestedVnd: fact.requestedVnd, acceptedVnd: fact.acceptedVnd, paidVnd: fact.paidVnd }),
    acceptedToRequested: acceptedToRequestedOfSums({ requestedVnd: fact.requestedVnd, acceptedVnd: fact.acceptedVnd, paidVnd: fact.paidVnd }),
    advanceRatio: advanceOutstandingRatioOfSums({ advancePaidVnd: fact.advancePaidVnd, advanceRecoveredVnd: fact.advanceRecoveredVnd, rows: advanceRows }),
    retentionReleased: retentionReleasedRatioOfSums({ retentionWithheldVnd: fact.retentionWithheldVnd, retentionReleasedVnd: fact.retentionReleasedVnd, rows: retentionRows }),
    guarantee: guaranteeCoverageOfSums({ requiredVnd: fact.guaranteeRequiredVnd ?? '0', validVnd: fact.guaranteeValidVnd ?? '0', rows: guaranteeRows }),
  };
}

/** The colour of a contract by `CONTRACT_HEALTH_RAG` thresholds `params` (the governance port gives them; the defaults are the same function). */
export function healthOfFact(fact: ContractFact, asOf: string, params: unknown = contractHealthDefaults()): ContractHealth {
  const found = indicatorsOfFact(fact);
  const late = daysLateOfFact(fact, asOf);
  const lateResult: IndicatorResult =
    late.value === null
      ? { code: 'DAYS_LATE', unit: 'DAYS', value: null, status: 'NOT_APPLICABLE', reason: late.reason === 'NO_ORIGINAL_DUE_DATE' ? 'NO_ORIGINAL_DUE_DATE' : 'NO_ROWS', numerator: null, denominator: null }
      : { code: 'DAYS_LATE', unit: 'DAYS', value: String(late.value), status: 'OK', reason: null, numerator: String(late.value), denominator: null };
  return contractHealthRag({ daysLate: lateResult, changeGrowth: found.growth, guaranteeCoverage: found.guarantee, paidToAccepted: found.paidToAccepted }, params);
}

const LEDGER_NA: CellReason = 'LEDGER_DENIED';

/** One row of a report from the fact: the identity of the contract, then the figures of the report; a ledger figure the reader may not see is `LEDGER_DENIED`, never zero. */
export function reportRowOf(code: Exclude<CtrReportCode, 'contractor-concentration'>, fact: ContractFact, context: { asOf: string; ragParams?: unknown; clock?: PaymentClockParams }): ReportRow {
  const row: ReportRow = {
    id: fact.id,
    cells: {
      code: fact.code,
      title: text(fact.title),
      project_code: fact.projectCode,
      contractor_name: text(fact.contractorName),
      unit_name: fact.unitName,
      contract_status: fact.contractStatus,
    },
    na: {},
  };
  const found = indicatorsOfFact(fact);
  const late = daysLateOfFact(fact, context.asOf);
  const put = (key: string, value: CellValue, reason: CellReason | null = null): void => {
    row.cells[key] = value;
    if (value === null && reason !== null) row.na[key] = reason;
  };
  switch (code) {
    case 'bid-variance': {
      put('winning_bid_vnd', fact.winningBidVnd, 'NO_WINNING_BID');
      put('original_value_vnd', fact.originalValueVnd);
      put('bid_variance_vnd', fact.winningBidVnd === null ? null : (big(fact.originalValueVnd) - big(fact.winningBidVnd)).toString(), 'NO_WINNING_BID');
      setIndicator(row, 'bid_variance_pct', found.bid);
      put('bidder_count', fact.bidderCount, 'NO_BIDDER_COUNT');
      put('single_bidder', fact.bidderCount === null ? null : fact.bidderCount === 1 ? 1 : 0, 'NO_BIDDER_COUNT');
      break;
    }
    case 'portfolio-status': {
      put('contract_value_vnd', fact.contractValueVnd);
      put('original_value_vnd', fact.originalValueVnd);
      put('approved_change_delta_vnd', fact.approvedChangeDeltaVnd);
      setIndicator(row, 'change_growth_pct', found.growth);
      put('accepted_vnd', fact.ledgerOk ? fact.acceptedVnd : null, fact.ledgerOk ? null : LEDGER_NA);
      put('paid_vnd', fact.ledgerOk ? fact.paidVnd : null, fact.ledgerOk ? null : LEDGER_NA);
      if (fact.ledgerOk) setIndicator(row, 'paid_to_accepted_pct', found.paidToAccepted);
      else put('paid_to_accepted_pct', null, LEDGER_NA);
      put('days_late', late.value, late.reason);
      // The colour reads the ledger (paid over accepted): a reader who may not see the ledger is shown the colour of what they may see, so it is judged on the other indicators only.
      const health = healthOfFact(fact.ledgerOk ? fact : { ...fact, requestedVnd: '0', acceptedVnd: '0', paidVnd: '0' }, context.asOf, context.ragParams);
      row.health = health;
      put('health', health.level);
      break;
    }
    case 'schedule-delay': {
      put('original_due_date', fact.originalDueDate, 'NO_ORIGINAL_DUE_DATE');
      put('approved_extension_days', fact.approvedExtensionDays);
      put('completed_on', fact.completedOn ?? fact.terminatedOn, 'NO_DATE');
      put('days_late', late.value, late.reason);
      put('milestone_count', fact.milestoneCount);
      put('milestone_past_due_count', fact.milestonePastDueCount);
      break;
    }
    case 'payment-three-way': {
      const ledger = (key: string, value: string): void => put(key, fact.ledgerOk ? value : null, fact.ledgerOk ? null : LEDGER_NA);
      ledger('requested_vnd', fact.requestedVnd);
      ledger('measured_vnd', fact.measuredVnd);
      ledger('accepted_vnd', fact.acceptedVnd);
      ledger('paid_vnd', fact.paidVnd);
      if (fact.ledgerOk) {
        setIndicator(row, 'accepted_to_requested_pct', found.acceptedToRequested);
        setIndicator(row, 'paid_to_accepted_pct', found.paidToAccepted);
      } else {
        put('accepted_to_requested_pct', null, LEDGER_NA);
        put('paid_to_accepted_pct', null, LEDGER_NA);
      }
      put('acceptance_to_request_days_max', fact.acceptanceToRequestDaysMax, 'NO_PAYMENT');
      put('request_to_treasury_days_max', fact.requestToTreasuryDaysMax, 'NO_PAYMENT');
      put('payment_clock', paymentClockOf(fact, context.clock ?? paymentClockDefaults()));
      break;
    }
    case 'advance-ageing': {
      const has = big(fact.advancePaidVnd) > 0n;
      const age = ageOf(fact.firstAdvanceOn, context.asOf);
      const ledger = (key: string, value: string | null, reason: CellReason): void => put(key, !fact.ledgerOk ? null : has ? value : null, !fact.ledgerOk ? LEDGER_NA : has ? null : reason);
      ledger('advance_paid_vnd', fact.advancePaidVnd, 'NO_ADVANCE');
      ledger('advance_recovered_vnd', fact.advanceRecoveredVnd, 'NO_ADVANCE');
      ledger('advance_outstanding_vnd', (big(fact.advancePaidVnd) - big(fact.advanceRecoveredVnd)).toString(), 'NO_ADVANCE');
      if (fact.ledgerOk) setIndicator(row, 'advance_outstanding_pct', found.advanceRatio);
      else put('advance_outstanding_pct', null, LEDGER_NA);
      put('progress_pct', fact.ledgerOk ? pctOf(big(fact.acceptedVnd), big(fact.contractValueVnd)) : null, fact.ledgerOk ? 'ZERO_DENOMINATOR' : LEDGER_NA);
      const shown = fact.ledgerOk && has;
      const hidden: CellReason = !fact.ledgerOk ? LEDGER_NA : has ? 'NO_DATE' : 'NO_ADVANCE';
      put('first_advance_on', shown ? fact.firstAdvanceOn : null, hidden);
      put('age_days', shown ? age : null, hidden);
      put('age_bucket', shown ? ageBucketOf(age) : null, hidden);
      break;
    }
    case 'retention-guarantee': {
      const has = big(fact.retentionWithheldVnd) > 0n;
      const ledger = (key: string, value: string): void => put(key, !fact.ledgerOk ? null : has ? value : null, !fact.ledgerOk ? LEDGER_NA : has ? null : 'NO_RETENTION');
      ledger('retention_withheld_vnd', fact.retentionWithheldVnd);
      ledger('retention_released_vnd', fact.retentionReleasedVnd);
      ledger('retention_held_vnd', (big(fact.retentionWithheldVnd) - big(fact.retentionReleasedVnd)).toString());
      if (fact.ledgerOk) setIndicator(row, 'retention_released_pct', found.retentionReleased);
      else put('retention_released_pct', null, LEDGER_NA);
      const required = fact.guaranteeRequiredVnd !== null && big(fact.guaranteeRequiredVnd) > 0n;
      put('guarantee_required_vnd', required ? fact.guaranteeRequiredVnd : null, 'NO_GUARANTEE_REQUIRED');
      put('guarantee_valid_vnd', required ? (fact.guaranteeValidVnd ?? '0') : null, 'NO_GUARANTEE_REQUIRED');
      setIndicator(row, 'guarantee_coverage_pct', found.guarantee);
      put('guarantee_exposure_vnd', required ? (big(fact.guaranteeRequiredVnd) - big(fact.guaranteeValidVnd)).toString() : null, 'NO_GUARANTEE_REQUIRED');
      put('guarantee_next_expiry_on', fact.guaranteeNextExpiryOn, 'NO_DATE');
      break;
    }
    case 'change-growth': {
      put('original_value_vnd', fact.originalValueVnd);
      put('approved_change_delta_vnd', fact.approvedChangeDeltaVnd);
      setIndicator(row, 'change_growth_pct', found.growth);
      put('approved_change_count', fact.approvedChangeCount);
      put('max_change_tier', fact.maxChangeTier, 'NO_ROWS');
      put('max_cumulative_variation_pct', fact.maxCumulativeVariationPct, 'NO_ROWS');
      break;
    }
  }
  return row;
}

// ---- sums, and the totals row made from them ------------------------------------------------------------------------------------------------------------------

/** The columns the database adds up for a totals row or a group (whole dong or whole counts, as text). The ledger ones are summed over the contracts the reader may see the ledger of. */
export const SUM_KEYS = [
  'contract_value',
  'original_value',
  'change_delta',
  'change_count',
  'requested',
  'accepted',
  'paid',
  'measured',
  'advance_paid',
  'advance_recovered',
  'advance_rows',
  'retention_withheld',
  'retention_released',
  'retention_rows',
  'bid_contract',
  'bid_price',
  'bid_rows',
  'guarantee_required',
  'guarantee_valid',
  'guarantee_rows',
  'single_bidder',
  'bidder_known',
  'extension_days',
  'milestones',
  'milestones_past_due',
  'max_days_late',
  'max_age_days',
  'max_acceptance_to_request',
  'max_request_to_treasury',
  'max_tier',
  'max_cumulative_variation',
] as const;
export type SumKey = (typeof SUM_KEYS)[number];
export type Sums = Record<SumKey, string | null> & { rows: number; ledgerRows: number };

/** Which sums a report needs (the database evaluates only these: the fact is made of subqueries and a column nobody reads is never computed). */
export const REPORT_SUMS: Readonly<Record<Exclude<CtrReportCode, 'contractor-concentration'>, readonly SumKey[]>> = {
  'bid-variance': ['bid_contract', 'bid_price', 'bid_rows', 'single_bidder', 'bidder_known'],
  'portfolio-status': ['contract_value', 'original_value', 'change_delta', 'accepted', 'paid', 'requested', 'max_days_late'],
  'schedule-delay': ['extension_days', 'milestones', 'milestones_past_due', 'max_days_late'],
  'payment-three-way': ['requested', 'measured', 'accepted', 'paid', 'max_acceptance_to_request', 'max_request_to_treasury'],
  'advance-ageing': ['advance_paid', 'advance_recovered', 'advance_rows', 'max_age_days'],
  'retention-guarantee': ['retention_withheld', 'retention_released', 'retention_rows', 'guarantee_required', 'guarantee_valid', 'guarantee_rows'],
  'change-growth': ['original_value', 'change_delta', 'change_count', 'max_tier', 'max_cumulative_variation'],
};

/** The sums of a list of facts, in the way the database adds them (the agreement tests hold the two together). */
export function sumsOfFacts(facts: readonly ContractFact[], asOf: string): Sums {
  const total = (pick: (fact: ContractFact) => bigint, ledgerOnly = false): string => facts.reduce((acc, fact) => (ledgerOnly && !fact.ledgerOk ? acc : acc + pick(fact)), 0n).toString();
  const biggest = (pick: (fact: ContractFact) => number | null): string | null => {
    const values = facts.map(pick).filter((value): value is number => value !== null);
    return values.length === 0 ? null : String(Math.max(...values));
  };
  const withBid = facts.filter((fact) => fact.winningBidVnd !== null);
  const advance = facts.filter((fact) => fact.ledgerOk && big(fact.advancePaidVnd) > 0n);
  const retention = facts.filter((fact) => fact.ledgerOk && big(fact.retentionWithheldVnd) > 0n);
  const guarantee = facts.filter((fact) => fact.guaranteeRequiredVnd !== null && big(fact.guaranteeRequiredVnd) > 0n);
  const known = facts.filter((fact) => fact.bidderCount !== null);
  const maxCum = facts.map((fact) => fact.maxCumulativeVariationPct).filter((value): value is string => value !== null);
  return {
    rows: facts.length,
    ledgerRows: facts.filter((fact) => fact.ledgerOk).length,
    contract_value: total((f) => big(f.contractValueVnd)),
    original_value: total((f) => big(f.originalValueVnd)),
    change_delta: total((f) => big(f.approvedChangeDeltaVnd)),
    change_count: String(facts.reduce((acc, fact) => acc + fact.approvedChangeCount, 0)),
    requested: total((f) => big(f.requestedVnd), true),
    accepted: total((f) => big(f.acceptedVnd), true),
    paid: total((f) => big(f.paidVnd), true),
    measured: total((f) => big(f.measuredVnd), true),
    advance_paid: total((f) => (big(f.advancePaidVnd) > 0n ? big(f.advancePaidVnd) : 0n), true),
    advance_recovered: advance.reduce((acc, fact) => acc + big(fact.advanceRecoveredVnd), 0n).toString(),
    advance_rows: String(advance.length),
    retention_withheld: retention.reduce((acc, fact) => acc + big(fact.retentionWithheldVnd), 0n).toString(),
    retention_released: retention.reduce((acc, fact) => acc + big(fact.retentionReleasedVnd), 0n).toString(),
    retention_rows: String(retention.length),
    bid_contract: withBid.reduce((acc, fact) => acc + big(fact.originalValueVnd), 0n).toString(),
    bid_price: withBid.reduce((acc, fact) => acc + big(fact.winningBidVnd), 0n).toString(),
    bid_rows: String(withBid.length),
    guarantee_required: guarantee.reduce((acc, fact) => acc + big(fact.guaranteeRequiredVnd), 0n).toString(),
    guarantee_valid: guarantee.reduce((acc, fact) => acc + big(fact.guaranteeValidVnd), 0n).toString(),
    guarantee_rows: String(guarantee.length),
    single_bidder: String(known.filter((fact) => fact.bidderCount === 1).length),
    bidder_known: String(known.length),
    extension_days: String(facts.reduce((acc, fact) => acc + fact.approvedExtensionDays, 0)),
    milestones: String(facts.reduce((acc, fact) => acc + fact.milestoneCount, 0)),
    milestones_past_due: String(facts.reduce((acc, fact) => acc + fact.milestonePastDueCount, 0)),
    max_days_late: biggest((fact) => daysLateOfFact(fact, asOf).value),
    max_age_days: biggest((fact) => (fact.ledgerOk && big(fact.advancePaidVnd) > 0n ? ageOf(fact.firstAdvanceOn, asOf) : null)),
    max_acceptance_to_request: biggest((fact) => fact.acceptanceToRequestDaysMax),
    max_request_to_treasury: biggest((fact) => fact.requestToTreasuryDaysMax),
    max_tier: biggest((fact) => fact.maxChangeTier),
    max_cumulative_variation: maxCum.length === 0 ? null : maxCum.reduce((a, b) => (Number(b) > Number(a) ? b : a)),
  };
}

export interface ReportTotals {
  /** The contracts the total is over. */
  rows: number;
  /** Of them, the contracts whose ledger the reader may see: the ledger columns are totals over these only. */
  ledgerRows: number;
  cells: Record<string, CellValue>;
  na: Record<string, CellReason>;
  indicators: IndicatorResult[];
}

const sumOf = (sums: Sums, key: SumKey): string => sums[key] ?? '0';

/** The totals row (or a group) of a report from its sums: sums are the sums, ratios are of the sums, the largest is the largest. */
export function totalsOfSums(code: Exclude<CtrReportCode, 'contractor-concentration'>, sums: Sums): ReportTotals {
  const cells: Record<string, CellValue> = {};
  const na: Record<string, CellReason> = {};
  const indicators: IndicatorResult[] = [];
  const put = (key: string, value: CellValue, reason: CellReason | null = null): void => {
    cells[key] = value;
    if (value === null && reason !== null) na[key] = reason;
  };
  const indicator = (key: string, result: IndicatorResult): void => {
    put(key, result.value, result.reason);
    indicators.push(result);
  };
  const ledgerless = sums.rows > 0 && sums.ledgerRows === 0;
  const ledger = (key: string, value: string | null): void => put(key, ledgerless ? null : value, ledgerless ? LEDGER_NA : null);
  const payments = { requestedVnd: sumOf(sums, 'requested'), acceptedVnd: sumOf(sums, 'accepted'), paidVnd: sumOf(sums, 'paid') };
  switch (code) {
    case 'bid-variance': {
      put('winning_bid_vnd', sumOf(sums, 'bid_price'));
      put('original_value_vnd', sumOf(sums, 'bid_contract'));
      put('bid_variance_vnd', (BigInt(sumOf(sums, 'bid_contract')) - BigInt(sumOf(sums, 'bid_price'))).toString());
      indicator('bid_variance_pct', bidPriceVarianceOfSums({ contractValueVnd: sumOf(sums, 'bid_contract'), winningBidVnd: sumOf(sums, 'bid_price'), rows: Number(sumOf(sums, 'bid_rows')) }));
      put('bidder_count', null);
      indicator('single_bidder', singleBidderRateOfCounts({ single: Number(sumOf(sums, 'single_bidder')), known: Number(sumOf(sums, 'bidder_known')) }));
      break;
    }
    case 'portfolio-status': {
      put('contract_value_vnd', sumOf(sums, 'contract_value'));
      put('original_value_vnd', sumOf(sums, 'original_value'));
      put('approved_change_delta_vnd', sumOf(sums, 'change_delta'));
      indicator('change_growth_pct', changeGrowthOfSums({ originalValueVnd: sumOf(sums, 'original_value'), approvedDeltaVnd: sumOf(sums, 'change_delta') }));
      ledger('accepted_vnd', sumOf(sums, 'accepted'));
      ledger('paid_vnd', sumOf(sums, 'paid'));
      if (ledgerless) put('paid_to_accepted_pct', null, LEDGER_NA);
      else indicator('paid_to_accepted_pct', paidToAcceptedOfSums(payments));
      put('days_late', sums.max_days_late === null ? null : Number(sums.max_days_late), 'NO_ROWS');
      break;
    }
    case 'schedule-delay': {
      put('approved_extension_days', Number(sumOf(sums, 'extension_days')));
      put('days_late', sums.max_days_late === null ? null : Number(sums.max_days_late), 'NO_ROWS');
      put('milestone_count', Number(sumOf(sums, 'milestones')));
      put('milestone_past_due_count', Number(sumOf(sums, 'milestones_past_due')));
      break;
    }
    case 'payment-three-way': {
      ledger('requested_vnd', payments.requestedVnd);
      ledger('measured_vnd', sumOf(sums, 'measured'));
      ledger('accepted_vnd', payments.acceptedVnd);
      ledger('paid_vnd', payments.paidVnd);
      if (ledgerless) {
        put('accepted_to_requested_pct', null, LEDGER_NA);
        put('paid_to_accepted_pct', null, LEDGER_NA);
      } else {
        indicator('accepted_to_requested_pct', acceptedToRequestedOfSums(payments));
        indicator('paid_to_accepted_pct', paidToAcceptedOfSums(payments));
      }
      put('acceptance_to_request_days_max', sums.max_acceptance_to_request === null ? null : Number(sums.max_acceptance_to_request), 'NO_PAYMENT');
      put('request_to_treasury_days_max', sums.max_request_to_treasury === null ? null : Number(sums.max_request_to_treasury), 'NO_PAYMENT');
      break;
    }
    case 'advance-ageing': {
      const advance = { advancePaidVnd: sumOf(sums, 'advance_paid'), advanceRecoveredVnd: sumOf(sums, 'advance_recovered'), rows: Number(sumOf(sums, 'advance_rows')) };
      ledger('advance_paid_vnd', advance.advancePaidVnd);
      ledger('advance_recovered_vnd', advance.advanceRecoveredVnd);
      const outstanding = advanceOutstandingOfSums(advance);
      ledger('advance_outstanding_vnd', outstanding.value);
      if (ledgerless) put('advance_outstanding_pct', null, LEDGER_NA);
      else indicator('advance_outstanding_pct', advanceOutstandingRatioOfSums(advance));
      put('age_days', sums.max_age_days === null ? null : Number(sums.max_age_days), 'NO_ADVANCE');
      break;
    }
    case 'retention-guarantee': {
      const retention = { retentionWithheldVnd: sumOf(sums, 'retention_withheld'), retentionReleasedVnd: sumOf(sums, 'retention_released'), rows: Number(sumOf(sums, 'retention_rows')) };
      ledger('retention_withheld_vnd', retention.retentionWithheldVnd);
      ledger('retention_released_vnd', retention.retentionReleasedVnd);
      ledger('retention_held_vnd', retentionHeldOfSums(retention).value);
      if (ledgerless) put('retention_released_pct', null, LEDGER_NA);
      else indicator('retention_released_pct', retentionReleasedRatioOfSums(retention));
      const guarantee = { requiredVnd: sumOf(sums, 'guarantee_required'), validVnd: sumOf(sums, 'guarantee_valid'), rows: Number(sumOf(sums, 'guarantee_rows')) };
      put('guarantee_required_vnd', guarantee.requiredVnd);
      put('guarantee_valid_vnd', guarantee.validVnd);
      indicator('guarantee_coverage_pct', guaranteeCoverageOfSums(guarantee));
      put('guarantee_exposure_vnd', (BigInt(guarantee.requiredVnd) - BigInt(guarantee.validVnd)).toString());
      break;
    }
    case 'change-growth': {
      put('original_value_vnd', sumOf(sums, 'original_value'));
      put('approved_change_delta_vnd', sumOf(sums, 'change_delta'));
      indicator('change_growth_pct', changeGrowthOfSums({ originalValueVnd: sumOf(sums, 'original_value'), approvedDeltaVnd: sumOf(sums, 'change_delta') }));
      put('approved_change_count', Number(sumOf(sums, 'change_count')));
      put('max_change_tier', sums.max_tier === null ? null : Number(sums.max_tier), 'NO_ROWS');
      put('max_cumulative_variation_pct', sums.max_cumulative_variation, 'NO_ROWS');
      break;
    }
  }
  return { rows: sums.rows, ledgerRows: sums.ledgerRows, cells, na, indicators };
}

// ---- the concentration and load of the contractors (R14) --------------------------------------------------------------------------------------------------------

/** What the reader of the report is told about the concentration of the portfolio, with the thresholds of the rule `CONTRACT_CONCENTRATION` that judged it. */
export interface ConcentrationParams {
  basis: 'CONTRACT_VALUE' | 'CONTRACT_COUNT';
  top_n: number;
  top_share_amber_pct: number;
  top_share_red_pct: number;
  hhi_amber: number;
  hhi_red: number;
  single_bidder_amber_pct: number;
  single_bidder_red_pct: number;
  min_contracts: number;
}

export const concentrationDefaults = (): ConcentrationParams => ({
  basis: 'CONTRACT_VALUE',
  top_n: DEFAULT_TOP_N,
  top_share_amber_pct: 50,
  top_share_red_pct: 70,
  hhi_amber: 1000,
  hhi_red: 1800,
  single_bidder_amber_pct: 20,
  single_bidder_red_pct: 40,
  min_contracts: 10,
});

export type ConcentrationLevel = 'GREEN' | 'AMBER' | 'RED' | 'NOT_ENOUGH_DATA';

/** A contract of the ACTIVE portfolio as the concentration reads it. */
export interface ConcentrationInput {
  id: string;
  status: string;
  valueVnd: string;
  investorKey: string | null;
  unitKey: string | null;
  fundKey: string | null;
  contractorId: string | null;
  parties?: readonly ContractPartyShare[] | undefined;
  bidderCount: number | null;
}

export interface ConcentrationDimensionReport {
  dimension: ConcentrationDimension;
  topN: number;
  totalVnd: string;
  groups: Array<{ key: string; valueVnd: string; sharePct: string }>;
  top: IndicatorResult;
  hhi: IndicatorResult;
  level: ConcentrationLevel;
  shareAnomalies: string[];
}

export interface ConcentrationReport {
  params: ConcentrationParams;
  activeContracts: number;
  dimensions: ConcentrationDimensionReport[];
  singleBidder: IndicatorResult;
  singleBidderLevel: ConcentrationLevel;
  activeValueVnd: string;
}

const levelAgainst = (value: string | null, amber: number, red: number): ConcentrationLevel => {
  if (value === null) return 'NOT_ENOUGH_DATA';
  const at = Math.round(Number(value) * 100);
  return at >= Math.round(red * 100) ? 'RED' : at >= Math.round(amber * 100) ? 'AMBER' : 'GREEN';
};

const WORSE: Record<ConcentrationLevel, number> = { NOT_ENOUGH_DATA: -1, GREEN: 0, AMBER: 1, RED: 2 };

/**
 * The concentration of the ACTIVE portfolio (R14): the share of the N largest groups and the HHI per investor, unit, fund and contractor, the single-bidder rate, judged by the thresholds of the rule. A group is judged
 * only when there are at least `min_contracts` active contracts: a handful of contracts is always concentrated and saying so teaches nothing. The value of a joint venture is attributed to its parties by their shares.
 */
export function concentrationReport(inputs: readonly ConcentrationInput[], params: ConcentrationParams = concentrationDefaults()): ConcentrationReport {
  const active = inputs.filter((input) => input.status === 'ACTIVE');
  const enough = active.length >= params.min_contracts;
  const rows = inputs.map((input) => ({ contractId: input.id, status: input.status, valueVnd: params.basis === 'CONTRACT_COUNT' ? '1000000' : input.valueVnd, investorKey: input.investorKey, unitKey: input.unitKey, fundKey: input.fundKey, contractorId: input.contractorId, parties: input.parties }));
  const dimensions = (['investor', 'unit', 'fund', 'contractor'] as const).map((dimension): ConcentrationDimensionReport => {
    const found = concentrationOf(rows, dimension, params.top_n);
    const topLevel = levelAgainst(found.top.value, params.top_share_amber_pct, params.top_share_red_pct);
    const hhiLevel = levelAgainst(found.hhi.value, params.hhi_amber, params.hhi_red);
    const level = !enough ? 'NOT_ENOUGH_DATA' : WORSE[topLevel] >= WORSE[hhiLevel] ? topLevel : hhiLevel;
    return { dimension, topN: found.topN, totalVnd: found.totalVnd, groups: found.groups, top: found.top, hhi: found.hhi, level, shareAnomalies: found.shareAnomalies };
  });
  const known = active.filter((input) => input.bidderCount !== null);
  const singleBidder = singleBidderRateOfCounts({ single: known.filter((input) => input.bidderCount === 1).length, known: known.length });
  return {
    params,
    activeContracts: active.length,
    dimensions,
    singleBidder,
    singleBidderLevel: !enough ? 'NOT_ENOUGH_DATA' : levelAgainst(singleBidder.value, params.single_bidder_amber_pct, params.single_bidder_red_pct),
    activeValueVnd: active.reduce((acc, input) => acc + big(input.valueVnd), 0n).toString(),
  };
}

// ---- the file of a report ------------------------------------------------------------------------------------------------------------------------------------------

export interface ReportDocumentInput {
  code: CtrReportCode;
  scopeDescription: string;
  /** The period the figures are of: the code of the period of a frozen snapshot, or the as-of day for a live reading. */
  periodLabel: string;
  asOf: string;
  /** The cut-off day of the frozen snapshot, or '' for a live reading. */
  cutoffDate: string;
  snapshotId: string;
  snapshotRevision: string;
  stale: boolean;
  generatedAt: Date;
  filterText: string;
  columns: readonly ReportColumn[];
  rows: readonly ReportRow[];
  totals: ReportTotals | null;
  /** The rows that do not belong to the totals line (the groups of a concentration report). */
  extraNotice?: string | null;
}

const cellText = (value: CellValue): string => (value === null ? '' : String(value));

/** The document of a report for CSV, XLSX and PDF: the header says what the figures are (scope, period, cut-off day, unit, freshness), the table has a totals row, a figure that is not there is an empty cell and its reason is written in the row after the totals. */
export function reportDocumentOf(input: ReportDocumentInput): ExportDocument {
  const entry = (key: string, text: string): ExportHeaderEntry => ({ key, label: message(`ctr.report.header.${key}`), value: text });
  const columns: ExportColumn[] = input.columns.map((column) => ({ key: column.key, label: message(`ctr.report.column.${column.key}`), numeric: column.kind !== 'TEXT' && column.kind !== 'DATE' && column.kind !== 'RAG' }));
  const rows = input.rows.map((row) => input.columns.map((column) => cellText(row.cells[column.key] ?? null)));
  if (input.totals !== null) {
    const totals = input.totals;
    rows.push(input.columns.map((column, index) => (index === 0 ? message('ctr.report.total_label') : column.total === null ? '' : cellText(totals.cells[column.key] ?? null))));
  }
  return {
    title: message(`ctr.report.title.${input.code}`),
    header: [
      entry('report', `${REPORT_CATALOGUE[input.code].ref} ${message(`ctr.report.title.${input.code}`)}`),
      entry('scope', input.scopeDescription),
      entry('period', input.periodLabel),
      entry('as_of', input.asOf),
      entry('cutoff_date', input.cutoffDate),
      entry('currency_unit', 'VND'),
      entry('snapshot_id', input.snapshotId),
      entry('snapshot_revision', input.snapshotRevision),
      entry('freshness', message(input.stale ? 'ctr.report.freshness.stale' : input.snapshotId === '' ? 'ctr.report.freshness.live' : 'ctr.report.freshness.latest')),
      entry('filters', input.filterText),
      entry('generated_at', input.generatedAt.toISOString()),
      entry('row_count', String(input.rows.length)),
    ],
    columns,
    rows,
    notice: input.extraNotice ?? null,
  };
}

/** The meaning of an indicator for the "i" of a screen and the footnote of a file. */
export const indicatorDefinition = (code: IndicatorCode): (typeof CTR_INDICATORS)[IndicatorCode] => CTR_INDICATORS[code];

// ---- the load of a contractor (R14) ------------------------------------------------------------------------------------------------------------------------------

export interface ContractorLoad {
  contractorId: string;
  /** The ACTIVE contracts the contractor is a party to (a joint venture counts for each of its parties). */
  activeContracts: number;
  /** Its share of the value of the ACTIVE contracts (joint ventures by `share_pct`), whole dong. */
  activeValueVnd: string;
  sharePct: string;
  /** What was awarded to it and has no contract yet (the load that is coming), whole dong. */
  pendingAwardVnd: string;
}

/** The load of each contractor: its active contracts and value (the same attribution as the concentration) and what is awarded and not yet contracted. Largest value first, then by key, so that the order is the same on every run. */
export function contractorLoadOf(inputs: readonly ConcentrationInput[], pendingAwards: ReadonlyMap<string, string>): ContractorLoad[] {
  const active = inputs.filter((input) => input.status === 'ACTIVE');
  const rows = active.map((input) => ({ contractId: input.id, status: input.status, valueVnd: input.valueVnd, investorKey: null, unitKey: null, fundKey: null, contractorId: input.contractorId, parties: input.parties }));
  const found = concentrationOf(rows, 'contractor', 1000);
  const counts = new Map<string, number>();
  for (const input of active) {
    const keys = new Set((input.parties ?? []).filter((party) => party.status === 'ACTIVE').map((party) => party.contractorId));
    if (keys.size === 0) keys.add(input.contractorId ?? '(none)');
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const loads = new Map<string, ContractorLoad>();
  for (const group of found.groups) loads.set(group.key, { contractorId: group.key, activeContracts: counts.get(group.key) ?? 0, activeValueVnd: group.valueVnd, sharePct: group.sharePct, pendingAwardVnd: pendingAwards.get(group.key) ?? '0' });
  // A contractor with an award and no active contract is load that is coming: it is listed, with no active value.
  for (const [key, pending] of pendingAwards) if (!loads.has(key)) loads.set(key, { contractorId: key, activeContracts: 0, activeValueVnd: '0', sharePct: '0.00', pendingAwardVnd: pending });
  return [...loads.values()].sort((a, b) => (BigInt(a.activeValueVnd) === BigInt(b.activeValueVnd) ? (a.contractorId < b.contractorId ? -1 : a.contractorId > b.contractorId ? 1 : 0) : BigInt(a.activeValueVnd) > BigInt(b.activeValueVnd) ? -1 : 1));
}

/** The document of the concentration report: one block of groups per dimension, each followed by its top-N share, its HHI and its level; the single-bidder rate last. */
export function concentrationDocumentOf(
  report: ConcentrationReport,
  base: Omit<ReportDocumentInput, 'code' | 'columns' | 'rows' | 'totals' | 'extraNotice'>,
  names: ReadonlyMap<string, string>,
): ExportDocument {
  const columns: ExportColumn[] = ['dimension', 'group_key', 'group_name', 'value_vnd', 'share_pct'].map((key) => ({ key, label: message(`ctr.report.column.${key}`), numeric: key === 'value_vnd' || key === 'share_pct' }));
  const rows: string[][] = [];
  for (const dimension of report.dimensions) {
    for (const group of dimension.groups) rows.push([dimension.dimension, group.key, names.get(group.key) ?? '', group.valueVnd, group.sharePct]);
    rows.push([dimension.dimension, 'TOP_N_SHARE', message('ctr.report.concentration.top_share', { n: dimension.topN }), dimension.top.numerator ?? '', dimension.top.value ?? '']);
    rows.push([dimension.dimension, 'HHI', message('ctr.report.concentration.hhi'), '', dimension.hhi.value ?? '']);
    rows.push([dimension.dimension, 'LEVEL', message(`ctr.report.concentration.level.${dimension.level}`), '', '']);
  }
  rows.push(['all', 'SINGLE_BIDDER_RATE', message('ctr.report.concentration.single_bidder'), report.singleBidder.numerator ?? '', report.singleBidder.value ?? '']);
  const document = reportDocumentOf({ ...base, code: 'contractor-concentration', columns: [], rows: [], totals: null });
  return { ...document, columns, rows, notice: message('ctr.report.concentration.notice', { amber: report.params.top_share_amber_pct, red: report.params.top_share_red_pct, hhiAmber: report.params.hhi_amber, hhiRed: report.params.hhi_red }) };
}

// ---- the words of the context of a report -----------------------------------------------------------------------------------------------------------------------

/** The scope line of a file: the whole tenant, or what the reader was granted. */
export const reportScopeDescription = (province: boolean): string => message(province ? 'ctr.report.scope.province' : 'ctr.report.scope.granted');

/** The filters of a request as a line of the header of a file ("none" when there are none). */
export function reportFilterText(filters: Readonly<Record<string, string | readonly string[] | undefined>>): string {
  const parts = Object.entries(filters)
    .filter(([, value]) => value !== undefined && (typeof value === 'string' ? value !== '' : value.length > 0))
    .map(([key, value]) => `${message(`ctr.report.filter.${key}`)}: ${typeof value === 'string' ? value : (value as readonly string[]).join(', ')}`);
  return parts.length === 0 ? message('ctr.report.filter.none') : parts.join('; ');
}
