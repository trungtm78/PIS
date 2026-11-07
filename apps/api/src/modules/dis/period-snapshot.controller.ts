import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_SNAPSHOT_BUILD_METRIC, DIS_SNAPSHOT_FREEZE_METRIC, DisCrossTotalStore, DisPeriodStore, DisSnapshotStore, SNAPSHOT_RESOURCE, TenantDatabase, crossTotalRecord, projectScope } from '@machvon/db';
import type { PeriodSnapshotLineRow, PeriodSnapshotRow } from '@machvon/db';
import { DomainError, NOOP_METRICS, SNAPSHOT_KINDS, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, SnapshotKind, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const BUILD_PERMISSION = PERMISSIONS.buildPeriodSnapshot;
const FREEZE_PERMISSION = PERMISSIONS.freezePeriodSnapshot;
const READ_PERMISSION = PERMISSIONS.listPeriodSnapshotLines;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The kind of snapshot that is the official figure of a period: the others are made the same way, and every snapshot holds the whole tenant. */
const OFFICIAL: SnapshotKind = 'PERIOD_CLOSE';

export function snapshotView(row: PeriodSnapshotRow): Record<string, unknown> {
  return {
    id: row.id,
    period_id: row.periodId,
    snapshot_kind: row.snapshotKind,
    as_of_at: row.asOfAt,
    as_of_date: row.asOfDate,
    treasury_cutoff_date: row.treasuryCutoffDate,
    status: row.status,
    metric_set_version: row.metricSetVersion,
    definition_status: row.definitionStatus,
    row_count: row.rowCount,
    payload_sha256: row.payloadSha256,
    frozen_by: row.frozenBy,
    frozen_at: row.frozenAt,
    supersedes_id: row.supersedesId,
    created_at: row.createdAt,
    created_by: row.createdBy,
    version: row.version,
  };
}

export function snapshotLineView(row: PeriodSnapshotLineRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.projectId,
    project_code: row.projectCode,
    unit_id: row.unitId,
    fund_source_version_id: row.fundSourceVersionId,
    bucket: row.bucket,
    budget_level: row.budgetLevel,
    plan_pm_assigned_vnd: row.planPmAssignedVnd,
    plan_local_added_vnd: row.planLocalAddedVnd,
    plan_total_vnd: row.planTotalVnd,
    disbursed_treasury_vnd: row.disbursedTreasuryVnd,
    disbursed_reported_vnd: row.disbursedReportedVnd,
    period_delta_vnd: row.periodDeltaVnd,
    registered_month_vnd: row.registeredMonthVnd,
    forecast_eac_vnd: row.forecastEacVnd,
    ctmtqg_subset_vnd: row.ctmtqgSubsetVnd,
    rate_pm_pct: row.ratePmPct,
    rate_total_pct: row.rateTotalPct,
    rate_null_reason: row.rateNullReason,
    treasury_coverage: row.treasuryCoverage,
    report_revision_id: row.reportRevisionId,
    plan_version_id: row.planVersionId,
  };
}

/** A calendar day, written `YYYY-MM-DD`, that exists. */
function dayOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/**
 * The period snapshot (ST-DIS-009, DIS 3 F6, DIS-21): the executive figures of a period built from the accepted reports, the plan in force and the Treasury up to a cutoff, frozen with the hash of what
 * it holds and replaced only by a newer one. Building freezes nothing; freezing is a second step of its own, taken by someone who holds `snapshot.freeze`, under the version the screen showed.
 */
