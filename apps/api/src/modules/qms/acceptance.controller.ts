import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { QmsAcceptanceStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, QmsAcceptanceResult } from '@machvon/db';
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
import { acceptanceActionsOf, acceptanceView } from './acceptance-view';
import type { AcceptancePermissions } from './acceptance-view';

const CREATE_PERMISSION = PERMISSIONS.createQualityAcceptance;
const SIGN_PERMISSION = PERMISSIONS.signQualityAcceptance;
const APPROVE_PERMISSION = PERMISSIONS.decideQualityAcceptance;
const REVOKE_PERMISSION = PERMISSIONS.revokeQualityAcceptance;
const READ_PERMISSION = PERMISSIONS.listQualityAcceptances;
const RESOURCE_TYPE = 'quality_acceptance';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: AcceptancePermissions = { sign: SIGN_PERMISSION, approve: APPROVE_PERMISSION, revoke: REVOKE_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The quality acceptance minutes of an inspection (ST-QMS-005, QMS 3.2). The supervisor drafts minutes from an inspection that passed; the roles the regime of the day required sign
 * them over one hash of what they say, the contractor as the contractor and the staff for the side of the procuring entity; and someone other than whoever drafted them approves them once
 * every role has signed and no serious non-conformance of the contract is open (422 `SIGNATURES_INCOMPLETE`, 422 `OPEN_CRITICAL_NCR`). Approval emits `qms.quality_acceptance.approved.v1` once,
 * which the acceptance of work (CTR) takes; revoking approved minutes emits `.revoked.v1` and is refused while an approved acceptance holds them (409 `ACCEPTANCE_ALREADY_USED`).
 */
@Controller()
export class AcceptanceController {
  private readonly acceptances = new QmsAcceptanceStore();

  @Post('inspections/:id/quality-acceptances')
  @HttpCode(200)
  @OperationId('createQualityAcceptance')
  @Command({ operation: 'createQualityAcceptance' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsCreateQualityAcceptance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.create(
      scope.tx,
      id.toLowerCase(),
      { acceptanceScope: body.acceptance_scope, recordNo: body.record_no, documentVersionId: body.document_version_id },
      scope.tenant.membershipId,
      scopesFor(access, CREATE_PERMISSION, now),
    );
    await this.written(scope, done, 'quality_acceptance.drafted', 'qms.quality_acceptance.drafted.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('quality-acceptances/:id/sign')
  @HttpCode(200)
  @OperationId('signQualityAcceptance')
  @Command({ operation: 'signQualityAcceptance', versioned: true })
  async sign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsSignQualityAcceptance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.sign(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { signerRole: body.signer_role, signatureMethod: body.signature_method, certSerial: body.cert_serial, clientOperationId: body.client_operation_id },
      scope.tenant.membershipId,
      scopesFor(access, SIGN_PERMISSION, now),
      now,
    );
    await this.written(scope, done, 'quality_acceptance.signed', 'qms.quality_acceptance.signed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('quality-acceptances/:id/decision')
  @HttpCode(200)
  @OperationId('decideQualityAcceptance')
  @Command({ operation: 'decideQualityAcceptance', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsDecideQualityAcceptance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.decide(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { decision: body.decision, reason: body.reason }, scope.tenant.membershipId, scopesFor(access, APPROVE_PERMISSION, now), now);
    // Approving emits qms.quality_acceptance.approved.v1 (once: the event key is the version it was approved at); rejecting is only audited, with the reason.
    await this.written(scope, done, done.status === 'APPROVED' ? 'quality_acceptance.approved' : 'quality_acceptance.rejected', done.status === 'APPROVED' ? 'qms.quality_acceptance.approved.v1' : undefined, now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('quality-acceptances/:id/revoke')
  @HttpCode(200)
  @OperationId('revokeQualityAcceptance')
  @Command({ operation: 'revokeQualityAcceptance', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsRevokeQualityAcceptance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.revoke(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, REVOKE_PERMISSION, now), now);
    await this.written(scope, done, 'quality_acceptance.revoked', 'qms.quality_acceptance.revoked.v1', now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, codes, dates, roles and statuses, never the words of a reason beyond the audit row that keeps them. */
  private async written(scope: CommandScope, done: QmsAcceptanceResult, action: string, type: string | undefined, now: Date, reason?: string): Promise<void> {
    const facts = {
      record_no: done.recordNo,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      inspection_id: done.inspectionId,
      boq_item_id: done.boqItemId,
      acceptance_scope: done.acceptanceScope,
      required_roles: done.requiredRoles,
      missing_roles: done.missingRoles,
      regime_rule_version_id: done.regimeRuleVersionId,
      regime_awaiting_confirmation: done.regimeAwaitingConfirmation,
      signer_role: done.signerRole,
      signature_method: done.signatureMethod,
      legal_effect: done.legalEffect,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    if (type === undefined) return;
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, quality_acceptance_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

/** The minutes of the contracts in the scope of the caller (the right to read them is `qacceptance.read`; a guest contractor holds it over its own contract). */
@Controller('quality-acceptances')
export class AcceptanceReadsController {
  private readonly acceptances = new QmsAcceptanceStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listQualityAcceptances')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('contract_id') contractId?: unknown,
    @Query('inspection_id') inspectionId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const filterOf = (name: string, value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      const parsed = typeof value === 'string' ? asUuid(value) : undefined;
      if (parsed === undefined) throw new DomainError('VALIDATION_FAILED', 422, name);
      return parsed.toLowerCase();
    };
    const contract = filterOf('contract_id', contractId);
    const inspection = filterOf('inspection_id', inspectionId);
    const now = new Date();
    const lines = await this.database.withTenant(tenant, (tx) => this.acceptances.list(tx, contractScope(access, READ_PERMISSION, now), tenant.membershipId, { contractId: contract, inspectionId: inspection }));
    return { items: lines.map((line) => acceptanceView(line, acceptanceActionsOf(line, access, now, ACTION_PERMISSIONS))), as_of: now.toISOString() };
  }

  @Get(':id')
  @OperationId('getQualityAcceptance')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const line = await this.database.withTenant(tenant, (tx) => this.acceptances.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now), tenant.membershipId));
    // Minutes in another tenant or outside the scope of the caller are indistinguishable from minutes that do not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return acceptanceView(line, acceptanceActionsOf(line, access, now, ACTION_PERMISSIONS));
  }
}
