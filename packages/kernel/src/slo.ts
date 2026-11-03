import type { AlertSink, MetricsSink } from './ports.ts';

/**
 * Availability objectives and the error budget of the core services (ST-KERNEL-052, NFR-AVAILABILITY-01). The measure is
 * the share of valid requests that were answered, one bucket for each minute and service: a response counts against
 * the budget when it is a server error (5xx) or the request timed out. A 4xx answer is the platform doing its job.
 * The policy built on top of these figures (what a spent budget stops) is `infra/pipelines/production.json`.
 */
export const SLO_OBJECTIVE = 0.999;
export const SLO_WINDOW_DAYS = 30;
/** The services the objective is measured for: the API of each module family named in the story. */
export const SLO_SERVICES = ['DIS', 'CAP', 'PAY', 'PRJ', 'IAM'] as const;
export type SloService = (typeof SLO_SERVICES)[number];

export const SLO_FAST_BURN_ALERT = 'SLO_FAST_BURN';
export const SLO_SLOW_BURN_ALERT = 'SLO_SLOW_BURN';
export const SLO_BUDGET_EXHAUSTED_ALERT = 'SLO_BUDGET_EXHAUSTED';

export const SLO_BUDGET_CONSUMED_METRIC = 'slo_error_budget_consumed_minutes';
export const SLO_BUDGET_REMAINING_METRIC = 'slo_error_budget_remaining_percent';
export const SLO_BURN_RATE_METRIC = 'slo_burn_rate';

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;
/** Floating point leaves 14.399999999999999 where 14.4 is meant; figures are compared and shown at this precision. */
const PRECISION = 1e6;
const round = (value: number): number => Math.round(value * PRECISION) / PRECISION;

/**
 * A burn rate is how many times faster than the objective allows the budget is being spent: 1 spends it exactly in the
 * window, 14.4 spends 2 percent of 30 days in an hour. A rule fires only while the long window AND the short window are
 * both at or above the rate: the long one says the loss is real, the short one that it is still going on (so the alert
 * clears within the short window once the cause is gone).
 */
export interface BurnRule {
  id: string;
  burnRate: number;
  longWindowMinutes: number;
  shortWindowMinutes: number;
  severity: 'critical' | 'warning';
}

export const FAST_BURN: BurnRule = { id: SLO_FAST_BURN_ALERT, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5, severity: 'critical' };
export const SLOW_BURN: BurnRule = { id: SLO_SLOW_BURN_ALERT, burnRate: 6, longWindowMinutes: 360, shortWindowMinutes: 30, severity: 'warning' };

/** The requests of one service in one minute (`minute` counts minutes since the epoch). */
export interface SliBucket {
  minute: number;
  total: number;
  bad: number;
}

/** A period in which the service was down by decision or by drill (a DR rehearsal): it counts as 100 percent failure, whatever the buckets say. */
export interface DeclaredOutage {
  startMinute: number;
  minutes: number;
  reason: string;
}

export const minuteOf = (moment: Date): number => Math.floor(moment.getTime() / MINUTE_MS);

/** Whether a response counts against the budget: a server error, or a request that timed out. */
export function isBadResponse(response: { status: number; timedOut: boolean }): boolean {
  return response.timedOut || response.status >= 500;
}

const inWindow = (minute: number, nowMinute: number, windowMinutes: number): boolean => minute > nowMinute - windowMinutes && minute <= nowMinute;

/** How many times faster than the objective allows the budget was spent over the last `windowMinutes` minutes (0 when no request was made). */
export function burnRateOver(buckets: readonly SliBucket[], nowMinute: number, windowMinutes: number, objective: number = SLO_OBJECTIVE): number {
  let total = 0;
  let bad = 0;
  for (const bucket of buckets) {
    if (!inWindow(bucket.minute, nowMinute, windowMinutes)) continue;
    total += bucket.total;
    bad += bucket.bad;
  }
  return total === 0 ? 0 : round(bad / total / round(1 - objective));
}

export interface BurnEvaluation {
  longRate: number;
  shortRate: number;
  firing: boolean;
}

export function evaluateBurn(buckets: readonly SliBucket[], rule: BurnRule, nowMinute: number, objective: number = SLO_OBJECTIVE): BurnEvaluation {
  const longRate = burnRateOver(buckets, nowMinute, rule.longWindowMinutes, objective);
  const shortRate = burnRateOver(buckets, nowMinute, rule.shortWindowMinutes, objective);
  return { longRate, shortRate, firing: longRate >= rule.burnRate && shortRate >= rule.burnRate };
}

export interface BudgetStatus {
  objective: number;
  /** Minutes of full outage the window allows: 43.2 for 99.9 percent over 30 days. */
  budgetMinutes: number;
  /** Minutes of full outage the window has had: a minute in which a quarter of the requests failed counts 0.25. */
  consumedMinutes: number;
  remainingMinutes: number;
  /** Negative once the budget is overspent. */
  remainingPercent: number;
  availability: number;
  /** The budget is spent (consumed has reached it): feature releases stop. */
  exhausted: boolean;
  /** The objective was missed (consumed is above the budget). */
  breached: boolean;
  /** The first minute at which the running total of the window reached the budget. */
  exhaustedSinceMinute?: number;
}

export interface BudgetInput {
  buckets: readonly SliBucket[];
  outages?: readonly DeclaredOutage[];
  nowMinute: number;
  objective?: number;
  windowDays?: number;
}

