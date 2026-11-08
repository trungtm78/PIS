import { analyticsPercent, indicatorNotApplicable, indicatorOk, indicatorRatio, wholeAmount } from './ctr-analytics.ts';
import type { IndicatorResult } from './ctr-analytics.ts';
import type { PaymentClockParams } from './ctr-reports.ts';
import { DomainError } from './errors.ts';
import type { EacMethod, EvmPolicy } from './gov-b1-policy.ts';
import { firstLevelRootOf, plannedValueAt, ratioOf } from './prj-baseline.ts';
import { computeEvm, lineEvm, ragOf, sCurveDays } from './prj-evm.ts';
import type { AcceptanceFact, EvmLineFacts, EvmMissing, EvmRag, PaymentFact } from './prj-evm.ts';
import { isCalendarDate } from './retention.ts';

/**
 * The money reports of the contract portfolio (CA-2): what the reports R3 to R7 add to the foundation of CA-1. Every figure here is a pure function of plain rows, so that the database reads only the rows and the
 * screens, the files and the tests judge them with the same code: the earned value of a contract and of a selection and its S-curve (R3), the three-way match of measured work, acceptance, request and payment and the
 * payment requests inside their clock (R4), the advance recovered as fast as the work was accepted (R5), the guarantee and the retention that fall due (R6), and the growth through changes by tier (R7).
 * The rules that hold: money is whole dong in text; a ratio is of sums; what cannot be known is NOT_APPLICABLE with its reason and never 0; nothing is read from a frozen snapshot that the snapshot does not hold.
 */

const big = (value: string | null | undefined): bigint => (value === null || value === undefined ? 0n : BigInt(value));
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const hundredthsOf = (value: number): bigint => BigInt(Math.round(value * 100));

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n * 2n + d) / (2n * d);
  return negative ? -rounded : rounded;
}

// ---- three-way match: measured work, acceptance, request, payment (R4) ------------------------------------------------------------------------------------------

export const MATCH_STATUSES = ['MATCHED', 'MEASURED_NOT_ACCEPTED', 'REQUEST_NOT_ACCEPTED', 'ACCEPTED_WITHOUT_MEASUREMENT', 'OVER_PAID', 'NO_ACTIVITY'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const THREE_WAY_RULE = 'CONTRACT_THREE_WAY_MATCH';

/** The params of the rule `CONTRACT_THREE_WAY_MATCH`: a gap between two of the four figures is tolerated up to the larger of a sum of money and a share of the larger of the two figures. */
export interface ThreeWayParams {
  tolerance_pct: number;
  tolerance_vnd: number;
}

/** Provisional working values awaiting the confirmation of the business owner and the audit: not law (any legal tolerance is configuration flagged unverified until it is signed). */
export const threeWayDefaults = (): ThreeWayParams => ({ tolerance_pct: 2, tolerance_vnd: 1_000_000 });

export function threeWayParams(raw: unknown): ThreeWayParams {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('params');
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== 'tolerance_pct' && key !== 'tolerance_vnd') throw bad(key);
  const pct = record.tolerance_pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100 || Math.round(pct * 100) / 100 !== pct) throw bad('tolerance_pct');
  const amount = record.tolerance_vnd;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 1_000_000_000_000) throw bad('tolerance_vnd');
  return { tolerance_pct: pct, tolerance_vnd: amount };
}

export interface ThreeWayFigures {
  measuredVnd: string;
  requestedVnd: string;
  acceptedVnd: string;
  paidVnd: string;
}

/** Whether two figures are the same within the tolerance: the gap, in ten-thousandths of a dong, against the larger of the sum and the share (percent in hundredths) of the larger figure. Exact, no float. */
function within(a: bigint, b: bigint, params: ThreeWayParams): boolean {
  const gap = a > b ? a - b : b - a;
  const base = a > b ? a : b;
  const sum = BigInt(params.tolerance_vnd) * 10_000n;
  const share = base * hundredthsOf(params.tolerance_pct);
  return gap * 10_000n <= (sum > share ? sum : share);
}

/**
 * The state of the four figures of a contract, the worst first: paid beyond what was accepted; accepted beyond what was measured; requested beyond what was accepted; measured and not yet accepted (the backlog of the
 * Investor, not a fault); else matched. A contract with none of the four has no activity, which is not a match.
 */
