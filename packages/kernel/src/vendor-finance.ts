import { DomainError } from './errors.ts';

/**
 * The financial standing of a contractor (VND-2, research V7) and its concurrent load (research V9); docs/vendor-controls.md sections 3 and 4. A period is the statements of one year as a person entered them from the
 * audited report (a second person verifies it against the paper). From it the kernel computes the ratios the evaluation of a package reads (current ratio, debt to assets, interest cover, average revenue) and
 * judges them against the thresholds of the rule `VENDOR_FINANCE` and against what the package asks (revenue as a multiple of the yearly value of the package). A joint venture is judged by the share each member holds.
 * The load compares the work the contractor already holds (open contracts, late ones, awards not yet signed) with its average revenue. Every result is a **signal with its figures**: the finding never rejects a bid
 * by itself; the evaluation panel records what it makes of it. Amounts are whole dong (safe integers), ratios have two decimals.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const VENDOR_FINANCE_RULE_TYPE = 'VENDOR_FINANCE';
export const VENDOR_CAPACITY_RULE_TYPE = 'VENDOR_CAPACITY';

/** The rule `VENDOR_FINANCE`; the ratios are held in hundredths (a current ratio of 1.25 is 125) so that the rule has integers only. */
export interface FinancePolicy {
  min_current_ratio_x100: number;
  max_debt_to_assets_pct: number;
  min_interest_cover_x100: number;
  /** The number of latest years the average revenue is taken over (a year without a verified period is not counted as zero: the average is over the years there are). */
  revenue_years: number;
  /** The average yearly revenue must be at least this multiple (in hundredths) of the yearly value of the package. */
  revenue_multiple_x100: number;
  /** The fewest verified years that make a judgment; fewer is INSUFFICIENT_DATA, never a pass. */
  min_verified_years: number;
}

export const FINANCE_POLICY_DEFAULTS: FinancePolicy = { min_current_ratio_x100: 100, max_debt_to_assets_pct: 80, min_interest_cover_x100: 150, revenue_years: 3, revenue_multiple_x100: 200, min_verified_years: 2 };

export function financePolicyOf(params: unknown): FinancePolicy {
  if (!isRecord(params)) throw invalid('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  return {
    min_current_ratio_x100: whole('min_current_ratio_x100', 0, 10_000),
    max_debt_to_assets_pct: whole('max_debt_to_assets_pct', 1, 1000),
    min_interest_cover_x100: whole('min_interest_cover_x100', 0, 100_000),
    revenue_years: whole('revenue_years', 1, 10),
    revenue_multiple_x100: whole('revenue_multiple_x100', 0, 10_000),
    min_verified_years: whole('min_verified_years', 1, 10),
  };
}

export interface FinancialPeriod {
  year: number;
  revenue: number;
  totalAssets: number;
  currentAssets: number;
  currentLiabilities: number;
  totalDebt: number;
  equity: number;
  ebit: number;
  interestExpense: number;
  /** A person other than the one who entered it checked it against the paper. */
  verified: boolean;
}

