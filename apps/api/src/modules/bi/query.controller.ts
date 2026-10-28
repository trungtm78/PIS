import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, BiMetricStore, BiPolicyStore, BiQueryStore, TenantDatabase, projectScope, scopePredicate } from '@machvon/db';
import type { AggregateRow, QueryFilter, SnapshotVersion } from '@machvon/db';
import {
  BI_DRILL_TTL_SECONDS,
  DISBURSEMENT_DIMENSIONS,
  DISBURSEMENT_FIELDS,
  DomainError,
  asUuid,
  biScopeHash,
  canonicalJson,
  expiredBiDrill,
  feedsCertified,
  figureOf,
  hiddenColumns,
  homeScopeFingerprint,
  measurePlanOf,
  parseBiDrill,
  queryCacheKey,
  reconcile,
  signBiDrill,
} from '@machvon/kernel';
import type { BiDrillClaims, EffectiveAccess, MeasurePlan, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { BiQueryCache } from './query-cache';
import { BI_CLOCK, BI_DRILL_KEY } from './tokens';

const QUERY_PERMISSION = PERMISSIONS.post_dashboard_queries;
const DATASET_CODE = 'DS-DISB';
const KEY_ID = '1';
const RESOURCE_TYPE = 'bi_query';
/** How many rows of an answer carry a token to go on from: the page the screen draws. */
const TOKEN_ROWS = 100;
const FILTER_FIELDS = new Set(Object.keys(DISBURSEMENT_DIMENSIONS));

type Row = Record<string, unknown>;

interface Answer {
  rows: AggregateRow[];
  total: AggregateRow;
  truncated: boolean;
  builtAt: string;
}

const emptySums = (): AggregateRow => ({ key: null, label: null, numerator: null, denominator: null, distinct: null });

/** The reading of a snapshot under one metric, one dimension and a scope: the same code for the first query and for the drill that follows it. */
interface Reading {
  plan: MeasurePlan;
  metricId: string;
  metricCode: string;
  unit: string;
  aggregationType: string;
  version: SnapshotVersion;
  scopeHash: string;
  fullTenant: boolean;
  policies: Row[];
  allowedDimensions: string[];
}

/**
 * The queries of BI and the drill under them (ST-BI-004, BI F3, F4): a metric over a frozen snapshot of a period, cut by one dimension of its dataset, the figures from sums (a ratio from the sums of its numerator and
 * denominator), each group with a token to go down one more level. The server writes the SQL from allowlists; a snapshot is kept for the whole path (a newer one only raises a banner); the right to read is judged again
 * on every step as it is now (a unit the reader lost is 403 SCOPE_DENIED and names nothing); a dataset that no active policy covers is refused (never answered empty); a token that was altered, of another tenant
 * or of another member is 400 DRILL_TOKEN_INVALID and is recorded. An answer is cached under a key that has the tenant, the snapshot, the query and the scope in it.
 */
@Controller()
export class BiQueryController {
  private readonly metrics = new BiMetricStore();
  private readonly queries = new BiQueryStore();
  private readonly policies = new BiPolicyStore();
  private readonly audit: AuditWriter;
  private readonly cache = new BiQueryCache();
  private readonly clock: () => Date;
  private readonly key: Buffer;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(BI_CLOCK) clock?: () => Date,
    @Optional() @Inject(BI_DRILL_KEY) key?: Buffer,
  ) {
    this.audit = new AuditWriter(database);
    this.clock = clock ?? ((): Date => new Date());
    this.key = key ?? randomBytes(32);
  }

  // ---- the query ---------------------------------------------------------------------------------------------------------------------------

  @Post('dashboard-queries')
  @HttpCode(200)
  @OperationId('post_dashboard_queries')
  @Command({ operation: 'post_dashboard_queries' })
  async query(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DrillQuery']): Promise<Row> {
    const started = Date.now();
    const now = this.clock();
    const { tenant, tx } = scope;
    const snapshotId = asUuid(body.snapshot_id);
    const metricId = asUuid(body.metric_version_id);
    if (snapshotId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'snapshot_id');
    if (metricId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'metric_version_id');
    if (body.dimensions.length > 1) throw new DomainError('VALIDATION_FAILED', 422, 'dimensions');
    const dimension = body.dimensions[0];
    // A drill continues from a context the reader made; its filters are the ones it was cut by, and its snapshot is the one kept.
    let base: QueryFilter[] = [];
    let parent: string | null = null;
    let path: string[] = [];
    if (body.context_token !== undefined) {
      const opened = await this.contextOf(tenant, tx, body.context_token, now).then(
        (value) => ({ value }),
        (error: unknown) => {
          if (error instanceof DomainError && error.code === 'DRILL_TOKEN_INVALID') return { rejected: error };
          throw error;
        },
      );
      if ('rejected' in opened) return this.refusedToken(scope, 'bi.query_denied', 'context');
      const context = opened.value;
      if (context.row.snapshotId !== snapshotId || context.row.metricVersionId !== metricId) throw new DomainError('VALIDATION_FAILED', 422, 'context_token');
      base = context.row.filters;
      parent = context.row.id;
      path = context.row.dimensionPath;
    }
    const filters = [...base, ...body.filters.map((filter): QueryFilter => ({ field: filter.field, operator: filter.operator, value: filter.value }))];
    for (const filter of filters) if (!FILTER_FIELDS.has(filter.field)) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, filter.field);
    const reading = await this.reading(tx, tenant, access, metricId, snapshotId, now, body.context_token !== undefined);
    if (reading.denied !== undefined) return this.refused(scope, reading.denied, started);
    const { value: read } = reading;
    // A context that is continued is judged as the drill judges it: a unit the path names that the reader no longer reads is a refusal, not an empty figure.
    if (base.length > 0 && (await this.pathRevoked(tx, access, read, base, now))) return this.refused(scope, 'SCOPE_DENIED', started);
    this.assertDimensions(read, [...(dimension === undefined ? [] : [dimension]), ...filters.map((filter) => filter.field)]);
    const answer = await this.answer(tx, read, dimension, filters, access, now, tenant.tenantId);
    const nextPath = dimension === undefined || path.includes(dimension) ? path : [...path, dimension];
    const contextId = await this.queries.insertContext(tx, { metricVersionId: metricId, snapshotId, asOfPeriod: read.version.periodCode, scopeHash: read.scopeHash, filters, dimensionPath: nextPath, unit: read.unit, parentContextId: parent, createdBy: tenant.membershipId, ttlSeconds: BI_DRILL_TTL_SECONDS });
    const rows = await this.shape(tx, read, answer, dimension, filters, nextPath, contextId, tenant);
    await this.queries.recordRun(tx, { requestedBy: tenant.membershipId, metricVersionIds: [metricId], asOfPeriod: read.version.periodCode, datasetVersionId: read.version.datasetVersionId, scopeHash: read.scopeHash, drillContextId: contextId, status: 'COMPLETED', servedFromCache: answer.fromCache, durationMs: Date.now() - started, rowCount: rows.length, errorCode: null });
    await scope.audit({ action: 'bi.query_run', resourceType: RESOURCE_TYPE, resourceId: contextId, diff: { metric_version_id: metricId, snapshot_id: snapshotId, as_of_period: read.version.periodCode, dimension: dimension ?? null, rows: rows.length, served_from_cache: answer.fromCache } });
    return { ...commandResult(scope, 'COMPLETED', 1, contextId), ...this.envelope(read, answer, dimension, rows, contextId, tenant) };
  }

  // ---- the drill ---------------------------------------------------------------------------------------------------------------------------

  @Get('bi/drill')
  @OperationId('explainBiMetric')
  async explain(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('drill_token') drillToken?: unknown,
    @Query('child_dimension') childDimension?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Row> {
    if (typeof drillToken !== 'string' || drillToken === '') return this.deniedToken(tenant, undefined, 'missing');
    if (typeof childDimension !== 'string' || !FILTER_FIELDS.has(childDimension)) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, 'child_dimension');
    const shown = Math.min(Math.max(Number.parseInt(String(limit ?? '100'), 10) || 100, 1), 200);
    const started = Date.now();
    const now = this.clock();
    const claims = await this.claimsOrDenied(tenant, drillToken);
    // A token is the member's own, of this tenant: another's is not valid, old or not, and nothing more is said of it.
    if (claims.tid !== tenant.tenantId) return this.deniedToken(tenant, claims, 'tenant');
    const done = await this.database.withTenant(tenant, async (tx) => {
      // A token that is not the reader's own, or names a context that is gone, is refused after the transaction: the refusal is recorded outside it.
      const opened = await this.contextOf(tenant, tx, drillToken, now, claims).then(
        (value) => ({ value }),
        (error: unknown) => {
          if (error instanceof DomainError && error.code === 'DRILL_TOKEN_INVALID') return { rejected: error };
          throw error;
        },
      );
      if ('rejected' in opened) return { rejected: opened.rejected };
      const context = opened.value;
      const reading = await this.reading(tx, tenant, access, context.row.metricVersionId, context.row.snapshotId, now, true);
      if (reading.denied !== undefined) return { denied: reading.denied, context };
      const { value: read } = reading;
      // The snapshot of the path is kept, and the right to read is judged again at every unit the path names, as it is now.
      if (await this.pathRevoked(tx, access, read, context.row.filters, now)) return { denied: 'SCOPE_DENIED' as const, context };
      // The dimensions the path was cut by are judged again as well: a policy that hides one since the token was made closes the way on through it.
      this.assertDimensions(read, [childDimension, ...context.row.filters.map((filter) => filter.field)]);
      if (context.row.dimensionPath.includes(childDimension)) throw new DomainError('VALIDATION_FAILED', 422, 'child_dimension');
      const answer = await this.answer(tx, read, childDimension, context.row.filters, access, now, tenant.tenantId);
      const path = [...context.row.dimensionPath, childDimension];
      const contextId = await this.queries.insertContext(tx, { metricVersionId: context.row.metricVersionId, snapshotId: context.row.snapshotId, asOfPeriod: context.row.asOfPeriod, scopeHash: read.scopeHash, filters: context.row.filters, dimensionPath: path, unit: read.unit, parentContextId: context.row.id, createdBy: tenant.membershipId, ttlSeconds: BI_DRILL_TTL_SECONDS });
      const rows = await this.shape(tx, read, answer, childDimension, context.row.filters, path, contextId, tenant, shown, shown);
      await this.queries.recordRun(tx, { requestedBy: tenant.membershipId, metricVersionIds: [context.row.metricVersionId], asOfPeriod: read.version.periodCode, datasetVersionId: read.version.datasetVersionId, scopeHash: read.scopeHash, drillContextId: contextId, status: 'COMPLETED', servedFromCache: answer.fromCache, durationMs: Date.now() - started, rowCount: rows.length, errorCode: null });
      return { denied: undefined, read, answer, rows, contextId, context };
    });
    if ('rejected' in done) return this.deniedToken(tenant, claims, 'context');
    if (done.denied !== undefined) {
      // Nothing of the place is told: the refusal is recorded without a name.
      await this.audit.recordDenied(tenant, { action: 'bi.drill_denied', resourceType: RESOURCE_TYPE, resourceId: done.context.row.id, diff: { code: done.denied, snapshot_id: done.context.row.snapshotId }, correlationId: randomUUID(), requestId: randomUUID() });
      throw new DomainError(done.denied, 403);
    }
    return {
      ...this.envelope(done.read, done.answer, childDimension, done.rows, done.contextId, tenant),
      // The children are cut at the limit asked, and the answer says so (the sum of the children in view is then not the parent).
      truncated: done.answer.truncated || done.answer.rows.length > shown,
      parent_context_id: done.context.row.id,
      // A token made under another scope is still read over the scope the reader has now; the screen is told, so that it offers a new reading.
      scope_changed: done.context.row.scopeHash !== done.read.scopeHash,
    };
  }

  // ---- a new context on the newest snapshot ------------------------------------------------------------------------------------------------

  @Post('bi/query-contexts/refresh')
  @HttpCode(200)
  @OperationId('refreshBiQueryContext')
  @Command({ operation: 'refreshBiQueryContext' })
  async refresh(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BiContextRefresh']): Promise<Row> {
    const now = this.clock();
    const { tenant, tx } = scope;
    let claims: BiDrillClaims;
    try {
      claims = this.claimsOf(body.drill_token);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return this.refusedToken(scope, 'bi.drill_refresh_denied', 'unreadable', error);
    }
    if (claims.tid !== tenant.tenantId) return this.refusedToken(scope, 'bi.drill_refresh_denied', 'tenant');
    // An old token may be renewed (that is what it is for); one that is not the member's own is not.
    const old = await this.queries.findContext(tx, claims.ctx_id);
    if (old === undefined || old.createdBy !== tenant.membershipId) return this.refusedToken(scope, 'bi.drill_refresh_denied', 'context');
    const latest = await this.queries.latestSnapshotOfPeriod(tx, old.asOfPeriod);
    if (latest === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 422);
    const reading = await this.reading(tx, tenant, access, old.metricVersionId, latest, now, true);
    if (reading.denied !== undefined) throw new DomainError(reading.denied, 403);
    const { value: read } = reading;
    const id = await this.queries.insertContext(tx, { metricVersionId: old.metricVersionId, snapshotId: latest, asOfPeriod: old.asOfPeriod, scopeHash: read.scopeHash, filters: old.filters, dimensionPath: old.dimensionPath, unit: read.unit, parentContextId: old.id, createdBy: tenant.membershipId, ttlSeconds: BI_DRILL_TTL_SECONDS });
    await scope.audit({ action: 'bi.query_context_refreshed', resourceType: RESOURCE_TYPE, resourceId: id, diff: { parent_context_id: old.id, from_snapshot_id: old.snapshotId, to_snapshot_id: latest, as_of_period: old.asOfPeriod } });
    return { ...commandResult(scope, 'CREATED', 1, id), drill_token: this.mint(tenant, id, read, old.asOfPeriod, latest), snapshot_id: latest, as_of_period: old.asOfPeriod, parent_context_id: old.id };
  }

  // ---- the contexts of the reader ----------------------------------------------------------------------------------------------------------

  @Get('resources/drill_context')
  @OperationId('get_resources_drill_context')
  async contexts(@CurrentTenant() tenant: TenantContext): Promise<{ items: Row[]; next_cursor: null }> {
    const rows = await this.database.withTenant(tenant, (tx) => this.queries.contextsOf(tx, tenant.membershipId, 100));
    return { items: rows.map(contextView), next_cursor: null };
  }

  @Get('resources/drill_context/:id')
  @OperationId('get_resources_drill_context_id')
  async oneContext(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Row> {
    const row = await this.database.withTenant(tenant, (tx) => this.queries.findContext(tx, id));
    // A context is its maker's: another member's is not told apart from one that does not exist.
    if (row === undefined || row.createdBy !== tenant.membershipId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return contextView(row);
  }

  // ---- shared steps ------------------------------------------------------------------------------------------------------------------------

  private claimsOf(token: string): BiDrillClaims {
    return parseBiDrill(token, this.key);
  }

  /** A token that cannot be read (altered, of another key, not one) is refused and recorded as denied, without saying why. */
  private async claimsOrDenied(tenant: TenantContext, token: string): Promise<BiDrillClaims> {
    try {
      return this.claimsOf(token);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'DRILL_TOKEN_INVALID') return this.deniedToken(tenant, undefined, 'unreadable');
      throw error;
    }
  }

  /** The context a token names, if the token is the reader's own and still good; otherwise the refusal (and the record of it). */
  private async contextOf(tenant: TenantContext, tx: Parameters<BiQueryStore['findContext']>[0], token: string, now: Date, parsed?: BiDrillClaims): Promise<{ claims: BiDrillClaims; row: NonNullable<Awaited<ReturnType<BiQueryStore['findContext']>>> }> {
    const claims = parsed ?? this.claimsOf(token);
    if (claims.tid !== tenant.tenantId) throw new DomainError('DRILL_TOKEN_INVALID', 400);
    const row = await this.queries.findContext(tx, claims.ctx_id);
    if (row === undefined || row.createdBy !== tenant.membershipId || row.snapshotId !== claims.snapshot_id || row.metricVersionId !== claims.metric_version_id) throw new DomainError('DRILL_TOKEN_INVALID', 400);
    if (claims.exp <= Math.floor(now.getTime() / 1000)) throw expiredBiDrill(claims);
    return { claims, row };
  }

  /** A token of another tenant: refused as any bad token, and recorded in the tenant of the session (the token's tenant is not told anything). */
  private async deniedToken(tenant: TenantContext, claims: BiDrillClaims | undefined, reason: string): Promise<never> {
    await this.audit.recordDenied(tenant, { action: 'bi.drill_denied', resourceType: RESOURCE_TYPE, resourceId: tenant.tenantId, diff: { code: 'DRILL_TOKEN_INVALID', reason, ...(claims === undefined ? {} : { metric_version_id: claims.metric_version_id }) }, correlationId: randomUUID(), requestId: randomUUID() });
    throw new DomainError('DRILL_TOKEN_INVALID', 400);
  }

  /** The metric, the snapshot, the quality of its version, the scope of the reader and the policies that apply to them; or the refusal. */
  private async reading(
    tx: Parameters<BiQueryStore['findContext']>[0],
    tenant: TenantContext,
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
    const plan = measurePlanOf({ aggregationType: metric.aggregationType as never, expressionAst: metric.expressionAst, numeratorAst: metric.numeratorAst, denominatorAst: metric.denominatorAst, nullPolicy: metric.nullPolicy as never });
    const version = await this.queries.versionOfSnapshot(tx, DATASET_CODE, snapshotId);
    if (version === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 422, 'snapshot_id');
    const requester = await this.queries.requesterOf(tx, tenant.membershipId);
    let applicable;
    try {
      applicable = await this.policies.applicable(tx, version.datasetId, { membershipId: tenant.membershipId, ...requester });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ACCESS_POLICY_MISSING') return { denied: 'ACCESS_POLICY_MISSING' };
      throw error;
    }
    const hidden = hiddenColumns(applicable);
    const closed = new Set([...hidden.hidden, ...hidden.masked]);
    // A column is known by the name of its dimension, by its name in the table and by the names of the fields that read it.
    const aliasesOf = (column: string): string[] => [
      column,
      ...Object.entries(DISBURSEMENT_FIELDS).filter(([, mapped]) => mapped === column).map(([field]) => field),
      ...Object.entries(DISBURSEMENT_DIMENSIONS).filter(([, dimension]) => dimension.column === column).map(([name]) => name),
    ];
    // A column a policy hides or masks is not summed either: the figure of a metric over it would give the column away to a filter that narrows to one row.
    for (const column of [plan.numeratorColumn, plan.denominatorColumn]) {
      if (column === null) continue;
      const restricted = aliasesOf(column).find((alias) => closed.has(alias));
      if (restricted !== undefined) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, restricted);
    }
    const scopeHash = biScopeHash({ membershipId: tenant.membershipId, scopeVersion: access.scopeVersion, grants: homeScopeFingerprint(access, QUERY_PERMISSION, now) });
    return {
      value: {
        plan,
        metricId: metric.id,
        metricCode: metric.code,
        unit: metric.unit,
        aggregationType: metric.aggregationType,
        version,
        scopeHash,
        fullTenant: projectScope(access, QUERY_PERMISSION, now)(1).sql === 'true',
        policies: applicable.map((policy) => policy.rowPredicate),
        allowedDimensions: Object.entries(DISBURSEMENT_DIMENSIONS)
          .filter(([name, dimension]) => !closed.has(name) && !aliasesOf(dimension.column).some((alias) => closed.has(alias)))
          .map(([name]) => name),
      },
    };
  }

  private assertDimensions(read: Reading, fields: readonly string[]): void {
    for (const field of fields) if (!read.allowedDimensions.includes(field)) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, field);
  }

  /** The groups and the total, from the cache when the same reader asked the same thing of the same snapshot a moment ago. */
  private async answer(tx: Parameters<BiQueryStore['findContext']>[0], read: Reading, dimension: string | undefined, filters: readonly QueryFilter[], access: EffectiveAccess, now: Date, tenantId: string): Promise<Answer & { fromCache: boolean }> {
    const key = queryCacheKey({
      tenantId,
      metricVersionIds: [read.metricId],
      filtersHash: createHash('sha256').update(canonicalJson({ dimension: dimension ?? null, filters, policies: read.policies })).digest('hex'),
      snapshotId: read.version.datasetVersionId,
      scopeHash: read.scopeHash,
    });
    const cached = this.cache.get<Answer>(key, now);
    if (cached !== undefined) return { ...(cached as Answer), fromCache: true };
    const projects = projectScope(access, QUERY_PERMISSION, now);
    const common = { snapshotId: read.version.sourceSnapshotId, plan: read.plan, filters, projects, policies: read.policies };
    const grouped = dimension === undefined ? [] : await this.queries.aggregate(tx, { ...common, dimension });
    const total = (await this.queries.aggregate(tx, common))[0] ?? emptySums();
    const truncated = grouped.length > this.queries.maxRows;
    const fresh: Answer = { rows: grouped.slice(0, this.queries.maxRows), total, truncated, builtAt: now.toISOString() };
    this.cache.set(key, fresh, now);
    return { ...fresh, fromCache: false };
  }

  private mint(tenant: TenantContext, contextId: string, read: Reading, asOfPeriod: string, snapshotId: string): string {
    return signBiDrill({ tid: tenant.tenantId, ctx_id: contextId, scope_hash: read.scopeHash, metric_version_id: read.metricId, snapshot_id: snapshotId, as_of_period: asOfPeriod }, this.key, KEY_ID, () => Math.floor(this.clock().getTime() / 1000));
  }

  /** The rows of an answer, each with its figure and, for the first page, a token for the way down: the group as one more filter of the path. */
  private async shape(
    tx: Parameters<BiQueryStore['findContext']>[0],
    read: Reading,
    answer: Answer,
    dimension: string | undefined,
    filters: readonly QueryFilter[],
    path: readonly string[],
    contextId: string,
    tenant: TenantContext,
    tokens: number = TOKEN_ROWS,
    limit: number = answer.rows.length,
  ): Promise<Row[]> {
    void contextId;
    const rows: Row[] = [];
    for (const [index, group] of answer.rows.slice(0, limit).entries()) {
      const figure = figureOf(read.plan, group);
      let token: string | null = null;
      if (dimension !== undefined && group.key !== null && index < tokens) {
        const child = await this.queries.insertContext(tx, { metricVersionId: read.metricId, snapshotId: read.version.datasetVersionId, asOfPeriod: read.version.periodCode, scopeHash: read.scopeHash, filters: [...filters, { field: dimension, operator: 'eq', value: group.key }], dimensionPath: path, unit: read.unit, parentContextId: contextId, createdBy: tenant.membershipId, ttlSeconds: BI_DRILL_TTL_SECONDS });
        token = this.mint(tenant, child, read, read.version.periodCode, read.version.datasetVersionId);
      }
      rows.push({ key: group.key, label: group.label ?? group.key, unclassified: group.key === null, value: figure.value, numerator: figure.numerator, denominator: figure.denominator, null_reason: figure.nullReason, drill_token: token });
    }
    return rows;
  }

  private envelope(read: Reading, answer: Answer & { fromCache: boolean }, dimension: string | undefined, rows: Row[], contextId: string, tenant: TenantContext): Row {
    const total = figureOf(read.plan, answer.total);
    const reconciliation = dimension === undefined ? { reconcilesToParent: true, nonAdditiveReason: null } : reconcile(read.plan, answer.rows, answer.total);
    return {
      metric: { id: read.metricId, code: read.metricCode, unit: read.unit, aggregation_type: read.aggregationType },
      metric_version_id: read.metricId,
      // The shape the contract names (BiDrillExplanation): the formula by the columns it adds up, the parent's figures, and the children.
      formula: { kind: read.plan.kind, numerator_column: read.plan.numeratorColumn, denominator_column: read.plan.denominatorColumn },
      numerator: total.numerator ?? total.value ?? '',
      ...(total.denominator === null ? {} : { denominator: total.denominator }),
      ...(total.nullReason === null ? {} : { null_reason: total.nullReason }),
      as_of_period: read.version.periodCode,
      snapshot_id: read.version.datasetVersionId,
      source_snapshot_id: read.version.sourceSnapshotId,
      quality_badge: read.version.qualityBadge,
      excluded_quarantine_rows: read.version.excludedQuarantineRows,
      feeds_certified: feedsCertified(read.version.qualityBadge as never),
      new_data_available: read.version.newerSnapshotId !== null,
      newer_snapshot_id: read.version.newerSnapshotId,
      scope: { label: read.fullTenant ? 'FULL_TENANT' : 'YOUR_SCOPE', full_tenant: read.fullTenant },
      scope_hash: read.scopeHash,
      served_from_cache: answer.fromCache,
      built_at: answer.builtAt,
      dimension: dimension ?? null,
      total: { value: total.value, numerator: total.numerator, denominator: total.denominator, null_reason: total.nullReason },
      reconciles_to_parent: reconciliation.reconcilesToParent,
      non_additive_reason: reconciliation.nonAdditiveReason,
      truncated: answer.truncated,
      children: rows,
      drill_token: this.mint(tenant, contextId, read, read.version.periodCode, read.version.datasetVersionId),
    };
  }

  /** Whether the reader no longer reads a unit the path was cut by (as it is now); the same judgment for the drill and for a query that continues a context. */
  private async pathRevoked(tx: Parameters<BiQueryStore['findContext']>[0], access: EffectiveAccess, read: Reading, filters: readonly QueryFilter[], now: Date): Promise<boolean> {
    const projects = projectScope(access, QUERY_PERMISSION, now);
    const units = (first: number) => scopePredicate(access, QUERY_PERMISSION, now, { unitPath: 'u.path', unitId: 'u.id' }, first);
    for (const filter of filters) {
      if (filter.field === 'unit' && filter.operator === 'eq' && !(await this.queries.unitStillReadable(tx, read.version.sourceSnapshotId, String(filter.value), projects, units))) return true;
    }
    return false;
  }

  /** A token that is not the reader's own (or cannot be read) on a command: the refusal is recorded with its audit, and the answer is the same 400 for the same key; nothing is said of what exists. */
  private async refusedToken(scope: CommandScope, action: string, reason: string, error: DomainError = new DomainError('DRILL_TOKEN_INVALID', 400)): Promise<Row> {
    await scope.audit({ action, resourceType: RESOURCE_TYPE, resourceId: scope.tenant.membershipId, diff: { code: error.code, reason } });
    scope.refuseAfterCommit(error);
    return { ...commandResult(scope, 'DENIED', 1, scope.tenant.membershipId) };
  }

  /** A refusal that is a record: the run is kept as DENIED with the audit of it, and the answer is the refusal (the same key gets it again). */
  private async refused(scope: CommandScope, code: 'ACCESS_POLICY_MISSING' | 'SCOPE_DENIED', started: number): Promise<Row> {
    await scope.audit({ action: 'bi.query_denied', resourceType: RESOURCE_TYPE, resourceId: scope.tenant.membershipId, diff: { code, duration_ms: Date.now() - started } });
    scope.refuseAfterCommit(new DomainError(code, 403));
    return { ...commandResult(scope, 'DENIED', 1, scope.tenant.membershipId) };
  }
}

function contextView(row: NonNullable<Awaited<ReturnType<BiQueryStore['findContext']>>>): Row {
  return { id: row.id, metric_version_id: row.metricVersionId, snapshot_id: row.snapshotId, as_of_period: row.asOfPeriod, dimension_path: row.dimensionPath, expires_at: row.expiresAt, parent_context_id: row.parentContextId };
}