@Controller()
export class PeriodSnapshotController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly periods = new DisPeriodStore();
  private readonly crossTotals = new DisCrossTotalStore();
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post('period-snapshots')
  @HttpCode(200)
  @OperationId('buildPeriodSnapshot')
  @Command({ operation: 'buildPeriodSnapshot' })
  async build(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DisSnapshotRequest']): Promise<CommandResult> {
    const now = this.clock();
    const kind = body.snapshot_kind as SnapshotKind;
    if (!SNAPSHOT_KINDS.includes(kind)) throw new DomainError('VALIDATION_FAILED', 422, 'snapshot_kind');
    const cutoff = dayOf(body.treasury_cutoff_date, 'treasury_cutoff_date');
    const asOfAt = body.as_of_at === undefined ? now : new Date(body.as_of_at);
    if (Number.isNaN(asOfAt.getTime()) || asOfAt.getTime() > now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_at');
    // The period is held against a close or a lock until the transaction ends.
    const period = await this.periods.find(scope.tx, body.period_id, 'share');
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
    // The Treasury has no figure for a day that has not come, and a figure from before the period began is not the figure of the period.
    if (cutoff < period.startDate || cutoff > vietnamDateOf(now)) throw new DomainError('VALIDATION_FAILED', 422, 'treasury_cutoff_date');
    // The official figure of a period is made once the period is no longer open (assumption: the job builds it after the lock).
    if (kind === OFFICIAL && period.status === 'OPEN') throw new DomainError('PERIOD_STATE_INVALID', 409, 'period_id', { extensions: { period_status: period.status } });
    const visible = projectScope(access, BUILD_PERMISSION, now);
    // A snapshot holds the whole tenant and replaces the build that is waiting: a person who sees a part of the projects makes no figure of the executive (and discards no one else's).
    if (visible(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'snapshot_kind');
    const built = await this.snapshots.build(scope.tx, { period, kind, treasuryCutoffDate: cutoff, asOfAt, actor: scope.tenant.membershipId, scope: visible });
    await scope.audit({
      action: 'dis.snapshot_built',
      resourceType: SNAPSHOT_RESOURCE,
      resourceId: built.snapshot.id,
      diff: {
        period_code: period.code,
        snapshot_kind: kind,
        treasury_cutoff_date: cutoff,
        row_count: built.snapshot.rowCount,
        projects: built.projects,
        definition_status: built.snapshot.definitionStatus,
        metric_set_version: built.snapshot.metricSetVersion,
        discarded_id: built.discardedId,
      },
    });
    await scope.emit({
      aggregateType: SNAPSHOT_RESOURCE,
      aggregateId: built.snapshot.id,
      aggregateVersion: built.snapshot.version,
      type: 'snapshot.built.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        snapshot_id: built.snapshot.id,
        period_id: period.id,
        as_of_date: built.snapshot.asOfDate,
        treasury_cutoff_date: cutoff,
        definition_status: built.snapshot.definitionStatus,
      },
      eventKey: `${SNAPSHOT_RESOURCE}:${built.snapshot.id}:built`,
    });
    scope.afterCommit(() => this.metrics.increment(DIS_SNAPSHOT_BUILD_METRIC, { kind }));
    return commandResult(scope, built.snapshot.status, built.snapshot.version, built.snapshot.id);
  }

  @Post('period-snapshots/:id/freeze')
  @HttpCode(200)
  @OperationId('freezePeriodSnapshot')
  @Command({ operation: 'freezePeriodSnapshot', versioned: true })
  async freeze(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = this.clock();
    // Freezing makes a figure official and replaces the one frozen before: it is for a person whose permission covers the whole tenant.
    if (projectScope(access, FREEZE_PERMISSION, now)(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    // The cross-total control (G4-5): the indicator is not published unless the disbursed money added up by unit, by fund and by project is one number to the dong. It is judged once the snapshot is known to be freezable (the
    // version and the state keep their own answers), and the check is kept whether or not it agrees; a refusal commits the check and the audit row and answers CROSS_TOTAL_MISMATCH naming the dimension that disagrees.
    const pending = await this.snapshots.find(scope.tx, id, true);
    let crossTotalCheckId: string | null = null;
    if (pending !== undefined && pending.status === 'BUILDING' && pending.version === (scope.expectedVersion ?? 0)) {
      const check = await this.crossTotals.evaluate(scope.tx, id, scope.tenant.membershipId, 'FREEZE_GATE');
      const record = crossTotalRecord(check, scope.tenant.tenantId, scope.tenant.membershipId, now);
      await scope.audit(record.audit);
      await scope.emit(record.event);
      if (!check.published) {
        scope.refuseAfterCommit(
          new DomainError('CROSS_TOTAL_MISMATCH', 422, 'dimension', {
            extensions: { cross_total_check_id: check.id, snapshot_id: id, disagreeing: check.disagreeing, agreeing: check.agreeing, totals: { unit: check.totals.UNIT, fund: check.totals.FUND, project: check.totals.PROJECT }, offset_vnd: check.offsetVnd, unattributed_fund_vnd: check.unattributedFundVnd },
          }),
        );
        return commandResult(scope, pending.status, pending.version, id);
      }
      crossTotalCheckId = check.id;
    }
    const done = await this.snapshots.freeze(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, now);
    const { snapshot } = done;
    await scope.audit({
      action: 'dis.snapshot_frozen',
      resourceType: SNAPSHOT_RESOURCE,
      resourceId: id,
      diff: { period_id: snapshot.periodId, snapshot_kind: snapshot.snapshotKind, payload_sha256: snapshot.payloadSha256, row_count: snapshot.rowCount, definition_status: snapshot.definitionStatus, supersedes_id: done.supersededId, cross_total_check_id: crossTotalCheckId, version: snapshot.version },
    });
    await scope.emit({
      aggregateType: SNAPSHOT_RESOURCE,
      aggregateId: id,
      aggregateVersion: snapshot.version,
      type: 'snapshot.frozen.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        snapshot_id: id,
        period_id: snapshot.periodId,
        as_of_date: snapshot.asOfDate,
        treasury_cutoff_date: snapshot.treasuryCutoffDate,
        definition_status: snapshot.definitionStatus,
      },
      eventKey: `${SNAPSHOT_RESOURCE}:${id}:frozen`,
    });
    scope.afterCommit(() => this.metrics.increment(DIS_SNAPSHOT_FREEZE_METRIC, { kind: snapshot.snapshotKind }));
    return commandResult(scope, snapshot.status, snapshot.version, id);
  }

  /** The snapshots of a tenant, newest first, of a period or a kind when named; with a period, the reports that were handed in and are not accepted (what a snapshot leaves out). */
  @Get('period-snapshots')
  @OperationId('listPeriodSnapshots')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('period_id') periodId?: unknown,
    @Query('snapshot_kind') kind?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, undefined);
    const period = optionalUuid(periodId, 'period_id');
    const filterKind = optionalOf(kind, 'snapshot_kind', SNAPSHOT_KINDS);
    const filterStatus = optionalOf(status, 'status', ['BUILDING', 'FROZEN', 'SUPERSEDED', 'FAILED']);
    const scope = projectScope(access, READ_PERMISSION, this.clock());
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.snapshots.list(tx, { periodId: period, kind: filterKind, status: filterStatus }, request.limit);
      const pending = period === undefined ? null : await this.snapshots.pendingReports(tx, period, scope);
      return {
        items: rows.map(snapshotView),
        next_cursor: null,
        pending_reports: pending === null ? null : pending.map((row) => ({ report_id: row.id, project_id: row.projectId, project_code: row.projectCode, revision: row.revision, status: row.status })),
      };
    });
  }

  @Get('period-snapshots/:id/lines')
  @OperationId('listPeriodSnapshotLines')
  async lines(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('project_id') projectId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const filter = { projectId: optionalUuid(projectId, 'project_id'), unitId: optionalUuid(unitId, 'unit_id') };
    const scope = projectScope(access, READ_PERMISSION, this.clock());
    return this.database.withTenant(tenant, async (tx) => {
      const snapshot = await this.snapshots.find(tx, id);
      if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const rows = await this.snapshots.lines(tx, id, scope, filter, { limit: request.limit + 1, after: request.after?.code });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      return {
        snapshot: snapshotView(snapshot),
        items: shown.map(snapshotLineView),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.projectCode}|${last.bucket}|${last.budgetLevel}`, id: last.id }) : null,
      };
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function optionalOf(value: unknown, field: string, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}
