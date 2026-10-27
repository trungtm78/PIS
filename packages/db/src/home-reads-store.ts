import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface HomeLeader {
  membershipId: string;
  displayName: string;
}

export interface HomeRule {
  id: string;
  metricCode: string;
  comparator: string;
  threshold: Record<string, unknown>;
}

export interface HomeExplanation {
  id: string;
  status: string;
  dueAt: string;
  isLate: boolean;
  requestedAt: string;
  requestedBy: string | null;
  respondedAt: string | null;
}

export interface HomeRankingRow {
  comparisonGroup: string;
  denominatorKind: string;
  unitId: string;
  unitCode: string | null;
  unitName: string | null;
  planVnd: string;
  disbursedVnd: string | null;
  ratePct: string | null;
  rank: number | null;
  excludedReason: string | null;
}

const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * What the warning and ranking screens of HOME read beside the rows DIS keeps (ST-HOME-003): the leader in charge of a project now (the same reading as DIS-24), the rule a warning was opened under, the explanation that
 * was asked for on it, and the ranking of a snapshot with the names of its units. HOME owns none of it: each is a read of the tables of DIS, PRJ and ADM.
 */
export class HomeReadStore {
  /** The leader in charge now of each project (a project with none is not in the answer). */
  async leadersOf(tx: TenantTx, projectIds: readonly string[]): Promise<Map<string, HomeLeader>> {
    const found = new Map<string, HomeLeader>();
    if (projectIds.length === 0) return found;
    const rows = await tx.query<{ project_id: string; leader_membership_id: string; display_name: string | null }>(
      `select p.id as project_id, lead.leader_membership_id, lu.display_name
         from machvon.project p
         join lateral (select a.leader_membership_id from machvon.project_accountability a
                        where a.tenant_id = p.tenant_id and a.project_id = p.id and a.accountability_role = 'LEADER_IN_CHARGE' and a.status = 'ACTIVE'
                        order by a.valid_from desc, a.id limit 1) lead on true
         left join machvon.tenant_user_directory lu on lu.tenant_id = p.tenant_id and lu.membership_id = lead.leader_membership_id
        where p.id = any($1::uuid[])`,
      [[...new Set(projectIds)]],
    );
    for (const row of rows) found.set(row.project_id, { membershipId: row.leader_membership_id, displayName: row.display_name ?? '' });
    return found;
  }

  /** The rules that warnings were opened under: what they measured, how they compared and the threshold. */
  async rulesOf(tx: TenantTx, ruleIds: readonly string[]): Promise<Map<string, HomeRule>> {
    const found = new Map<string, HomeRule>();
    if (ruleIds.length === 0) return found;
    const rows = await tx.query<{ id: string; metric_code: string; comparator: string; threshold_json: Record<string, unknown> }>(
      'select id, metric_code, comparator, threshold_json from machvon.early_warning_rule where id = any($1::uuid[])',
      [[...new Set(ruleIds)]],
    );
    for (const row of rows) found.set(row.id, { id: row.id, metricCode: row.metric_code, comparator: row.comparator, threshold: row.threshold_json });
    return found;
  }

  /** The explanation requests that were asked for on warnings, by their ids. */
  async explanationsOf(tx: TenantTx, ids: readonly string[]): Promise<Map<string, HomeExplanation>> {
    const found = new Map<string, HomeExplanation>();
    if (ids.length === 0) return found;
    const rows = await tx.query<{ id: string; status: string; due_at: string; is_late: boolean; created_at: string; created_by: string | null; responded_at: string | null }>(
      `select id, status, ${iso('due_at')} as due_at, is_late, ${iso('created_at')} as created_at, created_by, ${iso('responded_at')} as responded_at
         from machvon.explanation_request where id = any($1::uuid[])`,
      [[...new Set(ids)]],
    );
    for (const row of rows) found.set(row.id, { id: row.id, status: row.status, dueAt: row.due_at, isLate: row.is_late, requestedAt: row.created_at, requestedBy: row.created_by, respondedAt: row.responded_at });
    return found;
  }

  /** The ranking of a snapshot, each group and denominator apart: the units in their order, then the ones that were left out, each with the name of the unit. With `unitScope`, only the units the reader may read. */
  async rankings(
    tx: TenantTx,
    snapshotId: string,
    filter: { comparisonGroup: string | undefined; denominatorKind: string | undefined },
    unitScope: ScopeBuilder | undefined,
  ): Promise<HomeRankingRow[]> {
    const visible = unitScope === undefined ? undefined : unitScope(4);
    const rows = await tx.query<{
      comparison_group: string;
      denominator_kind: string;
      unit_id: string;
      unit_code: string | null;
      unit_name: string | null;
      plan_vnd: string;
      disbursed_vnd: string | null;
      rate_pct: string | null;
      rank: number | null;
      excluded_reason: string | null;
    }>(
      `select r.comparison_group, r.denominator_kind, r.unit_id, u.code as unit_code, u.name as unit_name, r.plan_vnd::text as plan_vnd, r.disbursed_vnd::text as disbursed_vnd, r.rate_pct::text as rate_pct, r.rank, r.excluded_reason
         from machvon.disbursement_ranking r join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.unit_id
        where r.snapshot_id = $1::uuid and ($2::text is null or r.comparison_group = $2) and ($3::text is null or r.denominator_kind = $3)${visible === undefined ? '' : ` and ${visible.sql}`}
        order by r.comparison_group, r.denominator_kind, r.rank nulls last, u.code, r.unit_id`,
      [snapshotId, filter.comparisonGroup ?? null, filter.denominatorKind ?? null, ...(visible?.params ?? [])],
    );
    return rows.map((row) => ({
      comparisonGroup: row.comparison_group,
      denominatorKind: row.denominator_kind,
      unitId: row.unit_id,
      unitCode: row.unit_code,
      unitName: row.unit_name,
      planVnd: row.plan_vnd,
      disbursedVnd: row.disbursed_vnd,
      ratePct: row.rate_pct,
      rank: row.rank,
      excludedReason: row.excluded_reason,
    }));
  }

  /** Whether a snapshot has a ranking at all (a snapshot that was not a close one, or was frozen before the job ran, has none). */
  async hasRanking(tx: TenantTx, snapshotId: string): Promise<boolean> {
    const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.disbursement_ranking where snapshot_id = $1::uuid', [snapshotId]);
    return Number(row?.n ?? 0) > 0;
  }

  /** The latest frozen close snapshot that has a ranking: the one the ranking opens on when none is named. */
  async latestRanked(tx: TenantTx): Promise<string | undefined> {
    const [row] = await tx.query<{ id: string }>(
      `select s.id from machvon.period_snapshot s
        where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and exists (select 1 from machvon.disbursement_ranking r where r.snapshot_id = s.id)
        order by s.frozen_at desc, s.created_at desc, s.id desc limit 1`,
    );
    return row?.id;
  }

  /** A project the reader may read (the evidence of a warning is of one). */
  async projectReadable(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<boolean> {
    const visible = scope(2);
    const [row] = await tx.query<{ n: string }>(`select count(*)::text as n from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql}`, [projectId, ...visible.params]);
    return Number(row?.n ?? 0) > 0;
  }
}
