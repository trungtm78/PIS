import { randomUUID } from 'node:crypto';
import { DISBURSEMENT_ADAPTER, DomainError, datasetAdapterOf, datasetAdapters } from '@machvon/kernel';
import type { DatasetAdapter, DatasetDimension, GroupSums, MeasurePlan, SeriesVersion, StageTerm } from '@machvon/kernel';
import { hasQuerySource, querySourceOf } from './bi-query-source.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 500;
/** The label of the group that has no value in the dimension: it is shown, so that the children add up to the parent. */
export const UNCLASSIFIED_KEY = null;

export type FilterOperator = 'eq' | 'in' | 'gte' | 'lte';
export interface QueryFilter {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

/** A row predicate of an access policy, as the kernel validated it; compiled here to a condition over the snapshot lines. */
export type PolicyNode = Record<string, unknown>;

export interface AggregateInput {
  snapshotId: string;
  /** The dataset the lines belong to: its allowlists of dimensions and the reader of its source. DS-DISB when none is named. */
  adapter?: DatasetAdapter | undefined;
  plan: MeasurePlan;
  /** The dimension to group by; none gives the total. */
  dimension?: string | undefined;
  filters: readonly QueryFilter[];
  /** The projects the reader may read: a line of a project outside it is not counted. */
  projects: ScopeBuilder;
  /** The row predicates of the applicable policies: a line is counted when any of them allows it (within the scope of the reader). */
  policies: readonly PolicyNode[];
  /** How many groups at most; one more is read to tell that there are more. A screen reads the page (500), an export reads up to its cap. */
  limit?: number | undefined;
}

export interface AggregateRow extends GroupSums {
  key: string | null;
  label: string | null;
}

export interface SnapshotVersion {
  /** The code of the dataset the version belongs to. */
  datasetCode: string;
  /** The snapshot of BI: the version of the dataset for a period. It is what a query is pinned to and what the API calls `snapshot_id`. */
  datasetVersionId: string;
  datasetId: string;
  /** The frozen close snapshot of DIS the version was made from: its lines are what the query reads. */
  sourceSnapshotId: string;
  /** How many lines the frozen snapshot of DIS has: what a query over it costs is judged from it. */
  sourceRows: number;
  periodCode: string;
  periodId: string;
  qualityBadge: string;
  excludedQuarantineRows: number;
  versionStatus: string;
  builtAt: string;
  /** The frozen version of the period now, if it is another than the one asked: new data is available (the banner), the figures stay on the version asked. */
  newerSnapshotId: string | null;
}

export interface ContextRow {
  id: string;
  metricVersionId: string;
  snapshotId: string;
  asOfPeriod: string;
  scopeHash: string;
  filters: QueryFilter[];
  dimensionPath: string[];
  expiresAt: string;
  parentContextId: string | null;
  createdBy: string | null;
}

interface Sql {
  [column: string]: unknown;
  version_id: string;
  dataset_id: string;
  dataset_code: string;
  source_snapshot_id: string;
  as_of_period: string;
  reporting_period_id: string;
  quality_badge: string;
  status: string;
  built_at: string | number | Date;
  newer: string | null;
  id: string;
  metric_version_id: string;
  snapshot_id: string;
  subject_scope_hash: string;
  filters_ast: QueryFilter[];
  expires_at: string | number | Date;
  parent_context_id: string | null;
  created_by: string | null;
  key: string | null;
  label: string | null;
  numerator: string | null;
  denominator: string | null;
  distinct_count: string | null;
  line_count: string | null | undefined;
  dimension_path: string[] | null;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export class Params {
  readonly values: unknown[];
  constructor(first: unknown[]) {
    this.values = first;
  }

  add(value: unknown): number {
    this.values.push(value);
    return this.values.length;
  }
}

function dimensionOf(field: string, adapter: DatasetAdapter): DatasetDimension {
  // An own property only: a name such as `constructor` is not a dimension.
  const dimension = Object.prototype.hasOwnProperty.call(adapter.dimensions, field) ? adapter.dimensions[field] : undefined;
  if (dimension === undefined) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, field);
  return dimension;
}

function valueFor(kind: 'uuid' | 'text', value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 120 || (kind === 'uuid' && !UUID.test(value))) throw invalid(`filters.${field}`);
  return kind === 'uuid' ? value.toLowerCase() : value;
}

