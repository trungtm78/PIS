import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisMilestoneStore, TenantDatabase, projectScope } from '@machvon/db';
import type { AccuracyView, DisRuleReading as RuleReading, MilestoneBoard } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { snakeKeys } from '../../snake-case';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK } from './tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR = /^\d{4}$/;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.toLowerCase();
}

const ruleView = <P>(rule: RuleReading<P>): Record<string, unknown> => ({
  code: rule.code,
  version: rule.version,
  source: rule.source,
  unverified: rule.unverified,
  params: snakeKeys(rule.policy),
  provenance: rule.provenance === null ? null : { formula: rule.provenance.formula, source: rule.provenance.source, as_of: rule.provenance.asOf, legal_status: rule.provenance.legalStatus },
});

/** The board of the milestones as the contract exposes it (an allowlist). */
export function milestoneBoardView(board: MilestoneBoard, now: Date): Record<string, unknown> {
  return {
    snapshot: board.snapshot === null ? null : { id: board.snapshot.id, as_of_date: board.snapshot.asOfDate, treasury_cutoff_date: board.snapshot.treasuryCutoffDate, plan_year: board.snapshot.planYear },
    run: board.run === null ? null : snakeKeys(board.run),
    milestones: board.milestones.map((group) => ({
      code: group.code,
      date: group.date,
      target_pct: group.targetPct,
      margin_pct: group.marginPct,
      summary: snakeKeys(group.summary),
      units: group.units.map((row) => ({
        id: row.id,
        unit: row.unit,
        plan_total_vnd: row.planTotalVnd,
        target_vnd: row.targetVnd,
        disbursed_vnd: row.disbursedVnd,
        projected_vnd: row.projectedVnd,
        projected_pct: row.projectedPct,
        gap_pct: row.gapPct,
        basis: row.basis,
        coverage: row.coverage,
        status: row.status,
        projects: row.projects,
      })),
    })),
    rule: ruleView(board.rule),
    as_of: now.toISOString(),
  };
}

export function accuracyView(view: AccuracyView, now: Date): Record<string, unknown> {
  const row = (entry: AccuracyView['report']['overall']): Record<string, unknown> => ({
    investor: entry.investorId === null ? null : (view.investors.get(entry.investorId) ?? { id: entry.investorId, code: null, name: null }),
    pairs: entry.pairs,
    months: entry.months,
    forecast_vnd: entry.forecastVnd,
    actual_vnd: entry.actualVnd,
    abs_error_vnd: entry.absErrorVnd,
    wape_pct: entry.wapePct,
    bias_pct: entry.biasPct,
    band: entry.band,
    bias_flag: entry.biasFlag,
  });
  return {
    plan_year: view.planYear,
    last_measured_month: view.lastMeasuredMonth,
    rows: view.report.rows.map(row),
    overall: row(view.report.overall),
    by_month: view.report.byMonth.map((month) => ({ month: month.month, forecast_vnd: month.forecastVnd, actual_vnd: month.actualVnd, wape_pct: month.wapePct })),
    rule: ruleView(view.rule),
    truncated: view.truncated,
    as_of: now.toISOString(),
  };
}

/**
 * The milestones of the directives and the accuracy of the forecasts (G1-16, DIS 3 F8). The board reads the vintages written when a snapshot was frozen, so it shows what was foreseen on that day and not
 * what would be foreseen now; the accuracy compares, from the history of the schedule, the last forecast before each month with what the Treasury paid. A caller sees only the investors that have a project in
 * their scope; a source that has not run is told as "not recorded", never as "no milestones".
 */
@Controller()
export class MilestoneForecastController {
  private readonly milestones = new DisMilestoneStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('disbursement-milestones')
  @OperationId('getDisbursementMilestones')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('snapshot_id') snapshotId?: unknown, @Query('unit_id') unitId?: unknown): Promise<Record<string, unknown>> {
    const now = this.clock();
    const snapshot = optionalUuid(snapshotId, 'snapshot_id');
    const unit = optionalUuid(unitId, 'unit_id');
    const board = await this.database.withTenant(tenant, (tx) => this.milestones.board(tx, projectScope(access, PERMISSIONS.getDisbursementMilestones, now), { snapshotId: snapshot, unitId: unit }, now));
    return milestoneBoardView(board, now);
  }

  @Get('disbursement-forecast-accuracy')
  @OperationId('getDisbursementForecastAccuracy')
  async accuracy(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('plan_year') planYear?: unknown, @Query('investor_id') investorId?: unknown): Promise<Record<string, unknown>> {
    const now = this.clock();
    if (planYear !== undefined && (typeof planYear !== 'string' || !YEAR.test(planYear))) throw new DomainError('VALIDATION_FAILED', 422, 'plan_year');
    const investor = optionalUuid(investorId, 'investor_id');
    const view = await this.database.withTenant(tenant, (tx) =>
      this.milestones.accuracy(tx, projectScope(access, PERMISSIONS.getDisbursementForecastAccuracy, now), { planYear: planYear === undefined ? undefined : Number(planYear), investorId: investor }, now),
    );
    return accuracyView(view, now);
  }
}
