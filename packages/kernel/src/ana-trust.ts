import { DomainError } from './errors.ts';
import type { RuleParams } from './governance-rules.ts';

/**
 * The trust the leader can put in a figure (G3-7, BI and DGV): how old a dataset is against its SLA ("stale data" appears by itself), and a scorecard of data quality per module and per unit made of the signals the
 * platform already holds (freshness, the quality run of the dataset, the certification, the completeness and coverage of the units, the explanations that are overdue). Every score is 0 to 100 or null with a reason:
 * a signal that is not there is never read as good and never as zero, and a composite that stands on too few signals is N/A. All thresholds and weights are governance rules (unverified until the tenant approves them).
 */

export const FRESHNESS_RULE_TYPE = 'FRESHNESS_SLA';
export const FRESHNESS_DEFAULT_CODE = 'DEFAULT';
export const SCORECARD_MODULE_RULE_TYPE = 'SCORECARD_MODULE';
export const SCORECARD_UNIT_RULE_TYPE = 'SCORECARD_UNIT';
export const SCORECARD_RULE_CODE = 'DEFAULT';

/** The rule code of a dataset: its catalogue code in upper case with every run of other characters turned into an underscore (`DS-DISB` is `DS_DISB`). */
export const freshnessRuleCodeOf = (datasetCode: string): string => datasetCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export interface FreshnessSla {
  slaHours: number;
  /** The share of the SLA after which a dataset is "due": still inside the SLA, but close to its end. */
  dueAfterPct: number;
}

export const FRESHNESS_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  DEFAULT: { sla_hours: 192, due_after_pct: 80 },
  DS_DISB: { sla_hours: 192, due_after_pct: 80 },
  DS_CTR: { sla_hours: 192, due_after_pct: 80 },
};

