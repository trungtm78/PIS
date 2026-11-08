import { DomainError } from './errors.ts';

/**
 * The directive milestones of the disbursement and the accuracy of the forecasts behind them (roadmap G1-16, DIS 3 F8): where the year-end estimate of `dis-forecast.ts` stands against the
 * cumulative targets the Government sets for dates of the year (30/6, 30/9, 31/12 are the starting values, a directive adds its own), and how well the forecasts of each investor
 * foretold what the Treasury then paid. Everything is pure: the estimate months, the actuals and the rules come in as arguments, amounts are whole dong in strings, percents are
 * computed from whole numbers (half up, two decimals) and never from floats. The numbers of the rules are starting values of the research, flagged unverified until the tenant approves its own.
 */

export const MILESTONE_RULE_TYPE = 'DISBURSEMENT_MILESTONES';
export const ACCURACY_RULE_TYPE = 'DISBURSEMENT_FORECAST_ACCURACY';
export const MILESTONE_RULE_CODE = 'DEFAULT';
export const ACCURACY_RULE_CODE = 'DEFAULT';
/** The month after December that closes the year of the plan (the adjustment time); no milestone of a year counts it. */
const ADJUSTMENT_MONTH = 13;

export const MILESTONE_STATUSES = ['ACHIEVED', 'MISSED', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'NO_DATA'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
/** The statuses an alert is raised for: the projection is below the target. */
export const MILESTONE_ALERT_STATUSES: readonly MilestoneStatus[] = ['AT_RISK', 'OFF_TRACK'];
export const MILESTONE_COVERAGES = ['COMPLETE', 'PARTIAL', 'NONE'] as const;
export type MilestoneCoverage = (typeof MILESTONE_COVERAGES)[number];
export const ACCURACY_BANDS = ['GOOD', 'FAIR', 'POOR', 'INSUFFICIENT'] as const;
export type AccuracyBand = (typeof ACCURACY_BANDS)[number];

export const MONTH_DAY_PATTERN = '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
const MONTH_DAY = new RegExp(MONTH_DAY_PATTERN);
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

// -- The rules ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface MilestoneDef {
  code: string;
  /** `MM-DD` in the plan year. */
  monthDay: string;
  /** The cumulative share of the plan the milestone asks for, 0 to 100, two decimals at most. */
  targetPct: number;
}

export interface MilestonePolicy {
  milestones: MilestoneDef[];
  /** A projection within this many points below the target is AT_RISK, further below is OFF_TRACK. */
  atRiskMarginPct: number;
  directiveRef: string | null;
}

/** The starting values: 30/6 half of the plan, 30/9 three quarters, 31/12 95 percent (research of the directives of the Government; the tenant approves its own, per directive when it likes). */
export function milestoneDefaults(): Record<string, unknown> {
  return {
    milestones: [
      { code: 'M_0630', month_day: '06-30', target_pct: 50 },
      { code: 'M_0930', month_day: '09-30', target_pct: 75 },
      { code: 'M_1231', month_day: '12-31', target_pct: 95 },
    ],
    at_risk_margin_pct: 5,
  };
}

const hundredths = (value: number): bigint => BigInt(Math.round(value * 100));

/** Whether `MM-DD` names a day that exists in some year (the 29th of February does). */
export function isMonthDay(value: unknown): value is string {
  if (typeof value !== 'string' || !MONTH_DAY.test(value)) return false;
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(3, 5));
  return day <= daysInMonth(2024, month);
}

