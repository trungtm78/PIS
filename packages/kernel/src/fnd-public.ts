import { DomainError } from './errors.ts';
import { percentOf } from './fnd-figures.ts';
import { splitOfOrigin, treasuryCarrier } from './fnd-taxonomy.ts';
import type { FundingPack } from './fnd-taxonomy.ts';

/**
 * The public pack through the engine (docs/fnd-funding-model.md sections 1, 6.1, 9): the lines of a snapshot, the sums of a group and the two rates of the public edition, computed from the pack as DATA (its classes and tiers,
 * its groups of origins, its source of actuals, its tolerance) instead of from the constants of `dis-snapshot.ts`. The public edition does not change: `fnd-public-golden.test.ts` proves that for every fixture this module returns,
 * field by field, what `buildLines`, `rateOfSums` and `snapshotHash` return (and what was recorded from the code before FND-1). The functions of `dis-snapshot.ts` are NOT used here, so the proof is an equality of two
 * implementations and not of a function with itself.
 */

export type PublicCoverage = 'COMPLETE' | 'PARTIAL' | 'NONE';
export type PublicRateReason = 'ZERO_DENOMINATOR' | 'NO_DATA' | 'TREASURY_COVERAGE_NONE';

export interface PublicPlanCell {
  bucket: string;
  budgetLevel: string;
  amountVnd: string;
  origin: string | null;
  fundSourceVersionId: string | null;
}
export interface PublicReportedCell {
  bucket: string;
  budgetLevel: string;
  cumulativeVnd: string;
  ctmtqgVnd: string | null;
  nextMonthVnd: string;
}
export interface PublicTreasuryEntry {
  amountVnd: string;
  reversal: boolean;
  paidOn: string;
}
export interface PublicProject {
  projectId: string;
  unitId: string;
  planVersionId: string | null;
  plans: readonly PublicPlanCell[];
  reported: { reportRevisionId: string; cells: readonly PublicReportedCell[] } | null;
  previous: ReadonlyMap<string, string> | null;
  treasury: readonly PublicTreasuryEntry[];
  treasuryFrom?: string | null;
}

export interface PublicLine {
  bucket: string;
  budgetLevel: string;
  fundSourceVersionId: string | null;
  planPmAssignedVnd: string;
  planLocalAddedVnd: string;
  planTotalVnd: string;
  disbursedTreasuryVnd: string | null;
  disbursedReportedVnd: string | null;
  periodDeltaVnd: string | null;
  registeredMonthVnd: string | null;
  forecastEacVnd: string | null;
  ctmtqgSubsetVnd: string | null;
  ratePmPct: string | null;
  rateTotalPct: string | null;
  rateNullReason: PublicRateReason | null;
  treasuryCoverage: PublicCoverage;
  reportRevisionId: string | null;
  planVersionId: string | null;
}

const cellKey = (bucket: string, level: string): string => `${bucket}/${level}`;
const sum = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total += value;
  return total;
};

/** BR-DIS-06: what the Treasury paid, by the day it paid, on or before the cutoff (and on or after `from`); a refund takes off on its own day; null when it booked nothing in the window. */
export function treasuryNet(entries: readonly PublicTreasuryEntry[], cutoff: string, from: string | null): { totalVnd: string; transactions: number } | null {
  const counted = entries.filter((entry) => entry.paidOn <= cutoff && (from === null || entry.paidOn >= from));
  if (counted.length === 0) return null;
  return { totalVnd: sum(counted.map((entry) => (entry.reversal ? -BigInt(entry.amountVnd) : BigInt(entry.amountVnd)))).toString(), transactions: counted.length };
}

/** The percent of the tolerance as basis points, so that the comparison is in whole numbers. */
const basisPoints = (pct: number): bigint => BigInt(Math.round(pct * 100));

