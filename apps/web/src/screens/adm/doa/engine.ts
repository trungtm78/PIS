/**
 * The delegation-of-authority rules of the matrix, for the band chart, the findings before a submission and the "who approves"
 * preview of ADM-15. The rule is the one of packages/kernel/src/doa.ts (the server decides and stores); both are held to the same
 * answers by packages/contracts/test-vectors/doa-matrix.json, so the screen shows what the server will do.
 * Amounts are whole VND written as decimal strings and compared as integers.
 */

export interface DoaRuleInput {
  document_type: string;
  unit_id: string;
  include_subtree?: boolean;
  amount_min_vnd: string;
  amount_max_vnd?: string | null;
  approver_role_id: string;
  approval_levels?: number;
  requires_distinct_approvers?: boolean;
}

export interface DoaRuleRecord extends DoaRuleInput {
  id: string;
}

export interface Finding {
  field: string;
  code: string;
}

const AMOUNT = /^(0|[1-9][0-9]{0,23})$/;

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

const groupKey = (rule: DoaRuleInput): string => `${rule.document_type}\u0000${rule.unit_id}`;

function shapeFindings(rules: readonly DoaRuleInput[]): { found: Finding[]; bands: Map<string, Band[]> } {
  const found: Finding[] = [];
  const bands = new Map<string, Band[]>();
  rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (rule.document_type.trim() === '') found.push({ field: `${at}.document_type`, code: 'DOCUMENT_TYPE_REQUIRED' });
    const min = parseVnd(rule.amount_min_vnd);
    if (min === undefined) found.push({ field: `${at}.amount_min_vnd`, code: 'AMOUNT_INVALID' });
    const hasMax = rule.amount_max_vnd !== undefined && rule.amount_max_vnd !== null;
    const max = hasMax ? parseVnd(rule.amount_max_vnd as string) : undefined;
    if (hasMax && max === undefined) found.push({ field: `${at}.amount_max_vnd`, code: 'AMOUNT_INVALID' });
    if (min === undefined || (hasMax && max === undefined)) return;
    if (max !== undefined && max <= min) {
      found.push({ field: `${at}.amount_max_vnd`, code: 'RANGE_INVALID' });
      return;
    }
    const key = groupKey(rule);
    bands.set(key, [...(bands.get(key) ?? []), { index, min, max }]);
  });
  return { found, bands };
}

const byMin = (a: Band, b: Band): number => (a.min < b.min ? -1 : a.min > b.min ? 1 : a.index - b.index);

function bandFindings(group: readonly Band[], complete: boolean): Finding[] {
  const found: Finding[] = [];
  const ordered = [...group].sort(byMin);
  let covered: bigint | undefined = 0n;
  for (const [position, band] of ordered.entries()) {
    const at = `rules[${band.index}]`;
    if (position === 0) {
      if (complete && band.min !== 0n) found.push({ field: `${at}.amount_min_vnd`, code: 'NOT_FROM_ZERO' });
    } else if (covered === undefined || band.min < covered) {
      found.push({ field: `${at}.amount_min_vnd`, code: 'OVERLAP' });
    } else if (complete && band.min > covered) {
      found.push({ field: `${at}.amount_min_vnd`, code: 'GAP' });
    }
    if (band.max === undefined) covered = undefined;
    else if (covered !== undefined && band.max > covered) covered = band.max;
  }
  const last = ordered[ordered.length - 1];
  if (complete && last !== undefined && covered !== undefined) found.push({ field: `rules[${last.index}].amount_max_vnd`, code: 'NOT_TO_INFINITY' });
  return found;
}

function findingsOf(rules: readonly DoaRuleInput[], complete: boolean): Finding[] {
  const { found, bands } = shapeFindings(rules);
  for (const group of bands.values()) found.push(...bandFindings(group, complete));
  if (complete && rules.length === 0) found.push({ field: 'rules', code: 'NO_RULES' });
  return found.sort((a, b) => a.field.localeCompare(b.field, 'en', { numeric: true }));
}

/** What a draft must satisfy to be saved: whole-VND amounts, proper bands, no overlap. Gaps are allowed. */
export const draftFindings = (rules: readonly DoaRuleInput[]): Finding[] => findingsOf(rules, false);

/** What a matrix must satisfy to be submitted: the draft rules, and bands from 0 to no end without a gap, for each document type and unit. */
export const submitFindings = (rules: readonly DoaRuleInput[]): Finding[] => findingsOf(rules, true);

export interface Segment {
  kind: 'band' | 'gap';
  /** The rule of a band. */
  index: number | null;
  /** Whole VND; null for a gap that has no upper end. */
  from: string;
  to: string | null;
  /** The band overlaps the one before it. */
  overlaps: boolean;
}

