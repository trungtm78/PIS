import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { TenantDatabase, projectScope } from '@machvon/db';
import { DomainError, EnterpriseFigureReader, NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { BLOCKED_DEFINITION_STATUS, BLOCKED_FORMULA, BLOCKED_STALLED_DAYS_DEFAULT, LeaderStore, blockedBoard, cutsOf, leaderRateBoard, structureOf } from '@machvon/edition-enterprise/src/server.ts';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { ENTERPRISE_METRICS } from './tokens';

/** The permission the leadership dashboard is read under: the one of HOME (the figures are read in the projects the reader may read). */
const LEADER_READ = 'home.read';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LEADER_NULL_METRIC = 'leader_rate_null_total';
/** The reason of the empty answer of `getLeaderRates`: no enterprise snapshot has been frozen yet. */
export const LEADER_NO_SNAPSHOT_REASON = 'NO_FROZEN_SNAPSHOT';

/**
 * The leadership dashboard of the enterprise edition (ENT-4d, HSKT BC.02): the disbursement against the annual plan by company, unit and project with the same period of last year, read from the frozen enterprise
 * snapshot through the one reader (`EnterpriseFigureReader`, R21), and the projects blocked on procedure. Nothing is written. Figures are those of the snapshot until a newer one is frozen; a figure that cannot be
 * given is null with its reason and never 0. The answer also tells the funding structure of the same snapshot (equity, loan, other: the classes of the enterprise taxonomy), which HOME-07 shows. The public edition does not mount this controller, so the rates of HOME-01 and HOME-09 cannot move.
 */
@Controller()
export class LeaderReadsController {
  private readonly store = new LeaderStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(ENTERPRISE_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Get('leader/rates')
  @OperationId('getLeaderRates')
  async rates(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('snapshot_id') snapshotId?: unknown): Promise<Record<string, unknown>> {
    if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !UUID.test(snapshotId))) throw new DomainError('VALIDATION_FAILED', 422, 'snapshot_id');
    const now = new Date();
    const scope = projectScope(access, LEADER_READ, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      const pair = await this.store.pair(tx, snapshotId);
      // No snapshot is frozen yet: an answer (200, `snapshot: null` and the reason), not a failed request. A snapshot that was named and is not there stays a 404.
      if (pair === undefined && snapshotId === undefined) return undefined;
      if (pair === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      if (pair.current.status !== 'FROZEN' && pair.current.status !== 'SUPERSEDED') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
      const visible = await this.store.visibleProjects(tx, scope);
      const reader = new EnterpriseFigureReader(await this.store.view(tx, pair.current));
      const prior = pair.prior === undefined ? undefined : new EnterpriseFigureReader(await this.store.view(tx, pair.prior));
      const directory = await this.store.directory(tx, reader.unitIds(), reader.projectIds());
      const current = cutsOf(reader, directory, visible);
      const before = prior === undefined ? undefined : cutsOf(prior, directory, visible);
      const allowed = visible === undefined ? undefined : new Set(visible);
      const structure = structureOf(reader, allowed === undefined ? {} : { projectIds: reader.projectIds().filter((id) => allowed.has(id)) });
      return { board: leaderRateBoard({ current, previous: before }), structure };
    });
    if (read === undefined) return { snapshot: null, reason: LEADER_NO_SNAPSHOT_REASON, as_of: now.toISOString() };
    const { board, structure } = read;
    if (board.company.ratePct === null) this.metrics.increment(LEADER_NULL_METRIC, { reason: board.company.nullReason ?? 'NO_DATA' });
    const rowDto = (row: (typeof board)['company']): Record<string, unknown> => ({
      level: row.level,
      id: row.id,
      code: row.code,
      name: row.name,
      projects: row.projects,
      plan_vnd: row.planVnd,
      disbursed_vnd: row.disbursedVnd,
      rate_pct: row.ratePct,
      null_reason: row.nullReason,
      last_year: { rate_pct: row.lastYear.ratePct, disbursed_vnd: row.lastYear.disbursedVnd, null_reason: row.lastYear.nullReason },
      delta_points: row.deltaPoints,
      trend: row.trend,
    });
    return {
      snapshot_id: board.snapshotId,
      as_of_date: board.asOfDate,
      revision: board.revision,
      snapshot_hash: board.hash,
      prior_snapshot_id: board.priorSnapshotId,
      prior_as_of_date: board.priorAsOfDate,
      definition_status: 'PROPOSED_PENDING_SIGNOFF',
      formula: 'cumulative disbursed since the start of the year over the annual plan in force (RATE_YEAR_IN_FORCE); the rate of a group is the sum of the numerators over the sum of the denominators',
      company: rowDto(board.company),
      units: board.units.map(rowDto),
      projects: board.projects.map(rowDto),
      structure: {
        measure: structure.measure,
        plan_total_vnd: structure.planTotalVnd,
        disbursed_total_vnd: structure.disbursedTotalVnd,
        classes: structure.classes.map((one) => ({
          class_code: one.classCode,
          plan_vnd: one.planVnd,
          disbursed_vnd: one.disbursedVnd,
          plan_share_pct: one.planSharePct,
          disbursed_share_pct: one.disbursedSharePct,
          rate_pct: one.ratePct,
          null_reason: one.nullReason,
        })),
      },
      as_of: now.toISOString(),
    };
  }

  @Get('leader/blocked-projects')
  @OperationId('getBlockedProjects')
  async blocked(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const scope = projectScope(access, LEADER_READ, now);
    const read = await this.database.withTenant(tenant, (tx) => this.store.blockFacts(tx, scope, today, BLOCKED_STALLED_DAYS_DEFAULT));
    const board = blockedBoard(read.facts, today);
    return {
      as_of_date: today,
      total: board.total,
      by_source: board.bySource,
      truncated: board.truncated || read.cut.length > 0,
      cut_sources: read.cut,
      stalled_days: BLOCKED_STALLED_DAYS_DEFAULT,
      definition_status: BLOCKED_DEFINITION_STATUS,
      formula: BLOCKED_FORMULA,
      projects: board.projects.map((project) => ({ project_id: project.projectId, project_code: project.projectCode, project_name: project.projectName, unit_id: project.unitId, unit_name: project.unitName, sources: project.sources, items: project.items, since: project.since, days: project.days })),
      as_of: now.toISOString(),
    };
  }
}
