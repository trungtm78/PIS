import { DomainError } from './errors.ts';
import type { RuleParams } from './governance-rules.ts';

/**
 * The ranking of the units on several measures (G3-8, DIS and HOME). A ranking that rests on one number invites the units to polish it and punishes the ones that report well; this one stands on several measures,
 * each judged against the units of a similar size, each with its own reason when it is missing; a unit that is held back by something outside its control carries a note that a different person approved; a figure a
 * unit disputes is marked until it is answered; and the rate of disbursement is shown beside the physical progress, never alone. Pure and deterministic; every line is a governance rule, unverified until approved.
 */

export const RANKING_RULE_TYPE = 'RANKING_MODEL';
export const RANKING_RULE_CODE = 'DEFAULT';
export const RANK_METRICS = ['RATE', 'COMPLETENESS', 'EXPLANATIONS', 'WARNINGS', 'PHYSICAL'] as const;
export type RankMetricCode = (typeof RANK_METRICS)[number];
export const RANK_DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export type RankDirection = (typeof RANK_DIRECTIONS)[number];
export const ANNOTATION_EFFECTS = ['SHOW_ONLY', 'EXCLUDE_METRIC'] as const;
export type AnnotationEffect = (typeof ANNOTATION_EFFECTS)[number];

export interface RankMetricRule {
  code: RankMetricCode;
  direction: RankDirection;
  weight: number;
}
export interface ScaleBand {
  code: string;
  /** The smallest year plan (whole dong, the plan of the Prime Minister) of a unit in the band. */
  minPlanVnd: string;
}
export interface RankingModel {
  metrics: RankMetricRule[];
  minMetrics: number;
  scaleBands: ScaleBand[];
  minUnitsPerBand: number;
  annotationEffect: AnnotationEffect;
  annotationReasons: string[];
  annotationMaxDays: number;
  complaintResponseDays: number;
  pairGapPct: number;
  pairHighPct: number;
}

export const RANKING_DEFAULTS: Readonly<Record<string, unknown>> = {
  metrics: [
    { code: 'RATE', direction: 'HIGHER_IS_BETTER', weight: 40 },
    { code: 'PHYSICAL', direction: 'HIGHER_IS_BETTER', weight: 20 },
    { code: 'COMPLETENESS', direction: 'HIGHER_IS_BETTER', weight: 15 },
    { code: 'EXPLANATIONS', direction: 'LOWER_IS_BETTER', weight: 15 },
    { code: 'WARNINGS', direction: 'LOWER_IS_BETTER', weight: 10 },
  ],
  min_metrics: 3,
  scale_bands: [
    { code: 'SMALL', min_plan_vnd: '0' },
    { code: 'MEDIUM', min_plan_vnd: '100000000000' },
    { code: 'LARGE', min_plan_vnd: '1000000000000' },
  ],
  min_units_per_band: 3,
  annotation_effect: 'SHOW_ONLY',
  annotation_reasons: ['LAND_CLEARANCE', 'AWAITING_DECISION', 'CAPITAL_NOT_RELEASED', 'FORCE_MAJEURE'],
  annotation_max_days: 180,
  complaint_response_days: 10,
  pair_gap_pct: 15,
  pair_high_pct: 60,
};

