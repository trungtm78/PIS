import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, VendorPolicyReader, VendorSecurityStore } from '@machvon/db';
import type { SecurityRow } from '@machvon/db';
import { DomainError, SECURITY_STATES } from '@machvon/kernel';
import type { EffectiveAccess, SecurityKind, SecurityState, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { securityDto, securityEventDto, standingDto } from './vendor-security-view';
import { policyDto, todayOf } from './vendor-view';
import type { Caller } from './vendor-view';

const CLASSIFICATION = 'CONFIDENTIAL';
const RESOURCE = 'vendor_bid_security';

const uuidOf = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

const need = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

/**
 * The commands of the bid security register (VND-09; docs/vendor-controls-security-subcontract.md). Each runs in one transaction with its audit row and its outbox event (ids and codes only), judged by the kernel
 * machine and the rule `VENDOR_BID_SECURITY`; the register belongs to the whole tenant, so each needs its permission through a grant on the whole tenant. The actor is the caller; the separation of duties (confirmation
 * by a person other than the receiver, the decision of a forfeiture by a person other than the proposer) is enforced by the store and again by the database.
 */
@Controller()
export class VendorSecurityController {
  private readonly securities = new VendorSecurityStore();

  private async announce(scope: CommandScope, now: Date, action: string, row: SecurityRow, move: string, reason?: string): Promise<void> {
    await scope.audit({
      action,
      resourceType: RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { package_id: row.packageId, contractor_id: row.contractorId, state: row.state, move, amount: row.amount, required_amount: row.requiredAmount, factor_applied: row.factorApplied },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'vnd.bid_security.changed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        resource_id: row.id,
        version: row.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        action,
        move,
        state: row.state,
        package_id: row.packageId,
        contractor_id: row.contractorId,
        // A forfeited security stands for a behaviour of the ledger of bid conduct: the hook the investor representative reads (never posted automatically).
        conduct_behaviour: row.conductBehaviour,
      },
      eventKey: `${RESOURCE}:${row.id}:${row.version}:${action}`,
    });
  }

  private version(scope: CommandScope): number {
    return scope.expectedVersion ?? 0;
  }

  @Post('vendor/bid-securities')
  @HttpCode(200)
  @OperationId('receiveVendorBidSecurity')
  @Command({ operation: 'receiveVendorBidSecurity' })
  async receive(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VndBidSecurityNew']): Promise<CommandResult> {
    need(access, PERMISSIONS.receiveVendorBidSecurity);
    const now = new Date();
    const row = await this.securities.receive(
      scope.tx,
      { packageId: body.package_id, contractorId: body.contractor_id, kind: body.kind as SecurityKind, issuer: body.issuer, securityNo: body.security_no, amount: body.amount, issuedOn: body.issued_on, validUntil: body.valid_until, documentId: body.document_id },
      scope.tenant.membershipId,
      now,
    );
    await this.announce(scope, now, 'vnd.bid_security_received', row, 'RECEIVE');
    return commandResult(scope, 'RECEIVED', row.version, row.id);
  }

  @Post('vendor/bid-securities/:id/confirm')
  @HttpCode(200)
  @OperationId('confirmVendorBidSecurity')
  @Command({ operation: 'confirmVendorBidSecurity', versioned: true })
  async confirm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VndBidSecurityConfirm']): Promise<CommandResult> {
    need(access, PERMISSIONS.confirmVendorBidSecurity);
    const now = new Date();
    const row = await this.securities.confirm(scope.tx, id, this.version(scope), body.issuer_reference, scope.tenant.membershipId, now);
    await this.announce(scope, now, 'vnd.bid_security_confirmed', row, 'CONFIRM');
    return commandResult(scope, 'CONFIRMED', row.version, row.id);
  }

  @Post('vendor/bid-securities/:id/reject')
  @HttpCode(200)
  @OperationId('rejectVendorBidSecurity')
  @Command({ operation: 'rejectVendorBidSecurity', versioned: true })
  async reject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorReason']): Promise<CommandResult> {
    need(access, PERMISSIONS.rejectVendorBidSecurity);
    const now = new Date();
    const row = await this.securities.reject(scope.tx, id, this.version(scope), body.reason, scope.tenant.membershipId, now);
    await this.announce(scope, now, 'vnd.bid_security_rejected', row, 'REJECT', body.reason);
    return commandResult(scope, 'REJECTED', row.version, row.id);
  }

  @Post('vendor/bid-securities/:id/propose-forfeiture')
  @HttpCode(200)
  @OperationId('proposeVendorBidSecurityForfeiture')
  @Command({ operation: 'proposeVendorBidSecurityForfeiture', versioned: true })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VndForfeitProposal']): Promise<CommandResult> {
    need(access, PERMISSIONS.proposeVendorBidSecurityForfeiture);
    const now = new Date();
    const row = await this.securities.proposeForfeiture(scope.tx, id, this.version(scope), body.reason_code, body.reason, scope.tenant.membershipId, now);
    await this.announce(scope, now, 'vnd.bid_security_forfeiture_proposed', row, 'PROPOSE_FORFEIT', body.reason);
    return commandResult(scope, 'FORFEIT_PROPOSED', row.version, row.id);
  }

  @Post('vendor/bid-securities/:id/withdraw-forfeiture')
  @HttpCode(200)
  @OperationId('withdrawVendorBidSecurityForfeiture')
  @Command({ operation: 'withdrawVendorBidSecurityForfeiture', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    need(access, PERMISSIONS.withdrawVendorBidSecurityForfeiture);
    const now = new Date();
    const row = await this.securities.withdrawForfeiture(scope.tx, id, this.version(scope), scope.tenant.membershipId, now);
    await this.announce(scope, now, 'vnd.bid_security_forfeiture_withdrawn', row, 'WITHDRAW_FORFEIT');
    return commandResult(scope, 'CONFIRMED', row.version, row.id);
  }

  @Post('vendor/bid-securities/:id/decide-forfeiture')
  @HttpCode(200)
  @OperationId('decideVendorBidSecurityForfeiture')
  @Command({ operation: 'decideVendorBidSecurityForfeiture', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VndForfeitDecision']): Promise<CommandResult> {
    need(access, PERMISSIONS.decideVendorBidSecurityForfeiture);
    const now = new Date();
    const row = await this.securities.decideForfeiture(scope.tx, id, this.version(scope), { decision: body.decision, reason: body.reason, decisionDocumentId: body.decision_document_id }, scope.tenant.membershipId, now);
    const forfeited = body.decision === 'FORFEIT';
    await this.announce(scope, now, forfeited ? 'vnd.bid_security_forfeited' : 'vnd.bid_security_forfeiture_refused', row, forfeited ? 'DECIDE_FORFEIT' : 'REFUSE_FORFEIT', body.reason);
    return commandResult(scope, row.state, row.version, row.id);
  }

  @Post('vendor/bid-securities/:id/release')
  @HttpCode(200)
  @OperationId('releaseVendorBidSecurity')
  @Command({ operation: 'releaseVendorBidSecurity', versioned: true })
  async release(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VndSecurityRelease']): Promise<CommandResult> {
    need(access, PERMISSIONS.releaseVendorBidSecurity);
    const now = new Date();
    const expired = body.expired === true;
    const row = await this.securities.release(scope.tx, id, this.version(scope), body.reason, expired, scope.tenant.membershipId, now);
    await this.announce(scope, now, expired ? 'vnd.bid_security_expired' : 'vnd.bid_security_released', row, expired ? 'EXPIRE' : 'RELEASE', body.reason);
    return commandResult(scope, row.state, row.version, row.id);
  }
}

/** The reads of the bid security register (VND-09): the list with the amount the package asks of a bidder, and one security with its ledger. */
@Controller()
export class VendorSecurityReadsController {
  private readonly securities = new VendorSecurityStore();
  private readonly policies = new VendorPolicyReader();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private caller(tenant: TenantContext, access: EffectiveAccess): Caller {
    return { membershipId: tenant.membershipId, holds: (permission) => holdsOnWholeTenant(access, permission) };
  }

  @Get('vendor/bid-securities')
  @OperationId('listVendorBidSecurities')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    need(access, PERMISSIONS.listVendorBidSecurities);
    const now = new Date();
    const today = todayOf(now);
    const packageId = uuidOf(query.package_id, 'package_id');
    const contractorId = uuidOf(query.contractor_id, 'contractor_id');
    const state = query.state;
    if (state !== undefined && (typeof state !== 'string' || !(SECURITY_STATES as readonly string[]).includes(state))) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policies.bidSecurity(tx, today);
      const rows = await this.securities.list(tx, { packageId, contractorId, state: state as SecurityState | undefined, limit }, today);
      const standing = packageId !== undefined && contractorId !== undefined ? await this.securities.standing(tx, packageId, contractorId, today) : null;
      return {
        items: rows.map((row) => securityDto(row, caller)),
        standing: standing === null || packageId === undefined || contractorId === undefined ? null : standingDto(packageId, contractorId, standing),
        policy: policyDto('VENDOR_BID_SECURITY', policy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/bid-securities/:id')
  @OperationId('getVendorBidSecurity')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    need(access, PERMISSIONS.getVendorBidSecurity);
    const now = new Date();
    const today = todayOf(now);
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.securities.find(tx, id, today);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const standing = await this.securities.standing(tx, row.packageId, row.contractorId, today);
      return {
        security: securityDto(row, caller),
        events: (await this.securities.events(tx, id)).map(securityEventDto),
        standing: standing === null ? null : standingDto(row.packageId, row.contractorId, standing),
        policy: policyDto('VENDOR_BID_SECURITY', await this.policies.bidSecurity(tx, today)),
        as_of: now.toISOString(),
      };
    });
  }
}