/** A filter as the query takes it, or the refusal: the column of its dimension, the type its values have, the operator and the values cleaned (an id in lower case, a list that is not empty). */
function normalized(filter: QueryFilter, adapter: DatasetAdapter): { column: string; cast: 'uuid' | 'text'; operator: QueryFilter['operator']; value: string | string[] } {
  const { column, kind } = dimensionOf(filter.field, adapter);
  const cast = kind === 'uuid' ? 'uuid' : 'text';
  if (filter.operator === 'eq') return { column, cast, operator: 'eq', value: valueFor(kind, filter.value, filter.field) };
  if (filter.operator === 'in') {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) throw invalid(`filters.${filter.field}`);
    return { column, cast, operator: 'in', value: filter.value.map((item) => valueFor(kind, item, filter.field)) };
  }
  // An order only means something for text (a bucket, a level); ids are not ordered.
  if (kind !== 'text') throw invalid(`filters.${filter.field}`);
  return { column, cast: 'text', operator: filter.operator, value: valueFor(kind, filter.value, filter.field) };
}

/**
 * Whether a filter can be run at all, before anything is kept that names it (a schedule of exports is kept and run later, so a filter it cannot run must be refused when it is made). Over the dataset it will run on
 * when that is known; otherwise it must be good for at least one dataset, and the error is the one of a dataset that has the dimension (a dataset that lacks it only says the dimension is not in it).
 */
export function assertFilter(filter: QueryFilter, adapter?: DatasetAdapter): void {
  if (adapter !== undefined) {
    normalized(filter, adapter);
    return;
  }
  const errors: unknown[] = [];
  for (const candidate of datasetAdapters()) {
    try {
      normalized(filter, candidate);
      return;
    } catch (error) {
      errors.push(error);
    }
  }
  throw errors.find((error) => !(error instanceof DomainError && error.code === 'DIMENSION_NOT_IN_DATASET')) ?? errors[0];
}

function filterSql(filter: QueryFilter, params: Params, adapter: DatasetAdapter): string {
  const found = normalized(filter, adapter);
  if (found.operator === 'eq') return `l.${found.column} = $${params.add(found.value)}::${found.cast}`;
  if (found.operator === 'in') return `l.${found.column} = any($${params.add(found.value)}::${found.cast}[])`;
  return `l.${found.column} ${found.operator === 'gte' ? '>=' : '<='} $${params.add(found.value)}::text`;
}

/** A predicate of a policy as a condition on the lines. `unit_in_scope` is true: the scope of the reader is applied to every line anyway. */
export function policySql(node: PolicyNode, params: Params, depth = 0, adapter: DatasetAdapter = DISBURSEMENT_ADAPTER): string {
  if (depth > 6) throw new DomainError('PREDICATE_NOT_ALLOWED', 422, 'row_predicate');
  const op = node.op;
  const args = Array.isArray(node.args) ? (node.args as PolicyNode[]) : [];
  switch (op) {
    case 'unit_in_scope':
      return 'true';
    case 'eq':
    case 'ne': {
      const { column, kind } = dimensionOf(String(node.field), adapter);
      return `l.${column}${op === 'eq' ? ' = ' : ' is distinct from '}$${params.add(kind === 'uuid' ? valueFor(kind, node.value, String(node.field)) : String(node.value))}::${kind}`;
    }
    case 'in': {
      const { column, kind } = dimensionOf(String(node.field), adapter);
      const values = (Array.isArray(node.values) ? node.values : []).map((item) => (kind === 'uuid' ? valueFor(kind, item, String(node.field)) : String(item)));
      return `l.${column} = any($${params.add(values)}::${kind}[])`;
    }
    case 'and':
    case 'or':
      return `(${args.map((child) => policySql(child, params, depth + 1, adapter)).join(op === 'and' ? ' and ' : ' or ')})`;
    case 'not':
      return `not (${policySql(args[0] as PolicyNode, params, depth + 1, adapter)})`;
    default:
      throw new DomainError('PREDICATE_NOT_ALLOWED', 422, 'row_predicate');
  }
}

