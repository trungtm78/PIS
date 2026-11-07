import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';
import type { MetricDefinition, MetricNode, NullPolicy, NullReason } from './bi-metric.ts';
import { ratioOfSums } from './bi-metric.ts';

/**
 * The query of BI (ST-BI-004, BI 3 F3, F4): a metric over one frozen snapshot, cut by a dimension of its dataset, the figures from sums. The server writes the query from allowlists (the fields a metric may read,
 * the dimensions a dataset offers); nothing a caller sends is a piece of SQL. A figure that cannot be given is null with its reason, never 0.
 */

/** The fields a metric of the disbursement dataset may read, and the column of a snapshot line each one is. */
export const DISBURSEMENT_FIELDS: Readonly<Record<string, string>> = {
  GIAI_NGAN: 'disbursed_treasury_vnd',
  GIAI_NGAN_BAO_CAO: 'disbursed_reported_vnd',
  KE_HOACH_TTG: 'plan_pm_assigned_vnd',
  KE_HOACH_DIA_PHUONG: 'plan_local_added_vnd',
  KE_HOACH_TONG: 'plan_total_vnd',
  CTMTQG: 'ctmtqg_subset_vnd',
  DU_AN: 'project_id',
  DON_VI: 'unit_id',
};

/** The dimensions of the disbursement dataset, and the column of a snapshot line each one cuts by. */
export const DISBURSEMENT_DIMENSIONS: Readonly<Record<string, DatasetDimension>> = {
  unit: { column: 'unit_id', kind: 'uuid' },
  project: { column: 'project_id', kind: 'uuid' },
  fund_source: { column: 'fund_source_version_id', kind: 'uuid' },
  budget_level: { column: 'budget_level', kind: 'text' },
  bucket: { column: 'bucket', kind: 'text' },
};

// ---- the datasets a query can read: one adapter each ---------------------------------------------------------------------------------------------------------

/** What a dataset is read from. Each kind has one reader in the database package (`QuerySource`); a kind with no reader there is not queryable yet (`DATASET_SOURCE_UNAVAILABLE`). */
export const DATASET_SOURCE_KINDS = ['PERIOD_SNAPSHOT', 'CONTRACT_FACT'] as const;
export type DatasetSourceKind = (typeof DATASET_SOURCE_KINDS)[number];

export interface DatasetDimension {
  column: string;
  kind: 'uuid' | 'text';
}

/**
 * A dataset as the query engine sees it (CA-1): the allowlists of what a metric may read and what it may be cut by, and nothing else. The planner, the query engine, the stores and the checks of publication take their
 * allowlists from the adapter of the dataset the snapshot belongs to, never from a constant; registering a dataset is registering its adapter here and its reader of the source in the database package.
 */
export interface DatasetAdapter {
  /** The `dataset_code` of the catalogue of BI. */
  code: string;
  sourceKind: DatasetSourceKind;
  /** What one line of the source is (`project` for a disbursement line, `contract_party` for a line of the contract fact). */
  grain: string;
  /** The fields a metric may read, and the column of a line of the source each one is. */
  fields: Readonly<Record<string, string>>;
  /** The dimensions a metric may be cut by, and the column of a line each one cuts by. */
  dimensions: Readonly<Record<string, DatasetDimension>>;
  /** The fields that are identifiers: they are counted apart, never added. */
  identifierFields: readonly string[];
  /** What the planner may do over the dataset beyond one group-by: two stages (shares, squared shares, top N) and a series of periods. */
  capabilities: { twoStage: boolean; periodSeries: boolean };
}

/** The dataset of the disbursement figures: the lines of a frozen close snapshot of DIS. */
export const DISBURSEMENT_ADAPTER: DatasetAdapter = Object.freeze({
  code: 'DS-DISB',
  sourceKind: 'PERIOD_SNAPSHOT',
  grain: 'project',
  fields: DISBURSEMENT_FIELDS,
  dimensions: DISBURSEMENT_DIMENSIONS,
  identifierFields: ['DU_AN', 'DON_VI'],
  capabilities: { twoStage: true, periodSeries: true },
});

