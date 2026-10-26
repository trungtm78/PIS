import { sha256Hex, canonicalJson } from './canonical-json.ts';
import { TREASURY_GAP_THRESHOLD_PCT } from './dis-review.ts';
import { BUDGET_LEVELS, FUNDING_BUCKETS } from './dis-report.ts';
import type { BudgetLevel, FundingBucket } from './dis-report.ts';

/**
 * The period snapshot (ST-DIS-009, DIS 3 F6): what the executive figures of a period are taken from. The formulas below are PROPOSALS until the capital business owner signs the definitions (D03,
 * CXN-03): every snapshot carries the name of the set of formulas it was built with and says so until the definitions are signed.
 */
export const SNAPSHOT_KINDS = ['PERIOD_CLOSE', 'ADHOC', 'MNE'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];
export const METRIC_SET_VERSION = 'DIS-METRICS-R1-PROPOSED';
export const DEFINITION_STATUSES = ['PROPOSED_PENDING_SIGNOFF', 'SIGNED'] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

export const COVERAGE = { complete: 'COMPLETE', partial: 'PARTIAL', none: 'NONE' } as const;
export type TreasuryCoverage = (typeof COVERAGE)[keyof typeof COVERAGE];
export type RateNullReason = 'ZERO_DENOMINATOR' | 'NO_DATA' | 'TREASURY_COVERAGE_NONE';

const RATE_SCALE = 10_000n;
const HUNDRED = 100n;

/** A percent with four decimals, rounded half up, from whole numbers: written `48.0000`. Never a float. */
function percentWithFourDecimals(numerator: bigint, denominator: bigint): string {
  const scaled = (numerator * HUNDRED * RATE_SCALE * 2n + denominator) / (2n * denominator);
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE).toString().padStart(4, '0');
  return `${whole}.${fraction}`;
}

export interface Rates {
  ratePmPct: string | null;
  rateTotalPct: string | null;
  nullReason: RateNullReason | null;
}

/**
 * BR-DIS-05 [CXN-03, proposal]: one numerator, two denominators. The rate on the plan the Prime Minister gave is D over that plan; the rate on the whole plan is D over that plan and what the
 * province or the ministry added. The first can pass 100%. A rate with nothing to divide by, or nothing to divide, is null with its reason, never zero (BR-DIS-08).
 */
export function ratesOf(input: { disbursedVnd: string | null; planPmVnd: string; planLocalVnd: string; coverage: TreasuryCoverage }): Rates {
  const pm = BigInt(input.planPmVnd);
  const total = pm + BigInt(input.planLocalVnd);
  // BR-DIS-08 names the plan first: with nothing to divide by there is no rate, whatever else is missing.
  if (total === 0n) return { ratePmPct: null, rateTotalPct: null, nullReason: 'ZERO_DENOMINATOR' };
  if (input.disbursedVnd === null) return { ratePmPct: null, rateTotalPct: null, nullReason: input.coverage === COVERAGE.none ? 'TREASURY_COVERAGE_NONE' : 'NO_DATA' };
  const disbursed = BigInt(input.disbursedVnd);
  // A refund of what the Treasury paid before the year can leave the net of the year below zero: that is not a rate of disbursement, it is a figure to be looked at, so no rate is given (assumption until D03).
  if (disbursed < 0n) return { ratePmPct: null, rateTotalPct: null, nullReason: 'NO_DATA' };
  const ratePmPct = pm === 0n ? null : percentWithFourDecimals(disbursed, pm);
  const rateTotalPct = percentWithFourDecimals(disbursed, total);
  return { ratePmPct, rateTotalPct, nullReason: ratePmPct === null ? 'ZERO_DENOMINATOR' : null };
}

/** BR-DIS-04: the rate of a group is the sum of the numerators over the sum of the denominators, never the mean of the rates; null when there is nothing to divide by. */
export function groupRate(parts: ReadonlyArray<{ numeratorVnd: string; denominatorVnd: string }>): string | null {
  const numerator = parts.reduce((total, part) => total + BigInt(part.numeratorVnd), 0n);
  const denominator = parts.reduce((total, part) => total + BigInt(part.denominatorVnd), 0n);
  return denominator === 0n ? null : percentWithFourDecimals(numerator, denominator);
}

