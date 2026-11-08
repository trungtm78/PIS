import { DomainError } from './errors.ts';
import { SCALE_MAX, riskLevelOf, riskScore } from './prj-risk.ts';
import type { RiskLevel } from './prj-risk.ts';

/**
 * The register of risks scored from live signals (MR-1, MR.02, G1-14): five kinds of signal each read from the facts of the system, an indicator of a kind compared with four rising thresholds of the governance rule
 * `RISK_SIGNAL_POLICY` gives a likelihood from 1 to 5, a fixed impact for the kind gives the other side of the 5 by 5 scale of PRJ-16, and the score is their product. Pure functions of their input: the rule is
 * read by the caller and passed in, nothing here knows a threshold, and a figure that could not be known is `null` (never zero), so an unknown reading never raises or clears a risk.
 */

export const RISK_SIGNAL_RULE_TYPE = 'RISK_SIGNAL_POLICY';
export const RISK_SIGNAL_RULE_CODE = 'DEFAULT';

export const RISK_SIGNAL_KINDS = ['SCHEDULE_DELAY', 'PAYMENT_INTEGRITY', 'CLAIM_EARLY_WARNING', 'FUNDING_GAP', 'PROCUREMENT_DELAY'] as const;
export type RiskSignalKind = (typeof RISK_SIGNAL_KINDS)[number];

/** The indicators the job measures, each belonging to one kind of signal. */
export const RISK_INDICATORS = [
  'SPI_SHORTFALL_PCT',
  'MILESTONE_SLIP_DAYS',
  'PAYMENT_BLOCKED_DRAFTS',
  'PAYMENT_SIGNAL_REQUESTS',
  'OPEN_CLAIMS',
  'EARLY_WARNINGS_HIGH',
  'FUNDING_GAP_PCT',
  'PROCUREMENT_SLIP_DAYS',
] as const;
export type RiskIndicator = (typeof RISK_INDICATORS)[number];

export const INDICATOR_KIND: Readonly<Record<RiskIndicator, RiskSignalKind>> = {
  SPI_SHORTFALL_PCT: 'SCHEDULE_DELAY',
  MILESTONE_SLIP_DAYS: 'SCHEDULE_DELAY',
  PAYMENT_BLOCKED_DRAFTS: 'PAYMENT_INTEGRITY',
  PAYMENT_SIGNAL_REQUESTS: 'PAYMENT_INTEGRITY',
  OPEN_CLAIMS: 'CLAIM_EARLY_WARNING',
  EARLY_WARNINGS_HIGH: 'CLAIM_EARLY_WARNING',
  FUNDING_GAP_PCT: 'FUNDING_GAP',
  PROCUREMENT_SLIP_DAYS: 'PROCUREMENT_DELAY',
};

export const RISK_ALERT_TYPES = ['RISK_SCORE_CRITICAL', 'RISK_SCORE_JUMP'] as const;
export type RiskAlertType = (typeof RISK_ALERT_TYPES)[number];

/** Four rising thresholds: a figure from the first gives likelihood 2, from the second 3, from the third 4, from the fourth 5; below the first it is 1. */
export type Thresholds = readonly [number, number, number, number];

export interface RiskSignalPolicy {
  /** The impact (1 to 5) of each kind of signal. */
  impact: Readonly<Record<RiskSignalKind, number>>;
  thresholds: Readonly<Record<RiskIndicator, Thresholds>>;
  /** A line is open while its likelihood is at least this (2 to 5). */
  openFromLikelihood: number;
  /** The score from which the alert RISK_SCORE_CRITICAL is raised (1 to 25). */
  criticalScore: number;
  /** The points a score rises by in one pass for the alert RISK_SCORE_JUMP (1 to 24). */
  jumpPoints: number;
  /** The statuses of a project whose signals are scored. */
  scoredStatuses: readonly string[];
}

/** The starting values of the rule (the research, to be confirmed with the owner of the business): flagged not verified wherever they are shown. */
export const RISK_SIGNAL_DEFAULTS: RiskSignalPolicy = {
  impact: { SCHEDULE_DELAY: 4, PAYMENT_INTEGRITY: 4, CLAIM_EARLY_WARNING: 3, FUNDING_GAP: 5, PROCUREMENT_DELAY: 3 },
  thresholds: {
    SPI_SHORTFALL_PCT: [5, 10, 20, 30],
    MILESTONE_SLIP_DAYS: [7, 14, 30, 60],
    PAYMENT_BLOCKED_DRAFTS: [1, 2, 3, 5],
    PAYMENT_SIGNAL_REQUESTS: [1, 2, 4, 8],
    OPEN_CLAIMS: [1, 2, 3, 5],
    EARLY_WARNINGS_HIGH: [1, 2, 3, 5],
    FUNDING_GAP_PCT: [5, 10, 20, 40],
    PROCUREMENT_SLIP_DAYS: [7, 14, 30, 60],
  },
  openFromLikelihood: 2,
  criticalScore: 15,
  jumpPoints: 6,
  scoredStatuses: ['BUDGETED', 'IMPLEMENTATION', 'SUSPENDED'],
};

