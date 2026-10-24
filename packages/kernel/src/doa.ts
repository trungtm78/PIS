import { DomainError } from './errors.ts';
import { findingOf } from './rule-findings.ts';
import type { RuleFinding } from './rule-findings.ts';

/**
 * The delegation-of-authority matrix of a tenant (ADM 3.6, BR-ADM-03, BR-ADM-04): for a kind of document, an organisation unit
 * and an amount, which role approves and through how many levels. The thresholds are tenant data (CXN-DOA-01), never code.
 * Amounts are whole VND written as decimal strings and compared as integers: a threshold is never rounded or floated.
 */

/** One rule of a matrix version (`DoaRule` of openapi.json): a band `[amount_min_vnd, amount_max_vnd)` for a document type at a unit. */
export interface DoaRuleContent {
  document_type: string;
  unit_id: string;
  /** Whether the rule also holds for the units below the unit; default true. */
  include_subtree?: boolean;
  amount_min_vnd: string;
  /** Absent or null: the band has no upper end. */
  amount_max_vnd?: string | null;
  approver_role_id: string;
  approval_levels?: number;
  requires_distinct_approvers?: boolean;
}

export interface DoaRuleRecord extends DoaRuleContent {
  id: string;
}

export type DoaFinding = RuleFinding;

const AMOUNT = /^(0|[1-9][0-9]{0,23})$/;
const MESSAGE_PREFIX = 'adm.doa.error';
const finding = (field: string, code: string): DoaFinding => findingOf(MESSAGE_PREFIX, field, code);

/** A whole non-negative number of VND, or undefined when the text is not one. */
export function parseVnd(text: string): bigint | undefined {
  return AMOUNT.test(text) ? BigInt(text) : undefined;
}

interface Band {
  index: number;
  min: bigint;
  /** undefined: no upper end. */
  max: bigint | undefined;
}

function shapeFindings(rules: readonly DoaRuleContent[]): { found: DoaFinding[]; bands: Map<string, Band[]> } {
  const found: DoaFinding[] = [];
  const bands = new Map<string, Band[]>();
  rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (rule.document_type.trim() === '') found.push(finding(`${at}.document_type`, 'DOCUMENT_TYPE_REQUIRED'));
    const min = parseVnd(rule.amount_min_vnd);
    if (min === undefined) found.push(finding(`${at}.amount_min_vnd`, 'AMOUNT_INVALID'));
    const hasMax = rule.amount_max_vnd !== undefined && rule.amount_max_vnd !== null;
    const max = hasMax ? parseVnd(rule.amount_max_vnd as string) : undefined;
    if (hasMax && max === undefined) found.push(finding(`${at}.amount_max_vnd`, 'AMOUNT_INVALID'));
    if (min === undefined || (hasMax && max === undefined)) return;
    if (max !== undefined && max <= min) {
      found.push(finding(`${at}.amount_max_vnd`, 'RANGE_INVALID'));
      return;
    }
    const key = `${rule.document_type}\u0000${rule.unit_id}`;
    bands.set(key, [...(bands.get(key) ?? []), { index, min, max }]);
  });
  return { found, bands };
}

/** The bands of one (document type, unit), lowest first: where they overlap, where they leave a gap, where they stop short of zero or infinity. */
function bandFindings(group: readonly Band[], complete: boolean): DoaFinding[] {
  const found: DoaFinding[] = [];
  const ordered = [...group].sort((a, b) => (a.min < b.min ? -1 : a.min > b.min ? 1 : a.index - b.index));
  let covered: bigint | undefined = 0n;
  for (const [position, band] of ordered.entries()) {
    const at = `rules[${band.index}]`;
    if (position === 0) {
      if (complete && band.min !== 0n) found.push(finding(`${at}.amount_min_vnd`, 'NOT_FROM_ZERO'));
    } else if (covered === undefined || band.min < covered) {
      found.push(finding(`${at}.amount_min_vnd`, 'OVERLAP'));
    } else if (complete && band.min > covered) {
      found.push(finding(`${at}.amount_min_vnd`, 'GAP'));
    }
    // The end of what the bands so far reach: the furthest upper end, or none when a band has no end.
    if (band.max === undefined) covered = undefined;
    else if (covered !== undefined && band.max > covered) covered = band.max;
  }
  const last = ordered[ordered.length - 1];
  if (complete && last !== undefined && covered !== undefined) found.push(finding(`rules[${last.index}].amount_max_vnd`, 'NOT_TO_INFINITY'));
  return found;
}

