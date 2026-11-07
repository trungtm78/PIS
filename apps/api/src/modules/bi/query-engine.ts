import { createHash } from 'node:crypto';
import { PERMISSIONS } from '@machvon/contracts';
import { BiMetricStore, BiPolicyStore, BiQueryStore, projectScope } from '@machvon/db';
import type { ScopeBuilder } from '@machvon/db';
import type { AggregateRow, QueryFilter, SnapshotVersion } from '@machvon/db';
import {
  BI_SYNC_COST_LIMIT,
  DISBURSEMENT_ADAPTER,
  DomainError,
  adaptersReadingFields,
  assembleSeries,
  biScopeHash,
  canonicalJson,
  datasetAdapterOf,
  estimateQueryCost,
  fieldsOfTree,
  hiddenColumns,
  homeScopeFingerprint,
  isHeavyQuery,
  knownDimensionNames,
  measurePlanOf,
  queryCacheKey,
} from '@machvon/kernel';
import type { DatasetAdapter, EffectiveAccess, GroupSums, MeasurePlan, SeriesPoint } from '@machvon/kernel';
import { BiQueryCache } from './query-cache';

type Tx = Parameters<BiQueryStore['findContext']>[0];

export const QUERY_PERMISSION = PERMISSIONS.post_dashboard_queries;
export const EXPORT_PERMISSION = PERMISSIONS.requestBiExport;
/** The dataset the platform has always had: what is read when nothing names another (a period asked for alone, a schedule made before datasets were many). The dataset of a snapshot is the one it belongs to. */
export const DATASET_CODE = DISBURSEMENT_ADAPTER.code;
/** The dimensions of every dataset: the first filter on what a caller sends, before the dataset of the snapshot is known. The adapter of that dataset has the last word (`assertDimensions`). */
export const FILTER_FIELDS: ReadonlySet<string> = knownDimensionNames();

export interface Answer {
  rows: AggregateRow[];
  total: AggregateRow;
  truncated: boolean;
  builtAt: string;
}

export const emptySums = (): AggregateRow => ({ key: null, label: null, numerator: null, denominator: null, distinct: null });

/** The reading of a snapshot under one metric, one dimension and a scope: the same code for the first query, for the drill that follows it and for the export. */
export interface Reading {
  /** The dataset the snapshot belongs to: the allowlists of the fields and dimensions and the reader of its lines. */
  adapter: DatasetAdapter;
  plan: MeasurePlan;
  metricId: string;
  metricCode: string;
  metricRevision: number;
  unit: string;
  aggregationType: string;
  version: SnapshotVersion;
  scopeHash: string;
  fullTenant: boolean;
  policies: Array<Record<string, unknown>>;
  allowedDimensions: string[];
}

/**
 * What every way of asking a figure of BI has in common (ST-BI-004, ST-BI-008): the metric, the snapshot, the quality of its version, the scope of the reader and the policies that apply to them, or the refusal; and the
 * groups and the total under them. The reader is a membership and the access it holds now, so a person who is not in a request (the recipient of a schedule) is read the same way as one who is.
 */
export class BiQueryEngine {
  private readonly metrics = new BiMetricStore();
  private readonly queries = new BiQueryStore();
  private readonly policies = new BiPolicyStore();

  constructor(
    private readonly cache: BiQueryCache = new BiQueryCache(),
    /** The cost a query may have and still be answered in the request. */
    private readonly syncCostLimit: number = BI_SYNC_COST_LIMIT,
  ) {}

  get maxRows(): number {
    return this.queries.maxRows;
  }

