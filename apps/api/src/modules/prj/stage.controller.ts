import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PRJ_STAGE_TRANSITION_METRIC, PrjStageStore, STAGE_COMMANDS, TenantDatabase, checkedPipelineFilter, projectScope, stageChangeRecord } from '@machvon/db';
import type { StageCommand } from '@machvon/db';
import { DomainError, NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { SHARED_PIPELINE_CACHE, pipelineVariant } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';
import { lifecycleView, pipelineCardView, stageInputOf } from './stage-view';
import { PRJ_METRICS, PRJ_PIPELINE_CACHE } from './tokens';

const READ_PERMISSION = PERMISSIONS.get_resources_project;
const BOARD_ALL_STAGES = 'all';

/** The text of a query parameter, or undefined when it is absent; a parameter that is repeated or not text is a fault of the request. */
function queryText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

/**
 * The guarded moves of a project along the PIMA life cycle (ST-PRJ-002, PRJ 3.1 F4 and F5): start, suspend, resume, complete, close and
 * cancel. Each acts on a project inside the scope of its own permission under the version the caller saw, along the transition table of the
 * domain, and leaves the audit row and `project.stage_changed.v1` of the same transaction. No generic write of the status exists.
 */
@Controller()
export class ProjectStageController {
  private readonly stages = new PrjStageStore();
  private readonly metrics: MetricsSink;
  private readonly cache: PipelineCache;

  constructor(@Optional() @Inject(PRJ_METRICS) metrics?: MetricsSink, @Optional() @Inject(PRJ_PIPELINE_CACHE) cache?: PipelineCache) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.cache = cache ?? SHARED_PIPELINE_CACHE;
  }

  @Post('projects/:id/implementation-start')
  @HttpCode(200)
  @OperationId('startProjectImplementation')
  @Command({ operation: 'startProjectImplementation', versioned: true })
  start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    return this.move(scope, access, id, 'startProjectImplementation', body);
  }

  @Post('projects/:id/suspension')
  @HttpCode(200)
  @OperationId('suspendProject')
  @Command({ operation: 'suspendProject', versioned: true })
  suspend(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    return this.move(scope, access, id, 'suspendProject', body);
  }

  @Post('projects/:id/resumption')
  @HttpCode(200)
  @OperationId('resumeProject')
  @Command({ operation: 'resumeProject', versioned: true })
  resume(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    return this.move(scope, access, id, 'resumeProject', body);
  }

  @Post('projects/:id/completion')
  @HttpCode(200)
  @OperationId('completeProject')
  @Command({ operation: 'completeProject', versioned: true })
  complete(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    return this.move(scope, access, id, 'completeProject', body);
  }

  @Post('projects/:id/closure')
  @HttpCode(200)
  @OperationId('closeProject')
  @Command({ operation: 'closeProject', versioned: true })
  close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    return this.move(scope, access, id, 'closeProject', body);
  }

  @Post('projects/:id/cancellation')
  @HttpCode(200)
  @OperationId('cancelProject')
  @Command({ operation: 'cancelProject', versioned: true })
  cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    return this.move(scope, access, id, 'cancelProject', body);
  }

  private async move(scope: CommandScope, access: EffectiveAccess, id: string, command: StageCommand, body: Schemas['PrjStageCommand']): Promise<CommandResult> {
    const now = new Date();
    const change = await this.stages.transition(scope.tx, {
      command,
      // The identifier travels on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
      projectId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, PERMISSIONS[command], now), read: projectScope(access, READ_PERMISSION, now) },
      input: stageInputOf(body),
      today: vietnamDateOf(now),
    });
    const record = stageChangeRecord(change, scope.tenant.tenantId, now);
    await scope.audit(record.audit);
    await scope.emit(record.event);
    // Only a committed move counts and clears the pages of the project bank: a move that rolled back changed nothing.
    scope.afterCommit(async () => {
      this.metrics.increment(PRJ_STAGE_TRANSITION_METRIC, { to: change.to });
      await this.cache.invalidate(scope.tenant.tenantId);
    });
    return commandResult(scope, change.to, change.version, change.projectId);
  }
}

/** The history of the stage of one project (PRJ-14 confirmation, PRJ-03) and the project bank by stage (PRJ-14): DTO allowlists filtered by the unit tree. */
@Controller()
export class ProjectLifecycleReadsController {
  private readonly stages = new PrjStageStore();
  private readonly cache: PipelineCache;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(PRJ_PIPELINE_CACHE) cache?: PipelineCache,
  ) {
    this.cache = cache ?? SHARED_PIPELINE_CACHE;
  }

  @Get('projects/:id/lifecycle')
  @OperationId('getProjectLifecycle')
  async lifecycle(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const act = Object.fromEntries(STAGE_COMMANDS.map((command) => [command, projectScope(access, PERMISSIONS[command], now)])) as Record<StageCommand, ReturnType<typeof projectScope>>;
    const lifecycle = await this.database.withTenant(tenant, (tx) => this.stages.lifecycle(tx, id.toLowerCase(), { read: projectScope(access, READ_PERMISSION, now), act }, vietnamDateOf(now)));
    // A project in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (lifecycle === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return lifecycleView(lifecycle, now);
  }

  @Get('project-pipeline')
  @OperationId('listProjectPipeline')
  async pipeline(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('stage') stage?: unknown,
    @Query('project_group') projectGroup?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const filter = checkedPipelineFilter({ stage: queryText(stage, 'stage'), projectGroup: queryText(projectGroup, 'project_group') });
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const scope = projectScope(access, READ_PERMISSION, now);
    const predicate = scope(6);
    const stageKey = filter.stage ?? BOARD_ALL_STAGES;
    const variant = pipelineVariant({ scopeSql: predicate.sql, scopeParams: predicate.params, group: filter.projectGroup, limit: request.limit, cursor: typeof cursor === 'string' ? cursor : undefined });
    const cached = await this.cache.get(tenant.tenantId, stageKey, variant);
    if (cached !== undefined) return JSON.parse(cached) as Record<string, unknown>;
    // One card more than the page tells whether there is a next page.
    const page = await this.database.withTenant(tenant, (tx) => this.stages.pipeline(tx, scope, filter, { limit: request.limit + 1, after: request.after }, vietnamDateOf(now)));
    const shown = page.cards.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const body = {
      items: shown.map(pipelineCardView),
      total: page.total,
      next_cursor: page.cards.length > request.limit && last !== undefined ? encodeCursor({ code: last.codeKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
    await this.cache.set(tenant.tenantId, stageKey, variant, JSON.stringify(body));
    return body;
  }
}