const invalid = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The params of the rule in the shape the code reads: 422 `GOVERNANCE_RULE_PARAMS_INVALID` naming the field the rule is wrong in. */
export function parseRiskSignalPolicy(raw: unknown): RiskSignalPolicy {
  if (!isRecord(raw)) throw invalid('params');
  const impactRaw = raw.impact;
  const thresholdRaw = raw.thresholds;
  if (!isRecord(impactRaw)) throw invalid('impact');
  if (!isRecord(thresholdRaw)) throw invalid('thresholds');
  const impact = {} as Record<RiskSignalKind, number>;
  for (const kind of RISK_SIGNAL_KINDS) {
    const value = impactRaw[kind];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SCALE_MAX) throw invalid(`impact.${kind}`);
    impact[kind] = value;
  }
  const thresholds = {} as Record<RiskIndicator, Thresholds>;
  for (const indicator of RISK_INDICATORS) {
    const value = thresholdRaw[indicator];
    if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) throw invalid(`thresholds.${indicator}`);
    const line = value as number[];
    if (!(line[0] !== undefined && line[1] !== undefined && line[2] !== undefined && line[3] !== undefined && line[0] < line[1] && line[1] < line[2] && line[2] < line[3])) throw invalid(`thresholds.${indicator}`);
    thresholds[indicator] = [line[0], line[1], line[2], line[3]];
  }
  const open = raw.open_from_likelihood;
  const critical = raw.critical_score;
  const jump = raw.jump_points;
  const statuses = raw.scored_statuses;
  if (typeof open !== 'number' || !Number.isInteger(open) || open < 2 || open > SCALE_MAX) throw invalid('open_from_likelihood');
  if (typeof critical !== 'number' || !Number.isInteger(critical) || critical < 1 || critical > SCALE_MAX * SCALE_MAX) throw invalid('critical_score');
  if (typeof jump !== 'number' || !Number.isInteger(jump) || jump < 1 || jump >= SCALE_MAX * SCALE_MAX) throw invalid('jump_points');
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((item) => typeof item !== 'string' || item === '')) throw invalid('scored_statuses');
  return { impact, thresholds, openFromLikelihood: open, criticalScore: critical, jumpPoints: jump, scoredStatuses: statuses as string[] };
}

/** The policy as the plain params the rule registry stores (snake case), so a default and a tenant rule have one shape. */
export function riskSignalParams(policy: RiskSignalPolicy): Record<string, unknown> {
  return {
    impact: { ...policy.impact },
    thresholds: Object.fromEntries(RISK_INDICATORS.map((indicator) => [indicator, [...policy.thresholds[indicator]]])),
    open_from_likelihood: policy.openFromLikelihood,
    critical_score: policy.criticalScore,
    jump_points: policy.jumpPoints,
    scored_statuses: [...policy.scoredStatuses],
  };
}

/** The likelihood a figure gives against four thresholds: 1 below the first, up to 5 from the fourth. */
export function likelihoodOf(value: number, thresholds: Thresholds): number {
  let likelihood = 1;
  for (const line of thresholds) if (value >= line) likelihood += 1;
  return likelihood;
}

/** What is known about a project on the day: a figure the system could not know is `null`, an indicator that was not measured at all is absent. */
export type IndicatorReadings = Partial<Record<RiskIndicator, number | null>>;

export interface SignalDriver {
  indicator: RiskIndicator;
  value: number;
  likelihood: number;
}

export interface SignalScore {
  kind: RiskSignalKind;
  /** No indicator of the kind could be known: the signal is not scored (it keeps whatever it had). */
  known: boolean;
  likelihood: number;
  impact: number;
  score: number;
  level: RiskLevel;
  /** The likelihood reaches the line from which a risk line is open. */
  active: boolean;
  drivers: SignalDriver[];
  /** The indicators of the kind that could not be known. */
  unknown: RiskIndicator[];
}

