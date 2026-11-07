import { DomainError } from './errors.ts';
import { decimalOf, parseScaled } from './fin-analysis.ts';

/**
 * The non-financial benefits of an investment (lane FIN-1, customer requirement AI.06): a safety, compliance or maintenance project may have no revenue to put in a cash flow, and the case for it rests on
 * criteria that are scored by a person and weighed. The criteria and their weights are rule data (a version per category, proposed and then approved by another person), never constants of a screen; the
 * built-in sets below are the starting values to be settled with the customer and are flagged as unverified. A score is a whole number from 1 to 5 and carries the evidence it rests on. The weighted score
 * is computed by the server from the weights in force when it is computed, with exact arithmetic; nobody types it in.
 */

export const FIN_CRITERIA_CATEGORIES = ['SAFETY', 'COMPLIANCE', 'MAINTENANCE'] as const;
export type FinCriteriaCategory = (typeof FIN_CRITERIA_CATEGORIES)[number];
export const isFinCriteriaCategory = (value: unknown): value is FinCriteriaCategory => typeof value === 'string' && (FIN_CRITERIA_CATEGORIES as readonly string[]).includes(value);

export const FIN_SCORE_MIN = 1;
export const FIN_SCORE_MAX = 5;
export const FIN_CRITERIA_MIN = 2;
export const FIN_CRITERIA_MAX = 15;
const WEIGHT_DECIMALS = 2;
const WEIGHT_TOTAL = 100n * 10n ** BigInt(WEIGHT_DECIMALS);
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_LABEL = 160;
const MAX_EVIDENCE = 1000;

export interface FinCriterion {
  key: string;
  label: string;
  /** Percent with up to two decimals; the weights of a set add up to exactly 100. */
  weightPct: string;
}

export interface FinCriteriaSet {
  category: FinCriteriaCategory;
  criteria: FinCriterion[];
}

const SAFETY: FinCriterion[] = [
  { key: 'accident_risk_reduction', label: 'Giảm nguy cơ tai nạn nghiêm trọng', weightPct: '30' },
  { key: 'legal_safety_standard', label: 'Đáp ứng quy chuẩn an toàn bắt buộc', weightPct: '25' },
  { key: 'people_protected', label: 'Số người được bảo vệ', weightPct: '20' },
  { key: 'incident_history', label: 'Lịch sử sự cố tại hạng mục', weightPct: '15' },
  { key: 'urgency', label: 'Mức khẩn cấp phải xử lý', weightPct: '10' },
];
const COMPLIANCE: FinCriterion[] = [
  { key: 'legal_obligation', label: 'Nghĩa vụ pháp lý phải thực hiện', weightPct: '35' },
  { key: 'penalty_avoided', label: 'Mức xử phạt hoặc thiệt hại tránh được', weightPct: '25' },
  { key: 'audit_finding_closed', label: 'Đóng được kiến nghị của thanh tra, kiểm toán', weightPct: '20' },
  { key: 'deadline_pressure', label: 'Thời hạn bắt buộc', weightPct: '20' },
];
const MAINTENANCE: FinCriterion[] = [
  { key: 'asset_condition', label: 'Tình trạng xuống cấp của tài sản', weightPct: '30' },
  { key: 'service_continuity', label: 'Bảo đảm dịch vụ không gián đoạn', weightPct: '25' },
  { key: 'cost_of_deferral', label: 'Chi phí phát sinh nếu hoãn', weightPct: '20' },
  { key: 'lifecycle_extension', label: 'Kéo dài tuổi thọ tài sản', weightPct: '15' },
  { key: 'energy_environment', label: 'Tiết kiệm năng lượng, môi trường', weightPct: '10' },
];

/** The sets in force until a tenant approves its own. Unverified starting values, to be settled with the customer. */
export const FIN_CRITERIA_DEFAULTS: Readonly<Record<FinCriteriaCategory, { criteria: readonly FinCriterion[]; unverified: true }>> = {
  SAFETY: { criteria: SAFETY, unverified: true },
  COMPLIANCE: { criteria: COMPLIANCE, unverified: true },
  MAINTENANCE: { criteria: MAINTENANCE, unverified: true },
};

const invalid = (field: string, reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason } });

