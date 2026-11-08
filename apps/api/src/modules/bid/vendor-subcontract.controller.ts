import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, VendorSubcontractStore } from '@machvon/db';
import type { SubcontractRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { subcontractListDto } from './vendor-security-view';
import { policyDto } from './vendor-view';
import type { Caller } from './vendor-view';

const CLASSIFICATION = 'CONFIDENTIAL';
const RESOURCE = 'vendor_subcontract';

const need = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

/**
 * The commands of the subcontracts of a contract (VND-10; docs/vendor-controls-security-subcontract.md). The approval runs the assessment of the kernel against the declaration of the bid and the rule `VENDOR_SUBCONTRACT`
 * again on the day and asks the gate SUBCONTRACT of VND-1; the approver is a person other than the proposer. Each command is audited and announces an event with ids and codes only (no scope text, no amount of the payment reference).
 */
@Controller()
export class VendorSubcontractController {
  private readonly subcontracts = new VendorSubcontractStore();

  private async announce(scope: CommandScope, now: Date, action: string, row: Pick<SubcontractRow, 'id' | 'contractId' | 'subcontractorId' | 'state' | 'sharePct' | 'value' | 'version' | 'exceptionApproved'>, reason?: string, extra: Record<string, unknown> = {}): Promise<void> {
    const diff = { contract_id: row.contractId, subcontractor_id: row.subcontractorId, state: row.state, share_pct: row.sharePct, value: row.value, exception_approved: row.exceptionApproved, ...extra };
    await scope.audit({ action, resourceType: RESOURCE, resourceId: row.id, classification: CLASSIFICATION, ...(reason === undefined ? {} : { reason }), diff });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: action === 'vnd.subcontract_payment_recorded' ? 'vnd.subcontract_payment.recorded.v1' : 'vnd.subcontract.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, resource_id: row.id, version: row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), action, ...diff },
      eventKey: `${RESOURCE}:${row.id}:${row.version}:${action}:${String(extra.payment_id ?? '')}`,
    });
  }

  private version(scope: CommandScope): number {
    return scope.expectedVersion ?? 0;
  }

  @Post('vendor/bid-declarations')
  @HttpCode(200)
  @OperationId('declareVendorBidSubcontracting')
  @Command({ operation: 'declareVendorBidSubcontracting' })
  async declare(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VndBidDeclarationNew']): Promise<CommandResult> {
    need(access, PERMISSIONS.declareVendorBidSubcontracting);
    const now = new Date();
    const row = await this.subcontracts.declare(scope.tx, { packageId: body.package_id, contractorId: body.contractor_id, declaredSharePct: body.declared_share_pct, subcontractorIds: body.subcontractor_ids, documentId: body.document_id }, scope.tenant.membershipId);
    await scope.audit({ action: 'vnd.bid_declaration_declared', resourceType: 'vendor_bid_declaration', resourceId: row.id, classification: CLASSIFICATION, diff: { package_id: row.packageId, contractor_id: row.contractorId, declared_share_pct: row.declaredSharePct, subcontractor_count: row.subcontractorIds.length } });
    await scope.emit({
      aggregateType: 'vendor_bid_declaration',
      aggregateId: row.id,
      aggregateVersion: 1,
      type: 'vnd.bid_declaration.declared.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, resource_id: row.id, version: 1, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), package_id: row.packageId, contractor_id: row.contractorId, declared_share_pct: row.declaredSharePct },
      eventKey: `vendor_bid_declaration:${row.id}:declared`,
    });
    return commandResult(scope, 'DECLARED', 1, row.id);
  }

  @Post('vendor/subcontracts')
  @HttpCode(200)
  @OperationId('proposeVendorSubcontract')
  @Command({ operation: 'proposeVendorSubcontract' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VndSubcontractNew']): Promise<CommandResult> {
    need(access, PERMISSIONS.proposeVendorSubcontract);
    const row = await this.subcontracts.propose(scope.tx, { contractId: body.contract_id, subcontractorId: body.subcontractor_id, scope: body.scope, value: body.value, sharePct: body.share_pct }, scope.tenant.membershipId);
    await this.announce(scope, new Date(), 'vnd.subcontract_proposed', row);
    return commandResult(scope, 'PROPOSED', row.version, row.id);
  }

  @Post('vendor/subcontracts/:id/approve')
  @HttpCode(200)
  @OperationId('approveVendorSubcontract')
  @Command({ operation: 'approveVendorSubcontract', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VndSubcontractApprove']): Promise<CommandResult> {
    need(access, PERMISSIONS.approveVendorSubcontract);
    const now = new Date();
    const row = await this.subcontracts.approve(scope.tx, id, this.version(scope), body.exception_reason, scope.tenant.membershipId, now);
    await this.announce(scope, now, 'vnd.subcontract_approved', row, row.exceptionReason ?? undefined, { findings: row.assessment?.findings ?? [] });
    return commandResult(scope, 'APPROVED', row.version, row.id);
  }

  @Post('vendor/subcontracts/:id/reject')
  @HttpCode(200)
  @OperationId('rejectVendorSubcontract')
  @Command({ operation: 'rejectVendorSubcontract', versioned: true })
  async reject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    need(access, PERMISSIONS.rejectVendorSubcontract);
    const row = await this.subcontracts.reject(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId);
    await this.announce(scope, new Date(), 'vnd.subcontract_rejected', row, body.reason);
    return commandResult(scope, 'REJECTED', row.version, row.id);
  }

  @Post('vendor/subcontracts/:id/terminate')
  @HttpCode(200)
  @OperationId('terminateVendorSubcontract')
  @Command({ operation: 'terminateVendorSubcontract', versioned: true })
  async terminate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    need(access, PERMISSIONS.terminateVendorSubcontract);
    const row = await this.subcontracts.terminate(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId);
    await this.announce(scope, new Date(), 'vnd.subcontract_terminated', row, body.reason);
    return commandResult(scope, 'TERMINATED', row.version, row.id);
  }

  @Post('vendor/subcontracts/:id/payments')
  @HttpCode(200)
  @OperationId('recordVendorSubcontractPayment')
  @Command({ operation: 'recordVendorSubcontractPayment' })
  async pay(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VndSubcontractPaymentNew']): Promise<CommandResult> {
    need(access, PERMISSIONS.recordVendorSubcontractPayment);
    const now = new Date();
    const payment = await this.subcontracts.recordPayment(scope.tx, id, { paymentRequestId: body.payment_request_id, paidAmount: body.paid_amount, paidOn: body.paid_on, reference: body.reference }, scope.tenant.membershipId, now);
    const row = (await this.subcontracts.find(scope.tx, id)) as SubcontractRow;
    await this.announce(scope, now, 'vnd.subcontract_payment_recorded', row, undefined, { payment_id: payment.id, payment_request_id: payment.paymentRequestId, paid_amount: payment.paidAmount });
    return commandResult(scope, 'RECORDED', row.version, payment.id);
  }
}

/** The read of the subcontracts of a contract (VND-10): the rows with their payments, the totals against the declaration of the bid and the floor of the prime, and the periods whose payment nobody recorded. */
@Controller()
export class VendorSubcontractReadsController {
  private readonly subcontracts = new VendorSubcontractStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private caller(tenant: TenantContext, access: EffectiveAccess): Caller {
    return { membershipId: tenant.membershipId, holds: (permission) => holdsOnWholeTenant(access, permission) };
  }

  @Get('vendor/subcontracts')
  @OperationId('listVendorSubcontracts')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    need(access, PERMISSIONS.listVendorSubcontracts);
    const contractId = query.contract_id;
    if (typeof contractId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contractId)) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    const now = new Date();
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const listing = await this.subcontracts.list(tx, contractId, now);
      return subcontractListDto(listing, caller, policyDto('VENDOR_SUBCONTRACT', listing.policy), listing.policy.value.prime_min_share_pct, now.toISOString());
    });
  }
}