/** The score of a kind of signal from the readings of its indicators (the highest likelihood of the ones that are known) by the rule. */
export function scoreSignal(kind: RiskSignalKind, readings: IndicatorReadings, policy: RiskSignalPolicy): SignalScore {
  const own = RISK_INDICATORS.filter((indicator) => INDICATOR_KIND[indicator] === kind);
  const drivers: SignalDriver[] = [];
  const unknown: RiskIndicator[] = [];
  for (const indicator of own) {
    const value = readings[indicator];
    if (value === undefined || value === null || !Number.isFinite(value)) {
      unknown.push(indicator);
      continue;
    }
    drivers.push({ indicator, value, likelihood: likelihoodOf(value, policy.thresholds[indicator]) });
  }
  const impact = policy.impact[kind];
  if (drivers.length === 0) return { kind, known: false, likelihood: 1, impact, score: riskScore(1, impact), level: riskLevelOf(riskScore(1, impact)), active: false, drivers, unknown };
  const likelihood = Math.max(...drivers.map((driver) => driver.likelihood));
  const score = riskScore(likelihood, impact);
  return { kind, known: true, likelihood, impact, score, level: riskLevelOf(score), active: likelihood >= policy.openFromLikelihood, drivers, unknown };
}

/** Every kind scored at once. */
export const scoreSignals = (readings: IndicatorReadings, policy: RiskSignalPolicy): SignalScore[] => RISK_SIGNAL_KINDS.map((kind) => scoreSignal(kind, readings, policy));

export interface Crossing {
  alertType: RiskAlertType;
  /** The line of the rule that was crossed: the critical score, or the points of the jump. */
  threshold: number;
}

/**
 * The alerts a move of a score raises. `prior` is the score the subject had before this pass (0 for a line that is new, closed, or had none); an alert needs the score to go UP across the line: a score that stays
 * above a line, or falls, raises nothing. A jump needs a line that already stood (`prior` above 0): a new line that starts high is a crossing of the critical score, not a jump.
 */
export function crossings(prior: number, next: number, policy: RiskSignalPolicy): Crossing[] {
  const found: Crossing[] = [];
  if (prior < policy.criticalScore && next >= policy.criticalScore) found.push({ alertType: 'RISK_SCORE_CRITICAL', threshold: policy.criticalScore });
  if (prior > 0 && next - prior >= policy.jumpPoints) found.push({ alertType: 'RISK_SCORE_JUMP', threshold: policy.jumpPoints });
  return found;
}

/** Whether a standing critical alert has ended: the score is below the line again. */
export const criticalEnded = (score: number, policy: RiskSignalPolicy): boolean => score < policy.criticalScore;

/** What a pass does with a line, given what the line was and what the signal reads now. */
export type LineMove = 'OPEN' | 'RESCORE' | 'CLEAR' | 'KEEP' | 'SKIP';

export interface LineState {
  status: 'ACTIVE' | 'CLEARED';
  likelihood: number;
  impact: number;
}

/**
 * The move of a pass for one kind on one project: open a line when the signal is active and there is none (or it was cleared), re-score a line that is active when the score or its drivers changed, clear a line whose
 * signal fell below the opening line, keep one that did not change, and skip (touch nothing) when nothing could be known.
 */
export function lineMove(existing: LineState | undefined, scored: SignalScore): LineMove {
  if (!scored.known) return 'SKIP';
  if (existing === undefined || existing.status === 'CLEARED') return scored.active ? 'OPEN' : 'KEEP';
  if (!scored.active) return 'CLEAR';
  return existing.likelihood === scored.likelihood && existing.impact === scored.impact ? 'KEEP' : 'RESCORE';
}

/** The trend of a score against the one before it: what the board shows beside the number (a word and an arrow, never a colour alone). */
export type Trend = 'UP' | 'DOWN' | 'FLAT' | 'NEW';
export function trendOf(previous: number | null, current: number): Trend {
  if (previous === null) return 'NEW';
  return current > previous ? 'UP' : current < previous ? 'DOWN' : 'FLAT';
}

/** The facts of one project as the signal reader gives them, and the evidence stored with the score (figures only, in plain data). */
export function evidenceOf(score: SignalScore, readings: IndicatorReadings, facts: Record<string, unknown>): Record<string, unknown> {
  const indicators: Record<string, number | null> = {};
  for (const driver of score.drivers) indicators[driver.indicator] = driver.value;
  for (const indicator of score.unknown) indicators[indicator] = readings[indicator] ?? null;
  return { indicators, drivers: score.drivers.map((driver) => ({ indicator: driver.indicator, value: driver.value, likelihood: driver.likelihood })), unknown: [...score.unknown], facts };
}
