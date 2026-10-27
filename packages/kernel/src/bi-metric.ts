import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';

/**
 * A metric of BI as data (BI 3 F1): the definition is a small document with an allowlisted expression tree, never a piece of SQL. The platform writes its metrics in files of the
 * repository and a sync takes them into the registry; a tenant drafts its own through the screen. Both are judged here by the same rules.
 */
export const METRIC_AGGREGATIONS = ['additive', 'semi_additive', 'ratio', 'distinct'] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];
export const NULL_POLICIES = ['NULL_NOT_ZERO', 'ZERO_IF_NO_ROWS'] as const;
export type NullPolicy = (typeof NULL_POLICIES)[number];

/** The prefix a metric a tenant drafts must carry: the code of the platform never starts with it, so the two never meet. */
export const TENANT_METRIC_PREFIX = 't_';
export const METRIC_MAX_BUNDLE = 500;

const AGGREGATE_OPS: readonly string[] = ['sum', 'count', 'count_distinct', 'min', 'max'];
const ARITHMETIC_OPS: readonly string[] = ['add', 'sub', 'mul', 'div'];
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE = /^[a-z][a-z0-9_]{1,79}$/;
const DIMENSION = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DEPTH = 6;
const MAX_NODES = 40;
const MAX_DIMENSIONS = 50;
const MAX_TEXT = 120;

/** A node of the expression tree: a field of the dataset, a number, an aggregate over one node, or arithmetic over two. Anything else is refused. */
export type MetricNode = { op: 'field'; name: string } | { op: 'const'; value: number } | { op: string; args: MetricNode[] };

export type MetricProblemCode = 'METRIC_DEFINITION_INVALID' | 'EXPRESSION_NOT_ALLOWED' | 'RATIO_REQUIRES_NUMERATOR_DENOMINATOR';
export interface MetricProblem {
  code: MetricProblemCode;
  field: string;
}