export function matchStatusOf(figures: ThreeWayFigures, params: ThreeWayParams): MatchStatus {
  const measured = wholeAmount(figures.measuredVnd, 'measured_vnd');
  const requested = wholeAmount(figures.requestedVnd, 'requested_vnd');
  const accepted = wholeAmount(figures.acceptedVnd, 'accepted_vnd');
  const paid = wholeAmount(figures.paidVnd, 'paid_vnd');
  if (measured === 0n && requested === 0n && accepted === 0n && paid === 0n) return 'NO_ACTIVITY';
  if (paid > accepted && !within(paid, accepted, params)) return 'OVER_PAID';
  if (accepted > measured && !within(accepted, measured, params)) return 'ACCEPTED_WITHOUT_MEASUREMENT';
  if (requested > accepted && !within(requested, accepted, params)) return 'REQUEST_NOT_ACCEPTED';
  if (measured > accepted && !within(measured, accepted, params)) return 'MEASURED_NOT_ACCEPTED';
  return 'MATCHED';
}

/** What the database compares against in its own statement of the same rule: the tolerance as whole dong and as hundredths of a percent. */
export const threeWaySqlArguments = (params: ThreeWayParams): { toleranceVnd: string; toleranceHundredths: string } => ({ toleranceVnd: String(params.tolerance_vnd), toleranceHundredths: hundredthsOf(params.tolerance_pct).toString() });

/** MEASURED_TO_ACCEPTED over sums: accepted / measured, in percent. */
export function measuredToAcceptedOfSums(sums: { acceptedVnd: string; measuredVnd: string }): IndicatorResult {
  const measured = wholeAmount(sums.measuredVnd, 'measured_vnd');
  if (measured === 0n) return indicatorNotApplicable('MEASURED_TO_ACCEPTED', 'NO_MEASURED_WORK', big(sums.acceptedVnd), 0n);
  return indicatorRatio('MEASURED_TO_ACCEPTED', wholeAmount(sums.acceptedVnd, 'accepted_vnd'), measured);
}

// ---- the payment clock, request by request ------------------------------------------------------------------------------------------------------------------

export interface PaymentSteps {
  /** Days from the approval of the acceptance to the submission of the request (a request of kind ADVANCE has none); null when it has no such step behind it. */
  acceptanceToRequestDays: number | null;
  /** Days from the submission to the Treasury (only a request that was sent has it). */
  requestToTreasuryDays: number | null;
}

export type PaymentJudgement = 'ON_TIME' | 'LATE' | 'NOT_JUDGED';

/** A request with neither step behind it is not judged (it is not "on time", it is too early to say); with at least one it is late as soon as a step took more days than the rule allows. */
export function paymentJudgement(steps: PaymentSteps, clock: PaymentClockParams): PaymentJudgement {
  if (steps.acceptanceToRequestDays === null && steps.requestToTreasuryDays === null) return 'NOT_JUDGED';
  const late = (steps.acceptanceToRequestDays !== null && steps.acceptanceToRequestDays > clock.acceptance_to_request_days) || (steps.requestToTreasuryDays !== null && steps.requestToTreasuryDays > clock.request_to_treasury_days);
  return late ? 'LATE' : 'ON_TIME';
}

export interface PaymentTiming {
  judged: number;
  onTime: number;
}

export function onTimePaymentRateOfCounts(counts: PaymentTiming): IndicatorResult {
  if (counts.judged === 0) return indicatorNotApplicable('ON_TIME_PAYMENT_RATE', 'NO_PAYMENT_JUDGED', BigInt(counts.onTime), 0n);
  return indicatorRatio('ON_TIME_PAYMENT_RATE', BigInt(counts.onTime), BigInt(counts.judged));
}

export function timingOfRequests(requests: readonly PaymentSteps[], clock: PaymentClockParams): PaymentTiming {
  let judged = 0;
  let onTime = 0;
  for (const request of requests) {
    const found = paymentJudgement(request, clock);
    if (found === 'NOT_JUDGED') continue;
    judged += 1;
    if (found === 'ON_TIME') onTime += 1;
  }
  return { judged, onTime };
}

// ---- advance recovered as fast as the work was accepted (R5) ----------------------------------------------------------------------------------------------------

export const RECOVERY_STATUSES = ['BEHIND', 'ON_TRACK', 'RECOVERED'] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export interface AdvanceRecoveryFigures {
  advancePaidVnd: string;
  advanceRecoveredVnd: string;
  acceptedVnd: string;
  contractValueVnd: string;
}