const fail = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
function whole(params: RuleParams, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = params[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw fail(field);
  return value;
}

export function freshnessSlaOf(params: RuleParams): FreshnessSla {
  return { slaHours: whole(params, 'sla_hours', 1, 8760), dueAfterPct: whole(params, 'due_after_pct', 1, 100) };
}

export type FreshnessStatus = 'FRESH' | 'DUE' | 'STALE' | 'NO_DATA';
export interface FreshnessReading {
  status: FreshnessStatus;
  /** Hours since the last build, one decimal; null when there is none. */
  ageHours: number | null;
  slaHours: number;
  /** Hours the age is over the SLA (stale only). */
  overdueHours: number | null;
  nullReason: 'NEVER_BUILT' | null;
}

/**
 * The state of a dataset on a day: no build at all is NO_DATA (never invented as fresh); an age up to the share of the SLA is FRESH, up to the SLA itself is DUE, and over it is STALE. Exactly at the SLA is
 * still DUE: it is late only after it. A build in the future of the clock (skew) is an age of 0.
 */
export function judgeFreshness(lastBuiltAt: string | null, now: Date, sla: FreshnessSla): FreshnessReading {
  if (lastBuiltAt === null) return { status: 'NO_DATA', ageHours: null, slaHours: sla.slaHours, overdueHours: null, nullReason: 'NEVER_BUILT' };
  const built = Date.parse(lastBuiltAt);
  if (Number.isNaN(built)) return { status: 'NO_DATA', ageHours: null, slaHours: sla.slaHours, overdueHours: null, nullReason: 'NEVER_BUILT' };
  const tenths = Math.max(0, Math.floor(((now.getTime() - built) * 10) / 3_600_000));
  const age = tenths / 10;
  const dueFrom = (sla.slaHours * sla.dueAfterPct) / 100;
  if (age <= dueFrom) return { status: 'FRESH', ageHours: age, slaHours: sla.slaHours, overdueHours: null, nullReason: null };
  if (age <= sla.slaHours) return { status: 'DUE', ageHours: age, slaHours: sla.slaHours, overdueHours: null, nullReason: null };
  return { status: 'STALE', ageHours: age, slaHours: sla.slaHours, overdueHours: Math.round((age - sla.slaHours) * 10) / 10, nullReason: null };
}

// ---- the scorecard ------------------------------------------------------------------------------------------------------------------------------------

export interface ModuleScorecardPolicy {
  weights: { freshness: number; quality: number; certification: number };
  dueScore: number;
  warningScore: number;
  confirmedScore: number;
  draftScore: number;
  minDimensions: number;
  goodFrom: number;
  fairFrom: number;
}
export interface UnitScorecardPolicy {
  weights: { completeness: number; coverage: number; timeliness: number };
  overduePenalty: number;
  minDimensions: number;
  goodFrom: number;
  fairFrom: number;
}

export const SCORECARD_MODULE_DEFAULTS: Readonly<Record<string, unknown>> = {
  w_freshness: 40,
  w_quality: 40,
  w_certification: 20,
  due_score: 60,
  warning_score: 60,
  confirmed_score: 60,
  draft_score: 20,
  min_dimensions: 2,
  good_from: 80,
  fair_from: 60,
};
export const SCORECARD_UNIT_DEFAULTS: Readonly<Record<string, unknown>> = { w_completeness: 40, w_coverage: 40, w_timeliness: 20, overdue_penalty: 20, min_dimensions: 2, good_from: 80, fair_from: 60 };

export function moduleScorecardPolicyOf(params: RuleParams): ModuleScorecardPolicy {
  const policy: ModuleScorecardPolicy = {
    weights: { freshness: whole(params, 'w_freshness', 0, 100), quality: whole(params, 'w_quality', 0, 100), certification: whole(params, 'w_certification', 0, 100) },
    dueScore: whole(params, 'due_score', 0, 100),
    warningScore: whole(params, 'warning_score', 0, 100),
    confirmedScore: whole(params, 'confirmed_score', 0, 100),
    draftScore: whole(params, 'draft_score', 0, 100),
    minDimensions: whole(params, 'min_dimensions', 1, 3),
    goodFrom: whole(params, 'good_from', 1, 100),
    fairFrom: whole(params, 'fair_from', 0, 99),
  };
  if (policy.fairFrom >= policy.goodFrom) throw fail('fair_from');
  if (policy.weights.freshness + policy.weights.quality + policy.weights.certification === 0) throw fail('w_freshness');
  return policy;
}

export function unitScorecardPolicyOf(params: RuleParams): UnitScorecardPolicy {
  const policy: UnitScorecardPolicy = {
    weights: { completeness: whole(params, 'w_completeness', 0, 100), coverage: whole(params, 'w_coverage', 0, 100), timeliness: whole(params, 'w_timeliness', 0, 100) },
    overduePenalty: whole(params, 'overdue_penalty', 0, 100),
    minDimensions: whole(params, 'min_dimensions', 1, 3),
    goodFrom: whole(params, 'good_from', 1, 100),
    fairFrom: whole(params, 'fair_from', 0, 99),
  };
  if (policy.fairFrom >= policy.goodFrom) throw fail('fair_from');
  if (policy.weights.completeness + policy.weights.coverage + policy.weights.timeliness === 0) throw fail('w_completeness');
  return policy;
}

export interface Dimension {
  code: string;
  weight: number;
  /** 0 to 100, or null when the signal is not there. */
  score: number | null;
  nullReason: string | null;
}
export type ScoreBand = 'GOOD' | 'FAIR' | 'POOR';
export interface ScorecardRow {
  dimensions: Dimension[];
  composite: number | null;
  compositeNullReason: 'TOO_FEW_DIMENSIONS' | null;
  usedDimensions: number;
  band: ScoreBand | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The weighted mean of the dimensions that have a score (a dimension with weight 0 is shown and does not count); N/A below the minimum number of dimensions that stand. */
export function compositeOf(dimensions: readonly Dimension[], rule: { minDimensions: number; goodFrom: number; fairFrom: number }): ScorecardRow {
  const standing = dimensions.filter((dimension) => dimension.score !== null && dimension.weight > 0);
  const weight = standing.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (standing.length < rule.minDimensions || weight === 0) return { dimensions: [...dimensions], composite: null, compositeNullReason: 'TOO_FEW_DIMENSIONS', usedDimensions: standing.length, band: null };
  const composite = round1(standing.reduce((sum, dimension) => sum + dimension.weight * (dimension.score as number), 0) / weight);
  return { dimensions: [...dimensions], composite, compositeNullReason: null, usedDimensions: standing.length, band: composite >= rule.goodFrom ? 'GOOD' : composite >= rule.fairFrom ? 'FAIR' : 'POOR' };
}

const present = (code: string, weight: number, score: number): Dimension => ({ code, weight, score, nullReason: null });
const absent = (code: string, weight: number, nullReason: string): Dimension => ({ code, weight, score: null, nullReason });

export type QualityBadgeLike = 'NOT_ASSESSED' | 'PASSED' | 'WARNING' | 'FAILED' | 'STALE';
export type CertificationLike = 'DRAFT' | 'CONFIRMED' | 'CERTIFIED' | 'OBSOLETE';

/** The scorecard of a module from its dataset: freshness, the quality badge of the latest version and the certification of the dataset. */
export function moduleScorecard(input: { freshness: FreshnessStatus; quality: QualityBadgeLike | null; certification: CertificationLike | null }, policy: ModuleScorecardPolicy): ScorecardRow {
  const { weights } = policy;
  const freshness =
    input.freshness === 'NO_DATA' ? absent('FRESHNESS', weights.freshness, 'NEVER_BUILT') : present('FRESHNESS', weights.freshness, input.freshness === 'FRESH' ? 100 : input.freshness === 'DUE' ? policy.dueScore : 0);
  const quality =
    input.quality === null || input.quality === 'NOT_ASSESSED'
      ? absent('QUALITY', weights.quality, 'NOT_ASSESSED')
      : present('QUALITY', weights.quality, input.quality === 'PASSED' ? 100 : input.quality === 'WARNING' ? policy.warningScore : 0);
  const certification =
    input.certification === null
      ? absent('CERTIFICATION', weights.certification, 'NO_CERTIFICATION')
      : present('CERTIFICATION', weights.certification, input.certification === 'CERTIFIED' ? 100 : input.certification === 'CONFIRMED' ? policy.confirmedScore : input.certification === 'DRAFT' ? policy.draftScore : 0);
  return compositeOf([freshness, quality, certification], policy);
}

/** The scorecard of a unit: how many of its projects have a Treasury figure, how much of the early-warning factors had data, and how many explanations are overdue. */
export function unitScorecard(input: { projects: number; projectsWithoutData: number; coveragePct: number | null; overdueExplanations: number | null }, policy: UnitScorecardPolicy): ScorecardRow {
  const { weights } = policy;
  const completeness = input.projects <= 0 ? absent('COMPLETENESS', weights.completeness, 'NO_PROJECTS') : present('COMPLETENESS', weights.completeness, round1(((input.projects - input.projectsWithoutData) / input.projects) * 100));
  const coverage = input.coveragePct === null ? absent('COVERAGE', weights.coverage, 'NOT_SCORED') : present('COVERAGE', weights.coverage, Math.max(0, Math.min(100, round1(input.coveragePct))));
  const timeliness = input.overdueExplanations === null ? absent('TIMELINESS', weights.timeliness, 'NOT_READABLE') : present('TIMELINESS', weights.timeliness, Math.max(0, 100 - policy.overduePenalty * input.overdueExplanations));
  return compositeOf([completeness, coverage, timeliness], policy);
}
