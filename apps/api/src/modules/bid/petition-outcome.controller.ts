import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidPetitionOutcomeStore, TenantDatabase, projectScope } from '@machvon/db';
import type { PetitionOutcomeLine } from '@machvon/db';
import { DomainError, asUuid, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const RECORD = PERMISSIONS.recordProcurementPetitionOutcome;
const CONFIRM = PERMISSIONS.confirmProcurementPetitionOutcome;
const READ = PERMISSIONS.listProcurementPetitionOutcomes;
const RESOURCE = 'procurement_petition_outcome';
const EVENT = 'bid.petition.outcome.changed.v1';
const STATUSES = ['PROPOSED', 'CONFIRMED', 'RETURNED'];

const refsOf = (line: PetitionOutcomeLine): ResourceRef[] =>
  [line.reach.ownerUnit, ...(line.reach.investorUnit === null ? [] : [line.reach.investorUnit])].map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId: line.projectId }));

/** An outcome as BID-34 reads it (an allowlist). The confirm and return buttons show only to a different person who holds the right over the project; the server judges the command again, and a conflict of interest is judged there. */
export function outcomeDto(line: PetitionOutcomeLine, access: EffectiveAccess, viewer: string, now: Date): Record<string, unknown> {
  const proposed = line.status === 'PROPOSED';
  const mayConfirm = proposed && line.recordedBy !== viewer && refsOf(line).some((ref) => holdsPermission(effectivePermissions(access, now, ref), CONFIRM));
  return {
    id: line.id,
    petition_id: line.petitionId,
    package: { id: line.package.id, code: line.package.code },
    contractor: { id: line.contractor.id, legal_name: line.contractor.legalName },
    petition_status: line.petitionStatus,
    outcome: line.outcome,
    decision_ref: line.decisionRef,
    decision_on: line.decisionOn,
    decision_document_id: line.decisionDocumentId,
    note: line.note,
    status: line.status,
    recorded_by_name: line.recordedByName,
    recorded_at: line.recordedAt,
    checked_by_name: line.checkedByName,
    checked_at: line.checkedAt,
    return_reason: line.returnReason,
    actions: { confirm: mayConfirm, return: mayConfirm },
    version: line.version,
  };
}

/**
 * The recorded outcome of a petition of a contractor (PORTAL-2, BID-34; docs/vendor-investigation.md section 14). A person of the scope of `bid.petition.outcome.record` records what the authority decided (upheld, rejected or
 * withdrawn, with the reference); a different person of `bid.petition.outcome.confirm` confirms it or returns it with a reason; whoever has a conflict of interest with the contractor or the package does neither. Only confirmed
 * outcomes feed the dispute figures of VND-22. The audit row and the event carry ids, codes and dates, never the words of a note or a reason.
 */
@Controller()
export class PetitionOutcomeController {
  private readonly outcomes = new BidPetitionOutcomeStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private async written(scope: CommandScope, line: PetitionOutcomeLine, action: string, now: Date, reason?: string): Promise<void> {
    await scope.audit({
      action,
      resourceType: RESOURCE,
      resourceId: line.id,
      classification: 'INTERNAL',
      ...(reason === undefined ? {} : { reason }),
      diff: { petition_id: line.petitionId, package_id: line.package.id, contractor_id: line.contractor.id, outcome: line.outcome, status: line.status, decision_on: line.decisionOn, decision_document_id: line.decisionDocumentId },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: line.id,
      aggregateVersion: line.version,
      type: EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, resource_id: line.id, version: line.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), action, petition_id: line.petitionId, package_id: line.package.id, contractor_id: line.contractor.id, outcome: line.outcome, status: line.status },
      eventKey: `${RESOURCE}:${line.id}:${line.version}:${action}`,
    });
  }

  @Post('procurement-petitions/:id/outcome')
  @HttpCode(200)
  @OperationId('recordProcurementPetitionOutcome')
  @Command({ operation: 'recordProcurementPetitionOutcome' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidPetitionOutcomeRecord']): Promise<CommandResult> {
    const now = new Date();
    const line = await this.outcomes.record(
      scope.tx,
      id.toLowerCase(),
      { outcome: body.outcome, decisionRef: body.decision_ref, decisionOn: body.decision_on, decisionDocumentId: body.decision_document_id, note: body.note },
      scope.tenant.membershipId,
      projectScope(access, RECORD, now),
    );
    await this.written(scope, line, 'petition.outcome_recorded', now);
    return commandResult(scope, line.status, line.version, line.id);
  }

  @Post('procurement-petition-outcomes/:id/confirmation')
  @HttpCode(200)
  @OperationId('confirmProcurementPetitionOutcome')
  @Command({ operation: 'confirmProcurementPetitionOutcome', versioned: true })
  async confirm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const line = await this.outcomes.confirm(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, projectScope(access, CONFIRM, now), now);
    await this.written(scope, line, 'petition.outcome_confirmed', now);
    return commandResult(scope, line.status, line.version, line.id);
  }

  @Post('procurement-petition-outcomes/:id/return')
  @HttpCode(200)
  @OperationId('returnProcurementPetitionOutcome')
  @Command({ operation: 'returnProcurementPetitionOutcome', versioned: true })
  async returnOutcome(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidPetitionOutcomeReturn']): Promise<CommandResult> {
    const now = new Date();
    const line = await this.outcomes.returnOutcome(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason, projectScope(access, CONFIRM, now), now);
    await this.written(scope, line, 'petition.outcome_returned', now, body.reason);
    return commandResult(scope, line.status, line.version, line.id);
  }

  @Get('procurement-petition-outcomes')
  @OperationId('listProcurementPetitionOutcomes')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('petition_id') petitionId?: unknown,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const petition = petitionId === undefined ? undefined : typeof petitionId === 'string' ? asUuid(petitionId) : undefined;
    if (petitionId !== undefined && petition === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'petition_id');
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const now = new Date();
    const lines = await this.database.withTenant(tenant, (tx) => this.outcomes.list(tx, projectScope(access, READ, now), { petitionId: petition?.toLowerCase(), status }));
    return { items: lines.map((line) => outcomeDto(line, access, tenant.membershipId, now)), as_of: now.toISOString() };
  }
}
