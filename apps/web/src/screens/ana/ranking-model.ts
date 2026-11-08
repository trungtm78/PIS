import { isRecord, list, nullableNumber, nullableText, text, toInfo } from './common';
import type { AnaInfo } from './common';

export const ANNOTATE_PERMISSION = 'home.ranking.annotate';
export const DECIDE_PERMISSION = 'home.ranking.annotation.decide';
export const COMPLAIN_PERMISSION = 'home.ranking.complain';
export const RESOLVE_PERMISSION = 'home.ranking.complaint.resolve';
export const MULTI_PATH = '/bi/bi-25';
export const NOTES_PATH = '/bi/bi-26';
export const RANKING_PATH = '/home/home-04';
export const METRICS = ['RATE', 'PHYSICAL', 'COMPLETENESS', 'EXPLANATIONS', 'WARNINGS'] as const;
export type MetricCode = (typeof METRICS)[number];
export const QUADRANTS = ['FAST_BOTH', 'MONEY_AHEAD_OF_WORK', 'WORK_AHEAD_OF_MONEY', 'SLOW_BOTH'] as const;
export type Quadrant = (typeof QUADRANTS)[number];
export const ANNOTATION_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number];
export const COMPLAINT_STATUSES = ['FILED', 'UNDER_REVIEW', 'UPHELD', 'REJECTED', 'CORRECTED'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export interface MetricView {
  code: MetricCode;
  direction: string;
  weight: number;
  value: number | null;
  score: number | null;
  nullReason: string | null;
  excluded: string | null;
  underComplaint: boolean;
}
export interface UnitRank {
  unitId: string;
  code: string;
  name: string;
  band: string;
  rank: number | null;
  ofBand: number;
  bandThin: boolean;
  composite: number | null;
  nullReason: string | null;
  standing: number;
  metrics: MetricView[];
  annotation: { id: string; reasonCode: string; validTo: string } | null;
  pair: { quadrant: Quadrant | null; ratePct: number | null; physicalPct: number | null; nullReason: string | null };
}
export interface RankingReading {
  snapshotId: string | null;
  asOfDate: string | null;
  certificationGate: string | null;
  nullReason: string | null;
  model: { ruleVersion: string; unverified: boolean; metrics: Array<{ code: MetricCode; direction: string; weight: number }>; minMetrics: number; annotationEffect: string; annotationReasons: string[]; annotationMaxDays: number; pairGapPct: number; pairHighPct: number };
  info: AnaInfo | undefined;
  bands: Array<{ code: string; minPlanVnd: string; units: number; thin: boolean }>;
  units: UnitRank[];
}
interface Person {
  id: string;
  name: string;
}
export interface Annotation {
  id: string;
  unit: { id: string; code: string | null; name: string | null };
  reasonCode: string;
  metricCodes: MetricCode[];
  evidence: string;
  validFrom: string;
  validTo: string;
  status: AnnotationStatus;
  proposedBy: Person;
  proposedAt: string;
  decidedBy: Person | null;
  decisionNote: string | null;
}
export interface Complaint {
  id: string;
  unit: { id: string; code: string | null; name: string | null };
  metricCode: MetricCode;
  asOfDate: string;
  claim: string;
  claimedValue: string | null;
  status: ComplaintStatus;
  filedBy: Person;
  dueOn: string;
  overdue: boolean;
  resolvedBy: Person | null;
  resolution: string | null;
}

const metricOf = (raw: unknown): MetricCode | undefined => METRICS.find((one) => one === raw);
const person = (raw: unknown): Person | null => (isRecord(raw) && text(raw.id) !== '' ? { id: text(raw.id), name: text(raw.name) } : null);

export function toRanking(raw: unknown): RankingReading | undefined {
  if (!isRecord(raw) || !isRecord(raw.model) || !Array.isArray(raw.units)) return undefined;
  const model = raw.model;
  return {
    snapshotId: nullableText(raw.snapshot_id),
    asOfDate: nullableText(raw.as_of_date),
    certificationGate: nullableText(raw.certification_gate),
    nullReason: nullableText(raw.null_reason),
    model: {
      ruleVersion: text(model.rule_version),
      unverified: model.unverified === true,
      metrics: list(model.metrics).flatMap((one) => {
        const code = isRecord(one) ? metricOf(one.code) : undefined;
        return isRecord(one) && code !== undefined ? [{ code, direction: text(one.direction), weight: nullableNumber(one.weight) ?? 0 }] : [];
      }),
      minMetrics: nullableNumber(model.min_metrics) ?? 0,
      annotationEffect: text(model.annotation_effect),
      annotationReasons: list(model.annotation_reasons).filter((one): one is string => typeof one === 'string'),
      annotationMaxDays: nullableNumber(model.annotation_max_days) ?? 0,
      pairGapPct: nullableNumber(model.pair_gap_pct) ?? 0,
      pairHighPct: nullableNumber(model.pair_high_pct) ?? 0,
    },
    info: toInfo(raw.info),
    bands: list(raw.bands).flatMap((one) => (isRecord(one) && text(one.code) !== '' ? [{ code: text(one.code), minPlanVnd: text(one.min_plan_vnd), units: nullableNumber(one.units) ?? 0, thin: one.thin === true }] : [])),
    units: raw.units.flatMap((one) => {
      if (!isRecord(one) || text(one.unit_id) === '' || !isRecord(one.pair)) return [];
      const quadrant = QUADRANTS.find((candidate) => candidate === (one.pair as Record<string, unknown>).quadrant) ?? null;
      const annotation = isRecord(one.annotation) ? one.annotation : null;
      return [
        {
          unitId: text(one.unit_id),
          code: text(one.code),
          name: text(one.name),
          band: text(one.band),
          rank: nullableNumber(one.rank),
          ofBand: nullableNumber(one.of_band) ?? 0,
          bandThin: one.band_thin === true,
          composite: nullableNumber(one.composite),
          nullReason: nullableText(one.null_reason),
          standing: nullableNumber(one.standing) ?? 0,
          metrics: list(one.metrics).flatMap((metric) => {
            const code = isRecord(metric) ? metricOf(metric.code) : undefined;
            return isRecord(metric) && code !== undefined
              ? [{ code, direction: text(metric.direction), weight: nullableNumber(metric.weight) ?? 0, value: nullableNumber(metric.value), score: nullableNumber(metric.score), nullReason: nullableText(metric.null_reason), excluded: nullableText(metric.excluded), underComplaint: metric.under_complaint === true }]
              : [];
          }),
          annotation: annotation === null ? null : { id: text(annotation.id), reasonCode: text(annotation.reason_code), validTo: text(annotation.valid_to) },
          pair: { quadrant, ratePct: nullableNumber(one.pair.rate_pct), physicalPct: nullableNumber(one.pair.physical_pct), nullReason: nullableText(one.pair.null_reason) },
        },
      ];
    }),
  };
}

const unitOf = (raw: unknown): Annotation['unit'] => (isRecord(raw) ? { id: text(raw.id), code: nullableText(raw.code), name: nullableText(raw.name) } : { id: '', code: null, name: null });

export function toAnnotations(raw: unknown): Annotation[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return raw.items.flatMap((one) => {
    const proposedBy = isRecord(one) ? person(one.proposed_by) : null;
    const status = isRecord(one) ? ANNOTATION_STATUSES.find((candidate) => candidate === one.status) : undefined;
    if (!isRecord(one) || proposedBy === null || status === undefined || text(one.id) === '') return [];
    return [
      {
        id: text(one.id),
        unit: unitOf(one.unit),
        reasonCode: text(one.reason_code),
        metricCodes: list(one.metric_codes).flatMap((code) => metricOf(code) ?? []),
        evidence: text(one.evidence),
        validFrom: text(one.valid_from),
        validTo: text(one.valid_to),
        status,
        proposedBy,
        proposedAt: text(one.proposed_at),
        decidedBy: person(one.decided_by),
        decisionNote: nullableText(one.decision_note),
      },
    ];
  });
}

export function toComplaints(raw: unknown): Complaint[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return raw.items.flatMap((one) => {
    const filedBy = isRecord(one) ? person(one.filed_by) : null;
    const status = isRecord(one) ? COMPLAINT_STATUSES.find((candidate) => candidate === one.status) : undefined;
    const metric = isRecord(one) ? metricOf(one.metric_code) : undefined;
    if (!isRecord(one) || filedBy === null || status === undefined || metric === undefined || text(one.id) === '') return [];
    return [{ id: text(one.id), unit: unitOf(one.unit), metricCode: metric, asOfDate: text(one.as_of_date), claim: text(one.claim), claimedValue: nullableText(one.claimed_value), status, filedBy, dueOn: text(one.due_on), overdue: one.overdue === true, resolvedBy: person(one.resolved_by), resolution: nullableText(one.resolution) }];
  });
}