/** How far the Treasury can be trusted next to the report: none when it booked nothing, partial without an accepted report or when the two differ by more than the tolerance of the pack (5 percent), complete otherwise. */
export function treasuryCoverage(pack: FundingPack, treasuryVnd: string | null, reportedVnd: string | null): PublicCoverage {
  if (treasuryVnd === null) return 'NONE';
  if (reportedVnd === null) return 'PARTIAL';
  const treasury = BigInt(treasuryVnd);
  if (treasury < 0n) return 'PARTIAL';
  const reported = BigInt(reportedVnd);
  if (reported === 0n) return treasury === 0n ? 'COMPLETE' : 'PARTIAL';
  const gap = treasury - reported;
  return (gap < 0n ? -gap : gap) * 10_000n > basisPoints(pack.varianceTolerance.pct) * reported ? 'PARTIAL' : 'COMPLETE';
}

export interface PublicRates {
  ratePmPct: string | null;
  rateTotalPct: string | null;
  nullReason: PublicRateReason | null;
}

/** BR-DIS-05, BR-DIS-08: one numerator over two denominators; a rate with nothing to divide by, or nothing to divide, is null with its reason, never zero. */
export function publicRates(input: { disbursedVnd: string | null; planPrimaryVnd: string; planAddedVnd: string; coverage: PublicCoverage }): PublicRates {
  const primary = BigInt(input.planPrimaryVnd);
  const total = primary + BigInt(input.planAddedVnd);
  if (total === 0n) return { ratePmPct: null, rateTotalPct: null, nullReason: 'ZERO_DENOMINATOR' };
  if (input.disbursedVnd === null) return { ratePmPct: null, rateTotalPct: null, nullReason: input.coverage === 'NONE' ? 'TREASURY_COVERAGE_NONE' : 'NO_DATA' };
  const disbursed = BigInt(input.disbursedVnd);
  if (disbursed < 0n) return { ratePmPct: null, rateTotalPct: null, nullReason: 'NO_DATA' };
  const ratePmPct = primary === 0n ? null : percentOf(disbursed, primary);
  return { ratePmPct, rateTotalPct: percentOf(disbursed, total), nullReason: ratePmPct === null ? 'ZERO_DENOMINATOR' : null };
}

/**
 * The lines of a project in a snapshot, one for each cell of the pack in the order of the form (BR-DIS-01), made from the pack: the plan of each cell is split into the primary and the added part by the groups of origins;
 * the Treasury figure is carried once, on the first tier of the first class whose actual is the Treasury, with the rates of that class over the plan of all its tiers; a cell nobody reported is null, not zero. 422
 * `VALIDATION_FAILED` for a pack whose actuals are not headed by the Treasury (the enterprise pack builds its figures with the engine of `fnd-figures.ts`, not with lines).
 */
