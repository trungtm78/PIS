import type { ExportLine } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface ExportRows {
  lines: ExportLine[];
  /** The projects of the lines, each once, in code order: what the download checks the scope of the caller against. */
  projectIds: string[];
  unitCodes: string[];
  /** True when the snapshot has more lines in the scope than `limit`: the file is not made. */
  overflow: boolean;
}

interface LineSql {
  project_id: string;
  project_code: string;
  project_name: string;
  unit_code: string;
  unit_name: string;
  bucket: string;
  budget_level: string;
  plan_pm: string;
  plan_local: string;
  plan_total: string;
  treasury: string | null;
  reported: string | null;
  ctmtqg: string | null;
  rate_pm: string | null;
  rate_total: string | null;
  rate_null_reason: string | null;
  coverage: string;
}

/** The audit row an export wrote (`dis.report_exported`): who made the file, from which snapshot, in what format, and which projects it names. */
export interface ExportRecord {
  actorId: string;
  snapshotId: string;
  format: string;
  rows: number;
  projectIds: string[];
  fileSha256: string;
}

export const EXPORT_ACTION = 'dis.report_exported';
export const EXPORT_RESOURCE_TYPE = 'report_export';

/**
 * What an export of a frozen snapshot reads (ST-DIS-016): the lines of the snapshot that are in the scope of the caller, with the names of the projects and units, in a fixed order; and how many of a set
 * of projects the caller still sees, which is what the download asks again (NFR-TENANCY-06).
 */
export class DisExportStore {
  async lines(tx: TenantTx, scope: ScopeBuilder, snapshotId: string, limit: number): Promise<ExportRows> {
    const visible = scope(3);
    const rows = await tx.query<LineSql>(
      `select l.project_id, p.code as project_code, p.name as project_name, u.code as unit_code, u.name as unit_name, l.bucket, l.budget_level,
              l.plan_pm_assigned_vnd::text as plan_pm, l.plan_local_added_vnd::text as plan_local, l.plan_total_vnd::text as plan_total,
              l.disbursed_treasury_vnd::text as treasury, l.disbursed_reported_vnd::text as reported, l.ctmtqg_subset_vnd::text as ctmtqg,
              l.rate_pm_pct::text as rate_pm, l.rate_total_pct::text as rate_total, l.rate_null_reason, l.treasury_coverage as coverage
         from machvon.period_snapshot_line l
         join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
         join machvon.organization_unit u on u.tenant_id = l.tenant_id and u.id = l.unit_id
        where l.snapshot_id = $1::uuid and ${visible.sql}
        order by u.code collate "C", p.code collate "C", l.bucket, l.budget_level limit $2::int`,
      [snapshotId, limit + 1, ...visible.params],
    );
    const overflow = rows.length > limit;
    const shown = overflow ? rows.slice(0, limit) : rows;
    return {
      overflow,
      lines: shown.map((row) => ({
        projectCode: row.project_code,
        projectName: row.project_name,
        unitCode: row.unit_code,
        unitName: row.unit_name,
        bucket: row.bucket,
        budgetLevel: row.budget_level,
        planPmVnd: row.plan_pm,
        planLocalVnd: row.plan_local,
        planTotalVnd: row.plan_total,
        disbursedTreasuryVnd: row.treasury,
        disbursedReportedVnd: row.reported,
        ctmtqgVnd: row.ctmtqg,
        ratePmPct: row.rate_pm,
        rateTotalPct: row.rate_total,
        rateNullReason: row.rate_null_reason,
        coverage: row.coverage,
      })),
      projectIds: [...new Set(shown.map((row) => row.project_id))],
      unitCodes: [...new Set(shown.map((row) => row.unit_code))],
    };
  }

  /** The record of an export, read back from the audit trail (the export has no table of its own: its audit row is its record). */
  async recordOf(tx: TenantTx, exportId: string): Promise<ExportRecord | undefined> {
    const [row] = await tx.query<{ actor_id: string; safe_diff: Record<string, unknown> }>(
      "select actor_id, safe_diff from machvon.audit_event where action = $1 and resource_type = $2 and resource_id = $3::uuid and outcome = 'SUCCESS' order by occurred_at limit 1",
      [EXPORT_ACTION, EXPORT_RESOURCE_TYPE, exportId],
    );
    if (row === undefined) return undefined;
    const diff = row.safe_diff;
    const snapshotId = diff.snapshot_id;
    const projectIds = diff.project_ids;
    if (typeof snapshotId !== 'string' || !Array.isArray(projectIds) || !projectIds.every((id) => typeof id === 'string')) return undefined;
    return { actorId: row.actor_id, snapshotId, format: String(diff.format ?? ''), rows: Number(diff.rows ?? 0), projectIds: projectIds as string[], fileSha256: String(diff.file_sha256 ?? '') };
  }

  /** How many of these projects the caller sees in the snapshot now: fewer than the export named means the scope has narrowed since. */
  async visibleProjects(tx: TenantTx, scope: ScopeBuilder, snapshotId: string, projectIds: readonly string[]): Promise<number> {
    if (projectIds.length === 0) return 0;
    const visible = scope(3);
    const [row] = await tx.query<{ n: string }>(
      `select count(distinct l.project_id)::text as n
         from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.snapshot_id = $1::uuid and l.project_id = any($2::uuid[]) and ${visible.sql}`,
      [snapshotId, [...projectIds], ...visible.params],
    );
    return Number(row?.n ?? '0');
  }
}
