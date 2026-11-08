import { DomainError } from './errors.ts';

/**
 * The risk grade of a contractor (VND-2, research V13; docs/vendor-controls.md section 7). A grade is a **snapshot with its explanation**: the points each factor adds, why, and the rule version that decided. Factors read
 * what the other controls found (a profile with gaps, a restriction in force or in the past, events on the list of bid conduct, certificates lapsed, an alert on the account, poor ratings, finance below the line, a load
 * over capacity, findings of independence nobody decided, subcontract breaches, forfeited securities). The weights and the cut points are the rule `VENDOR_RISK`; the grade decides how deep the checking goes (a high
 * grade needs a second person to confirm it and is looked at again in months of the rule), never whether a contractor may bid: that stays with the gate and the people. Pure.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const VENDOR_RISK_RULE_TYPE = 'VENDOR_RISK';

export const RISK_FACTORS = ['PROFILE_GAP', 'RESTRICTION', 'REPUTATION_EVENTS', 'QUALIFICATION_LAPSE', 'PAYEE_ALERT', 'POOR_PERFORMANCE', 'FINANCE_BELOW', 'LOAD_OVER', 'OPEN_FINDINGS', 'SUBCONTRACT_BREACH', 'SECURITY_FORFEIT'] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];

export const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** Weights are whole points (the most a factor can add); the tiers start at the cut points; `restriction_floor` is the lowest tier a restriction in force gives whatever the score. */
export interface RiskPolicy {
  weights: Readonly<Record<RiskFactor, number>>;
  medium_from: number;
  high_from: number;
  critical_from: number;
  restriction_floor: RiskTier;
  /** Months after which the grade is looked at again, per tier. */
  review_months: Readonly<Record<RiskTier, number>>;
  /** From this tier a second person confirms the grade before it is written on the contractor. */
  dual_check_from: 'HIGH' | 'CRITICAL';
}

export const RISK_POLICY_DEFAULTS: RiskPolicy = {
  weights: { PROFILE_GAP: 10, RESTRICTION: 40, REPUTATION_EVENTS: 15, QUALIFICATION_LAPSE: 10, PAYEE_ALERT: 10, POOR_PERFORMANCE: 20, FINANCE_BELOW: 10, LOAD_OVER: 5, OPEN_FINDINGS: 15, SUBCONTRACT_BREACH: 10, SECURITY_FORFEIT: 15 },
  medium_from: 20,
  high_from: 45,
  critical_from: 70,
  restriction_floor: 'HIGH',
  review_months: { LOW: 24, MEDIUM: 12, HIGH: 6, CRITICAL: 3 },
  dual_check_from: 'HIGH',
};

/** The params as the registry keeps them: flat, one number each. */
export function riskParamsOf(policy: RiskPolicy): Record<string, number | string> {
  const flat: Record<string, number | string> = { medium_from: policy.medium_from, high_from: policy.high_from, critical_from: policy.critical_from, restriction_floor: policy.restriction_floor, dual_check_from: policy.dual_check_from };
  for (const factor of RISK_FACTORS) flat[`weight_${factor.toLowerCase()}`] = policy.weights[factor];
  for (const tier of RISK_TIERS) flat[`review_months_${tier.toLowerCase()}`] = policy.review_months[tier];
  return flat;
}