export interface AdvanceRecovery {
  /** What should have been recovered by now if the advance is taken back in step with the accepted work: advance x accepted share of the contract, half up to the dong. */
  expectedVnd: string;
  /** What is short of that, never below zero. */
  shortfallVnd: string;
  outstandingVnd: string;
  status: RecoveryStatus;
}

/**
 * The recovery of an advance against the accepted work. `toleranceVnd` is what may stay owed and still count as recovered (the rule ADVANCE_RECOVERY of the money control). Null when the contract has no advance or no
 * value to measure the work against: the caller says which of the two it was.
 */
export function advanceRecoveryOf(figures: AdvanceRecoveryFigures, toleranceVnd: bigint): AdvanceRecovery | null {
  const paid = wholeAmount(figures.advancePaidVnd, 'advance_paid_vnd');
  const value = wholeAmount(figures.contractValueVnd, 'contract_value_vnd');
  if (paid <= 0n || value <= 0n) return null;
  const accepted = wholeAmount(figures.acceptedVnd, 'accepted_vnd');
  const recovered = wholeAmount(figures.advanceRecoveredVnd, 'advance_recovered_vnd');
  const expected = roundDiv(paid * (accepted > value ? value : accepted), value);
  const shortfall = expected > recovered ? expected - recovered : 0n;
  const outstanding = paid - recovered;
  const status: RecoveryStatus = outstanding <= toleranceVnd ? 'RECOVERED' : shortfall > toleranceVnd ? 'BEHIND' : 'ON_TRACK';
  return { expectedVnd: expected.toString(), shortfallVnd: shortfall.toString(), outstandingVnd: outstanding.toString(), status };
}

export interface RecoverySums {
  expectedVnd: string;
  shortfallVnd: string;
  rows: number;
}

/** ADVANCE_RECOVERY_SHORTFALL over sums of the contracts that have an advance and a value. */
export function advanceRecoveryShortfallOfSums(sums: RecoverySums): IndicatorResult {
  if (sums.rows === 0) return indicatorNotApplicable('ADVANCE_RECOVERY_SHORTFALL', 'NO_ADVANCE');
  const shortfall = wholeAmount(sums.shortfallVnd, 'advance_shortfall');
  return indicatorOk('ADVANCE_RECOVERY_SHORTFALL', shortfall.toString(), shortfall, null);
}

// ---- guarantee in force and retention that falls due (R6) -------------------------------------------------------------------------------------------------------

/** GUARANTEE_EXPOSURE over sums: what the contracts that require a guarantee lack of it on the as-of day. */
export function guaranteeExposureOfSums(sums: { requiredVnd: string; validVnd: string; rows: number }): IndicatorResult {
  if (sums.rows === 0) return indicatorNotApplicable('GUARANTEE_EXPOSURE', 'NO_GUARANTEE_REQUIRED');
  const exposure = wholeAmount(sums.requiredVnd, 'required_vnd') - wholeAmount(sums.validVnd, 'valid_vnd');
  return indicatorOk('GUARANTEE_EXPOSURE', exposure.toString(), exposure, null);
}

export const RETENTION_LADDER_KEYS = ['DUE_NOW', 'WITHIN_30', 'WITHIN_90', 'LATER', 'NO_DATE'] as const;
export const GUARANTEE_LADDER_KEYS = ['LAPSED', 'WITHIN_30', 'WITHIN_90', 'LATER'] as const;
export type RetentionBand = (typeof RETENTION_LADDER_KEYS)[number];
export type GuaranteeBand = (typeof GUARANTEE_LADDER_KEYS)[number];
/** Days ahead of the as-of day the two ladders look. */
export const LADDER_NEAR_DAYS = 30;
export const LADDER_FAR_DAYS = 90;

