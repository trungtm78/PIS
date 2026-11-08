import { DomainError } from './errors.ts';
import { addSums, rateOfSums } from './dis-rates.ts';
import type { RateBasis, RateFigures, RateSums } from './dis-rates.ts';
import { groupRate } from './dis-snapshot.ts';
import { REALLOCATION_THRESHOLD_PCT } from './dis-forecast.ts';

/**
 * Reallocation of capital by performance (GOV-11a, G1-12): which projects are slow and which are fast, and what a proposed move does to the disbursement rates of the province, of each unit and of each project.
 * Everything here is pure: the figures of the frozen basis snapshot and the policy come in as arguments, the database and the clock stay outside. The rates are made by `rateOfSums` of `dis-rates.ts`, the same
 * function the rates of DIS are made by, so a simulation of no move at all reproduces the rates that DIS shows (the golden test of this module). Money is whole dong in decimal strings and `bigint`, never a float.
 */

/** The rule type that holds the policy, and the code of the policy of everybody (a province can approve codes of its own). */
export const REALLOCATION_POLICY_RULE_TYPE = 'REALLOCATION_POLICY';
export const REALLOCATION_POLICY_DEFAULT_CODE = 'DEFAULT';
/** The document type of the matrix of delegation (ADM) that limits who approves a proposal, by amount. */
export const REALLOCATION_DOA_DOCUMENT_TYPE = 'CAP_REALLOCATION';

export interface ReallocationPolicy {
  /** A project whose projected year end is below this share of its plan is a candidate to give capital (percent; the DIS threshold of 80 is the starting value). */
  donor_max_ratio_pct: number;
  /** A donor keeps what it is projected to disburse plus this margin (percent of the projection). */
  donor_keep_margin_pct: number;
  /** A project whose projected year end is at or above this share of its plan, and above the plan itself, is a candidate to receive (percent). */
  recipient_min_ratio_pct: number;
  /** The share of what a recipient receives, up to the demand it has above its plan, that it is assumed to disburse before the year end (percent). */
  absorption_pct: number;
  /** A move smaller than this (whole dong) is not suggested. */
  min_move_vnd: number;
  /** No more than this share of the plan of a donor is suggested to leave it in one proposal (percent). */
  max_share_of_donor_plan_pct: number;
  /** A proposal cannot be decided before its impact has been recorded. */
  simulation_required: boolean;
  /** The document type of the delegation matrix that limits the approver by amount. */
  delegation_document_type: string;
}

export function reallocationPolicyDefaults(): ReallocationPolicy {
  return {
    donor_max_ratio_pct: REALLOCATION_THRESHOLD_PCT,
    donor_keep_margin_pct: 5,
    recipient_min_ratio_pct: 100,
    absorption_pct: 100,
    min_move_vnd: 100_000_000,
    max_share_of_donor_plan_pct: 50,
    simulation_required: true,
    delegation_document_type: REALLOCATION_DOA_DOCUMENT_TYPE,
  };
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function pct(params: Record<string, unknown>, key: string, min = 0, max = 100): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(key);
  return value;
}

/** The params of a `REALLOCATION_POLICY` rule, checked: a rule that does not say all of it is refused rather than half applied. */
export function reallocationPolicyOf(params: unknown): ReallocationPolicy {
  if (!isRecord(params)) throw invalid('params');
  const minMove = params.min_move_vnd;
  if (typeof minMove !== 'number' || !Number.isInteger(minMove) || minMove < 0 || minMove > 1_000_000_000_000) throw invalid('min_move_vnd');
  if (typeof params.simulation_required !== 'boolean') throw invalid('simulation_required');
  const documentType = params.delegation_document_type;
  if (typeof documentType !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(documentType)) throw invalid('delegation_document_type');
  const policy: ReallocationPolicy = {
    donor_max_ratio_pct: pct(params, 'donor_max_ratio_pct'),
    donor_keep_margin_pct: pct(params, 'donor_keep_margin_pct', 0, 100),
    recipient_min_ratio_pct: pct(params, 'recipient_min_ratio_pct', 0, 1000),
    absorption_pct: pct(params, 'absorption_pct'),
    min_move_vnd: minMove,
    max_share_of_donor_plan_pct: pct(params, 'max_share_of_donor_plan_pct'),
    simulation_required: params.simulation_required,
    delegation_document_type: documentType,
  };
  // A recipient must not be a project that a donor rule could also pick.
  if (policy.recipient_min_ratio_pct < policy.donor_max_ratio_pct) throw invalid('recipient_min_ratio_pct');
  return policy;
}