/** The definition as the registry keeps it. */
export interface MetricDefinition {
  code: string;
  grain: string;
  aggregationType: MetricAggregation;
  expressionAst: MetricNode;
  numeratorAst: MetricNode | null;
  denominatorAst: MetricNode | null;
  unit: string;
  nullPolicy: NullPolicy;
  dimensionCodes: string[];
  glossaryTerm: string | null;
  effectiveFrom: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (code: MetricProblemCode, field: string): MetricProblem => ({ code, field });

function checkNode(value: unknown, field: string, depth: number, budget: { nodes: number }): MetricProblem | undefined {
  budget.nodes += 1;
  if (!isRecord(value) || typeof value.op !== 'string' || depth > MAX_DEPTH || budget.nodes > MAX_NODES) return fail('EXPRESSION_NOT_ALLOWED', field);
  const keys = Object.keys(value);
  if (value.op === 'field') {
    return keys.length === 2 && typeof value.name === 'string' && FIELD_NAME.test(value.name) ? undefined : fail('EXPRESSION_NOT_ALLOWED', field);
  }
  if (value.op === 'const') {
    return keys.length === 2 && typeof value.value === 'number' && Number.isFinite(value.value) ? undefined : fail('EXPRESSION_NOT_ALLOWED', field);
  }
  const arity = AGGREGATE_OPS.includes(value.op) ? 1 : ARITHMETIC_OPS.includes(value.op) ? 2 : 0;
  if (arity === 0 || keys.length !== 2 || !Array.isArray(value.args) || value.args.length !== arity) return fail('EXPRESSION_NOT_ALLOWED', field);
  for (const [index, child] of (value.args as unknown[]).entries()) {
    const problem = checkNode(child, `${field}.args[${index}]`, depth + 1, budget);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Whether a tree is made of the allowed nodes only: no raw SQL, no function call, no field outside the grammar, a bounded depth and size. */
export function expressionProblem(value: unknown, field: string): MetricProblem | undefined {
  return checkNode(value, field, 1, { nodes: 0 });
}

/** A day that exists: `2026-02-30` is not one, though a date parser would move it to March. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const text = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** The fields every metric has, whoever wrote it. */
export interface MetricFields {
  code: unknown;
  grain: unknown;
  aggregationType: unknown;
  expressionAst: unknown;
  numeratorAst: unknown;
  denominatorAst: unknown;
  unit: unknown;
  nullPolicy: unknown;
  dimensionCodes: unknown;
  glossaryTerm: unknown;
  effectiveFrom: unknown;
}

/** The first problem of a metric, or the definition when there is none. A ratio is made of a numerator and a denominator, and a metric of any other kind is not. */
export function validateMetric(fields: MetricFields): { ok: true; value: MetricDefinition } | { ok: false; problem: MetricProblem } {
  if (typeof fields.code !== 'string' || !CODE.test(fields.code)) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'code') };
  if (!text(fields.grain)) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'grain') };
  const aggregation = (METRIC_AGGREGATIONS as readonly unknown[]).includes(fields.aggregationType) ? (fields.aggregationType as MetricAggregation) : undefined;
  if (aggregation === undefined) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'aggregation_type') };
  if (!text(fields.unit, 40)) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'unit') };
  const nullPolicy = (NULL_POLICIES as readonly unknown[]).includes(fields.nullPolicy) ? (fields.nullPolicy as NullPolicy) : undefined;
  if (nullPolicy === undefined) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'null_policy') };
  if (typeof fields.effectiveFrom !== 'string' || !isCalendarDate(fields.effectiveFrom)) {
    return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'effective_from') };
  }
  const dimensions = fields.dimensionCodes;
  if (!Array.isArray(dimensions) || dimensions.length > MAX_DIMENSIONS || dimensions.some((item) => typeof item !== 'string' || !DIMENSION.test(item)) || new Set(dimensions).size !== dimensions.length) {
    return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'dimensions') };
  }
  if (fields.glossaryTerm !== undefined && fields.glossaryTerm !== null && !text(fields.glossaryTerm, 80)) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'glossary_term') };
  const ratio = aggregation === 'ratio';
  const hasNumerator = fields.numeratorAst !== undefined && fields.numeratorAst !== null;
  const hasDenominator = fields.denominatorAst !== undefined && fields.denominatorAst !== null;
  if (ratio && (!hasNumerator || !hasDenominator)) return { ok: false, problem: fail('RATIO_REQUIRES_NUMERATOR_DENOMINATOR', hasNumerator ? 'denominator' : 'numerator') };
  if (!ratio && (hasNumerator || hasDenominator)) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', hasNumerator ? 'numerator' : 'denominator') };
  const expression = ratio && (fields.expressionAst === undefined || fields.expressionAst === null) ? { op: 'div', args: [fields.numeratorAst, fields.denominatorAst] } : fields.expressionAst;
  for (const [name, tree] of [
    ['expression', expression],
    ...(ratio ? ([['numerator', fields.numeratorAst], ['denominator', fields.denominatorAst]] as const) : []),
  ] as Array<[string, unknown]>) {
    const problem = expressionProblem(tree, name);
    if (problem !== undefined) return { ok: false, problem };
  }
  // A ratio is its numerator over its denominator: an expression that says otherwise would leave the registry with two definitions of one metric.
  if (ratio && canonicalJson(expression) !== canonicalJson({ op: 'div', args: [fields.numeratorAst, fields.denominatorAst] })) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'expression') };
  return {
    ok: true,
    value: {
      code: fields.code,
      grain: (fields.grain as string).trim(),
      aggregationType: aggregation,
      expressionAst: expression as MetricNode,
      numeratorAst: ratio ? (fields.numeratorAst as MetricNode) : null,
      denominatorAst: ratio ? (fields.denominatorAst as MetricNode) : null,
      unit: (fields.unit as string).trim(),
      nullPolicy,
      dimensionCodes: [...(dimensions as string[])].sort(),
      glossaryTerm: typeof fields.glossaryTerm === 'string' ? fields.glossaryTerm.trim() : null,
      effectiveFrom: fields.effectiveFrom,
    },
  };
}

