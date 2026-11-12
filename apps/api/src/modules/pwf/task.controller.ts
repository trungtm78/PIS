import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfTaskReads, PwfTaskStore, TenantDatabase, projectInScope, projectScope } from '@machvon/db';
import type { PwfTaskResult } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
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
import { TASK_RESOURCE, announce, scopesOf } from './pwf-support';

const READ = PERMISSIONS.getProjectTask;
const vietnamToday = vietnamDateOf;

/**
 * The commands on one task of a project workflow (PWF-04): start, evidence, checklist, completion, approval by a second person, return, exceptions and their decision, resume, and the ledger of assignments. Each is judged in the
 * scope of its own permission, audited (ADM-11) and announced in the outbox with ids, codes and days only; a refusal because the work is not complete lists the blockers.
 */
@Controller()
export class ProjectTaskController {
  private readonly tasks = new PwfTaskStore();

  private async done(scope: CommandScope, result: PwfTaskResult, action: string, type: string, now: Date, reason?: string): Promise<CommandResult> {
    await announce(scope, { resource: TASK_RESOURCE, id: result.id, version: result.version, action, type, fromStatus: result.fromStatus, status: result.status, facts: { workflow_id: result.workflowId, project_id: result.projectId, ...result.facts }, ...(reason === undefined ? {} : { reason }) }, now);
    return commandResult(scope, result.status, result.version, result.id);
  }

  /** The project a task belongs to (the scope of a permission is judged on the project). */
  private async projectOf(scope: CommandScope, taskId: string): Promise<string> {
    const rows = await scope.tx.query<{ project_id: string }>('select project_id from machvon.project_task where id = $1::uuid', [taskId.toLowerCase()]);
    return rows[0]?.project_id ?? taskId;
  }