/** A transaction of the Treasury as the snapshot counts it: the amount, whether it takes an earlier payment back, and the day it was paid (Vietnam time). */
export interface TreasuryEntry {
  amountVnd: string;
  reversal: boolean;
  paidOn: string;
}

/**
 * BR-DIS-06 [CXN-03, proposal]: what the Treasury paid, by the day it paid it, on or before the cutoff (and on or after `from` when the figure is of a year); a refund takes off on the day of the
 * refund, not on the day of the payment it takes back. Null when it booked nothing in the window: no figure is not a figure of zero.
 */
export function treasuryDisbursed(entries: readonly TreasuryEntry[], cutoff: string, from: string | null = null): { totalVnd: string; transactions: number } | null {
  const counted = entries.filter((entry) => entry.paidOn <= cutoff && (from === null || entry.paidOn >= from));
  if (counted.length === 0) return null;
  const total = counted.reduce((sum, entry) => sum + (entry.reversal ? -BigInt(entry.amountVnd) : BigInt(entry.amountVnd)), 0n);
  return { totalVnd: total.toString(), transactions: counted.length };
}

/** How far the data of the Treasury can be trusted next to the report: none when it booked nothing, partial when there is no accepted report to compare with or the two differ by more than 5% (assumption). */
export function coverageOf(input: { treasuryVnd: string | null; reportedVnd: string | null }): TreasuryCoverage {
  if (input.treasuryVnd === null) return COVERAGE.none;
  if (input.reportedVnd === null) return COVERAGE.partial;
  const treasury = BigInt(input.treasuryVnd);
  if (treasury < 0n) return COVERAGE.partial;
  const reported = BigInt(input.reportedVnd);
  if (reported === 0n) return treasury === 0n ? COVERAGE.complete : COVERAGE.partial;
  const gap = (treasury - reported) * 100n;
  return (gap < 0n ? -gap : gap) > TREASURY_GAP_THRESHOLD_PCT * reported ? COVERAGE.partial : COVERAGE.complete;
}

/** The plan the Prime Minister gave (and the capital carried over from it) is one part of a denominator; what a province, a ministry or a revenue increase adds is the other (assumption until D03). */
export function planSplitOf(origin: string | null): 'PM' | 'LOCAL' {
  return origin === 'LOCAL_ADDED' || origin === 'CENTRAL_SUPPORT' || origin === 'REVENUE_INCREASE' ? 'LOCAL' : 'PM';
}

export interface PlanCell {
  bucket: FundingBucket;
  budgetLevel: BudgetLevel;
  amountVnd: string;
  origin: string | null;
  fundSourceVersionId: string | null;
}

export interface ReportedCell {
  bucket: FundingBucket;
  budgetLevel: BudgetLevel;
  cumulativeVnd: string;
  ctmtqgVnd: string | null;
  nextMonthVnd: string;
}

/** What the build reads of a project: the plan in force at the end of the period, the accepted report of the period, the period before it, and the Treasury. */
export interface SnapshotProject {
  projectId: string;
  unitId: string;
  planVersionId: string | null;
  plans: readonly PlanCell[];
  reported: { reportRevisionId: string; cells: readonly ReportedCell[] } | null;
  /** The cumulative of each cell in the period before, `CURRENT_YEAR/CENTRAL` and so on; none when there is none. */
  previous: ReadonlyMap<string, string> | null;
  treasury: readonly TreasuryEntry[];
  /** The first day the Treasury figure counts from (the first day of the year); null for all time. */
  treasuryFrom?: string | null;
}

export interface SnapshotLine {
  bucket: FundingBucket;
  budgetLevel: BudgetLevel;
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
  rateNullReason: RateNullReason | null;
  treasuryCoverage: TreasuryCoverage;
  reportRevisionId: string | null;
  planVersionId: string | null;
}

const cellKey = (bucket: string, level: string): string => `${bucket}/${level}`;

/**
 * The lines of a project in a snapshot: one for each of the six cells of the report, in the order of the form (BR-DIS-01). The cumulative is that of the accepted report of the period, never a sum of
 * the periods (BR-DIS-02); a cell nobody reported is null, not zero. The Treasury pays a project, not a source, so its figure is carried once, on the year plan of the central budget, with the
 * rates of the year plan: the plan of both budget levels of the year is what the rates divide by.
 */
