import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AstEvaluationStore, EVALUATION_TRIGGER_ACKNOWLEDGED_EVENT, EVALUATION_TRIGGER_RESOURCE, EVALUATION_TRIGGER_SCHEDULED_EVENT, TenantDatabase, projectScope } from '@machvon/db';
import type { AstTriggerResult, TriggerLine, TriggerScopes } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
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

const MANAGE_PERMISSION = PERMISSIONS.scheduleEvaluationTrigger;
/** The project is seen with the right to read it: a project the caller sees and may not set a trigger on is a refusal, one they do not see does not exist. */
const SEE_PERMISSION = PERMISSIONS.get_resources_project;
const CLASSIFICATION = 'INTERNAL';

const scopesFor = (access: EffectiveAccess, now: Date): TriggerScopes => ({ update: projectScope(access, MANAGE_PERMISSION, now), read: projectScope(access, SEE_PERMISSION, now) });

export function triggerView(line: TriggerLine): Record<string, unknown> {
  return {
    id: line.id,
    project: { id: line.project.id, code: line.project.code, name: line.project.name },
    trigger_kind: line.triggerKind,
    handover: line.handover === null ? null : { id: line.handover.id, handover_no: line.handover.handoverNo, accepted_on: line.handover.acceptedOn },
    due_on: line.dueOn,
    status: line.status,
    fired_at: line.firedAt,
    evaluation: line.evaluation === null ? null : { id: line.evaluation.id, evaluation_kind: line.evaluation.evaluationKind, status: line.evaluation.status },
    created_at: line.createdAt,
    version: line.version,
  };
}

/**
 * The trigger of the evaluation after the investment (ST-AST-006, AST 3.4, UC-AST-04, UAT-AC394). The project office sets the trigger for a project: 12 or 24 months after the day an accepted handover was
 * accepted (and not before), when the settlement is closed, or by hand (409 `TRIGGER_DUPLICATE`, 422 `PROJECT_STAGE_INVALID`). The job fires it on its day (`ast.evaluation.due.v1`) and MNE, once it did
 * the evaluation, acknowledges the trigger with it (409 `TRIGGER_STATE_INVALID`). Nothing here evaluates.
 */
@Controller()
export class EvaluationController {
  private readonly triggers = new AstEvaluationStore();

  @Post('projects/:id/evaluation-triggers')
  @HttpCode(200)
  @OperationId('scheduleEvaluationTrigger')
  @Command({ operation: 'scheduleEvaluationTrigger' })
  async schedule(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AstScheduleEvaluationTrigger'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.triggers.schedule(
      scope.tx,
      { projectId: id.toLowerCase(), triggerKind: body.trigger_kind, sourceHandoverId: body.source_handover_id, dueOn: body.due_on },
      scope.tenant.membershipId,
      scopesFor(access, now),
      now,
    );
    await this.written(scope, done, 'ast.evaluation_trigger_scheduled', EVALUATION_TRIGGER_SCHEDULED_EVENT, now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('evaluation-triggers/:id/acknowledge')
  @HttpCode(200)
  @OperationId('acknowledgeEvaluationTrigger')
  @Command({ operation: 'acknowledgeEvaluationTrigger' })
  async acknowledge(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['AstAcknowledgeEvaluationTrigger'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.triggers.acknowledge(scope.tx, id.toLowerCase(), body.mne_evaluation_id, scope.tenant.membershipId, scopesFor(access, now));
    await this.written(scope, done, 'ast.evaluation_trigger_acknowledged', EVALUATION_TRIGGER_ACKNOWLEDGED_EVENT, now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, the kind and the day, and the evaluation a trigger led to. */
  private async written(scope: CommandScope, done: AstTriggerResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      project_id: done.projectId,
      trigger_kind: done.triggerKind,
      handover_id: done.sourceHandoverId,
      due_on: done.dueOn,
      mne_evaluation_id: done.mneEvaluationId,
    };
    await scope.audit({ action, resourceType: EVALUATION_TRIGGER_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: EVALUATION_TRIGGER_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        trigger_id: done.id,
        ...facts,
        status: done.status,
        from_status: done.fromStatus,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${EVALUATION_TRIGGER_RESOURCE}:${done.id}:${done.version}`,
    });
  }
}

/** The triggers of evaluation of the projects in the scope of the caller (AST-07). */
@Controller('evaluation-triggers')
export class EvaluationReadsController {
  private readonly triggers = new AstEvaluationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listEvaluationTriggers')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = project === undefined ? undefined : typeof project === 'string' ? asUuid(project) : undefined;
    if (project !== undefined && projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.triggers.list(tx, projectScope(access, MANAGE_PERMISSION, now), { projectId: projectId?.toLowerCase(), status, limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(triggerView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