  /** The metric, the snapshot, the quality of its version, the scope of the reader and the policies that apply to them; or the refusal. */
  async read(
    tx: Tx,
    membershipId: string,
    access: EffectiveAccess,
    metricId: string,
    snapshotId: string,
    now: Date,
    pinned = false,
  ): Promise<{ value: Reading; denied?: undefined } | { denied: 'ACCESS_POLICY_MISSING'; value?: undefined }> {
    const metric = await this.metrics.find(tx, metricId);
    if (metric === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'metric_version_id');
    // A path that is open keeps the revision of the metric it was begun with: a newer revision that replaced it (a sync) does not close the drill; a draft, one in review or one retired is not queried.
    if (metric.status !== 'CERTIFIED' && !(pinned && metric.status === 'SUPERSEDED')) throw new DomainError('METRIC_NOT_CERTIFIED', 422, 'metric_version_id');
    // The dataset is the one the snapshot belongs to. A snapshot that is not found is judged after the plan, so that the order of the refusals is the one it always was.
    const version = await this.queries.versionOfSnapshotAny(tx, snapshotId);
    if (version === undefined) this.assertSourceOfMetric(metric);
    const adapter = version === undefined ? DISBURSEMENT_ADAPTER : (datasetAdapterOf(version.datasetCode) as DatasetAdapter);
    const plan = measurePlanOf(
      {
        aggregationType: metric.aggregationType as never,
        expressionAst: metric.expressionAst,
        numeratorAst: metric.numeratorAst,
        denominatorAst: metric.denominatorAst,
        nullPolicy: metric.nullPolicy as never,
      },
      adapter,
    );
    if (version === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 422, 'snapshot_id');
    const requester = await this.queries.requesterOf(tx, membershipId);
    let applicable;
    try {
      applicable = await this.policies.applicable(tx, version.datasetId, { membershipId, ...requester });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ACCESS_POLICY_MISSING') return { denied: 'ACCESS_POLICY_MISSING' };
      throw error;
    }
    const hidden = hiddenColumns(applicable);
    const closed = new Set([...hidden.hidden, ...hidden.masked]);
    // A column is known by the name of its dimension, by its name in the table and by the names of the fields that read it.
    const aliasesOf = (column: string): string[] => [
      column,
      ...Object.entries(adapter.fields)
        .filter(([, mapped]) => mapped === column)
        .map(([field]) => field),
      ...Object.entries(adapter.dimensions)
        .filter(([, dimension]) => dimension.column === column)
        .map(([name]) => name),
    ];
    // A column a policy hides or masks is not summed either: the figure of a metric over it would give the column away to a filter that narrows to one row.
    for (const column of [plan.numeratorColumn, plan.denominatorColumn]) {
      if (column === null) continue;
      const restricted = aliasesOf(column).find((alias) => closed.has(alias));
      if (restricted !== undefined) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, restricted);
    }
    const scopeHash = biScopeHash({ membershipId, scopeVersion: access.scopeVersion, grants: homeScopeFingerprint(access, QUERY_PERMISSION, now) });
    return {
      value: {
        adapter,
        plan,
        metricId: metric.id,
        metricCode: metric.code,
        metricRevision: metric.revision,
        unit: metric.unit,
        aggregationType: metric.aggregationType,
        version,
        scopeHash,
        fullTenant: projectScope(access, QUERY_PERMISSION, now)(1).sql === 'true',
        policies: applicable.map((policy) => policy.rowPredicate),
        allowedDimensions: Object.entries(adapter.dimensions)
          .filter(([name, dimension]) => !closed.has(name) && !aliasesOf(dimension.column).some((alias) => closed.has(alias)))
          .map(([name]) => name),
      },
    };
  }

  /**
   * A metric that reads the fields of a dataset whose source is not in this build cannot be queried, whatever snapshot it is asked over: `DATASET_SOURCE_UNAVAILABLE`, not a snapshot that is "not found". A metric
   * that some available dataset can read (or that reads no field) is left to the plan and the snapshot, as before.
   */
  private assertSourceOfMetric(metric: { expressionAst: unknown; numeratorAst: unknown; denominatorAst: unknown }): void {
    const fields = [metric.expressionAst, metric.numeratorAst, metric.denominatorAst].flatMap((tree) => fieldsOfTree(tree as never));
    const homes = adaptersReadingFields(fields);
    if (homes.length > 0 && homes.every((home) => !this.queries.hasSource(home))) {
      throw new DomainError('DATASET_SOURCE_UNAVAILABLE', 422, 'snapshot_id', { extensions: { dataset_code: homes[0]?.code ?? null } });
    }
  }

  /**
   * What a file of an export was cut under, for the person: their grants and the version of their scope, and the access policies that apply to them over the dataset (which policy, which revision, what row and column
   * rules). A file is given again only under the same scope, so a policy that was replaced or tightened since the file was made is not served the file of the old one. No policy at all is a fingerprint of its own.
   */
  async exportScopeHash(tx: Tx, membershipId: string, access: EffectiveAccess, datasetId: string, now: Date): Promise<string> {
    const requester = await this.queries.requesterOf(tx, membershipId);
    const applicable = await this.policies.applicable(tx, datasetId, { membershipId, ...requester }).catch((error: unknown) => {
      if (error instanceof DomainError && error.code === 'ACCESS_POLICY_MISSING') return [];
      throw error;
    });
    const policies = applicable.map((policy) => ({ id: policy.id, revision: policy.revision, predicate: policy.rowPredicate, masks: policy.columnMasks })).sort((a, b) => a.id.localeCompare(b.id));
    const fingerprint = createHash('sha256').update(canonicalJson(policies)).digest('hex');
    return biScopeHash({
      membershipId,
      scopeVersion: access.scopeVersion,
      grants: `${homeScopeFingerprint(access, QUERY_PERMISSION, now)}|${homeScopeFingerprint(access, EXPORT_PERMISSION, now)}|${fingerprint}`,
    });
  }

  assertDimensions(read: Reading, fields: readonly string[]): void {
    for (const field of fields) if (!read.allowedDimensions.includes(field)) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, field);
  }

  /** What a question is kept under: the tenant, the metric, the snapshot, the query and the scope of the reader (the key of the cache), and its digest, which is how the log and the jobs name it. */
  keyOf(read: Reading, dimension: string | undefined, filters: readonly QueryFilter[], tenantId: string): { key: string; digest: string } {
    const key = queryCacheKey({
      tenantId,
      metricVersionIds: [read.metricId],
      filtersHash: createHash('sha256')
        .update(canonicalJson({ dimension: dimension ?? null, filters, policies: read.policies }))
        .digest('hex'),
      snapshotId: read.version.datasetVersionId,
      scopeHash: read.scopeHash,
    });
    return { key, digest: createHash('sha256').update(key).digest('hex') };
  }

  /** What the query costs (the lines it reads times the groups it makes) and whether that is more than a request may wait for. */
  costOf(read: Reading, dimension: string | undefined): { cost: number; heavy: boolean } {
    const cost = estimateQueryCost({ snapshotRows: read.version.sourceRows, dimension });
    return { cost, heavy: isHeavyQuery(cost, this.syncCostLimit) };
  }

  /** Whether the same reader asked the same thing a moment ago and the answer is still at hand. */
  isCached(key: string, now: Date): boolean {
    return this.cache.get<Answer>(key, now) !== undefined;
  }

  /** The groups and the total, from the cache when the same reader asked the same thing of the same snapshot a moment ago. */
  async answer(tx: Tx, read: Reading, dimension: string | undefined, filters: readonly QueryFilter[], access: EffectiveAccess, now: Date, tenantId: string): Promise<Answer & { fromCache: boolean }> {
    const { key } = this.keyOf(read, dimension, filters, tenantId);
    const cached = this.cache.get<Answer>(key, now);
    if (cached !== undefined) return { ...(cached as Answer), fromCache: true };
    const fresh = await this.compute(tx, read, dimension, filters, access, now);
    this.cache.set(key, fresh, now);
    return { ...fresh, fromCache: false };
  }

  /** The groups and the total, read from the snapshot now (never from the cache): what a job of a heavy query makes. */
  async compute(tx: Tx, read: Reading, dimension: string | undefined, filters: readonly QueryFilter[], access: EffectiveAccess, now: Date): Promise<Answer> {
    const projects = projectScope(access, QUERY_PERMISSION, now);
    const common = { adapter: read.adapter, snapshotId: read.version.sourceSnapshotId, plan: read.plan, filters, projects, policies: read.policies };
    // A measure of two stages is read from its groups: the dimension is what the groups are, and the total is the second stage over them.
    if (read.plan.twoStage !== undefined) {
      if (dimension === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dimension');
      const staged = await this.queries.aggregateTwoStage(tx, { ...common, dimension });
      return { rows: staged.groups.slice(0, this.queries.maxRows), total: staged.total, truncated: staged.groups.length > this.queries.maxRows, builtAt: now.toISOString() };
    }
    const grouped = dimension === undefined ? [] : await this.queries.aggregate(tx, { ...common, dimension });
    const total = (await this.queries.aggregate(tx, common))[0] ?? emptySums();
    const truncated = grouped.length > this.queries.maxRows;
    return { rows: grouped.slice(0, this.queries.maxRows), total, truncated, builtAt: now.toISOString() };
  }

  /** The projects a person may export: those they may query and those they may export, both (a right to export over one unit does not export what the right to query reaches elsewhere). */
  exportableProjects(access: EffectiveAccess, now: Date): ScopeBuilder {
    const query = projectScope(access, QUERY_PERMISSION, now);
    const exporting = projectScope(access, EXPORT_PERMISSION, now);
    return (first: number) => {
      const left = query(first);
      if (left.sql === 'true') return exporting(first);
      const right = exporting(first + left.params.length);
      return right.sql === 'true' ? left : { sql: `(${left.sql}) and (${right.sql})`, params: [...left.params, ...right.params] };
    };
  }

  /** Every group of the answer up to `cap` (an export is not the page of a screen, and never comes from the cache); one more than the cap comes back when there are more. */
  async answerAll(tx: Tx, read: Reading, dimension: string | undefined, filters: readonly QueryFilter[], access: EffectiveAccess, now: Date, cap: number): Promise<Answer> {
    const projects = this.exportableProjects(access, now);
    const common = { adapter: read.adapter, snapshotId: read.version.sourceSnapshotId, plan: read.plan, filters, projects, policies: read.policies };
    if (read.plan.twoStage !== undefined) {
      if (dimension === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dimension');
      const staged = await this.queries.aggregateTwoStage(tx, { ...common, dimension, limit: cap + 1 });
      return { rows: staged.groups, total: staged.total, truncated: staged.groups.length > cap, builtAt: now.toISOString() };
    }
    const grouped = dimension === undefined ? [] : await this.queries.aggregate(tx, { ...common, dimension, limit: cap + 1 });
    const total = (await this.queries.aggregate(tx, common))[0] ?? emptySums();
    return { rows: grouped, total, truncated: grouped.length > cap, builtAt: now.toISOString() };
  }

  /**
   * The metric over several periods (R16, CA-1): one point per period asked, each the figure of the frozen version of that period under the same scope and policies as a single query (so a point and the period asked
   * alone are one number), a gap with no figure for a period that has no frozen version. For a measure of two stages the dimension is what the groups are and each point is the second stage of its period; for any
   * other measure a dimension adds the groups of each period. Not cached: a series is read from the periods as they are frozen now.
   */
  async series(
    tx: Tx,
    read: Reading,
    periods: readonly string[],
    dimension: string | undefined,
    filters: readonly QueryFilter[],
    access: EffectiveAccess,
    now: Date,
  ): Promise<{ points: SeriesPoint[]; groups: Array<{ period: string; rows: AggregateRow[] }>; builtAt: string }> {
    if (!read.adapter.capabilities.periodSeries) throw new DomainError('VALIDATION_FAILED', 422, 'periods');
    const versions = await this.queries.frozenVersionsOfPeriods(tx, read.adapter.code, periods);
    const projects = projectScope(access, QUERY_PERMISSION, now);
    const common = { adapter: read.adapter, snapshotIds: versions.map((version) => version.sourceSnapshotId), plan: read.plan, filters, projects, policies: read.policies };
    const staged = read.plan.twoStage !== undefined;
    if (staged && dimension === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dimension');
    const totals = await this.queries.aggregateSeries(tx, staged ? { ...common, dimension } : common);
    const sums = new Map<string, GroupSums>(totals.map((row) => [row.snapshotId, row.sums]));
    const groups: Array<{ period: string; rows: AggregateRow[] }> = [];
    if (!staged && dimension !== undefined) {
      const cut = await this.queries.aggregateSeries(tx, { ...common, dimension });
      for (const version of versions) groups.push({ period: version.period, rows: cut.filter((row) => row.snapshotId === version.sourceSnapshotId).map((row) => row.sums) });
    }
    return { points: assembleSeries(read.plan, periods, versions, sums), groups, builtAt: now.toISOString() };
  }
}
