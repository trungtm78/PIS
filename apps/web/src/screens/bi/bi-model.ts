import { ApiError } from '@machvon/api-client';

export const MANAGE_PERMISSION = 'bi.metric.manage';
export const CATALOGUE_PATH = '/bi/bi-05';
export const DEFINITION_PATH = '/bi/bi-06';
export const REGISTRATION_PATH = '/bi/bi-15';

export const AGGREGATIONS = ['additive', 'semi_additive', 'ratio', 'distinct'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];
export const STATUSES = ['DRAFT', 'IN_REVIEW', 'CERTIFIED', 'SUPERSEDED', 'RETIRED'] as const;
export type MetricStatus = (typeof STATUSES)[number];
export const ORIGINS = ['PLATFORM_CODE', 'TENANT_UI'] as const;
export type MetricOrigin = (typeof ORIGINS)[number];
export const NULL_POLICIES = ['NULL_NOT_ZERO', 'ZERO_IF_NO_ROWS'] as const;
export type NullPolicy = (typeof NULL_POLICIES)[number];
/** The aggregates the editor offers over one field of the dataset; the server allows these and arithmetic, and nothing else. */
export const AGGREGATES = ['sum', 'count', 'count_distinct', 'min', 'max'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

const TENANT_CODE = /^t_[a-z0-9_]{1,77}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DIMENSION = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A node of an expression as the server keeps it; the screen reads it only to write it as a formula. */
export type Node = Raw;

export interface Metric {
  id: string;
  code: string;
  revision: number;
  grain: string;
  aggregationType: Aggregation;
  expression: Node;
  numerator: Node | null;
  denominator: Node | null;
  unit: string;
  ownerId: string;
  status: MetricStatus;
  origin: MetricOrigin;
  sourceCommit: string | null;
  definitionSha256: string | null;
  nullPolicy: NullPolicy;
  dimensionCodes: string[];
  datasetId: string | null;
  glossaryTermId: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  certifiedBy: string | null;
  createdAt: string;
  createdBy: string | null;
}

const includes = <T extends string>(list: readonly T[], value: string | undefined): value is T => value !== undefined && (list as readonly string[]).includes(value);

/** A revision as the screens read it; an entry that lacks what the screens need is left out, never guessed. */
export function toMetric(raw: unknown): Metric | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const code = text(row.code);
  const aggregation = text(row.aggregation_type);
  const status = text(row.status);
  const origin = text(row.origin);
  const nullPolicy = text(row.null_policy);
  const expression = asRecord(row.expression_ast);
  const revision = typeof row.revision === 'number' && Number.isInteger(row.revision) ? row.revision : undefined;
  if (id === undefined || code === undefined || revision === undefined || expression === undefined || !includes(AGGREGATIONS, aggregation) || !includes(STATUSES, status) || !includes(ORIGINS, origin) || !includes(NULL_POLICIES, nullPolicy)) {
    return undefined;
  }
  return {
    id,
    code,
    revision,
    grain: text(row.grain) ?? '',
    aggregationType: aggregation,
    expression,
    numerator: asRecord(row.numerator_ast) ?? null,
    denominator: asRecord(row.denominator_ast) ?? null,
    unit: text(row.unit) ?? '',
    ownerId: text(row.owner_id) ?? '',
    status,
    origin,
    sourceCommit: nullableText(row.source_commit),
    definitionSha256: nullableText(row.definition_sha256),
    nullPolicy,
    dimensionCodes: Array.isArray(row.dimension_codes) ? row.dimension_codes.filter((item): item is string => typeof item === 'string') : [],
    datasetId: nullableText(row.dataset_id),
    glossaryTermId: nullableText(row.glossary_term_id),
    effectiveFrom: nullableText(row.effective_from),
    effectiveUntil: nullableText(row.effective_until),
    certifiedBy: nullableText(row.certified_by),
    createdAt: text(row.created_at) ?? '',
    createdBy: nullableText(row.created_by),
  };
}

// The multiplication sign (U+00D7) stands for `mul`.
const OPERATORS: Readonly<Record<string, string>> = { add: '+', sub: '-', mul: '\u00d7', div: '/' };

/** A tree written as a formula a person reads: `SUM(GIAI_NGAN) / SUM(KE_HOACH_TTG)`. Anything the grammar does not have is shown as a question mark, not guessed. */
export function formulaText(node: Node | null): string {
  if (node === null) return '';
  const op = text(node.op);
  if (op === 'field') return text(node.name) ?? '?';
  if (op === 'const') return typeof node.value === 'number' ? String(node.value) : '?';
  const args = Array.isArray(node.args) ? node.args.map((child) => asRecord(child) ?? null) : [];
  if (op !== undefined && OPERATORS[op] !== undefined && args.length === 2) return `(${formulaText(args[0] ?? null)} ${OPERATORS[op]} ${formulaText(args[1] ?? null)})`;
  if (op !== undefined && includes(AGGREGATES, op) && args.length === 1) return `${op.toUpperCase()}(${formulaText(args[0] ?? null)})`;
  return '?';
}

/** The formula of a revision: a ratio is its numerator over its denominator; any other kind is its expression. */
export const metricFormula = (metric: Metric): string => (metric.aggregationType === 'ratio' ? `${formulaText(metric.numerator)} / ${formulaText(metric.denominator)}` : formulaText(metric.expression));

// ---- BI-15: what the files of the repository brought --------------------------------------------------------------------------------------

export interface Registration {
  sourceCommit: string;
  added: number;
  revised: number;
  retired: number;
  inForce: number;
  lastAt: string;
}

