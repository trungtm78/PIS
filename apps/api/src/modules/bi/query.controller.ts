import { randomBytes, randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuditWriter, BiLineageStore, BiMetricStore, BiQueryJobStore, BiQueryStore, TenantDatabase, projectScope, scopePredicate } from '@machvon/db';
import type { QueryFilter } from '@machvon/db';
import { BI_DRILL_TTL_SECONDS, DomainError, asUuid, expiredBiDrill, feedsCertified, figureOf, parseBiDrill, reconcile, signBiDrill } from '@machvon/kernel';
import type { BiDrillClaims, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { BiQueryCache } from './query-cache';
import { BiQueryEngine, DATASET_CODE, FILTER_FIELDS, QUERY_PERMISSION } from './query-engine';
import type { Answer, Reading } from './query-engine';
import { specOf } from './query-jobs';
import { BI_CLOCK, BI_DRILL_KEY, BI_QUERY_COST_LIMIT } from './tokens';

const KEY_ID = '1';
const RESOURCE_TYPE = 'bi_query';
/** How many rows of an answer carry a token to go on from: the page the screen draws. */
const TOKEN_ROWS = 100;
type Row = Record<string, unknown>;

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
  private readonly jobs = new BiQueryJobStore();
  private readonly lineage = new BiLineageStore();
  private readonly engine: BiQueryEngine;
  private readonly audit: AuditWriter;
  private readonly clock: () => Date;
  private readonly key: Buffer;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(BI_CLOCK) clock?: () => Date,
    @Optional() @Inject(BI_DRILL_KEY) key?: Buffer,
    @Optional() @Inject(BI_QUERY_COST_LIMIT) costLimit?: number,
  ) {
    this.audit = new AuditWriter(database);
    this.engine = new BiQueryEngine(new BiQueryCache(), costLimit);
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
    const reading = await this.engine.read(tx, tenant.membershipId, access, metricId, snapshotId, now, body.context_token !== undefined);
    if (reading.denied !== undefined) return this.refused(scope, reading.denied, started);
    const { value: read } = reading;
    // A context that is continued is judged as the drill judges it: a unit the path names that the reader no longer reads is a refusal, not an empty figure.
    if (base.length > 0 && (await this.pathRevoked(tx, access, read, base, now))) return this.refused(scope, 'SCOPE_DENIED', started);
    this.engine.assertDimensions(read, [...(dimension === undefined ? [] : [dimension]), ...filters.map((filter) => filter.field)]);
    // A question a job answered a moment ago is answered from it; one too heavy to wait for becomes a job (one at a time for the same question of the same reader) and the answer is 202.
    const keyed = this.engine.keyOf(read, dimension, filters, tenant.tenantId);
    let kept = await this.jobs.answerOf(tx, keyed.digest, now);
    if (kept === undefined && !this.engine.isCached(keyed.key, now)) {
      const { cost, heavy } = this.engine.costOf(read, dimension);
      if (heavy) {
        const reply = await this.queued(scope, read, keyed.digest, specOf({ metricId, snapshotId, dimension, filters, pinned: body.context_token !== undefined }), cost, metricId, snapshotId, now);
        if (reply !== undefined) return reply;
        // A job that ended while this request was on its way has its answer kept: it is read now, and the question is answered.
        kept = await this.jobs.answerOf(tx, keyed.digest, now);
      }
    }
    const answer = kept === undefined ? await this.engine.answer(tx, read, dimension, filters, access, now, tenant.tenantId) : { ...(kept as Answer), fromCache: true };
    const nextPath = dimension === undefined || path.includes(dimension) ? path : [...path, dimension];
    const contextId = await this.queries.insertContext(tx, {
      metricVersionId: metricId,
      snapshotId,
      asOfPeriod: read.version.periodCode,
      scopeHash: read.scopeHash,
      filters,
      dimensionPath: nextPath,
      unit: read.unit,
      parentContextId: parent,
      createdBy: tenant.membershipId,
      ttlSeconds: BI_DRILL_TTL_SECONDS,
    });
    const rows = await this.shape(tx, read, answer, dimension, filters, nextPath, contextId, tenant);
    await this.queries.recordRun(tx, {
      requestedBy: tenant.membershipId,
      metricVersionIds: [metricId],
      asOfPeriod: read.version.periodCode,
      datasetVersionId: read.version.datasetVersionId,
      scopeHash: read.scopeHash,
      drillContextId: contextId,
      status: 'COMPLETED',
      servedFromCache: answer.fromCache,
      durationMs: Date.now() - started,
      rowCount: rows.length,
      errorCode: null,
    });
    await this.lineage.metricRead(tx, {
      metricId,
      metricCode: read.metricCode,
      metricRevision: read.metricRevision,
      versionId: read.version.datasetVersionId,
      datasetCode: DATASET_CODE,
      asOfPeriod: read.version.periodCode,
      runId: contextId,
      observedAt: now,
    });
    await scope.audit({
      action: 'bi.query_run',
      resourceType: RESOURCE_TYPE,
      resourceId: contextId,
      diff: { metric_version_id: metricId, snapshot_id: snapshotId, as_of_period: read.version.periodCode, dimension: dimension ?? null, rows: rows.length, served_from_cache: answer.fromCache },
    });
    return { ...commandResult(scope, 'COMPLETED', 1, contextId), ...this.envelope(read, answer, dimension, rows, contextId, tenant) };
  }

  /** The 202 of a query that is a job: its run is in the log as QUEUED, and the same question asked again (by the same reader, under the same scope) is the same job; none when a job of the question ended a moment ago and its answer is kept. */
  private async queued(scope: CommandScope, read: Reading, digest: string, spec: ReturnType<typeof specOf>, cost: number, metricId: string, snapshotId: string, now: Date): Promise<Row | undefined> {
    const job = await this.jobs.enqueue(
      scope.tx,
      {
        requestedBy: scope.tenant.membershipId,
        metricVersionIds: [metricId],
        asOfPeriod: read.version.periodCode,
        datasetVersionId: read.version.datasetVersionId,
        scopeHash: read.scopeHash,
        cacheKey: digest,
        spec,
        estimatedCost: cost,
      },
      now,
    );
    // The job that was there ended before this request could join it: there is nothing to queue, the answer is its own.
    if (job === undefined) return undefined;
    await scope.audit({
      action: 'bi.query_queued',
      resourceType: RESOURCE_TYPE,
      resourceId: job.id,
      diff: { metric_version_id: metricId, snapshot_id: snapshotId, as_of_period: read.version.periodCode, estimated_cost: cost, new_job: job.created },
    });
    scope.respondWith(202);
    return { ...commandResult(scope, 'ASYNC_JOB', 1, job.id), mode: 'ASYNC_JOB', run_id: job.id, estimated_cost: cost, as_of_period: read.version.periodCode, snapshot_id: snapshotId };
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
      const reading = await this.engine.read(tx, tenant.membershipId, access, context.row.metricVersionId, context.row.snapshotId, now, true);
      if (reading.denied !== undefined) return { denied: reading.denied, context };
      const { value: read } = reading;
      // The snapshot of the path is kept, and the right to read is judged again at every unit the path names, as it is now.
      if (await this.pathRevoked(tx, access, read, context.row.filters, now)) return { denied: 'SCOPE_DENIED' as const, context };
      // The dimensions the path was cut by are judged again as well: a policy that hides one since the token was made closes the way on through it.
      this.engine.assertDimensions(read, [childDimension, ...context.row.filters.map((filter) => filter.field)]);
      if (context.row.dimensionPath.includes(childDimension)) throw new DomainError('VALIDATION_FAILED', 422, 'child_dimension');
      const answer = await this.engine.answer(tx, read, childDimension, context.row.filters, access, now, tenant.tenantId);
      const path = [...context.row.dimensionPath, childDimension];
      const contextId = await this.queries.insertContext(tx, {
        metricVersionId: context.row.metricVersionId,
        snapshotId: context.row.snapshotId,
        asOfPeriod: context.row.asOfPeriod,
        scopeHash: read.scopeHash,
        filters: context.row.filters,
        dimensionPath: path,
        unit: read.unit,
        parentContextId: context.row.id,
        createdBy: tenant.membershipId,
        ttlSeconds: BI_DRILL_TTL_SECONDS,
      });
      const rows = await this.shape(tx, read, answer, childDimension, context.row.filters, path, contextId, tenant, shown, shown);
      await this.queries.recordRun(tx, {
        requestedBy: tenant.membershipId,
        metricVersionIds: [context.row.metricVersionId],
        asOfPeriod: read.version.periodCode,
        datasetVersionId: read.version.datasetVersionId,
        scopeHash: read.scopeHash,
        drillContextId: contextId,
        status: 'COMPLETED',
        servedFromCache: answer.fromCache,
        durationMs: Date.now() - started,
        rowCount: rows.length,
        errorCode: null,
      });
      return { denied: undefined, read, answer, rows, contextId, context };
    });
    if ('rejected' in done) return this.deniedToken(tenant, claims, 'context');
    if (done.denied !== undefined) {
      // Nothing of the place is told: the refusal is recorded without a name.
      await this.audit.recordDenied(tenant, {
        action: 'bi.drill_denied',
        resourceType: RESOURCE_TYPE,
        resourceId: done.context.row.id,
        diff: { code: done.denied, snapshot_id: done.context.row.snapshotId },
        correlationId: randomUUID(),
        requestId: randomUUID(),
      });
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
    const reading = await this.engine.read(tx, tenant.membershipId, access, old.metricVersionId, latest, now, true);
    if (reading.denied !== undefined) throw new DomainError(reading.denied, 403);
    const { value: read } = reading;
    const id = await this.queries.insertContext(tx, {
      metricVersionId: old.metricVersionId,
      snapshotId: latest,
      asOfPeriod: old.asOfPeriod,
      scopeHash: read.scopeHash,
      filters: old.filters,
      dimensionPath: old.dimensionPath,
      unit: read.unit,
      parentContextId: old.id,
      createdBy: tenant.membershipId,
      ttlSeconds: BI_DRILL_TTL_SECONDS,
    });
    await scope.audit({
      action: 'bi.query_context_refreshed',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { parent_context_id: old.id, from_snapshot_id: old.snapshotId, to_snapshot_id: latest, as_of_period: old.asOfPeriod },
    });
    return {
      ...commandResult(scope, 'CREATED', 1, id),
      drill_token: this.mint(tenant, id, read, old.asOfPeriod, latest),
      snapshot_id: latest,
      as_of_period: old.asOfPeriod,
      parent_context_id: old.id,
    };
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
  private async contextOf(
    tenant: TenantContext,
    tx: Parameters<BiQueryStore['findContext']>[0],
    token: string,
    now: Date,
    parsed?: BiDrillClaims,
  ): Promise<{ claims: BiDrillClaims; row: NonNullable<Awaited<ReturnType<BiQueryStore['findContext']>>> }> {
    const claims = parsed ?? this.claimsOf(token);
    if (claims.tid !== tenant.tenantId) throw new DomainError('DRILL_TOKEN_INVALID', 400);
    const row = await this.queries.findContext(tx, claims.ctx_id);
    if (row === undefined || row.createdBy !== tenant.membershipId || row.snapshotId !== claims.snapshot_id || row.metricVersionId !== claims.metric_version_id)
      throw new DomainError('DRILL_TOKEN_INVALID', 400);
    if (claims.exp <= Math.floor(now.getTime() / 1000)) throw expiredBiDrill(claims);
    return { claims, row };
  }

  /** A token of another tenant: refused as any bad token, and recorded in the tenant of the session (the token's tenant is not told anything). */
  private async deniedToken(tenant: TenantContext, claims: BiDrillClaims | undefined, reason: string): Promise<never> {
    await this.audit.recordDenied(tenant, {
      action: 'bi.drill_denied',
      resourceType: RESOURCE_TYPE,
      resourceId: tenant.tenantId,
      diff: { code: 'DRILL_TOKEN_INVALID', reason, ...(claims === undefined ? {} : { metric_version_id: claims.metric_version_id }) },
      correlationId: randomUUID(),
      requestId: randomUUID(),
    });
    throw new DomainError('DRILL_TOKEN_INVALID', 400);
  }

  private mint(tenant: TenantContext, contextId: string, read: Reading, asOfPeriod: string, snapshotId: string): string {
    return signBiDrill(
      { tid: tenant.tenantId, ctx_id: contextId, scope_hash: read.scopeHash, metric_version_id: read.metricId, snapshot_id: snapshotId, as_of_period: asOfPeriod },
      this.key,
      KEY_ID,
      () => Math.floor(this.clock().getTime() / 1000),
    );
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
        const child = await this.queries.insertContext(tx, {
          metricVersionId: read.metricId,
          snapshotId: read.version.datasetVersionId,
          asOfPeriod: read.version.periodCode,
          scopeHash: read.scopeHash,
          filters: [...filters, { field: dimension, operator: 'eq', value: group.key }],
          dimensionPath: path,
          unit: read.unit,
          parentContextId: contextId,
          createdBy: tenant.membershipId,
          ttlSeconds: BI_DRILL_TTL_SECONDS,
        });
        token = this.mint(tenant, child, read, read.version.periodCode, read.version.datasetVersionId);
      }
      rows.push({
        key: group.key,
        label: group.label ?? group.key,
        unclassified: group.key === null,
        value: figure.value,
        numerator: figure.numerator,
        denominator: figure.denominator,
        null_reason: figure.nullReason,
        drill_token: token,
      });
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
  return {
    id: row.id,
    metric_version_id: row.metricVersionId,
    snapshot_id: row.snapshotId,
    as_of_period: row.asOfPeriod,
    dimension_path: row.dimensionPath,
    expires_at: row.expiresAt,
    parent_context_id: row.parentContextId,
  };
}
