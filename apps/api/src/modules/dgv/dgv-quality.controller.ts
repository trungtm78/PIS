import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DgvQualityRuleStore, DgvQualityRunStore, QUALITY_RUN_TRIGGERS, QUALITY_RULE_STATUSES, TenantDatabase } from '@machvon/db';
import type { QualityRunStatus, QualityRuleStatus } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertTenantAuthority, uuidOf, viewerOf } from './inputs';
import { ruleViewOf, runViewOf, scorecardViewOf } from './quality-view';

const RULE_RESOURCE = 'quality_rule_version';
const RUN_RESOURCE = 'quality_run';
const RULE_STATUS_VALUES: readonly string[] = QUALITY_RULE_STATUSES;
const RUN_STATUS_VALUES: readonly string[] = ['RUNNING', 'COMPLETED', 'FAILED'];

function optionalUuid(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : uuidOf(value, name);
}

function optionalOneOf<T extends string>(list: readonly string[], value: unknown, name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value as T;
}

/**
 * The commands of the quality rules and runs (ST-DGV-002, DGV 3.3 F3). A rule is written in an expression the engine allows and approved by
 * a person other than its author; a run is requested against a frozen snapshot and is executed by the quality job, so the answer is 202. These
 * commands govern datasets that belong to no organisation unit and need the permission on the whole tenant.
 */
@Controller()
export class DgvQualityCommandsController {
  private readonly rules = new DgvQualityRuleStore();
  private readonly runs = new DgvQualityRunStore();

  @Post('dgv/quality-rules')
  @HttpCode(200)
  @OperationId('createQualityRuleVersion')
  @Command({ operation: 'createQualityRuleVersion' })
  async createRule(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvRuleDraft']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.createQualityRuleVersion);
    const draft = await this.rules.create(
      scope.tx,
      {
        contractId: uuidOf(body.contract_id, 'contract_id'),
        code: body.code,
        dimension: body.dimension,
        fieldPath: body.field_path,
        expressionAst: body.expression_ast,
        severity: body.severity,
        thresholdJson: body.threshold_json,
        actionOnFail: body.action_on_fail,
        criticalityWeight: body.criticality_weight,
      },
      viewerOf(scope.tenant, access),
    );
    await scope.audit({
      action: 'dgv.quality_rule_drafted',
      resourceType: RULE_RESOURCE,
      resourceId: draft.id,
      diff: {
        dataset_id: draft.datasetId,
        contract_id: draft.contractId,
        code: draft.code,
        revision: draft.revision,
        dimension: draft.dimension,
        field_path: draft.fieldPath,
        expression_ast: draft.expressionAst,
        severity: draft.severity,
        // Named so that the redaction of the audit diff (which hides what looks like a secret) does not take a rate for one.
        threshold_min_percent: draft.thresholdJson.min_pass_rate_pct,
        threshold_warn_percent: draft.thresholdJson.warn_pass_rate_pct ?? null,
        action_on_fail: draft.actionOnFail,
        criticality_weight: draft.criticalityWeight,
      },
    });
    await scope.emit({
      aggregateType: RULE_RESOURCE,
      aggregateId: draft.id,
      aggregateVersion: draft.version,
      type: 'dgv.rule.drafted.v1',
      schemaVersion: 1,
      payload: { rule_version_id: draft.id, dataset_id: draft.datasetId, contract_id: draft.contractId, code: draft.code, revision: draft.revision, dimension: draft.dimension },
      eventKey: `${RULE_RESOURCE}:${draft.id}:${draft.version}`,
    });
    return commandResult(scope, 'DRAFT', draft.version, draft.id);
  }

