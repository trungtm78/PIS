import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { AnaOutlookStore, AnalyticsGovernanceStore, HomeStore, TenantDatabase, projectScope } from '@machvon/db';
import type { OutlookSeries } from '@machvon/db';
import { DomainError, FORECAST_RULE_TYPE, describeRuleType, leaderGate, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Outlook, OutlookPoint, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_READ_PERMISSION } from './scope-hash';
import { HOME_CLOCK } from './tokens';
import { workScopes } from './work-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
/** The indicator whose certification gates the outlook: a leader is shown no figure built on a definition that is not certified (G3-1). */
const GATE_KPI: Readonly<Record<'PM' | 'TOTAL', string>> = { PM: 'DISBURSEMENT_RATE_PM', TOTAL: 'DISBURSEMENT_RATE_TOTAL' };

const band = (value: { lowVnd: string; centralVnd: string; highVnd: string } | null): Record<string, string> | null => (value === null ? null : { low_vnd: value.lowVnd, central_vnd: value.centralVnd, high_vnd: value.highVnd });

export function outlookView(outlook: Outlook, projects: number): Record<string, unknown> {
  return {
    null_reason: outlook.nullReason,
    as_of_date: outlook.asOfDate,
    plan_year_end: outlook.planYearEnd,
    cumulative_vnd: outlook.cumulativeVnd,
    plan_total_vnd: outlook.planTotalVnd,
    remaining_days: outlook.remainingDays,
    projects,
    windows: outlook.windows.map((window) => ({
      weeks: window.weeks,
      start_date: window.startDate,
      days: window.days,
      delta_vnd: window.deltaVnd,
      weekly_speed_vnd: window.weeklySpeedVnd,
      linear_year_end_vnd: window.linearYearEndVnd,
      seasonal_year_end_vnd: window.seasonalYearEndVnd,
      seasonal_null_reason: window.seasonalNullReason,
    })),
    skipped: outlook.skipped.map((one) => ({ weeks: one.weeks, reason: one.reason })),
    linear: band(outlook.linear),
    linear_ratio_pct: outlook.linearRatioPct,
    seasonal: band(outlook.seasonal),
    seasonal_ratio_pct: outlook.seasonalRatioPct,
    seasonal_null_reason: outlook.seasonalNullReason,
    gap_vnd: outlook.gapVnd,
    attention: outlook.attention,
    needed: {
      status: outlook.needed.status,
      null_reason: outlook.needed.nullReason,
      remaining_vnd: outlook.needed.remainingVnd,
      remaining_days: outlook.needed.remainingDays,
      per_week_vnd: outlook.needed.perWeekVnd,
      speed_vnd: outlook.needed.speedVnd,
      multiple: outlook.needed.multiple,
      multiple_null_reason: outlook.needed.multipleNullReason,
    },
  };
}

const pointView = (point: OutlookPoint): Record<string, string> => ({ as_of_date: point.asOfDate, cumulative_vnd: point.cumulativeVnd });

/**
 * The year-end outlook of the disbursement (G3-5, BI and DIS): the weekly cumulative of the frozen snapshots of the year in the scope of the reader, the band from the speed of the last 4 to 8 weeks, the seasonal
 * reading when the year before has a complete series, and how much has to be paid each week to reach the plan. Per fund source with `breakdown=FUND` (G3-11). The parameters are a governance rule (unverified until
 * the tenant approves its own); a figure on a definition that is not certified is not given to a leader.
 */