const MAX_SERIES_POINTS = 36;

/**
 * The SQL of one term of the second stage over the groups `g` of the first (`v` the value of a group, `k` its key, `rn` its rank by value): the multiplier and N were validated by the planner as whole numbers, and
 * are written as numbers, never as text. The total is a sum over all the groups, and a group with no figure (null) is no group.
 */
function stageSql(term: StageTerm): string {
  const times = /^[1-9][0-9]{0,6}$/.test(term.multiplier) ? term.multiplier : '1';
  switch (term.op) {
    case 'SUM':
      return `(sum(v) * ${times})`;
    case 'SUM_OF_SQUARES':
      return `(sum(v * v) * ${times})`;
    case 'TOTAL_SQUARED':
      return `(sum(v) * sum(v) * ${times})`;
    case 'TOP_N_SUM':
      if (!Number.isInteger(term.n) || (term.n as number) < 1 || (term.n as number) > 1000) throw new DomainError('VALIDATION_FAILED', 422, 'metric_version_id');
      return `(sum(v) filter (where rn <= ${term.n as number}) * ${times})`;
  }
}

/**
 * The queries of BI over a frozen snapshot (ST-BI-004, BI F3): the SQL is written here from the allowlists of the dataset (the columns of a snapshot line, the dimensions it offers), the tenant is filtered by row level
 * security and the scope of the reader on the project of every line, and a policy only ever narrows. The sums are exact (decimal text), the groups are of one dimension, and a line with no value in it is kept as a group of
 * its own so that the children add up to the parent.
 */
