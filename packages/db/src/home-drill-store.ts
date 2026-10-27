import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface DrillProject {
  id: string;
  code: string;
  name: string;
  ownerUnitId: string;
}

export interface DrillRevision {
  id: string;
  revision: number;
  status: string;
  submittedAt: string | null;
  acceptedAt: string | null;
}

export interface DrillTransaction {
  id: string;
  externalId: string;
  amountVnd: string;
  confirmedAt: string;
  reversalOfId: string | null;
}

interface TransactionSql {
  id: string;
  external_id: string;
  amount_vnd: string;
  confirmed_at: string;
  reversal_of_id: string | null;
}

/**
 * What the drill of the command center reads beyond the snapshot (ST-HOME-002): the project the reader may open, the report revisions the lines of a snapshot came from, and the Treasury transactions of a
 * project up to the cutoff of the snapshot. Every read is in the scope of the reader as it is now, so a right that was taken away ends the drill at the next step.
 */
export class HomeDrillStore {
  /** A project the reader may read (null for one that does not exist, lies in another tenant or is outside their scope: the answers are the same). */
  async project(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<DrillProject | undefined> {
    const visible = scope(2);
    const [row] = await tx.query<{ id: string; code: string; name: string; owner_unit_id: string }>(
      `select p.id, p.code, p.name, p.owner_unit_id from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql}`,
      [projectId, ...visible.params],
    );
    return row === undefined ? undefined : { id: row.id, code: row.code, name: row.name, ownerUnitId: row.owner_unit_id };
  }

  /** The report revisions of the lines of a project in a snapshot (all of them, or the one of a line), the ones the figures were taken from. */
  async revisions(tx: TenantTx, input: { snapshotId: string; projectId: string; lineId: string | undefined }): Promise<DrillRevision[]> {
    const rows = await tx.query<{ id: string; revision: number; status: string; submitted_at: string | null; accepted_at: string | null }>(
      `select distinct r.id, r.revision, r.status, r.submitted_at::text as submitted_at, r.accepted_at::text as accepted_at
         from machvon.period_snapshot_line l join machvon.report_revision r on r.tenant_id = l.tenant_id and r.id = l.report_revision_id
        where l.snapshot_id = $1::uuid and l.project_id = $2::uuid and ($3::uuid is null or l.id = $3::uuid)
        order by r.revision, r.id`,
      [input.snapshotId, input.projectId, input.lineId ?? null],
    );
    return rows.map((row) => ({ id: row.id, revision: row.revision, status: row.status, submittedAt: row.submitted_at, acceptedAt: row.accepted_at }));
  }

  /**
   * Whether a unit has lines in the snapshot that the reader may read through their projects (a grant of one project, or a project seen through its investor unit): the unit is then a place of the figures the reader
   * is allowed, though no grant names the unit. It opens nothing beyond those projects: every figure below is still counted over the projects of the reader only.
   */
  async unitContributes(tx: TenantTx, scope: ScopeBuilder, input: { snapshotId: string; unitId: string; exact: boolean }): Promise<boolean> {
    const visible = scope(4);
    const [row] = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.snapshot_id = $1::uuid and ($3::boolean and l.unit_id = $2::uuid or not $3::boolean and exists (select 1 from machvon.organization_unit lu join machvon.organization_unit su on su.tenant_id = lu.tenant_id and su.id = $2::uuid
                                                                                                                      where lu.tenant_id = l.tenant_id and lu.id = l.unit_id and starts_with(lu.path, su.path))) and ${visible.sql}`,
      [input.snapshotId, input.unitId, input.exact, ...visible.params],
    );
    return Number(row?.n ?? 0) > 0;
  }

  /** The fiscal year of the period a snapshot was made for: the year the figures of the Treasury are counted from the first day of. */
  async fiscalYearOf(tx: TenantTx, periodId: string): Promise<number | undefined> {
    const [row] = await tx.query<{ fiscal_year: number }>('select fiscal_year from machvon.reporting_period where id = $1::uuid', [periodId]);
    return row?.fiscal_year;
  }

  /**
   * The Treasury transactions of a project that explain the figures of a snapshot: confirmed from the first day of its fiscal year up to the end of the cutoff day (Vietnam time), as the snapshot counts them, the latest
   * first, a page at a time (the cursor is the moment and the id of the last one). A transaction that was recorded after the snapshot was built (`observedAt`, the moment the snapshot was made: the day it says it is as of may be an earlier one) is
   * not one of its sources, whatever day it says it was confirmed on: the snapshot did not see it.
   */
  async transactions(tx: TenantTx, input: { projectId: string; fiscalYear: number; cutoffDate: string; observedAt: string; limit: number; after: { confirmedAt: string; id: string } | undefined }): Promise<{ items: DrillTransaction[]; more: boolean }> {
    const rows = await tx.query<TransactionSql>(
      `select t.id, t.external_id, t.amount_vnd::text as amount_vnd, to_char(t.confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as confirmed_at, t.reversal_of_id
         from machvon.treasury_transaction t
        where t.project_id = $1::uuid and t.confirmed_at < (($2::date + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
          and t.confirmed_at >= (make_date($6::int, 1, 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
          and t.created_at <= $7::timestamptz
          and ($3::timestamptz is null or (t.confirmed_at, t.id) < ($3::timestamptz, $4::uuid))
        order by t.confirmed_at desc, t.id desc limit $5::int`,
      [input.projectId, input.cutoffDate, input.after?.confirmedAt ?? null, input.after?.id ?? null, input.limit + 1, input.fiscalYear, input.observedAt],
    );
    const items = rows.slice(0, input.limit).map((row) => ({ id: row.id, externalId: row.external_id, amountVnd: row.amount_vnd, confirmedAt: row.confirmed_at, reversalOfId: row.reversal_of_id }));
    return { items, more: rows.length > input.limit };
  }
}