// -- Arithmetic ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A percent with up to two decimals as whole hundredths, so that a comparison never needs a float. */
const hundredths = (value: number): bigint => BigInt(Math.round(value * 100));
const lesser = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const greater = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const ceilDiv = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/** A percent written `48.0000` as whole ten-thousandths. */
function scaledOf(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
}

/** The signed difference of two percents of four decimals (`after` less `before`), or null when either has no rate. */
export function rateDelta(before: string | null, after: string | null): string | null {
  if (before === null || after === null) return null;
  const difference = scaledOf(after) - scaledOf(before);
  const magnitude = difference < 0n ? -difference : difference;
  return `${difference < 0n ? '-' : ''}${magnitude / 10_000n}.${(magnitude % 10_000n).toString().padStart(4, '0')}`;
}

// -- The simulation ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the lines of the basis snapshot add up to for one project and one basis (the sums `rateOfSums` reads). */
export interface ImpactProject {
  projectId: string;
  unitId: string | null;
  sums: Readonly<Record<RateBasis, RateSums>>;
}

/** One move of a proposal, resolved to the lines it takes from and gives to: the bucket decides which rate it reaches, the split which of the two denominators. */
export interface ImpactMove {
  fromProjectId: string;
  toProjectId: string;
  amountVnd: string;
  bucket: string;
  split: 'PM' | 'LOCAL';
}

export interface ImpactGroup {
  /** The unit or the project; null for the whole province. */
  id: string | null;
  before: RateFigures;
  after: RateFigures;
  /** The change of the rate of the whole plan, in percentage points (four decimals, signed), null when either side has no rate. */
  deltaRateTotalPct: string | null;
  deltaRatePmPct: string | null;
}

export type ImpactWarningCode = 'MOVE_OUTSIDE_RATES' | 'PLAN_BELOW_ZERO' | 'ZERO_DENOMINATOR' | 'TREASURY_COVERAGE_PARTIAL' | 'UNKNOWN_PROJECT' | 'NO_PROJECTION_DATA';

export interface ImpactWarning {
  code: ImpactWarningCode;
  projectId: string | null;
  basis: RateBasis | null;
}

export interface BasisImpact {
  province: ImpactGroup;
  units: ImpactGroup[];
  /** The projects a move touches, in the order of their ids. */
  projects: ImpactGroup[];
}

export interface ProjectedInput {
  projectId: string;
  /** The plan of the year of the project in the basis snapshot (the sum of its lines of the year). */
  planTotalVnd: string;
  /** The year-end estimate of the project (`Estimate.eacVnd`), null when the Treasury booked nothing for it. */
  eacVnd: string | null;
}

export interface ProjectedFigures {
  planTotalVnd: string;
  /** What the projects with an estimate are expected to disburse by the year end, never above their plan. */
  disbursedVnd: string;
  /** Four decimals, null when there is no plan to divide by. */
  ratePct: string | null;
  projects: number;
}

export interface ProjectedImpact {
  before: ProjectedFigures;
  after: ProjectedFigures;
  deltaRatePct: string | null;
  /** Projects left out because they have no estimate. */
  excludedProjects: number;
  absorptionPct: number;
}

export interface ImpactResult {
  basis: Record<RateBasis, BasisImpact>;
  projected: ProjectedImpact | null;
  warnings: ImpactWarning[];
}

const BASIS_OF_BUCKET: Readonly<Record<string, RateBasis>> = { CURRENT_YEAR: 'CURRENT_YEAR', CARRYOVER: 'CARRYOVER' };

const sumsOf = (group: readonly RateSums[]): RateSums => addSums(group);