/**
 * The dataset of the contract portfolio: one line per contract per active party, read from the certified view `contract_fact` of a frozen `contract_fact_snapshot` (R17), made by part 2 of CA-1. The money of a line
 * is already attributed to its party by `contract_party.share_pct` (whole dong, by the largest remainder, as `spreadByWeight` of `ctr-analytics.ts` does), so every sum over the dataset is whole dong and the groups
 * of any dimension add up to the total, a joint venture counted once. The flag fields (`SINGLE_BIDDER`, `BIDDER_KNOWN`) are 1 or 0 on the line of the lead party only, for the same reason. Until the source is
 * registered in the database package a query over it is refused with `DATASET_SOURCE_UNAVAILABLE`.
 */
export const CONTRACT_ADAPTER: DatasetAdapter = Object.freeze({
  code: 'DS-CTR',
  sourceKind: 'CONTRACT_FACT',
  grain: 'contract_party',
  fields: {
    CONTRACT_VALUE: 'contract_value_vnd',
    ACTIVE_VALUE: 'active_value_vnd',
    ORIGINAL_VALUE: 'original_value_vnd',
    APPROVED_CHANGE_DELTA: 'approved_change_delta_vnd',
    WINNING_BID: 'winning_bid_vnd',
    BID_VARIANCE: 'bid_variance_vnd',
    REQUESTED: 'requested_vnd',
    ACCEPTED: 'accepted_vnd',
    PAID: 'paid_vnd',
    ADVANCE_PAID: 'advance_paid_vnd',
    ADVANCE_RECOVERED: 'advance_recovered_vnd',
    ADVANCE_OUTSTANDING: 'advance_outstanding_vnd',
    RETENTION_WITHHELD: 'retention_withheld_vnd',
    RETENTION_RELEASED: 'retention_released_vnd',
    RETENTION_HELD: 'retention_held_vnd',
    GUARANTEE_REQUIRED: 'guarantee_required_vnd',
    GUARANTEE_VALID: 'guarantee_valid_vnd',
    SINGLE_BIDDER: 'single_bidder_flag',
    BIDDER_KNOWN: 'bidder_known_flag',
    DAYS_LATE: 'days_late',
    CONTRACT: 'contract_id',
    CONTRACTOR: 'contractor_id',
  },
  dimensions: {
    unit: { column: 'unit_id', kind: 'uuid' as const },
    project: { column: 'project_id', kind: 'uuid' as const },
    fund_source: { column: 'fund_source_version_id', kind: 'uuid' as const },
    investor: { column: 'investor_id', kind: 'uuid' as const },
    contractor: { column: 'contractor_id', kind: 'uuid' as const },
    contract_status: { column: 'contract_status', kind: 'text' as const },
    contract_type: { column: 'contract_type', kind: 'text' as const },
  },
  identifierFields: ['CONTRACT', 'CONTRACTOR'],
  capabilities: { twoStage: true, periodSeries: true },
});

const ADAPTERS = new Map<string, DatasetAdapter>();

/** Registers a dataset. A code is registered once (a second registration is a programming error, not a replacement). */
export function registerDatasetAdapter(adapter: DatasetAdapter): void {
  if (ADAPTERS.has(adapter.code)) throw new Error(`dataset adapter ${adapter.code} is already registered`);
  ADAPTERS.set(adapter.code, adapter);
}

registerDatasetAdapter(DISBURSEMENT_ADAPTER);
registerDatasetAdapter(CONTRACT_ADAPTER);

/** The adapter of a dataset by its code; none for a dataset the query engine does not read. */
export const datasetAdapterOf = (code: string): DatasetAdapter | undefined => ADAPTERS.get(code);

