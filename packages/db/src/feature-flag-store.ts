import { DomainError, assertFlagChangeable, flagEnabled, versionConflict } from '@machvon/kernel';
import type { FlagRollout, FlagStatus, FlagUpdate } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The release flags (ST-SAS-020, SAS 3.11): control-plane rows the declared flags are written into by a migration. The control role changes a flag under the version it saw (If-Match) and never adds or deletes one;
 * a tenant reads which flags are on for it. A flag is read and written in the control-plane transaction (`withControl`).
 */
export interface FlagRow {
  id: string;
  key: string;
  description: string;
  status: FlagStatus;
  rollout: FlagRollout;
  /** How many times the rollout was set; the version below is the If-Match counter. */
  revision: number;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

interface FlagSql {
  id: string;
  flag_key: string;
  description: string;
  status: FlagStatus;
  rollout_json: { tenant_cohorts?: string[]; tenant_ids?: string[]; percentage?: number };
  revision: number;
  version: string;
  updated_by: string;
  updated_at: string;
}

const COLUMNS = `id, flag_key, description, status, rollout_json, revision, version::text as version, updated_by, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

const rowOf = (row: FlagSql): FlagRow => ({
  id: row.id,
  key: row.flag_key,
  description: row.description,
  status: row.status,
  rollout: { cohorts: row.rollout_json.tenant_cohorts ?? [], tenantIds: row.rollout_json.tenant_ids ?? [], percentage: row.rollout_json.percentage ?? 0 },
  revision: row.revision,
  version: Number(row.version),
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});

export interface FlagChange {
  before: FlagRow;
  after: FlagRow;
}

export class FeatureFlagStore {
  /** Every flag, by key. */
  async list(tx: TenantTx): Promise<FlagRow[]> {
    const rows = await tx.query<FlagSql>(`select ${COLUMNS} from machvon.feature_flag order by flag_key`);
    return rows.map(rowOf);
  }

  /**
   * Sets the status and the rollout of a flag under the version of the flag the caller saw (409 `VERSION_CONFLICT`). A flag that is not declared is 404; a retired flag is not changed (422 `FLAG_RULE_INVALID`).
   * The revision rises with every change, whether or not the rollout itself differs.
   */
  async update(tx: TenantTx, input: { key: string; expectedVersion: number; update: FlagUpdate; actor: string }): Promise<FlagChange> {
    const found = await tx.query<FlagSql>(`select ${COLUMNS} from machvon.feature_flag where flag_key = $1 for update`, [input.key]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const before = rowOf(found[0]);
    if (before.version !== input.expectedVersion) throw versionConflict(before.version);
    assertFlagChangeable(before.status);
    const rollout = { tenant_cohorts: input.update.rollout.cohorts, tenant_ids: input.update.rollout.tenantIds, percentage: input.update.rollout.percentage };
    const rows = await tx.query<FlagSql>(
      `update machvon.feature_flag set status = $2, rollout_json = $3::jsonb, revision = revision + 1, updated_by = $4::uuid, updated_at = now(), version = version + 1 where flag_key = $1 returning ${COLUMNS}`,
      [input.key, input.update.status, JSON.stringify(rollout), input.actor],
    );
    const updated = rows[0];
    if (updated === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after: rowOf(updated) };
  }

  /** Whether each flag is on for the tenant: its status and rollout against the tenant and the cohort (the region of its placement) it is in. A tenant that does not exist has none on. */
  async enabledFor(tx: TenantTx, tenantId: string): Promise<Array<{ key: string; enabled: boolean }>> {
    const tenant = await tx.query<{ region: string }>('select region from machvon.tenant where id = $1::uuid', [tenantId]);
    const region = tenant[0]?.region;
    const flags = await this.list(tx);
    return flags.map((flag) => ({ key: flag.key, enabled: region !== undefined && flagEnabled(flag, { id: tenantId, region }) }));
  }
}
