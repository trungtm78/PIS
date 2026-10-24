import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapPlanRevisionStore, TenantDatabase, planReadScope } from '@machvon/db';
import type { PlanAsOf } from '@machvon/db';
import { DomainError, asUuid, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { lineView } from './plan-view';

const RESOURCE_TYPE = 'capital_plan';
const REVISE_PERMISSION = PERMISSIONS.createCapitalPlanRevision;
const AS_OF_PERMISSION = PERMISSIONS.getCapitalPlanAsOf;
const REASON_MIN = 10;
const REASON_MAX = 2000;

/** What the plan said at the moment asked for: the revision in force with its decision, and each line against what the first revision gave it. */
function asOfView(found: PlanAsOf): Record<string, unknown> {
  return {
    capital_plan_id: found.capitalPlanId,
    plan_code: found.planCode,
    revision: found.revision,
    status: found.status,
    decision_document_id: found.decisionDocumentId,
    effective_at: found.effectiveAt,
    as_of: found.asOf,
    truncated: found.truncated,
    totals: {
      amount_vnd: found.totals.amountVnd,
      initial_vnd: found.totals.initialVnd,
      adjustment_vnd: found.totals.adjustmentVnd,
      disbursed_vnd: found.totals.disbursedVnd,
    },
    lines: found.lines.map((row) => ({ ...lineView(row.line), initial_vnd: row.initialVnd, adjustment_vnd: row.adjustmentVnd, as_of_disbursed_vnd: row.disbursedVnd })),
  };
}

/**
 * The revision of a published capital plan (ST-CAP-004, CAP 3.1 F3): the plan in force is copied into a DRAFT revision that the planner edits with
 * the drafting command, and the plan can be read as it stood on any date, so that an adjustment is traceable and a past report can be explained.
 */
@Controller('capital-plans')
export class CapitalPlanRevisionController {
  private readonly revisions = new CapPlanRevisionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post(':id/revisions')
  @HttpCode(200)
  @OperationId('createCapitalPlanRevision')
  @Command({ operation: 'createCapitalPlanRevision', versioned: true })
  async revise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapPlanRevision']): Promise<CommandResult> {
    const reason = body.reason.trim();
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const now = new Date();
    const created = await this.revisions.create(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, (unit) => {
      if (!holdsPermission(effectivePermissions(access, now, { ownerUnitPath: unit.path, ownerUnitId: unit.id }), REVISE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
    });
    await scope.audit({
      action: 'capital.plan_revision_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      reason,
      diff: { plan_code: created.planCode, revision: created.revision, supersedes_id: created.supersedesId, copied_projects: created.projects, copied_lines: created.lines },
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Get(':id/as-of')
  @OperationId('getCapitalPlanAsOf')
  async asOf(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('at') at?: unknown,
    @Query('project_id') projectId?: unknown,
  ): Promise<Record<string, unknown>> {
    if (at !== undefined && typeof at !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'at');
    const project = projectId === undefined ? undefined : asUuid(projectId);
    if (projectId !== undefined && project === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const now = new Date();
    const scope = planReadScope(access, AS_OF_PERMISSION, now);
    const found = await this.database.withTenant(tenant, (tx) => this.revisions.asOf(tx, id, at, project, scope, now));
    // A plan of another tenant, and a moment before any revision came into force, are not something to read.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return asOfView(found);
  }
}
