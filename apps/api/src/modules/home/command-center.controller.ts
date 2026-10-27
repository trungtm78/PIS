import { randomBytes } from 'node:crypto';
import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_RATE_NULL_METRIC, DisSnapshotStore, HomeStore, TenantDatabase, projectScope, scopePredicate } from '@machvon/db';
import type { ScopeBuilder } from '@machvon/db';
import { DomainError, NOOP_METRICS, addSums, homeScopeFingerprint, homeScopeHash, homeSnapshotState, homeTiles, rateOfSums, signHomeContext, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_CLOCK, HOME_CONTEXT_KEY, HOME_METRICS } from './tokens';

const READ_PERMISSION = PERMISSIONS.getCommandCenter;
/** Counted for every tile that has no figure, by the reason it gives (home_null_tile_total{reason}). */
export const HOME_NULL_TILE_METRIC = 'home_null_tile_total';
/** The terms the formulas are proposals under, until the business owner signs them (CXN-03). */
const LEGAL_REFS = ['CXN-03'];
const DENOMINATORS = ['PM_ASSIGNED', 'TOTAL'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function optionalDenominator(value: unknown): (typeof DENOMINATORS)[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(DENOMINATORS as readonly string[]).includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'denominator_kind');
  return value as (typeof DENOMINATORS)[number];
}

const unitScope =
  (access: EffectiveAccess, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, READ_PERMISSION, now, { unitPath: 'u.path', unitId: 'u.id' }, first);

/**
 * The command center of the leader (ST-HOME-001, HOME 3 F1, HOME-09, HOME-01, BR-HOME-01): the two disbursement rates, the amounts, and the counts of what waits (open warnings, overdue explanations, proposals of
 * reallocation), all from the latest frozen snapshot, or the one the leader pinned. Each tile is given with the scope it was counted for, the day it is as of, the snapshot, its unit and its formula, and with a signed token
 * that the drill (HOME-10) takes back. The rates are made from the sums of the lines, by the same code as DIS-19, so the two screens cannot disagree. A figure that cannot be given is null and says why (never 0); a
 * snapshot that is not frozen is not shown. HOME owns no table: nothing is written, and the figures are those of the snapshot until a newer one is frozen.
 */
@Controller()
export class CommandCenterController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly home = new HomeStore();
  private readonly clock: () => Date;
  private readonly metrics: MetricsSink;
  private readonly key: Buffer;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
    @Optional() @Inject(HOME_METRICS) metrics?: MetricsSink,
    // Without a configured key the tokens are good for this process only: a restart makes every token of before invalid, which the screen answers by asking for new ones.
    @Optional() @Inject(HOME_CONTEXT_KEY) key?: Buffer,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.metrics = metrics ?? NOOP_METRICS;
    this.key = key ?? randomBytes(32);
  }

  @Get('home/command-center')
  @OperationId('getCommandCenter')
  async commandCenter(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('snapshot_id') snapshotId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('denominator_kind') denominatorKind?: unknown,
  ): Promise<Record<string, unknown>> {
    const filter = { snapshotId: optionalUuid(snapshotId, 'snapshot_id'), unitId: optionalUuid(unitId, 'unit_id'), denominator: optionalDenominator(denominatorKind) };
    const now = this.clock();
    const today = vietnamDateOf(now);
    const projects = projectScope(access, READ_PERMISSION, now);
    const units = unitScope(access, now);
    const read = await this.database.withTenant(tenant, async (tx) => {
      if (filter.unitId !== undefined && !(await this.home.unitReadable(tx, units, filter.unitId))) throw new DomainError('SCOPE_DENIED', 403);
      const snapshot = filter.snapshotId === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, filter.snapshotId);
      if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      if (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
      const query = { basis: 'CURRENT_YEAR' as const, underUnitId: filter.unitId };
      const whole = await this.snapshots.rateSums(tx, snapshot.id, projects, { ...query, groupBy: 'NONE' });
      const perProject = await this.snapshots.rateSums(tx, snapshot.id, projects, { ...query, groupBy: 'PROJECT' });
      const counts = await this.home.counts(tx, { projectScope: projects, unitScope: units, unitId: filter.unitId, now });
      return { snapshot, sums: addSums(whole.map((row) => row.sums)), withoutData: perProject.filter((row) => row.sums.allNone).length, counts };
    });
    const { snapshot } = read;
    // BR-HOME-01: a figure is given with its scope, day, snapshot, unit and formula, or it is not given.
    if (snapshot.asOfDate === '') throw new DomainError('METRIC_UNAVAILABLE', 422, 'snapshot_id');
    const scopeHash = homeScopeHash({ membershipId: tenant.membershipId, scopeVersion: tenant.scopeVersion, unitId: filter.unitId ?? null, grants: homeScopeFingerprint(access, READ_PERMISSION, now) });
    const figures = rateOfSums(read.sums, 'CURRENT_YEAR');
    const tiles = homeTiles(figures, snapshot.definitionStatus).map((tile) => ({
      metric_code: tile.metricCode,
      value: tile.value,
      numerator: tile.numerator,
      denominator: tile.denominator,
      null_reason: tile.nullReason,
      unit: tile.unit,
      formula: tile.formula,
      definition_status: tile.definitionStatus,
      context_token: signHomeContext({ tenantId: tenant.tenantId, snapshotId: snapshot.id, scopeHash, metricCode: tile.metricCode, unitId: filter.unitId ?? null }, this.key, () => Math.floor(now.getTime() / 1000)),
    }));
    for (const tile of tiles) {
      if (tile.null_reason !== null) this.metrics.increment(HOME_NULL_TILE_METRIC, { reason: tile.null_reason });
    }
    if (figures.rateNullReason !== null) this.metrics.increment(DIS_RATE_NULL_METRIC, { reason: figures.rateNullReason });
    return {
      snapshot_id: snapshot.id,
      snapshot_kind: snapshot.snapshotKind,
      as_of_date: snapshot.asOfDate,
      treasury_cutoff_date: snapshot.treasuryCutoffDate,
      freshness: homeSnapshotState(snapshot.asOfDate, today),
      definition_status: snapshot.definitionStatus,
      legal_confirmation_refs: LEGAL_REFS,
      scope: { unit_id: filter.unitId ?? null, denominator_kind: filter.denominator ?? null, projects: read.sums.projects, scope_hash: scopeHash },
      tiles,
      projects_without_data: read.withoutData,
      open_warnings: read.counts.openWarnings,
      overdue_explanations: read.counts.overdueExplanations,
      pending_reallocations: read.counts.pendingReallocations,
      // Data governance (DGV) feeds this when it is deployed (ST-HOME-007); until then the quality is not assessed, and the screen says so.
      quality_badge: 'NOT_ASSESSED',
    };
  }
}