/** Every registered adapter, by code. */
export const datasetAdapters = (): DatasetAdapter[] => [...ADAPTERS.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

/** The names of the dimensions of every dataset: the first filter on what a caller sends, before it is known which dataset the snapshot belongs to (the adapter of that dataset has the last word). */
export const knownDimensionNames = (): ReadonlySet<string> => new Set(datasetAdapters().flatMap((adapter) => Object.keys(adapter.dimensions)));

/** The registered datasets that have every field a metric reads: the ones it can be a metric of. */
export function adaptersReadingFields(fields: readonly string[]): DatasetAdapter[] {
  return datasetAdapters().filter((adapter) => fields.every((field) => field in adapter.fields));
}

/** The names of the fields a tree reads. */
export function fieldsOfTree(node: MetricNode | null): string[] {
  if (node === null || typeof node !== 'object') return [];
  const record = node as { op?: unknown; name?: unknown; args?: unknown };
  if (record.op === 'field') return typeof record.name === 'string' ? [record.name] : [];
  return Array.isArray(record.args) ? (record.args as MetricNode[]).flatMap((child) => fieldsOfTree(child)) : [];
}

export type MeasureKind = 'ADDITIVE' | 'RATIO' | 'DISTINCT';

/**
 * The second stage of a two-stage measure: the first stage groups the lines by the dimension of the query and sums the column in each group (`v` of the group); the second stage reads the groups.
 * `SUM` is the sum of the groups (the total), `SUM_OF_SQUARES` the sum of their squares, `TOP_N_SUM` the sum of the N largest, `TOTAL_SQUARED` the square of the total; each is then multiplied by the whole `multiplier`.
 * A ratio of two of them is a share (top N over the total) or an index (HHI = sum of the squares over the square of the total, times 10000, which is the percent of the ratio times 100).
 */
export const STAGE_OPS = ['SUM', 'SUM_OF_SQUARES', 'TOP_N_SUM', 'TOTAL_SQUARED'] as const;
export type StageOp = (typeof STAGE_OPS)[number];
export interface StageTerm {
  op: StageOp;
  /** The N of `TOP_N_SUM`; null for the others. */
  n: number | null;
  /** A positive whole number, as text. */
  multiplier: string;
}
export interface TwoStage {
  numerator: StageTerm;
  denominator: StageTerm;
}
export const MAX_TOP_N = 1000;
const MAX_MULTIPLIER = 1_000_000;

/** What the query adds up for a metric: a column summed (or counted apart), and for a ratio the second column its denominator is. */
export interface MeasurePlan {
  kind: MeasureKind;
  numeratorColumn: string;
  denominatorColumn: string | null;
  /** What a group with no line is: no data, or zero when the metric says so. */
  nullPolicy: NullPolicy;
  /** Present only for a measure of two stages: the groups of the query are the groups of the first stage. */
  twoStage?: TwoStage;
}

const notComputable = (): DomainError => new DomainError('VALIDATION_FAILED', 422, 'metric_version_id');

function columnOf(node: MetricNode | null, aggregate: 'sum' | 'count_distinct', adapter: DatasetAdapter): string {
  const call = node as { op?: unknown; args?: unknown } | null;
  const arg = Array.isArray(call?.args) ? (call.args[0] as { op?: unknown; name?: unknown } | undefined) : undefined;
  if (call?.op !== aggregate || (call.args as unknown[]).length !== 1 || arg?.op !== 'field' || typeof arg.name !== 'string') throw notComputable();
  const column = adapter.fields[arg.name];
  // An identifier is counted, never summed (sum(uuid) is not a thing, and the database would say so as a server error).
  if (column === undefined || (aggregate === 'sum' && adapter.identifierFields.includes(arg.name))) throw notComputable();
  return column;
}

type Call = { op?: unknown; args?: unknown; value?: unknown };
const asCall = (node: unknown): Call | null => (typeof node === 'object' && node !== null ? (node as Call) : null);
const argsOf = (call: Call | null): unknown[] => (Array.isArray(call?.args) ? (call?.args as unknown[]) : []);

/** A whole number between 1 and the bound, written as a `const` node. */
function wholeConst(node: unknown, max: number): number | undefined {
  const call = asCall(node);
  return call?.op === 'const' && typeof call.value === 'number' && Number.isInteger(call.value) && call.value >= 1 && call.value <= max ? call.value : undefined;
}

/** A side of a ratio: one `sum` of a field, or a term of two stages (see `StageOp`), with the column both read. */
function sideOf(node: MetricNode | null, adapter: DatasetAdapter): { column: string; term: StageTerm } {
  const call = asCall(node);
  if (call?.op === 'sum') return { column: columnOf(node, 'sum', adapter), term: { op: 'SUM', n: null, multiplier: '1' } };
  if (call?.op === 'mul') {
    const [left, right] = argsOf(call);
    // A whole number times a term: the number is the multiplier. A sum times the same sum is the square of the total.
    const leftFactor = wholeConst(left, MAX_MULTIPLIER);
    const rightFactor = wholeConst(right, MAX_MULTIPLIER);
    if (leftFactor !== undefined || rightFactor !== undefined) {
      const inner = sideOf((leftFactor === undefined ? left : right) as MetricNode, adapter);
      if (inner.term.multiplier !== '1') throw notComputable();
      return { column: inner.column, term: { ...inner.term, multiplier: String(leftFactor ?? rightFactor) } };
    }
    const first = columnOf(left as MetricNode, 'sum', adapter);
    if (first !== columnOf(right as MetricNode, 'sum', adapter)) throw notComputable();
    return { column: first, term: { op: 'TOTAL_SQUARED', n: null, multiplier: '1' } };
  }
  if (call?.op === 'sum_of_squares') {
    const [inner] = argsOf(call);
    if (argsOf(call).length !== 1) throw notComputable();
    return { column: columnOf(inner as MetricNode, 'sum', adapter), term: { op: 'SUM_OF_SQUARES', n: null, multiplier: '1' } };
  }
  if (call?.op === 'top_n_sum') {
    const [inner, count] = argsOf(call);
    const n = wholeConst(count, MAX_TOP_N);
    if (argsOf(call).length !== 2 || n === undefined) throw notComputable();
    return { column: columnOf(inner as MetricNode, 'sum', adapter), term: { op: 'TOP_N_SUM', n, multiplier: '1' } };
  }
  throw notComputable();
}

/** The pairs of terms that are a measure: a share of the N largest groups, and the sum of the squares over the square of the total (an index). Anything else is not a thing a person can read. */
const STAGE_PAIRS: ReadonlyArray<readonly [StageOp, StageOp]> = [
  ['TOP_N_SUM', 'SUM'],
  ['SUM_OF_SQUARES', 'TOTAL_SQUARED'],
];

/**
 * What a metric needs of the lines of a dataset. A ratio is the sum of one field over the sum of another, an additive metric (and a semi-additive one, within one snapshot) is the sum of a field, a distinct metric
 * counts the distinct values of a field. A ratio of two stages (`top_n_sum`, `sum_of_squares`, the square of a sum) is over one field and groups by the dimension of the query first. A metric that reads a field the
 * dataset does not have, or is built another way, cannot be queried.
 */
export function measurePlanOf(
  metric: Pick<MetricDefinition, 'aggregationType' | 'expressionAst' | 'numeratorAst' | 'denominatorAst'> & { nullPolicy?: NullPolicy },
  adapter: DatasetAdapter = DISBURSEMENT_ADAPTER,
): MeasurePlan {
  const nullPolicy = metric.nullPolicy ?? 'NULL_NOT_ZERO';
  switch (metric.aggregationType) {
    case 'ratio': {
      const numerator = sideOf(metric.numeratorAst, adapter);
      const denominator = sideOf(metric.denominatorAst, adapter);
      const staged = numerator.term.op !== 'SUM' || denominator.term.op !== 'SUM' || numerator.term.multiplier !== '1' || denominator.term.multiplier !== '1';
      if (!staged) return { kind: 'RATIO', numeratorColumn: numerator.column, denominatorColumn: denominator.column, nullPolicy };
      const paired = STAGE_PAIRS.some(([top, bottom]) => top === numerator.term.op && bottom === denominator.term.op);
      if (!adapter.capabilities.twoStage || numerator.column !== denominator.column || !paired) throw notComputable();
      return { kind: 'RATIO', numeratorColumn: numerator.column, denominatorColumn: denominator.column, nullPolicy, twoStage: { numerator: numerator.term, denominator: denominator.term } };
    }
    case 'additive':
    case 'semi_additive':
      return { kind: 'ADDITIVE', numeratorColumn: columnOf(metric.expressionAst, 'sum', adapter), denominatorColumn: null, nullPolicy };
    case 'distinct':
      return { kind: 'DISTINCT', numeratorColumn: columnOf(metric.expressionAst, 'count_distinct', adapter), denominatorColumn: null, nullPolicy };
  }
}

/** The sums of a group as the database gives them: text, or null when no line had a figure. */
export interface GroupSums {
  numerator: string | null;
  denominator: string | null;
  distinct: string | null;
  /** How many lines the group has: none is different from lines that have no figure. */
  lines?: string | null;
}

export interface Figure {
  /** An additive or distinct metric: the whole number; a ratio: the percent with two decimals. Null with its reason when it cannot be given. */
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: NullReason | null;
}

const WHOLE = /^-?(0|[1-9]\d*)$/;

/** The figure of a group. A group with no figure is NO_DATA, a ratio over a denominator of zero NOT_APPLICABLE; neither is zero. */
export function figureOf(plan: MeasurePlan, sums: GroupSums): Figure {
  // A metric that says no lines is zero is zero when there is no line at all; lines with no figure are still no data.
  if (sums.lines === '0' && plan.nullPolicy === 'ZERO_IF_NO_ROWS') {
    return plan.kind === 'RATIO' ? { value: '0.00', numerator: '0', denominator: '0', nullReason: null } : { value: '0', numerator: null, denominator: null, nullReason: null };
  }
  if (plan.kind === 'DISTINCT') return sums.distinct === null ? { value: null, numerator: null, denominator: null, nullReason: 'NO_DATA' } : { value: sums.distinct, numerator: null, denominator: null, nullReason: null };
  if (plan.kind === 'ADDITIVE') return sums.numerator === null ? { value: null, numerator: null, denominator: null, nullReason: 'NO_DATA' } : { value: sums.numerator, numerator: null, denominator: null, nullReason: null };
  if (sums.numerator === null || sums.denominator === null) return { value: null, numerator: sums.numerator, denominator: sums.denominator, nullReason: 'NO_DATA' };
  const ratio = ratioOfSums([{ numerator: sums.numerator, denominator: sums.denominator }], 'NULL_NOT_ZERO');
  return { value: ratio.percent, numerator: ratio.numerator, denominator: ratio.denominator, nullReason: ratio.nullReason };
}

export interface QueryReconciliation {
  reconcilesToParent: boolean;
  nonAdditiveReason: string | null;
}

/**
 * Whether the children add up to the parent. The sums of an additive metric do; a ratio does through its numerators and denominators (the ratio of the parent is made from their sums, never from the ratios of the
 * children); a distinct count does not when one thing is in two groups: each group counts it and the total counts it once.
 */
export function reconcile(plan: MeasurePlan, children: readonly GroupSums[], parent: GroupSums): QueryReconciliation {
  const sum = (values: ReadonlyArray<string | null>): bigint => values.reduce<bigint>((total, value) => (value !== null && WHOLE.test(value) ? total + BigInt(value) : total), 0n);
  // A measure of two stages (a share of the largest, an index) is not the sum of its groups: it is recomputed from the values of the groups (their numerators are the sums of the first stage) and must be the parent.
  if (plan.twoStage !== undefined) {
    const again = stageTwoSums(
      plan,
      children.map((child) => child.numerator),
    );
    const same = again.numerator === parent.numerator && again.denominator === parent.denominator;
    return same ? { reconcilesToParent: true, nonAdditiveReason: null } : { reconcilesToParent: false, nonAdditiveReason: 'TWO_STAGE_NOT_RECOMPUTED' };
  }
  if (plan.kind === 'DISTINCT') {
    const same = sum(children.map((child) => child.distinct)) === sum([parent.distinct]);
    return same ? { reconcilesToParent: true, nonAdditiveReason: null } : { reconcilesToParent: false, nonAdditiveReason: 'DISTINCT_NOT_ADDITIVE' };
  }
  const numerators = sum(children.map((child) => child.numerator)) === sum([parent.numerator]);
  const denominators = plan.kind === 'RATIO' ? sum(children.map((child) => child.denominator)) === sum([parent.denominator]) : true;
  return numerators && denominators ? { reconcilesToParent: true, nonAdditiveReason: null } : { reconcilesToParent: false, nonAdditiveReason: 'CHILDREN_DO_NOT_ADD_UP' };
}

/**
 * The second stage of a plan over the values of the groups of the first (the reference the database must agree with, and the check of a query: "recomputed from the raw rows"). A group with no figure (null) is not a
 * group of the second stage. Returns the numerator and the denominator as whole numbers in text, or nulls when no group had a figure.
 */
export function stageTwoSums(plan: MeasurePlan, groups: ReadonlyArray<string | null>): { numerator: string | null; denominator: string | null } {
  const stage = plan.twoStage;
  if (stage === undefined) throw notComputable();
  const values = groups
    .filter((value): value is string => value !== null)
    .map((value) => {
      if (!WHOLE.test(value)) throw notComputable();
      return BigInt(value);
    });
  if (values.length === 0) return { numerator: null, denominator: null };
  const total = values.reduce((acc, value) => acc + value, 0n);
  const term = (spec: StageTerm): bigint => {
    switch (spec.op) {
      case 'SUM':
        return total * BigInt(spec.multiplier);
      case 'SUM_OF_SQUARES':
        return values.reduce((acc, value) => acc + value * value, 0n) * BigInt(spec.multiplier);
      case 'TOTAL_SQUARED':
        return total * total * BigInt(spec.multiplier);
      case 'TOP_N_SUM':
        return [...values].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1)).slice(0, spec.n ?? 0).reduce((acc, value) => acc + value, 0n) * BigInt(spec.multiplier);
    }
  };
  return { numerator: term(stage.numerator).toString(), denominator: term(stage.denominator).toString() };
}

