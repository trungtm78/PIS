import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { DisSnapshotStore, HomeReadStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { HomeRankingRow, ScopeBuilder } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_READ_PERMISSION } from './scope-hash';
import { HOME_CLOCK, HOME_RANKING_VISIBILITY } from './tokens';
import type { RankingVisibility } from './tokens';

const DENOMINATORS = ['PM_ASSIGNED', 'TOTAL_INCL_LOCAL'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP = /^[A-Z][A-Z0-9_]{0,39}$/;
/** The terms the formulas are proposals under, until the business owner signs them (CXN-03). */
const LEGAL_REFS = ['CXN-03'];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The ranking of the units of the command center (ST-HOME-003, HOME 3 F3, HOME-04, BR-HOME-06): the ranking that DIS computed when the close snapshot was frozen (ST-DIS-013), of the snapshot named or of the latest
 * that has one, a table for each comparison group and each denominator (the plan the Prime Minister gave, and the plan with what the province added): never mixed, never one rate over another denominator. In each table
 * the units in their order, then the ones that were left out with the reason (a plan of nothing, a plan below the minimum, no figure) and no position. The tenant's policy of visibility (`ALL`, or `OWN_ONLY`: only the
 * units the reader may read) is applied here, not on the screen. HOME ranks nothing itself.
 */
@Controller()
export class HomeRankingsController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly reads = new HomeReadStore();
  private readonly clock: () => Date;
  private readonly visibility: (tenant: TenantContext) => Promise<RankingVisibility>;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
    @Optional() @Inject(HOME_RANKING_VISIBILITY) visibility?: (tenant: TenantContext) => Promise<RankingVisibility>,
  ) {
    this.clock = clock ?? ((): Date => new Date());
    this.visibility = visibility ?? ((): Promise<RankingVisibility> => Promise.resolve('ALL'));
  }

  @Get('home/rankings')
  @OperationId('getDisbursementRankings')
  async rankings(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('snapshot_id') snapshotId?: unknown,
    @Query('comparison_group') comparisonGroup?: unknown,
    @Query('denominator_kind') denominatorKind?: unknown,
  ): Promise<Record<string, unknown>> {
    if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !UUID.test(snapshotId))) throw invalid('snapshot_id');
    if (comparisonGroup !== undefined && (typeof comparisonGroup !== 'string' || !GROUP.test(comparisonGroup))) throw invalid('comparison_group');
    if (denominatorKind !== undefined && (typeof denominatorKind !== 'string' || !(DENOMINATORS as readonly string[]).includes(denominatorKind))) throw invalid('denominator_kind');
    const now = this.clock();
    const visibility = await this.visibility(tenant);
    const unitScope: ScopeBuilder | undefined = visibility === 'OWN_ONLY' ? (first) => scopePredicate(access, HOME_READ_PERMISSION, now, { unitPath: 'u.path', unitId: 'u.id' }, first) : undefined;
    const read = await this.database.withTenant(tenant, async (tx) => {
      const id = snapshotId === undefined ? await this.reads.latestRanked(tx) : snapshotId.toLowerCase();
      const snapshot = id === undefined ? undefined : await this.snapshots.find(tx, id);
      if (snapshot === undefined || snapshot.status !== 'FROZEN' || !(await this.reads.hasRanking(tx, snapshot.id))) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      const rows = await this.reads.rankings(tx, snapshot.id, { comparisonGroup: comparisonGroup as string | undefined, denominatorKind: denominatorKind as string | undefined }, unitScope);
      return { snapshot, rows };
    });
    const tables = new Map<string, { comparison_group: string; denominator_kind: string; ranked: Array<Record<string, unknown>>; excluded: Array<Record<string, unknown>> }>();
    for (const row of read.rows) {
      const key = `${row.comparisonGroup}|${row.denominatorKind}`;
      const table = tables.get(key) ?? { comparison_group: row.comparisonGroup, denominator_kind: row.denominatorKind, ranked: [], excluded: [] };
      tables.set(key, table);
      (row.rank === null ? table.excluded : table.ranked).push(rowView(row));
    }
    return {
      snapshot_id: read.snapshot.id,
      as_of_date: read.snapshot.asOfDate,
      treasury_cutoff_date: read.snapshot.treasuryCutoffDate,
      definition_status: read.snapshot.definitionStatus,
      legal_confirmation_refs: LEGAL_REFS,
      visibility,
      tables: [...tables.values()],
    };
  }
}

function rowView(row: HomeRankingRow): Record<string, unknown> {
  return {
    rank: row.rank,
    unit: { id: row.unitId, code: row.unitCode, name: row.unitName },
    plan_vnd: row.planVnd,
    disbursed_vnd: row.disbursedVnd,
    rate_pct: row.ratePct,
    excluded_reason: row.excludedReason,
  };
}
