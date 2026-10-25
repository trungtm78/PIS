import { randomUUID } from 'node:crypto';
import { PROCUREMENT_SOURCE_SYSTEM } from '@machvon/kernel';
import type { MilestoneKind } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** What the register and the file of the national bidding system disagree on, kept on the link of the package (`diff_json`). */
export interface LinkDiff {
  /** A milestone with a date in the register and another date in the file: the register keeps its date until a person decides. */
  milestones?: Partial<Record<MilestoneKind, { register: string; file: string }>>;
  /** The package is linked to another code on the national network than the one the file gives. */
  external_code?: { register: string; file: string };
}

export const isInSync = (diff: LinkDiff): boolean => diff.external_code === undefined && Object.keys(diff.milestones ?? {}).length === 0;

/** The diff with the milestone of `kind` set to the disagreement, or cleared when there is none. */
export function diffWithMilestone(diff: LinkDiff, kind: MilestoneKind, disagreement: { register: string; file: string } | undefined): LinkDiff {
  const milestones = { ...(diff.milestones ?? {}) };
  if (disagreement === undefined) delete milestones[kind];
  else milestones[kind] = disagreement;
  const next: LinkDiff = {};
  if (Object.keys(milestones).length > 0) next.milestones = milestones;
  if (diff.external_code !== undefined) next.external_code = diff.external_code;
  return next;
}

export interface LinkRow {
  id: string;
  packageId: string;
  externalCode: string;
  diff: LinkDiff;
  diffOwnerId: string | null;
}

interface LinkSql {
  id: string;
  package_id: string;
  external_code: string;
  diff_json: LinkDiff;
  diff_owner_user_id: string | null;
}

const toRow = (row: LinkSql): LinkRow => ({ id: row.id, packageId: row.package_id, externalCode: row.external_code, diff: row.diff_json, diffOwnerId: row.diff_owner_user_id });

/** The link between a package and its code on the national network (`procurement_external_link`), one per package and system. */
export class BidExternalLinks {
  /** The link of a package, locked; undefined when the package has none yet. */
  async lock(tx: TenantTx, packageId: string): Promise<LinkRow | undefined> {
    const rows = await tx.query<LinkSql>('select id, package_id, external_code, diff_json, diff_owner_user_id from machvon.procurement_external_link where package_id = $1::uuid and external_system = $2 for update', [
      packageId,
      PROCUREMENT_SOURCE_SYSTEM,
    ]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  async create(tx: TenantTx, input: { packageId: string; externalCode: string; batchId: string; actor: string }): Promise<LinkRow> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.procurement_external_link (tenant_id, id, package_id, external_system, external_code, last_batch_id, diff_status, diff_json, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, 'IN_SYNC', '{}'::jsonb, $6::uuid, $6::uuid, 1)`,
      [id, input.packageId, PROCUREMENT_SOURCE_SYSTEM, input.externalCode, input.batchId, input.actor],
    );
    return { id, packageId: input.packageId, externalCode: input.externalCode, diff: {}, diffOwnerId: null };
  }

  /**
   * Writes the difference of a link: IN_SYNC when there is none, DIFFERENT with the owner that settles it otherwise. The batch that last looked at the link is kept when one is
   * given (a settlement by hand leaves it as it was).
   */
  async save(tx: TenantTx, link: LinkRow, diff: LinkDiff, owner: string, actor: string, batchId?: string): Promise<void> {
    const inSync = isInSync(diff);
    await tx.query(
      `update machvon.procurement_external_link
          set diff_status = $2, diff_json = $3::jsonb, diff_owner_user_id = $4::uuid, last_batch_id = coalesce($5::uuid, last_batch_id),
              updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [link.id, inSync ? 'IN_SYNC' : 'DIFFERENT', JSON.stringify(diff), inSync ? (link.diffOwnerId ?? null) : owner, batchId ?? null, actor],
    );
  }
}