function dayNumber(value: string, field: string): number {
  if (!isCalendarDate(value)) throw invalid(field);
  return Math.round(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
}

/** When the money held back may leave: from the day its condition allows (due now), within 30 days, within 90, later, or with no day set (it waits for its condition or a decision). */
export function retentionBandOf(releaseNotBefore: string | null, asOf: string): RetentionBand {
  if (releaseNotBefore === null) return 'NO_DATE';
  const left = dayNumber(releaseNotBefore, 'release_not_before') - dayNumber(asOf, 'as_of');
  return left <= 0 ? 'DUE_NOW' : left <= LADDER_NEAR_DAYS ? 'WITHIN_30' : left <= LADDER_FAR_DAYS ? 'WITHIN_90' : 'LATER';
}

/** How soon a guarantee that is on the register lapses: already lapsed (still marked active), within 30 days, within 90, later. The expiry day itself is still in force. */
export function guaranteeBandOf(expiresOn: string, asOf: string): GuaranteeBand {
  const left = dayNumber(expiresOn, 'expires_on') - dayNumber(asOf, 'as_of');
  return left < 0 ? 'LAPSED' : left <= LADDER_NEAR_DAYS ? 'WITHIN_30' : left <= LADDER_FAR_DAYS ? 'WITHIN_90' : 'LATER';
}

/** A line of a ladder: how many holds or guarantees and how much money (whole dong). */
export interface LadderGroup {
  key: string;
  count: number;
  amountVnd: string;
}

export interface ExposureLadders {
  retention: LadderGroup[];
  guarantee: LadderGroup[];
}

/** The groups of a ladder in the order they are shown, a group with nothing in it kept (as a count of zero, which is a figure: it was looked for) so that the ladder always has the same steps. */
export function ladderOf(keys: readonly string[], found: ReadonlyArray<{ key: string; count: number; amountVnd: string }>): LadderGroup[] {
  return keys.map((key) => {
    const rows = found.filter((row) => row.key === key);
    return { key, count: rows.reduce((acc, row) => acc + row.count, 0), amountVnd: rows.reduce((acc, row) => acc + big(row.amountVnd), 0n).toString() };
  });
}

/** What one contract has coming due: retention that may be released now and guarantee in force that lapses within 90 days. Null where the contract has none of the thing at all. */
export interface ExposureRow {
  retentionDueNowVnd: string | null;
  guaranteeExpiringVnd: string | null;
}

// ---- growth through changes by tier (R7) ----------------------------------------------------------------------------------------------------------------------

export const CHANGE_TIER_KEYS = ['TIER_1', 'TIER_2', 'TIER_3', 'UNTIERED'] as const;
export type ChangeTierKey = (typeof CHANGE_TIER_KEYS)[number];

export const tierKeyOf = (tier: number | null): ChangeTierKey => (tier === 1 ? 'TIER_1' : tier === 2 ? 'TIER_2' : tier === 3 ? 'TIER_3' : 'UNTIERED');

/** The approved changes of one tier (of one contract, or of a selection): how many, the signed sum of their deltas and the highest cumulative variation any of them reached. */
export interface TierDelta {
  tier: number | null;
  count: number;
  deltaVnd: string;
  maxCumulativePct: string | null;
}

export interface TierGroup {
  key: ChangeTierKey;
  count: number;
  /** Null when no approved change has the tier (no change is not a delta of zero). */
  deltaVnd: string | null;
  growth: IndicatorResult;
  /** The share of the whole growth through changes the tier is, in percent; null when the tiers add up to zero (a share of nothing). */
  shareOfGrowthPct: string | null;
  maxCumulativePct: string | null;
}

export interface TierSplit {
  originalValueVnd: string;
  totalDeltaVnd: string;
  totalCount: number;
  groups: TierGroup[];
}

/** CHANGE_TIER_GROWTH of one tier: the sum of its deltas over the original value of the whole selection, so that the tiers add up to the CHANGE_GROWTH of the selection. */
export function tierGrowthOf(deltaVnd: string, originalValueVnd: string): IndicatorResult {
  return indicatorRatio('CHANGE_TIER_GROWTH', wholeAmount(deltaVnd, 'approved_delta_vnd'), wholeAmount(originalValueVnd, 'original_value_vnd'));
}

/**
 * The growth through changes cut by the tier of each change. The denominator is the original value of ALL the contracts of the selection, whichever tier their changes are of, so the growth of the tiers sum to the
 * growth of the selection (CHANGE_GROWTH): a tier is read as "how much of the growth is this tier". `UNTIERED` is shown only when an approved change has no tier (a change approved before tiers existed).
 */
export function tierSplitOf(found: readonly TierDelta[], originalValueVnd: string): TierSplit {
  const byKey = new Map<ChangeTierKey, TierDelta>();
  for (const row of found) {
    const key = tierKeyOf(row.tier);
    const before = byKey.get(key);
    byKey.set(key, {
      tier: row.tier,
      count: (before?.count ?? 0) + row.count,
      deltaVnd: (big(before?.deltaVnd) + big(row.deltaVnd)).toString(),
      maxCumulativePct: [before?.maxCumulativePct ?? null, row.maxCumulativePct].reduce<string | null>((best, next) => (next === null ? best : best === null || Number(next) > Number(best) ? next : best), null),
    });
  }
  const total = [...byKey.values()].reduce((acc, row) => acc + big(row.deltaVnd), 0n);
  const totalCount = [...byKey.values()].reduce((acc, row) => acc + row.count, 0);
  const keys = CHANGE_TIER_KEYS.filter((key) => key !== 'UNTIERED' || (byKey.get('UNTIERED')?.count ?? 0) > 0);
  const groups = keys.map((key): TierGroup => {
    const row = byKey.get(key);
    if (row === undefined || row.count === 0) return { key, count: 0, deltaVnd: null, growth: indicatorNotApplicable('CHANGE_TIER_GROWTH', 'NO_CHANGE'), shareOfGrowthPct: null, maxCumulativePct: null };
    return {
      key,
      count: row.count,
      deltaVnd: row.deltaVnd,
      growth: tierGrowthOf(row.deltaVnd, originalValueVnd),
      shareOfGrowthPct: total === 0n ? null : analyticsPercent(big(row.deltaVnd), total),
      maxCumulativePct: row.maxCumulativePct,
    };
  });
  return { originalValueVnd, totalDeltaVnd: total.toString(), totalCount, groups };
}

// ---- earned value of a contract, of a selection of contracts and its S-curve (R3) -----------------------------------------------------------------------------------

/** A contract linked to a first-level package of its project (`project_component_contract`, an open link). */
export interface EvmLinkFact {
  contractId: string;
  projectId: string;
  componentId: string;
  /** The value of the contract now, whole dong. */
  valueVnd: string;
}

export interface EvmBaselineLine {
  key: string;
  code: string;
  name: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
}

export interface EvmProjectFact {
  projectId: string;
  /** Every component of the project with its parent (null for a first-level one). */
  parents: ReadonlyMap<string, string | null>;
  /** The versions of the baseline, oldest first: version 0 is the first when it was taken. */
  versions: ReadonlyArray<{ version: number; lines: readonly EvmBaselineLine[] }>;
}

/** The share of the package a contract carries, as the lines of the baseline in force and of version 0; or why there is none. */
export interface ContractEvmLines {
  contractId: string;
  current: EvmLineFacts | null;
  v0: EvmLineFacts | null;
  missing: Extract<EvmMissing, 'NO_BASELINE' | 'NO_CONTRACT_LINK'> | null;
}

/**
 * The line of the baseline each linked contract stands for. A contract carries the first-level package its component belongs to; where several contracts carry one package, each takes the share of the budget of the package
 * that its value is of the values of all the carriers (the rule of `PrjEvmStore.pick`, scope CONTRACT, so a contract and the project agree). A contract whose project has no baseline, or whose package is not in the baseline in force, is
 * NO_BASELINE.
 */
export function contractEvmLines(links: readonly EvmLinkFact[], projects: readonly EvmProjectFact[]): Map<string, ContractEvmLines> {
  const byProject = new Map(projects.map((project) => [project.projectId, project]));
  const result = new Map<string, ContractEvmLines>();
  const rootOf = (link: EvmLinkFact): string | undefined => {
    const project = byProject.get(link.projectId);
    return project === undefined ? undefined : firstLevelRootOf(link.componentId, project.parents);
  };
  const carriers = new Map<string, EvmLinkFact[]>();
  for (const link of links) {
    const root = rootOf(link);
    if (root === undefined) continue;
    const key = `${link.projectId}|${root}`;
    carriers.set(key, [...(carriers.get(key) ?? []), link]);
  }
  for (const link of links) {
    const project = byProject.get(link.projectId);
    const root = rootOf(link);
    const first = project?.versions[0];
    const last = project?.versions[project.versions.length - 1];
    const current = last?.lines.find((line) => line.key === root);
    if (project === undefined || root === undefined || last === undefined || current === undefined) {
      result.set(link.contractId, { contractId: link.contractId, current: null, v0: null, missing: 'NO_BASELINE' });
      continue;
    }
    const total = (carriers.get(`${link.projectId}|${root}`) ?? [link]).reduce((acc, one) => acc + BigInt(one.valueVnd), 0n);
    const share = (line: EvmBaselineLine): EvmLineFacts => ({
      key: line.key,
      code: line.code,
      name: line.name,
      bacVnd: (total === 0n ? 0n : roundDiv(BigInt(line.bacVnd) * BigInt(link.valueVnd), total)).toString(),
      plannedStart: line.plannedStart,
      plannedFinish: line.plannedFinish,
      contracts: [{ contractId: link.contractId, valueVnd: link.valueVnd }],
    });
    const zero = first !== undefined && first.version === 0 ? first.lines.find((line) => line.key === root) : undefined;
    result.set(link.contractId, { contractId: link.contractId, current: share(current), v0: zero === undefined ? null : share(zero), missing: null });
  }
  return result;
}

export type EvmCellReason = EvmMissing;

/** The earned value figures of one contract on the as-of day; every figure is null, with the reason, when the contract has none. */
export interface ContractEvmResult {
  contractId: string;
  reason: EvmCellReason | null;
  bacVnd: string | null;
  pvVnd: string | null;
  evVnd: string | null;
  acVnd: string | null;
  svVnd: string | null;
  spi: string | null;
  cpi: string | null;
  /** Why an index is empty when the others are not: a division by zero is not an index of zero. */
  spiReason: 'PV_ZERO' | null;
  cpiReason: 'AC_ZERO' | null;
  ragSpi: EvmRag | null;
  ragCpi: EvmRag | null;
}

const emptyResult = (contractId: string, reason: EvmCellReason): ContractEvmResult => ({ contractId, reason, bacVnd: null, pvVnd: null, evVnd: null, acVnd: null, svVnd: null, spi: null, cpi: null, spiReason: null, cpiReason: null, ragSpi: null, ragCpi: null });

export interface EvmFacts {
  acceptances: readonly AcceptanceFact[];
  payments: readonly PaymentFact[];
}

const groupBy = <T extends { contractId: string }>(items: readonly T[]): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(item.contractId, [...(out.get(item.contractId) ?? []), item]);
  return out;
};

