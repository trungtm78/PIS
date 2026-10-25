import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ControlDatabase, EntitlementOverrideStore, actingAsTenant, tenantOfOverride } from '@machvon/db';
import type { OverrideRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';

const RESOURCE_TYPE = 'entitlement_override';

export function overrideView(row: OverrideRow): Schemas['EntitlementOverride'] {
  return {
    id: row.id,
    feature_code: row.featureCode,
    enabled: row.enabled,
    ...(row.limitValue === null ? {} : { limit_value: row.limitValue }),
    reason: row.reason,
    valid_from: row.validFrom.toISOString(),
    valid_until: row.validUntil.toISOString(),
    status: row.status,
    requested_by: row.requestedBy,
    ...(row.approvedBy === null ? {} : { approved_by: row.approvedBy }),
    version: row.version,
  };
}

/**
 * The entitlement overrides of a tenant on the control plane (ST-SAS-009, SAS-25, SAS.md BR-SAS-10): a System Admin asks for an exception to the plan for a time, a
 * second one decides it (the same person cannot, and the database holds that too), and either may end it early. The commands act as the tenant of the override while
 * they write, audit and emit, so every row belongs to that tenant; the entitlement gate of the tenant reads what is in force.
 */
@Controller('system')
export class EntitlementOverrideController {
  constructor(
    @Inject(EntitlementOverrideStore) private readonly store: EntitlementOverrideStore,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
  ) {}

  @Get('tenants/:tenantId/entitlement-overrides')
  @OperationId('listTenantEntitlementOverrides')
  async list(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Schemas['EntitlementOverridePage']> {
    const known = await this.control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant where id = $1::uuid', [tenantId]));
    if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const page = parsePageRequest(limit, cursor);
    const rows = await this.control.withTenantOf(tenantId, (tx) => this.store.list(tx, { limit: page.limit + 1, after: page.after?.id }));
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return { items: items.map(overrideView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.validFrom.toISOString(), id: last.id }) : null };
  }

  @Post('tenants/:tenantId/entitlement-overrides')
  @HttpCode(201)
  @OperationId('requestEntitlementOverride')
  @Command({ operation: 'requestEntitlementOverride', plane: 'control' })
  async request(@Scope() scope: CommandScope, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: Schemas['EntitlementOverrideRequest']): Promise<CommandResult> {
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, async () => {
      const row = await this.store.request(scope.tx, {
        featureCode: body.feature_code,
        enabled: body.enabled,
        limitValue: body.limit_value,
        validFrom: new Date(body.valid_from),
        validUntil: new Date(body.valid_until),
        reason: body.reason,
        requestedBy: scope.tenant.membershipId,
        now: new Date(),
      });
      await scope.audit({
        action: 'entitlement_override.requested',
        resourceType: RESOURCE_TYPE,
        resourceId: row.id,
        reason: row.reason,
        diff: { feature_code: row.featureCode, enabled: row.enabled, limit_value: row.limitValue, valid_from: row.validFrom.toISOString(), valid_until: row.validUntil.toISOString() },
      });
      return commandResult(scope, 'PENDING_APPROVAL', row.version, row.id);
    });
  }

  @Post('entitlement-overrides/:overrideId/decision')
  @HttpCode(200)
  @OperationId('decideEntitlementOverride')
  @Command({ operation: 'decideEntitlementOverride', plane: 'control', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('overrideId', ParseUUIDPipe) overrideId: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    // The decision of the contract is shared by every approval; an override has no "return for rework": a change of mind is a new request.
    const decision = body.decision;
    if (decision === 'return') throw new DomainError('VALIDATION_FAILED', 422, 'decision', { extensions: { reason: 'DECISION_NOT_OFFERED' } });
    return this.inTenantOf(scope, overrideId, async () => {
      const row = await this.store.decide(scope.tx, { overrideId, decision, decidedBy: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0, now: new Date() });
      await scope.audit({
        action: decision === 'approve' ? 'entitlement_override.approved' : 'entitlement_override.rejected',
        resourceType: RESOURCE_TYPE,
        resourceId: row.id,
        reason: body.reason,
        diff: { feature_code: row.featureCode, status: row.status, requested_by: row.requestedBy, approved_by: row.approvedBy },
      });
      return commandResult(scope, row.status === 'Active' ? 'ACTIVE' : 'REJECTED', row.version, row.id);
    });
  }

  @Post('entitlement-overrides/:overrideId/revoke')
  @HttpCode(200)
  @OperationId('revokeEntitlementOverride')
  @Command({ operation: 'revokeEntitlementOverride', plane: 'control', versioned: true })
  async revoke(@Scope() scope: CommandScope, @Param('overrideId', ParseUUIDPipe) overrideId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return this.inTenantOf(scope, overrideId, async () => {
      const row = await this.store.revoke(scope.tx, overrideId, scope.expectedVersion ?? 0);
      await scope.audit({
        action: 'entitlement_override.revoked',
        resourceType: RESOURCE_TYPE,
        resourceId: row.id,
        reason: body.reason,
        diff: { feature_code: row.featureCode, status: row.status },
      });
      return commandResult(scope, 'REVOKED', row.version, row.id);
    });
  }

  // The path names only the override: its tenant is found first, and the work runs as that tenant (404 when no tenant has the override).
  private async inTenantOf<T>(scope: CommandScope, overrideId: string, work: () => Promise<T>): Promise<T> {
    const tenantId = await tenantOfOverride(scope.tx, overrideId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, work);
  }
}
