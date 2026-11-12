import type { TenantTx } from './tenant-database.ts';

/**
 * The one reader of the schedule of a project for everything that is not PWF itself (R28, BR-PWF-11): the baseline process of PRJ, the risk signals and the figures that look-ahead, EVM and the investment profile (IPF) take
 * from the dates of the milestones. A task of the workflow that is a milestone IS a row of `project_milestone` (the schedule publishes into it, a done or cancelled task closes it), so there is one authoritative schedule and
 * this port reads it where it is; the figures of a project that has a workflow are the ones of a project that has none, and move only when a schedule is published. The tests of reconciliation hold the two together.
 */

export interface MilestoneFact {
  id: string;
  componentId: string | null;
  code: string;
  baselineDate: string;
  plannedDate: string;
  status: 'PLANNED' | 'DONE' | 'DELAYED' | 'CANCELLED';
}

export interface MilestoneFigures {
  projectId: string;
  total: number;
  late: number;
  slipDays: number;
}

export interface ProjectScheduleReadPort {
  /** The milestones of a project with their baseline and planned days. */
  milestones(tx: TenantTx, projectId: string): Promise<MilestoneFact[]>;
  /** How many milestones each project has, how many are late on `today`, and by how many days the latest is (projects without a milestone are absent). */
  milestoneFigures(tx: TenantTx, projectIds: readonly string[], today: string): Promise<MilestoneFigures[]>;
  /** The day the project is planned to start: the one of its workflow, else the start of its effective baseline, else none. */
  plannedStart(tx: TenantTx, projectId: string): Promise<string | null>;
}

export class SqlProjectScheduleReader implements ProjectScheduleReadPort {
  async milestones(tx: TenantTx, projectId: string): Promise<MilestoneFact[]> {
    const rows = await tx.query<{ id: string; component_id: string | null; code: string; baseline_date: string; planned_date: string; status: MilestoneFact['status'] }>(
      `select id, component_id, code, baseline_date::text as baseline_date, planned_date::text as planned_date, status from machvon.project_milestone where project_id = $1::uuid`,
      [projectId],
    );
    return rows.map((row) => ({ id: row.id, componentId: row.component_id, code: row.code, baselineDate: row.baseline_date, plannedDate: row.planned_date, status: row.status }));
  }

  async milestoneFigures(tx: TenantTx, projectIds: readonly string[], today: string): Promise<MilestoneFigures[]> {
    const rows = await tx.query<{ project_id: string; total: string; late: string; slip: string }>(
      `select m.project_id, count(*)::text as total,
              count(*) filter (where m.status in ('PLANNED', 'DELAYED') and m.actual_date is null and m.planned_date < $2::date)::text as late,
              coalesce(max($2::date - m.planned_date) filter (where m.status in ('PLANNED', 'DELAYED') and m.actual_date is null and m.planned_date < $2::date), 0)::text as slip
         from machvon.project_milestone m where m.project_id = any($1::uuid[]) and m.status <> 'CANCELLED' group by m.project_id`,
      [[...projectIds], today],
    );
    return rows.map((row) => ({ projectId: row.project_id, total: Number(row.total), late: Number(row.late), slipDays: Number(row.slip) }));
  }

  async plannedStart(tx: TenantTx, projectId: string): Promise<string | null> {
    const rows = await tx.query<{ day: string | null }>(
      `select coalesce(p.planned_start_date, (select b.planned_start from machvon.project_baseline b where b.project_id = p.id order by b.version desc limit 1))::text as day from machvon.project p where p.id = $1::uuid`,
      [projectId],
    );
    return rows[0]?.day ?? null;
  }
}