function groupOf(id: string | null, before: RateSums, after: RateSums, basis: RateBasis): ImpactGroup {
  const b = rateOfSums(before, basis);
  const a = rateOfSums(after, basis);
  return { id, before: b, after: a, deltaRateTotalPct: rateDelta(b.rateTotalPct, a.rateTotalPct), deltaRatePmPct: rateDelta(b.ratePmPct, a.ratePmPct) };
}

/** Applies the moves of one basis to the plan sums of the projects: the donor's plan falls and the recipient's rises by the amount, in the denominator the line belongs to. */
function movedSums(projects: ReadonlyMap<string, ImpactProject>, moves: readonly ImpactMove[], basis: RateBasis, warnings: ImpactWarning[]): Map<string, RateSums> {
  const result = new Map<string, RateSums>([...projects].map(([id, project]) => [id, project.sums[basis]]));
  const change = (projectId: string, split: 'PM' | 'LOCAL', delta: bigint): void => {
    const current = result.get(projectId);
    if (current === undefined) return;
    const field = split === 'PM' ? 'planPmVnd' : 'planLocalVnd';
    let next = BigInt(current[field]) + delta;
    if (next < 0n) {
      warnings.push({ code: 'PLAN_BELOW_ZERO', projectId, basis });
      next = 0n;
    }
    result.set(projectId, { ...current, [field]: next.toString() });
  };
  for (const move of moves) {
    if (BASIS_OF_BUCKET[move.bucket] !== basis) continue;
    const amount = BigInt(move.amountVnd);
    change(move.fromProjectId, move.split, -amount);
    change(move.toProjectId, move.split, amount);
  }
  return result;
}

/** The net change of the plan of the year of each project that the moves of the bucket CURRENT_YEAR make (positive for a recipient). */
function netYearChange(moves: readonly ImpactMove[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const move of moves) {
    if (move.bucket !== 'CURRENT_YEAR') continue;
    const amount = BigInt(move.amountVnd);
    net.set(move.fromProjectId, (net.get(move.fromProjectId) ?? 0n) - amount);
    net.set(move.toProjectId, (net.get(move.toProjectId) ?? 0n) + amount);
  }
  return net;
}

/**
 * The projected year end before and after the move (CURRENT_YEAR only). A project is expected to disburse its estimate but never more than its plan. After the move a donor is capped by its smaller plan, and a
 * recipient adds the part of what it receives that its demand above the plan can use, scaled by the absorption of the policy. Projects with no estimate (no Treasury data) are left out of both sides and counted.
 */
export function projectedImpact(projects: readonly ProjectedInput[], moves: readonly ImpactMove[], policy: Pick<ReallocationPolicy, 'absorption_pct'>): ProjectedImpact {
  const net = netYearChange(moves);
  let planBefore = 0n;
  let planAfter = 0n;
  let disbursedBefore = 0n;
  let disbursedAfter = 0n;
  let counted = 0;
  let excluded = 0;
  const absorption = hundredths(policy.absorption_pct);
  for (const project of projects) {
    if (project.eacVnd === null) {
      excluded += 1;
      continue;
    }
    counted += 1;
    const plan = BigInt(project.planTotalVnd);
    const eac = BigInt(project.eacVnd);
    const delta = net.get(project.projectId) ?? 0n;
    const planNew = greater(0n, plan + delta);
    const capped = lesser(eac, plan);
    let after = lesser(eac, planNew);
    if (delta > 0n) after = capped + (lesser(delta, greater(0n, eac - plan)) * absorption) / 10_000n;
    planBefore += plan;
    planAfter += planNew;
    disbursedBefore += capped;
    disbursedAfter += lesser(after, planNew);
  }
  const figures = (plan: bigint, disbursed: bigint): ProjectedFigures => ({
    planTotalVnd: plan.toString(),
    disbursedVnd: disbursed.toString(),
    ratePct: groupRate([{ numeratorVnd: disbursed.toString(), denominatorVnd: plan.toString() }]),
    projects: counted,
  });
  const before = figures(planBefore, disbursedBefore);
  const after = figures(planAfter, disbursedAfter);
  return { before, after, deltaRatePct: rateDelta(before.ratePct, after.ratePct), excludedProjects: excluded, absorptionPct: policy.absorption_pct };
}