const fail = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function whole(params: RuleParams, field: string, min: number, max: number): number {
  const value = params[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw fail(field);
  return value;
}

/** The model from the params of the approved rule or the default; a model that is not whole is refused rather than half applied. */
export function rankingModelOf(params: RuleParams): RankingModel {
  if (!Array.isArray(params.metrics) || params.metrics.length === 0) throw fail('metrics');
  const metrics = params.metrics.map((one, index): RankMetricRule => {
    if (!isRecord(one) || !(RANK_METRICS as readonly unknown[]).includes(one.code) || !(RANK_DIRECTIONS as readonly unknown[]).includes(one.direction) || typeof one.weight !== 'number' || !Number.isInteger(one.weight) || one.weight < 0 || one.weight > 100) throw fail(`metrics[${index}]`);
    return { code: one.code as RankMetricCode, direction: one.direction as RankDirection, weight: one.weight };
  });
  if (new Set(metrics.map((one) => one.code)).size !== metrics.length) throw fail('metrics');
  if (metrics.every((one) => one.weight === 0)) throw fail('metrics');
  if (!Array.isArray(params.scale_bands) || params.scale_bands.length === 0) throw fail('scale_bands');
  const scaleBands = params.scale_bands.map((one, index): ScaleBand => {
    if (!isRecord(one) || typeof one.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,19}$/.test(one.code) || typeof one.min_plan_vnd !== 'string' || !/^\d{1,18}$/.test(one.min_plan_vnd)) throw fail(`scale_bands[${index}]`);
    return { code: one.code, minPlanVnd: one.min_plan_vnd };
  });
  scaleBands.forEach((band, index) => {
    if (index === 0 ? band.minPlanVnd !== '0' : BigInt(band.minPlanVnd) <= BigInt((scaleBands[index - 1] as ScaleBand).minPlanVnd)) throw fail('scale_bands');
  });
  if (!(ANNOTATION_EFFECTS as readonly unknown[]).includes(params.annotation_effect)) throw fail('annotation_effect');
  if (!Array.isArray(params.annotation_reasons) || params.annotation_reasons.length === 0 || !params.annotation_reasons.every((one) => typeof one === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(one))) throw fail('annotation_reasons');
  const model: RankingModel = {
    metrics,
    minMetrics: whole(params, 'min_metrics', 1, 5),
    scaleBands,
    minUnitsPerBand: whole(params, 'min_units_per_band', 1, 50),
    annotationEffect: params.annotation_effect as AnnotationEffect,
    annotationReasons: params.annotation_reasons as string[],
    annotationMaxDays: whole(params, 'annotation_max_days', 1, 365),
    complaintResponseDays: whole(params, 'complaint_response_days', 1, 60),
    pairGapPct: whole(params, 'pair_gap_pct', 0, 100),
    pairHighPct: whole(params, 'pair_high_pct', 0, 100),
  };
  if (model.minMetrics > metrics.filter((one) => one.weight > 0).length) throw fail('min_metrics');
  return model;
}

// ---- the inputs and the ranking --------------------------------------------------------------------------------------------------------------------------

export interface UnitMeasures {
  unitId: string;
  code: string;
  name: string;
  projects: number;
  projectsWithoutData: number;
  planPmVnd: string;
  treasuryVnd: string | null;
  criticalWarnings: number | null;
  overdueExplanations: number | null;
  /** The earned value and the budget at completion of the projects whose physical progress is known (the frozen EVM results), and how many that is. */
  evVnd: string | null;
  bacVnd: string | null;
  physicalProjects: number;
}

export interface ApprovedAnnotation {
  id: string;
  unitId: string;
  reasonCode: string;
  metricCodes: readonly string[];
  validFrom: string;
  validTo: string;
}
export interface OpenComplaint {
  id: string;
  unitId: string;
  metricCode: string;
  status: string;
}

