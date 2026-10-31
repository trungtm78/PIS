import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ENFORCEMENT_ADVANCED_EVENT, ENFORCEMENT_RESOURCE, ENFORCEMENT_STARTED_EVENT, LndEnforcementStore, LndLandSource, TenantDatabase, householdScopeUnits, unitInScope } from '@machvon/db';
import type { EnforcementLine, EnforcementResult, ScopeUnits, TenantTx } from '@machvon/db';
import { DomainError, asUuid, stepAfter, vietnamDateOf } from '@machvon/kernel';
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

const ENFORCE_PERMISSION = PERMISSIONS.startEnforcement;
const READ_PERMISSION = PERMISSIONS.listEnforcementCases;
/** A case names a household and a parcel: the trail of it is classified as personal data and carries the ids and the steps, never the words of the household. */
const CLASSIFICATION = 'PERSONAL';

/** The case as the contract exposes it: an allowlist, the household in its masked form only, and what the caller may do with it. */
export function enforcementView(line: EnforcementLine, caller: { memberId: string; mayEnforce: boolean; enforceUnits: ScopeUnits }): Record<string, unknown> {
  // A suspended case goes back to the step it was suspended from, except the persuasion, which is not entered again: it goes on to the notice.
  const next = line.step === 'SUSPENDED' ? (line.suspendedFrom === 'PERSUASION' ? stepAfter('PERSUASION') : line.suspendedFrom) : stepAfter(line.step);
  const mine = line.draftedBy.toLowerCase() === caller.memberId.toLowerCase();
  // The right to enforce is held over the project and inside the units of the household: a case outside them is read but not acted on.
  const mayAct = caller.mayEnforce && unitInScope(caller.enforceUnits, line.ownerUnitId) && !mine;
  return {
    id: line.id,
    project_id: line.projectId,
    parcel: { id: line.parcel.id, parcel_code: line.parcel.code, status: line.parcel.status },
    household: line.household === null ? null : { id: line.household.id, household_code: line.household.code, head_name: line.household.headName },
    plan_id: line.planId,
    owner_unit_id: line.ownerUnitId,
    authority_unit_id: line.authorityUnitId,
    step: line.step,
    suspended_from: line.suspendedFrom,
    started_on: line.startedOn,
    decision_document_version_id: line.decisionDocumentVersionId,
    planned_on: line.plannedOn,
    executed_on: line.executedOn,
    legal_basis: line.legalBasis,
    suspend_reason: line.suspendReason,
    allowed: { advance: mayAct && line.step !== 'COMPLETED', suspend: mayAct && line.step !== 'COMPLETED' && line.step !== 'SUSPENDED', next: next ?? null },
    version: line.version,
  };
}

/**
 * The enforcement of a land recovery (ST-LND-011, LND 3.3, UC-LND-03, LND-09, UAT-AC385). A case is opened for a parcel whose recovery was decided, for a household that was offered the money (422
 * `PRECONDITION_NOT_MET`, 422 `PAYMENT_NOT_OFFERED`), and goes through its steps one after the other, each decision with its document (422 `DECISION_DOCUMENT_REQUIRED`), by someone other than the person who drew it up
 * (403 `SELF_APPROVAL_DENIED`); execution puts the parcel under enforcement. The right is `land.enforce.write`, held over the project and inside the units of the household; the household is shown masked only, and the trail and
 * the event carry ids and the steps, never the words of the household.
 */
@Controller()
export class EnforcementController {
  private readonly source = new LndLandSource();
  private readonly cases = new LndEnforcementStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('land-enforcement-cases')
  @HttpCode(200)
  @OperationId('startEnforcement')
  @Command({ operation: 'startEnforcement' })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndStartEnforcement']): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, ENFORCE_PERMISSION, now);
    await this.mayAct(scope.tx, access, body.project_id, now);
    const done = await this.cases.start(
      scope.tx,
      {
        projectId: body.project_id,
        parcelId: body.parcel_id,
        householdId: body.household_id,
        planId: body.plan_id,
        ownerUnitId: body.owner_unit_id,
        authorityUnitId: body.authority_unit_id,
        legalBasis: body.legal_basis,
        startedOn: body.started_on,
      },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await this.written(scope, done, 'lnd.enforcement_started', ENFORCEMENT_STARTED_EVENT, now);
    return commandResult(scope, done.step, done.version, done.id);
  }

