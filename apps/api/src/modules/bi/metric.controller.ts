import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BiMetricStore, METRIC_ORIGINS, METRIC_STATUSES, TenantDatabase } from '@machvon/db';
import type { SyncRunInput } from '@machvon/db';
import { DomainError, asUuid, parseMetricBundle, planMetricSync, validateMetric } from '@machvon/kernel';
import type { EffectiveAccess, MetricSyncPlan, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { FileService } from '../files';
import { metricBundleSource } from './metric-bundle-source';
import { metricView } from './metric-views';

const RESOURCE_TYPE = 'metric_definition';
const SYNC_RESOURCE = 'bi_metric_sync_run';
const REVISION_PART = /^[1-9][0-9]{0,8}$/;
const CODE_FILTER = /^[a-z][a-z0-9_]{1,79}$/;

/** The registry belongs to the tenant: a grant on a subtree does not reach it. */
function assertWholeTenant(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function choice(value: unknown, allowed: readonly string[], field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/** The cursor of a page carries `<code>|<revision>`: the ordering key of the last revision on it. */
function pageAnchor(cursor: ReturnType<typeof parsePageRequest>['after']): { code: string; revision: number } | undefined {
  if (cursor === undefined) return undefined;
  const cut = cursor.code.lastIndexOf('|');
  const revision = cursor.code.slice(cut + 1);
  if (cut <= 0 || !REVISION_PART.test(revision)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { code: cursor.code.slice(0, cut), revision: Number(revision) };
}

const countsOf = (plan: MetricSyncPlan) => ({ added: plan.added.length, revised: plan.revised.length, retired: plan.retired.length });

/**
 * The sync of the metrics of the platform (ST-BI-001, BI 3 F1): the deploy pipeline names the commit and the hash of the bundle it built from the files of the repository; the bundle is read from the
 * object store and must be the bundle of that hash. The same bundle again is NO_CHANGE; a changed definition is the next revision; a change of what a number means under the same code, on the same
 * day, refuses the whole sync. Every sync leaves a run, a refused one too (BI-15 shows them), and a tenant cannot change what it brings.
 */
@Controller()
export class MetricRegistryController {
  private readonly metrics = new BiMetricStore();

  constructor(@Inject(FileService) private readonly files: FileService) {}

  @Post('bi/metric-registry-syncs')
  @HttpCode(200)
  @OperationId('syncMetricRegistry')
  @Command({ operation: 'syncMetricRegistry' })
  async sync(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BiMetricSync']): Promise<CommandResult & { added: number; revised: number; retired: number }> {
    assertWholeTenant(access, PERMISSIONS.syncMetricRegistry);
    const source = metricBundleSource(body);
    const input: SyncRunInput = { sourceCommit: body.source_commit, bundleSha256: source.sha256, bundleObjectKey: source.objectKey, triggeredBy: scope.tenant.membershipId };
    await this.metrics.lockSync(scope.tx);
    // The same commit with the same bundle again is the same deploy: nothing is read and nothing changes.
    if ((await this.metrics.processedRun(scope.tx, input.sourceCommit, input.bundleSha256)) !== undefined) {
      const run = await this.metrics.recordRun(scope.tx, input, { status: 'NO_CHANGE', added: 0, revised: 0, retired: 0 });
      await scope.audit({ action: 'bi.metric_registry_synced', resourceType: SYNC_RESOURCE, resourceId: run.id, diff: { source_commit: run.sourceCommit, bundle_sha256: run.bundleSha256, status: run.status } });
      return { ...commandResult(scope, 'NO_CHANGE', 1, run.id), added: 0, revised: 0, retired: 0 };
    }
    let plan: MetricSyncPlan;
    try {
      const bytes = source.bytes ?? (await this.files.download(scope.tenant, source.objectKey)).bytes;
      const bundle = parseMetricBundle(bytes, source.sha256);
      plan = planMetricSync(await this.metrics.registeredPlatform(scope.tx), bundle);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      // A refused sync is a record: nothing of the registry was written, the run commits with its error, and the answer is the refusal (the same key gets it again).
      const run = await this.metrics.recordRun(scope.tx, input, { status: 'REJECTED', added: 0, revised: 0, retired: 0, error: { code: error.code, detail: error.detail ?? null } });
      await scope.audit({ action: 'bi.metric_registry_sync_rejected', resourceType: SYNC_RESOURCE, resourceId: run.id, diff: { source_commit: run.sourceCommit, bundle_sha256: run.bundleSha256, status: run.status, code: error.code } });
      scope.refuseAfterCommit(error);
      return { ...commandResult(scope, 'REJECTED', 1, run.id), added: 0, revised: 0, retired: 0 };
    }
    const counts = countsOf(plan);
    if (counts.added + counts.revised + counts.retired === 0) {
      const run = await this.metrics.recordRun(scope.tx, input, { status: 'NO_CHANGE', added: 0, revised: 0, retired: 0 });
      await scope.audit({ action: 'bi.metric_registry_synced', resourceType: SYNC_RESOURCE, resourceId: run.id, diff: { source_commit: run.sourceCommit, bundle_sha256: run.bundleSha256, status: run.status } });
      return { ...commandResult(scope, 'NO_CHANGE', 1, run.id), added: 0, revised: 0, retired: 0 };
    }
    await this.metrics.applyPlan(scope.tx, plan, input);
    const run = await this.metrics.recordRun(scope.tx, input, { status: 'APPLIED', added: counts.added, revised: counts.revised, retired: counts.retired });
    await scope.audit({
      action: 'bi.metric_registry_synced',
      resourceType: SYNC_RESOURCE,
      resourceId: run.id,
      diff: { source_commit: run.sourceCommit, bundle_sha256: run.bundleSha256, status: run.status, ...counts },
    });
    await scope.emit({
      aggregateType: SYNC_RESOURCE,
      aggregateId: run.id,
      aggregateVersion: 1,
      type: 'bi.metric_registry.synced.v1',
      schemaVersion: 1,
      payload: {
        run_id: run.id,
        source_commit: run.sourceCommit,
        bundle_sha256: run.bundleSha256,
        added: plan.added.map((item) => item.code),
        revised: plan.revised.map((item) => item.definition.code),
        retired: plan.retired,
      },
      eventKey: `${SYNC_RESOURCE}:${run.id}`,
    });
    return { ...commandResult(scope, 'APPLIED', 1, run.id), ...counts };
  }
}

/** The metrics a tenant drafts itself (ST-BI-001): a code that starts with `t_`, an expression of allowed nodes only, and a dataset that offers every dimension. */
@Controller()
export class TenantMetricController {
  private readonly metrics = new BiMetricStore();

  @Post('bi/metric-definitions')
  @HttpCode(200)
  @OperationId('createTenantMetricDefinition')
  @Command({ operation: 'createTenantMetricDefinition' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BiMetricDraft']): Promise<CommandResult & { code: string; revision: number }> {
    assertWholeTenant(access, PERMISSIONS.createTenantMetricDefinition);
    const datasetId = asUuid(body.dataset_id);
    if (datasetId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
    const glossaryTermId = body.glossary_term_id === undefined ? undefined : asUuid(body.glossary_term_id);
    if (body.glossary_term_id !== undefined && glossaryTermId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'glossary_term_id');
    const checked = validateMetric({
      code: body.code,
      grain: body.grain,
      aggregationType: body.aggregation_type,
      expressionAst: body.expression_ast,
      numeratorAst: body.numerator_ast,
      denominatorAst: body.denominator_ast,
      unit: body.unit,
      nullPolicy: body.null_policy,
      dimensionCodes: body.dimension_codes,
      glossaryTerm: undefined,
      effectiveFrom: body.effective_from,
    });
    if (!checked.ok) throw new DomainError(checked.problem.code, 422, checked.problem.field);
    const created = await this.metrics.createTenant(scope.tx, { definition: checked.value, datasetId, glossaryTermId, actor: scope.tenant.membershipId });
    await scope.audit({
      action: 'bi.metric_drafted',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { code: created.code, revision: created.revision, aggregation_type: created.aggregationType, dataset_id: created.datasetId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bi.metric.drafted.v1',
      schemaVersion: 1,
      payload: { metric_id: created.id, code: created.code, revision: created.revision },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), code: created.code, revision: created.revision };
  }
}

/** The catalogue of the metrics (the scaffold read of the metric definition): BI-05 lists the revisions, BI-06 and BI-15 open one. */
@Controller('resources/metric_definition')
export class MetricReadsController {
  private readonly metrics = new BiMetricStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_metric_definition')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('origin') origin?: unknown,
    @Query('status') status?: unknown,
    @Query('code') code?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (code !== undefined && (typeof code !== 'string' || !CODE_FILTER.test(code))) throw new DomainError('VALIDATION_FAILED', 422, 'code');
    const filter = { origin: choice(origin, METRIC_ORIGINS, 'origin'), status: choice(status, METRIC_STATUSES, 'status'), code: code as string | undefined };
    const after = pageAnchor(request.after);
    const rows = await this.database.withTenant(tenant, (tx) => this.metrics.list(tx, filter, { limit: request.limit + 1, after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(metricView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.code}|${last.revision}`, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_metric_definition_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.metrics.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return metricView(row);
  }
}