/** A metric of the files of the repository, as the sync reads it (the YAML of the platform turned into data: expression, numerator, denominator, dimensions, glossary_term). */
export function metricOfDocument(raw: unknown): { ok: true; value: MetricDefinition } | { ok: false; problem: MetricProblem } {
  if (!isRecord(raw)) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'metric') };
  const known = new Set(['code', 'grain', 'aggregation_type', 'expression', 'numerator', 'denominator', 'dimensions', 'unit', 'null_policy', 'glossary_term', 'effective_from']);
  const extra = Object.keys(raw).find((key) => !known.has(key));
  if (extra !== undefined) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', extra) };
  // The prefix of the tenant's metrics is the tenant's: a code of the platform that started with it could meet a draft of a tenant.
  if (typeof raw.code === 'string' && raw.code.startsWith(TENANT_METRIC_PREFIX)) return { ok: false, problem: fail('METRIC_DEFINITION_INVALID', 'code') };
  return validateMetric({
    code: raw.code,
    grain: raw.grain,
    aggregationType: raw.aggregation_type,
    expressionAst: raw.expression,
    numeratorAst: raw.numerator,
    denominatorAst: raw.denominator,
    unit: raw.unit,
    nullPolicy: raw.null_policy ?? 'NULL_NOT_ZERO',
    dimensionCodes: raw.dimensions ?? [],
    glossaryTerm: raw.glossary_term,
    effectiveFrom: raw.effective_from,
  });
}

/** The hash of a definition: of its canonical form, so the order of the keys of a file never changes it. */
export const metricSha256 = (definition: MetricDefinition): string => sha256Hex(canonicalJson(definition));

/** A bundle the pipeline built from the files: a version, and the metrics. The hash the caller names is the hash of the bytes. */
export function parseMetricBundle(bytes: Uint8Array, sha256: string): MetricDefinition[] {
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new DomainError('BUNDLE_HASH_MISMATCH', 422);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError('METRIC_DEFINITION_INVALID', 422, 'bundle');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.metrics) || parsed.metrics.length > METRIC_MAX_BUNDLE) throw new DomainError('METRIC_DEFINITION_INVALID', 422, 'bundle');
  const seen = new Set<string>();
  return parsed.metrics.map((raw: unknown, index: number) => {
    const result = metricOfDocument(raw);
    if (!result.ok) throw new DomainError('METRIC_DEFINITION_INVALID', 422, `metrics[${index}].${result.problem.field}`);
    if (seen.has(result.value.code)) throw new DomainError('METRIC_DEFINITION_INVALID', 422, `metrics[${index}].code`);
    seen.add(result.value.code);
    return result.value;
  });
}

/** What the registry holds of a metric of the platform, the latest revision of each code. */
export interface RegisteredMetric {
  id: string;
  code: string;
  revision: number;
  status: string;
  definitionSha256: string;
  definition: MetricDefinition;
}

export interface MetricSyncPlan {
  added: MetricDefinition[];
  revised: Array<{ definition: MetricDefinition; revision: number; supersedes: string }>;
  unchanged: string[];
  retired: string[];
}

/** The fields whose change changes what a number means: with the same code they need a later day to take effect, or a new code. */
function meaningOf(definition: MetricDefinition): string {
  return canonicalJson({
    grain: definition.grain,
    aggregation_type: definition.aggregationType,
    unit: definition.unit,
    expression: definition.expressionAst,
    numerator: definition.numeratorAst,
    denominator: definition.denominatorAst,
  });
}

/**
 * What a sync does to the registry (BI 3 F1): a code that is new is added; a code whose definition is the same is left alone; a code whose definition changed is a new revision, but when
 * what changed is what the number means (the grain, the unit, the kind, the expression, the numerator or the denominator) the revision must take effect on a later day than the one
 * in force: otherwise the sync is refused whole, naming the code, and nothing is changed. A code that is in force and no longer in the bundle is retired.
 */
