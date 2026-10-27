import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisForecastStore, DisPeriodStore, DisSnapshotStore, TenantDatabase, projectScope } from '@machvon/db';
import type { ForecastProject } from '@machvon/db';
import { DomainError, REALLOCATION_THRESHOLD_PCT, estimateYear, mergeEstimates, monthOf } from '@machvon/kernel';
import type { EffectiveAccess, Estimate, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK } from './tokens';

const READ_PERMISSION = PERMISSIONS.getDisbursementForecast;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADJUSTMENT_MONTH = 13;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

const estimateView = (estimate: Estimate): Record<string, unknown> => ({
  disbursed_vnd: estimate.disbursedVnd,
  months: estimate.months.map((month) => ({ month: month.month, amount_vnd: month.amountVnd, source: month.source })),
  eac_vnd: estimate.eacVnd,
  plan_total_vnd: estimate.planTotalVnd,
  gap_vnd: estimate.gapVnd,
  ratio_pct: estimate.ratioPct,
  coverage: estimate.coverage,
  reallocation_candidate: estimate.reallocationCandidate,
  method: estimate.method,
});

const estimateOf = (project: ForecastProject, cutoffMonth: number): Estimate => estimateYear({ disbursedVnd: project.disbursedVnd, cutoffMonth, forecasts: project.forecasts, registered: project.registered, planTotalVnd: project.planTotalVnd });

/**
 * The cumulative curve of the year: what the Treasury paid month by month up to the cutoff (the month of the cutoff is the figure of the snapshot itself, so the line ends where the number is), and after it the
 * forecast on top of that figure, as far as every month is known; a month that is not known ends the line, it is not drawn as a flat stretch.
 */
export function curveOf(total: Estimate, actualByMonth: ReadonlyMap<number, string>, cutoffMonth: number): Array<{ month: number; actual_cumulative_vnd: string | null; forecast_cumulative_vnd: string | null }> {
  const curve: Array<{ month: number; actual_cumulative_vnd: string | null; forecast_cumulative_vnd: string | null }> = [];
  let running = 0n;
  for (let month = 1; month <= cutoffMonth; month += 1) {
    running += BigInt(actualByMonth.get(month) ?? '0');
    const actual = month === cutoffMonth ? total.disbursedVnd : total.disbursedVnd === null ? null : running.toString();
    curve.push({ month, actual_cumulative_vnd: actual, forecast_cumulative_vnd: month === cutoffMonth ? total.disbursedVnd : null });
  }
  let forecast: bigint | null = total.disbursedVnd === null ? null : BigInt(total.disbursedVnd);
  for (const month of total.months) {
    if (forecast !== null) forecast = month.amountVnd === null || !month.complete ? null : forecast + BigInt(month.amountVnd);
    if (month.month > 12 && month.month !== ADJUSTMENT_MONTH) continue;
    curve.push({ month: month.month, actual_cumulative_vnd: null, forecast_cumulative_vnd: forecast === null ? null : forecast.toString() });
  }
  return curve;
}

/**
 * The year-end estimate and the cumulative curve of the projects in the scope of the caller, over a frozen snapshot (ST-DIS-018, DIS 3 F8, BR-DIS-11, DIS-23): the Treasury figure of the snapshot plus the forecasts of the
 * months after the cutoff, the registration where a month has no forecast, and nothing invented for a month that has neither (the estimate is then told as partial and no reallocation is called for it). The
 * totals are of all the projects in the scope; the list of the projects is a page at a time. A project the caller does not see does not exist for them.
 */
@Controller()
export class DisbursementForecastController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly periods = new DisPeriodStore();
  private readonly forecasts = new DisForecastStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('disbursement-forecasts')
  @OperationId('getDisbursementForecast')
  async read(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('snapshot_id') snapshotId?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = this.clock();
    const request = parsePageRequest(limit, cursor);
    const snapshotFilter = optionalUuid(snapshotId, 'snapshot_id');
    const project = optionalUuid(projectId, 'project_id');
    const unit = optionalUuid(unitId, 'unit_id');
    const scope = projectScope(access, READ_PERMISSION, now);
    return this.database.withTenant(tenant, async (tx) => {
      const snapshot = snapshotFilter === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, snapshotFilter);
      if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      if (snapshot.status !== 'FROZEN') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
      // The plan year is the fiscal year of the period of the snapshot, as it is for the lines of the snapshot; a cutoff after its December (a close in January) is in the adjustment month (13), which the figure of the snapshot already holds up to the cutoff.
      const period = await this.periods.find(tx, snapshot.periodId);
      if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      const planYear = period.fiscalYear;
      const cutoffYear = Number(snapshot.treasuryCutoffDate.slice(0, 4));
      const cutoffMonth = cutoffYear > planYear ? ADJUSTMENT_MONTH : cutoffYear < planYear ? 0 : monthOf(snapshot.treasuryCutoffDate);
      const data = await this.forecasts.read(tx, scope, { snapshotId: snapshot.id, planYear, cutoffDate: snapshot.treasuryCutoffDate, projectId: project, unitId: unit });
      if (project !== undefined && data.projects.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'project_id');
      const estimated = data.projects.map((row) => ({ row, estimate: estimateOf(row, cutoffMonth) }));
      const total = mergeEstimates(estimated.map((each) => each.estimate));
      const after = request.after;
      const rest = after === undefined ? estimated : estimated.filter((each) => each.row.projectCode > after.code || (each.row.projectCode === after.code && each.row.projectId > after.id));
      const page = rest.slice(0, request.limit);
      const last = page[page.length - 1];
      return {
        snapshot_id: snapshot.id,
        as_of_date: snapshot.asOfDate,
        treasury_cutoff_date: snapshot.treasuryCutoffDate,
        plan_year: planYear,
        cutoff_month: cutoffMonth,
        definition_status: snapshot.definitionStatus,
        reallocation_threshold_pct: REALLOCATION_THRESHOLD_PCT,
        project_id: project === undefined ? null : project,
        ...estimateView(total),
        curve: curveOf(total, data.actualByMonth, cutoffMonth),
        projects: page.map((each) => ({ project: { id: each.row.projectId, code: each.row.projectCode, name: each.row.projectName }, ...estimateView(each.estimate) })),
        next_cursor: rest.length > request.limit && last !== undefined ? encodeCursor({ code: last.row.projectCode, id: last.row.projectId }) : null,
      };
    });
  }
}