/** Checks one period as it is entered: a real year, whole non-negative amounts (EBIT may be negative), current assets not above total assets, no number past the safe range. */
export function assertFinancialPeriod(period: Omit<FinancialPeriod, 'verified'>): void {
  if (!Number.isInteger(period.year) || period.year < 1990 || period.year > 2200) throw invalid('fiscal_year');
  const nonNegative: Array<[string, number]> = [['revenue', period.revenue], ['total_assets', period.totalAssets], ['current_assets', period.currentAssets], ['current_liabilities', period.currentLiabilities], ['total_debt', period.totalDebt], ['interest_expense', period.interestExpense]];
  for (const [field, value] of nonNegative) if (!Number.isSafeInteger(value) || value < 0) throw invalid(field);
  if (!Number.isSafeInteger(period.equity)) throw invalid('equity');
  if (!Number.isSafeInteger(period.ebit)) throw invalid('ebit');
  if (period.currentAssets > period.totalAssets) throw invalid('current_assets');
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface Ratios {
  /** Current assets over current liabilities; null when there are no current liabilities (nothing to cover). */
  currentRatio: number | null;
  /** Total debt over total assets, in percent; null when there are no assets. */
  debtToAssetsPct: number | null;
  /** EBIT over interest expense; null when there is no interest (the cover is not limited). */
  interestCover: number | null;
  equityToAssetsPct: number | null;
}

export function ratiosOf(period: FinancialPeriod): Ratios {
  return {
    currentRatio: period.currentLiabilities === 0 ? null : round2(period.currentAssets / period.currentLiabilities),
    debtToAssetsPct: period.totalAssets === 0 ? null : round2((period.totalDebt * 100) / period.totalAssets),
    interestCover: period.interestExpense === 0 ? null : round2(period.ebit / period.interestExpense),
    equityToAssetsPct: period.totalAssets === 0 ? null : round2((period.equity * 100) / period.totalAssets),
  };
}

/** The periods that count: verified ones, the latest `years` distinct years, latest first. */
export function countedPeriods(periods: readonly FinancialPeriod[], years: number): FinancialPeriod[] {
  const byYear = new Map<number, FinancialPeriod>();
  for (const one of periods) if (one.verified) byYear.set(one.year, one);
  return [...byYear.values()].sort((a, b) => b.year - a.year).slice(0, years);
}

/** Average revenue over the periods that count; null when there is none. */
export function averageRevenue(periods: readonly FinancialPeriod[], years: number): number | null {
  const counted = countedPeriods(periods, years);
  return counted.length === 0 ? null : Math.round(counted.reduce((sum, one) => sum + one.revenue, 0) / counted.length);
}

export const FINANCE_TESTS = ['CURRENT_RATIO', 'DEBT_TO_ASSETS', 'INTEREST_COVER', 'AVERAGE_REVENUE'] as const;
export type FinanceTest = (typeof FINANCE_TESTS)[number];
export type FinanceStatus = 'PASS' | 'FAIL' | 'NO_DATA';

export interface FinanceResult {
  test: FinanceTest;
  status: FinanceStatus;
  /** The figure judged (ratio, percent or amount), null when it cannot be computed. */
  value: number | null;
  /** The line it was judged against, in the unit of the figure. */
  threshold: number | null;
  /** The year of the period the ratio was taken from; null for the average. */
  year: number | null;
}

export interface FinanceRequirement {
  /** The value of the package and the months it lasts: the yearly value is value * 12 / months. */
  packageValue: number;
  durationMonths: number;
}

export interface FinanceAssessment {
  results: FinanceResult[];
  /** MEETS: every test passes; BELOW: one fails; INSUFFICIENT_DATA: fewer verified years than the rule asks (never a pass). */
  overall: 'MEETS' | 'BELOW' | 'INSUFFICIENT_DATA';
  verifiedYears: number;
  averageRevenue: number | null;
  requiredRevenue: number | null;
}

/** The yearly value of a package: value over its duration in years (a package of under a month counts as a month). */
export const yearlyValue = (requirement: FinanceRequirement): number => Math.round((requirement.packageValue * 12) / Math.max(1, requirement.durationMonths));

/**
 * Judges the latest verified period against the ratios of the rule and the average revenue against the requirement of the package (when it has one). The ratios come from the latest period that counts; a test whose
 * figure cannot be computed (no liabilities, no interest) passes by being unlimited, and a test with no period is NO_DATA.
 */
export function assessFinance(periods: readonly FinancialPeriod[], policy: FinancePolicy, requirement: FinanceRequirement | null): FinanceAssessment {
  const counted = countedPeriods(periods, policy.revenue_years);
  const latest = counted[0];
  const results: FinanceResult[] = [];
  if (latest === undefined) {
    for (const test of FINANCE_TESTS) results.push({ test, status: 'NO_DATA', value: null, threshold: null, year: null });
    return { results, overall: 'INSUFFICIENT_DATA', verifiedYears: 0, averageRevenue: null, requiredRevenue: requirement === null ? null : Math.round((yearlyValue(requirement) * policy.revenue_multiple_x100) / 100) };
  }
  const ratios = ratiosOf(latest);
  const minCurrent = policy.min_current_ratio_x100 / 100;
  results.push({ test: 'CURRENT_RATIO', status: ratios.currentRatio === null || ratios.currentRatio >= minCurrent ? 'PASS' : 'FAIL', value: ratios.currentRatio, threshold: minCurrent, year: latest.year });
  results.push({ test: 'DEBT_TO_ASSETS', status: ratios.debtToAssetsPct === null ? 'NO_DATA' : ratios.debtToAssetsPct <= policy.max_debt_to_assets_pct ? 'PASS' : 'FAIL', value: ratios.debtToAssetsPct, threshold: policy.max_debt_to_assets_pct, year: latest.year });
  const minCover = policy.min_interest_cover_x100 / 100;
  results.push({ test: 'INTEREST_COVER', status: ratios.interestCover === null || ratios.interestCover >= minCover ? 'PASS' : 'FAIL', value: ratios.interestCover, threshold: minCover, year: latest.year });
  const average = averageRevenue(periods, policy.revenue_years);
  const required = requirement === null ? null : Math.round((yearlyValue(requirement) * policy.revenue_multiple_x100) / 100);
  results.push({ test: 'AVERAGE_REVENUE', status: required === null ? 'NO_DATA' : average !== null && average >= required ? 'PASS' : 'FAIL', value: average, threshold: required, year: null });
  const failed = results.some((one) => one.status === 'FAIL');
  const overall = counted.length < policy.min_verified_years ? 'INSUFFICIENT_DATA' : failed ? 'BELOW' : 'MEETS';
  return { results, overall, verifiedYears: counted.length, averageRevenue: average, requiredRevenue: required };
}

export interface VentureMember {
  /** Percent of the venture the member holds (0 to 100, two decimals). */
  sharePct: number;
  periods: readonly FinancialPeriod[];
}

/**
 * The periods of a joint venture: each year that every member has verified, with each figure the sum of the share of each member (a member holding 40 percent brings 40 percent of its revenue and balance sheet). The shares
 * must add up to 100; the ratios are then computed on the combined figures, not averaged.
 */
export function ventureFinance(members: readonly VentureMember[]): FinancialPeriod[] {
  const total = members.reduce((sum, one) => sum + Math.round(one.sharePct * 100), 0);
  if (members.length === 0 || total !== 10_000) throw invalid('share_pct');
  const years = members.map((one) => new Set(one.periods.filter((p) => p.verified).map((p) => p.year)));
  const common = [...(years[0] ?? new Set<number>())].filter((year) => years.every((set) => set.has(year)));
  return common
    .sort((a, b) => b - a)
    .map((year): FinancialPeriod => {
      const share = (pick: (period: FinancialPeriod) => number): number =>
        Math.round(members.reduce((sum, one) => sum + (pick(one.periods.find((p) => p.year === year && p.verified) as FinancialPeriod) * Math.round(one.sharePct * 100)) / 10_000, 0));
      return { year, revenue: share((p) => p.revenue), totalAssets: share((p) => p.totalAssets), currentAssets: share((p) => p.currentAssets), currentLiabilities: share((p) => p.currentLiabilities), totalDebt: share((p) => p.totalDebt), equity: share((p) => p.equity), ebit: share((p) => p.ebit), interestExpense: share((p) => p.interestExpense), verified: true };
    });
}

// -- Load (V9) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The rule `VENDOR_CAPACITY`: the load (open contracts plus awards not yet signed) may be at most this multiple (in hundredths) of the average yearly revenue, and at most so many contracts may be late. */
export interface CapacityPolicy {
  max_load_multiple_x100: number;
  max_late_contracts: number;
  /** Awards not yet signed count in the load at this percent of their value (the chance they will be signed is not zero). */
  pending_award_weight_pct: number;
}

export const CAPACITY_POLICY_DEFAULTS: CapacityPolicy = { max_load_multiple_x100: 300, max_late_contracts: 2, pending_award_weight_pct: 100 };

export function capacityPolicyOf(params: unknown): CapacityPolicy {
  if (!isRecord(params)) throw invalid('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  return { max_load_multiple_x100: whole('max_load_multiple_x100', 10, 100_000), max_late_contracts: whole('max_late_contracts', 0, 1000), pending_award_weight_pct: whole('pending_award_weight_pct', 0, 100) };
}

export interface CapacityFacts {
  /** The remaining value of contracts that are signed, active or suspended (value not yet accepted). */
  openContractValue: number;
  openContractCount: number;
  /** Contracts past their end day or with a late milestone, as the contract module counts them. */
  lateContractCount: number;
  /** The value of packages awarded to the contractor and not yet signed. */
  pendingAwardValue: number;
  pendingAwardCount: number;
  averageAnnualRevenue: number | null;
}

export const CAPACITY_SIGNALS = ['LOAD_OVER_REVENUE', 'LATE_CONTRACTS', 'NO_REVENUE_DATA'] as const;
export type CapacitySignal = (typeof CAPACITY_SIGNALS)[number];

export interface CapacityAssessment {
  /** Open work plus the weighted awards not yet signed. */
  load: number;
  /** Load over average yearly revenue, two decimals; null when there is no revenue to compare with. */
  loadMultiple: number | null;
  limitMultiple: number;
  signals: CapacitySignal[];
  status: 'WITHIN' | 'OVER' | 'NO_DATA';
}

/** The load of a contractor against its capacity; the status is a signal for the panel (`OVER` when a limit is passed), `NO_DATA` when there is no revenue to compare with and nothing else is over. */
export function assessCapacity(facts: CapacityFacts, policy: CapacityPolicy): CapacityAssessment {
  const load = facts.openContractValue + Math.round((facts.pendingAwardValue * policy.pending_award_weight_pct) / 100);
  const revenue = facts.averageAnnualRevenue;
  const multiple = revenue === null || revenue === 0 ? null : round2(load / revenue);
  const signals: CapacitySignal[] = [];
  if (multiple === null) signals.push('NO_REVENUE_DATA');
  else if (multiple > policy.max_load_multiple_x100 / 100) signals.push('LOAD_OVER_REVENUE');
  if (facts.lateContractCount > policy.max_late_contracts) signals.push('LATE_CONTRACTS');
  const over = signals.some((one) => one !== 'NO_REVENUE_DATA');
  return { load, loadMultiple: multiple, limitMultiple: policy.max_load_multiple_x100 / 100, signals, status: over ? 'OVER' : multiple === null ? 'NO_DATA' : 'WITHIN' };
}
