/**
 * The judgements of the four alert sources that GOV-10 adds to the alert centre (roadmap G2-12): the clocks of a contract (K07), the review of a document that is due (K16), the freshness of a dataset (B8) and the
 * anomalies of the money (B4). Everything here is pure: the database side reads the facts, the thresholds come from the governance rules (`CONTRACT_CLOCK_RULE`, `DOC_REVIEW_RULE`, `DATA_FRESHNESS_RULE`,
 * `ANOMALY_RULE`, and the payment clock that already exists as `CONTRACT_PAYMENT_CLOCK`), and a finding says what was found, never why. An anomaly is a hint to look, not a conclusion.
 */

export const CONTRACT_CLOCK_RULE_TYPE = 'CONTRACT_CLOCK_RULE';
export const DOC_REVIEW_RULE_TYPE = 'DOC_REVIEW_RULE';
export const DATA_FRESHNESS_RULE_TYPE = 'DATA_FRESHNESS_RULE';
export const ANOMALY_RULE_TYPE = 'ANOMALY_RULE';

export type AlertSeverityWord = 'URGENT' | 'ACTION' | 'WATCH';

// -- the clocks of a contract ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ContractClockParams {
  /** How many calendar days before the end of the contract (its due date moved by the approved extensions) the end is shown. */
  end_warning_days: number;
  /** From this many days before the end the end is urgent; a contract past its end is always urgent. */
  end_urgent_days: number;
}

export const contractClockDefaults = (): ContractClockParams => ({ end_warning_days: 30, end_urgent_days: 7 });

export type ContractClockFacet = 'END_NEAR' | 'END_PASSED' | 'PAYMENT_UNREQUESTED';

export interface ContractClockFact {
  contractStatus: string;
  /** The due date of the contract and the days the approved changes moved it by. */
  dueDate: string | null;
  extensionDays: number;
  completedOn: string | null;
  /** Whole dong as text. */
  acceptedVnd: string | null;
  requestedVnd: string | null;
  lastAcceptanceOn: string | null;
}

export interface ContractClockFinding {
  facet: ContractClockFacet;
  /** The day the clock runs to (the end of the contract), or the day the request of payment was due. */
  dueOn: string;
  /** Days to the day above: negative once it is past. */
  daysLeft: number;
  severity: AlertSeverityWord;
}

const DAY_MS = 86_400_000;
const addCalendarDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The day a contract ends: its due date moved by the days the approved changes added. */
export const contractEndOn = (dueDate: string, extensionDays: number): string => addCalendarDays(dueDate, extensionDays);

const big = (value: string | null): bigint => {
  if (value === null || !/^-?\d+$/.test(value)) return 0n;
  return BigInt(value);
};

/**
 * What the clocks of one running contract say on `today` (a contract that is not active has no clock): its end is near or has passed, and an acceptance that is approved and not yet asked for payment for longer than the
 * payment clock allows (the number is the `acceptance_to_request_days` of `CONTRACT_PAYMENT_CLOCK`, so that one definition serves the report and this alert).
 */
export function contractClockFindings(fact: ContractClockFact, today: string, params: ContractClockParams, acceptanceToRequestDays: number): ContractClockFinding[] {
  if (fact.contractStatus !== 'ACTIVE') return [];
  const findings: ContractClockFinding[] = [];
  if (fact.dueDate !== null && fact.completedOn === null) {
    const end = contractEndOn(fact.dueDate, fact.extensionDays);
    const left = daysBetween(today, end);
    if (left < 0) findings.push({ facet: 'END_PASSED', dueOn: end, daysLeft: left, severity: 'URGENT' });
    else if (left <= params.end_warning_days) findings.push({ facet: 'END_NEAR', dueOn: end, daysLeft: left, severity: left <= params.end_urgent_days ? 'URGENT' : 'WATCH' });
  }
  if (fact.lastAcceptanceOn !== null && big(fact.acceptedVnd) > big(fact.requestedVnd)) {
    const due = addCalendarDays(fact.lastAcceptanceOn, acceptanceToRequestDays);
    const left = daysBetween(today, due);
    if (left < 0) findings.push({ facet: 'PAYMENT_UNREQUESTED', dueOn: due, daysLeft: left, severity: 'ACTION' });
  }
  return findings;
}