export interface EvmSetup {
  asOf: string;
  method: EacMethod;
  policy: Pick<EvmPolicy, 'amberBelow' | 'redBelow'>;
}

/** The earned value of one contract on the day, from the line it stands for and its own acceptances and certified payments: the figures of `lineEvm` and `computeEvm`, which are the ones of the project. */
export function contractEvmAt(lines: ContractEvmLines, facts: EvmFacts, setup: EvmSetup): ContractEvmResult {
  if (lines.missing !== null || lines.current === null) return emptyResult(lines.contractId, lines.missing ?? 'NO_BASELINE');
  const line = lineEvm(lines.current, setup.asOf, facts.acceptances, facts.payments);
  if (line.missing.length > 0 || line.evVnd === null || line.acVnd === null) return emptyResult(lines.contractId, line.missing[0] ?? 'NO_BASELINE');
  const figures = computeEvm({ bac: line.bacVnd, pv: line.pvVnd, ev: line.evVnd, ac: line.acVnd, missing: [] }, setup.method, setup.policy, setup.asOf);
  return {
    contractId: lines.contractId,
    reason: null,
    bacVnd: line.bacVnd.toString(),
    pvVnd: line.pvVnd.toString(),
    evVnd: line.evVnd.toString(),
    acVnd: line.acVnd.toString(),
    svVnd: (line.evVnd - line.pvVnd).toString(),
    spi: figures.spi,
    cpi: figures.cpi,
    spiReason: figures.unavailable.spi === 'PV_ZERO' ? 'PV_ZERO' : null,
    cpiReason: figures.unavailable.cpi === 'AC_ZERO' ? 'AC_ZERO' : null,
    ragSpi: ragOf(figures.spi, setup.policy),
    ragCpi: ragOf(figures.cpi, setup.policy),
  };
}

