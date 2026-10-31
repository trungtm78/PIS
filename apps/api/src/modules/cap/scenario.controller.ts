import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapScenarioStore, TenantDatabase, reallocationRecord, scenarioRecord, scenarioScope } from '@machvon/db';
import type { ScenarioRow } from '@machvon/db';
import { DomainError, effectivePermissions, holdsPermission } from '@machvon/kernel';
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
import { unitAuthorizer } from './plan-approval.service';

const RUN_PERMISSION = PERMISSIONS.runAllocationScenario;
const PROMOTE_PERMISSION = PERMISSIONS.promoteAllocationScenario;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const STATUS = /^(DRAFT|RUN|PROMOTED|ARCHIVED)$/;

/** The scenario as openapi.json exposes it (x-exposure dto): an allowlist, with what the caller may do with it. */
export function scenarioView(row: ScenarioRow, access: EffectiveAccess, now: Date): Record<string, unknown> {
  const holds = (permission: string): boolean => holdsPermission(effectivePermissions(access, now, { ownerUnitPath: row.scopeUnitPath, ownerUnitId: row.scopeUnitId }), permission);
  return {
    id: row.id,
    code: row.code,
    plan_year: row.planYear,
    base_capital_plan: { id: row.baseCapitalPlanId, plan_code: row.basePlanCode, scope_unit: { id: row.scopeUnitId, name: row.scopeUnitName } },
    input_snapshot_id: row.inputSnapshotId,
    constraints: row.constraints,
    assumptions: row.assumptions,
    result: row.result,
    status: row.status,
    promoted_proposal_id: row.promotedProposalId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    actions: { run: (row.status === 'DRAFT' || row.status === 'RUN') && holds(RUN_PERMISSION), promote: row.status === 'RUN' && holds(PROMOTE_PERMISSION) },
    version: row.version,
  };
}

/**
 * The simulation of an allocation (ST-CAP-013, CAP 3.1 F8, CAP-09): a planner states moves and limits, runs the scenario and reads each line before and after; nothing is written to the ledger or to an allocation line.
 * A scenario that has been run is promoted to a DRAFT reallocation proposal. What is read here is the scenarios on plans of the units in the scope of the caller.
 */
@Controller()
export class ScenarioController {
  private readonly scenarios = new CapScenarioStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('allocation-scenarios')
  @OperationId('listAllocationScenarios')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('plan_year') planYear?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !STATUS.test(status))) throw invalid('status');
    if (planYear !== undefined && (typeof planYear !== 'string' || !/^\d{4}$/.test(planYear))) throw invalid('plan_year');
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.scenarios.list(tx, scenarioScope(access, PERMISSIONS.listAllocationScenarios, now), {
        status,
        planYear: planYear === undefined ? undefined : Number(planYear),
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map((row) => scenarioView(row, access, now)), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null, as_of: now.toISOString() };
  }

  @Post('allocation-scenarios')
  @HttpCode(200)
  @OperationId('createAllocationScenario')
  @Command({ operation: 'createAllocationScenario' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CapScenario']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.scenarios.create(scope.tx, {
      code: body.code,
      planYear: body.plan_year,
      baseCapitalPlanId: body.base_capital_plan_id,
      inputSnapshotId: body.input_snapshot_id,
      constraints: body.constraints,
      assumptions: body.assumptions,
      actor: scope.tenant.membershipId,
      authorize: unitAuthorizer(access, PERMISSIONS.createAllocationScenario, now),
    });
    await scope.audit(scenarioRecord('created', made));
    return commandResult(scope, made.row.status, made.row.version, made.row.id);
  }

  @Post('allocation-scenarios/:id/run')
  @HttpCode(200)
  @OperationId('runAllocationScenario')
  @Command({ operation: 'runAllocationScenario', versioned: true })
  async run(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const done = await this.scenarios.run(scope.tx, { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, now, authorize: unitAuthorizer(access, RUN_PERMISSION, now) });
    await scope.audit(scenarioRecord('run', done));
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  @Post('allocation-scenarios/:id/promote')
  @HttpCode(200)
  @OperationId('promoteAllocationScenario')
  @Command({ operation: 'promoteAllocationScenario', versioned: true })
  async promote(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const done = await this.scenarios.promote(scope.tx, { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, now, authorize: unitAuthorizer(access, PROMOTE_PERMISSION, now) });
    await scope.audit(reallocationRecord('drafted', done.proposal));
    await scope.audit(scenarioRecord('promoted', done));
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }
}