/**
 * What the moves of a proposal do to the rates of the basis snapshot: for each basis (the year plan and the capital carried over) the rates before and after for the province, for every unit and for the projects
 * the moves touch; and, when estimates are given, the projected year end. With no move, `after` equals `before` and both are the rates DIS shows (golden test). A move whose bucket reaches no rate
 * is reported, not ignored in silence.
 */
export function simulateReallocation(input: { projects: readonly ImpactProject[]; moves: readonly ImpactMove[]; projections?: readonly ProjectedInput[] | undefined; policy?: Pick<ReallocationPolicy, 'absorption_pct'> | undefined }): ImpactResult {
  const warnings: ImpactWarning[] = [];
  const projects = new Map(input.projects.map((project) => [project.projectId, project]));
  for (const move of input.moves) {
    for (const id of [move.fromProjectId, move.toProjectId]) {
      if (!projects.has(id) && !warnings.some((warning) => warning.code === 'UNKNOWN_PROJECT' && warning.projectId === id)) warnings.push({ code: 'UNKNOWN_PROJECT', projectId: id, basis: null });
    }
    if (BASIS_OF_BUCKET[move.bucket] === undefined) warnings.push({ code: 'MOVE_OUTSIDE_RATES', projectId: move.fromProjectId, basis: null });
  }
  const touched = new Set(input.moves.flatMap((move) => [move.fromProjectId, move.toProjectId]).filter((id) => projects.has(id)));
  const basis = {} as Record<RateBasis, BasisImpact>;
  for (const name of ['CURRENT_YEAR', 'CARRYOVER'] as const) {
    const after = movedSums(projects, input.moves, name, warnings);
    const unitIds = [...new Set(input.projects.map((project) => project.unitId))].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    const inUnit = (unitId: string | null): ImpactProject[] => input.projects.filter((project) => project.unitId === unitId);
    const province = groupOf(null, sumsOf(input.projects.map((project) => project.sums[name])), sumsOf([...after.values()]), name);
    if (province.before.treasuryCoverage === 'PARTIAL') warnings.push({ code: 'TREASURY_COVERAGE_PARTIAL', projectId: null, basis: name });
    if (province.before.rateNullReason === 'ZERO_DENOMINATOR') warnings.push({ code: 'ZERO_DENOMINATOR', projectId: null, basis: name });
    basis[name] = {
      province,
      units: unitIds.map((unitId) => groupOf(unitId, sumsOf(inUnit(unitId).map((project) => project.sums[name])), sumsOf(inUnit(unitId).map((project) => after.get(project.projectId) ?? project.sums[name])), name)),
      projects: [...touched].sort().map((id) => groupOf(id, (projects.get(id) as ImpactProject).sums[name], after.get(id) ?? (projects.get(id) as ImpactProject).sums[name], name)),
    };
  }
  let projected: ProjectedImpact | null = null;
  if (input.projections !== undefined) {
    projected = projectedImpact(input.projections, input.moves, input.policy ?? reallocationPolicyDefaults());
    if (projected.before.projects === 0) warnings.push({ code: 'NO_PROJECTION_DATA', projectId: null, basis: 'CURRENT_YEAR' });
  }
  return { basis, projected, warnings };
}

// -- Candidates by performance -------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface CandidateInput {
  projectId: string;
  unitId: string | null;
  planTotalVnd: string;
  /** The year-end estimate, null when the Treasury booked nothing for the project (no data is not zero). */
  eacVnd: string | null;
  /** What is reserved, committed and disbursed on the lines of the project: a donor keeps at least this much. */
  floorVnd: string;
}

export type CandidateExclusion = 'NO_ESTIMATE' | 'NO_PLAN' | 'BELOW_MIN_MOVE' | 'WITHIN_RANGE';

export interface DonorCandidate {
  projectId: string;
  unitId: string | null;
  planTotalVnd: string;
  eacVnd: string;
  /** The projected year end as a share of the plan (four decimals). */
  ratioPct: string;
  /** What the project is projected not to use (plan less the projection and its margin), never below what is already spoken for. */
  surplusVnd: string;
  /** What may leave it in one proposal: the surplus within the share cap of the policy. */
  releasableVnd: string;
}

