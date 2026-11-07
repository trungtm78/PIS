import { randomBytes } from 'node:crypto';
import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { DIS_RATE_NULL_METRIC, TenantDatabase } from '@machvon/db';
import { DomainError, NOOP_METRICS, homeSnapshotState, signHomeContext, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HomeFigureReader } from './figures';
import { scopeHashOf } from './scope-hash';
import { HOME_CLOCK, HOME_CONTEXT_KEY, HOME_METRICS } from './tokens';

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

/**
 * The command center of the leader (ST-HOME-001, HOME 3 F1, HOME-09, HOME-01, BR-HOME-01): the two disbursement rates, the amounts, and the counts of what waits (open warnings, overdue explanations, proposals of
 * reallocation), all from the latest frozen snapshot, or the one the leader pinned. Each tile is given with the scope it was counted for, the day it is as of, the snapshot, its unit and its formula, and with a signed token
 * that the drill (HOME-10) takes back. The rates are made from the sums of the lines, by the same code as DIS-19, so the two screens cannot disagree. A figure that cannot be given is null and says why (never 0); a
 * snapshot that is not frozen is not shown. HOME owns no table: nothing is written, and the figures are those of the snapshot until a newer one is frozen.
 */
@Controller()
export class CommandCenterController {
  private readonly figures: HomeFigureReader;
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
    this.figures = new HomeFigureReader(database);
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
    // The figures come from the register (G0-4): one definition for each, the certification a leader is held to (G3-1), the flags that sit on the number. The file and the phone read the same result.
    const read = await this.figures.read(tenant, access, { snapshotId: filter.snapshotId, unitId: filter.unitId }, now, today);
    const { snapshot, figures } = read;
    const scopeHash = scopeHashOf(tenant, access, filter.unitId ?? null, now);
    const tiles = read.tiles.map((tile) => ({
      metric_code: tile.metric_code,
      value: tile.value,
      display_value: tile.display_value,
      numerator: tile.numerator,
      denominator: tile.denominator,
      null_reason: tile.null_reason,
      unit: tile.unit,
      formula: tile.formula,
      definition_status: tile.definition_status,
      kpi: tile.kpi,
      certification: tile.certification,
      flags: tile.flags,
      context_token: signHomeContext({ tenantId: tenant.tenantId, membershipId: tenant.membershipId, snapshotId: snapshot.id, scopeHash, metricCode: tile.metric_code, unitId: filter.unitId ?? null, unitExact: false, projectId: null, lineId: null }, this.key, () => Math.floor(now.getTime() / 1000)),
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
      count_tiles: read.countTiles,
      projects_without_data: read.withoutData,
      open_warnings: read.counts.openWarnings,
      overdue_explanations: read.counts.overdueExplanations,
      pending_reallocations: read.counts.pendingReallocations,
      // Data governance (DGV) feeds this when it is deployed (ST-HOME-007); until then the quality is not assessed, and the screen says so.
      quality_badge: 'NOT_ASSESSED',
    };
  }
}