/** The params of a `DISBURSEMENT_MILESTONES` rule, checked: codes are unique, days exist, the dates grow and so do the targets (a later date never asks for less). */
export function milestonePolicyOf(params: unknown): MilestonePolicy {
  if (!isRecord(params)) throw invalid('params');
  const list = params.milestones;
  if (!Array.isArray(list) || list.length === 0 || list.length > 12) throw invalid('milestones');
  const milestones: MilestoneDef[] = list.map((entry, index) => {
    if (!isRecord(entry)) throw invalid(`milestones[${index}]`);
    const { code, month_day: monthDay, target_pct: target } = entry;
    if (typeof code !== 'string' || !CODE.test(code)) throw invalid(`milestones[${index}].code`);
    if (!isMonthDay(monthDay)) throw invalid(`milestones[${index}].month_day`);
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0 || target > 100) throw invalid(`milestones[${index}].target_pct`);
    return { code, monthDay, targetPct: target };
  });
  if (new Set(milestones.map((entry) => entry.code)).size !== milestones.length) throw invalid('milestones');
  for (let index = 1; index < milestones.length; index += 1) {
    const before = milestones[index - 1] as MilestoneDef;
    const at = milestones[index] as MilestoneDef;
    if (at.monthDay <= before.monthDay) throw invalid(`milestones[${index}].month_day`);
    if (hundredths(at.targetPct) < hundredths(before.targetPct)) throw invalid(`milestones[${index}].target_pct`);
  }
  const margin = params.at_risk_margin_pct;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 50) throw invalid('at_risk_margin_pct');
  const directive = params.directive_ref;
  if (directive !== undefined && (typeof directive !== 'string' || directive.trim() === '' || directive.length > 200)) throw invalid('directive_ref');
  return { milestones, atRiskMarginPct: margin, directiveRef: typeof directive === 'string' ? directive : null };
}

export interface AccuracyPolicy {
  /** The forecast that counts is the last one made before the first day of the month `leadMonths - 1` months ahead of the month it is about (1: made before the month began). */
  leadMonths: number;
  /** An investor with fewer measured months than this is not given a band. */
  minMonths: number;
  /** Weighted absolute percentage error up to this is GOOD, up to `fairWapePct` is FAIR, above is POOR. */
  goodWapePct: number;
  fairWapePct: number;
  /** A project-month where both the forecast and the actual are below this is noise and is not measured. */
  minActualVnd: number;
  /** A bias (forecast minus actual over actual) at or above this share, in either direction, is called out. */
  biasFlagPct: number;
}

export function accuracyDefaults(): Record<string, unknown> {
  return { lead_months: 1, min_months: 3, good_wape_pct: 10, fair_wape_pct: 25, min_actual_vnd: 1_000_000, bias_flag_pct: 15 };
}

export function accuracyPolicyOf(params: unknown): AccuracyPolicy {
  if (!isRecord(params)) throw invalid('params');
  const int = (key: string, min: number, max: number): number => {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(key);
    return value;
  };
  const pct = (key: string): number => {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) throw invalid(key);
    return value;
  };
  const policy: AccuracyPolicy = {
    leadMonths: int('lead_months', 1, 6),
    minMonths: int('min_months', 1, 12),
    goodWapePct: pct('good_wape_pct'),
    fairWapePct: pct('fair_wape_pct'),
    minActualVnd: int('min_actual_vnd', 0, 1_000_000_000_000),
    biasFlagPct: pct('bias_flag_pct'),
  };
  if (policy.fairWapePct < policy.goodWapePct) throw invalid('fair_wape_pct');
  return policy;
}

// -- Percent arithmetic ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** `numerator / denominator` as a percent with two decimals, rounded half up, written `48.25`; null when the denominator is not positive. A negative numerator keeps its sign. */
export function percent2(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n;
  const top = negative ? -numerator : numerator;
  const hundredthsOfPercent = (top * 20000n + denominator) / (2n * denominator);
  const text = `${hundredthsOfPercent / 100n}.${(hundredthsOfPercent % 100n).toString().padStart(2, '0')}`;
  return negative && hundredthsOfPercent !== 0n ? `-${text}` : text;
}

export const pctText = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

// -- Cutoff and milestone dates -------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The month (1 to 12) of the cutoff in the plan year: 0 before the year began, 13 in the adjustment time after it. */
export function cutoffMonthOf(planYear: number, cutoffDate: string): number {
  const year = Number(cutoffDate.slice(0, 4));
  return year > planYear ? ADJUSTMENT_MONTH : year < planYear ? 0 : Number(cutoffDate.slice(5, 7));
}

export const milestoneDateOf = (planYear: number, monthDay: string): string => `${String(planYear).padStart(4, '0')}-${monthDay}`;

export interface MonthFigure {
  month: number;
  /** Null for a month that has neither a forecast nor a registration. */
  amountVnd: string | null;
  /** Every project the month adds up has a figure for it. */
  complete: boolean;
}