export interface RecipientCandidate {
  projectId: string;
  unitId: string | null;
  planTotalVnd: string;
  eacVnd: string;
  ratioPct: string;
  /** What the estimate is above the plan: the demand a move can fund. */
  demandVnd: string;
}

export interface CandidateResult {
  donors: DonorCandidate[];
  recipients: RecipientCandidate[];
  excluded: Array<{ projectId: string; reason: CandidateExclusion }>;
}

/**
 * The slow and the fast by the policy (G1-12). A donor is projected below `donor_max_ratio_pct` of its plan; what it can release is its plan less the larger of what is already spoken for and its projection with
 * the margin, within the share cap and at least the minimum move. A recipient is projected at or above `recipient_min_ratio_pct` and above its plan; its demand is the part above. Donors come slowest first,
 * recipients fastest first, ties by project id, so the order never depends on the order the projects were read.
 */
export function reallocationCandidates(projects: readonly CandidateInput[], policy: ReallocationPolicy): CandidateResult {
  const donors: DonorCandidate[] = [];
  const recipients: RecipientCandidate[] = [];
  const excluded: CandidateResult['excluded'] = [];
  const donorLine = hundredths(policy.donor_max_ratio_pct);
  const recipientLine = hundredths(policy.recipient_min_ratio_pct);
  const margin = hundredths(policy.donor_keep_margin_pct);
  const share = hundredths(policy.max_share_of_donor_plan_pct);
  const minMove = BigInt(policy.min_move_vnd);
  for (const project of projects) {
    const plan = BigInt(project.planTotalVnd);
    if (project.eacVnd === null) {
      excluded.push({ projectId: project.projectId, reason: 'NO_ESTIMATE' });
      continue;
    }
    if (plan <= 0n) {
      excluded.push({ projectId: project.projectId, reason: 'NO_PLAN' });
      continue;
    }
    const eac = BigInt(project.eacVnd);
    const ratioPct = groupRate([{ numeratorVnd: project.eacVnd, denominatorVnd: project.planTotalVnd }]) as string;
    if (eac * 10_000n < plan * donorLine) {
      const keep = greater(BigInt(project.floorVnd), ceilDiv(eac * (10_000n + margin), 10_000n));
      const surplus = greater(0n, plan - keep);
      const releasable = lesser(surplus, (plan * share) / 10_000n);
      if (releasable < minMove) {
        excluded.push({ projectId: project.projectId, reason: 'BELOW_MIN_MOVE' });
        continue;
      }
      donors.push({ projectId: project.projectId, unitId: project.unitId, planTotalVnd: project.planTotalVnd, eacVnd: project.eacVnd, ratioPct, surplusVnd: surplus.toString(), releasableVnd: releasable.toString() });
    } else if (eac > plan && eac * 10_000n >= plan * recipientLine) {
      const demand = eac - plan;
      if (demand < minMove) {
        excluded.push({ projectId: project.projectId, reason: 'BELOW_MIN_MOVE' });
        continue;
      }
      recipients.push({ projectId: project.projectId, unitId: project.unitId, planTotalVnd: project.planTotalVnd, eacVnd: project.eacVnd, ratioPct, demandVnd: demand.toString() });
    } else {
      excluded.push({ projectId: project.projectId, reason: 'WITHIN_RANGE' });
    }
  }
  donors.sort((a, b) => Number(scaledOf(a.ratioPct) - scaledOf(b.ratioPct)) || (a.projectId < b.projectId ? -1 : 1));
  recipients.sort((a, b) => Number(scaledOf(b.ratioPct) - scaledOf(a.ratioPct)) || (a.projectId < b.projectId ? -1 : 1));
  excluded.sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
  return { donors, recipients, excluded };
}

/** The assumptions a recorded impact carries, so a reader sees what the numbers rest on without reading the rule. */
export function impactAssumptions(policy: ReallocationPolicy, version: number, source: 'RULE' | 'DEFAULT'): Record<string, unknown> {
  return { rule_type: REALLOCATION_POLICY_RULE_TYPE, rule_version: version, rule_source: source, ...policy };
}
