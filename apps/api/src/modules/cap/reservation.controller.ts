import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapReservationStore, RESERVATION_RESOURCE, RESERVATION_STATUSES, TenantDatabase, projectScope } from '@machvon/db';
import type { FundReservationRow, ReservationFilter, ReservationStatus } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
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

const MANAGE_PERMISSION = PERMISSIONS.createFundReservation;
const READ_PERMISSION = PERMISSIONS.listFundReservations;
const CREATED_EVENT = 'capital.reservation_created.v1';
const RELEASED_EVENT = 'capital.reservation_released.v1';

/** The reservation as the contract exposes it: an allowlist. */
export function reservationView(row: FundReservationRow): Record<string, unknown> {
  return {
    id: row.id,
    allocation_line_id: row.allocationLineId,
    project: row.project,
    plan_year: row.planYear,
    purpose: row.purpose,
    reference_kind: row.referenceKind,
    reference_id: row.referenceId,
    amount_vnd: row.amountVnd,
    expires_at: row.expiresAt,
    status: row.status,
    release_reason: row.releaseReason,
    avc_warning_acknowledged: row.avcWarningAcknowledged,
    created_at: row.createdAt,
    created_by: row.createdBy,
    closed_at: row.closedAt,
    closed_by: row.closedBy,
    version: row.version,
  };
}

function filterOf(query: Record<string, unknown>): ReservationFilter {
  const text = (name: string): string | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, name);
    return value;
  };
  const status = text('status');
  const line = text('allocation_line_id');
  const project = text('project_id');
  if (status !== undefined && !(RESERVATION_STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  if (line !== undefined && asUuid(line) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'allocation_line_id');
  if (project !== undefined && asUuid(project) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
  return {
    ...(status === undefined ? {} : { status: status as ReservationStatus }),
    ...(line === undefined ? {} : { allocationLineId: asUuid(line) as string }),
    ...(project === undefined ? {} : { projectId: asUuid(project) as string }),
  };
}

/**
 * The earmark of capital (ST-CAP-011, CAP 3.1 F4, BR-CAP-06, CAP-18): an investor reserves part of a line for a purpose until a day, under the same availability policy as a commitment (a warning needs to be accepted:
 * 422 `AVC_WARNING_ACK_REQUIRED`, a share above the block threshold is refused: 422 `AVC_BLOCKED`); a reservation is released with a reason against the version read (409 `RESERVATION_NOT_ACTIVE` once it has left
 * ACTIVE) and returns its capital; the job `capital-reservation-expiry` returns the capital of the ones that run out. A line of a project out of the scope of the caller does not exist for them.
 */
@Controller('fund-reservations')
export class FundReservationController {
  private readonly reservations = new CapReservationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post()
  @HttpCode(200)
  @OperationId('createFundReservation')
  @Command({ operation: 'createFundReservation' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CapReservation']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const made = await this.reservations.create(
      scope.tx,
      {
        allocationLineId: body.allocation_line_id,
        amountVnd: body.amount_vnd,
        purpose: body.purpose,
        referenceKind: body.reference_kind,
        referenceId: body.reference_id,
        expiresAt: body.expires_at,
        acknowledgeWarning: body.avc_acknowledged === true,
      },
      scope.tenant.membershipId,
      { act: projectScope(access, MANAGE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      now,
    );
    await scope.audit({
      action: 'capital.reservation_created',
      resourceType: RESERVATION_RESOURCE,
      resourceId: made.id,
      classification: 'INTERNAL',
      diff: {
        allocation_line_id: made.allocationLineId,
        project_id: made.projectId,
        plan_year: made.planYear,
        amount_vnd: made.amountVnd,
        purpose: made.purpose,
        expires_at: made.expiresAt,
        avc_state: made.commit.line.state,
        consumption_pct: made.commit.line.consumptionPct,
        avc_policy_id: made.commit.policyId,
        warning_acknowledged: made.commit.warningAcknowledged,
        ledger_entry_id: made.entryId,
      },
    });
    await scope.emit({
      aggregateType: RESERVATION_RESOURCE,
      aggregateId: made.id,
      aggregateVersion: made.version,
      type: CREATED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        reservation_id: made.id,
        allocation_line_id: made.allocationLineId,
        appropriation_id: made.appropriationId,
        project_id: made.projectId,
        plan_year: made.planYear,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        amount_vnd: made.amountVnd,
        purpose: made.purpose,
        expires_at: made.expiresAt,
        avc_state: made.commit.line.state,
        warning_acknowledged: made.commit.warningAcknowledged,
        ledger_entry_id: made.entryId,
      },
      eventKey: `${RESERVATION_RESOURCE}:${made.id}:created`,
    });
    return { ...commandResult(scope, 'ACTIVE', made.version, made.id), avc_state: made.commit.line.state, consumption_pct: made.commit.line.consumptionPct };
  }

  @Post(':id/release')
  @HttpCode(200)
  @OperationId('releaseFundReservation')
  @Command({ operation: 'releaseFundReservation', versioned: true })
  async release(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapReservationRelease']): Promise<CommandResult> {
    const now = new Date();
    const closed = await this.reservations.release(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, {
      act: projectScope(access, MANAGE_PERMISSION, now),
      read: projectScope(access, READ_PERMISSION, now),
    });
    await scope.audit({
      action: 'capital.reservation_released',
      resourceType: RESERVATION_RESOURCE,
      resourceId: closed.id,
      classification: 'INTERNAL',
      reason: closed.reason,
      diff: { allocation_line_id: closed.allocationLineId, project_id: closed.projectId, amount_vnd: closed.amountVnd, ledger_entry_id: closed.entryId },
    });
    await scope.emit({
      aggregateType: RESERVATION_RESOURCE,
      aggregateId: closed.id,
      aggregateVersion: closed.version,
      type: RELEASED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        reservation_id: closed.id,
        allocation_line_id: closed.allocationLineId,
        appropriation_id: closed.appropriationId,
        project_id: closed.projectId,
        plan_year: closed.planYear,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        amount_vnd: closed.amountVnd,
        status: closed.status,
        reason: closed.reason,
        ledger_entry_id: closed.entryId,
      },
      eventKey: `${RESERVATION_RESOURCE}:${closed.id}:closed`,
    });
    return commandResult(scope, closed.status, closed.version, closed.id);
  }

  @Get()
  @OperationId('listFundReservations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query() query: Record<string, unknown>,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(query.limit, query.cursor);
    const filter = filterOf(query);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) => this.reservations.list(tx, filter, projectScope(access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(reservationView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null, as_of: now.toISOString() };
  }
}
