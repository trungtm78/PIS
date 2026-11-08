import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApprovalStore, TenantDatabase } from '@machvon/db';
import type { ApprovalTaskRecord, WorkflowInstanceRecord, WorkflowVersionRecord } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid } from '@machvon/kernel';
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
import { APPROVAL_FINAL_COMMANDS, effectsOf } from './approval.service';
import type { FinalCommandRegistry } from './approval.service';
import { holdsOnWholeTenant } from './tenant-authority';
import { ADM_METRICS } from './tokens';

const MANAGE = 'adm.workflow.manage';
const PUBLISH = 'adm.workflow.publish';
const OPERATE = 'adm.workflow.operate';
const VERSION_RESOURCE = 'workflow_version';
const TASK_RESOURCE = 'approval_task';
/** The counter of the approvals the owning module refused at their end (BR-ADM-07): any increase is an alert for the operators. */
export const GUARD_REJECTED_METRIC = 'workflow_guard_rejected_total';
const STATUSES: readonly string[] = ['Draft', 'Published', 'Superseded', 'Retired'];
const INSTANCE_STATUSES: readonly string[] = ['Running', 'Completed', 'Cancelled', 'Failed'];
const TASK_STATUSES: readonly string[] = ['Pending', 'Decided', 'Reassigned', 'Cancelled', 'Expired'];

/** The workflow definitions are the tenant's own rules, owned by no unit: only a grant on the whole tenant reaches them. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function oneOf(list: readonly string[], value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

function versionView(row: WorkflowVersionRecord): Record<string, unknown> {
  return { id: row.id, business_type: row.businessType, kind: row.kind, revision: row.revision, status: row.status, definition: row.definition, created_by: row.createdBy, published_by: row.publishedBy, created_at: row.createdAt, published_at: row.publishedAt, version: row.version };
}

function instanceView(row: WorkflowInstanceRecord): Record<string, unknown> {
  return {
    id: row.id,
    workflow_version_id: row.workflowVersionId,
    business_type: row.businessType,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    resource_version: row.resourceVersion,
    status: row.status,
    outcome: row.outcome,
    current_step: row.currentStep,
    document_type: row.documentType,
    amount_vnd: row.amountVnd,
    unit_id: row.unitId,
    initiator_id: row.initiatorId,
    doa_matrix_version_id: row.doaMatrixVersionId,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    version: row.version,
  };
}

function taskView(row: ApprovalTaskRecord, membershipId: string, operates = false): Record<string, unknown> {
  return {
    id: row.id,
    workflow_instance_id: row.workflowInstanceId,
    step_id: row.stepId,
    step_index: row.stepIndex,
    assignee: { id: row.assigneeId, name: row.assigneeName },
    delegated_from_id: row.delegatedFromId,
    due_at: row.dueAt,
    status: row.status,
    decision: row.decision,
    reason: row.reason,
    decided_at: row.decidedAt,
    decided_by: row.decidedBy,
    business_type: row.businessType,
    resource: { type: row.resourceType, id: row.resourceId },
    created_at: row.createdAt,
    version: row.version,
    step_name: row.stepName,
    // What the monitor (ADM-18) shows beside the task: the figure and the definition the instance runs by, and the version the cancellation is asked at.
    instance: { id: row.workflowInstanceId, version: row.instanceVersion, status: row.instanceStatus, amount_vnd: row.amountVnd, document_type: row.documentType, unit_id: row.unitId, workflow_revision: row.workflowRevision },
    overdue: row.status === 'Pending' && Date.parse(row.dueAt) < Date.now(),
    overdue_reminders: row.overdueReminders,
    escalated_at: row.escalatedAt,
    escalated_from_id: row.escalatedFromId,
    reassigned_from_id: row.reassignedFromId,
    // The server judges again: this only says whether the screen should offer it.
    actions: { decide: row.status === 'Pending' && (row.assigneeId === membershipId || row.delegatedToMe), reassign: operates && row.status === 'Pending', cancel: operates && row.status === 'Pending' && row.instanceStatus === 'Running' },
  };
}

/**
 * The workflow definitions and the decision of a task (ST-ADM-012, ADM 3.7). A tenant administrator writes a draft per business type, another administrator publishes it, and the instances that start afterwards run it; an
 * approver decides the tasks they are given. The decision needs a fresh second factor (`x-step-up`), and a maker is never the checker.
 */
@Controller()
export class ApprovalCommandsController {
  private readonly store = new ApprovalStore();

  private readonly metrics: MetricsSink;

