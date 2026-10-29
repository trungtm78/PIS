import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { SupportAccessStore, TenantDatabase, actingAsTenant } from '@machvon/db';
import type { ApprovalEffects, SupportGrantRow } from '@machvon/db';
import { DomainError, isSupportGrantLive, supportStatusAt } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const STATUSES = ['Requested', 'Approved', 'Active', 'Expired', 'Revoked', 'Rejected'] as const;

/**
 * A grant as the tenant sees it (SAS.md 3.6 "DTO riêng"): who asked and for what, when, how long, who approved. The status is the one at the time of the read, so a grant whose window ended is Expired before the pass of
 * the lifecycle job says so; `in_force` is the judgment the guard makes on each request of the operator.
 */
export function supportGrantView(row: SupportGrantRow, now: Date): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    ticket_reference: row.ticketReference,
    operator_id: row.operatorId,
    access_mode: row.accessMode,
    status: supportStatusAt(row, now),
    in_force: isSupportGrantLive(row, now),
    scope: { modules: [...row.modules], resource_ids: [...row.resourceIds] },
    duration_minutes: row.durationMinutes,
    request_reason: row.requestReason,
    requested_at: row.requestedAt.toISOString(),
    starts_at: row.startsAt?.toISOString() ?? null,
    expires_at: row.expiresAt.toISOString(),
    approved_by: row.ownerApprovedBy,
    second_approver_id: row.secondApproverId,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    revoke_reason: row.revokeReason,
    version: row.version,
  };
}

function effectsOf(scope: CommandScope): ApprovalEffects {
  return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
}

/**
 * The request of a Support Operator (ST-SAS-015, SAS-19): a control-plane command, permission `system.support.request`. It acts as the tenant while it reads the ticket and writes the grant, so the row, the audit and the
 * event belong to the tenant, which is the one that must decide. Nothing is given by it: the grant waits for the people of the tenant.
 */
@Controller('support-access')
export class SupportAccessRequestController {
  constructor(@Inject(SupportAccessStore) private readonly store: SupportAccessStore) {}

  @Post()
  @HttpCode(201)
  @OperationId('requestSupportAccess')
  @Command({ operation: 'requestSupportAccess', plane: 'control' })
  async request(@Scope() scope: CommandScope, @Body() body: Schemas['SupportAccessRequest']): Promise<CommandResult> {
    const grant = await actingAsTenant(scope.tx, body.tenant_id, scope.tenant.tenantId, () =>
      this.store.request(
        scope.tx,
        effectsOf(scope),
        {
          tenantId: body.tenant_id,
          operatorId: scope.tenant.membershipId,
          ticketReference: body.ticket_reference,
          modules: body.scope.modules,
          resourceIds: body.scope.resource_ids ?? [],
          accessMode: body.access_mode,
          durationMinutes: body.duration_minutes,
          reason: body.reason,
        },
        new Date(),
      ),
    );
    return commandResult(scope, 'REQUESTED', grant.version, grant.id);
  }
}

/**
 * What the tenant does with a request (permission `tenant.support.approve`, held by the owner and the administrators of the tenant): approve or reject it, and revoke a grant at any time. A grant of another tenant is
 * not found.
 */
@Controller('support-access')
export class SupportAccessController {
  constructor(@Inject(SupportAccessStore) private readonly store: SupportAccessStore) {}

  @Post(':id/approve')
  @HttpCode(200)
  @OperationId('post_support_access_id_approve')
  @Command({ operation: 'post_support_access_id_approve', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SupportAccessApproval']): Promise<CommandResult> {
    const grant = await this.store.decide(
      scope.tx,
      effectsOf(scope),
      { grantId: id, approverId: scope.tenant.membershipId, decision: body.decision, startsAt: body.starts_at === undefined ? undefined : new Date(body.starts_at), reason: body.reason, expectedVersion: scope.expectedVersion ?? undefined },
      new Date(),
    );
    return commandResult(scope, grant.status.toUpperCase(), grant.version, grant.id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @OperationId('revokeSupportAccess')
  @Command({ operation: 'revokeSupportAccess', versioned: true })
  async revoke(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const grant = await this.store.revoke(scope.tx, effectsOf(scope), id, body.reason, scope.expectedVersion ?? undefined, new Date());
    return commandResult(scope, 'REVOKED', grant.version, grant.id);
  }
}

/** The grants of the caller's own tenant (get_resources_support_access_grant and its id form), the newest request first. */
@Controller('resources/support_access_grant')
export class SupportAccessReadsController {
  constructor(
    @Inject(SupportAccessStore) private readonly store: SupportAccessStore,
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
  ) {}

  @Get()
  @OperationId('get_resources_support_access_grant')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('status') status?: unknown,
    @Query('in_force') inForce?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const page = parsePageRequest(limit, cursor);
    if (status !== undefined && !(typeof status === 'string' && (STATUSES as readonly string[]).includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (inForce !== undefined && inForce !== 'true' && inForce !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'in_force');
    // The cursor of this list is the instant of the request and the id.
    if (page.after !== undefined && Number.isNaN(Date.parse(page.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    // One instant for the filter and for the view of each grant: what is asked for is what is shown.
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, { limit: page.limit + 1, now, after: page.after === undefined ? undefined : { requestedAt: page.after.code, id: page.after.id }, status: status as (typeof STATUSES)[number] | undefined, ...(inForce === undefined ? {} : { inForce: inForce === 'true' }) }),
    );
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => supportGrantView(row, now)),
      next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.requestedAt.toISOString(), id: last.id }) : null,
    };
  }

  @Get(':id')
  @OperationId('get_resources_support_access_grant_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return supportGrantView(row, new Date());
  }
}