// -- the review of a document ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DocReviewParams {
  /** How many days before the review day a document that waits for review is shown. */
  warning_days: number;
}

export const docReviewDefaults = (): DocReviewParams => ({ warning_days: 2 });

export type DocReviewFacet = 'OVERDUE' | 'DUE_SOON';

/** A document that waits for review (in review or submitted) against its review day: past it, or within the warning days; no review day, no clock. */
export function docReviewFacet(reviewDueOn: string | null, today: string, params: DocReviewParams): DocReviewFacet | null {
  if (reviewDueOn === null) return null;
  const left = daysBetween(today, reviewDueOn);
  if (left < 0) return 'OVERDUE';
  return left <= params.warning_days ? 'DUE_SOON' : null;
}

// -- the freshness of a dataset -------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DataFreshnessParams {
  stale_severity: AlertSeverityWord;
  /** A critical dataset that was never assessed is an alert too (a dataset that was never looked at is not "fresh"). */
  flag_never_assessed_critical: boolean;
}

export const dataFreshnessDefaults = (): DataFreshnessParams => ({ stale_severity: 'ACTION', flag_never_assessed_critical: true });

export type DataFreshnessFacet = 'STALE' | 'NEVER_ASSESSED';

/** The badge of the dataset (the one definition of BR-DGV-04: NOT_ASSESSED without a finished run, STALE when the last run is older than the freshness the dataset promises) against the rule. */
export function dataFreshnessFacet(badge: string, critical: boolean, params: DataFreshnessParams): DataFreshnessFacet | null {
  if (badge === 'STALE') return 'STALE';
  if (badge === 'NOT_ASSESSED' && critical && params.flag_never_assessed_critical) return 'NEVER_ASSESSED';
  return null;
}

// -- the anomalies of the money -------------------------------------------------------------------------------------------------------------------------------------------------------------

export const ANOMALY_CODES = ['PERIOD_END_RUSH', 'ADVANCE_WHILE_OPEN', 'REPEATED_REALLOCATION'] as const;
export type AnomalyCode = (typeof ANOMALY_CODES)[number];

export interface AnomalyParams {
  indicator: string;
  window_days?: number;
  threshold_pct?: number;
  threshold_count?: number;
  /** Whole dong as text: a smaller amount is not looked at. */
  min_amount_vnd?: string;
  severity: AlertSeverityWord;
  enabled: boolean;
}

/** Disbursement that is pressed into the last days of the plan year: the share of the year's payments that went to the Treasury inside the window, once the payments of the year reach the minimum. */
export function periodEndRush(input: { paidInWindowVnd: string; paidInYearVnd: string }, params: Pick<AnomalyParams, 'threshold_pct' | 'min_amount_vnd'>): { share: number } | null {
  const year = big(input.paidInYearVnd);
  if (year <= 0n || year < big(params.min_amount_vnd ?? '0')) return null;
  const share = Number((big(input.paidInWindowVnd) * 10_000n) / year) / 100;
  return share >= (params.threshold_pct ?? 50) ? { share } : null;
}

/** An advance paid while an earlier advance of the same contract is not yet recovered: the open amount of the earlier one must reach the minimum. */
export function advanceWhileOpen(earlierOutstandingVnd: string, params: Pick<AnomalyParams, 'min_amount_vnd'>): boolean {
  const open = big(earlierOutstandingVnd);
  return open > 0n && open >= big(params.min_amount_vnd ?? '0');
}

/** The same unit and plan year adjusted again and again: the number of approved adjustments reaches the threshold. */
export const repeatedReallocation = (count: number, params: Pick<AnomalyParams, 'threshold_count'>): boolean => count >= (params.threshold_count ?? 3);

/** The first day a period-end window opens in a plan year (the last `windowDays` days of 31 December). */
export const periodEndWindowStart = (planYear: number, windowDays: number): string => addCalendarDays(`${planYear}-12-31`, -(windowDays - 1));
