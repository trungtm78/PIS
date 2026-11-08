import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LOOK_AHEAD_CONSTRAINT_RESOURCE, LOOK_AHEAD_ITEM_RESOURCE, LOOK_AHEAD_RESOURCE, PrjLookAheadStore, TenantDatabase, projectScope } from '@machvon/db';
import type { LookAheadPlanView, LookAheadView } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { snakeKeys } from '../../snake-case';
import { CurrentTenant } from '../../tenant-context.decorator';

const CLASSIFICATION = 'INTERNAL';

export function lookAheadViewOf(view: LookAheadView, now: Date): Record<string, unknown> {
  return {
    project: view.project,
    plan: view.plan === null ? null : snakeKeys(view.plan),
    history: snakeKeys(view.history),
    overdue: view.overdue,
    rule: {
      version: view.rule.version,
      source: view.rule.source,
      unverified: view.rule.unverified,
      params: snakeKeys(view.rule.policy),
      provenance: view.rule.provenance === null ? null : { formula: view.rule.provenance.formula, source: view.rule.provenance.source, as_of: view.rule.provenance.asOf, legal_status: view.rule.provenance.legalStatus },
    },
    as_of: now.toISOString(),
  };
}

/**
 * The look-ahead plan of a project (G1-19, QMS and PRJ): the rolling plan of the next 2 to 6 weeks with the constraints of each item of work, and the record of what was done at the end of the week (PPC). Every
 * command is audited and idempotent, carries the version of what it changes, and leaves an event; a person sees and changes only the projects in the scope of their grant.
 */
