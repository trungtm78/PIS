import { DEFAULT_MINIMUM_PLAN_VND, DomainError, rankUnits } from '@machvon/kernel';
import type { Ranking } from '@machvon/kernel';
import { DisSnapshotStore } from './dis-snapshot-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const RANKING_RESOURCE = 'disbursement_ranking';
export const DENOMINATORS = ['PM_ASSIGNED', 'TOTAL_INCL_LOCAL'] as const;
export type DenominatorKind = (typeof DENOMINATORS)[number];

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

export interface RankingRow {
  id: string;
  snapshotId: string;
  comparisonGroup: string;
  unitId: string;
  unitCode: string | null;
  denominatorKind: DenominatorKind;
  planVnd: string;
  disbursedVnd: string | null;
  ratePct: string | null;
  rank: number | null;
  excludedReason: string | null;
}

interface RankingSql {
  id: string;
  snapshot_id: string;
  comparison_group: string;
  unit_id: string;
  unit_code: string | null;
  denominator_kind: DenominatorKind;
  plan_vnd: string;
  disbursed_vnd: string | null;
  rate_pct: string | null;
  rank: number | null;
  excluded_reason: string | null;
}

export interface Computation {
  /** Why nothing was computed, when nothing was. */
  skipped: 'NOT_FROZEN' | 'NOT_CLOSE' | 'ALREADY_COMPUTED' | undefined;
  groups: number;
  ranked: number;
  excluded: number;
}

interface UnitSums {
  unit_id: string;
  code: string | null;
  unit_type: string | null;
  plan_pm: string;
  plan_local: string;
  treasury: string | null;
}

/**
 * The ranking of the units of a comparison group (ST-DIS-013, DIS 3 F8, BR-DIS-10): computed once when a close snapshot is frozen, for each group of units (the type of the unit: a department, a project
 * management board, a commune) and separately for each denominator, the plan the Prime Minister gave and the plan with the local addition. The order and the exclusions are those of the kernel (`rankUnits`):
 * the unit with a plan below the minimum, with none, or with no figure is left out with its reason and has no position.
 */
export class DisRankingStore {
  private readonly snapshots = new DisSnapshotStore();