@Controller()
export class AnaForecastController {
  private readonly outlooks = new AnaOutlookStore();
  private readonly home = new HomeStore();
  private readonly register = new AnalyticsGovernanceStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/outlook')
  @OperationId('getDisbursementOutlook')
  async outlook(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('unit_id') unitId?: unknown,
    @Query('plan_basis') planBasis?: unknown,
    @Query('breakdown') breakdown?: unknown,
    @Query('year') yearText?: unknown,
  ): Promise<Record<string, unknown>> {
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    if (planBasis !== undefined && planBasis !== 'PM' && planBasis !== 'TOTAL') throw invalid('plan_basis');
    if (breakdown !== undefined && breakdown !== 'NONE' && breakdown !== 'FUND') throw invalid('breakdown');
    if (yearText !== undefined && (typeof yearText !== 'string' || !/^\d{4}$/.test(yearText))) throw invalid('year');
    const basis: 'PM' | 'TOTAL' = planBasis === 'TOTAL' ? 'TOTAL' : 'PM';
    const byFund = breakdown === 'FUND';
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const projects = projectScope(access, HOME_READ_PERMISSION, now);
    const underUnitId = unitId as string | undefined;
    const rule = describeRuleType(FORECAST_RULE_TYPE);
    const read = await this.database.withTenant(tenant, async (tx) => {
      if (underUnitId !== undefined && !(await this.home.unitReadable(tx, scopes.unitScope, underUnitId))) throw new DomainError('SCOPE_DENIED', 403);
      const policy = await this.outlooks.policy(tx, today);
      const latest = await this.outlooks.latestFrozenDay(tx, today);
      const year = yearText === undefined ? (latest === undefined ? undefined : Number(latest.slice(0, 4))) : Number(yearText);
      if (year === undefined) return { policy, year: undefined, gate: null, whole: [] as OutlookSeries[], funds: [] as OutlookSeries[], prior: [] as OutlookSeries[], priorFunds: [] as OutlookSeries[] };
      const definitions = await this.register.kpiDefinitions(tx, today);
      const certifications = await this.register.kpiCertifications(tx, definitions.values());
      const certification = certifications.get(GATE_KPI[basis]);
      const gate = certification === undefined ? null : leaderGate(certification.status);
      if (gate !== null) return { policy, year, gate, whole: [], funds: [], prior: [], priorFunds: [] };
      const current = await this.outlooks.frozenOfYear(tx, year);
      const before = await this.outlooks.frozenOfYear(tx, year - 1);
      const query = { basis, underUnitId };
      const whole = await this.outlooks.series(tx, projects, { snapshots: current, byFund: false, ...query });
      const prior = await this.outlooks.series(tx, projects, { snapshots: before, byFund: false, ...query });
      const funds = byFund ? await this.outlooks.series(tx, projects, { snapshots: current, byFund: true, ...query }) : [];
      const priorFunds = byFund ? await this.outlooks.series(tx, projects, { snapshots: before, byFund: true, ...query }) : [];
      return { policy, year, gate: null, whole, funds, prior, priorFunds };
    });
    const info = { formula: rule.formula, source: rule.source, as_of: rule.asOf, rule_version: read.policy.version, unverified: read.policy.unverified };
    const model = {
      window_min_weeks: read.policy.params.windowMinWeeks,
      window_max_weeks: read.policy.params.windowMaxWeeks,
      central: read.policy.params.central,
      seasonality: read.policy.params.seasonality,
      attention_below_pct: read.policy.params.attentionBelowPct,
    };
    const head = { plan_basis: basis, breakdown: byFund ? 'FUND' : 'NONE', model, info };
    if (read.year === undefined) return { ...head, year: null, as_of_date: null, certification_gate: null, null_reason: 'NO_SNAPSHOT', whole: null, series: [], prior_series: [], funds: [] };
    if (read.gate !== null) return { ...head, year: read.year, as_of_date: null, certification_gate: read.gate, null_reason: 'NOT_CERTIFIED', whole: null, series: [], prior_series: [], funds: [] };
    const { params } = read.policy;
    const wholeSeries = read.whole[0];
    const priorPoints = read.prior[0]?.points ?? [];
    const whole = wholeSeries === undefined ? null : outlookView(this.outlooks.outlook(wholeSeries, priorPoints, read.year, params), wholeSeries.projects);
    const priorByFund = new Map(read.priorFunds.map((series) => [series.fundSourceVersionId ?? '', series.points]));
    const funds = read.funds.map((series) => ({
      fund_source_version_id: series.fundSourceVersionId,
      code: series.fundCode,
      label: series.fundLabel,
      outlook: outlookView(this.outlooks.outlook(series, priorByFund.get(series.fundSourceVersionId ?? '') ?? [], read.year as number, params), series.projects),
    }));
    return {
      ...head,
      year: read.year,
      as_of_date: wholeSeries?.points[wholeSeries.points.length - 1]?.asOfDate ?? null,
      certification_gate: null,
      null_reason: whole === null ? 'NO_SNAPSHOT' : null,
      whole,
      series: (wholeSeries?.points ?? []).map(pointView),
      prior_series: priorPoints.map(pointView),
      funds,
    };
  }
}
