import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjRiskStore, RISK_RESOURCE, TenantDatabase, projectScope } from '@machvon/db';
import type { RiskChange, RiskLine } from '@machvon/db';
import { DomainError, RISK_STATUSES, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, RiskStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.get_resources_project;
const MANAGE_PERMISSION = PERMISSIONS.registerProjectRisk;

const REGISTERED_EVENT = 'project.risk_registered.v1';
const UPDATED_EVENT = 'project.risk_updated.v1';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The line of the register (PRJ-16) as the contract exposes it: an allowlist, so a column added to the table later is not shown until it is listed here. */
export function riskLineView(line: RiskLine): Record<string, unknown> {
  return {
    id: line.id,
    code: line.code,
    category_master_version_id: line.categoryMasterVersionId,
    category_label: line.categoryLabel,
    title: line.title,
    description: line.description,
    likelihood: line.likelihood,
    impact: line.impact,
    score: line.score,
    level: line.level,
    owner: { membership_id: line.owner.membershipId, display_name: line.owner.displayName },
    mitigation: line.mitigation,
    due_date: line.dueDate,
    overdue: line.overdue,
    linked_issue_id: line.linkedIssueId,
    status: line.status,
    closed_reason: line.closedReason,
    version: line.version,
    updated_at: line.updatedAt,
  };
}

/** The part of an event that every change of a risk shares: the minimum of the module and what the change did to the risk. */
function eventPayload(scope: CommandScope, change: RiskChange, now: Date): Record<string, unknown> {
  return {
    tenant_id: scope.tenant.tenantId,
    project_id: change.projectId,
    version: change.projectVersion,
    actor_id: scope.tenant.membershipId,
    occurred_at: now.toISOString(),
    risk_id: change.id,
    risk_version: change.version,
    code: change.code,
    status: change.status,
    likelihood: change.likelihood,
    impact: change.impact,
    score: change.score,
    severity: change.level,
    owner_membership_id: change.ownerMembershipId,
    due_date: change.dueDate,
  };
}

/**
 * The risk register of a project (ST-PRJ-010, PRJ 3.1 F8, BR-PRJ-07): a risk is written with a likelihood and an impact, the server scores it, and from 15 it
 * is critical and reaches the executive warnings through its event. The commands are judged in the scope of `project.risk.manage` over the project, and the
 * register is read in the scope of `project.read`.
 */
@Controller()
export class ProjectRiskController {
  private readonly risks = new PrjRiskStore();

  @Post('projects/:id/risks')
  @HttpCode(200)
  @OperationId('registerProjectRisk')
  @Command({ operation: 'registerProjectRisk' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjRiskEntry']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.risks.register(scope.tx, {
      // The identifier travels on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
      projectId: id.toLowerCase(),
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, MANAGE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      now,
    });
    await this.record(scope, 'project.risk_registered', REGISTERED_EVENT, change, now);
    return this.answer(scope, change);
  }

  @Post('project-risks/:id/update')
  @HttpCode(200)
  @OperationId('updateProjectRisk')
  @Command({ operation: 'updateProjectRisk', versioned: true })
  async update(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjRiskEntry']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.risks.update(scope.tx, {
      riskId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, MANAGE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      now,
    });
    await this.record(scope, 'project.risk_updated', UPDATED_EVENT, change, now);
    return this.answer(scope, change);
  }

  @Post('project-risks/:id/closure')
  @HttpCode(200)
  @OperationId('closeProjectRisk')
  @Command({ operation: 'closeProjectRisk', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjRiskClosure']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.risks.close(scope.tx, {
      riskId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, MANAGE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
    });
    await this.record(scope, 'project.risk_closed', UPDATED_EVENT, change, now);
    return this.answer(scope, change);
  }

  private answer(scope: CommandScope, change: RiskChange): CommandResult & Record<string, unknown> {
    return { ...commandResult(scope, change.status, change.version, change.id), project_id: change.projectId, score: change.score, level: change.level };
  }

  /** The audit row and the event of the same transaction. The reason of an end goes in the audit row's reason, not in its diff. */
  private async record(scope: CommandScope, action: string, eventType: string, change: RiskChange, now: Date): Promise<void> {
    await scope.audit({
      action,
      resourceType: RISK_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      ...(change.closedReason === null ? {} : { reason: change.closedReason }),
      diff: {
        project_id: change.projectId,
        code: change.code,
        status: change.status,
        previous_status: change.previousStatus,
        score: change.score,
        severity: change.level,
        changed: change.changed,
      },
    });
    await scope.emit({
      aggregateType: RISK_RESOURCE,
      aggregateId: change.id,
      aggregateVersion: change.version,
      type: eventType,
      schemaVersion: 1,
      payload: eventPayload(scope, change, now),
      eventKey: `${RISK_RESOURCE}:${change.id}:${change.version}`,
    });
  }
}

/** The read of PRJ-16 (ST-PRJ-010): the register of a project in the scope of the caller, and the live risks by likelihood and impact for the matrix. */
@Controller()
export class ProjectRiskReadsController {
  private readonly risks = new PrjRiskStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/risks')
  @OperationId('listProjectRisks')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !RISK_STATUSES.some((known) => known === status))) throw invalid('status');
    const now = new Date();
    const projectId = asUuid(id);
    if (projectId === undefined) throw invalid('id');
    const register = await this.database.withTenant(tenant, (tx) =>
      this.risks.list(tx, projectScope(access, READ_PERMISSION, now), {
        projectId,
        status: status as RiskStatus | undefined,
        today: vietnamDateOf(now),
        limit: request.limit + 1,
        after: request.after,
      }),
    );
    const shown = register.lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(riskLineView),
      next_cursor: register.lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.rankKey, id: last.id }) : null,
      matrix: register.matrix.map((cell) => ({ likelihood: cell.likelihood, impact: cell.impact, score: cell.score, level: cell.level, count: cell.count })),
      live_count: register.liveCount,
      critical_count: register.criticalCount,
      overdue_count: register.overdueCount,
      as_of: vietnamDateOf(now),
    };
  }
}
