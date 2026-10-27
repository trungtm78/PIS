import { Controller, Get, Inject, Optional, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisPeriodStore, DisSubmissionBoardStore, TenantDatabase, projectScope } from '@machvon/db';
import type { BoardProjectRow } from '@machvon/db';
import { DRILL_STATES, DomainError, inDrill, isOverdue, tallyBoard } from '@machvon/kernel';
import type { BoardTally, DrillState, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK } from './tokens';

const READ_PERMISSION = PERMISSIONS.getSubmissionProgress;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function optionalState(value: unknown): DrillState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(DRILL_STATES as readonly string[]).includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
  return value as DrillState;
}

function optionalFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

export function tallyView(tally: BoardTally): Record<string, number> {
  return { must_report: tally.mustReport, submitted: tally.submitted, submitted_late: tally.lateSubmitted, draft: tally.draft, not_started: tally.notStarted, overdue: tally.overdue };
}

function projectView(row: BoardProjectRow, deadlinePassed: boolean, withNarrative: boolean): Record<string, unknown> {
  return {
    project: { id: row.projectId, code: row.projectCode, name: row.projectName },
    unit: { id: row.unitId, code: row.unitCode, name: row.unitName },
    state: row.state,
    is_late: row.late,
    overdue: isOverdue(row, deadlinePassed),
    report: row.reportId === null ? null : { id: row.reportId, status: row.reportStatus, submitted_at: row.submittedAt },
    ...(withNarrative ? { narrative: row.narrative } : {}),
  };
}

/**
 * The submission progress board of a period (ST-DIS-015, DIS 3 F4, DIS-15): for each unit the projects that must report, how many handed a report in (and how many of them late, by the lateness stored when they
 * did), how many have a draft, have not started, and are overdue (the deadline of the period has passed and nothing was handed in). The projects are those in the scope of the caller. With `state` the answer
 * carries the exact projects a number counted, a page at a time, with their narrative when it is asked for (PRJ-13).
 */
@Controller()
export class SubmissionProgressController {
  private readonly periods = new DisPeriodStore();
  private readonly board = new DisSubmissionBoardStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('reporting-periods/:id/submission-progress')
  @OperationId('getSubmissionProgress')
  async progress(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('unit_id') unitId?: unknown,
    @Query('state') state?: unknown,
    @Query('with_narrative') withNarrative?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = this.clock();
    const request = parsePageRequest(limit, cursor);
    const unit = optionalUuid(unitId, 'unit_id');
    const drill = optionalState(state);
    const narrative = optionalFlag(withNarrative, 'with_narrative');
    if (narrative && drill === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'with_narrative');
    const scope = projectScope(access, READ_PERMISSION, now);
    return this.database.withTenant(tenant, async (tx) => {
      const period = await this.periods.find(tx, id);
      if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const rows = await this.board.projects(tx, scope, id, { unitId: unit });
      const deadlinePassed = now.getTime() > Date.parse(period.deadlineAt);
      const byUnit = new Map<string, BoardProjectRow[]>();
      for (const row of rows) byUnit.set(row.unitId, [...(byUnit.get(row.unitId) ?? []), row]);
      const units = [...byUnit.values()].map((group) => ({ unit: { id: group[0]?.unitId, code: group[0]?.unitCode, name: group[0]?.unitName }, ...tallyView(tallyBoard(group, deadlinePassed)) }));
      const answer: Record<string, unknown> = {
        period: { id: period.id, code: period.code, period_type: period.periodType, start_date: period.startDate, end_date: period.endDate, deadline_at: period.deadlineAt },
        deadline_passed: deadlinePassed,
        as_of: now.toISOString(),
        total: tallyView(tallyBoard(rows, deadlinePassed)),
        units,
      };
      if (drill === undefined) return answer;
      const chosen = rows.filter((row) => inDrill(row, drill, deadlinePassed)).sort((a, b) => (a.projectCode < b.projectCode ? -1 : a.projectCode > b.projectCode ? 1 : a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
      const after = request.after;
      const rest = after === undefined ? chosen : chosen.filter((row) => row.projectCode > after.code || (row.projectCode === after.code && row.projectId > after.id));
      const page = rest.slice(0, request.limit);
      const last = page[page.length - 1];
      return {
        ...answer,
        state: drill,
        projects: page.map((row) => projectView(row, deadlinePassed, narrative)),
        next_cursor: rest.length > request.limit && last !== undefined ? encodeCursor({ code: last.projectCode, id: last.projectId }) : null,
      };
    });
  }
}
