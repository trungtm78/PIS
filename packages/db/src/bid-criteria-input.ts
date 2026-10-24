import { DomainError } from '@machvon/kernel';
import { prohibitedRuleOf } from './bid-criteria-rules.ts';

export const CRITERION_KINDS = ['SCORED', 'PASS_FAIL'] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** Whole weights of the scored criteria add up to this (BR-BID-04). */
export const TOTAL_WEIGHT = 100;
export const MAX_CRITERIA = 50;
export const MAX_EVIDENCE = 10;
const MAX_SCALE = 100;
const MIN_NAME = 3;
const MAX_NAME = 300;
const MAX_CODE = 30;
const MIN_LEGAL_BASIS = 3;
const MAX_LEGAL_BASIS = 2000;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CRITERION_KEYS: readonly string[] = ['code', 'name', 'kind', 'weight', 'max_score', 'threshold', 'mandatory', 'required_evidence'];

/** One criterion as it is stored: a scored one has a weight, a scale and maybe a threshold; a pass/fail one has none of them. */
export interface Criterion {
  code: string;
  name: string;
  kind: CriterionKind;
  weight: number | null;
  maxScore: number | null;
  /** The lowest score that still passes; a mandatory criterion below it fails the whole evaluation without making up for it elsewhere. */
  threshold: number | null;
  mandatory: boolean;
  requiredEvidence: string[];
}

export interface CheckedCriteria {
  criteria: Criterion[];
  /** The sum of the weights of the scored criteria; null when no criterion is scored. */
  weightsSum: number | null;
}

export interface NewCriteriaInput {
  packageId: string;
  criteriaJson: unknown;
  legalBasis: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const TAB = 9;
const SPACE = 32;
const DELETE = 127;

function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < SPACE || code === DELETE || code === TAB) return true;
  }
  return false;
}

function textOf(value: unknown, field: string, min: number, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max || hasControl(text)) throw invalid(field);
  return text;
}

function wholeNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

/** The legal basis of a version of criteria: why these criteria, in the words of the maker. */
export const legalBasisOf = (value: unknown): string => textOf(value, 'legal_basis', MIN_LEGAL_BASIS, MAX_LEGAL_BASIS);

function criterionOf(raw: unknown, index: number): Criterion {
  const at = (key: string): string => `criteria_json.criteria.${index}.${key}`;
  if (!isRecord(raw)) throw invalid(`criteria_json.criteria.${index}`);
  const extra = Object.keys(raw).find((key) => !CRITERION_KEYS.includes(key));
  if (extra !== undefined) throw new DomainError('FIELD_NOT_ALLOWED', 400, at(extra));
  const code = textOf(raw.code, at('code'), 1, MAX_CODE);
  if (!CODE.test(code)) throw invalid(at('code'));
  const kind = CRITERION_KINDS.find((candidate) => candidate === raw.kind);
  if (kind === undefined) throw invalid(at('kind'));
  if (typeof raw.mandatory !== 'boolean') throw invalid(at('mandatory'));
  const evidence = raw.required_evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) throw invalid(at('required_evidence'));
  const requiredEvidence = evidence.map((item: unknown, position) => textOf(item, `${at('required_evidence')}.${position}`, MIN_NAME, MAX_NAME));
  const common = { code, name: textOf(raw.name, at('name'), MIN_NAME, MAX_NAME), kind, mandatory: raw.mandatory, requiredEvidence };
  if (kind === 'PASS_FAIL') {
    for (const key of ['weight', 'max_score', 'threshold']) if (raw[key] !== undefined && raw[key] !== null) throw invalid(at(key));
    return { ...common, weight: null, maxScore: null, threshold: null };
  }
  const maxScore = wholeNumber(raw.max_score, at('max_score'), 1, MAX_SCALE);
  const threshold = raw.threshold === undefined || raw.threshold === null ? null : wholeNumber(raw.threshold, at('threshold'), 0, maxScore);
  return { ...common, weight: wholeNumber(raw.weight, at('weight'), 1, TOTAL_WEIGHT), maxScore, threshold };
}

/**
 * Reads the criteria out of the body of the command and judges them in the order of BID 3 F4: the shape (VALIDATION_FAILED, FIELD_NOT_ALLOWED
 * for a member that is not part of a criterion), then the criteria nobody may ask for (PROHIBITED_CRITERION, naming the criterion, the rule and
 * its legal basis), then the weights (CRITERIA_WEIGHT_INVALID unless the scored criteria add up to exactly 100). A set without a scored criterion
 * has no weights to add up; it is a list of requirements that are met or not.
 */
export function readCriteria(raw: unknown): CheckedCriteria {
  if (!isRecord(raw)) throw invalid('criteria_json');
  const extra = Object.keys(raw).find((key) => key !== 'criteria');
  if (extra !== undefined) throw new DomainError('FIELD_NOT_ALLOWED', 400, `criteria_json.${extra}`);
  const list = raw.criteria;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CRITERIA) throw invalid('criteria_json.criteria');
  const criteria = list.map(criterionOf);
  const duplicate = criteria.findIndex((criterion, index) => criteria.findIndex((other) => other.code.toLowerCase() === criterion.code.toLowerCase()) !== index);
  if (duplicate >= 0) throw invalid(`criteria_json.criteria.${duplicate}.code`);
  criteria.forEach((criterion, index) => {
    for (const text of [criterion.name, ...criterion.requiredEvidence]) {
      const rule = prohibitedRuleOf(text);
      if (rule !== undefined) {
        throw new DomainError('PROHIBITED_CRITERION', 422, `criteria_json.criteria.${index}.name`, {
          extensions: { criterion_code: criterion.code, rule: rule.code, category: rule.category, legal_basis: rule.legalBasis },
        });
      }
    }
  });
  const scored = criteria.filter((criterion) => criterion.kind === 'SCORED');
  const weightsSum = scored.length === 0 ? null : scored.reduce((sum, criterion) => sum + (criterion.weight ?? 0), 0);
  if (weightsSum !== null && weightsSum !== TOTAL_WEIGHT) {
    throw new DomainError('CRITERIA_WEIGHT_INVALID', 422, 'criteria_json.criteria', { extensions: { weights_sum: weightsSum, expected: TOTAL_WEIGHT } });
  }
  return { criteria, weightsSum };
}

/** The criteria as they are written into the column: the members of the contract, in snake case. */
export function criteriaDocument(criteria: readonly Criterion[]): { criteria: Array<Record<string, unknown>> } {
  return {
    criteria: criteria.map((criterion) => ({
      code: criterion.code,
      name: criterion.name,
      kind: criterion.kind,
      weight: criterion.weight,
      max_score: criterion.maxScore,
      threshold: criterion.threshold,
      mandatory: criterion.mandatory,
      required_evidence: criterion.requiredEvidence,
    })),
  };
}
