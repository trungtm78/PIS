import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { COMPONENT_RESOURCE, MILESTONE_RESOURCE, PrjWbsStore, TenantDatabase, WBS_EXCEEDS_TOTAL, projectScope } from '@machvon/db';
import type { ComponentChange, ComponentLine, ProjectMilestoneChange, ProjectMilestoneLine } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.get_resources_project;
const WRITE_PERMISSION = PERMISSIONS.addProjectComponent;

const MILESTONE_EVENT = 'project.milestone_updated.v1';

/** The line of the work breakdown (PRJ-05) as the contract exposes it: an allowlist. */
export function componentLineView(line: ComponentLine): Record<string, unknown> {
  return {
    id: line.id,
    parent_component_id: line.parentId,
    code: line.code,
    name: line.name,
    planned_value_vnd: line.plannedValueVnd,
    sort_order: line.sortOrder,
    valid_from: line.validFrom,
    valid_until: line.validUntil,
    depth: line.depth,
  };
}

/** The line of the milestones (PRJ-07) as the contract exposes it: an allowlist. `delayed` says in one flag what the days say in a number. */
export function milestoneLineView(line: ProjectMilestoneLine): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    name: line.name,
    component: line.component,
    baseline_date: line.baselineDate,
    planned_date: line.plannedDate,
    actual_date: line.actualDate,
    depends_on: line.dependsOn,
    status: line.status,
    reason: line.reason,
    delay_days: line.delayDays,
    delayed: line.delayDays > 0,
    version: line.version,
  };
}

/**
 * The work breakdown and the milestones of a project (ST-PRJ-009, PRJ 3.1 BR-PRJ-08, PRJ-05, PRJ-07): the commands are judged in the scope of `project.update` over the project, the reads in the scope of `project.read`.
 * A component that makes the first level add up to more than the investment total is accepted and answered with a warning; a milestone is done on a day, delayed to a later day, or cancelled, each with what it needs,
 * and the dependencies between milestones never close a loop.
 */
@Controller()
export class ProjectWbsController {
  private readonly wbs = new PrjWbsStore();

