import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { AnaInsightStore, AnalyticsGovernanceStore, DisSnapshotStore, NO_FUND_KEY, TenantDatabase, projectScope } from '@machvon/db';
import type { HeatLabel, HeatSource } from '@machvon/db';
import { DomainError, HEAT_VIEWS, INSIGHT_RULE_TYPE, backtestThresholds, buildHeatmap, describeRuleType, leaderGate, previousWeekOf, trendRanking, vietnamDateOf, weekStartOf, yearPacePct } from '@machvon/kernel';
import type { EffectiveAccess, HeatView, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_READ_PERMISSION } from './scope-hash';
import { HOME_CLOCK } from './tokens';
import { workScopes } from './work-scope';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const HISTORY_WEEKS = 52;

const infoOf = (version: string, unverified: boolean): Record<string, unknown> => {
  const rule = describeRuleType(INSIGHT_RULE_TYPE);
  return { formula: rule.formula, source: rule.source, as_of: rule.asOf, rule_version: version, unverified };
};
const labelView = (label: HeatLabel): Record<string, unknown> => ({ key: label.key, code: label.code, label: label.label });

/**
 * The insight over units, fund sources and contractors, and over the weeks of the early-warning score (G3-10, G3-11): the heat-map in three views (a cell with too few projects or contracts is not shown and the totals leave it
 * out), the back-test of the thresholds of the early-warning score against what happened in the weeks after (a replay; it changes no threshold in force), and the ranking of the units by the trend of their score. Every
 * parameter is a governance rule, unverified until approved; what cannot be told is N/A with its reason.
 */