@Controller()
export class LookAheadController {
  private readonly store = new PrjLookAheadStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/look-ahead')
  @OperationId('getLookAhead')
  async read(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query('plan_id', new ParseUUIDPipe({ optional: true })) planId?: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, (tx) => this.store.view(tx, projectScope(access, PERMISSIONS.getLookAhead, now), id.toLowerCase(), now, planId?.toLowerCase()));
    return lookAheadViewOf(view, now);
  }

  @Post('projects/:id/look-ahead-plans')
  @HttpCode(200)
  @OperationId('createLookAheadPlan')
  @Command({ operation: 'createLookAheadPlan' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLookAheadPlanCreate']): Promise<CommandResult> {
    const now = new Date();
    const plan = await this.store.create(scope.tx, projectScope(access, PERMISSIONS.createLookAheadPlan, now), {
      projectId: id.toLowerCase(),
      weekStart: body.week_start,
      horizonWeeks: body.horizon_weeks,
      items: body.items.map((item) => ({ description: item.description, plannedStart: item.planned_start, plannedFinish: item.planned_finish, responsible: item.responsible ?? null })),
      actor: scope.tenant.membershipId,
      now,
    });
    await this.record(scope, 'project.look_ahead_plan_created', 'project.look_ahead_plan_created.v1', plan, now, { week_start: plan.weekStart, horizon_weeks: plan.horizonWeeks, items: plan.items.length });
    return commandResult(scope, plan.status, plan.version, plan.id);
  }

  @Post('look-ahead-plans/:id/publish')
  @HttpCode(200)
  @OperationId('publishLookAheadPlan')
  @Command({ operation: 'publishLookAheadPlan', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const plan = await this.store.publish(scope.tx, projectScope(access, PERMISSIONS.publishLookAheadPlan, now), { planId: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, now });
    await this.record(scope, 'project.look_ahead_plan_published', 'project.look_ahead_plan_published.v1', plan, now, { week_start: plan.weekStart, items: plan.items.length });
    return commandResult(scope, plan.status, plan.version, plan.id);
  }

  @Post('look-ahead-items/:id/constraints')
  @HttpCode(200)
  @OperationId('raiseLookAheadConstraint')
  @Command({ operation: 'raiseLookAheadConstraint' })
  async raise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLookAheadConstraintRaise']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.raiseConstraint(scope.tx, projectScope(access, PERMISSIONS.raiseLookAheadConstraint, now), {
      itemId: id.toLowerCase(),
      kind: body.kind,
      description: body.description,
      ownerMembershipId: body.owner_membership_id,
      dueOn: body.due_on,
      actor: scope.tenant.membershipId,
      now,
    });
    await this.recordChild(scope, 'project.look_ahead_constraint_raised', 'project.look_ahead_constraint_raised.v1', LOOK_AHEAD_CONSTRAINT_RESOURCE, done.constraintId, done, 1, now, { kind: body.kind });
    return commandResult(scope, 'OPEN', 1, done.constraintId);
  }

  @Post('look-ahead-constraints/:id/clear')
  @HttpCode(200)
  @OperationId('clearLookAheadConstraint')
  @Command({ operation: 'clearLookAheadConstraint', versioned: true })
  async clear(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLookAheadConstraintClear']): Promise<CommandResult> {
    const now = new Date();
    const expected = scope.expectedVersion ?? 0;
    const done = await this.store.clearConstraint(scope.tx, projectScope(access, PERMISSIONS.clearLookAheadConstraint, now), { constraintId: id.toLowerCase(), expectedVersion: expected, note: body.note, actor: scope.tenant.membershipId, now });
    await this.recordChild(scope, 'project.look_ahead_constraint_cleared', 'project.look_ahead_constraint_cleared.v1', LOOK_AHEAD_CONSTRAINT_RESOURCE, done.constraintId, done, expected + 1, now, {});
    return commandResult(scope, 'CLEARED', expected + 1, done.constraintId);
  }

  @Post('look-ahead-items/:id/outcome')
  @HttpCode(200)
  @OperationId('recordLookAheadOutcome')
  @Command({ operation: 'recordLookAheadOutcome', versioned: true })
  async outcome(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjLookAheadOutcome']): Promise<CommandResult> {
    const now = new Date();
    const expected = scope.expectedVersion ?? 0;
    const done = await this.store.recordOutcome(scope.tx, projectScope(access, PERMISSIONS.recordLookAheadOutcome, now), { itemId: id.toLowerCase(), expectedVersion: expected, outcome: body.outcome, reasonCode: body.reason_code, actor: scope.tenant.membershipId, now });
    await this.recordChild(scope, 'project.look_ahead_outcome_recorded', 'project.look_ahead_outcome_recorded.v1', LOOK_AHEAD_ITEM_RESOURCE, done.itemId, done, expected + 1, now, { outcome: done.outcome, reason_code: body.reason_code ?? null });
    return commandResult(scope, done.outcome, expected + 1, done.itemId);
  }

  private async record(scope: CommandScope, action: string, type: string, plan: LookAheadPlanView, now: Date, facts: Record<string, unknown>): Promise<void> {
    await scope.audit({ action, resourceType: LOOK_AHEAD_RESOURCE, resourceId: plan.id, classification: CLASSIFICATION, diff: { project_id: plan.projectId, status: plan.status, ...facts } });
    await scope.emit({
      aggregateType: LOOK_AHEAD_RESOURCE,
      aggregateId: plan.id,
      aggregateVersion: plan.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: plan.projectId, plan_id: plan.id, status: plan.status, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${LOOK_AHEAD_RESOURCE}:${plan.id}:${plan.version}:${action}`,
    });
  }

  private async recordChild(scope: CommandScope, action: string, type: string, resource: string, resourceId: string, done: { projectId: string; planId: string; itemId?: string }, version: number, now: Date, facts: Record<string, unknown>): Promise<void> {
    await scope.audit({ action, resourceType: resource, resourceId, classification: CLASSIFICATION, diff: { project_id: done.projectId, plan_id: done.planId, ...facts } });
    await scope.emit({
      aggregateType: resource,
      aggregateId: resourceId,
      aggregateVersion: version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: done.projectId, plan_id: done.planId, [`${resource}_id`]: resourceId, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${resource}:${resourceId}:${version}:${action}`,
    });
  }
}