  @Post('project-tasks/:task_id/start')
  @HttpCode(200)
  @OperationId('startProjectTask')
  @Command({ operation: 'startProjectTask', versioned: true })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Body() body: Schemas['PwfTaskStart']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.start(scope.tx, { taskId, expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.startProjectTask, now), today: vietnamToday(now), earlyStartReason: body.early_start_reason, actualStart: body.actual_start, note: body.note, mayStartEarly: body.early_start_reason === undefined ? false : await projectInScope(scope.tx, await this.projectOf(scope, taskId), projectScope(access, PERMISSIONS.startProjectWorkflow, now)) });
    return this.done(scope, result, 'task.started', 'pwf.task.started.v1', now);
  }

  @Post('project-tasks/:task_id/evidence')
  @HttpCode(200)
  @OperationId('attachProjectTaskEvidence')
  @Command({ operation: 'attachProjectTaskEvidence' })
  async evidence(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Body() body: Schemas['PwfEvidenceInput']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.attachEvidence(scope.tx, {
      taskId,
      actor: scope.tenant.membershipId,
      scopes: scopesOf(access, PERMISSIONS.attachProjectTaskEvidence, now),
      today: vietnamToday(now),
      input: { evidenceKind: body.evidence_kind, itemCode: body.item_code, documentId: body.document_id, legalDocType: body.legal_doc_type, formTemplateCode: body.form_template_code, externalRef: body.external_ref, note: body.note },
    });
    await announce(scope, { resource: TASK_RESOURCE, id: result.id, version: result.version, action: 'task.evidence_attached', type: 'pwf.task.evidence_attached.v1', fromStatus: result.fromStatus, status: result.status, facts: { workflow_id: result.workflowId, project_id: result.projectId, evidence_id: result.evidenceId, ...result.facts } }, now);
    return commandResult(scope, result.status, result.version, result.evidenceId);
  }

  @Post('project-tasks/:task_id/checklist/:item_code/complete')
  @HttpCode(200)
  @OperationId('completeProjectTaskChecklistItem')
  @Command({ operation: 'completeProjectTaskChecklistItem', versioned: true })
  async checklist(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Param('item_code') itemCode: string, @Body() body: Schemas['PwfChecklistComplete']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.completeChecklistItem(scope.tx, { taskId, expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.completeProjectTaskChecklistItem, now), today: vietnamToday(now), itemCode, evidenceId: body.evidence_id, note: body.note });
    return this.done(scope, result, 'task.checklist_done', 'pwf.task.checklist_done.v1', now);
  }

  @Post('project-tasks/:task_id/complete')
  @HttpCode(200)
  @OperationId('completeProjectTask')
  @Command({ operation: 'completeProjectTask', versioned: true })
  async complete(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Body() body: Schemas['PwfTaskComplete']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.complete(scope.tx, {
      taskId,
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      scopes: scopesOf(access, PERMISSIONS.completeProjectTask, now),
      today: vietnamToday(now),
      actualFinish: body.actual_finish,
      actualVnd: body.actual_vnd === undefined ? undefined : String(body.actual_vnd),
      exceptionId: body.exception_id,
      note: body.note,
    });
    return this.done(scope, result, 'task.completed', 'pwf.task.completed.v1', now);
  }

  @Post('project-tasks/:task_id/approve-completion')
  @HttpCode(200)
  @OperationId('approveProjectTaskCompletion')
  @Command({ operation: 'approveProjectTaskCompletion', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Body() body: Schemas['PwfDecisionInput']): Promise<CommandResult> {
    if (body.decision !== 'APPROVE') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const now = new Date();
    const result = await this.tasks.approveCompletion(scope.tx, { taskId, expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.approveProjectTaskCompletion, now), today: vietnamToday(now), note: body.note });
    return this.done(scope, result, 'task.approved', 'pwf.task.approved.v1', now);
  }

  @Post('project-tasks/:task_id/return')
  @HttpCode(200)
  @OperationId('returnProjectTask')
  @Command({ operation: 'returnProjectTask', versioned: true })
  async return(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Body() body: Schemas['PwfReturnInput']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.returnTask(scope.tx, { taskId, expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.returnProjectTask, now), today: vietnamToday(now), reason: body.reason });
    return this.done(scope, result, 'task.returned', 'pwf.task.returned.v1', now, body.reason);
  }

  @Post('project-tasks/:task_id/exceptions')
  @HttpCode(200)
  @OperationId('requestProjectTaskException')
  @Command({ operation: 'requestProjectTaskException' })
  async requestException(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Body() body: Schemas['PwfExceptionRequest']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.requestException(scope.tx, {
      taskId,
      actor: scope.tenant.membershipId,
      scopes: scopesOf(access, PERMISSIONS.requestProjectTaskException, now),
      today: vietnamToday(now),
      kind: body.kind,
      items: body.items,
      validFrom: body.valid_from,
      validTo: body.valid_to,
      reason: body.reason,
      evidenceRef: body.evidence_ref,
    });
    await announce(scope, { resource: TASK_RESOURCE, id: result.id, version: result.version, action: 'task.exception_requested', type: 'pwf.task.exception.requested.v1', fromStatus: result.fromStatus, status: result.status, facts: { workflow_id: result.workflowId, project_id: result.projectId, exception_id: result.exceptionId, ...result.facts }, reason: body.reason }, now);
    return commandResult(scope, 'REQUESTED', 1, result.exceptionId);
  }

  @Post('project-task-exceptions/:id/decide')
  @HttpCode(200)
  @OperationId('decideProjectTaskException')
  @Command({ operation: 'decideProjectTaskException', versioned: true })
  async decideException(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PwfDecisionInput']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.decideException(scope.tx, { exceptionId: id, expectedVersion: scope.expectedVersion ?? 0, decision: body.decision, note: body.note, actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.decideProjectTaskException, now), today: vietnamToday(now) });
    await announce(scope, { resource: TASK_RESOURCE, id: result.id, version: result.version, action: 'task.exception_decided', type: 'pwf.task.exception.decided.v1', fromStatus: result.fromStatus, status: result.status, facts: { workflow_id: result.workflowId, project_id: result.projectId, exception_id: result.exceptionId, ...result.facts } }, now);
    if (result.status === 'ON_HOLD') await announce(scope, { resource: TASK_RESOURCE, id: result.id, version: result.version, action: 'task.paused', type: 'pwf.task.paused.v1', fromStatus: result.fromStatus, status: result.status, facts: { workflow_id: result.workflowId, project_id: result.projectId, ...result.facts } }, now);
    if (result.status === 'CANCELLED') await announce(scope, { resource: TASK_RESOURCE, id: result.id, version: result.version, action: 'task.cancelled', type: 'pwf.task.cancelled.v1', fromStatus: result.fromStatus, status: result.status, facts: { workflow_id: result.workflowId, project_id: result.projectId, ...result.facts } }, now);
    return commandResult(scope, result.exceptionStatus, result.version, result.exceptionId);
  }

  @Post('project-tasks/:task_id/resume')
  @HttpCode(200)
  @OperationId('resumeProjectTask')
  @Command({ operation: 'resumeProjectTask', versioned: true })
  async resume(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.resume(scope.tx, { taskId, expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, scopes: scopesOf(access, PERMISSIONS.resumeProjectTask, now), today: vietnamToday(now) });
    return this.done(scope, result, 'task.resumed', 'pwf.task.resumed.v1', now);
  }

  @Post('project-tasks/:task_id/assignments')
  @HttpCode(200)
  @OperationId('assignProjectTask')
  @Command({ operation: 'assignProjectTask' })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Body() body: Schemas['PwfAssignmentInput']): Promise<CommandResult> {
    const now = new Date();
    const result = await this.tasks.assign(scope.tx, {
      taskId,
      actor: scope.tenant.membershipId,
      scopes: scopesOf(access, PERMISSIONS.assignProjectTask, now),
      today: vietnamToday(now),
      input: { membershipId: body.membership_id, role: body.role, validFrom: body.valid_from, validTo: body.valid_to, sharePct: body.share_pct, reason: body.reason },
    });
    await announce(scope, { resource: TASK_RESOURCE, id: result.id, version: result.version, action: 'task.assigned', type: 'pwf.task.assigned.v1', fromStatus: result.fromStatus, status: result.status, facts: { workflow_id: result.workflowId, project_id: result.projectId, assignment_id: result.assignmentId, ...result.facts } }, now);
    return commandResult(scope, 'ASSIGNED', result.version, result.assignmentId);
  }
}

