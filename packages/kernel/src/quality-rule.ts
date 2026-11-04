import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';
import { hasControlChar } from './control-chars.ts';

/**
 * Data quality rules (ST-DGV-002, DGV 3.3 F3): the declarative, allowlisted expression a steward may write, the threshold it is judged by, and
 * the arithmetic of a run (BR-DGV-02, BR-DGV-03). Nothing here reads a database or a clock. A rule is data, never code: the only things that
 * can appear in its expression are the operators below, applied to the fields that the source of the dataset names, so a rule that is stored
 * can be compiled to a parameterised query without trusting its author.
 */

export const QUALITY_DIMENSIONS = ['COMPLETENESS', 'VALIDITY', 'UNIQUENESS', 'CONSISTENCY', 'TIMELINESS', 'ACCURACY', 'INTEGRITY'] as const;
export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];
export const ACTIONS_ON_FAIL = ['HARD_BLOCK', 'QUARANTINE', 'WARN'] as const;
export type ActionOnFail = (typeof ACTIONS_ON_FAIL)[number];
export const RULE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];
export const RULE_RESULTS = ['PASS', 'WARN', 'FAIL', 'ERROR'] as const;
export type RuleResult = (typeof RULE_RESULTS)[number];
export type RunOverall = 'PASSED' | 'WARNING' | 'FAILED';

/** The hours an incident of each severity may stay open (BR-DGV-05; working assumptions until the data owner signs the governance rules). */
export const INCIDENT_SLA_HOURS: Readonly<Record<RuleSeverity, number>> = { CRITICAL: 4, HIGH: 24, MEDIUM: 72, LOW: 240 };

export const CRITICALITY_WEIGHT_MIN = 1;
export const CRITICALITY_WEIGHT_MAX = 10;

export type FieldType = 'uuid' | 'text' | 'numeric';

/** What a rule may look at: the fields of one source relation, and which of them may be checked against a table of the tenant. */
export interface QualitySourceShape {
  fields: Readonly<Record<string, FieldType>>;
  references: ReadonlySet<string>;
}

export const COMPARATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;
export type Comparator = (typeof COMPARATORS)[number];

export type QualityExpr =
  | { op: 'not_null'; field: string }
  | { op: 'not_blank'; field: string }
  | { op: 'is_null'; field: string }
  | { op: 'compare'; field: string; cmp: Comparator; value: string }
  | { op: 'compare_fields'; left: string; cmp: Comparator; right: string }
  | { op: 'between'; field: string; min: string; max: string }
  | { op: 'in'; field: string; values: string[] }
  | { op: 'unique'; fields: string[] }
  | { op: 'reference_exists'; field: string }
  | { op: 'snapshot_age_within'; seconds: number }
  | { op: 'and' | 'or'; args: QualityExpr[] }
  | { op: 'not'; arg: QualityExpr };

const MAX_DEPTH = 4;
const MAX_NODES = 20;
const MAX_IN_VALUES = 50;
const MAX_UNIQUE_FIELDS = 4;
const MAX_TEXT_LITERAL = 200;
const MAX_AGE_SECONDS = 31_536_000;
const NUMERIC_LITERAL = /^-?\d{1,18}(\.\d{1,6})?$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The operators each dimension may use. A dimension with an empty list cannot be written as a rule yet (accuracy needs a confirmed source or an expert sample). */
const LEAVES: Readonly<Record<QualityDimension, ReadonlySet<QualityExpr['op']>>> = {
  COMPLETENESS: new Set(['not_null', 'not_blank']),
  VALIDITY: new Set(['compare', 'between', 'in', 'is_null', 'not_null', 'not_blank']),
  CONSISTENCY: new Set(['compare_fields', 'compare', 'is_null', 'not_null']),
  UNIQUENESS: new Set(),
  TIMELINESS: new Set(),
  ACCURACY: new Set(),
  INTEGRITY: new Set(['reference_exists']),
};
const COMBINATORS: Readonly<Record<QualityDimension, ReadonlySet<QualityExpr['op']>>> = {
  COMPLETENESS: new Set(['and']),
  VALIDITY: new Set(['and', 'or', 'not']),
  CONSISTENCY: new Set(['and', 'or', 'not']),
  UNIQUENESS: new Set(),
  TIMELINESS: new Set(),
  ACCURACY: new Set(),
  INTEGRITY: new Set(['and']),
};
/** Operators that stand alone as the whole rule of their dimension. */
const WHOLE: Readonly<Partial<Record<QualityDimension, QualityExpr['op']>>> = { UNIQUENESS: 'unique', TIMELINESS: 'snapshot_age_within' };