function findingsOf(rules: readonly DoaRuleContent[], complete: boolean): DoaFinding[] {
  const { found, bands } = shapeFindings(rules);
  for (const group of bands.values()) found.push(...bandFindings(group, complete));
  // A matrix without a rule decides nothing: whoever approved it would leave every document without an approver.
  if (complete && rules.length === 0) found.push(finding('rules', 'NO_RULES'));
  return found.sort((a, b) => a.field.localeCompare(b.field, 'en', { numeric: true }));
}

/**
 * What a draft must satisfy to be stored: every amount a whole number of VND, every band a proper interval, and no two bands
 * of one document type and unit overlapping (the database also refuses an overlap). Gaps are allowed in a draft: the editor shows them.
 */
export function draftFindings(rules: readonly DoaRuleContent[]): DoaFinding[] {
  return findingsOf(rules, false);
}

/** What a matrix must satisfy to be submitted (BR-ADM-04): the draft rules, and for each document type and unit bands that run from 0 to no upper end without a gap. */
export function submitFindings(rules: readonly DoaRuleContent[]): DoaFinding[] {
  return findingsOf(rules, true);
}

/** Refuses with 422 DOA_MATRIX_INVALID, naming the first field and listing every finding in `errors`; does nothing when there are none. */
export function refuseDoa(found: readonly DoaFinding[]): void {
  if (found.length > 0) throw new DomainError('DOA_MATRIX_INVALID', 422, found[0]?.field, { extensions: { errors: found } });
}

/** Fails with 422 DOA_MATRIX_INVALID listing every finding of `draftFindings` in `errors`. */
export function validateDoaDraft(rules: readonly DoaRuleContent[]): void {
  refuseDoa(draftFindings(rules));
}

/** Fails with 422 DOA_MATRIX_INVALID listing every finding of `submitFindings` in `errors` (`GAP`, `OVERLAP`, `NOT_FROM_ZERO`, `NOT_TO_INFINITY` and the shape findings). */
export function validateDoaForSubmit(rules: readonly DoaRuleContent[]): void {
  refuseDoa(submitFindings(rules));
}

/** A version of the matrix with its rules, as `resolveDoa` reads it. */
export interface DoaMatrixRecord {
  id: string;
  status: string;
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
  /** `YYYY-MM-DD`, exclusive; null: no end. */
  effectiveUntil: string | null;
  rules: readonly DoaRuleRecord[];
}

export interface DoaQuery {
  documentType: string;
  /** Whole VND; null for a document that has no amount (the band that holds 0 applies). */
  amountVnd: string | null;
  unitId: string;
  /** `YYYY-MM-DD`: the matrix in force on this day applies. */
  businessDate: string;
}

export interface DoaResolution {
  /** The version that decided: an instance pins it, so a later matrix never changes a running approval. */
  matrixVersionId: string;
  ruleId: string;
  /** The unit of the rule that applied: the nearest one at or above the unit asked about. */
  ruleUnitId: string;
  approverRoleId: string;
  approvalLevels: number;
  requiresDistinctApprovers: boolean;
}

const notFound = (field: string): DomainError => new DomainError('DOA_RULE_NOT_FOUND', 422, field);

