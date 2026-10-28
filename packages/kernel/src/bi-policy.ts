import { DomainError } from './errors.ts';

/**
 * The row and column policies of BI (ST-BI-003, BI 3 BR-BI-05): closed by default. A person reaches the data of a dataset only through a policy that is ACTIVE for them: no policy is a refusal
 * (ACCESS_POLICY_MISSING), never an empty answer that looks like "no data". A policy narrows, it never widens: its predicate is ANDed with the scope the person holds by their grants, and the columns it hides
 * are not in the answer at all.
 */
export const POLICY_GRANTEE_KINDS = ['ROLE', 'UNIT_TREE', 'MEMBERSHIP'] as const;
export type PolicyGranteeKind = (typeof POLICY_GRANTEE_KINDS)[number];
export const COLUMN_MASKS = ['HIDE', 'MASK'] as const;
export type ColumnMask = (typeof COLUMN_MASKS)[number];

const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_DEPTH = 5;
const MAX_NODES = 30;
const MAX_VALUES = 100;
const MAX_COLUMNS = 50;
const MAX_TEXT = 120;

export interface PolicyProblem {
  code: 'PREDICATE_NOT_ALLOWED' | 'DIMENSION_NOT_IN_DATASET' | 'VALIDATION_FAILED';
  field: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): boolean => (typeof value === 'string' && value.length <= MAX_TEXT) || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const refuse = (field: string): PolicyProblem => ({ code: 'PREDICATE_NOT_ALLOWED', field });

function checkNode(node: unknown, dimensions: readonly string[], path: string, depth: number, budget: { nodes: number }): PolicyProblem | undefined {
  budget.nodes += 1;
  if (!isRecord(node) || typeof node.op !== 'string' || depth > MAX_DEPTH || budget.nodes > MAX_NODES) return refuse(path);
  const keys = Object.keys(node);
  switch (node.op) {
    case 'unit_in_scope':
      return keys.length === 1 ? undefined : refuse(path);
    case 'eq':
    case 'ne':
      return keys.length === 3 && typeof node.field === 'string' && isScalar(node.value) ? fieldProblem(node.field, dimensions, path) : refuse(path);
    case 'in':
      return keys.length === 3 && typeof node.field === 'string' && Array.isArray(node.values) && node.values.length >= 1 && node.values.length <= MAX_VALUES && node.values.every(isScalar)
        ? fieldProblem(node.field, dimensions, path)
        : refuse(path);
    case 'and':
    case 'or': {
      if (keys.length !== 2 || !Array.isArray(node.args) || node.args.length < 2 || node.args.length > 8) return refuse(path);
      for (const [index, child] of (node.args as unknown[]).entries()) {
        const problem = checkNode(child, dimensions, `${path}.args[${index}]`, depth + 1, budget);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case 'not':
      return keys.length === 2 && Array.isArray(node.args) && node.args.length === 1 ? checkNode(node.args[0], dimensions, `${path}.args[0]`, depth + 1, budget) : refuse(path);
    default:
      return refuse(path);
  }
}

function fieldProblem(field: string, dimensions: readonly string[], path: string): PolicyProblem | undefined {
  if (!FIELD.test(field)) return refuse(path);
  return dimensions.includes(field) ? undefined : { code: 'DIMENSION_NOT_IN_DATASET', field };
}

/**
 * The first problem of a row predicate, or none. The grammar is small: the unit being in the scope of the person, a field equal to, different from or among some values, and and, or, not over those. A field must be a
 * dimension of the dataset (the dataset says what can be cut, ST-BI-002); there is no literal "true" and no free text, so a predicate cannot be written that reads what the grants do not allow.
 */
export function predicateProblem(node: unknown, dimensions: readonly string[]): PolicyProblem | undefined {
  return checkNode(node, dimensions, 'row_predicate', 1, { nodes: 0 });
}

/** The columns a policy hides or masks: a plain record of column name to HIDE or MASK. */
export function columnMasksProblem(masks: unknown): PolicyProblem | undefined {
  if (!isRecord(masks)) return { code: 'VALIDATION_FAILED', field: 'column_masks' };
  const entries = Object.entries(masks);
  if (entries.length > MAX_COLUMNS) return { code: 'VALIDATION_FAILED', field: 'column_masks' };
  for (const [column, mode] of entries) {
    if (!FIELD.test(column) || !(COLUMN_MASKS as readonly unknown[]).includes(mode)) return { code: 'VALIDATION_FAILED', field: `column_masks.${column}` };
  }
  return undefined;
}

export interface PolicyView {
  id: string;
  rowPredicate: unknown;
  columnMasks: Record<string, string>;
}

/**
 * The policies that apply to a person for a dataset: with none the answer is a refusal, never an empty list (closed by default). Several may apply together; the rows are what any of them allows within the scope
 * of the person, and a column is hidden when any of them hides it (a policy only hides, so the safe reading is the union of what is hidden).
 */
export function requireApplicablePolicies<T extends PolicyView>(policies: readonly T[]): readonly T[] {
  if (policies.length === 0) throw new DomainError('ACCESS_POLICY_MISSING', 403);
  return policies;
}

/** The columns hidden from the person: those any applicable policy hides (HIDE), and those it masks. */
export function hiddenColumns(policies: readonly PolicyView[]): { hidden: string[]; masked: string[] } {
  const hidden = new Set<string>();
  const masked = new Set<string>();
  for (const policy of policies) {
    for (const [column, mode] of Object.entries(policy.columnMasks)) (mode === 'HIDE' ? hidden : masked).add(column);
  }
  for (const column of hidden) masked.delete(column);
  return { hidden: [...hidden].sort(), masked: [...masked].sort() };
}