export interface MilestoneInput {
  planYear: number;
  milestone: MilestoneDef;
  atRiskMarginPct: number;
  /** The last day the Treasury figure of the snapshot counts. */
  cutoffDate: string;
  /** What the Treasury paid to the cutoff in the year; null when it booked nothing (no data is not zero). */
  disbursedVnd: string | null;
  planTotalVnd: string;
  /** The months after the cutoff month of the estimate (12 and below count; the adjustment month never does). */
  months: readonly MonthFigure[];
  /** What the Treasury paid up to the day of the milestone, for a milestone that is not after the cutoff; null when unknown. */
  actualToDateVnd: string | null;
}

export interface MilestoneReading {
  code: string;
  date: string;
  targetPct: string;
  /** The cumulative amount the target asks for. */
  targetVnd: string;
  /** What is expected to be paid by the day: the Treasury figure when the day is past, else the figure plus the months up to it. A lower bound when `coverage` is PARTIAL. */
  projectedVnd: string | null;
  projectedPct: string | null;
  /** The projection less the target, in points of the plan (negative: short). */
  gapPct: string | null;
  basis: 'ACTUAL' | 'FORECAST';
  coverage: MilestoneCoverage;
  status: MilestoneStatus;
}

/**
 * Where the year stands against one milestone. A day that is not after the cutoff is judged on what was paid (ACHIEVED or MISSED). A later day is the Treasury figure of the cutoff plus the forecast months
 * before it (the registration where a month has no forecast), the month that holds the day pro rata by days (the amount of the month times the day over the days of the month, rounded down); a month that
 * nobody gave a figure for makes the projection a lower bound and the status NO_DATA unless the lower bound already reaches the target. Nothing is invented for a missing month.
 */
export function readMilestone(input: MilestoneInput): MilestoneReading {
  const date = milestoneDateOf(input.planYear, input.milestone.monthDay);
  const plan = BigInt(input.planTotalVnd);
  const targetBp = hundredths(input.milestone.targetPct);
  const targetVnd = (plan * targetBp + 5_000n) / 10_000n;
  const marginBp = hundredths(input.atRiskMarginPct);
  const reading = (projected: bigint | null, basis: 'ACTUAL' | 'FORECAST', coverage: MilestoneCoverage, status: MilestoneStatus): MilestoneReading => ({
    code: input.milestone.code,
    date,
    targetPct: pctText(input.milestone.targetPct),
    targetVnd: targetVnd.toString(),
    projectedVnd: projected === null ? null : projected.toString(),
    projectedPct: projected === null ? null : percent2(projected, plan),
    gapPct: projected === null || plan <= 0n ? null : percent2(projected - targetVnd, plan),
    basis,
    coverage,
    status,
  });
  if (plan <= 0n) return reading(null, date <= input.cutoffDate ? 'ACTUAL' : 'FORECAST', 'NONE', 'NO_DATA');
  const reached = (amount: bigint): boolean => amount * 10_000n >= plan * targetBp;

  if (date <= input.cutoffDate) {
    const actual = date === input.cutoffDate ? input.disbursedVnd : input.actualToDateVnd;
    if (actual === null) return reading(null, 'ACTUAL', 'NONE', 'NO_DATA');
    const amount = BigInt(actual);
    return reading(amount, 'ACTUAL', 'COMPLETE', reached(amount) ? 'ACHIEVED' : 'MISSED');
  }
  if (input.disbursedVnd === null) return reading(null, 'FORECAST', 'NONE', 'NO_DATA');

  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const cutoffMonth = cutoffMonthOf(input.planYear, input.cutoffDate);
  let projected = BigInt(input.disbursedVnd);
  let complete = true;
  // The days of the cutoff month after the cutoff have no figure of their own: a milestone inside that month is the Treasury figure, which can only be a lower bound.
  if (month === cutoffMonth) complete = false;
  for (let at = cutoffMonth + 1; at <= month; at += 1) {
    const figure = input.months.find((entry) => entry.month === at);
    if (figure === undefined || figure.amountVnd === null || !figure.complete) {
      complete = false;
      continue;
    }
    const amount = BigInt(figure.amountVnd);
    projected += at < month ? amount : (amount * BigInt(day)) / BigInt(daysInMonth(input.planYear, month));
  }
  if (!complete) return reading(projected, 'FORECAST', 'PARTIAL', reached(projected) ? 'ON_TRACK' : 'NO_DATA');
  const status: MilestoneStatus = reached(projected) ? 'ON_TRACK' : projected * 10_000n + marginBp * plan >= plan * targetBp ? 'AT_RISK' : 'OFF_TRACK';
  return reading(projected, 'FORECAST', 'COMPLETE', status);
}