/** The earned value of a selection of contracts: the sums over the contracts that have figures, how many those are, and how many have none for which reason. */
export interface SelectionEvm {
  /** The contracts the selection holds that the reader may see the ledger of. */
  contracts: number;
  covered: number;
  /** How many contracts have no figure, by reason (`NO_CONTRACT_LINK`, `NO_BASELINE`, `CONTRACT_VALUE_ZERO`, `NO_SCHEDULE`). */
  missing: Record<string, number>;
  bacVnd: string | null;
  pvVnd: string | null;
  evVnd: string | null;
  acVnd: string | null;
  svVnd: string | null;
  spi: IndicatorResult;
  cpi: IndicatorResult;
  ragSpi: EvmRag | null;
  ragCpi: EvmRag | null;
  /** Of the covered contracts, how many have version 0 of the baseline (the S-curve draws the original plan only when all of them do). */
  v0Contracts: number;
}

/**
 * The sums of a selection from the results of its contracts. SPI and CPI are ratios of the sums (never the mean of the indices of the contracts); a ratio with nothing to divide by is NOT_APPLICABLE with its reason. When
 * no contract has figures the sums are null, never 0.
 */
export function selectionEvmOf(results: readonly ContractEvmResult[], unlinkedContracts: number, v0Contracts: number, setup: EvmSetup): SelectionEvm {
  const covered = results.filter((result) => result.reason === null);
  const missing: Record<string, number> = {};
  if (unlinkedContracts > 0) missing.NO_CONTRACT_LINK = unlinkedContracts;
  for (const result of results) if (result.reason !== null) missing[result.reason] = (missing[result.reason] ?? 0) + 1;
  const sum = (pick: (result: ContractEvmResult) => string | null): bigint => covered.reduce((acc, result) => acc + big(pick(result)), 0n);
  const contracts = results.length + unlinkedContracts;
  const base = { contracts, covered: covered.length, missing, v0Contracts };
  if (covered.length === 0) {
    // When the two are equally many the more telling one is named: a contract that is linked and has no baseline to stand on.
    const reason: 'NO_CONTRACT_LINK' | 'NO_BASELINE' = (missing.NO_CONTRACT_LINK ?? 0) > (missing.NO_BASELINE ?? 0) ? 'NO_CONTRACT_LINK' : 'NO_BASELINE';
    return { ...base, bacVnd: null, pvVnd: null, evVnd: null, acVnd: null, svVnd: null, spi: indicatorNotApplicable('SPI', contracts === 0 ? 'NO_CONTRACT_LINK' : reason), cpi: indicatorNotApplicable('CPI', contracts === 0 ? 'NO_CONTRACT_LINK' : reason), ragSpi: null, ragCpi: null };
  }
  const bac = sum((r) => r.bacVnd);
  const pv = sum((r) => r.pvVnd);
  const ev = sum((r) => r.evVnd);
  const ac = sum((r) => r.acVnd);
  const spi = ratioOf(ev, pv);
  const cpi = ratioOf(ev, ac);
  return {
    ...base,
    bacVnd: bac.toString(),
    pvVnd: pv.toString(),
    evVnd: ev.toString(),
    acVnd: ac.toString(),
    svVnd: (ev - pv).toString(),
    spi: spi === null ? indicatorNotApplicable('SPI', 'PV_ZERO', ev, pv) : indicatorOk('SPI', spi, ev, pv),
    cpi: cpi === null ? indicatorNotApplicable('CPI', 'AC_ZERO', ev, ac) : indicatorOk('CPI', cpi, ev, ac),
    ragSpi: ragOf(spi, setup.policy),
    ragCpi: ragOf(cpi, setup.policy),
  };
}

