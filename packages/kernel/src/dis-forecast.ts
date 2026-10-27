import { percentOf } from './dis-review.ts';

/**
 * The year-end estimate of a project (ST-DIS-018, DIS 3 F8, BR-DIS-11): what the Treasury paid up to the cutoff plus what is expected for the months after it, a forecast when there is one for the month, else
 * the registration of the month, and nothing is invented for a month that has neither (the historical curve of the design needs a year of history and waits for R2). Everything is a proposal until the
 * business owner signs D03 (CXN-03): the share of the plan below which a project is called a candidate for reallocation is an assumption of the design.
 */
export const REALLOCATION_THRESHOLD_PCT = 80;
/** The month after December that closes the year of the plan (the adjustment time): it takes a row when one names it and is never missing. */
export const ADJUSTMENT_MONTH = 13;

export type MonthSource = 'FORECAST' | 'REGISTERED' | 'MISSING' | 'MIXED';
export type EstimateCoverage = 'COMPLETE' | 'PARTIAL' | 'NONE';
export type EstimateMethod = 'FORECAST_AND_REGISTERED' | 'FORECAST_AND_REGISTERED_PARTIAL' | 'NO_TREASURY_DATA';

export interface EstimateInput {
  /** What the Treasury paid to the cutoff in the year, or null when it booked nothing for the project (no data is not zero, BR-DIS-08). */
  disbursedVnd: string | null;
  /** The month of the cutoff, 1 to 12: the months after it are the ones that are estimated. */
  cutoffMonth: number;
  forecasts: ReadonlyMap<number, string>;
  registered: ReadonlyMap<number, string>;
  planTotalVnd: string;
}

export interface EstimatedMonth {
  month: number;
  /** Null for a month that has no forecast and no registration. */
  amountVnd: string | null;
  source: MonthSource;
  /** Every project that the month adds up has a figure for it (a month that is only a sum of some of them is not complete, and the curve stops there). The adjustment month is never required. */
  complete: boolean;
}

export interface Estimate {
  disbursedVnd: string | null;
  planTotalVnd: string;
  months: EstimatedMonth[];
  /** The disbursement plus the months that are known; a lower bound while a month is missing. Null with no Treasury data. */
  eacVnd: string | null;
  /** The estimate less the plan: negative when the year is expected to fall short. */
  gapVnd: string | null;
  /** The estimate as a share of the plan, one decimal; null with no plan, no estimate or a negative one. */
  ratioPct: string | null;
  coverage: EstimateCoverage;
  /** True below the threshold of the plan, false at or above it, null when the estimate is not complete or there is no plan. */
  reallocationCandidate: boolean | null;
  method: EstimateMethod;
}

/** The month (1 to 12) of a date `YYYY-MM-DD`. */
export const monthOf = (date: string): number => Number(date.slice(5, 7));

function judged(plan: bigint, estimated: bigint | null, coverage: EstimateCoverage): Pick<Estimate, 'gapVnd' | 'ratioPct' | 'reallocationCandidate'> {
  if (estimated === null) return { gapVnd: null, ratioPct: null, reallocationCandidate: null };
  return {
    gapVnd: (estimated - plan).toString(),
    ratioPct: plan > 0n && estimated >= 0n ? percentOf(estimated, plan) : null,
    reallocationCandidate: coverage === 'COMPLETE' && plan > 0n ? estimated * 100n < plan * BigInt(REALLOCATION_THRESHOLD_PCT) : null,
  };
}