/** Checks a set of criteria: unique keys, a label each, a positive weight each, and weights that add up to exactly 100. */
export function assertCriteriaSet(set: FinCriteriaSet): void {
  if (!isFinCriteriaCategory(set.category)) throw invalid('category', 'UNKNOWN_CATEGORY');
  if (!Array.isArray(set.criteria) || set.criteria.length < FIN_CRITERIA_MIN || set.criteria.length > FIN_CRITERIA_MAX) throw invalid('criteria', 'COUNT_OUT_OF_RANGE');
  const seen = new Set<string>();
  let total = 0n;
  set.criteria.forEach((criterion, index) => {
    if (typeof criterion.key !== 'string' || !KEY.test(criterion.key)) throw invalid(`criteria[${index}].key`, 'NOT_A_KEY');
    if (seen.has(criterion.key)) throw invalid(`criteria[${index}].key`, 'DUPLICATE_KEY');
    seen.add(criterion.key);
    if (typeof criterion.label !== 'string' || criterion.label.trim() === '' || criterion.label.trim() !== criterion.label || criterion.label.length > MAX_LABEL) throw invalid(`criteria[${index}].label`, 'EMPTY');
    const weight = parseScaled(criterion.weightPct, WEIGHT_DECIMALS, `criteria[${index}].weight_pct`, false);
    if (weight === 0n) throw invalid(`criteria[${index}].weight_pct`, 'MUST_BE_POSITIVE');
    total += weight;
  });
  if (total !== WEIGHT_TOTAL) throw invalid('criteria', 'WEIGHTS_MUST_ADD_UP_TO_100');
}

export interface FinCriterionScoreInput {
  key: string;
  score: number;
  evidence: string;
}

export interface FinCriterionScoreLine {
  key: string;
  label: string;
  weightPct: string;
  score: number;
  /** weight x score / 100, three decimals. */
  contribution: string;
  evidence: string;
}

export interface FinCriteriaResult {
  category: FinCriteriaCategory;
  lines: FinCriterionScoreLine[];
  /** The weighted average of the scores, 1 to 5, two decimals. */
  weightedScore: string;
  /** The weighted score as a share of the best possible, 0 to 100, two decimals. */
  indexPct: string;
  formula: string;
}

export const FIN_CRITERIA_FORMULA = 'Điểm có trọng số = Σ (trọng số(i) × điểm(i)) / 100; chỉ số = điểm có trọng số / 5 × 100%';

/** Scores a set: every criterion needs exactly one whole score from 1 to 5 and the evidence it rests on; a missing, extra or repeated score is refused. */
export function scoreCriteria(set: FinCriteriaSet, scores: readonly FinCriterionScoreInput[]): FinCriteriaResult {
  assertCriteriaSet(set);
  const byKey = new Map<string, FinCriterionScoreInput>();
  scores.forEach((entry, index) => {
    if (!set.criteria.some((criterion) => criterion.key === entry.key)) throw invalid(`scores[${index}].key`, 'UNKNOWN_CRITERION');
    if (byKey.has(entry.key)) throw invalid(`scores[${index}].key`, 'DUPLICATE_KEY');
    if (!Number.isInteger(entry.score) || entry.score < FIN_SCORE_MIN || entry.score > FIN_SCORE_MAX) throw invalid(`scores[${index}].score`, 'OUT_OF_RANGE');
    if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '' || entry.evidence.length > MAX_EVIDENCE) throw invalid(`scores[${index}].evidence`, 'EVIDENCE_REQUIRED');
    byKey.set(entry.key, entry);
  });
  const missing = set.criteria.filter((criterion) => !byKey.has(criterion.key)).map((criterion) => criterion.key);
  if (missing.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'scores', { extensions: { reason: 'MISSING_SCORES', missing } });
  let weighted = 0n;
  const lines = set.criteria.map((criterion): FinCriterionScoreLine => {
    const entry = byKey.get(criterion.key) as FinCriterionScoreInput;
    const weight = parseScaled(criterion.weightPct, WEIGHT_DECIMALS, 'weight_pct', false);
    weighted += weight * BigInt(entry.score);
    return { key: criterion.key, label: criterion.label, weightPct: criterion.weightPct, score: entry.score, contribution: decimalOf({ n: weight * BigInt(entry.score), d: WEIGHT_TOTAL }, 3), evidence: entry.evidence };
  });
  return {
    category: set.category,
    lines,
    weightedScore: decimalOf({ n: weighted, d: WEIGHT_TOTAL }, 2),
    indexPct: decimalOf({ n: weighted * 100n, d: WEIGHT_TOTAL * BigInt(FIN_SCORE_MAX) }, 2),
    formula: FIN_CRITERIA_FORMULA,
  };
}