/** The readings of every milestone of a policy for one group (an investor, or all of them). */
export function readMilestones(policy: MilestonePolicy, base: Omit<MilestoneInput, 'milestone' | 'atRiskMarginPct' | 'actualToDateVnd'>, actualToDate: (date: string) => string | null): MilestoneReading[] {
  return policy.milestones.map((milestone) => readMilestone({ ...base, milestone, atRiskMarginPct: policy.atRiskMarginPct, actualToDateVnd: actualToDate(milestoneDateOf(base.planYear, milestone.monthDay)) }));
}

/** One investor's row of a milestone as it is stored, the members the summary of a scope needs. */
export interface MilestoneRow {
  planTotalVnd: string;
  targetVnd: string;
  projectedVnd: string | null;
  coverage: MilestoneCoverage;
  status: MilestoneStatus;
  basis: 'ACTUAL' | 'FORECAST';
}

export interface MilestoneSummary {
  units: number;
  planTotalVnd: string;
  targetVnd: string;
  projectedVnd: string | null;
  projectedPct: string | null;
  gapPct: string | null;
  coverage: MilestoneCoverage;
  status: MilestoneStatus;
  /** How many units are in each status. */
  byStatus: Record<MilestoneStatus, number>;
}

/**
 * The milestone of a whole scope from the rows of the investors in it: the amounts add (a project belongs to one investor), the percent is of the sums, never the mean of the percents. A scope with a unit that
 * has no figure has a lower bound, and is judged only where the lower bound already settles it (reached, so on track or achieved); otherwise it is NO_DATA, as for one investor.
 */
export function summarizeMilestone(rows: readonly MilestoneRow[], targetPct: number, marginPct: number): MilestoneSummary {
  const byStatus = Object.fromEntries(MILESTONE_STATUSES.map((status) => [status, rows.filter((row) => row.status === status).length])) as Record<MilestoneStatus, number>;
  const plan = rows.reduce((sum, row) => sum + BigInt(row.planTotalVnd), 0n);
  const target = rows.reduce((sum, row) => sum + BigInt(row.targetVnd), 0n);
  const known = rows.filter((row) => row.projectedVnd !== null);
  const projected = known.reduce((sum, row) => sum + BigInt(row.projectedVnd as string), 0n);
  const complete = rows.length > 0 && known.length === rows.length && rows.every((row) => row.coverage === 'COMPLETE');
  const coverage: MilestoneCoverage = known.length === 0 ? 'NONE' : complete ? 'COMPLETE' : 'PARTIAL';
  const past = rows.length > 0 && rows.every((row) => row.basis === 'ACTUAL');
  const base = { units: rows.length, planTotalVnd: plan.toString(), targetVnd: target.toString(), byStatus, coverage };
  if (known.length === 0 || plan <= 0n) return { ...base, projectedVnd: null, projectedPct: null, gapPct: null, status: 'NO_DATA' };
  const targetBp = hundredths(targetPct);
  const reached = projected * 10_000n >= plan * targetBp;
  let status: MilestoneStatus;
  if (past) status = complete ? (reached ? 'ACHIEVED' : 'MISSED') : reached ? 'ACHIEVED' : 'NO_DATA';
  else if (reached) status = 'ON_TRACK';
  else if (!complete) status = 'NO_DATA';
  else status = projected * 10_000n + hundredths(marginPct) * plan >= plan * targetBp ? 'AT_RISK' : 'OFF_TRACK';
  return { ...base, projectedVnd: projected.toString(), projectedPct: percent2(projected, plan), gapPct: percent2(projected - target, plan), status };
}

// -- Accuracy of the forecasts ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface AccuracyPair {
  /** The investor unit of the project; null when the project has none. */
  investorId: string | null;
  projectId: string;
  /** The month of the plan year the forecast is about. */
  month: number;
  /** What the forecast of the lead said would be paid in the month. */
  forecastVnd: string;
  /** What the Treasury paid in it (a refund takes off). */
  actualVnd: string;
}

