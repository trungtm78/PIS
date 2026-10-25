import { Body, Controller, Get, HttpCode, Inject, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CapFiscalYearStore, TenantDatabase } from '@machvon/db';
import type { ClosedYear, FiscalYearRow, LapseSummary } from '@machvon/db';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const RESOURCE_TYPE = 'fiscal_year';
export const FISCAL_YEAR_CLOSED_EVENT = 'capital.fiscal_year_closed.v1';
export const FISCAL_YEAR_REOPENED_EVENT = 'capital.fiscal_year_reopened.v1';

export function fiscalYearView(row: FiscalYearRow): Schemas['FiscalYear'] {
  return {
    ...(row.id === null ? {} : { id: row.id }),
    plan_year: row.year,
    status: row.status,
    version: row.version,
    ...(row.softClosedAt === null ? {} : { soft_closed_at: row.softClosedAt }),
    ...(row.softClosedBy === null ? {} : { soft_closed_by: row.softClosedBy }),
    ...(row.lockedAt === null ? {} : { locked_at: row.lockedAt }),
    ...(row.lockedBy === null ? {} : { locked_by: row.lockedBy }),
    ...(row.closeReason === null ? {} : { close_reason: row.closeReason }),
    ...(row.reopenReason === null ? {} : { reopen_reason: row.reopenReason }),
    ...(row.reopenedAt === null ? {} : { reopened_at: row.reopenedAt }),
    ...(row.reopenedUntil === null ? {} : { reopened_until: row.reopenedUntil }),
    ...(row.reopenApprovedBy === null ? {} : { reopen_approved_by: row.reopenApprovedBy }),
  };
}

const lapseDiff = (lapse: LapseSummary | undefined): Record<string, unknown> =>
  lapse === undefined ? {} : { lapsed_lines: lapse.lines, lapsed_vnd: lapse.totalVnd, lapsed_extension_requests: lapse.extensionsLapsed, lock_ref_id: lapse.refId };

/** The event that tells the other modules a year was closed: the plans, the disbursement snapshots and the home screens read it. */
function closedEvent(scope: CommandScope, closed: ClosedYear, occurredAt: Date) {
  return {
    aggregateType: RESOURCE_TYPE,
    aggregateId: closed.row.id as string,
    aggregateVersion: closed.row.version,
    type: FISCAL_YEAR_CLOSED_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: scope.tenant.tenantId,
      plan_year: closed.row.year,
      status: closed.row.status,
      previous_status: closed.previous,
      version: closed.row.version,
      actor_id: scope.tenant.membershipId,
      occurred_at: occurredAt.toISOString(),
      ...lapseDiff(closed.lapse),
    },
    eventKey: `${RESOURCE_TYPE}:${closed.row.id}:closed:${closed.row.version}`,
  };
}

/**
 * The closing of a fiscal year of the capital plan (ST-CAP-008, CAP 3.1 F6, CAP-11): a year-close officer soft-closes a year (the adjustment period: it takes no plan command and no commitment,
 * only what carries capital out of it) and locks it (the capital that was not carried over lapses); another officer reopens a locked year for a limited window, and the year is locked
 * again when the window ends (the job). The rules live in `CapFiscalYearStore`.
 */
@Controller()
export class FiscalYearController {
  private readonly years = new CapFiscalYearStore();

  @Post('fiscal-years/:year/close')
  @HttpCode(200)
  @OperationId('closeFiscalYear')
  @Command({ operation: 'closeFiscalYear', versioned: true, ttl: 'extended' })
  async close(@Scope() scope: CommandScope, @Param('year', ParseIntPipe) year: number, @Body() body: Schemas['CapYearClose']): Promise<CommandResult> {
    const now = new Date();
    const closed = await this.years.close(scope.tx, { year, target: body.target_status, reason: body.reason, closedBy: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0 }, now);
    await scope.audit({
      action: closed.row.status === 'LOCKED' ? 'capital.fiscal_year_locked' : 'capital.fiscal_year_soft_closed',
      resourceType: RESOURCE_TYPE,
      resourceId: closed.row.id as string,
      reason: body.reason,
      diff: { plan_year: year, status_before: closed.previous, status_after: closed.row.status, ...lapseDiff(closed.lapse) },
    });
    await scope.emit(closedEvent(scope, closed, now));
    return commandResult(scope, closed.row.status, closed.row.version, closed.row.id as string);
  }

  @Post('fiscal-years/:year/reopen')
  @HttpCode(200)
  @OperationId('reopenFiscalYear')
  @Command({ operation: 'reopenFiscalYear', versioned: true, ttl: 'extended' })
  async reopen(@Scope() scope: CommandScope, @Param('year', ParseIntPipe) year: number, @Body() body: Schemas['CapYearReopen']): Promise<CommandResult> {
    const now = new Date();
    const row = await this.years.reopen(scope.tx, { year, reason: body.reason, windowHours: body.window_hours, reopenedBy: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0 }, now);
    await scope.audit({
      action: 'capital.fiscal_year_reopened',
      resourceType: RESOURCE_TYPE,
      resourceId: row.id as string,
      reason: body.reason,
      diff: { plan_year: year, status_before: 'LOCKED', status_after: row.status, window_hours: body.window_hours, reopened_until: row.reopenedUntil },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: row.id as string,
      aggregateVersion: row.version,
      type: FISCAL_YEAR_REOPENED_EVENT,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        plan_year: year,
        version: row.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        reopened_until: row.reopenedUntil,
        window_hours: body.window_hours,
      },
      eventKey: `${RESOURCE_TYPE}:${row.id}:reopened:${row.version}`,
    });
    return commandResult(scope, row.status, row.version, row.id as string);
  }
}

/** The years the control knows (CAP-11); a year it does not list is open with version 1. */
@Controller()
export class FiscalYearReadsController {
  private readonly years = new CapFiscalYearStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('fiscal-years')
  @OperationId('listFiscalYears')
  async list(@CurrentTenant() tenant: TenantContext): Promise<Schemas['FiscalYearList']> {
    const rows = await this.database.withTenant(tenant, (tx) => this.years.list(tx));
    return { items: rows.map(fiscalYearView) };
  }
}