/** The contracts of a selection with their lines, results and the sums: what the store hands the report. */
export interface EvmReading {
  rows: Map<string, ContractEvmResult>;
  selection: SelectionEvm;
  lines: Map<string, ContractEvmLines>;
}

/** The earned value of every linked contract of a selection and the sums, from the facts the store read. */
export function evmOfContracts(input: { links: readonly EvmLinkFact[]; projects: readonly EvmProjectFact[]; facts: EvmFacts; unlinkedContracts: number; setup: EvmSetup }): EvmReading {
  const lines = contractEvmLines(input.links, input.projects);
  const acceptances = groupBy(input.facts.acceptances);
  const payments = groupBy(input.facts.payments);
  const rows = new Map<string, ContractEvmResult>();
  for (const link of input.links) {
    const own = lines.get(link.contractId);
    if (own === undefined) continue;
    rows.set(link.contractId, contractEvmAt(own, { acceptances: acceptances.get(link.contractId) ?? [], payments: payments.get(link.contractId) ?? [] }, input.setup));
  }
  const v0 = [...rows.values()].filter((result) => result.reason === null && lines.get(result.contractId)?.v0 !== null).length;
  return { rows, selection: selectionEvmOf([...rows.values()], input.unlinkedContracts, v0, input.setup), lines };
}