/**
 * The error budget of the last `windowDays` days. Each minute costs the share of its requests that failed; a minute inside a
 * declared outage costs a whole minute, so a DR drill counts fully against the budget and no cache or retry can make it smaller.
 */
export function budgetStatus({ buckets, outages = [], nowMinute, objective = SLO_OBJECTIVE, windowDays = SLO_WINDOW_DAYS }: BudgetInput): BudgetStatus {
  const windowMinutes = windowDays * MINUTES_PER_DAY;
  const budgetMinutes = round(windowMinutes * round(1 - objective));
  const first = nowMinute - windowMinutes + 1;
  const cost = new Float64Array(windowMinutes);
  for (const bucket of buckets) {
    if (inWindow(bucket.minute, nowMinute, windowMinutes) && bucket.total > 0) cost[bucket.minute - first] = bucket.bad / bucket.total;
  }
  for (const outage of outages) {
    for (let minute = Math.max(outage.startMinute, first); minute < outage.startMinute + outage.minutes && minute <= nowMinute; minute += 1) cost[minute - first] = 1;
  }
  let running = 0;
  let exhaustedSinceMinute: number | undefined;
  for (let index = 0; index < windowMinutes; index += 1) {
    running += cost[index] as number;
    if (exhaustedSinceMinute === undefined && round(running) >= budgetMinutes) exhaustedSinceMinute = first + index;
  }
  const consumedMinutes = round(running);
  const remainingMinutes = round(budgetMinutes - consumedMinutes);
  const status: BudgetStatus = {
    objective,
    budgetMinutes,
    consumedMinutes,
    remainingMinutes,
    remainingPercent: round((remainingMinutes / budgetMinutes) * 100),
    availability: round(1 - consumedMinutes / windowMinutes),
    exhausted: consumedMinutes >= budgetMinutes,
    breached: consumedMinutes > budgetMinutes,
  };
  if (exhaustedSinceMinute !== undefined) status.exhaustedSinceMinute = exhaustedSinceMinute;
  return status;
}

export interface SloReportInput {
  service: SloService;
  buckets: readonly SliBucket[];
  outages?: readonly DeclaredOutage[];
  nowMinute: number;
  metrics: MetricsSink;
  alerts: AlertSink;
}

export interface SloReport {
  status: BudgetStatus;
  fastBurn: boolean;
  slowBurn: boolean;
}

/**
 * One evaluation of one service: publishes the figures of the dashboard as gauges (budget consumed and left, the burn rate
 * of every window of both rules) and raises the alert of every rule that fires. It is called every minute; an alert
 * is raised on every call while its condition holds and stops being raised when it does not.
 */
export function reportSlo({ service, buckets, outages, nowMinute, metrics, alerts }: SloReportInput): SloReport {
  const status = budgetStatus({ buckets, nowMinute, ...(outages === undefined ? {} : { outages }) });
  metrics.gauge(SLO_BUDGET_CONSUMED_METRIC, status.consumedMinutes, { service });
  metrics.gauge(SLO_BUDGET_REMAINING_METRIC, status.remainingPercent, { service });
  const evaluations = [FAST_BURN, SLOW_BURN].map((rule) => ({ rule, evaluation: evaluateBurn(buckets, rule, nowMinute) }));
  for (const { rule, evaluation } of evaluations) {
    metrics.gauge(SLO_BURN_RATE_METRIC, evaluation.longRate, { service, window: `${rule.longWindowMinutes}m` });
    metrics.gauge(SLO_BURN_RATE_METRIC, evaluation.shortRate, { service, window: `${rule.shortWindowMinutes}m` });
  }
  const [fast, slow] = evaluations.map(({ evaluation }) => evaluation.firing) as [boolean, boolean];
  if (fast) alerts.raise(SLO_FAST_BURN_ALERT, { service, burnRate: FAST_BURN.burnRate });
  if (slow) alerts.raise(SLO_SLOW_BURN_ALERT, { service, burnRate: SLOW_BURN.burnRate });
  if (status.exhausted) alerts.raise(SLO_BUDGET_EXHAUSTED_ALERT, { service, consumedMinutes: status.consumedMinutes, budgetMinutes: status.budgetMinutes });
  return { status, fastBurn: fast, slowBurn: slow };
}

/**
 * What the release pipeline reads (`scripts/deploy-gate.mjs --budget-report`, ST-KERNEL-052): whether any core service has
 * spent its budget, and since when. A single spent budget stops feature releases, because they all share one platform.
 */
export interface BudgetReport {
  generatedAt: string;
  exhausted: boolean;
  /** The earliest moment at which a service reached its budget; absent while none has. */
  exhaustedAt?: string;
  services: Array<{ service: SloService; consumedMinutes: number; budgetMinutes: number; remainingPercent: number; exhausted: boolean }>;
}

export function budgetReport(entries: ReadonlyArray<{ service: SloService; status: BudgetStatus }>, generatedAt: Date): BudgetReport {
  const since = entries.flatMap(({ status }) => (status.exhaustedSinceMinute === undefined ? [] : [status.exhaustedSinceMinute]));
  const report: BudgetReport = {
    generatedAt: generatedAt.toISOString(),
    exhausted: entries.some(({ status }) => status.exhausted),
    services: entries.map(({ service, status }) => ({ service, consumedMinutes: status.consumedMinutes, budgetMinutes: status.budgetMinutes, remainingPercent: status.remainingPercent, exhausted: status.exhausted })),
  };
  if (since.length > 0) report.exhaustedAt = new Date(Math.min(...since) * MINUTE_MS).toISOString();
  return report;
}