  constructor(
    @Inject(APPROVAL_FINAL_COMMANDS) private readonly commands: FinalCommandRegistry,
    @Optional() @Inject(ADM_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post('workflow-definitions')
  @HttpCode(200)
  @OperationId('createWorkflowDraft')
  @Command({ operation: 'createWorkflowDraft' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['WorkflowDraft']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const created = await this.store.createDraft(scope.tx, { businessType: body.business_type, definition: body.definition }, scope.tenant.membershipId);
    await scope.audit({ action: 'workflow.drafted', resourceType: VERSION_RESOURCE, resourceId: created.id, classification: 'INTERNAL', diff: { business_type: created.businessType, revision: created.revision } });
    return commandResult(scope, 'DRAFT', created.version, created.id);
  }

  @Put('workflow-definitions/:workflowVersionId')
  @HttpCode(200)
  @OperationId('updateWorkflowDraft')
  @Command({ operation: 'updateWorkflowDraft', versioned: true })
  async update(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflowVersionId', ParseUUIDPipe) id: string, @Body() body: Schemas['WorkflowDraft']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const updated = await this.store.updateDraft(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { businessType: body.business_type, definition: body.definition }, scope.tenant.membershipId);
    await scope.audit({ action: 'workflow.updated', resourceType: VERSION_RESOURCE, resourceId: updated.id, classification: 'INTERNAL', diff: { business_type: updated.businessType, revision: updated.revision, version: updated.version } });
    return commandResult(scope, 'DRAFT', updated.version, updated.id);
  }

  @Post('workflow-definitions/:workflowVersionId/publish')
  @HttpCode(200)
  @OperationId('publishWorkflowVersion')
  @Command({ operation: 'publishWorkflowVersion', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('workflowVersionId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, PUBLISH);
    const done = await this.store.publish(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, new Date());
    await scope.audit({ action: 'workflow.published', resourceType: VERSION_RESOURCE, resourceId: done.version.id, reason: body.reason, classification: 'INTERNAL', diff: { business_type: done.version.businessType, revision: done.version.revision, superseded_id: done.supersededId } });
    await scope.emit({
      aggregateType: VERSION_RESOURCE,
      aggregateId: done.version.id,
      aggregateVersion: done.version.version,
      type: 'adm.workflow_version.published.v1',
      schemaVersion: 1,
      payload: { workflow_version_id: done.version.id, business_type: done.version.businessType, revision: done.version.revision, superseded_id: done.supersededId },
      eventKey: `${VERSION_RESOURCE}:${done.version.id}:published`,
    });
    return commandResult(scope, 'PUBLISHED', done.version.version, done.version.id);
  }

  @Post('workflow-instances/:instanceId/cancel')
  @HttpCode(202)
  @OperationId('cancelWorkflowInstance')
  @Command({ operation: 'cancelWorkflowInstance', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('instanceId', ParseUUIDPipe) instanceId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, OPERATE);
    const ended = await this.store.cancelInstance(scope.tx, effectsOf(scope), { instanceId: instanceId.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, reason: body.reason.trim(), now: new Date() });
    return commandResult(scope, 'CANCELLED', ended.version, ended.id);
  }

  @Post('approval-tasks/:taskId/reassign')
  @HttpCode(200)
  @OperationId('reassignApprovalTask')
  @Command({ operation: 'reassignApprovalTask', versioned: true })
  async reassign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() body: Schemas['TaskReassign']): Promise<CommandResult> {
    assertHolds(access, OPERATE);
    const done = await this.store.reassignTask(scope.tx, effectsOf(scope), {
      taskId: taskId.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      newAssignee: body.new_assignee_membership_id.toLowerCase(),
      reason: body.reason,
      now: new Date(),
    });
    return commandResult(scope, 'REASSIGNED', done.task.version, done.task.id);
  }

  @Post('approval-tasks/:taskId/decision')
  @HttpCode(200)
  @OperationId('decideApprovalTask')
  @Command({ operation: 'decideApprovalTask', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() body: Schemas['ApprovalDecision']): Promise<CommandResult> {
    const decision = (['approve', 'return', 'reject'] as const).find((candidate) => candidate === body.decision);
    if (decision === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const result = await this.store.decide(scope.tx, effectsOf(scope), {
      taskId: taskId.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      decision,
      reason: body.reason,
      returnToStep: body.return_to_step,
      now: new Date(),
      finish: this.commands.asFinalCommand(),
    });
    if (result.kind === 'SELF_APPROVAL') {
      // The reassignment is committed with the audit row; the answer is the refusal.
      await scope.audit({ action: 'approval.self_approval_refused', resourceType: TASK_RESOURCE, resourceId: result.task.id, diff: { reassigned_to: result.reassignedTo, step_id: result.task.stepId } });
      scope.refuseAfterCommit(new DomainError('SELF_APPROVAL_DENIED', 403, undefined, { extensions: { reassigned: result.reassignedTo !== null } }));
      return commandResult(scope, 'REFUSED', result.task.version, result.task.id);
    }
    await scope.audit({
      action: 'approval.task_decided',
      resourceType: TASK_RESOURCE,
      resourceId: result.task.id,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      // A decision taken under a delegation names both: the actor is the delegate, the person it is taken for is the delegator (ADM-11).
      ...(result.delegationId === null || result.task.delegatedFromId === null ? {} : { onBehalfOfId: result.task.delegatedFromId }),
      diff: { decision, step_id: result.task.stepId, step: result.step, outcome: result.outcome, final_command: result.finalCommand, instance_id: result.instance.id, ...(result.delegationId === null ? {} : { delegation_id: result.delegationId }) },
    });
    if (result.outcome === 'GUARD_REJECTED') this.metrics.increment(GUARD_REJECTED_METRIC, { business_type: result.instance.businessType });
    return commandResult(scope, result.instance.status === 'Running' ? 'DECIDED' : (result.outcome ?? 'DECIDED'), result.task.version, result.task.id);
  }
}

function pageOf<T extends { sortKey: string; id: string }>(rows: T[], limit: number, view: (row: T) => Record<string, unknown>): { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string } {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown.map(view), next_cursor: rows.length > limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
}

/** The definitions: the tenant's own rules, readable by those who hold the read right. */
@Controller('resources/workflow_version')
export class WorkflowVersionReadsController {
  private readonly store = new ApprovalStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_workflow_version')
  async list(@CurrentTenant() tenant: TenantContext, @Query('business_type') businessType?: unknown, @Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown) {
    const request = parsePageRequest(limit, cursor);
    const filters = { businessType: typeof businessType === 'string' && businessType !== '' ? businessType : undefined, status: oneOf(STATUSES, status, 'status') };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listVersions(tx, filters, { limit: request.limit + 1, after: request.after }));
    return pageOf(rows, request.limit, versionView);
  }

  @Get(':id')
  @OperationId('get_resources_workflow_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.store.findVersion(tx, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...versionView(found), as_of: new Date().toISOString() };
  }
}

/** The running and finished approvals: those of the whole tenant for who runs workflows, otherwise the ones the person started or has a task in. */
@Controller('resources/workflow_instance')
export class WorkflowInstanceReadsController {
  private readonly store = new ApprovalStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_workflow_instance')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('resource_type') resourceType?: unknown,
    @Query('resource_id') resourceId?: unknown,
    @Query('status') status?: unknown,
    @Query('business_type') businessType?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ) {
    const request = parsePageRequest(limit, cursor);
    const filters = {
      resourceType: typeof resourceType === 'string' && resourceType !== '' ? resourceType : undefined,
      resourceId: resourceId === undefined ? undefined : (asUuid(resourceId) ?? ((): never => { throw new DomainError('VALIDATION_FAILED', 422, 'resource_id'); })()),
      status: oneOf(INSTANCE_STATUSES, status, 'status'),
      businessType: typeof businessType === 'string' && businessType !== '' ? businessType : undefined,
    };
    const viewer = { membershipId: tenant.membershipId, all: holdsOnWholeTenant(access, OPERATE) || holdsOnWholeTenant(access, MANAGE) };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listInstances(tx, viewer, filters, { limit: request.limit + 1, after: request.after }));
    return pageOf(rows, request.limit, instanceView);
  }

  @Get(':id')
  @OperationId('get_resources_workflow_instance_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const viewer = { membershipId: tenant.membershipId, all: holdsOnWholeTenant(access, OPERATE) || holdsOnWholeTenant(access, MANAGE) };
    const found = await this.database.withTenant(tenant, async (tx) => {
      const instance = await this.store.findInstance(tx, id.toLowerCase());
      if (instance === undefined) return undefined;
      if (viewer.all) return instance;
      // The instance of someone else's approval is not there for a person who neither started it nor has a task in it.
      const visible = await this.store.listInstances(tx, viewer, { id: instance.id }, { limit: 1, after: undefined });
      return visible.length > 0 ? instance : undefined;
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...instanceView(found), as_of: new Date().toISOString() };
  }
}

/** The tasks: the ones given to the person (or on whose behalf they may decide), and for who runs workflows all of them. */
@Controller('resources/approval_task')
export class ApprovalTaskReadsController {
  private readonly store = new ApprovalStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_approval_task')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('workflow_instance_id') instanceId?: unknown,
    @Query('mine') mine?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ) {
    const request = parsePageRequest(limit, cursor);
    if (mine !== undefined && mine !== 'true' && mine !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'mine');
    const filters = {
      status: oneOf(TASK_STATUSES, status, 'status'),
      instanceId: instanceId === undefined ? undefined : (asUuid(instanceId) ?? ((): never => { throw new DomainError('VALIDATION_FAILED', 422, 'workflow_instance_id'); })()),
      mine: mine === 'true',
    };
    const viewer = { membershipId: tenant.membershipId, all: holdsOnWholeTenant(access, OPERATE) };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listTasks(tx, viewer, filters, { limit: request.limit + 1, after: request.after }));
    return pageOf(rows, request.limit, (row) => taskView(row, tenant.membershipId, viewer.all));
  }

  @Get(':id')
  @OperationId('get_resources_approval_task_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const all = holdsOnWholeTenant(access, OPERATE);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const task = await this.store.findTask(tx, id.toLowerCase(), tenant.membershipId);
      if (task === undefined) return undefined;
      if (all) return task;
      const visible = await this.store.listTasks(tx, { membershipId: tenant.membershipId, all: false }, { id: task.id }, { limit: 1, after: undefined });
      return visible.length > 0 ? task : undefined;
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...taskView(found, tenant.membershipId, all), as_of: new Date().toISOString() };
  }
}