export function planMetricSync(registered: readonly RegisteredMetric[], bundle: readonly MetricDefinition[]): MetricSyncPlan {
  const plan: MetricSyncPlan = { added: [], revised: [], unchanged: [], retired: [] };
  const byCode = new Map(registered.map((metric) => [metric.code, metric]));
  for (const definition of bundle) {
    const current = byCode.get(definition.code);
    if (current === undefined) {
      plan.added.push(definition);
    } else if (current.status !== 'RETIRED' && metricSha256(definition) === current.definitionSha256) {
      plan.unchanged.push(definition.code);
    } else {
      if (meaningOf(definition) !== meaningOf(current.definition) && definition.effectiveFrom <= current.definition.effectiveFrom) {
        throw new DomainError('BREAKING_CHANGE_WITHOUT_NEW_CODE', 422, definition.code);
      }
      plan.revised.push({ definition, revision: current.revision + 1, supersedes: current.id });
    }
  }
  const inBundle = new Set(bundle.map((definition) => definition.code));
  plan.retired = registered.filter((metric) => metric.status !== 'RETIRED' && !inBundle.has(metric.code)).map((metric) => metric.code);
  return plan;
}

// ---- the value of a metric --------------------------------------------------------------------------------------------------------------------

export type NullReason = 'NO_DATA' | 'NOT_APPLICABLE';
export interface RatioFigure {
  /** Exact, two decimals, in percent; null with its reason when there is nothing to divide. */
  percent: string | null;
  numerator: string;
  denominator: string;
  nullReason: NullReason | null;
}

const WHOLE = /^-?(0|[1-9]\d*)$/;

function sumOf(values: readonly string[], field: string): bigint {
  return values.reduce((total, value) => {
    if (!WHOLE.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
    return total + BigInt(value);
  }, 0n);
}

/** Two decimals, half up, of a ratio of two whole numbers, in percent: no float is involved. */
function percentText(numerator: bigint, denominator: bigint): string {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const scaled = (n * 20000n + d) / (2n * d); // round half up of n * 10000 / d
  const text = scaled.toString().padStart(3, '0');
  return `${negative && scaled !== 0n ? '-' : ''}${text.slice(0, -2)}.${text.slice(-2)}`;
}

/**
 * A ratio of a group is the sum of the numerators over the sum of the denominators, never the mean of the ratios of its parts (BI 3 F3). No row is `NO_DATA` and a denominator that adds
 * up to zero is `NOT_APPLICABLE`: the value is null with its reason, and zero only when the metric says that no rows means zero.
 */
export function ratioOfSums(rows: ReadonlyArray<{ numerator: string; denominator: string }>, nullPolicy: NullPolicy): RatioFigure {
  if (rows.length === 0) return { percent: nullPolicy === 'ZERO_IF_NO_ROWS' ? '0.00' : null, numerator: '0', denominator: '0', nullReason: nullPolicy === 'ZERO_IF_NO_ROWS' ? null : 'NO_DATA' };
  const numerator = sumOf(rows.map((row) => row.numerator), 'numerator');
  const denominator = sumOf(rows.map((row) => row.denominator), 'denominator');
  if (denominator === 0n) return { percent: null, numerator: numerator.toString(), denominator: '0', nullReason: 'NOT_APPLICABLE' };
  return { percent: percentText(numerator, denominator), numerator: numerator.toString(), denominator: denominator.toString(), nullReason: null };
}

export interface PeriodPoint {
  snapshotId: string;
  period: string;
  value: string;
}

/**
 * The value of a semi-additive metric (a balance, a stock) at the end of a period: the value of the latest period up to the one asked, never the sum over the periods. The points must
 * come from one snapshot, so a figure and the rows under it are never of two.
 */
export function periodEndValue(points: readonly PeriodPoint[], asOfPeriod: string): { value: string | null; period: string | null; nullReason: NullReason | null } {
  if (new Set(points.map((point) => point.snapshotId)).size > 1) throw new DomainError('VALIDATION_FAILED', 422, 'snapshot_id');
  const upTo = points.filter((point) => point.period <= asOfPeriod).sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  const last = upTo[0];
  if (last === undefined) return { value: null, period: null, nullReason: 'NO_DATA' };
  return { value: sumOf([last.value], 'value').toString(), period: last.period, nullReason: null };
}
