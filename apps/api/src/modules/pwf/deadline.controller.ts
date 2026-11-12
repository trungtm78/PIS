import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PwfDeadlineReads, TenantDatabase, projectScope } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { queryText } from './pwf-support';

const integer = (value: unknown, field: string): number | undefined => {
  const text = queryText(value, field);
  if (text === undefined) return undefined;
  if (!/^\d{1,4}$/.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return Number(text);
};

/**
 * The portfolio of deadlines (PWF-07): the board with exact totals and the colour of the rule of the tenant only (R40), the month calendar, the milestones of the next days and the load by person. All of them read straight from
 * `project_task` in the scope of `pwf.read`, in pages, and say how many they show of how many there are (R35).
 */
@Controller()
export class PwfDeadlineReadsController {
  private readonly reads = new PwfDeadlineReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('pwf/deadlines')
  @OperationId('getDeadlineBoard')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfDeadlineBoard']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    const found = await this.database.withTenant(tenant, (tx) =>
      this.reads.board(
        tx,
        projectScope(access, PERMISSIONS.getDeadlineBoard, now),
        {
          unitId: queryText(query.unit_id, 'unit_id'),
          projectId: queryText(query.project_id, 'project_id'),
          band: queryText(query.band, 'band'),
          phase: queryText(query.phase, 'phase'),
          assigneeId: queryText(query.assignee_id, 'assignee_id'),
          status: queryText(query.status, 'status'),
          dueFrom: queryText(query.due_from, 'due_from'),
          dueTo: queryText(query.due_to, 'due_to'),
        },
        { limit: page.limit, after: page.after },
        now,
      ),
    );
    const { next, ...rest } = found as { next: { code: string; id: string } | null } & Record<string, unknown>;
    return { ...rest, next_cursor: next === null ? null : encodeCursor(next) } as unknown as Schemas['PwfDeadlineBoard'];
  }

  @Get('pwf/deadlines/calendar')
  @OperationId('getDeadlineCalendar')
  async calendar(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfDeadlineCalendar']> {
    const now = new Date();
    const month = queryText(query.month, 'month') ?? new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 7);
    return this.database.withTenant(tenant, (tx) =>
      this.reads.calendar(tx, projectScope(access, PERMISSIONS.getDeadlineCalendar, now), { unitId: queryText(query.unit_id, 'unit_id'), projectId: queryText(query.project_id, 'project_id'), assigneeId: queryText(query.assignee_id, 'assignee_id') }, month, now),
    ) as Promise<Schemas['PwfDeadlineCalendar']>;
  }

  @Get('pwf/milestones/upcoming')
  @OperationId('getUpcomingMilestones')
  async milestones(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfMilestoneList']> {
    const now = new Date();
    return this.database.withTenant(tenant, (tx) =>
      this.reads.milestones(tx, projectScope(access, PERMISSIONS.getUpcomingMilestones, now), { unitId: queryText(query.unit_id, 'unit_id'), projectId: queryText(query.project_id, 'project_id') }, integer(query.days, 'days') ?? 30, now),
    ) as Promise<Schemas['PwfMilestoneList']>;
  }

  @Get('pwf/workload')
  @OperationId('getProjectWorkload')
  async workload(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfWorkload']> {
    const now = new Date();
    return this.database.withTenant(tenant, (tx) =>
      this.reads.workload(tx, projectScope(access, PERMISSIONS.getProjectWorkload, now), { unitId: queryText(query.unit_id, 'unit_id') }, { from: queryText(query.from, 'from'), weeks: integer(query.weeks, 'weeks') }, now),
    ) as Promise<Schemas['PwfWorkload']>;
  }
}
