import { DomainError } from './errors.ts';
import { isRuleDay, resolveGovernanceRule } from './governance-rules.ts';
import type { GovernanceRuleVersion, ResolvedGovernanceRule } from './governance-rules.ts';
import { EWS_CRITICAL_CODE, EWS_FACTOR_CODES, EWS_NO_DATA_CODE, EWS_OVERDUE_CODE, EWS_RATE_CODE, EWS_SCORE_CODE } from './analytics-rule-defaults.ts';
import { RAG_RULE_TYPE, ragOfValue, yearPacePct } from './kpi-register.ts';
import type { RagColor, ThresholdLine } from './kpi-register.ts';

/**
 * Red, amber and green that can be explained (G3-2, BI+HOME): a rule-based reading of a unit or a project. The colour is never a verdict of its own: it comes with the one to three factors that moved it, each with
 * its value against its line, with how much of the data was there, and, when a person overrode the colour, with their reason. The early-warning score is the weighted share of the factors that are off their line,
 * 0 (nothing wrong) to 100; its breakdown is what the weekly row stores. Thresholds and weights are `RAG_THRESHOLDS` rules read through the governance store, never constants of this file.
 */

export type RagBand = RagColor | 'NO_DATA';

export interface RagFactorRule extends ThresholdLine {
  code: string;
  weight: number;
}

export interface RagModel {
  factors: RagFactorRule[];
  /** The lines the score is read against (lower is better) and the share of the weight that must have data before a band is given. */
  score: ThresholdLine;
  minCoveragePct: number;
  /** The versions of the rules that decided, kept on the stored row (0 is a built-in default). */
  versions: Record<string, number>;
  unverified: boolean;
}

const numberOf = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * The model from a way of resolving a code: the factor rules and the score rule, each resolved through the governance rules (an approved rule of the tenant, or the built-in default). The store reads the rules
 * through `GovernancePolicyPort` and gives its answers here; a test gives the rule versions to `ragModelOf`.
 */
export function ragModelFromResolver(resolve: (code: string) => ResolvedGovernanceRule | undefined): RagModel {
  const versions: Record<string, number> = {};
  let unverified = false;
  const read = (code: string): Record<string, unknown> => {
    const resolved = resolve(code);
    if (resolved === undefined) throw new DomainError('METRIC_UNAVAILABLE', 422, code);
    versions[code] = resolved.version;
    unverified = unverified || resolved.unverified;
    return resolved.params;
  };
  const factors = EWS_FACTOR_CODES.map((code): RagFactorRule => {
    const params = read(code);
    return { code, direction: params.direction === 'LOWER_IS_BETTER' ? 'LOWER_IS_BETTER' : 'HIGHER_IS_BETTER', green: numberOf(params.green, 0), amber: numberOf(params.amber, 0), weight: numberOf(params.weight, 0) };
  });
  const score = read(EWS_SCORE_CODE);
  return {
    factors,
    score: { direction: 'LOWER_IS_BETTER', green: numberOf(score.green, 25), amber: numberOf(score.amber, 45) },
    minCoveragePct: numberOf(score.min_coverage_pct, 60),
    versions,
    unverified,
  };
}

/** The model in force on `asOf`, from the versions of the rules of a tenant. */
export function ragModelOf(rules: readonly GovernanceRuleVersion[], asOf: string): RagModel {
  return ragModelFromResolver((code) => resolveGovernanceRule(rules, RAG_RULE_TYPE, code, asOf));
}

export interface RagFactorInput {
  code: string;
  /** Null when the factor cannot be read (the source failed or there is nothing to read): it has no colour and takes no part in the score. */
  value: number | null;
}

/** What is known of a unit on the day of a snapshot: the sums of its lines and what waits in it. A count that could not be read is null (a source that failed is never "none"). */
export interface UnitFacts {
  projects: number;
  projectsWithoutData: number;
  planPmVnd: string;
  /** What the Treasury paid, or null when it booked nothing for any project of the unit. */
  treasuryVnd: string | null;
  criticalWarnings: number | null;
  overdueExplanations: number | null;
}

/**
 * The inputs of the four factors from the facts of a unit: the disbursement rate over the pace of the year (the Treasury over the plan of the Prime Minister, divided by the share of the year gone by on the day of the
 * snapshot; null when the Treasury booked nothing or there is no plan), the critical warnings and the overdue explanations (counts), and the share of the projects with no Treasury figure (null for a unit without projects).
 */
export function ragFactorInputs(facts: UnitFacts, asOfDay: string): RagFactorInput[] {
  let rate: number | null = null;
  if (facts.treasuryVnd !== null && BigInt(facts.planPmVnd) > 0n) {
    const percent = Number((BigInt(facts.treasuryVnd) * 1_000_000n) / BigInt(facts.planPmVnd)) / 10_000;
    rate = percent / yearPacePct(asOfDay);
  }
  return [
    { code: EWS_RATE_CODE, value: rate },
    { code: EWS_CRITICAL_CODE, value: facts.criticalWarnings },
    { code: EWS_OVERDUE_CODE, value: facts.overdueExplanations },
    { code: EWS_NO_DATA_CODE, value: facts.projects > 0 ? (facts.projectsWithoutData / facts.projects) * 100 : null },
  ];
}