const notAllowed = (detail = 'expression_ast'): DomainError => new DomainError('EXPRESSION_NOT_ALLOWED', 422, detail);

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw notAllowed();
  return value as Record<string, unknown>;
};

/** The node must carry exactly the keys it is allowed: an extra key (raw SQL, a function call) is refused, never ignored. */
function onlyKeys(node: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(node)) if (key !== 'op' && !keys.includes(key)) throw notAllowed();
  for (const key of keys) if (!(key in node)) throw notAllowed();
}

function fieldOf(source: QualitySourceShape, value: unknown): { name: string; type: FieldType } {
  if (typeof value !== 'string' || !FIELD_NAME.test(value) || !Object.hasOwn(source.fields, value)) throw notAllowed();
  return { name: value, type: source.fields[value] as FieldType };
}

function literalOf(type: FieldType, value: unknown): string {
  if (type === 'numeric') {
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof text !== 'string' || !NUMERIC_LITERAL.test(text)) throw notAllowed();
    return text;
  }
  if (type === 'uuid') {
    const id = asUuid(value);
    if (id === undefined) throw notAllowed();
    return id;
  }
  if (typeof value !== 'string' || value === '' || value.length > MAX_TEXT_LITERAL || hasControlChar(value)) throw notAllowed();
  return value;
}

function comparatorOf(value: unknown): Comparator {
  if (typeof value !== 'string' || !COMPARATORS.some((comparator) => comparator === value)) throw notAllowed();
  return value as Comparator;
}

const ORDERED: ReadonlySet<Comparator> = new Set(['gt', 'gte', 'lt', 'lte']);

interface Walk {
  dimension: QualityDimension;
  source: QualitySourceShape;
  fields: Set<string>;
  nodes: number;
}

function walk(raw: unknown, state: Walk, depth: number): QualityExpr {
  if (depth > MAX_DEPTH) throw notAllowed();
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw notAllowed();
  const node = asObject(raw);
  const op = node.op;
  if (typeof op !== 'string') throw notAllowed();
  const { dimension, source } = state;
  if (COMBINATORS[dimension].has(op as QualityExpr['op'])) {
    if (op === 'not') {
      onlyKeys(node, ['arg']);
      return { op: 'not', arg: walk(node.arg, state, depth + 1) };
    }
    onlyKeys(node, ['args']);
    if (!Array.isArray(node.args) || node.args.length < 2) throw notAllowed();
    return { op: op as 'and' | 'or', args: node.args.map((arg) => walk(arg, state, depth + 1)) };
  }
  if (!LEAVES[dimension].has(op as QualityExpr['op']) && WHOLE[dimension] !== op) throw notAllowed();
  switch (op) {
    case 'not_null':
    case 'not_blank':
    case 'is_null': {
      onlyKeys(node, ['field']);
      const field = fieldOf(source, node.field);
      if (op === 'not_blank' && field.type !== 'text') throw notAllowed();
      state.fields.add(field.name);
      return { op, field: field.name };
    }
    case 'compare': {
      onlyKeys(node, ['field', 'cmp', 'value']);
      const field = fieldOf(source, node.field);
      const cmp = comparatorOf(node.cmp);
      if (field.type !== 'numeric' && ORDERED.has(cmp)) throw notAllowed();
      state.fields.add(field.name);
      return { op, field: field.name, cmp, value: literalOf(field.type, node.value) };
    }
    case 'compare_fields': {
      onlyKeys(node, ['left', 'cmp', 'right']);
      const left = fieldOf(source, node.left);
      const right = fieldOf(source, node.right);
      const cmp = comparatorOf(node.cmp);
      if (left.type !== right.type || left.name === right.name || (left.type !== 'numeric' && ORDERED.has(cmp))) throw notAllowed();
      state.fields.add(left.name).add(right.name);
      return { op, left: left.name, cmp, right: right.name };
    }
    case 'between': {
      onlyKeys(node, ['field', 'min', 'max']);
      const field = fieldOf(source, node.field);
      if (field.type !== 'numeric') throw notAllowed();
      state.fields.add(field.name);
      return { op, field: field.name, min: literalOf('numeric', node.min), max: literalOf('numeric', node.max) };
    }
    case 'in': {
      onlyKeys(node, ['field', 'values']);
      const field = fieldOf(source, node.field);
      if (!Array.isArray(node.values) || node.values.length === 0 || node.values.length > MAX_IN_VALUES) throw notAllowed();
      state.fields.add(field.name);
      return { op, field: field.name, values: [...new Set(node.values.map((value) => literalOf(field.type, value)))] };
    }
    case 'unique': {
      onlyKeys(node, ['fields']);
      if (!Array.isArray(node.fields) || node.fields.length === 0 || node.fields.length > MAX_UNIQUE_FIELDS) throw notAllowed();
      const names = [...new Set(node.fields.map((value) => fieldOf(source, value).name))];
      for (const name of names) state.fields.add(name);
      return { op, fields: names };
    }
    case 'reference_exists': {
      onlyKeys(node, ['field']);
      const field = fieldOf(source, node.field);
      if (!source.references.has(field.name)) throw notAllowed();
      state.fields.add(field.name);
      return { op, field: field.name };
    }
    case 'snapshot_age_within': {
      onlyKeys(node, ['seconds']);
      const seconds = node.seconds;
      if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_AGE_SECONDS) throw notAllowed();
      return { op, seconds };
    }
    default:
      throw notAllowed();
  }
}

