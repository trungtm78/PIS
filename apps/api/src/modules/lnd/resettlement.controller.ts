import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndResettlementStore, RESETTLEMENT_ALLOCATED_EVENT, RESETTLEMENT_RESOURCE, TenantDatabase, householdScopeUnits } from '@machvon/db';
import type { AllocationLine, Candidate, TenantTx } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { projectRefs, reaches } from './reach';

const ALLOCATE_PERMISSION = PERMISSIONS.allocateResettlement;
const READ_PERMISSION = PERMISSIONS.listResettlementAllocations;
/** An allocation names a household: the trail of it is classified as personal data and carries the ids and the unit, never the household's words. */
const CLASSIFICATION = 'PERSONAL';

/** The allocation as the contract exposes it: an allowlist, the household in its masked form only. */
export function allocationView(line: AllocationLine): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    household: { id: line.household.id, household_code: line.household.code, head_name: line.household.headName },
    plan_item_id: line.planItemId,
    owner_unit_id: line.ownerUnitId,
    unit_kind: line.unitKind,
    unit_code: line.unitCode,
    site_text: line.siteText,
    area_m2: line.areaM2,
    priority_rank: line.priorityRank,
    allocated_on: line.allocatedOn,
    handed_on: line.handedOn,
    status: line.status,
    version: line.version,
  };
}

export function candidateView(candidate: Candidate): Record<string, unknown> {
  return {
    plan_item_id: candidate.planItemId,
    plan_id: candidate.planId,
    household: { id: candidate.household.id, household_code: candidate.household.code, head_name: candidate.household.headName },
    owner_unit_id: candidate.ownerUnitId,
    item_kind: candidate.itemKind,
    unit_kinds: candidate.unitKinds,
  };
}

/**
 * The resettlement of the households (ST-LND-012, LND 3.1, UC-LND-01, LND-12, UAT-PLAN-31): a plot, a flat or a house goes to one household at a time, on an item of its approved plan (409 `UNIT_ALREADY_ALLOCATED`, 422
 * `HOUSEHOLD_NOT_ELIGIBLE` with the reason). The right to allocate is `land.resettle.write`, held over the project and inside the units of the household; the household is shown masked only, and the trail and the event
 * carry ids and the unit, never the words of the household.
 */
@Controller()
export class ResettlementController {
  private readonly source = new LndLandSource();
  private readonly allocations = new LndResettlementStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('resettlement-allocations')
  @HttpCode(200)
  @OperationId('allocateResettlement')
  @Command({ operation: 'allocateResettlement' })
  async allocate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndAllocateResettlement']): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, ALLOCATE_PERMISSION, now);
    const place = await this.allocations.householdPlace(scope.tx, body.household_id, units);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.mayAct(scope.tx, access, place.projectId, now);
    const done = await this.allocations.allocate(
      scope.tx,
      {
        householdId: body.household_id,
        planItemId: body.plan_item_id,
        ownerUnitId: body.owner_unit_id,
        unitKind: body.unit_kind,
        unitCode: body.unit_code,
        siteText: body.site_text,
        areaM2: body.area_m2,
        priorityRank: body.priority_rank,
      },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'lnd.resettlement_allocated',
      resourceType: RESETTLEMENT_RESOURCE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: { project_id: done.projectId, household_id: done.householdId, plan_item_id: done.planItemId, unit_kind: done.unitKind, unit_code: done.unitCode, allocated_on: done.allocatedOn },
    });
    await scope.emit({
      aggregateType: RESETTLEMENT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: RESETTLEMENT_ALLOCATED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        allocation_id: done.id,
        project_id: done.projectId,
        household_id: done.householdId,
        plan_item_id: done.planItemId,
        owner_unit_id: done.ownerUnitId,
        unit_kind: done.unitKind,
        allocated_on: done.allocatedOn,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESETTLEMENT_RESOURCE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, 'ALLOCATED', done.version, done.id);
  }

  /** The project has to exist for the caller (they reach it with the right to read or to act): a project they cannot see is 404, one they see and may not act on is 403. */
  private async mayAct(tx: TenantTx, access: EffectiveAccess, projectId: string, now: Date): Promise<void> {
    const project = await this.source.projectRef(tx, projectId);
    const refs = project === undefined ? [] : projectRefs(project);
    if (project === undefined || ![ALLOCATE_PERMISSION, READ_PERMISSION].some((seeing) => reaches(access, seeing, refs, now))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, ALLOCATE_PERMISSION, refs, now)) throw new DomainError('SCOPE_DENIED', 403);
  }
}

/** The allocations and the candidates of a project (LND-12) inside the units of the reader. */
@Controller()
export class ResettlementReadsController {
  private readonly source = new LndLandSource();
  private readonly allocations = new LndResettlementStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resettlement-allocations')
  @OperationId('listResettlementAllocations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = typeof project === 'string' ? asUuid(project) : undefined;
    if (projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      // A project the caller cannot reach has no allocations for them.
      const place = await this.source.projectRef(tx, projectId.toLowerCase());
      if (place === undefined || !reaches(access, READ_PERMISSION, projectRefs(place), now)) return [];
      return this.allocations.list(tx, { projectId, status }, await householdScopeUnits(tx, access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after });
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(allocationView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null, as_of: now.toISOString() };
  }

  @Get('resettlement-allocations/candidates')
  @OperationId('listResettlementCandidates')
  async candidates(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = typeof project === 'string' ? asUuid(project) : undefined;
    if (projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      const place = await this.source.projectRef(tx, projectId.toLowerCase());
      if (place === undefined || !reaches(access, READ_PERMISSION, projectRefs(place), now)) return [];
      return this.allocations.candidates(tx, projectId, await householdScopeUnits(tx, access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after });
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(candidateView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.household.code, id: last.planItemId }) : null, as_of: now.toISOString() };
  }
}