export interface EvmCurvePoint {
  day: string;
  /** Planned by version 0 of the baseline; null when no covered contract has version 0 (a missing plan is not a flat line at zero). */
  pvV0Vnd: string | null;
  pvCurrentVnd: string;
  /** Earned and cost up to the day of the view; null after it. */
  evVnd: string | null;
  acVnd: string | null;
}

export interface EvmCurve {
  asOf: string;
  points: EvmCurvePoint[];
  /** Whether version 0 is there for every contract on the curve: when it is not, the original plan drawn covers only some of them. */
  v0Complete: boolean;
  v0Contracts: number;
  contracts: number;
}

/**
 * The S-curve of a selection: the planned value by the baseline in force and by version 0, summed over the contracts that have figures, and the earned value and the cost up to the as-of day, drawn at the end of every month
 * and on the day of the view. The earned value and the cost of each contract are those of `lineEvm` on that day, over the acceptances and payments of the contract only, so a point of the curve is the figure the table
 * would give for that day.
 */
export function evmCurveOf(reading: EvmReading, facts: EvmFacts, asOf: string): EvmCurve {
  if (!isCalendarDate(asOf)) throw invalid('as_of');
  const covered = [...reading.rows.values()].filter((result) => result.reason === null).map((result) => reading.lines.get(result.contractId)).filter((one): one is ContractEvmLines & { current: EvmLineFacts } => one?.current !== undefined && one.current !== null);
  if (covered.length === 0) return { asOf, points: [], v0Complete: false, v0Contracts: 0, contracts: 0 };
  const everyLine = covered.flatMap((one) => (one.v0 === null ? [one.current] : [one.current, one.v0]));
  const from = everyLine.reduce((first, line) => (line.plannedStart < first ? line.plannedStart : first), everyLine[0]?.plannedStart ?? asOf);
  const to = everyLine.reduce((last, line) => (line.plannedFinish > last ? line.plannedFinish : last), everyLine[0]?.plannedFinish ?? asOf);
  const acceptances = groupBy(facts.acceptances);
  const payments = groupBy(facts.payments);
  const withV0 = covered.filter((one) => one.v0 !== null);
  const points = sCurveDays(from, to, asOf).map((day): EvmCurvePoint => {
    let current = 0n;
    for (const one of covered) current += plannedValueAt(one.current, day);
    let original: bigint | null = null;
    if (withV0.length > 0) {
      original = 0n;
      for (const one of withV0) original += plannedValueAt(one.v0 as EvmLineFacts, day);
    }
    let ev: bigint | null = null;
    let ac: bigint | null = null;
    if (day <= asOf) {
      ev = 0n;
      ac = 0n;
      for (const one of covered) {
        const line = lineEvm(one.current, day, acceptances.get(one.contractId) ?? [], payments.get(one.contractId) ?? []);
        if (line.evVnd === null || line.acVnd === null) {
          ev = null;
          ac = null;
          break;
        }
        ev += line.evVnd;
        ac += line.acVnd;
      }
    }
    return { day, pvV0Vnd: original === null ? null : original.toString(), pvCurrentVnd: current.toString(), evVnd: ev === null ? null : ev.toString(), acVnd: ac === null ? null : ac.toString() };
  });
  return { asOf, points, v0Complete: withV0.length === covered.length, v0Contracts: withV0.length, contracts: covered.length };
}

// ---- the extras a report row reads ---------------------------------------------------------------------------------------------------------------------------------

/** What the rows of the page need beyond the fact (read live, never from a frozen snapshot): each map is keyed by contract id; a contract missing from a map has nothing of that kind. */
export interface ReportExtras {
  evm: ReadonlyMap<string, ContractEvmResult>;
  timing: ReadonlyMap<string, PaymentTiming>;
  tiers: ReadonlyMap<string, readonly TierDelta[]>;
  exposure: ReadonlyMap<string, ExposureRow>;
}

/** The same kinds for the whole selection: the totals row and the groups read these. */
export interface ReportTotalExtras {
  evm: SelectionEvm | null;
  timing: PaymentTiming | null;
  tiers: readonly TierDelta[] | null;
  exposure: { retentionDueNowVnd: string; guaranteeExpiringVnd: string } | null;
}
