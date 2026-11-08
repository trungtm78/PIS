import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { AlertCoverStore, AlertGapStore, AlertGovernancePolicyReader, AlertProfileStore, AlertTraceStore, HomeWorkCalendars, TenantDatabase, WORK_CALENDAR_CODE } from '@machvon/db';
import { HEALTH_RULE_TYPE, computeAlertHealth, positionCoverage, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { ALERT_HEALTH_PERMISSION, bodyId, denied, invalid, personNames, ruleView, unitNames, unitScopeOf } from './alert-support';
import { HOME_CLOCK } from './tokens';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 28;
const MIN_DAYS = 7;
const MAX_DAYS = 90;
/** How far back the closed gaps of the coverage report reach. */
const GAP_DAYS = 28;

function daysOf(value: unknown): number {
  if (value === undefined) return DEFAULT_DAYS;
  const parsed = typeof value === 'string' && /^[0-9]{1,3}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS) throw invalid('days');
  return parsed;
}

/**
 * The health of the alert system (roadmap G2-10, HOME-13): the fourteen indicators computed from what the alert centre recorded (the trace of the items, the log of notices, the routing gaps, the coverage of the positions), with the targets of the
 * governance rule `ALERT_HEALTH_TARGETS` (starting values, flagged as such), each figure with its formula, its source and its status. A figure that cannot be computed is NO_DATA or NO_SOURCE with the reason, never zero. The reader sees what lies in the units
 * they may read under `home.alert.health.read`; the page says when the recording job is older than two passes. The coverage report (G2-7) lists the positions with their cover and the gaps in the receivers of alerts.
 */
@Controller()
export class AlertHealthController {
  private readonly trace = new AlertTraceStore();
  private readonly gaps = new AlertGapStore();
  private readonly covers = new AlertCoverStore();
  private readonly profiles = new AlertProfileStore();
  private readonly policies = new AlertGovernancePolicyReader();
  private readonly calendars = new HomeWorkCalendars();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/alert-health')
  @OperationId('getAlertHealth')
  async health(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('days') daysQuery?: unknown, @Query('unit_id') unitQuery?: unknown): Promise<Record<string, unknown>> {
    const days = daysOf(daysQuery);
    const unitId = unitQuery === undefined ? null : bodyId(unitQuery, 'unit_id');
    const now = this.clock();
    const from = new Date(now.getTime() - days * DAY_MS);
    // The window ends just after now: what the pass of this very moment wrote is in it.
    const to = new Date(now.getTime() + 1);
    return this.database.withTenant(tenant, async (tx) => {
      const today = vietnamDateOf(now);
      const unitScope = unitScopeOf(access, ALERT_HEALTH_PERMISSION, now);
      if (unitId !== null) {
        const scope = unitScope(2);
        const found = await tx.query<{ id: string }>(`select u.id from machvon.organization_unit u where u.id = $1::uuid and ${scope.sql}`, [unitId, ...scope.params]);
        if (found.length === 0) throw denied();
      }
      const policies = await this.policies.read(tx, today);
      const items = await this.trace.forHealth(tx, from, to, unitId, unitScope);
      const holders = await this.covers.positionHolders(tx, now, policies.absence.position_min_rank, policies.escalation.admin_fallback_min_rank, unitScope);
      const coverage = positionCoverage(holders, policies.absence);
      const health = computeAlertHealth({
        from,
        to,
        now,
        items,
        notices: await this.profiles.forHealth(tx, from, to, unitScope),
        gaps: await this.gaps.forHealth(tx, from, to, unitScope),
        coverage,
        // The platform has no delivery receipts for the notices of alerts yet (G2-6): the figure says so instead of showing a number.
        delivery: null,
        calendars: await this.calendars.load(tx, WORK_CALENDAR_CODE, now),
        lastPassAt: await this.trace.lastPassAt(tx),
        targets: policies.health,
      });
      const units = await unitNames(tx, [...health.staleByUnit.map((row) => row.unitId), ...coverage.positions.map((position) => position.unitId)]);
      return {
        from: health.from,
        to: health.to,
        as_of: health.asOf,
        stale: health.stale,
        last_pass_at: health.lastPassAt,
        kpis: health.kpis.map((kpi) => ({
          code: kpi.code,
          value: kpi.value,
          unit: kpi.unit,
          direction: kpi.direction,
          target: kpi.target,
          status: kpi.status,
          sample: kpi.sample,
          low_sample: kpi.lowSample,
          parts: kpi.parts,
          formula: kpi.formula,
          source: kpi.source,
          note: kpi.note,
        })),
        top_types: health.topTypes.map((row) => ({ type_code: row.typeCode, count: row.count, share_pct: row.sharePct, snoozed: row.snoozed, snooze_rate_pct: row.snoozeRatePct })),
        stale_by_unit: health.staleByUnit.map((row) => ({ unit_id: row.unitId, unit_name: row.unitId === null ? null : (units.get(row.unitId) ?? null), count: row.count })),
        items: { in_window: health.items.inWindow, open: health.items.open },
        positions: coverage.positions.map((position) => ({ key: position.key, role_code: position.roleCode, unit_id: position.unitId, unit_name: units.get(position.unitId) ?? null, holders: position.holders, present: position.present, state: position.state })),
        rule: ruleView(await this.policies.info(tx, HEALTH_RULE_TYPE, today)),
      };
    });
  }

  /** The coverage of the positions of leadership and the gaps in the receivers of alerts, open and closed in the last four weeks (G2-7). */
  @Get('home/alert-coverage')
  @OperationId('getAlertCoverageReport')
  async coverage(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const today = vietnamDateOf(now);
      const unitScope = unitScopeOf(access, ALERT_HEALTH_PERMISSION, now);
      const policies = await this.policies.read(tx, today);
      const holders = await this.covers.positionHolders(tx, now, policies.absence.position_min_rank, policies.escalation.admin_fallback_min_rank, unitScope);
      const summary = positionCoverage(holders, policies.absence);
      const gaps = await this.gaps.list(tx, { from: new Date(now.getTime() - GAP_DAYS * DAY_MS), to: new Date(now.getTime() + 1000), unitScope });
      const units = await unitNames(tx, [...summary.positions.map((position) => position.unitId), ...gaps.map((gap) => gap.unitId)]);
      const names = await personNames(tx, gaps.map((gap) => gap.membershipId));
      return {
        positions: summary.positions.map((position) => ({ key: position.key, role_code: position.roleCode, unit_id: position.unitId, unit_name: units.get(position.unitId) ?? null, holders: position.holders, present: position.present, state: position.state })),
        summary: { backed_up: summary.backedUp, total: summary.total, percent: summary.percent },
        gaps: gaps.map((gap) => ({
          id: gap.id,
          kind: gap.kind,
          membership_id: gap.membershipId,
          name: gap.membershipId === null ? null : (names.get(gap.membershipId) ?? null),
          unit_id: gap.unitId,
          absence_id: gap.absenceId,
          item_count: gap.itemCount,
          opened_at: gap.openedAt,
          closed_at: gap.closedAt,
          close_reason: gap.closeReason,
        })),
        rule: ruleView(await this.policies.info(tx, 'ABSENCE_POLICY', today)),
        as_of: now.toISOString(),
      };
    });
  }
}
