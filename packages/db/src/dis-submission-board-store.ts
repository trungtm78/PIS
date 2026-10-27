import { REPORTABLE_PROJECT_STATUSES, submissionStateOf } from '@machvon/kernel';
import type { BoardProject } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface BoardProjectRow extends BoardProject {
  projectId: string;
  projectCode: string;
  projectName: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  /** The report that stands for the project in the period (the one handed in, else the latest), or null when there is none. */
  reportId: string | null;
  reportStatus: string | null;
  submittedAt: string | null;
  narrative: { results: string | null; causes: string | null; solutions: string | null; proposals: string | null } | null;
}

interface ProjectSql {
  project_id: string;
  project_code: string;
  project_name: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  statuses: string[] | null;
  first_late: boolean | null;
  report_id: string | null;
  report_status: string | null;
  submitted_at: string | null;
  results: string | null;
  causes: string | null;
  solutions: string | null;
  proposals: string | null;
}

/**
 * The projects that must report for a period and what each has done about it (ST-DIS-015, DIS-15): every project in the scope of the caller that is at a stage that reports (DIS 3 F1), with the
 * statuses of its reports of the period, the stored lateness of the first one handed in, and the report that stands for it (the one handed in, else the latest not deleted).
 */
export class DisSubmissionBoardStore {
  async projects(tx: TenantTx, scope: ScopeBuilder, periodId: string, filter: { unitId?: string | undefined }): Promise<BoardProjectRow[]> {
    const visible = scope(4);
    const rows = await tx.query<ProjectSql>(
      `select p.id as project_id, p.code as project_code, p.name as project_name, p.owner_unit_id as unit_id, ou.code as unit_code, ou.name as unit_name,
              rep.statuses, rep.first_late, rep.report_id, rep.report_status, rep.submitted_at::text as submitted_at, nar.results_text as results, nar.causes_text as causes, nar.solutions_text as solutions, nar.proposals_text as proposals
         from ${SCOPE_FROM}
         left join lateral (
           select array_agg(r.status) as statuses,
                  (array_agg(r.is_late order by r.submitted_at, r.revision) filter (where r.status in ('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'SUPERSEDED', 'AMENDMENT_REQUESTED')))[1] as first_late,
                  (array_agg(r.id order by (r.status in ('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'AMENDMENT_REQUESTED')) desc, r.revision desc))[1] as report_id,
                  (array_agg(r.status order by (r.status in ('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'AMENDMENT_REQUESTED')) desc, r.revision desc))[1] as report_status,
                  (array_agg(r.submitted_at order by (r.status in ('SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'AMENDMENT_REQUESTED')) desc, r.revision desc))[1] as submitted_at
             from machvon.report_revision r
            where r.tenant_id = p.tenant_id and r.project_id = p.id and r.period_id = $1::uuid and r.deleted_at is null) rep on true
         left join machvon.report_narrative nar on nar.tenant_id = p.tenant_id and nar.report_revision_id = rep.report_id
        where p.status = any($2::text[]) and ($3::uuid is null or p.owner_unit_id = $3::uuid) and ${visible.sql}
        order by ou.name, ou.code, p.code`,
      [periodId, [...REPORTABLE_PROJECT_STATUSES], filter.unitId ?? null, ...visible.params],
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      projectCode: row.project_code,
      projectName: row.project_name,
      unitId: row.unit_id,
      unitCode: row.unit_code,
      unitName: row.unit_name,
      state: submissionStateOf(row.statuses ?? []),
      late: row.first_late === true,
      reportId: row.report_id,
      reportStatus: row.report_status,
      submittedAt: row.submitted_at,
      narrative: row.results === null && row.causes === null && row.solutions === null && row.proposals === null ? null : { results: row.results, causes: row.causes, solutions: row.solutions, proposals: row.proposals },
    }));
  }
}