/** The commits that brought metrics of the platform, the newest first, with what each one added, revised and what of it is now retired or in force. */
export function registrationsOf(metrics: readonly Metric[]): Registration[] {
  const byCommit = new Map<string, Registration>();
  for (const metric of metrics) {
    if (metric.origin !== 'PLATFORM_CODE' || metric.sourceCommit === null) continue;
    const entry = byCommit.get(metric.sourceCommit) ?? { sourceCommit: metric.sourceCommit, added: 0, revised: 0, retired: 0, inForce: 0, lastAt: '' };
    if (metric.revision === 1) entry.added += 1;
    else entry.revised += 1;
    if (metric.status === 'RETIRED') entry.retired += 1;
    if (metric.status === 'CERTIFIED') entry.inForce += 1;
    if (metric.createdAt > entry.lastAt) entry.lastAt = metric.createdAt;
    byCommit.set(metric.sourceCommit, entry);
  }
  return [...byCommit.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.sourceCommit.localeCompare(b.sourceCommit)));
}

// ---- BI-06: drafting a metric of the tenant -------------------------------------------------------------------------------------------------

export interface Operand {
  aggregate: Aggregate;
  field: string;
}

export interface MetricValues {
  code: string;
  grain: string;
  aggregationType: Aggregation;
  expression: Operand;
  numerator: Operand;
  denominator: Operand;
  unit: string;
  nullPolicy: NullPolicy;
  /** Codes separated by commas. */
  dimensions: string;
  datasetId: string;
  effectiveFrom: string;
}

const EMPTY_OPERAND: Operand = { aggregate: 'sum', field: '' };
export const EMPTY_VALUES: MetricValues = {
  code: 't_',
  grain: '',
  aggregationType: 'additive',
  expression: EMPTY_OPERAND,
  numerator: EMPTY_OPERAND,
  denominator: EMPTY_OPERAND,
  unit: '',
  nullPolicy: 'NULL_NOT_ZERO',
  dimensions: '',
  datasetId: '',
  effectiveFrom: '',
};

export type FieldProblem = 'required' | 'invalidCode' | 'invalidField' | 'invalidDimension' | 'invalidId' | 'invalidDate';
export type MetricErrors = Partial<Record<'code' | 'grain' | 'expression' | 'numerator' | 'denominator' | 'unit' | 'dimensions' | 'datasetId' | 'effectiveFrom', FieldProblem>>;

const dimensionsOf = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

/** A tree in the type the generated contract gives it: `object` in openapi.json is rendered as a record of `never`, so the tree is the one field that needs the cast. */
const asContract = (node: Node): Record<string, never> => node as Record<string, never>;
const nodeOf = (operand: Operand): Record<string, never> => asContract({ op: operand.aggregate, args: [{ op: 'field', name: operand.field.trim() }] });

/** What is wrong with the values, field by field; the server judges again and a refusal of it is shown too. */
export function validateMetric(values: MetricValues): MetricErrors {
  const errors: MetricErrors = {};
  if (!TENANT_CODE.test(values.code.trim())) errors.code = 'invalidCode';
  if (values.grain.trim() === '') errors.grain = 'required';
  if (values.unit.trim() === '') errors.unit = 'required';
  const operands: Array<['expression' | 'numerator' | 'denominator', Operand]> = values.aggregationType === 'ratio' ? [['numerator', values.numerator], ['denominator', values.denominator]] : [['expression', values.expression]];
  for (const [name, operand] of operands) {
    if (operand.field.trim() === '') errors[name] = 'required';
    else if (!FIELD_NAME.test(operand.field.trim())) errors[name] = 'invalidField';
  }
  if (!dimensionsOf(values.dimensions).every((item) => DIMENSION.test(item))) errors.dimensions = 'invalidDimension';
  if (!UUID.test(values.datasetId.trim())) errors.datasetId = values.datasetId.trim() === '' ? 'required' : 'invalidId';
  if (!DATE.test(values.effectiveFrom)) errors.effectiveFrom = values.effectiveFrom === '' ? 'required' : 'invalidDate';
  return errors;
}

/** The body of createTenantMetricDefinition: the editor builds the tree from an aggregate and a field, so a node outside the grammar cannot be written on the screen at all. */
export function metricBody(values: MetricValues) {
  const ratio = values.aggregationType === 'ratio';
  const numerator = nodeOf(values.numerator);
  const denominator = nodeOf(values.denominator);
  return {
    code: values.code.trim(),
    grain: values.grain.trim(),
    aggregation_type: values.aggregationType,
    expression_ast: ratio ? asContract({ op: 'div', args: [numerator, denominator] }) : nodeOf(values.expression),
    ...(ratio ? { numerator_ast: numerator, denominator_ast: denominator } : {}),
    unit: values.unit.trim(),
    null_policy: values.nullPolicy,
    dimension_codes: dimensionsOf(values.dimensions),
    dataset_id: values.datasetId.trim().toLowerCase(),
    effective_from: values.effectiveFrom,
  };
}

export type ProblemReason = 'ratio' | 'expression' | 'platformReadOnly' | 'dimension' | 'invalid' | 'denied' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  RATIO_REQUIRES_NUMERATOR_DENOMINATOR: 'ratio',
  EXPRESSION_NOT_ALLOWED: 'expression',
  PLATFORM_METRIC_READ_ONLY: 'platformReadOnly',
  DIMENSION_NOT_IN_DATASET: 'dimension',
  METRIC_DEFINITION_INVALID: 'invalid',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

/** Maps a refusal of the server to what the screen says; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
