import { COVERAGE, ratesOf } from './dis-snapshot.ts';
import type { RateNullReason, TreasuryCoverage } from './dis-snapshot.ts';

/** The figures a rate is made of: the year plan is divided by what the Treasury paid, the capital carried over by what was reported (the Treasury pays a project, not a source). */
export const RATE_BASES = ['CURRENT_YEAR', 'CARRYOVER'] as const;
export type RateBasis = (typeof RATE_BASES)[number];

/** What the lines of a group of a snapshot add up to (sums of whole dong, null when no line had the figure), written by the database and read here. */
export interface RateSums {
  /** How many projects the lines belong to. */
  projects: number;
  planPmVnd: string;
  planLocalVnd: string;
  treasuryVnd: string | null;
  reportedVnd: string | null;
  ctmtqgVnd: string | null;
  /** Whether the Treasury coverage of every line is NONE, and whether it is COMPLETE: a group is in between when its lines differ. */
  allNone: boolean;
  allComplete: boolean;
}

export interface RateFigures {
  projects: number;
  numeratorVnd: string | null;
  planPmVnd: string;
  planLocalVnd: string;
  planTotalVnd: string;
  reportedVnd: string | null;
  ctmtqgVnd: string | null;
  ratePmPct: string | null;
  rateTotalPct: string | null;
  rateNullReason: RateNullReason | null;
  treasuryCoverage: TreasuryCoverage;
}

const plus = (left: string | null, right: string | null): string | null => (left === null ? right : right === null ? left : (BigInt(left) + BigInt(right)).toString());

/** The sums of several groups, as if their lines were one group (the groups of a snapshot never share a project, so the projects are added). */
export function addSums(groups: readonly RateSums[]): RateSums {
  return groups.reduce<RateSums>(
    (sum, group) => ({
      projects: sum.projects + group.projects,
      planPmVnd: (BigInt(sum.planPmVnd) + BigInt(group.planPmVnd)).toString(),
      planLocalVnd: (BigInt(sum.planLocalVnd) + BigInt(group.planLocalVnd)).toString(),
      treasuryVnd: plus(sum.treasuryVnd, group.treasuryVnd),
      reportedVnd: plus(sum.reportedVnd, group.reportedVnd),
      ctmtqgVnd: plus(sum.ctmtqgVnd, group.ctmtqgVnd),
      allNone: sum.allNone && group.allNone,
      allComplete: sum.allComplete && group.allComplete,
    }),
    { projects: 0, planPmVnd: '0', planLocalVnd: '0', treasuryVnd: null, reportedVnd: null, ctmtqgVnd: null, allNone: true, allComplete: true },
  );
}

/** How far the Treasury can be trusted over a group: none when it booked nothing for any line (or there is no line), complete when it agrees with the report on every line. */
function coverageOfSums(sums: RateSums): TreasuryCoverage {
  if (sums.projects === 0 || sums.allNone) return COVERAGE.none;
  return sums.allComplete ? COVERAGE.complete : COVERAGE.partial;
}

/**
 * BR-DIS-04, BR-DIS-05, BR-DIS-08: the two rates of a group are made from the sums, never from the rates of its parts: the sum of the numerators over the sum of the plan given by the Prime Minister,
 * and over the sum of the whole plan. A rate with nothing to divide by is null with its reason, never zero.
 */
export function rateOfSums(sums: RateSums, basis: RateBasis): RateFigures {
  const numeratorVnd = basis === 'CURRENT_YEAR' ? sums.treasuryVnd : sums.reportedVnd;
  const treasuryCoverage = coverageOfSums(sums);
  const rates = ratesOf({ disbursedVnd: numeratorVnd, planPmVnd: sums.planPmVnd, planLocalVnd: sums.planLocalVnd, coverage: treasuryCoverage });
  return {
    projects: sums.projects,
    numeratorVnd,
    planPmVnd: sums.planPmVnd,
    planLocalVnd: sums.planLocalVnd,
    planTotalVnd: (BigInt(sums.planPmVnd) + BigInt(sums.planLocalVnd)).toString(),
    reportedVnd: sums.reportedVnd,
    ctmtqgVnd: sums.ctmtqgVnd,
    ratePmPct: rates.ratePmPct,
    rateTotalPct: rates.rateTotalPct,
    rateNullReason: rates.nullReason,
    treasuryCoverage,
  };
}