/** The matrix in force on a day: a published version, or one that was superseded but covered the day. */
function matrixOn(matrices: readonly DoaMatrixRecord[], businessDate: string): DoaMatrixRecord | undefined {
  return matrices
    .filter((matrix) => (matrix.status === 'Published' || matrix.status === 'Superseded') && matrix.effectiveFrom <= businessDate && (matrix.effectiveUntil === null || businessDate < matrix.effectiveUntil))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

/**
 * Who approves a document (BR-ADM-03): the matrix in force on the business date; its rules for the document type whose unit is
 * the unit asked about, or above it with the subtree included; the nearest such unit (the longest path) wins; in it the band
 * with `min <= amount < max` (no max: no end). `unitPaths` gives the materialised path of every unit involved
 * (`/<root id>/.../<unit id>/`). Fails with 422 `DOA_RULE_NOT_FOUND` when no matrix, no rule or no band applies, and with
 * 422 `VALIDATION_FAILED` for an amount that is not whole VND or a unit without a path.
 */
export function resolveDoa(matrices: readonly DoaMatrixRecord[], unitPaths: ReadonlyMap<string, string>, query: DoaQuery): DoaResolution {
  const amount = query.amountVnd === null ? 0n : parseVnd(query.amountVnd);
  if (amount === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'amount_vnd');
  const target = unitPaths.get(query.unitId);
  if (target === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'unit_id');
  const matrix = matrixOn(matrices, query.businessDate);
  if (matrix === undefined) throw notFound('business_date');
  const reaching = matrix.rules.filter((rule) => {
    if (rule.document_type !== query.documentType) return false;
    if (rule.unit_id === query.unitId) return true;
    const path = unitPaths.get(rule.unit_id);
    return path !== undefined && (rule.include_subtree ?? true) && target.startsWith(path);
  });
  const depth = (rule: DoaRuleRecord): number => (unitPaths.get(rule.unit_id) ?? '').length;
  const nearest = Math.max(-1, ...reaching.map(depth));
  const band = reaching
    .filter((rule) => depth(rule) === nearest)
    .find((rule) => {
      const min = parseVnd(rule.amount_min_vnd);
      if (min === undefined || min > amount) return false;
      if (rule.amount_max_vnd === undefined || rule.amount_max_vnd === null) return true;
      const max = parseVnd(rule.amount_max_vnd);
      return max !== undefined && amount < max;
    });
  if (band === undefined) throw notFound('amount_vnd');
  return {
    matrixVersionId: matrix.id,
    ruleId: band.id,
    ruleUnitId: band.unit_id,
    approverRoleId: band.approver_role_id,
    approvalLevels: band.approval_levels ?? 1,
    requiresDistinctApprovers: band.requires_distinct_approvers ?? true,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isCalendarDate = (value: string): boolean => ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** The findings about the dates of a matrix version: both are real dates and the version ends after it starts. */
export function headerFindings(effectiveFrom: string, effectiveUntil: string | null | undefined): DoaFinding[] {
  const found: DoaFinding[] = [];
  if (!isCalendarDate(effectiveFrom)) found.push(finding('effective_from', 'DATE_INVALID'));
  if (effectiveUntil !== undefined && effectiveUntil !== null) {
    if (!isCalendarDate(effectiveUntil)) found.push(finding('effective_until', 'DATE_INVALID'));
    else if (isCalendarDate(effectiveFrom) && effectiveUntil <= effectiveFrom) found.push(finding('effective_until', 'RANGE_INVALID'));
  }
  return found;
}

/** The finding for a version that would not start after the one in force. */
export const notAfterCurrentFinding = (): DoaFinding => finding('effective_from', 'NOT_AFTER_CURRENT');

/** A rule that names a unit or a role the tenant does not have (or no longer has). */
export const unknownReferenceFinding = (index: number, field: 'unit_id' | 'approver_role_id'): DoaFinding =>
  finding(`rules[${index}].${field}`, field === 'unit_id' ? 'UNIT_UNKNOWN' : 'ROLE_UNKNOWN');