@Controller()
export class AnaInsightController {
  private readonly insight = new AnaInsightStore();
  private readonly snapshots = new DisSnapshotStore();
  private readonly register = new AnalyticsGovernanceStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/insight/heatmap')
  @OperationId('getAnalyticsHeatmap')
  async heatmap(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('view') viewText?: unknown): Promise<Record<string, unknown>> {
    if (viewText !== undefined && (typeof viewText !== 'string' || !(HEAT_VIEWS as readonly string[]).includes(viewText))) throw invalid('view');
    const view = (viewText ?? 'UNIT_FUND') as HeatView;
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scope = projectScope(access, HOME_READ_PERMISSION, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.insight.policy(tx, today);
      let gate: string | null = null;
      let source: HeatSource;
      if (view === 'UNIT_FUND') {
        const snapshot = await this.snapshots.latestFrozen(tx);
        const definitions = await this.register.kpiDefinitions(tx, today);
        const certification = (await this.register.kpiCertifications(tx, definitions.values())).get('DISBURSEMENT_RATE_PM');
        gate = certification === undefined ? null : leaderGate(certification.status);
        source = snapshot === undefined || gate !== null ? { cells: [], rows: [], cols: [], snapshotId: snapshot?.id ?? null, asOfDate: snapshot?.asOfDate ?? null } : await this.insight.unitFund(tx, scope, snapshot.id, snapshot.asOfDate);
      } else source = await this.insight.contractors(tx, scope, view === 'CONTRACTOR_UNIT' ? 'UNIT' : 'FUND');
      return { policy, source, gate };
    });
    const { params } = read.policy;
    const pace = view === 'UNIT_FUND' && read.source.asOfDate !== null ? yearPacePct(read.source.asOfDate) : null;
    const map = buildHeatmap(view, read.source.cells, pace, params);
    const rowLabels = new Map(read.source.rows.map((label) => [label.key, label]));
    const colLabels = new Map(read.source.cols.map((label) => [label.key, label]));
    return {
      view,
      snapshot_id: read.source.snapshotId,
      as_of_date: read.source.asOfDate,
      pace_pct: pace,
      certification_gate: read.gate,
      null_reason: read.gate !== null ? 'NOT_CERTIFIED' : read.source.snapshotId === null ? 'NO_SNAPSHOT' : null,
      params: { green_ratio: params.greenRatio, amber_ratio: params.amberRatio, min_cell_count: params.minCellCount, ctr_green_pct: params.ctrGreenPct, ctr_amber_pct: params.ctrAmberPct },
      info: infoOf(read.policy.version, read.policy.unverified),
      rows: read.source.rows.map(labelView),
      cols: read.source.cols.map((label) => ({ ...labelView(label), none: label.key === NO_FUND_KEY })),
      cells: map.cells.map((cell) => ({ row_key: cell.rowKey, col_key: cell.colKey, numerator_vnd: cell.numeratorVnd, denominator_vnd: cell.denominatorVnd, count: cell.count, rate_pct: cell.ratePct, band: cell.band, null_reason: cell.nullReason })),
      row_totals: map.rowTotals.map((total) => ({ key: total.key, label: rowLabels.get(total.key)?.label ?? null, numerator_vnd: total.numeratorVnd, denominator_vnd: total.denominatorVnd, rate_pct: total.ratePct, cells: total.cells, hidden: total.hidden })),
      col_totals: map.colTotals.map((total) => ({ key: total.key, label: colLabels.get(total.key)?.label ?? null, numerator_vnd: total.numeratorVnd, denominator_vnd: total.denominatorVnd, rate_pct: total.ratePct, cells: total.cells, hidden: total.hidden })),
      hidden_cells: map.hiddenCells,
    };
  }

  @Get('home/insight/backtest')
  @OperationId('getAnalyticsBacktest')
  async backtest(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.insight.policy(tx, today);
      const model = await this.register.ragModel(tx, today);
      const latest = await this.snapshots.latestFrozen(tx);
      const history = latest === undefined ? { scores: [], units: new Map() } : await this.insight.scores(tx, scopes.unitScope, weekStartOf(latest.asOfDate), HISTORY_WEEKS);
      return { policy, model, latest, history };
    });
    const lines = { amberFrom: read.model.score.green, redFrom: read.model.score.amber };
    const result = backtestThresholds(read.history.scores, lines, read.policy.params);
    return {
      as_of_date: read.latest?.asOfDate ?? null,
      null_reason: read.latest === undefined ? 'NO_SNAPSHOT' : result.nullReason,
      horizon_weeks: result.horizonWeeks,
      weeks_evaluated: result.weeksEvaluated,
      units_evaluated: result.unitsEvaluated,
      pairs: result.pairs,
      positives: result.positives,
      min_pairs: read.policy.params.backtestMinPairs,
      lines: { amber_from: lines.amberFrom, red_from: lines.redFrom, score_rule_versions: read.model.versions, score_unverified: read.model.unverified },
      info: infoOf(read.policy.version, read.policy.unverified),
      candidates: result.candidates.map((one) => ({
        threshold: one.threshold,
        is_current: one.isCurrent,
        shift: one.shift,
        line: one.line,
        pairs: one.pairs,
        tp: one.tp,
        fp: one.fp,
        fn: one.fn,
        tn: one.tn,
        precision_pct: one.precisionPct,
        recall_pct: one.recallPct,
        mean_lead_weeks: one.meanLeadWeeks,
        missed_units: one.missedUnits,
        warned_early_units: one.warnedEarlyUnits,
        null_reason: one.nullReason,
      })),
    };
  }

  @Get('home/insight/trend-ranking')
  @OperationId('getAnalyticsTrendRanking')
  async trend(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const policy = await this.insight.policy(tx, today);
      const latest = await this.snapshots.latestFrozen(tx);
      const week = latest === undefined ? undefined : weekStartOf(latest.asOfDate);
      const history = week === undefined ? { scores: [], units: new Map<string, { code: string; name: string }>() } : await this.insight.scores(tx, scopes.unitScope, week, policy.params.trendWeeks + 1);
      return { policy, latest, week, history };
    });
    const { params } = read.policy;
    const rows = read.week === undefined ? [] : trendRanking(read.history.scores, read.week, params.trendWeeks, (unitId) => read.history.units.get(unitId)?.code ?? unitId);
    const view = (row: (typeof rows)[number]): Record<string, unknown> => ({
      unit_id: row.unitId,
      code: read.history.units.get(row.unitId)?.code ?? '',
      name: read.history.units.get(row.unitId)?.name ?? '',
      rank: row.rank,
      delta: row.delta,
      direction: row.direction,
      score_now: row.scoreNow,
      score_before: row.scoreBefore,
      null_reason: row.nullReason,
      series: row.series,
    });
    const ranked = rows.filter((row) => row.rank !== null);
    return {
      as_of_date: read.latest?.asOfDate ?? null,
      week_start: read.week ?? null,
      previous_week_start: read.week === undefined ? null : previousWeekOf(read.week),
      null_reason: read.latest === undefined ? 'NO_SNAPSHOT' : null,
      trend_weeks: params.trendWeeks,
      top: params.trendTop,
      info: infoOf(read.policy.version, read.policy.unverified),
      improving: ranked.filter((row) => row.direction === 'IMPROVING').slice(0, params.trendTop).map(view),
      worsening: [...ranked].reverse().filter((row) => row.direction === 'WORSENING').slice(0, params.trendTop).map(view),
      units: rows.map(view),
    };
  }
}