  /** Computes and keeps the ranking of a frozen close snapshot; one that has been computed is not computed again. */
  async compute(tx: TenantTx, snapshotId: string, minimumPlanVnd: string = DEFAULT_MINIMUM_PLAN_VND): Promise<Computation> {
    const none = (skipped: Computation['skipped']): Computation => ({ skipped, groups: 0, ranked: 0, excluded: 0 });
    const snapshot = await this.snapshots.find(tx, snapshotId);
    if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    if (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED') return none('NOT_FROZEN');
    if (snapshot.snapshotKind !== 'PERIOD_CLOSE') return none('NOT_CLOSE');
    await tx.query(`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':ranking:' || $1, 0))`, [snapshotId]);
    const [known] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.disbursement_ranking where snapshot_id = $1::uuid', [snapshotId]);
    if (Number((known as { n: string }).n) > 0) return none('ALREADY_COMPUTED');
    const units = await tx.query<UnitSums>(
      `select l.unit_id, u.code, u.unit_type,
              coalesce(sum(l.plan_pm_assigned_vnd) filter (where l.bucket = 'CURRENT_YEAR'), 0)::text as plan_pm,
              coalesce(sum(l.plan_local_added_vnd) filter (where l.bucket = 'CURRENT_YEAR'), 0)::text as plan_local,
              sum(l.disbursed_treasury_vnd) filter (where l.bucket = 'CURRENT_YEAR')::text as treasury
         from machvon.period_snapshot_line l left join machvon.organization_unit u on u.tenant_id = l.tenant_id and u.id = l.unit_id
        where l.snapshot_id = $1::uuid
        group by l.unit_id, u.code, u.unit_type`,
      [snapshotId],
    );
    const groups = new Map<string, UnitSums[]>();
    for (const unit of units) groups.set(unit.unit_type ?? 'OTHER', [...(groups.get(unit.unit_type ?? 'OTHER') ?? []), unit]);
    const rows: Array<Record<string, unknown>> = [];
    let ranked = 0;
    let excluded = 0;
    for (const [group, members] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      // The code breaks a tie, and the unit stays itself whatever its code is: a unit that was dissolved may share its code with the one that took its place.
      const keyOf = (unit: UnitSums): string => `${unit.code ?? ''}|${unit.unit_id}`;
      const byKey = new Map(members.map((unit) => [keyOf(unit), unit]));
      for (const kind of DENOMINATORS) {
        const planOf = (unit: UnitSums): string => (kind === 'PM_ASSIGNED' ? unit.plan_pm : (BigInt(unit.plan_pm) + BigInt(unit.plan_local)).toString());
        const ranking: Ranking = rankUnits(
          members.map((unit) => ({ code: keyOf(unit), planVnd: planOf(unit), disbursedVnd: unit.treasury })),
          minimumPlanVnd,
        );
        for (const item of ranking.ranked) {
          const unit = byKey.get(item.code) as UnitSums;
          rows.push({ group, kind, unit_id: unit.unit_id, plan: planOf(unit), disbursed: item.disbursedVnd, rate: item.ratePct, rank: item.rank, reason: null });
          ranked += 1;
        }
        for (const item of ranking.excluded) {
          const unit = byKey.get(item.code) as UnitSums;
          rows.push({ group, kind, unit_id: unit.unit_id, plan: planOf(unit), disbursed: unit.treasury, rate: null, rank: null, reason: item.reason });
          excluded += 1;
        }
      }
    }
    if (rows.length > 0) {
      await tx.query(
        `insert into machvon.disbursement_ranking (tenant_id, id, snapshot_id, comparison_group, unit_id, denominator_kind, plan_vnd, disbursed_vnd, rate_pct, rank, excluded_reason)
         select ${TENANT}, gen_random_uuid(), $1::uuid, x.grp, x.unit_id, x.kind, x.plan, x.disbursed, x.rate, x.rank, x.reason
           from jsonb_to_recordset($2::jsonb) as x(grp text, unit_id uuid, kind text, plan numeric, disbursed numeric, rate numeric, rank int, reason text)`,
        [snapshotId, JSON.stringify(rows.map((row) => ({ ...row, grp: row.group })))],
      );
    }
    return { skipped: undefined, groups: groups.size, ranked, excluded };
  }

  /** The rows of a ranking of a snapshot, a table for each group and denominator: the units in their order, then the ones that were left out. */
  async list(tx: TenantTx, snapshotId: string, filter: { comparisonGroup?: string | undefined; denominatorKind?: string | undefined } = {}): Promise<RankingRow[]> {
    const rows = await tx.query<RankingSql>(
      `select r.id, r.snapshot_id, r.comparison_group, r.unit_id, u.code as unit_code, r.denominator_kind, r.plan_vnd::text as plan_vnd, r.disbursed_vnd::text as disbursed_vnd, r.rate_pct::text as rate_pct, r.rank, r.excluded_reason
         from machvon.disbursement_ranking r left join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.unit_id
        where r.snapshot_id = $1::uuid and ($2::text is null or r.comparison_group = $2) and ($3::text is null or r.denominator_kind = $3)
        order by r.comparison_group, r.denominator_kind, r.rank nulls last, u.code, r.unit_id`,
      [snapshotId, filter.comparisonGroup ?? null, filter.denominatorKind ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      snapshotId: row.snapshot_id,
      comparisonGroup: row.comparison_group,
      unitId: row.unit_id,
      unitCode: row.unit_code,
      denominatorKind: row.denominator_kind,
      planVnd: row.plan_vnd,
      disbursedVnd: row.disbursed_vnd,
      ratePct: row.rate_pct,
      rank: row.rank,
      excludedReason: row.excluded_reason,
    }));
  }
}
