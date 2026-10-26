import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisWeeklyPlanStore, TenantDatabase, projectScope } from '@machvon/db';
import type { WeeklyPlanRow } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK } from './tokens';

const READ_PERMISSION = PERMISSIONS.listWeeklyDisbursementPlans;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR = /^(20[0-9]{2}|2100)$/;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

export function weeklyPlanView(row: WeeklyPlanRow): Record<string, unknown> {
  return {
    project: { id: row.projectId, code: row.projectCode, name: row.projectName },
    leader: row.leader === null ? null : { membership_id: row.leader.membershipId, display_name: row.leader.displayName },
    period: { id: row.periodId, code: row.periodCode, start_date: row.startDate, end_date: row.endDate },
    commitment_vnd: row.commitmentVnd,
    actual_vnd: row.actualVnd,
    difference_vnd: row.differenceVnd,
    actual_from_year_start: row.fromYearStart,
  };
}

/**
 * The weekly commitment of each project against what the Treasury paid (ST-DIS-014, DIS 3 F8, DIS-24, Directive 162): read only. The commitments are the current WEEKLY_COMMITMENT lines of the capital
 * schedule (registered by CAP), the actuals are the frozen close snapshots, the leader is the current leader in charge of the project; a plan is never added to a disbursement.
 */
@Controller()
export class WeeklyPlanController {
  private readonly store = new DisWeeklyPlanStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('weekly-disbursement-plans')
  @OperationId('listWeeklyDisbursementPlans')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('plan_year') planYear?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = this.clock();
    const request = parsePageRequest(limit, cursor);
    if (planYear !== undefined && (typeof planYear !== 'string' || !YEAR.test(planYear))) throw new DomainError('VALIDATION_FAILED', 422, 'plan_year');
    const year = planYear === undefined ? Number(vietnamDateOf(now).slice(0, 4)) : Number(planYear);
    const filter = { planYear: year, projectId: optionalUuid(projectId, 'project_id'), unitId: optionalUuid(unitId, 'unit_id') };
    const scope = projectScope(access, READ_PERMISSION, now);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, scope, filter, { limit: request.limit + 1, after: request.after?.code }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      plan_year: year,
      items: shown.map(weeklyPlanView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.projectCode}|${last.startDate}`, id: last.projectId }) : null,
    };
  }
}