export function riskPolicyOf(params: unknown): RiskPolicy {
  if (!isRecord(params)) throw invalid('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  const weights = {} as Record<RiskFactor, number>;
  for (const factor of RISK_FACTORS) weights[factor] = whole(`weight_${factor.toLowerCase()}`, 0, 100);
  const review = {} as Record<RiskTier, number>;
  for (const tier of RISK_TIERS) review[tier] = whole(`review_months_${tier.toLowerCase()}`, 1, 120);
  const policy: RiskPolicy = {
    weights,
    medium_from: whole('medium_from', 1, 1000),
    high_from: whole('high_from', 1, 1000),
    critical_from: whole('critical_from', 1, 1000),
    restriction_floor: RISK_TIERS.includes(params.restriction_floor as RiskTier) ? (params.restriction_floor as RiskTier) : (() => { throw invalid('restriction_floor'); })(),
    review_months: review,
    dual_check_from: params.dual_check_from === 'HIGH' || params.dual_check_from === 'CRITICAL' ? params.dual_check_from : (() => { throw invalid('dual_check_from'); })(),
  };
  if (!(policy.medium_from < policy.high_from && policy.high_from < policy.critical_from)) throw invalid('high_from');
  return policy;
}

/** What the other controls found about one contractor on a day; a figure that is not known is null and adds nothing (never a guess). */
export interface RiskInputs {
  /** Share of the required profile fields that are present, 0 to 100. */
  profileCoveragePct: number | null;
  restrictionsInForce: number;
  restrictionsPast: number;
  /** Events of bid conduct that were posted and still weigh (VND-1: within the years of the factor). */
  reputationEventsPosted: number;
  qualificationsLapsed: number;
  payeeAlerts: number;
  /** Consecutive POOR ratings, latest first, and POOR ratings inside the retrospect window. */
  poorRatingsConsecutive: number;
  financeStatus: 'MEETS' | 'BELOW' | 'INSUFFICIENT_DATA' | null;
  loadStatus: 'WITHIN' | 'OVER' | 'NO_DATA' | null;
  openStrongFindings: number;
  subcontractBreaches: number;
  securityForfeits: number;
}

export interface RiskFactorLine {
  factor: RiskFactor;
  points: number;
  max: number;
  /** The reading the points came from, as numbers and codes (the explanation of the grade shows it). */
  reading: Readonly<Record<string, number | string | null>>;
}

export interface RiskGrade {
  score: number;
  tier: RiskTier;
  /** The tier the score alone gives, before a floor. */
  scoreTier: RiskTier;
  floored: boolean;
  factors: RiskFactorLine[];
  /** The factors that added points, the largest first: the first of them is the "main reason" of the screen. */
  reasons: RiskFactor[];
  reviewMonths: number;
  dualCheck: boolean;
}

const tierOfScore = (score: number, policy: RiskPolicy): RiskTier => (score >= policy.critical_from ? 'CRITICAL' : score >= policy.high_from ? 'HIGH' : score >= policy.medium_from ? 'MEDIUM' : 'LOW');
const tierRank = (tier: RiskTier): number => RISK_TIERS.indexOf(tier);
const capped = (count: number, steps: number): number => Math.min(Math.max(count, 0), steps) / steps;

/**
 * The grade: each factor adds at most its weight. A profile adds weight times the share missing; a restriction in force adds its full weight (and the floor of the rule keeps the tier up whatever the rest), a past
 * one adds a third; a posted event, a lapsed certificate, an alert on the account, an open STRONG finding, a breach of the subcontract limits and a forfeited security add a third of the weight each time up to three
 * times; poor ratings add weight times the streak over three; finance below the line and a load over capacity add their full weight (insufficient data adds half of the finance weight: unknown is a risk, not a pass).
 */
export function gradeRisk(inputs: RiskInputs, policy: RiskPolicy): RiskGrade {
  const w = policy.weights;
  const lines: RiskFactorLine[] = [];
  const add = (factor: RiskFactor, fraction: number, reading: Record<string, number | string | null>): void => {
    lines.push({ factor, points: Math.round(w[factor] * Math.max(0, Math.min(1, fraction))), max: w[factor], reading });
  };
  add('PROFILE_GAP', inputs.profileCoveragePct === null ? 1 : (100 - inputs.profileCoveragePct) / 100, { coverage_pct: inputs.profileCoveragePct });
  add('RESTRICTION', inputs.restrictionsInForce > 0 ? 1 : inputs.restrictionsPast > 0 ? 1 / 3 : 0, { in_force: inputs.restrictionsInForce, past: inputs.restrictionsPast });
  add('REPUTATION_EVENTS', capped(inputs.reputationEventsPosted, 3), { posted: inputs.reputationEventsPosted });
  add('QUALIFICATION_LAPSE', capped(inputs.qualificationsLapsed, 3), { lapsed: inputs.qualificationsLapsed });
  add('PAYEE_ALERT', capped(inputs.payeeAlerts, 3), { alerts: inputs.payeeAlerts });
  add('POOR_PERFORMANCE', capped(inputs.poorRatingsConsecutive, 3), { consecutive_poor: inputs.poorRatingsConsecutive });
  add('FINANCE_BELOW', inputs.financeStatus === 'BELOW' ? 1 : inputs.financeStatus === 'INSUFFICIENT_DATA' ? 0.5 : 0, { finance: inputs.financeStatus });
  add('LOAD_OVER', inputs.loadStatus === 'OVER' ? 1 : 0, { load: inputs.loadStatus });
  add('OPEN_FINDINGS', capped(inputs.openStrongFindings, 3), { open_strong: inputs.openStrongFindings });
  add('SUBCONTRACT_BREACH', capped(inputs.subcontractBreaches, 3), { breaches: inputs.subcontractBreaches });
  add('SECURITY_FORFEIT', capped(inputs.securityForfeits, 3), { forfeits: inputs.securityForfeits });
  const score = lines.reduce((sum, line) => sum + line.points, 0);
  const scoreTier = tierOfScore(score, policy);
  const floorTier = inputs.restrictionsInForce > 0 ? policy.restriction_floor : null;
  const tier = floorTier !== null && tierRank(floorTier) > tierRank(scoreTier) ? floorTier : scoreTier;
  const reasons = lines.filter((line) => line.points > 0).sort((a, b) => b.points - a.points || RISK_FACTORS.indexOf(a.factor) - RISK_FACTORS.indexOf(b.factor)).map((line) => line.factor);
  return { score, tier, scoreTier, floored: tier !== scoreTier, factors: lines, reasons, reviewMonths: policy.review_months[tier], dualCheck: tierRank(tier) >= tierRank(policy.dual_check_from) };
}

export const RISK_SNAPSHOT_STATES = ['PROPOSED', 'CONFIRMED', 'SUPERSEDED', 'REJECTED'] as const;
export type RiskSnapshotState = (typeof RISK_SNAPSHOT_STATES)[number];

/**
 * A grade becomes the grade of the contractor when it is confirmed. One that needs a second person (dual check) is confirmed by somebody other than the person who assessed it (403 `SELF_APPROVAL_DENIED`); a grade
 * that does not need it is confirmed at once by the assessor. Rejecting a proposal always needs a reason of 20 characters (REASON_REQUIRED).
 */
export function assertRiskDecision(input: { decision: 'CONFIRM' | 'REJECT'; reason: string | undefined; decidedBy: string; assessedBy: string; dualCheck: boolean; state: RiskSnapshotState }): void {
  if (input.state !== 'PROPOSED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
  if (input.decision === 'REJECT' && (input.reason === undefined || input.reason.trim().length < 20)) throw new DomainError('REASON_REQUIRED', 422, 'reason');
  if (input.dualCheck && input.decidedBy === input.assessedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/** The first day the grade is looked at again: `months` after `from`, clamped to the last day of a short month. */
export function nextReviewOn(from: string, months: number): string {
  const [year, month, day] = from.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
