import type { LinkDiff } from './bid-external-link.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const LINK_DIFF_STATUSES = ['IN_SYNC', 'DIFFERENT', 'MISSING_EXTERNAL'] as const;
export type LinkDiffStatus = (typeof LINK_DIFF_STATUSES)[number];

export interface LinkLine {
  id: string;
  packageId: string;
  packageCode: string;
  packageTitle: string | null;
  project: { id: string; code: string };
  externalSystem: string;
  externalCode: string;
  diffStatus: LinkDiffStatus;
  diff: LinkDiff;
  diffOwner: { membershipId: string; displayName: string } | null;
  /** The batch that last looked at the link, with the hash of its file and the state of the adapter that read it. */
  batch: { id: string; fileSha256: string; adapterStatus: string; appliedAt: string; rowsTotal: number; rowsOk: number; rowsError: number } | null;
  version: number;
}

interface LinkSql {
  id: string;
  package_id: string;
  package_code: string;
  package_title: string | null;
  project_id: string;
  project_code: string;
  external_system: string;
  external_code: string;
  diff_status: LinkDiffStatus;
  diff_json: LinkDiff;
  diff_owner_user_id: string | null;
  owner_name: string | null;
  batch_id: string | null;
  file_sha256: string | null;
  adapter_status: string | null;
  applied_at: string | null;
  rows_total: number | null;
  rows_ok: number | null;
  rows_error: number | null;
  version: string;
}

/**
 * The links between the packages and their codes on the national bidding network (BID-19), with the difference each carries and the batch that last looked at it. Only the
 * links of the packages of the projects in the scope of the caller are read.
 */
export class BidLinkReads {
  async list(tx: TenantTx, scope: ScopeBuilder, filter: { projectId?: string | undefined; diffStatus?: LinkDiffStatus | undefined }): Promise<LinkLine[]> {
    const predicate = scope(3);
    const rows = await tx.query<LinkSql>(
      `select l.id, k.id as package_id, k.code as package_code, k.title as package_title, p.id as project_id, p.code as project_code, l.external_system, l.external_code, l.diff_status, l.diff_json,
              l.diff_owner_user_id, u.display_name as owner_name, b.id as batch_id, b.file_sha256, b.adapter_status,
              to_char(b.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as applied_at, b.rows_total, b.rows_ok, b.rows_error, l.version::text as version
         from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.procurement_external_link l on l.tenant_id = k.tenant_id and l.package_id = k.id
         left join machvon.procurement_import_batch b on b.tenant_id = l.tenant_id and b.id = l.last_batch_id
         left join machvon.tenant_user_directory u on u.tenant_id = l.tenant_id and u.membership_id = l.diff_owner_user_id
        where ($1::uuid is null or p.id = $1::uuid) and ($2::text is null or l.diff_status = $2) and ${predicate.sql}
        order by k.code, k.id`,
      [filter.projectId ?? null, filter.diffStatus ?? null, ...predicate.params],
    );
    return rows.map((row) => ({
      id: row.id,
      packageId: row.package_id,
      packageCode: row.package_code,
      packageTitle: row.package_title,
      project: { id: row.project_id, code: row.project_code },
      externalSystem: row.external_system,
      externalCode: row.external_code,
      diffStatus: row.diff_status,
      diff: row.diff_json,
      diffOwner: row.diff_owner_user_id === null ? null : { membershipId: row.diff_owner_user_id, displayName: row.owner_name ?? '' },
      batch:
        row.batch_id === null || row.file_sha256 === null || row.adapter_status === null || row.applied_at === null
          ? null
          : { id: row.batch_id, fileSha256: row.file_sha256, adapterStatus: row.adapter_status, appliedAt: row.applied_at, rowsTotal: row.rows_total ?? 0, rowsOk: row.rows_ok ?? 0, rowsError: row.rows_error ?? 0 },
      version: Number(row.version),
    }));
  }
}
