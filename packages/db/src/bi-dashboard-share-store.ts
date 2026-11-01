import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type ShareGranteeKind = 'USER' | 'ROLE' | 'UNIT';
export type SharePermission = 'VIEW' | 'EDIT';
export type ShareStatus = 'ACTIVE' | 'REVOKED';

export interface ShareRow {
  id: string;
  dashboardId: string;
  granteeKind: ShareGranteeKind;
  granteeRefId: string;
  /** What the grantee is called now (the person, the role, the unit), when it can be read. */
  granteeName: string | null;
  permission: SharePermission;
  status: ShareStatus;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string;
  version: number;
}

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const UNIQUE_VIOLATION = '23505';
const SAVEPOINT = 'dashboard_share';
const iso = (value: unknown): string => new Date(value as string).toISOString();

const SELECT = `select s.id, s.dashboard_id, s.grantee_kind, s.grantee_ref_id, s.permission, s.status, s.revoked_at, s.created_at, s.created_by, s.version::text as version,
  case s.grantee_kind
    when 'USER' then (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = s.tenant_id and u.membership_id = s.grantee_ref_id)
    when 'ROLE' then (select r.name from machvon.role_definition r where r.tenant_id = s.tenant_id and r.id = s.grantee_ref_id)
    else (select o.name from machvon.organization_unit o where o.tenant_id = s.tenant_id and o.id = s.grantee_ref_id) end as grantee_name
  from machvon.dashboard_share s`;

const toRow = (row: Sql): ShareRow => ({
  id: row.id,
  dashboardId: row.dashboard_id,
  granteeKind: row.grantee_kind,
  granteeRefId: row.grantee_ref_id,
  granteeName: row.grantee_name,
  permission: row.permission,
  status: row.status,
  revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
  createdAt: iso(row.created_at),
  createdBy: row.created_by,
  version: Number(row.version),
});

/** Whether a grantee of the kind exists in the tenant (the policy of the row of the tenant hides what is another's, so a person of another tenant is as good as none). */
const GRANTEE_SQL: Readonly<Record<ShareGranteeKind, string>> = {
  USER: "select 1 from machvon.membership where id = $1::uuid and status = 'Active'",
  ROLE: 'select 1 from machvon.role_definition where id = $1::uuid',
  UNIT: 'select 1 from machvon.organization_unit where id = $1::uuid',
};

/**
 * The shares of a dashboard (ST-BI-007, BI 3 F6): the owner gives a person, a role or a unit (and the units under it) the right to see the layout, or to change it, and takes it back at once. A share never gives data:
 * what the figures show is judged for the reader when they are asked for. A dashboard is `SHARED` while it has an active share and `PRIVATE` when it has none.
 */
export class BiDashboardShareStore {
  async find(tx: TenantTx, id: string): Promise<ShareRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where s.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The share locked for its end. */
  async lock(tx: TenantTx, id: string): Promise<ShareRow | undefined> {
    const rows = await tx.query<{ id: string }>('select id from machvon.dashboard_share where id = $1::uuid for update', [id]);
    return rows[0] === undefined ? undefined : this.find(tx, id);
  }

  /** The shares of a dashboard, the active ones first, the newest first. */
  async forDashboard(tx: TenantTx, dashboardId: string): Promise<ShareRow[]> {
    const rows = await tx.query<Sql>(`${SELECT} where s.dashboard_id = $1::uuid order by (s.status = 'ACTIVE') desc, s.created_at desc, s.id`, [dashboardId]);
    return rows.map(toRow);
  }

  async activeCount(tx: TenantTx, dashboardId: string): Promise<number> {
    const rows = await tx.query<{ n: string }>("select count(*)::text as n from machvon.dashboard_share where dashboard_id = $1::uuid and status = 'ACTIVE'", [dashboardId]);
    return Number(rows[0]?.n ?? 0);
  }

  async granteeExists(tx: TenantTx, kind: ShareGranteeKind, id: string): Promise<boolean> {
    return (await tx.query(GRANTEE_SQL[kind], [id])).length > 0;
  }

  /** A share is made, active; the same grantee already having an active one is 409 `STAGE_TRANSITION_DENIED` (end it, or share with the other permission after). */
  async create(tx: TenantTx, input: { dashboardId: string; kind: ShareGranteeKind; granteeRefId: string; permission: SharePermission; actor: string }): Promise<ShareRow> {
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.dashboard_share (tenant_id, id, dashboard_id, grantee_kind, grantee_ref_id, permission, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5, 'ACTIVE', $6::uuid, $6::uuid)`,
        [id, input.dashboardId, input.kind, input.granteeRefId, input.permission, input.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'grantee_ref_id');
    }
    return (await this.find(tx, id)) as ShareRow;
  }

  /** The share ends, once; one that has ended is 409 `SHARE_STATE_INVALID`. */
  async revoke(tx: TenantTx, id: string, actor: string): Promise<ShareRow> {
    const held = await this.lock(tx, id);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (held.status !== 'ACTIVE') throw new DomainError('SHARE_STATE_INVALID', 409, 'status');
    await tx.query("update machvon.dashboard_share set status = 'REVOKED', revoked_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    return (await this.find(tx, id)) as ShareRow;
  }
}