export interface ValidatedExpression {
  ast: QualityExpr;
  /** The fields the expression reads, in the order they are first used. */
  fields: string[];
}

/**
 * The expression of a rule as it is stored: only the operators that the dimension allows, only the fields the source has, literals of the
 * field's type, within the size limits. Anything else - raw SQL, a function, an unknown key, an operator of another dimension - is 422
 * EXPRESSION_NOT_ALLOWED; the answer names the expression, never what it contained.
 */
export function validateQualityExpression(dimension: QualityDimension, raw: unknown, source: QualitySourceShape): ValidatedExpression {
  const state: Walk = { dimension, source, fields: new Set(), nodes: 0 };
  const ast = walk(raw, state, 1);
  const whole = WHOLE[dimension];
  if (whole !== undefined && ast.op !== whole) throw notAllowed();
  if (dimension === 'CONSISTENCY' && !containsOp(ast, 'compare_fields')) throw notAllowed();
  return { ast, fields: [...state.fields] };
}

function containsOp(node: QualityExpr, op: QualityExpr['op']): boolean {
  if (node.op === op) return true;
  if (node.op === 'and' || node.op === 'or') return node.args.some((arg) => containsOp(arg, op));
  return node.op === 'not' ? containsOp(node.arg, op) : false;
}

// ---- thresholds and the arithmetic of a run -------------------------------------------------------------------------

/** A rate is counted in millionths of a percent: 99.5 percent is 99_500_000. Whole numbers, so nothing is rounded by a floating point. */
export const RATE_SCALE = 1_000_000;
export const FULL_RATE = 100 * RATE_SCALE;
const RATE_TEXT = /^(\d{1,3})(?:\.(\d{1,6}))?$/;

const thresholdInvalid = (): DomainError => new DomainError('THRESHOLD_INVALID', 422, 'threshold_json');

function rateOf(value: unknown): number {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') throw thresholdInvalid();
  const match = RATE_TEXT.exec(text);
  if (match === null) throw thresholdInvalid();
  const micro = Number(match[1]) * RATE_SCALE + Number((match[2] ?? '').padEnd(6, '0'));
  if (micro > FULL_RATE) throw thresholdInvalid();
  return micro;
}

export const formatRate = (micro: number): string => `${Math.floor(micro / RATE_SCALE)}.${String(micro % RATE_SCALE).padStart(6, '0')}`;

export interface QualityThreshold {
  /** As stored: decimal strings of percent. */
  json: { min_pass_rate_pct: string; warn_pass_rate_pct?: string };
  minMicro: number;
  warnMicro: number | undefined;
}

/**
 * The pass rate a rule must reach (`min_pass_rate_pct`, more than 0 and at most 100) and, optionally, the lower rate from which a miss is
 * only a warning (`warn_pass_rate_pct`, below the minimum). An integrity rule has no room for a miss: its minimum is 100.
 */
export function parseQualityThreshold(raw: unknown, dimension: QualityDimension): QualityThreshold {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw thresholdInvalid();
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) if (key !== 'min_pass_rate_pct' && key !== 'warn_pass_rate_pct') throw thresholdInvalid();
  if (!('min_pass_rate_pct' in object)) throw thresholdInvalid();
  const minMicro = rateOf(object.min_pass_rate_pct);
  if (minMicro === 0) throw thresholdInvalid();
  if (dimension === 'INTEGRITY' && minMicro !== FULL_RATE) throw thresholdInvalid();
  let warnMicro: number | undefined;
  if ('warn_pass_rate_pct' in object) {
    warnMicro = rateOf(object.warn_pass_rate_pct);
    if (warnMicro >= minMicro) throw thresholdInvalid();
  }
  const json: QualityThreshold['json'] = { min_pass_rate_pct: formatRate(minMicro) };
  if (warnMicro !== undefined) json.warn_pass_rate_pct = formatRate(warnMicro);
  return { json, minMicro, warnMicro };
}