export interface BandRow {
  documentType: string;
  unitId: string;
  segments: Segment[];
}

/**
 * The bands of each document type and unit, lowest first, with the gaps between them (and before the first band and after the last
 * when they do not run from 0 to no end) as segments of their own, so a gap is seen before the matrix is submitted.
 */
export function bandRows(rules: readonly DoaRuleInput[]): BandRow[] {
  const { bands } = shapeFindings(rules);
  return [...bands.entries()].map(([key, group]) => {
    const [documentType = '', unitId = ''] = key.split('\u0000');
    const segments: Segment[] = [];
    let covered: bigint | undefined = 0n;
    for (const band of [...group].sort(byMin)) {
      const overlaps = covered === undefined || band.min < covered;
      if (covered !== undefined && band.min > covered) segments.push({ kind: 'gap', index: null, from: covered.toString(), to: band.min.toString(), overlaps: false });
      segments.push({ kind: 'band', index: band.index, from: band.min.toString(), to: band.max === undefined ? null : band.max.toString(), overlaps });
      if (band.max === undefined) covered = undefined;
      else if (covered !== undefined && band.max > covered) covered = band.max;
    }
    if (covered !== undefined) segments.push({ kind: 'gap', index: null, from: covered.toString(), to: null, overlaps: false });
    return { documentType, unitId, segments };
  });
}

export interface DoaMatrixRecord {
  id: string;
  status: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  rules: readonly DoaRuleRecord[];
}

export interface DoaQuery {
  documentType: string;
  amountVnd: string | null;
  unitId: string;
  businessDate: string;
}

export interface DoaResolution {
  matrixVersionId: string;
  ruleId: string;
  ruleUnitId: string;
  approverRoleId: string;
  approvalLevels: number;
  requiresDistinctApprovers: boolean;
}

export type ResolveFailure = 'amount' | 'unit' | 'notFound';

export type Resolved = { ok: true; resolution: DoaResolution } | { ok: false; failure: ResolveFailure };

function matrixOn(matrices: readonly DoaMatrixRecord[], businessDate: string): DoaMatrixRecord | undefined {
  return matrices
    .filter((matrix) => (matrix.status === 'Published' || matrix.status === 'Superseded') && matrix.effectiveFrom <= businessDate && (matrix.effectiveUntil === null || businessDate < matrix.effectiveUntil))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

/**
 * Who approves a document (BR-ADM-03): the matrix in force on the business date, the nearest unit that has a rule for the document
 * type, in it the band that holds the amount. `unitPaths` is the path of each unit (`/<root id>/.../<unit id>/`). A failure says why
 * nobody was found instead of throwing: the preview shows it as a warning.
 */
export function resolveDoa(matrices: readonly DoaMatrixRecord[], unitPaths: ReadonlyMap<string, string>, query: DoaQuery): Resolved {
  const amount = query.amountVnd === null ? 0n : parseVnd(query.amountVnd);
  if (amount === undefined) return { ok: false, failure: 'amount' };
  const target = unitPaths.get(query.unitId);
  if (target === undefined) return { ok: false, failure: 'unit' };
  const matrix = matrixOn(matrices, query.businessDate);
  if (matrix === undefined) return { ok: false, failure: 'notFound' };
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
  if (band === undefined) return { ok: false, failure: 'notFound' };
  return {
    ok: true,
    resolution: {
      matrixVersionId: matrix.id,
      ruleId: band.id,
      ruleUnitId: band.unit_id,
      approverRoleId: band.approver_role_id,
      approvalLevels: band.approval_levels ?? 1,
      requiresDistinctApprovers: band.requires_distinct_approvers ?? true,
    },
  };
}

/** The materialised path of each unit from the parent links of the unit list (`/<root id>/.../<unit id>/`), as the server keeps it. */
export function unitPathsOf(units: ReadonlyArray<{ id: string; parent_id: string | null }>): Map<string, string> {
  const parents = new Map(units.map((unit) => [unit.id, unit.parent_id]));
  const paths = new Map<string, string>();
  for (const unit of units) {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let current: string | null | undefined = unit.id; current !== null && current !== undefined && !seen.has(current); current = parents.get(current)) {
      seen.add(current);
      chain.unshift(current);
    }
    paths.set(unit.id, `/${chain.join('/')}/`);
  }
  return paths;
}

/** A whole-VND amount with the thousands separators of the language, exact for any size. */
export function formatVnd(amount: string, locale: string): string {
  const value = parseVnd(amount);
  return value === undefined ? amount : value.toLocaleString(locale);
}