// ---- a series over periods -----------------------------------------------------------------------------------------------------------------------------------

export const MAX_SERIES_PERIODS = 36;
const PERIOD_CODE = /^[0-9A-Za-z][0-9A-Za-z._-]{1,19}$/;

/** The periods of a series, as a caller names them: distinct, in the order of their codes (the codes of reporting periods sort in time), at most three years of months. */
export function seriesPeriods(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SERIES_PERIODS) throw new DomainError('VALIDATION_FAILED', 422, 'periods');
  const periods = raw.map((period) => {
    if (typeof period !== 'string' || !PERIOD_CODE.test(period)) throw new DomainError('VALIDATION_FAILED', 422, 'periods');
    return period;
  });
  if (new Set(periods).size !== periods.length) throw new DomainError('VALIDATION_FAILED', 422, 'periods');
  return [...periods].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The frozen version of the dataset a period of the series is read from. */
export interface SeriesVersion {
  period: string;
  versionId: string;
  /** The key the sums of the version are found under (the snapshot of the source the version was built from). */
  sourceSnapshotId: string;
  qualityBadge: string;
}

export interface SeriesPoint {
  period: string;
  /** Null for a period that has no frozen version: the point is there, with no figure (a gap is not zero and is not skipped). */
  versionId: string | null;
  qualityBadge: string | null;
  figure: Figure;
  sums: GroupSums | null;
  /** Whether the period has no frozen version. */
  missing: boolean;
  /** The figure less the figure of the point before it, in the unit of the figure (percentage points for a ratio); null when either has none. */
  changeFromPrevious: string | null;
}