export function buildLines(project: SnapshotProject, cutoff: string): SnapshotLine[] {
  const treasury = treasuryDisbursed(project.treasury, cutoff, project.treasuryFrom ?? null);
  const reportedTotal = project.reported === null ? null : project.reported.cells.reduce((sum, cell) => sum + BigInt(cell.cumulativeVnd), 0n).toString();
  const coverage = coverageOf({ treasuryVnd: treasury?.totalVnd ?? null, reportedVnd: reportedTotal });
  const yearPlan = project.plans.filter((plan) => plan.bucket === 'CURRENT_YEAR');
  const yearPm = yearPlan.filter((plan) => planSplitOf(plan.origin) === 'PM').reduce((sum, plan) => sum + BigInt(plan.amountVnd), 0n);
  const yearLocal = yearPlan.filter((plan) => planSplitOf(plan.origin) === 'LOCAL').reduce((sum, plan) => sum + BigInt(plan.amountVnd), 0n);
  const carried = ratesOf({ disbursedVnd: treasury?.totalVnd ?? null, planPmVnd: yearPm.toString(), planLocalVnd: yearLocal.toString(), coverage });

  const lines: SnapshotLine[] = [];
  for (const bucket of FUNDING_BUCKETS) {
    for (const budgetLevel of BUDGET_LEVELS) {
      const plans = project.plans.filter((plan) => plan.bucket === bucket && plan.budgetLevel === budgetLevel);
      const pm = plans.filter((plan) => planSplitOf(plan.origin) === 'PM').reduce((sum, plan) => sum + BigInt(plan.amountVnd), 0n);
      const local = plans.filter((plan) => planSplitOf(plan.origin) === 'LOCAL').reduce((sum, plan) => sum + BigInt(plan.amountVnd), 0n);
      const reported = project.reported?.cells.find((cell) => cell.bucket === bucket && cell.budgetLevel === budgetLevel);
      const before = project.previous?.get(cellKey(bucket, budgetLevel));
      const carrier = bucket === 'CURRENT_YEAR' && budgetLevel === 'CENTRAL';
      lines.push({
        bucket,
        budgetLevel,
        fundSourceVersionId: plans.find((plan) => plan.fundSourceVersionId !== null)?.fundSourceVersionId ?? null,
        planPmAssignedVnd: pm.toString(),
        planLocalAddedVnd: local.toString(),
        planTotalVnd: (pm + local).toString(),
        disbursedTreasuryVnd: carrier ? (treasury?.totalVnd ?? null) : null,
        disbursedReportedVnd: reported?.cumulativeVnd ?? null,
        periodDeltaVnd: reported === undefined || before === undefined ? null : (BigInt(reported.cumulativeVnd) - BigInt(before)).toString(),
        registeredMonthVnd: reported?.nextMonthVnd ?? null,
        forecastEacVnd: null,
        ctmtqgSubsetVnd: reported?.ctmtqgVnd ?? null,
        ratePmPct: carrier ? carried.ratePmPct : null,
        rateTotalPct: carrier ? carried.rateTotalPct : null,
        rateNullReason: carrier ? carried.nullReason : 'NO_DATA',
        treasuryCoverage: coverage,
        reportRevisionId: project.reported?.reportRevisionId ?? null,
        planVersionId: project.planVersionId,
      });
    }
  }
  return lines;
}

export interface SnapshotHeader {
  periodId: string;
  snapshotKind: SnapshotKind;
  asOfDate: string;
  treasuryCutoffDate: string;
  metricSetVersion: string;
  definitionStatus: DefinitionStatus;
}

export type HashedLine = SnapshotLine & { projectId: string; unitId: string };

/** The SHA-256 of a snapshot: its header and every line, in an order that does not depend on how they were read, so that the same figures give the same hash and a changed figure does not. */
export function snapshotHash(header: SnapshotHeader, lines: readonly HashedLine[]): string {
  const ordered = [...lines].sort((a, b) => (a.projectId + cellKey(a.bucket, a.budgetLevel)).localeCompare(b.projectId + cellKey(b.bucket, b.budgetLevel)));
  return sha256Hex(canonicalJson({ header, lines: ordered }));
}