export interface AccuracyRow {
  investorId: string | null;
  /** How many project-months were measured and in how many different months. */
  pairs: number;
  months: number;
  forecastVnd: string;
  actualVnd: string;
  /** The sum of the absolute errors of the project-months. */
  absErrorVnd: string;
  /** Weighted absolute percentage error: the absolute errors over the actual, two decimals; null when nothing was paid. */
  wapePct: string | null;
  /** Forecast less actual over actual: positive is over-forecasting; null when nothing was paid. */
  biasPct: string | null;
  band: AccuracyBand;
  /** OVER or UNDER when the bias passes the flag of the rule. */
  biasFlag: 'OVER' | 'UNDER' | null;
}

export interface AccuracyMonth {
  month: number;
  forecastVnd: string;
  actualVnd: string;
  wapePct: string | null;
}

export interface AccuracyReport {
  rows: AccuracyRow[];
  overall: AccuracyRow;
  byMonth: AccuracyMonth[];
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

function rowOf(investorId: string | null, pairs: readonly AccuracyPair[], policy: AccuracyPolicy): AccuracyRow {
  const forecast = pairs.reduce((sum, pair) => sum + BigInt(pair.forecastVnd), 0n);
  const actual = pairs.reduce((sum, pair) => sum + BigInt(pair.actualVnd), 0n);
  const error = pairs.reduce((sum, pair) => sum + abs(BigInt(pair.forecastVnd) - BigInt(pair.actualVnd)), 0n);
  const months = new Set(pairs.map((pair) => pair.month)).size;
  const wape = percent2(error, actual);
  const bias = actual > 0n ? percent2(forecast - actual, actual) : null;
  let band: AccuracyBand = 'INSUFFICIENT';
  if (wape !== null && months >= policy.minMonths) band = Number(wape) <= policy.goodWapePct ? 'GOOD' : Number(wape) <= policy.fairWapePct ? 'FAIR' : 'POOR';
  const flagBp = hundredths(policy.biasFlagPct);
  const flag = actual > 0n && abs(forecast - actual) * 10_000n >= actual * flagBp ? (forecast > actual ? 'OVER' : 'UNDER') : null;
  return { investorId, pairs: pairs.length, months, forecastVnd: forecast.toString(), actualVnd: actual.toString(), absErrorVnd: error.toString(), wapePct: wape, biasPct: bias, band, biasFlag: flag };
}

/**
 * How well the forecasts of each investor foretold the payments (G1-16): over the project-months that had a forecast made before the month (the lead of the rule) and a payment figure, the weighted absolute percentage
 * error and the bias. A project-month where both figures are below the noise floor is left out. The investors are listed worst first (the largest error), the ones with no band after the others.
 */
export function forecastAccuracy(pairs: readonly AccuracyPair[], policy: AccuracyPolicy): AccuracyReport {
  const measured = pairs.filter((pair) => BigInt(pair.forecastVnd) >= BigInt(policy.minActualVnd) || BigInt(pair.actualVnd) >= BigInt(policy.minActualVnd));
  const byInvestor = new Map<string | null, AccuracyPair[]>();
  for (const pair of measured) byInvestor.set(pair.investorId, [...(byInvestor.get(pair.investorId) ?? []), pair]);
  const rows = [...byInvestor.entries()].map(([investor, own]) => rowOf(investor, own, policy));
  rows.sort((a, b) => {
    const left = a.wapePct === null ? -1 : Number(a.wapePct);
    const right = b.wapePct === null ? -1 : Number(b.wapePct);
    return right - left || (a.investorId ?? '').localeCompare(b.investorId ?? '');
  });
  const months = [...new Set(measured.map((pair) => pair.month))].sort((a, b) => a - b);
  const byMonth = months.map((month) => {
    const own = measured.filter((pair) => pair.month === month);
    const row = rowOf(null, own, policy);
    return { month, forecastVnd: row.forecastVnd, actualVnd: row.actualVnd, wapePct: row.wapePct };
  });
  return { rows, overall: rowOf(null, measured, policy), byMonth };
}