const hundredthsOf = (value: string): bigint => BigInt(value.replace('.', ''));

function change(previous: Figure | undefined, current: Figure): string | null {
  if (previous === undefined || previous.value === null || current.value === null) return null;
  if (WHOLE.test(previous.value) && WHOLE.test(current.value)) return (BigInt(current.value) - BigInt(previous.value)).toString();
  const diff = hundredthsOf(current.value) - hundredthsOf(previous.value);
  const digits = (diff < 0n ? -diff : diff).toString().padStart(3, '0');
  return `${diff < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * The points of a series: one per requested period in order, each the figure of its version's sums by the plan (the same `figureOf` as a single query, so a point of the series and the figure of that period asked alone
 * are one number), or a gap with `NO_DATA` for a period with no version or no line. The change from the previous point is only between points that both have a figure.
 */
export function assembleSeries(plan: MeasurePlan, periods: readonly string[], versions: readonly SeriesVersion[], sums: ReadonlyMap<string, GroupSums>): SeriesPoint[] {
  const byPeriod = new Map(versions.map((version) => [version.period, version]));
  const points: SeriesPoint[] = [];
  for (const period of periods) {
    const version = byPeriod.get(period);
    // A version with no line at all is read as a group with no line (zero only when the metric says so); a period with no version has no figure.
    const found = version === undefined ? undefined : (sums.get(version.sourceSnapshotId) ?? { numerator: null, denominator: null, distinct: null, lines: '0' });
    const figure: Figure = found === undefined ? { value: null, numerator: null, denominator: null, nullReason: 'NO_DATA' } : figureOf(plan, found);
    points.push({
      period,
      versionId: version?.versionId ?? null,
      qualityBadge: version?.qualityBadge ?? null,
      figure,
      sums: found ?? null,
      missing: version === undefined,
      changeFromPrevious: change(points[points.length - 1]?.figure, figure),
    });
  }
  return points;
}

// ---- the token of a drill ------------------------------------------------------------------------------------------------------------------

export const BI_DRILL_TTL_SECONDS = 1800;
const PURPOSE = 'bi-drill:';
const MIN_KEY_BYTES = 32;

/** What a token names: ids only, no figure and no name. The context it points at is kept by the server. */
export interface BiDrillClaims {
  v: 1;
  tid: string;
  ctx_id: string;
  scope_hash: string;
  metric_version_id: string;
  snapshot_id: string;
  as_of_period: string;
  iat: number;
  exp: number;
  kid: string;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const invalid = (): DomainError => new DomainError('DRILL_TOKEN_INVALID', 400);

/** The key of one tenant, from the key of the application and the id of the key: a token of tenant A is not good under the key of tenant B, and a key can be turned by a new id. */
export function tenantDrillKey(rootKey: Buffer, tenantId: string, kid: string): Buffer {
  if (rootKey.length < MIN_KEY_BYTES) throw new Error('key too short');
  return createHmac('sha256', rootKey).update(`${PURPOSE}key:${tenantId}:${kid}`).digest();
}

const mac = (payloadPart: string, key: Buffer): Buffer => createHmac('sha256', key).update(PURPOSE).update(payloadPart).digest();

export function signBiDrill(claims: Omit<BiDrillClaims, 'v' | 'iat' | 'exp' | 'kid'>, rootKey: Buffer, kid: string, now: () => number = nowSeconds): string {
  const issued = now();
  const full: BiDrillClaims = { v: 1, ...claims, iat: issued, exp: issued + BI_DRILL_TTL_SECONDS, kid };
  const payloadPart = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `${payloadPart}.${mac(payloadPart, tenantDrillKey(rootKey, claims.tid, kid)).toString('base64url')}`;
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Reads a token back, old or not: the shape and the signature under the key of the tenant the token names are judged, the age is not. Anything that was altered, signed for another tenant or key, made for another
 * purpose or is not a token is `400 DRILL_TOKEN_INVALID` that says nothing of why. The caller judges that the tenant is the one of the session before it judges the age.
 */
export function parseBiDrill(token: string, rootKey: Buffer): BiDrillClaims {
  if (token.length > 2000) throw invalid();
  const parts = token.split('.');
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (parts.length !== 2 || !payloadPart || !signaturePart) throw invalid();
  let record: Record<string, unknown> | null;
  try {
    record = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown> | null;
  } catch {
    throw invalid();
  }
  if (typeof record !== 'object' || record === null || record.v !== 1 || !text(record.tid) || !text(record.ctx_id) || !text(record.scope_hash) || !text(record.metric_version_id) || !text(record.snapshot_id) || !text(record.as_of_period) || !text(record.kid) || typeof record.iat !== 'number' || typeof record.exp !== 'number') {
    throw invalid();
  }
  const expected = mac(payloadPart, tenantDrillKey(rootKey, record.tid, record.kid));
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  return record as unknown as BiDrillClaims;
}

/** The refusal of a token that is good and old: the context to ask again for is in the body. */
export const expiredBiDrill = (claims: BiDrillClaims): DomainError => new DomainError('SNAPSHOT_EXPIRED', 409, undefined, { extensions: { snapshot_id: claims.snapshot_id, as_of_period: claims.as_of_period } });

// ---- the key of the cache ------------------------------------------------------------------------------------------------------------------

/** The scope a person queries in, as a hash: who, the version of their grants, and what those grants let them read now (not shared between scopes). */
export function biScopeHash(input: { membershipId: string; scopeVersion: number; grants: string }): string {
  return createHash('sha256').update(`bi|${input.membershipId}|${input.scopeVersion}|${input.grants}`).digest('hex');
}

/** `t:{tenant}:bi:{metric_versions}:{filters_hash}:{snapshot_id}:{scope_hash}` — a cached answer is shared by nobody whose tenant, snapshot, query or scope differs (BR-BI-07). */
export function queryCacheKey(input: { tenantId: string; metricVersionIds: readonly string[]; filtersHash: string; snapshotId: string; scopeHash: string }): string {
  return `t:${input.tenantId}:bi:${[...input.metricVersionIds].sort().join(',')}:${input.filtersHash}:${input.snapshotId}:${input.scopeHash}`;
}
