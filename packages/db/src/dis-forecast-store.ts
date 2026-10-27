import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface ForecastProject {
  projectId: string;
  projectCode: string;
  projectName: string;
  /** What the lines of the snapshot add up to for the plan of the year. */
  planTotalVnd: string;
  /** What the Treasury paid to the cutoff, or null when it booked nothing for any line of the project. */
  disbursedVnd: string | null;
  /** The sum of the current forecasts of each month, over the sources and the levels of the budget. */
  forecasts: Map<number, string>;
  registered: Map<number, string>;
}

export interface ForecastData {
  projects: ForecastProject[];
  /** What the Treasury paid in each month of the year up to the cutoff, from the transactions of the projects in the scope (a refund takes off). */
  actualByMonth: Map<number, string>;
}

/**
 * What the year-end estimate reads (ST-DIS-018, DIS-23): for the projects of a frozen snapshot that are in the scope of the caller, the plan and the disbursement of the lines, and the forecasts and
 * registrations of the months of the plan year from the schedule of CAP; and what the Treasury paid in each month, for the curve.
 */
export class DisForecastStore {
  async read(tx: TenantTx, scope: ScopeBuilder, input: { snapshotId: string; planYear: number; cutoffDate: string; projectId?: string | undefined; unitId?: string | undefined }): Promise<ForecastData> {
    const visible = scope(4);
    const lines = await tx.query<{ project_id: string; code: string; name: string; plan: string; disbursed: string | null }>(
      `select l.project_id, p.code, p.name, sum(l.plan_total_vnd)::text as plan,
              case when count(l.disbursed_treasury_vnd) = 0 then null else sum(l.disbursed_treasury_vnd)::text end as disbursed
         from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.snapshot_id = $1::uuid and ($2::uuid is null or l.project_id = $2::uuid) and ($3::uuid is null or l.unit_id = $3::uuid) and ${visible.sql}
        group by l.project_id, p.code, p.name
        order by p.code collate "C", l.project_id`,
      [input.snapshotId, input.projectId ?? null, input.unitId ?? null, ...visible.params],
    );
    const projects = new Map<string, ForecastProject>(
      lines.map((row) => [row.project_id, { projectId: row.project_id, projectCode: row.code, projectName: row.name, planTotalVnd: row.plan, disbursedVnd: row.disbursed, forecasts: new Map(), registered: new Map() }]),
    );
    const ids = [...projects.keys()];
    if (ids.length === 0) return { projects: [], actualByMonth: new Map() };
    const schedule = await tx.query<{ project_id: string; month: number; kind: 'FORECAST' | 'REGISTERED'; amount: string }>(
      `select s.project_id, s.month::int as month, s.kind, sum(s.amount_vnd)::text as amount
         from machvon.disbursement_schedule_line s
        where s.project_id = any($1::uuid[]) and s.plan_year = $2::int and s.granularity = 'MONTH' and s.kind in ('FORECAST', 'REGISTERED') and s.is_current
        group by s.project_id, s.month, s.kind`,
      [ids, input.planYear],
    );
    for (const row of schedule) (row.kind === 'FORECAST' ? projects.get(row.project_id)?.forecasts : projects.get(row.project_id)?.registered)?.set(row.month, row.amount);
    const paid = await tx.query<{ month: number; amount: string }>(
      `select extract(month from (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date)::int as month,
              sum(case when t.reversal_of_id is not null then -t.amount_vnd else t.amount_vnd end)::text as amount
         from machvon.treasury_transaction t
        where t.project_id = any($1::uuid[]) and (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date between make_date($2::int, 1, 1) and least($3::date, make_date($2::int, 12, 31))
        group by 1`,
      [ids, input.planYear, input.cutoffDate],
    );
    return { projects: [...projects.values()], actualByMonth: new Map(paid.map((row) => [row.month, row.amount])) };
  }
}