export class BiQueryStore {
  /** The version of the dataset a snapshot of BI names (the frozen one, or one a later build replaced, which still serves a drill that was opened on it). */
  async versionOfSnapshot(tx: TenantTx, datasetCode: string, snapshotId: string): Promise<SnapshotVersion | undefined> {
    // A dataset the engine has no adapter for is not read; a dataset whose source is not there yet is refused as such.
    const adapter = datasetAdapterOf(datasetCode);
    if (adapter === undefined) return undefined;
    const source = querySourceOf(adapter);
    const rows = await tx.query<Sql>(
      `select v.id as version_id, v.dataset_id, d.dataset_code, v.source_snapshot_id, v.as_of_period, v.reporting_period_id, v.quality_badge, v.excluded_quarantine_rows::text as excluded, v.status, v.built_at,
              ${source.sourceRowsSql} as source_rows,
              (select nv.id from machvon.bi_dataset_version nv where nv.tenant_id = v.tenant_id and nv.dataset_id = v.dataset_id and nv.as_of_period = v.as_of_period and nv.status = 'FROZEN' and nv.id <> v.id limit 1) as newer
         from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id
        where d.dataset_code = $1 and v.id = $2::uuid and v.status in ('FROZEN', 'SUPERSEDED') limit 1`,
      [datasetCode, snapshotId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      datasetCode: row.dataset_code,
      datasetVersionId: row.version_id,
      datasetId: row.dataset_id,
      sourceSnapshotId: row.source_snapshot_id,
      sourceRows: Number(row.source_rows),
      periodCode: row.as_of_period,
      periodId: row.reporting_period_id,
      qualityBadge: row.quality_badge,
      excludedQuarantineRows: Number(row.excluded),
      versionStatus: row.status,
      builtAt: new Date(row.built_at).toISOString(),
      newerSnapshotId: row.newer,
    };
  }

  /** The version of the dataset a snapshot of BI names, whichever dataset it is (the snapshot says which): none when it is not a version served, or of a dataset the engine does not read. */
  async versionOfSnapshotAny(tx: TenantTx, snapshotId: string): Promise<SnapshotVersion | undefined> {
    const rows = await tx.query<{ dataset_code: string }>(
      "select d.dataset_code from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id where v.id = $1::uuid and v.status in ('FROZEN', 'SUPERSEDED') limit 1",
      [snapshotId],
    );
    const code = rows[0]?.dataset_code;
    return code === undefined ? undefined : this.versionOfSnapshot(tx, code, snapshotId);
  }

  /** The frozen version of the dataset (DS-DISB when none is named) for a period now. */
  async latestSnapshotOfPeriod(tx: TenantTx, periodCode: string, datasetCode: string = DISBURSEMENT_ADAPTER.code): Promise<string | undefined> {
    const rows = await tx.query<{ id: string }>(
      "select v.id from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id where d.dataset_code = $2 and v.as_of_period = $1 and v.status = 'FROZEN' limit 1",
      [periodCode, datasetCode],
    );
    return rows[0]?.id;
  }

  /** The frozen version of each period asked, the periods that have none left out: what a series is read from. The key a version's lines are found under is the snapshot of its source. */
  async frozenVersionsOfPeriods(tx: TenantTx, datasetCode: string, periods: readonly string[]): Promise<SeriesVersion[]> {
    const rows = await tx.query<{ id: string; as_of_period: string; source_snapshot_id: string | null; quality_badge: string }>(
      `select v.id, v.as_of_period, v.source_snapshot_id, v.quality_badge
         from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id
        where d.dataset_code = $1 and v.as_of_period = any($2::text[]) and v.status = 'FROZEN' and v.source_snapshot_id is not null
        order by v.as_of_period`,
      [datasetCode, [...periods]],
    );
    return rows.map((row) => ({ period: row.as_of_period, versionId: row.id, sourceSnapshotId: row.source_snapshot_id as string, qualityBadge: row.quality_badge }));
  }

  /** Whether the lines of a dataset can be read in this build (its source is registered). */
  hasSource(adapter: DatasetAdapter): boolean {
    return hasQuerySource(adapter.sourceKind);
  }

  /** The frozen version of a dataset (by its code) that was built last, with its period. */
  async latestFrozenVersion(tx: TenantTx, datasetCode: string): Promise<{ versionId: string; periodCode: string } | undefined> {
    const rows = await tx.query<{ id: string; as_of_period: string }>(
      "select v.id, v.as_of_period from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id where d.dataset_code = $1 and v.status = 'FROZEN' order by v.built_at desc, v.id desc limit 1",
      [datasetCode],
    );
    return rows[0] === undefined ? undefined : { versionId: rows[0].id, periodCode: rows[0].as_of_period };
  }

  /** The frozen version of a dataset that was built last, and the snapshot it was built from. */
  async latestFrozenOfDataset(tx: TenantTx, datasetId: string): Promise<{ versionId: string; snapshotId: string | null; datasetCode: string } | undefined> {
    const rows = await tx.query<{ id: string; source_snapshot_id: string | null; dataset_code: string }>(
      `select v.id, v.source_snapshot_id, d.dataset_code from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id
        where v.dataset_id = $1::uuid and v.status = 'FROZEN' order by v.built_at desc, v.id desc limit 1`,
      [datasetId],
    );
    return rows[0] === undefined ? undefined : { versionId: rows[0].id, snapshotId: rows[0].source_snapshot_id, datasetCode: rows[0].dataset_code };
  }

  /**
   * The rerun of a metric over a snapshot, over the whole tenant: the lines it finds against the rows the snapshot says it has, and whether the groups of each dimension add up to the whole (the sums the metric is made of,
   * grouped and not). A distinct count is not added, so only its rows are compared. The columns and dimensions come from the allowlists of the dataset (kernel), never from the request.
   */
  async reproduce(
    tx: TenantTx,
    snapshotId: string,
    plan: MeasurePlan,
    dimensions: readonly string[],
    adapter: DatasetAdapter = DISBURSEMENT_ADAPTER,
  ): Promise<{ storedRows: number; countedRows: number; reconciles: boolean } | undefined> {
    const source = querySourceOf(adapter);
    const stored = await tx.query<{ row_count: number }>(source.storedRowsSql, [snapshotId]);
    if (stored[0] === undefined) return undefined;
    const counted = await tx.query<{ n: string }>(source.countedRowsSql, [snapshotId]);
    let reconciles = true;
    if (plan.kind !== 'DISTINCT') {
      const second = plan.denominatorColumn === null ? 'null::numeric' : `l.${plan.denominatorColumn}`;
      for (const dimension of dimensions) {
        const { column } = dimensionOf(dimension, adapter);
        const [row] = await tx.query<{ ok: boolean }>(
          `with line as (select l.${plan.numeratorColumn} as n, ${second} as d, l.${column} as k from ${source.linesTable} l where l.${source.snapshotColumn} = $1::uuid),
                grouped as (select sum(n) as n, sum(d) as d from line group by k)
           select (select sum(n) from line) is not distinct from (select sum(n) from grouped) and (select sum(d) from line) is not distinct from (select sum(d) from grouped) as ok`,
          [snapshotId],
        );
        reconciles = reconciles && row?.ok === true;
      }
    }
    return { storedRows: stored[0].row_count, countedRows: Number(counted[0]?.n ?? 0), reconciles };
  }

  /** What every aggregation shares: the conditions over the lines (the snapshot, the scope of the reader, the filters, the policies), with their parameters; the scope is numbered after what the caller already put in the parameters. */
  private conditionsOf(input: AggregateInput, adapter: DatasetAdapter, params: Params, snapshotCondition: string): string[] {
    const scope = input.projects(params.values.length + 1);
    for (const value of scope.params) params.add(value);
    const conditions = [snapshotCondition, scope.sql, ...input.filters.map((filter) => filterSql(filter, params, adapter))];
    if (input.policies.length > 0) conditions.push(`(${input.policies.map((policy) => policySql(policy, params, 0, adapter)).join(' or ')})`);
    return conditions;
  }

  /** The sums of the groups of the snapshot, one dimension at a time, in the scope of the reader. */
  async aggregate(tx: TenantTx, input: AggregateInput): Promise<AggregateRow[]> {
    const adapter = input.adapter ?? DISBURSEMENT_ADAPTER;
    const source = querySourceOf(adapter);
    if (input.plan.twoStage !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'metric_version_id');
    const params = new Params([input.snapshotId]);
    const conditions = this.conditionsOf(input, adapter, params, `l.${source.snapshotColumn} = $1::uuid`);
    const { plan } = input;
    // The columns come from the allowlist of the dataset (kernel), never from the request.
    const measures =
      plan.kind === 'DISTINCT'
        ? `null::text as numerator, null::text as denominator, case when count(l.${plan.numeratorColumn}) = 0 then null else count(distinct l.${plan.numeratorColumn})::text end as distinct_count, count(*)::text as line_count`
        : `sum(l.${plan.numeratorColumn})::text as numerator, ${plan.denominatorColumn === null ? 'null::text' : `sum(l.${plan.denominatorColumn})::text`} as denominator, null::text as distinct_count, count(*)::text as line_count`;
    let keyed = 'null::text as key, null::text as label';
    let grouping = '';
    if (input.dimension !== undefined) {
      const { column } = dimensionOf(input.dimension, adapter);
      keyed = `l.${column}::text as key, ${source.labelSql(input.dimension, column)} as label`;
      grouping = `group by l.${column} order by l.${column}::text nulls last`;
    }
    const rows = await tx.query<Sql>(
      `select ${keyed}, ${measures}
         from ${source.linesTable} l ${source.joinsSql}
        where ${conditions.join(' and ')} ${grouping} limit ${(input.limit ?? MAX_ROWS) + 1}`,
      params.values,
    );
    return rows.map((row) => ({ key: row.key, label: row.label, numerator: row.numerator, denominator: row.denominator, distinct: row.distinct_count, lines: row.line_count }));
  }

  /**
   * A measure of two stages over one snapshot (R16): the lines are grouped by the dimension (the first stage sums the column in each group), and the second stage reads the groups: the sum of their squares, the sum of
   * the N largest, the total and its square. The groups come back as rows whose numerator is the value of the group and whose denominator is the total of all the groups (their figure is their share), and the total is the
   * second stage itself, one row. The dimension is required: it is what the groups are.
   */
  async aggregateTwoStage(tx: TenantTx, input: AggregateInput): Promise<{ groups: AggregateRow[]; total: AggregateRow }> {
    const adapter = input.adapter ?? DISBURSEMENT_ADAPTER;
    const source = querySourceOf(adapter);
    const stage = input.plan.twoStage;
    if (stage === undefined || !adapter.capabilities.twoStage) throw new DomainError('VALIDATION_FAILED', 422, 'metric_version_id');
    if (input.dimension === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dimension');
    const params = new Params([input.snapshotId]);
    const conditions = this.conditionsOf(input, adapter, params, `l.${source.snapshotColumn} = $1::uuid`);
    const { column } = dimensionOf(input.dimension, adapter);
    const first = `select l.${column} as k, ${source.labelSql(input.dimension, column)} as label, sum(l.${input.plan.numeratorColumn}) as v, count(*) as n
         from ${source.linesTable} l ${source.joinsSql}
        where ${conditions.join(' and ')} group by l.${column}`;
    const limit = (input.limit ?? MAX_ROWS) + 1;
    const groups = await tx.query<Sql>(
      `with g as (${first})
       select k::text as key, label, v::text as numerator, (sum(v) over ())::text as denominator, null::text as distinct_count, n::text as line_count
         from g order by k::text nulls last limit ${limit}`,
      params.values,
    );
    const total = await tx.query<Sql>(
      `with g as (${first}), ranked as (select g.*, row_number() over (order by v desc nulls last, k::text nulls last) as rn from g)
       select ${stageSql(stage.numerator)}::text as numerator, ${stageSql(stage.denominator)}::text as denominator, null::text as distinct_count, coalesce(sum(n), 0)::text as line_count from ranked`,
      params.values,
    );
    const shape = (row: Sql): AggregateRow => ({ key: row.key, label: row.label, numerator: row.numerator, denominator: row.denominator, distinct: row.distinct_count, lines: row.line_count });
    const only = total[0];
    return { groups: groups.map(shape), total: only === undefined ? { key: null, label: null, numerator: null, denominator: null, distinct: null } : shape({ ...only, key: null, label: null }) };
  }

  /**
   * The sums of one metric over several snapshots of the source at once (a series over periods): per snapshot, and per group when the plan is cut by a dimension; a measure of two stages gives the second stage of each
   * snapshot (the dimension is then what the groups are). One query for all the periods, under the same scope and policies as a query of one. The key of a row is the group, the snapshot is in `snapshotId`.
   */
  async aggregateSeries(tx: TenantTx, input: Omit<AggregateInput, 'snapshotId'> & { snapshotIds: readonly string[] }): Promise<Array<{ snapshotId: string; sums: AggregateRow }>> {
    const adapter = input.adapter ?? DISBURSEMENT_ADAPTER;
    const source = querySourceOf(adapter);
    if (!adapter.capabilities.periodSeries) throw new DomainError('VALIDATION_FAILED', 422, 'periods');
    if (input.snapshotIds.length === 0) return [];
    const params = new Params([[...input.snapshotIds]]);
    const conditions = this.conditionsOf({ ...input, snapshotId: '' }, adapter, params, `l.${source.snapshotColumn} = any($1::uuid[])`);
    const { plan } = input;
    const dimension = input.dimension === undefined ? undefined : dimensionOf(input.dimension, adapter);
    const stage = plan.twoStage;
    if (stage !== undefined) {
      if (dimension === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dimension');
      const rows = await tx.query<Sql & { sid: string }>(
        `with g as (select l.${source.snapshotColumn} as sid, l.${dimension.column} as k, sum(l.${plan.numeratorColumn}) as v, count(*) as n
                      from ${source.linesTable} l ${source.joinsSql}
                     where ${conditions.join(' and ')} group by l.${source.snapshotColumn}, l.${dimension.column}),
              ranked as (select g.*, row_number() over (partition by sid order by v desc nulls last, k::text nulls last) as rn from g)
         select sid::text as sid, ${stageSql(stage.numerator)}::text as numerator, ${stageSql(stage.denominator)}::text as denominator, null::text as distinct_count, coalesce(sum(n), 0)::text as line_count
           from ranked group by sid`,
        params.values,
      );
      return rows.map((row) => ({ snapshotId: row.sid, sums: { key: null, label: null, numerator: row.numerator, denominator: row.denominator, distinct: null, lines: row.line_count } }));
    }
    const measures =
      plan.kind === 'DISTINCT'
        ? `null::text as numerator, null::text as denominator, case when count(l.${plan.numeratorColumn}) = 0 then null else count(distinct l.${plan.numeratorColumn})::text end as distinct_count, count(*)::text as line_count`
        : `sum(l.${plan.numeratorColumn})::text as numerator, ${plan.denominatorColumn === null ? 'null::text' : `sum(l.${plan.denominatorColumn})::text`} as denominator, null::text as distinct_count, count(*)::text as line_count`;
    const keyed = dimension === undefined || input.dimension === undefined ? 'null::text as key, null::text as label' : `l.${dimension.column}::text as key, ${source.labelSql(input.dimension, dimension.column)} as label`;
    const grouping = dimension === undefined ? '' : `, l.${dimension.column}`;
    const rows = await tx.query<Sql & { sid: string }>(
      `select l.${source.snapshotColumn}::text as sid, ${keyed}, ${measures}
         from ${source.linesTable} l ${source.joinsSql}
        where ${conditions.join(' and ')} group by l.${source.snapshotColumn}${grouping} order by sid, key nulls last limit ${(input.limit ?? MAX_ROWS * MAX_SERIES_POINTS) + 1}`,
      params.values,
    );
    return rows.map((row) => ({ snapshotId: row.sid, sums: { key: row.key, label: row.label, numerator: row.numerator, denominator: row.denominator, distinct: row.distinct_count, lines: row.line_count } }));
  }

  /** Whether the reader may still read a unit the context names: it is in a unit they hold, or lines of projects they read are of it. */
  async unitStillReadable(tx: TenantTx, snapshotId: string, unitId: string, projects: ScopeBuilder, units: ScopeBuilder, adapter: DatasetAdapter = DISBURSEMENT_ADAPTER): Promise<boolean> {
    const source = querySourceOf(adapter);
    const own = units(2);
    const byUnit = await tx.query('select 1 from machvon.organization_unit u where u.id = $1::uuid and ' + own.sql, [unitId, ...own.params]);
    if (byUnit.length > 0) return true;
    const scope = projects(3);
    const byProject = await tx.query(
      `select 1 from ${source.linesTable} l ${source.joinsSql} where l.${source.snapshotColumn} = $1::uuid and l.unit_id = $2::uuid and ${scope.sql} limit 1`,
      [snapshotId, unitId, ...scope.params],
    );
    return byProject.length > 0;
  }

  async requesterOf(tx: TenantTx, membershipId: string): Promise<{ roleIds: string[]; unitIds: string[] }> {
    const roles = await tx.query<{ role_id: string }>(
      "select distinct role_id from machvon.role_grant where membership_id = $1::uuid and status = 'Active' and effective_from <= now() and (effective_until is null or now() < effective_until)",
      [membershipId],
    );
    const units = await tx.query<{ id: string }>(
      `select a.id from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id
         join machvon.organization_unit a on a.tenant_id = u.tenant_id and u.path like a.path || '%' where m.id = $1::uuid`,
      [membershipId],
    );
    return { roleIds: roles.map((row) => row.role_id), unitIds: units.map((row) => row.id) };
  }

  // ---- the contexts of a drill -------------------------------------------------------------------------------------------------------------

  async insertContext(
    tx: TenantTx,
    input: {
      metricVersionId: string;
      snapshotId: string;
      asOfPeriod: string;
      scopeHash: string;
      filters: readonly QueryFilter[];
      dimensionPath: readonly string[];
      unit: string;
      parentContextId: string | null;
      createdBy: string;
      ttlSeconds: number;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.drill_context (tenant_id, id, subject_scope_hash, metric_version_id, snapshot_id, filters_ast, path, as_of, expires_at, as_of_period, dimension_path, unit, currency, parent_context_id, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb, $6::jsonb, now(), now() + make_interval(secs => $7::int), $8, $6::jsonb, $9, $10, $11::uuid, $12::uuid)`,
      [
        id,
        input.scopeHash,
        input.metricVersionId,
        input.snapshotId,
        JSON.stringify(input.filters),
        JSON.stringify(input.dimensionPath),
        input.ttlSeconds,
        input.asOfPeriod,
        input.unit,
        input.unit === 'VND' ? 'VND' : null,
        input.parentContextId,
        input.createdBy,
      ],
    );
    return id;
  }

  async findContext(tx: TenantTx, id: string): Promise<ContextRow | undefined> {
    const rows = await tx.query<Sql>(
      `select id, metric_version_id, snapshot_id, as_of_period, subject_scope_hash, filters_ast, dimension_path, expires_at, parent_context_id, created_by from machvon.drill_context where id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      metricVersionId: row.metric_version_id,
      snapshotId: row.snapshot_id,
      asOfPeriod: row.as_of_period,
      scopeHash: row.subject_scope_hash,
      filters: row.filters_ast,
      dimensionPath: row.dimension_path ?? [],
      expiresAt: new Date(row.expires_at).toISOString(),
      parentContextId: row.parent_context_id,
      createdBy: row.created_by,
    };
  }

  /** The contexts a person made, the newest first (the read of the contexts is for the person's own). */
  async contextsOf(tx: TenantTx, membershipId: string, limit: number): Promise<ContextRow[]> {
    const rows = await tx.query<{ id: string }>('select id from machvon.drill_context where created_by = $1::uuid order by created_at desc, id desc limit $2', [membershipId, limit]);
    const found: ContextRow[] = [];
    for (const row of rows) {
      const context = await this.findContext(tx, row.id);
      if (context !== undefined) found.push(context);
    }
    return found;
  }

  async recordRun(
    tx: TenantTx,
    run: {
      requestedBy: string;
      metricVersionIds: readonly string[];
      asOfPeriod: string;
      datasetVersionId: string;
      scopeHash: string;
      drillContextId: string | null;
      status: 'COMPLETED' | 'DENIED' | 'FAILED';
      servedFromCache: boolean;
      durationMs: number;
      rowCount: number | null;
      errorCode: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `insert into machvon.bi_query_run (tenant_id, id, requested_by, metric_version_ids, as_of_period, dataset_version_id, scope_hash, drill_context_id, mode, status, served_from_cache, duration_ms, row_count, cost_units, error_code)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid, $6, $7::uuid, 'SYNC', $8, $9, $10::int, $11::int, $12::numeric, $13)`,
      [
        randomUUID(),
        run.requestedBy,
        JSON.stringify(run.metricVersionIds),
        run.asOfPeriod,
        run.datasetVersionId,
        run.scopeHash,
        run.drillContextId,
        run.status,
        run.servedFromCache,
        run.durationMs,
        run.rowCount,
        run.rowCount ?? 0,
        run.errorCode,
      ],
    );
  }

  get maxRows(): number {
    return MAX_ROWS;
  }
}