export function buildPackLines(pack: FundingPack, project: PublicProject, cutoff: string): PublicLine[] {
  const carrier = treasuryCarrier(pack);
  if (carrier === undefined || pack.actualsPrecedence !== 'TREASURY_HEADLINE') throw new DomainError('VALIDATION_FAILED', 422, 'pack');
  const treasury = treasuryNet(project.treasury, cutoff, project.treasuryFrom ?? null);
  const reportedTotal = project.reported === null ? null : sum(project.reported.cells.map((cell) => BigInt(cell.cumulativeVnd))).toString();
  const coverage = treasuryCoverage(pack, treasury?.totalVnd ?? null, reportedTotal);
  const planOf = (plans: readonly PublicPlanCell[], side: 'PRIMARY' | 'ADDED'): bigint => sum(plans.filter((plan) => splitOfOrigin(pack, plan.origin) === side).map((plan) => BigInt(plan.amountVnd)));
  const yearPlans = project.plans.filter((plan) => plan.bucket === carrier.classCode);
  const carried = publicRates({ disbursedVnd: treasury?.totalVnd ?? null, planPrimaryVnd: planOf(yearPlans, 'PRIMARY').toString(), planAddedVnd: planOf(yearPlans, 'ADDED').toString(), coverage });

  const lines: PublicLine[] = [];
  for (const one of pack.classes) {
    for (const tier of pack.tiers) {
      const plans = project.plans.filter((plan) => plan.bucket === one.code && plan.budgetLevel === tier.code);
      const primary = planOf(plans, 'PRIMARY');
      const added = planOf(plans, 'ADDED');
      const reported = project.reported?.cells.find((cell) => cell.bucket === one.code && cell.budgetLevel === tier.code);
      const before = project.previous?.get(cellKey(one.code, tier.code));
      const carries = one.code === carrier.classCode && tier.code === carrier.tierCode;
      lines.push({
        bucket: one.code,
        budgetLevel: tier.code,
        fundSourceVersionId: plans.find((plan) => plan.fundSourceVersionId !== null)?.fundSourceVersionId ?? null,
        planPmAssignedVnd: primary.toString(),
        planLocalAddedVnd: added.toString(),
        planTotalVnd: (primary + added).toString(),
        disbursedTreasuryVnd: carries ? (treasury?.totalVnd ?? null) : null,
        disbursedReportedVnd: reported?.cumulativeVnd ?? null,
        periodDeltaVnd: reported === undefined || before === undefined ? null : (BigInt(reported.cumulativeVnd) - BigInt(before)).toString(),
        registeredMonthVnd: reported?.nextMonthVnd ?? null,
        forecastEacVnd: null,
        ctmtqgSubsetVnd: reported?.ctmtqgVnd ?? null,
        ratePmPct: carries ? carried.ratePmPct : null,
        rateTotalPct: carries ? carried.rateTotalPct : null,
        rateNullReason: carries ? carried.nullReason : 'NO_DATA',
        treasuryCoverage: coverage,
        reportRevisionId: project.reported?.reportRevisionId ?? null,
        planVersionId: project.planVersionId,
      });
    }
  }
  return lines;
}

// -- groups -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the lines of a group add up to (the same shape the database writes for `rateOfSums`). */
export interface PublicRateSums {
  projects: number;
  planPmVnd: string;
  planLocalVnd: string;
  treasuryVnd: string | null;
  reportedVnd: string | null;
  ctmtqgVnd: string | null;
  allNone: boolean;
  allComplete: boolean;
}

export interface PublicRateFigures {
  projects: number;
  numeratorVnd: string | null;
  planPmVnd: string;
  planLocalVnd: string;
  planTotalVnd: string;
  reportedVnd: string | null;
  ctmtqgVnd: string | null;
  ratePmPct: string | null;
  rateTotalPct: string | null;
  rateNullReason: PublicRateReason | null;
  treasuryCoverage: PublicCoverage;
}

const plusKnown = (left: string | null, right: string | null): string | null => (left === null ? right : right === null ? left : (BigInt(left) + BigInt(right)).toString());

/** The sums of the lines of a class over the projects, as the database adds them for the rates of a group: the plan of both tiers, the figures that exist, whether every line is NONE and whether every line is COMPLETE. */
export function publicRateSums(lines: ReadonlyArray<PublicLine & { projectId: string }>, classCode: string): PublicRateSums {
  const own = lines.filter((line) => line.bucket === classCode);
  const known = (pick: (line: PublicLine) => string | null): string | null => own.map(pick).reduce<string | null>((total, value) => plusKnown(total, value), null);
  return {
    projects: new Set(own.map((line) => line.projectId)).size,
    planPmVnd: sum(own.map((line) => BigInt(line.planPmAssignedVnd))).toString(),
    planLocalVnd: sum(own.map((line) => BigInt(line.planLocalAddedVnd))).toString(),
    treasuryVnd: known((line) => line.disbursedTreasuryVnd),
    reportedVnd: known((line) => line.disbursedReportedVnd),
    ctmtqgVnd: known((line) => line.ctmtqgSubsetVnd),
    allNone: own.every((line) => line.treasuryCoverage === 'NONE'),
    allComplete: own.length > 0 && own.every((line) => line.treasuryCoverage === 'COMPLETE'),
  };
}