/** One task in full and the ledger of its assignments (PWF-04, PWF-16): the scope of `pwf.read`; the buttons the caller may press are told by `can_*`. */
@Controller()
export class ProjectTaskReadsController {
  private readonly reads = new PwfTaskReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('project-tasks/:task_id')
  @OperationId('getProjectTask')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string): Promise<Schemas['PwfTaskDetail']> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const holds = async (permission: string, projectId: string): Promise<boolean> => projectInScope(tx, projectId, projectScope(access, permission, now));
      const owner = await tx.query<{ project_id: string }>('select project_id from machvon.project_task where id = $1::uuid', [taskId.toLowerCase()]);
      const projectId = owner[0]?.project_id;
      const can =
        projectId === undefined
          ? { manage: false, proposeReschedule: false, work: false, approve: false, assign: false }
          : { manage: false, proposeReschedule: false, work: await holds(PERMISSIONS.startProjectTask, projectId), approve: await holds(PERMISSIONS.approveProjectTaskCompletion, projectId), assign: await holds(PERMISSIONS.assignProjectTask, projectId) };
      return this.reads.task(tx, projectScope(access, READ, now), taskId.toLowerCase(), now, tenant.membershipId, can);
    }) as Promise<Schemas['PwfTaskDetail']>;
  }

  @Get('project-tasks/:task_id/assignments')
  @OperationId('listProjectTaskAssignments')
  async assignments(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('task_id', ParseUUIDPipe) taskId: string, @Query() query: Record<string, unknown>): Promise<Schemas['PwfAssignmentPage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    const found = await this.database.withTenant(tenant, (tx) => this.reads.assignments(tx, projectScope(access, PERMISSIONS.listProjectTaskAssignments, now), taskId.toLowerCase(), { limit: page.limit, after: page.after }, now));
    return { items: found.items as unknown as Schemas['PwfAssignmentPage']['items'], next_cursor: found.next === null ? null : encodeCursor(found.next), as_of: found.asOf };
  }
}