/**
 * The share of the evaluated rows that passed, in millionths of a percent, rounded DOWN: a rate is never rounded up to a threshold it did not
 * reach. Nothing evaluated has no rate (undefined), and is never read as a pass.
 */
export function passRateMicro(passed: number, evaluated: number): number | undefined {
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(evaluated) || passed < 0 || evaluated < 0 || passed > evaluated) throw new RangeError('counts');
  if (evaluated === 0) return undefined;
  return Number((BigInt(passed) * BigInt(FULL_RATE)) / BigInt(evaluated));
}

/** PASS at or above the minimum; between the warning rate and the minimum a WARN; below it a FAIL, which an action of WARN softens to a WARN. */
export function ruleVerdict(rateMicro: number, threshold: Pick<QualityThreshold, 'minMicro' | 'warnMicro'>, action: ActionOnFail): Exclude<RuleResult, 'ERROR'> {
  if (rateMicro >= threshold.minMicro) return 'PASS';
  if (threshold.warnMicro !== undefined && rateMicro >= threshold.warnMicro) return 'WARN';
  return action === 'WARN' ? 'WARN' : 'FAIL';
}

/**
 * The weighted mean of pass rates, `sum(w x rate) / sum(w)`, in hundredths of a percent as a decimal string ("95.00"). It is cut, never rounded
 * up, so a score never claims more than was measured. Nothing measured has no score (null), never 0.
 */
export function weightedScore(items: ReadonlyArray<{ weight: number; rateMicro: number }>): string | null {
  if (items.length === 0) return null;
  let weights = 0;
  let weighted = 0n;
  for (const item of items) {
    weights += item.weight;
    weighted += BigInt(item.weight) * BigInt(item.rateMicro);
  }
  const hundredths = Math.floor(Number(weighted / BigInt(weights)) / (RATE_SCALE / 100));
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

export interface RuleOutcome {
  dimension: QualityDimension;
  action: ActionOnFail;
  weight: number;
  result: RuleResult;
  /** The pass rate in millionths of a percent; null when the rule could not be measured (ERROR). */
  rateMicro: number | null;
}

export interface RunVerdict {
  /** Hundredths of a percent, as a decimal string ("95.00"), never rounded up; null when no rule could be measured. */
  score: string | null;
  hardFail: boolean;
  /** The snapshot must not feed certified figures: a hard fail, or a failed rule whose action is HARD_BLOCK. */
  certifiedBlocked: boolean;
  /** Undefined when no rule could be measured: there is nothing to call passed, warned or failed. */
  overall: RunOverall | undefined;
  measured: number;
  failed: number;
}

/**
 * The verdict of a run (BR-DGV-03): `score = 100 x sum(w x rate) / sum(w)` over the rules that were measured; a failed integrity rule, or a
 * failed HARD_BLOCK rule on a critical dataset, is a hard fail and the run FAILED whatever the score; any other failed rule fails the run, a
 * warning or a rule that could not be measured keeps it from reading PASSED. A rule that was not measured is never counted as passed.
 */
export function judgeRun(outcomes: readonly RuleOutcome[], datasetIsCritical: boolean): RunVerdict {
  const measured = outcomes.filter((outcome) => outcome.result !== 'ERROR' && outcome.rateMicro !== null);
  const failedOutcomes = outcomes.filter((outcome) => outcome.result === 'FAIL');
  const hardFail = failedOutcomes.some((outcome) => outcome.dimension === 'INTEGRITY' || (outcome.action === 'HARD_BLOCK' && datasetIsCritical));
  const certifiedBlocked = hardFail || failedOutcomes.some((outcome) => outcome.action === 'HARD_BLOCK');
  if (measured.length === 0) return { score: null, hardFail: false, certifiedBlocked: false, overall: undefined, measured: 0, failed: 0 };
  const score = weightedScore(measured.map((outcome) => ({ weight: outcome.weight, rateMicro: outcome.rateMicro as number })));
  const warned = outcomes.some((outcome) => outcome.result === 'WARN' || outcome.result === 'ERROR');
  let overall: RunOverall = 'PASSED';
  if (hardFail || failedOutcomes.length > 0) overall = 'FAILED';
  else if (warned) overall = 'WARNING';
  return { score, hardFail, certifiedBlocked, overall, measured: measured.length, failed: failedOutcomes.length };
}
