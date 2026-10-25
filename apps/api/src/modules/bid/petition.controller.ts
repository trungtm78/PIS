import { Body, Controller, Get, HttpCode, Inject, Post, Query, Param, ParseUUIDPipe } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidPetitionStore, TenantDatabase, projectScope } from '@machvon/db';
import type { BidPetitionLine, BidPetitionResult } from '@machvon/db';
import { DomainError, OPEN_PETITION_STATUSES, asUuid, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const RECEIVE_PERMISSION = PERMISSIONS.receiveProcurementPetition;
const RESOLVE_PERMISSION = PERMISSIONS.resolveProcurementPetition;
const READ_PERMISSION = PERMISSIONS.listProcurementPetitions;
const RESOURCE_TYPE = 'procurement_petition';
const CLASSIFICATION = 'INTERNAL';

const person = (who: { membershipId: string; displayName: string } | null): Record<string, unknown> | null => (who === null ? null : { membership_id: who.membershipId, display_name: who.displayName });

/** The places the package lies in for the permission test: the units that own and invest in its project. */
const refsOf = (line: BidPetitionLine): ResourceRef[] =>
  [line.reach.ownerUnit, ...(line.reach.investorUnit === null ? [] : [line.reach.investorUnit])].map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId: line.projectId }));

/**
 * A petition as BID-20 reads it: an allowlist of what it is. The caller may answer it while it waits (or was passed on to the level above) and when they hold the permission over the
 * project and no conflict of interest of their own stands between them and the petition; the server judges the command again.
 */
export function petitionDto(line: BidPetitionLine, access: EffectiveAccess, now: Date): Record<string, unknown> {
  const answerable = OPEN_PETITION_STATUSES.includes(line.status) || line.status === 'ESCALATED';
  const permitted = refsOf(line).some((ref) => holdsPermission(effectivePermissions(access, now, ref), RESOLVE_PERMISSION));
  return {
    id: line.id,
    package: { id: line.package.id, code: line.package.code },
    project_id: line.projectId,
    contractor: { id: line.contractor.id, legal_name: line.contractor.legalName },
    petition_kind: line.petitionKind,
    received_on: line.receivedOn,
    due_on: line.dueOn,
    days_applied: line.daysApplied,
    status: line.status,
    overdue: line.overdue,
    days_overdue: line.daysOverdue,
    petition_document_id: line.petitionDocumentId,
    resolution_document_id: line.resolutionDocumentId,
    viewer_in_conflict: line.viewerInConflict,
    handled_by: person(line.handledBy),
    resolved_at: line.resolvedAt,
    created_by: line.createdBy,
    created_at: line.createdAt,
    actions: { resolve: answerable && permitted && !line.viewerInConflict },
    version: line.version,
  };
}

/**
 * The petitions of contractors about the selection of a contractor (ST-BID-007, BID 3 F7, BR-BID-14). A planner of the scope of `bid.petition.manage` logs a petition of a contractor about
 * the process or the result of a package: the last day to answer comes from the rule data in force on the day it is received. The petition is answered with a document, or passed on to
 * the level above with one; whoever has a conflict of interest with the contractor or the package does not answer it, another person does. Status, deadline, rule and version are written
 * by no body.
 */
@Controller()
export class PetitionController {
  private readonly petitions = new BidPetitionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('procurement-petitions')
  @HttpCode(200)
  @OperationId('receiveProcurementPetition')
  @Command({ operation: 'receiveProcurementPetition' })
  async receive(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidPetitionReceive']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.petitions.receive(
      scope.tx,
      { packageId: body.package_id, contractorId: body.contractor_id, petitionKind: body.petition_kind, receivedOn: body.received_on, petitionDocumentId: body.petition_document_id },
      scope.tenant.membershipId,
      projectScope(access, RECEIVE_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'petition.received', 'bid.petition.received.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('procurement-petitions/:id/resolution')
  @HttpCode(200)
  @OperationId('resolveProcurementPetition')
  @Command({ operation: 'resolveProcurementPetition', versioned: true })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidPetitionResolve']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.petitions.resolve(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { outcome: body.outcome, resolutionDocumentId: body.resolution_document_id }, scope.tenant.membershipId, projectScope(access, RESOLVE_PERMISSION, now), now);
    await this.written(scope, done, done.status === 'ESCALATED' ? 'petition.escalated' : 'petition.resolved', done.status === 'ESCALATED' ? 'bid.petition.escalated.v1' : 'bid.petition.resolved.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Get('procurement-petitions')
  @OperationId('listProcurementPetitions')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('package_id') packageId?: unknown,
    @Query('overdue') overdue?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const filter = packageId === undefined ? undefined : typeof packageId === 'string' ? asUuid(packageId) : undefined;
    if (packageId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'package_id');
    if (overdue !== undefined && overdue !== 'true' && overdue !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'overdue');
    const now = new Date();
    const lines = await this.database.withTenant(tenant, (tx) =>
      this.petitions.list(tx, projectScope(access, READ_PERMISSION, now), tenant.membershipId, { packageId: filter?.toLowerCase(), overdueOnly: overdue === 'true' }, now),
    );
    return { items: lines.map((line) => petitionDto(line, access, now)), as_of: now.toISOString() };
  }

  /** The audit row and the event of a command: ids, codes, dates and statuses, never the words of the petition or the name of the contractor. */
  private async written(scope: CommandScope, done: BidPetitionResult, action: string, type: string, now: Date): Promise<void> {
    const facts = {
      package_id: done.packageId,
      package_code: done.packageCode,
      project_id: done.projectId,
      contractor_id: done.contractorId,
      petition_kind: done.petitionKind,
      received_on: done.receivedOn,
      due_on: done.dueOn,
      days_applied: done.daysApplied,
      rule_version_id: done.ruleVersionId,
      petition_document_id: done.petitionDocumentId,
      resolution_document_id: done.resolutionDocumentId,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts, late: done.late },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, petition_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, late: done.late, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}
