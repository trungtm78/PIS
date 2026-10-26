import { weeklyActual, weeklyDifference } from '@machvon/kernel';
import type { FrozenWeek } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface WeeklyPlanRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  leader: { membershipId: string; displayName: string } | null;
  periodId: string;
  periodCode: string;
  startDate: string;
  endDate: string;
  commitmentVnd: string;
  /** What the Treasury paid in the week, or null while the week has no frozen close snapshot. */
  actualVnd: string | null;
  /** The actual less the commitment (negative when the week fell short), null with no actual. */
  differenceVnd: string | null;
  /** True when no earlier week of the year was frozen and the actual is counted from the first day of the year. */
  fromYearStart: boolean;
}

interface CommitmentSql {
  project_id: string;
  project_code: string;
  project_name: string;
  leader_membership_id: string | null;
  leader_name: string | null;
  period_id: string;
  period_code: string;
  fiscal_year: number;
  start_date: string;
  end_date: string;
  commitment: string;
}

/**
 * The weekly commitment of each project against what the Treasury paid (ST-DIS-014, DIS 3 F8, Directive 162): the commitments are the current WEEKLY_COMMITMENT lines of the capital schedule, the actuals
 * come from the frozen close snapshots (`weeklyActual`), the leader is the current LEADER_IN_CHARGE of the project. A plan is never added to a disbursement: they are two columns and their difference.
 */
export class DisWeeklyPlanStore {
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: { planYear: number; projectId?: string | undefined; unitId?: string | undefined },
    page: { limit: number; after: string | undefined },
  ): Promise<WeeklyPlanRow[]> {
    const visible = scope(6);
    const rows = await tx.query<CommitmentSql>(
      `select s.project_id, p.code as project_code, p.name as project_name, lead.leader_membership_id, lu.display_name as leader_name,
              rp.id as period_id, rp.code as period_code, rp.fiscal_year, rp.start_date::text as start_date, rp.end_date::text as end_date, sum(s.amount_vnd)::text as commitment
         from machvon.disbursement_schedule_line s
         join machvon.reporting_period rp on rp.tenant_id = s.tenant_id and rp.id = s.period_id
         join ${SCOPE_FROM} on p.tenant_id = s.tenant_id and p.id = s.project_id
         left join lateral (select a.leader_membership_id from machvon.project_accountability a
                             where a.tenant_id = s.tenant_id and a.project_id = s.project_id and a.accountability_role = 'LEADER_IN_CHARGE' and a.status = 'ACTIVE'
                             order by a.valid_from desc, a.id limit 1) lead on true
         left join machvon.tenant_user_directory lu on lu.tenant_id = s.tenant_id and lu.membership_id = lead.leader_membership_id
        where s.kind = 'WEEKLY_COMMITMENT' and s.granularity = 'WEEK' and s.is_current and s.plan_year = $1::int
          and ($2::uuid is null or s.project_id = $2::uuid) and ($3::uuid is null or p.owner_unit_id = $3::uuid)
          and ($4::text is null or (p.code || '|' || rp.start_date::text) collate "C" > $4::text collate "C") and ${visible.sql}
        group by s.project_id, p.code, p.name, lead.leader_membership_id, lu.display_name, rp.id, rp.code, rp.fiscal_year, rp.start_date, rp.end_date
        order by (p.code || '|' || rp.start_date::text) collate "C" limit $5::int`,
      [filter.planYear, filter.projectId ?? null, filter.unitId ?? null, page.after ?? null, page.limit, ...visible.params],
    );
    if (rows.length === 0) return [];
    const years = [...new Set(rows.map((row) => row.fiscal_year))];
    const frozen = await tx.query<{ period_id: string; end_date: string; fiscal_year: number }>(
      `select distinct on (s.period_id) s.period_id, rp.end_date::text as end_date, rp.fiscal_year
         from machvon.period_snapshot s join machvon.reporting_period rp on rp.tenant_id = s.tenant_id and rp.id = s.period_id
        where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and rp.fiscal_year = any($1::int[]) and rp.period_type = 'WEEK'
        order by s.period_id, s.frozen_at desc, s.id`,
      [years],
    );
    const projectIds = [...new Set(rows.map((row) => row.project_id))];
    const sums = await tx.query<{ project_id: string; period_id: string; cumulative: string }>(
      `select l.project_id, sn.period_id, sum(l.disbursed_treasury_vnd)::text as cumulative
         from (select distinct on (s.period_id) s.id, s.period_id
                 from machvon.period_snapshot s join machvon.reporting_period rp on rp.tenant_id = s.tenant_id and rp.id = s.period_id
                where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and rp.fiscal_year = any($1::int[]) and rp.period_type = 'WEEK'
                order by s.period_id, s.frozen_at desc, s.id) sn
         join machvon.period_snapshot_line l on l.snapshot_id = sn.id
        where l.project_id = any($2::uuid[]) and l.disbursed_treasury_vnd is not null
        group by l.project_id, sn.period_id`,
      [years, projectIds],
    );
    const cumulative = new Map(sums.map((row) => [`${row.project_id}|${row.period_id}`, row.cumulative]));
    return rows.map((row) => {
      const weeks: FrozenWeek[] = frozen.filter((week) => week.fiscal_year === row.fiscal_year).map((week) => ({ periodId: week.period_id, endDate: week.end_date, cumulativeVnd: cumulative.get(`${row.project_id}|${week.period_id}`) ?? null }));
      const actual = weeklyActual(weeks, row.period_id);
      return {
        projectId: row.project_id,
        projectCode: row.project_code,
        projectName: row.project_name,
        leader: row.leader_membership_id === null || row.leader_name === null ? null : { membershipId: row.leader_membership_id, displayName: row.leader_name },
        periodId: row.period_id,
        periodCode: row.period_code,
        startDate: row.start_date,
        endDate: row.end_date,
        commitmentVnd: row.commitment,
        actualVnd: actual.actualVnd,
        differenceVnd: weeklyDifference(actual.actualVnd, row.commitment),
        fromYearStart: actual.actualVnd !== null && actual.fromYearStart,
      };
    });
  }
}