  @Post('projects/:id/components')
  @HttpCode(200)
  @OperationId('addProjectComponent')
  @Command({ operation: 'addProjectComponent' })
  async addComponent(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjComponentInput']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.wbs.addComponent(scope.tx, {
      // The identifier travels on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
      projectId: id.toLowerCase(),
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, WRITE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
    });
    await scope.audit({
      action: 'project.component_added',
      resourceType: COMPONENT_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      diff: { project_id: change.projectId, code: change.code, parent_component_id: change.parentId, planned_value_vnd: change.plannedValueVnd, depth: change.depth, exceeds_total: change.exceedsTotal },
    });
    return { ...commandResult(scope, 'ACTIVE', 1, change.id), project_id: change.projectId, warnings: warningsOf(change) };
  }

  @Post('projects/:id/milestones')
  @HttpCode(200)
  @OperationId('addProjectMilestone')
  @Command({ operation: 'addProjectMilestone' })
  async addMilestone(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjMilestoneInput']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.wbs.addMilestone(scope.tx, {
      projectId: id.toLowerCase(),
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, WRITE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      today: vietnamDateOf(now),
    });
    await scope.audit({
      action: 'project.milestone_added',
      resourceType: MILESTONE_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      diff: { project_id: change.projectId, code: change.code, baseline_date: change.baselineDate, planned_date: change.plannedDate, depends_on_milestone_id: change.dependsOnId },
    });
    return { ...commandResult(scope, change.status, change.version, change.id), project_id: change.projectId };
  }

  @Post('project-milestones/:id/progress')
  @HttpCode(200)
  @OperationId('recordMilestoneProgress')
  @Command({ operation: 'recordMilestoneProgress', versioned: true })
  async progress(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjMilestoneActual']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.wbs.recordProgress(scope.tx, {
      milestoneId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, WRITE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      today: vietnamDateOf(now),
    });
    await this.record(scope, 'project.milestone_progress', change, now);
    return this.answer(scope, change);
  }

  @Post('project-milestones/:id/dependency')
  @HttpCode(200)
  @OperationId('setMilestoneDependency')
  @Command({ operation: 'setMilestoneDependency', versioned: true })
  async dependency(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjMilestoneDependency']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const target = body.depends_on_milestone_id === null || body.depends_on_milestone_id === undefined ? null : asUuid(body.depends_on_milestone_id);
    if (target === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'depends_on_milestone_id');
    const change = await this.wbs.setDependency(scope.tx, {
      milestoneId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      dependsOnId: target,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, WRITE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      today: vietnamDateOf(now),
    });
    await this.record(scope, 'project.milestone_dependency_set', change, now);
    return this.answer(scope, change);
  }

  private answer(scope: CommandScope, change: ProjectMilestoneChange): CommandResult & Record<string, unknown> {
    return { ...commandResult(scope, change.status, change.version, change.id), project_id: change.projectId, delay_days: change.delayDays, delayed: change.delayDays > 0 };
  }

  /** The audit row (the reason of a delay or a cancellation is the reason of the row) and the event of the same transaction. */
  private async record(scope: CommandScope, action: string, change: ProjectMilestoneChange, now: Date): Promise<void> {
    await scope.audit({
      action,
      resourceType: MILESTONE_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      ...(change.reason === null ? {} : { reason: change.reason }),
      diff: {
        project_id: change.projectId,
        code: change.code,
        status: change.status,
        previous_status: change.previousStatus,
        planned_date: change.plannedDate,
        previous_planned_date: change.previousPlannedDate,
        actual_date: change.actualDate,
        depends_on_milestone_id: change.dependsOnId,
        previous_depends_on_milestone_id: change.previousDependsOnId,
        delay_days: change.delayDays,
      },
    });
    await scope.emit({
      aggregateType: MILESTONE_RESOURCE,
      aggregateId: change.id,
      aggregateVersion: change.version,
      type: MILESTONE_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        project_id: change.projectId,
        version: change.projectVersion,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        milestone_id: change.id,
        milestone_version: change.version,
        code: change.code,
        status: change.status,
        baseline_date: change.baselineDate,
        planned_date: change.plannedDate,
        actual_date: change.actualDate,
        delay_days: change.delayDays,
      },
      eventKey: `${MILESTONE_RESOURCE}:${change.id}:${change.version}`,
    });
  }
}

/** The warnings a component command answers with: the first level adding up to more than the total is told, with both figures, and never refuses the command. */
function warningsOf(change: ComponentChange): Array<Record<string, unknown>> {
  return change.exceedsTotal ? [{ code: WBS_EXCEEDS_TOTAL, wbs_total_vnd: change.wbsTotalVnd, project_total_vnd: change.projectTotalVnd }] : [];
}

/** The reads of PRJ-05 and PRJ-07 (ST-PRJ-009): the work breakdown and the milestones of a project in the scope of `project.read`. */
@Controller()
export class ProjectWbsReadsController {
  private readonly wbs = new PrjWbsStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/components')
  @OperationId('listProjectComponents')
  async components(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const register = await this.database.withTenant(tenant, (tx) => this.wbs.listComponents(tx, projectScope(access, READ_PERMISSION, now), id.toLowerCase()));
    return {
      items: register.lines.map(componentLineView),
      wbs_total_vnd: register.wbsTotalVnd,
      project_total_vnd: register.projectTotalVnd,
      exceeds_total: register.exceedsTotal,
      as_of: vietnamDateOf(now),
    };
  }

  @Get('projects/:id/milestones')
  @OperationId('listProjectMilestones')
  async milestones(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const lines = await this.database.withTenant(tenant, (tx) => this.wbs.listMilestones(tx, projectScope(access, READ_PERMISSION, now), id.toLowerCase(), today));
    return { items: lines.map(milestoneLineView), as_of: today };
  }
}