export function estimateYear(input: EstimateInput): Estimate {
  const plan = BigInt(input.planTotalVnd);
  const months: EstimatedMonth[] = [];
  for (let month = input.cutoffMonth + 1; month <= 12; month += 1) {
    const forecast = input.forecasts.get(month);
    const registered = input.registered.get(month);
    months.push(
      forecast !== undefined
        ? { month, amountVnd: forecast, source: 'FORECAST', complete: true }
        : registered !== undefined
          ? { month, amountVnd: registered, source: 'REGISTERED', complete: true }
          : { month, amountVnd: null, source: 'MISSING', complete: false },
    );
  }
  // A cutoff in the adjustment month itself (a close in the January after the year) has the payments of that month in the figure of the snapshot already; its schedule is not added a second time.
  const adjustment = input.cutoffMonth < ADJUSTMENT_MONTH ? input.forecasts.get(ADJUSTMENT_MONTH) : undefined;
  const adjustmentRegistered = input.cutoffMonth < ADJUSTMENT_MONTH ? input.registered.get(ADJUSTMENT_MONTH) : undefined;
  if (adjustment !== undefined) months.push({ month: ADJUSTMENT_MONTH, amountVnd: adjustment, source: 'FORECAST', complete: true });
  else if (adjustmentRegistered !== undefined) months.push({ month: ADJUSTMENT_MONTH, amountVnd: adjustmentRegistered, source: 'REGISTERED', complete: true });
  if (input.disbursedVnd === null) {
    return { disbursedVnd: null, planTotalVnd: input.planTotalVnd, months, eacVnd: null, gapVnd: null, ratioPct: null, coverage: 'NONE', reallocationCandidate: null, method: 'NO_TREASURY_DATA' };
  }
  const disbursed = BigInt(input.disbursedVnd);
  const required = months.filter((month) => month.month <= 12);
  const known = required.filter((month) => month.amountVnd !== null).length;
  const coverage: EstimateCoverage = known === required.length ? 'COMPLETE' : known === 0 ? 'NONE' : 'PARTIAL';
  const estimated = months.reduce((sum, month) => sum + (month.amountVnd === null ? 0n : BigInt(month.amountVnd)), disbursed);
  return {
    disbursedVnd: input.disbursedVnd,
    planTotalVnd: input.planTotalVnd,
    months,
    eacVnd: estimated.toString(),
    ...judged(plan, estimated, coverage),
    coverage,
    method: coverage === 'COMPLETE' ? 'FORECAST_AND_REGISTERED' : 'FORECAST_AND_REGISTERED_PARTIAL',
  };
}

/** The estimate of a unit or of the whole scope: the sums of the projects, as complete as the least complete of them; a project with no Treasury data keeps the sum a lower bound and says so. */
export function mergeEstimates(estimates: readonly Estimate[]): Estimate {
  const known = estimates.filter((estimate) => estimate.disbursedVnd !== null);
  const plan = estimates.reduce((sum, estimate) => sum + BigInt(estimate.planTotalVnd), 0n);
  // Only the projects with Treasury data add up: the months of a project that has none would add to a baseline that is not there, and the curve would not agree with the estimate.
  const months = new Map<number, { amount: bigint | null; sources: Set<MonthSource>; complete: number }>();
  for (const estimate of known) {
    for (const month of estimate.months) {
      const held = months.get(month.month) ?? { amount: null, sources: new Set<MonthSource>(), complete: 0 };
      if (month.amountVnd !== null) held.amount = (held.amount ?? 0n) + BigInt(month.amountVnd);
      held.sources.add(month.source);
      if (month.complete) held.complete += 1;
      months.set(month.month, held);
    }
  }
  const merged: EstimatedMonth[] = [...months.entries()]
    .sort(([left], [right]) => left - right)
    .map(([month, held]) => ({ month, amountVnd: held.amount === null ? null : held.amount.toString(), source: held.sources.size === 1 ? ([...held.sources][0] as MonthSource) : 'MIXED', complete: month === ADJUSTMENT_MONTH || held.complete === known.length }));
  const complete = estimates.length > 0 && estimates.every((estimate) => estimate.coverage === 'COMPLETE');
  const none = estimates.every((estimate) => estimate.coverage === 'NONE');
  const coverage: EstimateCoverage = complete ? 'COMPLETE' : none ? 'NONE' : 'PARTIAL';
  if (known.length === 0) {
    return { disbursedVnd: null, planTotalVnd: plan.toString(), months: merged, eacVnd: null, gapVnd: null, ratioPct: null, coverage: 'NONE', reallocationCandidate: null, method: 'NO_TREASURY_DATA' };
  }
  const disbursed = known.reduce((sum, estimate) => sum + BigInt(estimate.disbursedVnd as string), 0n);
  const estimated = known.reduce((sum, estimate) => sum + BigInt(estimate.eacVnd as string), 0n);
  return {
    disbursedVnd: disbursed.toString(),
    planTotalVnd: plan.toString(),
    months: merged,
    eacVnd: estimated.toString(),
    ...judged(plan, estimated, coverage),
    coverage,
    method: coverage === 'COMPLETE' ? 'FORECAST_AND_REGISTERED' : 'FORECAST_AND_REGISTERED_PARTIAL',
  };
}
