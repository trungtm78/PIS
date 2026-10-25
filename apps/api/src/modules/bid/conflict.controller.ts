import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidConflictStore, TenantDatabase, projectScope } from '@machvon/db';
import type { DeclarationLine } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const DECLARE_PERMISSION = PERMISSIONS.declareConflictOfInterest;
const DECIDE_PERMISSION = PERMISSIONS.decideConflictOfInterest;
const READ_PERMISSION = PERMISSIONS.listConflictDeclarations;
const RESOURCE_TYPE = 'bid_conflict_declaration';

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** A declaration as the screen reads it: an allowlist of what it is. */
export function declarationDto(line: DeclarationLine, caller: string): Record<string, unknown> {
  return {
    id: line.id,
    package_id: line.packageId,
    member: { membership_id: line.member.membershipId, display_name: line.member.displayName },
    has_conflict: line.hasConflict,
    relation_text: line.relationText,
    contractor: line.contractor === null ? null : { id: line.contractor.id, legal_name: line.contractor.legalName },
    declared_at: line.declaredAt,
    decision: line.decision,
    decision_reason: line.decisionReason,
    decided_by: line.decidedBy === null ? null : { membership_id: line.decidedBy.membershipId, display_name: line.decidedBy.displayName },
    decided_at: line.decidedAt,
    standing: line.standing,
    is_own: line.member.membershipId === caller,
    version: line.version,
  };
}

/**
 * The declaration of conflict of interest (ST-BID-004, BID 3 F3, BR-BID-03): a member of the evaluation team of the scope of `bid.evaluate` declares once per package, before
 * they see a bid, whether a relation stands between them and a bidder. A conflict is decided by someone of the scope of `bid.conflict.decide` who is not the member: allowed,
 * recused (from the bidder, or from the whole package when none is named) or blocked (from the whole package). Until a conflict is decided the member sees none of what it
 * covers. The relation is told in words to the people who decide and is left out of the audit trail and the events.
 */
@Controller()
export class ConflictController {
  private readonly store = new BidConflictStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('procurement-packages/:id/conflict-declarations')
  @HttpCode(200)
  @OperationId('declareConflictOfInterest')
  @Command({ operation: 'declareConflictOfInterest' })
  async declare(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['BidConflictDeclare'],
  ): Promise<CommandResult> {
    const now = new Date();
    const made = await this.store.declare(
      scope.tx,
      {
        packageId: id.toLowerCase(),
        hasConflict: body.has_conflict,
        relationText: body.relation_text,
        contractorId: body.contractor_id === undefined ? undefined : idOf(body.contractor_id, 'contractor_id'),
      },
      scope.tenant.membershipId,
      projectScope(access, DECLARE_PERMISSION, now),
    );
    await scope.audit({
      action: 'bid.conflict_declared',
      resourceType: RESOURCE_TYPE,
      resourceId: made.id,
      diff: { package_code: made.packageCode, has_conflict: made.hasConflict, contractor_id: made.contractorId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: made.id,
      aggregateVersion: made.version,
      type: 'bid.conflict.declared.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        declaration_id: made.id,
        package_id: made.packageId,
        project_id: made.projectId,
        member_id: scope.tenant.membershipId,
        has_conflict: made.hasConflict,
        contractor_id: made.contractorId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${made.id}:${made.version}`,
    });
    return commandResult(scope, made.hasConflict ? 'PENDING' : 'CLEAR', made.version, made.id);
  }

  @Post('bid-conflict-declarations/:id/decision')
  @HttpCode(200)
  @OperationId('decideConflictOfInterest')
  @Command({ operation: 'decideConflictOfInterest', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['BidConflictDecision'],
  ): Promise<CommandResult> {
    const now = new Date();
    const decided = await this.store.decide(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      body.decision,
      body.decision_reason,
      scope.tenant.membershipId,
      projectScope(access, DECIDE_PERMISSION, now),
    );
    await scope.audit({
      action: 'bid.conflict_decided',
      resourceType: RESOURCE_TYPE,
      resourceId: decided.id,
      diff: {
        package_code: decided.packageCode,
        member_id: decided.memberId,
        contractor_id: decided.contractorId,
        decision: decided.decision,
        previous_decision: decided.previousDecision,
        reports_reopened: decided.reportsReopened,
      },
      reason: body.decision_reason.trim(),
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: decided.id,
      aggregateVersion: decided.version,
      type: 'bid.conflict.decided.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        declaration_id: decided.id,
        package_id: decided.packageId,
        project_id: decided.projectId,
        member_id: decided.memberId,
        contractor_id: decided.contractorId,
        decision: decided.decision,
        previous_decision: decided.previousDecision,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${decided.id}:${decided.version}`,
    });
    return commandResult(scope, decided.decision, decided.version, decided.id);
  }

  @Get('procurement-packages/:id/conflict-declarations')
  @OperationId('listConflictDeclarations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ items: Array<Record<string, unknown>>; may_decide: boolean; as_of: string }> {
    const now = new Date();
    const packageId = id.toLowerCase();
    const { lines, mayDecide } = await this.database.withTenant(tenant, async (tx) => {
      // A package outside the scope of the caller is indistinguishable from one that does not exist.
      if (!(await this.store.reaches(tx, packageId, projectScope(access, READ_PERMISSION, now)))) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const mayDecide = await this.store.reaches(tx, packageId, projectScope(access, DECIDE_PERMISSION, now));
      const lines = await this.store.list(tx, packageId, { membershipId: tenant.membershipId, mayDecide }, projectScope(access, READ_PERMISSION, now));
      return { lines, mayDecide };
    });
    return { items: lines.map((line) => declarationDto(line, tenant.membershipId)), may_decide: mayDecide, as_of: now.toISOString() };
  }
}
