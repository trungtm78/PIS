import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { IamSupportTicketStore, TICKET_STATUSES, TenantDatabase } from '@machvon/db';
import type { TicketRow, TicketStatus } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const RESOURCE_TYPE = 'support_ticket';
/** Held on the whole tenant, it shows every ticket of the tenant and not only the caller's own. */
const MANAGE_PERMISSION = 'support.ticket.manage';
const STATUS_VALUES: readonly string[] = TICKET_STATUSES;

/** A ticket as the list shows it: the metadata and the SLA, an explicit allowlist; what the member wrote is not part of it, and neither is who asked (only whether it is the caller's). */
function ticketView(row: TicketRow, membershipId: string): Record<string, unknown> {
  return {
    id: row.id,
    ticket_code: row.ticketCode,
    category: row.category,
    subject: row.subject,
    priority: row.priority,
    status: row.status,
    sla_due_at: row.slaDueAt,
    created_at: row.createdAt,
    attachment_count: row.attachmentCount,
    own: row.requesterMembershipId.toLowerCase() === membershipId.toLowerCase(),
    version: row.version,
  };
}

/**
 * The support ticket of a member (ST-IAM-007, IAM 3.6): any member asks for help; the ticket gets its code SUP-YYYY-NNNNNN, a priority from what it is
 * about and the time by which the operator must have answered. The operator of the platform sees the metadata and the SLA, never the business data of the
 * tenant: to see it they ask for a support access, which the tenant owner approves (SAS-19).
 */
@Controller()
export class SupportTicketController {
  private readonly tickets = new IamSupportTicketStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('support-tickets')
  @HttpCode(200)
  @OperationId('createSupportTicket')
  @Command({ operation: 'createSupportTicket' })
  async create(@Scope() scope: CommandScope, @Body() body: Schemas['SupportTicketCreate']): Promise<CommandResult> {
    const now = new Date();
    const created = await this.tickets.create(scope.tx, { category: body.category, subject: body.subject, description: body.description, attachmentIds: body.attachment_ids }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'support.ticket_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { ticket_code: created.ticketCode, category: created.category, priority: created.priority, sla_due_at: created.slaDueAt.toISOString(), on_calendar: created.onCalendar, attachment_count: created.attachmentCount },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'iam.support_ticket.created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        ticket_id: created.id,
        ticket_code: created.ticketCode,
        category: created.category,
        priority: created.priority,
        sla_due_at: created.slaDueAt.toISOString(),
        requester_membership_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  /**
   * The tickets of the caller (IAM-08), newest first: their own, or every ticket of the tenant for someone who holds the management of support on the
   * whole tenant. The text a member wrote is not in the answer.
   */
  @Get('resources/support_ticket')
  @OperationId('get_resources_support_ticket')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !STATUS_VALUES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const filter = { requester: holdsOnWholeTenant(access, MANAGE_PERMISSION) ? undefined : tenant.membershipId, status: status as TicketStatus | undefined };
    const rows = await this.database.withTenant(tenant, (tx) => this.tickets.list(tx, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => ticketView(row, tenant.membershipId)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }
}