  @Post('land-enforcement-cases/:id/advance')
  @HttpCode(200)
  @OperationId('advanceEnforcement')
  @Command({ operation: 'advanceEnforcement', versioned: true })
  async advance(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndAdvanceEnforcement'],
  ): Promise<CommandResult> {
    const now = new Date();
    const units = await householdScopeUnits(scope.tx, access, ENFORCE_PERMISSION, now);
    const place = await this.cases.casePlace(scope.tx, id.toLowerCase(), units);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.mayAct(scope.tx, access, place.projectId, now);
    const done = await this.cases.advance(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { toStep: body.to_step, decisionDocumentVersionId: body.decision_document_version_id, plannedOn: body.planned_on, executedOn: body.executed_on, suspendReason: body.suspend_reason },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await this.written(scope, done, 'lnd.enforcement_advanced', ENFORCEMENT_ADVANCED_EVENT, now);
    return commandResult(scope, done.step, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, the steps and the days; the words of the household and the reason of a suspension stay in the table. */
  private async written(scope: CommandScope, done: EnforcementResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      project_id: done.projectId,
      parcel_id: done.parcelId,
      household_id: done.householdId,
      plan_id: done.planId,
      owner_unit_id: done.ownerUnitId,
      authority_unit_id: done.authorityUnitId,
      started_on: done.startedOn,
      decision_document_version_id: done.decisionDocumentVersionId,
      planned_on: done.plannedOn,
      executed_on: done.executedOn,
    };
    await scope.audit({ action, resourceType: ENFORCEMENT_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_step: done.fromStep, to_step: done.step, ...facts } });
    await scope.emit({
      aggregateType: ENFORCEMENT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, case_id: done.id, ...facts, step: done.step, from_step: done.fromStep, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${ENFORCEMENT_RESOURCE}:${done.id}:${done.version}`,
    });
  }

  /** The project has to exist for the caller (they reach it with the right to read or to act): a project they cannot see is 404, one they see and may not act on is 403. */
  private async mayAct(tx: TenantTx, access: EffectiveAccess, projectId: string, now: Date): Promise<void> {
    const wanted = asUuid(projectId);
    const project = wanted === undefined ? undefined : await this.source.projectRef(tx, wanted.toLowerCase());
    const refs = project === undefined ? [] : projectRefs(project);
    if (project === undefined || ![ENFORCE_PERMISSION, READ_PERMISSION].some((seeing) => reaches(access, seeing, refs, now))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, ENFORCE_PERMISSION, refs, now)) throw new DomainError('SCOPE_DENIED', 403);
  }
}

/** The cases of a project (LND-09) inside the units of the reader. */
@Controller()
export class EnforcementReadsController {
  private readonly source = new LndLandSource();
  private readonly cases = new LndEnforcementStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('land-enforcement-cases')
  @OperationId('listEnforcementCases')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') project?: unknown,
    @Query('step') step?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const projectId = typeof project === 'string' ? asUuid(project) : undefined;
    if (projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    if (step !== undefined && typeof step !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'step');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      // A project the caller cannot reach has no cases for them.
      const place = await this.source.projectRef(tx, projectId.toLowerCase());
      if (place === undefined || !reaches(access, READ_PERMISSION, projectRefs(place), now)) return { lines: [] as EnforcementLine[], mayEnforce: false, enforceUnits: '' };
      return {
        lines: await this.cases.list(tx, { projectId, step }, await householdScopeUnits(tx, access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }),
        mayEnforce: reaches(access, ENFORCE_PERMISSION, projectRefs(place), now),
        enforceUnits: await householdScopeUnits(tx, access, ENFORCE_PERMISSION, now),
      };
    });
    const shown = rows.lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => enforcementView(line, { memberId: tenant.membershipId, mayEnforce: rows.mayEnforce, enforceUnits: rows.enforceUnits })),
      next_cursor: rows.lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