/** The sums of several groups as one (the groups of a snapshot never share a project, so the projects are added). */
export function addPublicSums(groups: readonly PublicRateSums[]): PublicRateSums {
  return groups.reduce<PublicRateSums>(
    (total, group) => ({
      projects: total.projects + group.projects,
      planPmVnd: (BigInt(total.planPmVnd) + BigInt(group.planPmVnd)).toString(),
      planLocalVnd: (BigInt(total.planLocalVnd) + BigInt(group.planLocalVnd)).toString(),
      treasuryVnd: plusKnown(total.treasuryVnd, group.treasuryVnd),
      reportedVnd: plusKnown(total.reportedVnd, group.reportedVnd),
      ctmtqgVnd: plusKnown(total.ctmtqgVnd, group.ctmtqgVnd),
      allNone: total.allNone && group.allNone,
      allComplete: total.allComplete && group.allComplete,
    }),
    { projects: 0, planPmVnd: '0', planLocalVnd: '0', treasuryVnd: null, reportedVnd: null, ctmtqgVnd: null, allNone: true, allComplete: true },
  );
}

/**
 * BR-DIS-04, BR-DIS-05, BR-DIS-08: the two rates of a group from the sums, never from the rates of its parts. The class of the basis is the one whose actual is the Treasury (the year plan: the Treasury is the numerator) or
 * another class (the capital carried over: what was reported over its own plan). `numeratorClass` names the class of the numerator the pack ratio reads; the Treasury is the headline only for the carrier class.
 */
export function publicRateFigures(pack: FundingPack, sums: PublicRateSums, classCode: string): PublicRateFigures {
  const carrier = treasuryCarrier(pack);
  const numeratorVnd = carrier !== undefined && classCode === carrier.classCode ? sums.treasuryVnd : sums.reportedVnd;
  const coverage: PublicCoverage = sums.projects === 0 || sums.allNone ? 'NONE' : sums.allComplete ? 'COMPLETE' : 'PARTIAL';
  const rates = publicRates({ disbursedVnd: numeratorVnd, planPrimaryVnd: sums.planPmVnd, planAddedVnd: sums.planLocalVnd, coverage });
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
    treasuryCoverage: coverage,
  };
}

export interface PublicIndicator {
  code: string;
  numeratorVnd: string | null;
  denominatorVnd: string;
  ratePct: string | null;
  nullReason: PublicRateReason | null;
  coverage: PublicCoverage;
  basis: 'TREASURY' | 'REPORTED';
}

/** The public ratios of the pack (`RATE_PM`, `RATE_TOTAL`, `RATE_CARRYOVER`) from the sums of the lines, each with its numerator and denominator, as the pack names them. */
export function publicIndicatorsOf(pack: FundingPack, lines: ReadonlyArray<PublicLine & { projectId: string }>): PublicIndicator[] {
  const found: PublicIndicator[] = [];
  for (const ratio of pack.ratios) {
    if (ratio.numerator !== 'TREASURY_YTD' && ratio.numerator !== 'REPORTED_CUMULATIVE') continue;
    const classCode = ratio.classFilter[0];
    if (classCode === undefined) continue;
    const figures = publicRateFigures(pack, publicRateSums(lines, classCode), classCode);
    const primary = ratio.denominator === 'PLAN_IN_FORCE_PRIMARY';
    const rate = primary ? figures.ratePmPct : figures.rateTotalPct;
    found.push({
      code: ratio.code,
      numeratorVnd: figures.numeratorVnd,
      denominatorVnd: primary ? figures.planPmVnd : figures.planTotalVnd,
      ratePct: rate,
      nullReason: rate === null ? figures.rateNullReason : null,
      coverage: figures.treasuryCoverage,
      basis: ratio.numerator === 'TREASURY_YTD' ? 'TREASURY' : 'REPORTED',
    });
  }
  return found;
}