export type MetricNullReason = 'NO_FIGURE' | 'NO_PLAN' | 'NO_PROJECTS' | 'NOT_READABLE' | 'NO_PHYSICAL_PROGRESS';
export interface MetricReading {
  code: RankMetricCode;
  direction: RankDirection;
  weight: number;
  /** A percent for the rate, completeness and physical progress; a count per project for the explanations and the warnings; null with a reason when there is none. */
  value: number | null;
  nullReason: MetricNullReason | null;
  /** 0 to 100 among the units of the same size band (100 is the best); null when the value is missing or taken out. */
  score: number | null;
  excluded: 'ANNOTATION' | null;
  underComplaint: boolean;
}
export type RankedNullReason = 'TOO_FEW_METRICS';
export interface RankedUnit {
  unitId: string;
  code: string;
  name: string;
  band: string;
  /** The weighted mean of the scores that stand, two decimals; null when fewer than the minimum number of measures stand. */
  composite: number | null;
  nullReason: RankedNullReason | null;
  rank: number | null;
  ofBand: number;
  bandThin: boolean;
  standing: number;
  metrics: MetricReading[];
  annotation: { id: string; reasonCode: string; validTo: string } | null;
  pair: PairReading;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const percent = (numerator: string, denominator: string): number => Number((BigInt(numerator) * 1_000_000n) / BigInt(denominator)) / 10_000;

/** The value of one measure of a unit, or why there is none. */
export function measureValue(code: RankMetricCode, unit: UnitMeasures): { value: number | null; nullReason: MetricNullReason | null } {
  switch (code) {
    case 'RATE':
      if (BigInt(unit.planPmVnd) <= 0n) return { value: null, nullReason: 'NO_PLAN' };
      if (unit.treasuryVnd === null) return { value: null, nullReason: 'NO_FIGURE' };
      return { value: round2(percent(unit.treasuryVnd, unit.planPmVnd)), nullReason: null };
    case 'COMPLETENESS':
      return unit.projects <= 0 ? { value: null, nullReason: 'NO_PROJECTS' } : { value: round2(((unit.projects - unit.projectsWithoutData) / unit.projects) * 100), nullReason: null };
    case 'EXPLANATIONS':
      if (unit.projects <= 0) return { value: null, nullReason: 'NO_PROJECTS' };
      return unit.overdueExplanations === null ? { value: null, nullReason: 'NOT_READABLE' } : { value: round2(unit.overdueExplanations / unit.projects), nullReason: null };
    case 'WARNINGS':
      if (unit.projects <= 0) return { value: null, nullReason: 'NO_PROJECTS' };
      return unit.criticalWarnings === null ? { value: null, nullReason: 'NOT_READABLE' } : { value: round2(unit.criticalWarnings / unit.projects), nullReason: null };
    case 'PHYSICAL':
      if (unit.evVnd === null || unit.bacVnd === null || BigInt(unit.bacVnd) <= 0n || unit.physicalProjects <= 0) return { value: null, nullReason: 'NO_PHYSICAL_PROGRESS' };
      return { value: round2(percent(unit.evVnd, unit.bacVnd)), nullReason: null };
  }
}

/** The size band of a unit: the highest band whose lower line its plan reaches. */
export function bandOf(model: RankingModel, planPmVnd: string): string {
  let found = model.scaleBands[0] as ScaleBand;
  for (const band of model.scaleBands) if (BigInt(planPmVnd) >= BigInt(band.minPlanVnd)) found = band;
  return found.code;
}

export type PairQuadrant = 'FAST_BOTH' | 'MONEY_AHEAD_OF_WORK' | 'WORK_AHEAD_OF_MONEY' | 'SLOW_BOTH';
export interface PairReading {
  quadrant: PairQuadrant | null;
  ratePct: number | null;
  physicalPct: number | null;
  nullReason: MetricNullReason | null;
}

/** The rate of disbursement beside the physical progress: money ahead of the work, work ahead of the money, both high, both low; N/A with the reason of whichever is missing. */
export function pairOf(ratePct: number | null, rateReason: MetricNullReason | null, physicalPct: number | null, physicalReason: MetricNullReason | null, model: Pick<RankingModel, 'pairGapPct' | 'pairHighPct'>): PairReading {
  if (ratePct === null) return { quadrant: null, ratePct, physicalPct, nullReason: rateReason ?? 'NO_FIGURE' };
  if (physicalPct === null) return { quadrant: null, ratePct, physicalPct, nullReason: physicalReason ?? 'NO_PHYSICAL_PROGRESS' };
  const gap = ratePct - physicalPct;
  const quadrant: PairQuadrant = gap > model.pairGapPct ? 'MONEY_AHEAD_OF_WORK' : -gap > model.pairGapPct ? 'WORK_AHEAD_OF_MONEY' : ratePct >= model.pairHighPct && physicalPct >= model.pairHighPct ? 'FAST_BOTH' : 'SLOW_BOTH';
  return { quadrant, ratePct, physicalPct, nullReason: null };
}

export interface RankingResult {
  units: RankedUnit[];
  bands: Array<{ code: string; units: number; thin: boolean }>;
}

/**
 * The multi-measure ranking. Each measure of a unit is turned into a score from 0 to 100 among the units of its size band (min-max over the band, flipped for a measure where lower is better; a band whose units
 * all stand level gives each 100), a measure that is missing or that an approved annotation takes out (when the rule says so) takes no part, the composite is the weighted mean of the scores that stand, and a unit
 * with fewer than the minimum number of measures standing has no composite and no position. Positions are within the band, from the best; a tie goes to the code. Nothing is ranked on a band of units too few to compare: it is
 * flagged thin and says so.
 */
export function rankMultiMetric(model: RankingModel, units: readonly UnitMeasures[], annotations: readonly ApprovedAnnotation[], complaints: readonly OpenComplaint[], today: string): RankingResult {
  const active = new Map<string, ApprovedAnnotation>();
  for (const annotation of annotations) if (annotation.validFrom <= today && today <= annotation.validTo) active.set(annotation.unitId, annotation);
  const disputed = new Set(complaints.filter((one) => one.status === 'FILED' || one.status === 'UNDER_REVIEW').map((one) => `${one.unitId}:${one.metricCode}`));
  const raw = units.map((unit) => ({ unit, band: bandOf(model, unit.planPmVnd), readings: model.metrics.map((rule) => ({ rule, ...measureValue(rule.code, unit) })) }));
  const bandSizes = new Map<string, number>();
  for (const one of raw) bandSizes.set(one.band, (bandSizes.get(one.band) ?? 0) + 1);
  const taken = (unitId: string, code: RankMetricCode): boolean => model.annotationEffect === 'EXCLUDE_METRIC' && (active.get(unitId)?.metricCodes.includes(code) ?? false);
  // The lines of each measure in each band: only the values that stand count.
  const lines = new Map<string, { low: number; high: number }>();
  for (const one of raw) {
    for (const reading of one.readings) {
      if (reading.value === null || taken(one.unit.unitId, reading.rule.code)) continue;
      const key = `${one.band}:${reading.rule.code}`;
      const held = lines.get(key);
      lines.set(key, held === undefined ? { low: reading.value, high: reading.value } : { low: Math.min(held.low, reading.value), high: Math.max(held.high, reading.value) });
    }
  }
  const ranked: RankedUnit[] = raw.map((one) => {
    const metrics: MetricReading[] = one.readings.map((reading) => {
      const excluded = reading.value !== null && taken(one.unit.unitId, reading.rule.code) ? ('ANNOTATION' as const) : null;
      let score: number | null = null;
      if (reading.value !== null && excluded === null) {
        const line = lines.get(`${one.band}:${reading.rule.code}`) as { low: number; high: number };
        const span = line.high - line.low;
        score = span === 0 ? 100 : round2(((reading.rule.direction === 'HIGHER_IS_BETTER' ? reading.value - line.low : line.high - reading.value) / span) * 100);
      }
      return { code: reading.rule.code, direction: reading.rule.direction, weight: reading.rule.weight, value: reading.value, nullReason: reading.nullReason, score, excluded, underComplaint: disputed.has(`${one.unit.unitId}:${reading.rule.code}`) };
    });
    const standing = metrics.filter((reading) => reading.score !== null && reading.weight > 0);
    const weight = standing.reduce((sum, reading) => sum + reading.weight, 0);
    const enough = standing.length >= model.minMetrics && weight > 0;
    const annotation = active.get(one.unit.unitId);
    const rate = metrics.find((reading) => reading.code === 'RATE');
    const physical = metrics.find((reading) => reading.code === 'PHYSICAL');
    return {
      unitId: one.unit.unitId,
      code: one.unit.code,
      name: one.unit.name,
      band: one.band,
      composite: enough ? round2(standing.reduce((sum, reading) => sum + reading.weight * (reading.score as number), 0) / weight) : null,
      nullReason: enough ? null : 'TOO_FEW_METRICS',
      rank: null,
      ofBand: bandSizes.get(one.band) ?? 0,
      bandThin: (bandSizes.get(one.band) ?? 0) < model.minUnitsPerBand,
      standing: standing.length,
      metrics,
      annotation: annotation === undefined ? null : { id: annotation.id, reasonCode: annotation.reasonCode, validTo: annotation.validTo },
      // The pair always uses the real figures, an annotation never changes them.
      pair: pairOf(rate?.value ?? null, rate?.nullReason ?? null, physical?.value ?? null, physical?.nullReason ?? null, model),
    };
  });
  for (const band of model.scaleBands) {
    const inBand = ranked.filter((unit) => unit.band === band.code && unit.composite !== null).sort((left, right) => (right.composite as number) - (left.composite as number) || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
    inBand.forEach((unit, index) => {
      unit.rank = index + 1;
    });
  }
  const order = new Map(model.scaleBands.map((band, index) => [band.code, index]));
  ranked.sort((left, right) => (order.get(left.band) as number) - (order.get(right.band) as number) || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  return { units: ranked, bands: model.scaleBands.map((band) => ({ code: band.code, units: bandSizes.get(band.code) ?? 0, thin: (bandSizes.get(band.code) ?? 0) < model.minUnitsPerBand })) };
}

// ---- annotations and complaints ---------------------------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const words = (value: unknown): string => (typeof value === 'string' ? value.trim().normalize('NFC') : '');
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const dayAfter = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export interface AnnotationDraft {
  unitId: string;
  reasonCode: string;
  metricCodes: RankMetricCode[];
  evidence: string;
  validFrom: string;
  validTo: string;
}

/** A proposal of an annotation "this unit is held back by something outside its control": a unit, a reason from the closed list, the measures it touches, the evidence in words and a period of at most the maximum days. */
export function checkAnnotation(input: unknown, model: RankingModel, today: string): AnnotationDraft {
  const body = record(input);
  if (typeof body.unit_id !== 'string' || !UUID.test(body.unit_id)) throw invalid('unit_id');
  if (typeof body.reason_code !== 'string' || !model.annotationReasons.includes(body.reason_code)) throw invalid('reason_code');
  const metrics = Array.isArray(body.metric_codes) ? body.metric_codes : [];
  const known = new Set<string>(model.metrics.map((one) => one.code));
  if (metrics.length === 0 || new Set(metrics).size !== metrics.length || !metrics.every((one) => typeof one === 'string' && known.has(one))) throw invalid('metric_codes');
  const evidence = words(body.evidence);
  if (evidence.length < 10 || evidence.length > 1000) throw invalid('evidence');
  const validFrom = body.valid_from === undefined ? today : body.valid_from;
  if (!isDay(validFrom) || validFrom < today) throw invalid('valid_from');
  if (!isDay(body.valid_to) || body.valid_to < validFrom || body.valid_to > dayAfter(today, model.annotationMaxDays)) throw invalid('valid_to');
  return { unitId: body.unit_id, reasonCode: body.reason_code, metricCodes: metrics as RankMetricCode[], evidence, validFrom, validTo: body.valid_to };
}

export const ANNOTATION_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number];
export const ANNOTATION_DECISIONS = ['APPROVE', 'REJECT', 'WITHDRAW'] as const;
export type AnnotationDecision = (typeof ANNOTATION_DECISIONS)[number];

/** The status an annotation moves to; null when the move is not allowed (a decision is final except that an approved note may be withdrawn). */
export function annotationNext(status: AnnotationStatus, decision: AnnotationDecision): AnnotationStatus | null {
  if (status === 'PROPOSED') return decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'WITHDRAWN';
  if (status === 'APPROVED' && decision === 'WITHDRAW') return 'WITHDRAWN';
  return null;
}

/** Maker is not checker: the person who proposed a note does not approve or reject it (withdrawing their own is allowed). */
export function assertAnnotationDecider(decision: AnnotationDecision, proposerId: string, deciderId: string): void {
  if ((decision === 'APPROVE' || decision === 'REJECT') && proposerId === deciderId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'decision');
}

export function checkAnnotationDecision(input: unknown): { decision: AnnotationDecision; note: string } {
  const body = record(input);
  if (!(ANNOTATION_DECISIONS as readonly unknown[]).includes(body.decision)) throw invalid('decision');
  const note = words(body.note);
  if (note.length < 5 || note.length > 1000) throw invalid('note');
  return { decision: body.decision as AnnotationDecision, note };
}

export const COMPLAINT_STATUSES = ['FILED', 'UNDER_REVIEW', 'UPHELD', 'REJECTED', 'CORRECTED'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const COMPLAINT_ACTIONS = ['START_REVIEW', 'UPHOLD', 'REJECT', 'CORRECT'] as const;
export type ComplaintAction = (typeof COMPLAINT_ACTIONS)[number];

export interface ComplaintDraft {
  unitId: string;
  metricCode: RankMetricCode;
  asOfDate: string;
  claim: string;
  claimedValue: string | null;
}

/** A complaint about a figure: the unit, the measure, the day of the snapshot the figure was on, what the unit says is wrong and, when it has one, the value it claims. */
export function checkComplaint(input: unknown, model: RankingModel, today: string): ComplaintDraft {
  const body = record(input);
  if (typeof body.unit_id !== 'string' || !UUID.test(body.unit_id)) throw invalid('unit_id');
  if (typeof body.metric_code !== 'string' || !model.metrics.some((one) => one.code === body.metric_code)) throw invalid('metric_code');
  if (!isDay(body.as_of_date) || body.as_of_date > today) throw invalid('as_of_date');
  const claim = words(body.claim);
  if (claim.length < 10 || claim.length > 2000) throw invalid('claim');
  let claimedValue: string | null = null;
  if (body.claimed_value !== undefined && body.claimed_value !== null) {
    if (typeof body.claimed_value !== 'string' || !/^-?\d{1,18}(\.\d{1,4})?$/.test(body.claimed_value)) throw invalid('claimed_value');
    claimedValue = body.claimed_value;
  }
  return { unitId: body.unit_id, metricCode: body.metric_code as RankMetricCode, asOfDate: body.as_of_date, claim, claimedValue };
}

/** The status a complaint moves to by an action; null when the move is not allowed. A review starts from FILED; it is answered from FILED or UNDER_REVIEW. */
export function complaintNext(status: ComplaintStatus, action: ComplaintAction): ComplaintStatus | null {
  if (action === 'START_REVIEW') return status === 'FILED' ? 'UNDER_REVIEW' : null;
  if (status !== 'FILED' && status !== 'UNDER_REVIEW') return null;
  return action === 'UPHOLD' ? 'UPHELD' : action === 'REJECT' ? 'REJECTED' : 'CORRECTED';
}

export function checkComplaintResolution(input: unknown): { action: ComplaintAction; resolution: string | null } {
  const body = record(input);
  if (!(COMPLAINT_ACTIONS as readonly unknown[]).includes(body.action)) throw invalid('action');
  const action = body.action as ComplaintAction;
  const resolution = words(body.resolution);
  if (action === 'START_REVIEW') return { action, resolution: resolution === '' ? null : resolution };
  if (resolution.length < 10 || resolution.length > 2000) throw invalid('resolution');
  return { action, resolution };
}

/** The person who answers a complaint is not the one who filed it. */
export function assertComplaintResolver(filedBy: string, resolverId: string): void {
  if (filedBy === resolverId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'action');
}

/** The day by which a complaint is to be answered: the day it was filed and the days of the rule. */
export const complaintDueDay = (filedDay: string, model: Pick<RankingModel, 'complaintResponseDays'>): string => dayAfter(filedDay, model.complaintResponseDays);