  @Post('dgv/quality-rules/:id/approval')
  @HttpCode(200)
  @OperationId('approveQualityRuleVersion')
  @Command({ operation: 'approveQualityRuleVersion', versioned: true })
  async approveRule(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.approveQualityRuleVersion);
    const ruleId = id.toLowerCase();
    const done = await this.rules.approve(scope.tx, ruleId, scope.expectedVersion ?? 0, viewerOf(scope.tenant, access));
    await scope.audit({
      action: 'dgv.quality_rule_approved',
      resourceType: RULE_RESOURCE,
      resourceId: ruleId,
      diff: { dataset_id: done.datasetId, contract_id: done.contractId, code: done.code, revision: done.revision, dimension: done.dimension, author_user_id: done.author, superseded_ids: done.supersededIds },
    });
    await scope.emit({
      aggregateType: RULE_RESOURCE,
      aggregateId: ruleId,
      aggregateVersion: done.version,
      type: 'dgv.rule.approved.v1',
      schemaVersion: 1,
      payload: { rule_version_id: ruleId, dataset_id: done.datasetId, contract_id: done.contractId, code: done.code, revision: done.revision, dimension: done.dimension, superseded_ids: done.supersededIds },
      eventKey: `${RULE_RESOURCE}:${ruleId}:${done.version}`,
    });
    return commandResult(scope, 'APPROVED', done.version, ruleId);
  }

  @Post('dgv/quality-runs')
  @HttpCode(202)
  @OperationId('runQualityChecks')
  @Command({ operation: 'runQualityChecks' })
  async requestRun(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DgvRunRequest']): Promise<CommandResult> {
    assertTenantAuthority(access, PERMISSIONS.runQualityChecks);
    if (!QUALITY_RUN_TRIGGERS.some((trigger) => trigger === body.trigger)) throw new DomainError('VALIDATION_FAILED', 422, 'trigger');
    const run = await this.runs.request(
      scope.tx,
      { datasetContractId: uuidOf(body.dataset_contract_id, 'dataset_contract_id'), snapshotId: uuidOf(body.snapshot_id, 'snapshot_id'), trigger: body.trigger },
      viewerOf(scope.tenant, access),
    );
    await scope.audit({
      action: 'dgv.quality_run_requested',
      resourceType: RUN_RESOURCE,
      resourceId: run.id,
      diff: { dataset_id: run.datasetId, dataset_contract_id: uuidOf(body.dataset_contract_id, 'dataset_contract_id'), snapshot_id: run.snapshotId, trigger: run.trigger, rule_count: run.ruleCount },
    });
    return commandResult(scope, 'RUNNING', 1, run.id);
  }
}

/** The scorecard of a dataset (DGV-01, DGV-07): what was measured, and only that; a dataset the caller may not see does not exist for them. */
@Controller()
export class DgvScorecardController {
  private readonly runs = new DgvQualityRunStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('dgv/datasets/:id/quality-scorecard')
  @OperationId('getQualityScorecard')
  async scorecard(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const viewer = viewerOf(tenant, access);
    const card = await this.database.withTenant(tenant, (tx) => this.runs.scorecard(tx, id.toLowerCase(), viewer));
    if (card === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return scorecardViewOf(card, new Date());
  }
}

/** The rule versions (the scaffold read of `quality_rule_version`): DGV-06 lists them and opens one; rules are metadata, not data of the rows. */
@Controller('resources/quality_rule_version')
export class QualityRuleReadsController {
  private readonly rules = new DgvQualityRuleStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_quality_rule_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { datasetId: optionalUuid(datasetId, 'dataset_id'), status: optionalOneOf<QualityRuleStatus>(RULE_STATUS_VALUES, status, 'status') };
    const viewer = viewerOf(tenant, access);
    const rows = await this.database.withTenant(tenant, (tx) => this.rules.list(tx, viewer, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(ruleViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.listKey, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_quality_rule_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const viewer = viewerOf(tenant, access);
    const row = await this.database.withTenant(tenant, (tx) => this.rules.find(tx, id.toLowerCase(), viewer));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return ruleViewOf(row);
  }
}

/**
 * The runs (the scaffold read of `quality_run`): a summary of what each run found. The list is of the runs themselves, over many snapshots, so
 * it names none; one run names the frozen snapshot it read (`snapshot_id`), and every answer says when it was read (`as_of`).
 */
@Controller('resources/quality_run')
export class QualityRunReadsController {
  private readonly runs = new DgvQualityRunStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_quality_run')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { datasetId: optionalUuid(datasetId, 'dataset_id'), status: optionalOneOf<QualityRunStatus>(RUN_STATUS_VALUES, status, 'status') };
    const viewer = viewerOf(tenant, access);
    const rows = await this.database.withTenant(tenant, (tx) => this.runs.list(tx, viewer, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(runViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.startedKey, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_quality_run_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const viewer = viewerOf(tenant, access);
    const row = await this.database.withTenant(tenant, (tx) => this.runs.find(tx, id.toLowerCase(), viewer));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...runViewOf(row), as_of: new Date().toISOString() };
  }
}
