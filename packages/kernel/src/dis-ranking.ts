import { groupRate } from './dis-snapshot.ts';

/** BR-DIS-10 [assumption until D03]: a unit with a plan below this minimum is not ranked, so that a small unit does not top the table with one payment. */
export const DEFAULT_MINIMUM_PLAN_VND = '1000000000';

export interface RankingUnit {
  code: string;
  planVnd: string;
  /** What was disbursed, or null when nobody has the figure (the Treasury booked nothing): a unit with no figure has no rate to be ranked by. */
  disbursedVnd: string | null;
}

export type ExcludedReason = 'PLAN_BELOW_MINIMUM' | 'ZERO_DENOMINATOR' | 'NO_DATA';

export interface RankedUnit {
  rank: number;
  code: string;
  ratePct: string;
  disbursedVnd: string;
}

export interface Ranking {
  ranked: RankedUnit[];
  excluded: Array<{ code: string; reason: ExcludedReason }>;
}

/**
 * BR-DIS-10: the units of one group, by rate from the highest; a tie goes to the larger disbursement, then to the code of the unit, so that the order never depends on how the units were read. The
 * rates are compared as fractions of whole dong (never as rounded percents), a unit whose plan is zero or below the minimum, or that has no figure, is left out with its reason, and positions are 1, 2, 3 without gaps.
 */
export function rankUnits(units: readonly RankingUnit[], minimumPlanVnd: string = DEFAULT_MINIMUM_PLAN_VND): Ranking {
  const minimum = BigInt(minimumPlanVnd);
  const excluded: Ranking['excluded'] = [];
  const counted: Array<{ code: string; planVnd: string; disbursedVnd: string }> = [];
  for (const unit of units) {
    const plan = BigInt(unit.planVnd);
    if (plan === 0n) excluded.push({ code: unit.code, reason: 'ZERO_DENOMINATOR' });
    else if (plan < minimum) excluded.push({ code: unit.code, reason: 'PLAN_BELOW_MINIMUM' });
    // A rate of disbursement is not negative and is not a guess: no figure, or a net below zero, leaves the unit out with its reason.
    else if (unit.disbursedVnd === null || BigInt(unit.disbursedVnd) < 0n) excluded.push({ code: unit.code, reason: 'NO_DATA' });
    else counted.push({ code: unit.code, planVnd: unit.planVnd, disbursedVnd: unit.disbursedVnd });
  }
  const ordered = [...counted].sort((a, b) => {
    const left = BigInt(a.disbursedVnd) * BigInt(b.planVnd);
    const right = BigInt(b.disbursedVnd) * BigInt(a.planVnd);
    if (left !== right) return left > right ? -1 : 1;
    const paidA = BigInt(a.disbursedVnd);
    const paidB = BigInt(b.disbursedVnd);
    if (paidA !== paidB) return paidA > paidB ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return {
    ranked: ordered.map((unit, index) => ({ rank: index + 1, code: unit.code, ratePct: groupRate([{ numeratorVnd: unit.disbursedVnd, denominatorVnd: unit.planVnd }]) as string, disbursedVnd: unit.disbursedVnd })),
    excluded: excluded.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
  };
}