export interface RagFactorResult extends ThresholdLine {
  code: string;
  weight: number;
  value: number | null;
  band: RagBand;
  /** What the factor adds to the score, in points of the 100. */
  points: number;
}

export interface RagEvaluation {
  /** 0 to 100, or null when too little of the data is there for a score to mean anything. */
  score: number | null;
  band: RagBand;
  /** The share of the weight whose factor had a value, in percent. */
  coveragePct: number;
  factors: RagFactorResult[];
  /** The one to three factors that moved the band, the most points first (empty for a green or an unscored unit). */
  reasons: RagFactorResult[];
}

const SEVERITY: Readonly<Record<RagColor, number>> = { GREEN: 0, AMBER: 0.5, RED: 1 };
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The reading of one unit or project. A factor with no value takes no part; if the factors that had values carry less of the weight than the model asks, the unit is "not enough data" (NO_DATA, no score):
 * a lack of data is never read as green and never as zero.
 */
export function evaluateRag(model: RagModel, inputs: readonly RagFactorInput[]): RagEvaluation {
  const byCode = new Map(inputs.map((input) => [input.code, input.value]));
  const total = model.factors.reduce((sum, factor) => sum + factor.weight, 0);
  const results = model.factors.map((factor): RagFactorResult => {
    const value = byCode.get(factor.code) ?? null;
    const color = ragOfValue(factor, value);
    return { ...factor, value, band: color ?? 'NO_DATA', points: 0 };
  });
  const present = results.filter((factor) => factor.band !== 'NO_DATA');
  const used = present.reduce((sum, factor) => sum + factor.weight, 0);
  const coveragePct = total === 0 ? 0 : round2((used / total) * 100);
  if (used === 0 || coveragePct < model.minCoveragePct) return { score: null, band: 'NO_DATA', coveragePct, factors: results, reasons: [] };
  for (const factor of present) factor.points = round2(((factor.weight * SEVERITY[factor.band as RagColor]) / used) * 100);
  const score = round2(present.reduce((sum, factor) => sum + factor.points, 0));
  const band = ragOfValue(model.score, score) as RagColor;
  const reasons = present
    .filter((factor) => factor.points > 0)
    .sort((left, right) => right.points - left.points || left.code.localeCompare(right.code, 'en'))
    .slice(0, 3);
  return { score, band, coveragePct, factors: results, reasons };
}

// ---- override ------------------------------------------------------------------------------------------------------------------------------------

export const RAG_OVERRIDE_MAX_DAYS = 90;
export const RAG_OVERRIDE_REASON_MIN = 10;
export const RAG_OVERRIDE_REASON_MAX = 500;
export const RAG_COLORS: readonly RagColor[] = ['GREEN', 'AMBER', 'RED'];

export interface RagOverrideInput {
  band: unknown;
  reason: unknown;
  until: unknown;
}

export interface RagOverrideDraft {
  band: RagColor;
  reason: string;
  until: string;
}

const dayAfter = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * An override of a colour: a colour the rules did not give, a reason in words (at least ten characters, kept on the row and the audit trail), and a last day no more than 90 days away. An override with no reason, or
 * to the colour the rules already gave, or with no end, is refused: the rules are the default and a person's word is the exception that expires.
 */
export function checkRagOverride(input: RagOverrideInput, ruleBand: RagBand, today: string): RagOverrideDraft {
  const band = (RAG_COLORS as readonly unknown[]).includes(input.band) ? (input.band as RagColor) : undefined;
  if (band === undefined || band === ruleBand) throw new DomainError('VALIDATION_FAILED', 422, 'band');
  const reason = typeof input.reason === 'string' ? input.reason.trim().normalize('NFC') : '';
  if (reason.length < RAG_OVERRIDE_REASON_MIN || reason.length > RAG_OVERRIDE_REASON_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  if (typeof input.until !== 'string' || !isRuleDay(input.until) || input.until <= today || input.until > dayAfter(today, RAG_OVERRIDE_MAX_DAYS)) throw new DomainError('VALIDATION_FAILED', 422, 'until');
  return { band, reason, until: input.until };
}

export interface ActiveOverride {
  band: RagColor;
  reason: string;
  until: string;
  by: string;
  at: string;
}

/** The band a reader is shown: the override while it lasts (and the rule's own colour beside it, so the two are never confused), else the rule's colour. */
export function shownBand(ruleBand: RagBand, override: ActiveOverride | null, today: string): { band: RagBand; overridden: boolean; ruleBand: RagBand } {
  const live = override !== null && override.until >= today;
  return { band: live ? override.band : ruleBand, overridden: live, ruleBand };
}

// ---- the week -----------------------------------------------------------------------------------------------------------------------------------

/** The Monday of the week of a day (weeks run Monday to Sunday), as a day: the key of the weekly row. */
export function weekStartOf(day: string): string {
  if (!isRuleDay(day)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dayAfter(day, -((weekday + 6) % 7));
}

export const previousWeekOf = (weekStart: string): string => dayAfter(weekStart, -7);
