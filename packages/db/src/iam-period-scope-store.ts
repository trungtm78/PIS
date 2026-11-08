import { DomainError, versionConflict } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import { bumpScopeVersion } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type PeriodScopeStatus = 'Active' | 'Lifted';

export interface PeriodScopeRecord {
  id: string;
  roleGrantId: string;
  /** The holder of the role grant and the role, as the screen names them. */
  membershipId: string;
  memberName: string | null;
  roleCode: string;
  periodCodes: string[];
  reason: string;
  status: PeriodScopeStatus;
  setBy: string;
  setAt: string;
  liftedBy: string | null;
  liftedAt: string | null;
  liftReason: string | null;
  version: number;
  sortKey: string;
}

interface Row {
  id: string;
  role_grant_id: string;
  membership_id: string;
  member_name: string | null;
  role_code: string;
  period_codes: string[];
  reason: string;
  status: PeriodScopeStatus;
  set_by: string;
  set_at: string;
  lifted_by: string | null;
  lifted_at: string | null;
  lift_reason: string | null;
  version: string;
  sort_key: string;
}

const FROM = `machvon.role_grant_period_scope s
  join machvon.role_grant g on g.tenant_id = s.tenant_id and g.id = s.role_grant_id
  join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
  left join machvon.tenant_user_directory dm on dm.tenant_id = g.tenant_id and dm.membership_id = g.membership_id`;
const COLUMNS = `s.id, s.role_grant_id, g.membership_id, dm.display_name as member_name, r.code as role_code, s.period_codes, s.reason, s.status, s.set_by, ${TIME('s.set_at')} as set_at, s.lifted_by,
  ${TIME('s.lifted_at')} as lifted_at, s.lift_reason, s.version::text as version, ${TIME('s.set_at')} as sort_key`;

const toRecord = (row: Row): PeriodScopeRecord => ({
  id: row.id,
  roleGrantId: row.role_grant_id,
  membershipId: row.membership_id,
  memberName: row.member_name,
  roleCode: row.role_code,
  periodCodes: row.period_codes,
  reason: row.reason,
  status: row.status,
  setBy: row.set_by,
  setAt: row.set_at,
  liftedBy: row.lifted_by,
  liftedAt: row.lifted_at,
  liftReason: row.lift_reason,
  version: Number(row.version),
  sortKey: row.sort_key,
});

/**
 * The limit of a role grant to report periods (IAM-2). Setting one narrows the holder, lifting it widens them; either raises the scope version of the holder, so their next request reads the access again. The kernel
 * `assertPeriodAllowed` is what the commands that handle a report ask; the access store joins the Active row into the grant it gives them.
 */
export class PeriodScopeStore {
  /** The role grant a limit is set on, locked: its holder and whether it is Active; undefined when the tenant has no such grant. */
  async lockGrant(tx: TenantTx, roleGrantId: string): Promise<{ membershipId: string; active: boolean } | undefined> {
    const [row] = await tx.query<{ membership_id: string; status: string }>('select membership_id, status from machvon.role_grant where id = $1::uuid for update', [roleGrantId]);
    return row === undefined ? undefined : { membershipId: row.membership_id, active: row.status === 'Active' };
  }

  async activeFor(tx: TenantTx, roleGrantId: string): Promise<PeriodScopeRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where s.role_grant_id = $1::uuid and s.status = 'Active'`, [roleGrantId]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** 409 `PERIOD_SCOPE_STATE_INVALID` when the grant already has an Active limit: changing the periods is lifting it and setting another. */
  async insert(tx: TenantTx, input: { roleGrantId: string; membershipId: string; periodCodes: readonly string[]; reason: string; setBy: string }): Promise<PeriodScopeRecord> {
    if ((await this.activeFor(tx, input.roleGrantId)) !== undefined) throw new DomainError('PERIOD_SCOPE_STATE_INVALID', 409, 'role_grant_id');
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.role_grant_period_scope (tenant_id, id, role_grant_id, period_codes, reason, set_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::text[], $3, $4::uuid) returning id`,
      [input.roleGrantId, [...input.periodCodes], input.reason, input.setBy],
    );
    await bumpScopeVersion(tx, [input.membershipId]);
    return (await this.find(tx, (row as { id: string }).id)) as PeriodScopeRecord;
  }

  async find(tx: TenantTx, id: string, options: { forUpdate?: boolean } = {}): Promise<PeriodScopeRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where s.id = $1::uuid${options.forUpdate === true ? ' for update of s' : ''}`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  async list(tx: TenantTx, filters: { id?: string | undefined; status?: string | undefined; membershipId?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<PeriodScopeRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ($1::text is null or s.status = $1) and ($2::uuid is null or s.id = $2::uuid) and ($3::uuid is null or g.membership_id = $3::uuid)
          and ($4::timestamptz is null or (s.set_at, s.id) < ($4::timestamptz, $5::uuid))
        order by s.set_at desc, s.id desc limit $6::int`,
      [filters.status ?? null, filters.id ?? null, filters.membershipId ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }

  /** Lifts a limit: 409 `PERIOD_SCOPE_STATE_INVALID` when it was lifted already, 409 `VERSION_CONFLICT` when it changed since it was read. */
  async lift(tx: TenantTx, id: string, expectedVersion: number, by: string, reason: string, now: Date): Promise<{ before: PeriodScopeRecord; after: PeriodScopeRecord }> {
    const before = await this.find(tx, id, { forUpdate: true });
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.status !== 'Active') throw new DomainError('PERIOD_SCOPE_STATE_INVALID', 409, 'status');
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    await tx.query("update machvon.role_grant_period_scope set status = 'Lifted', lifted_by = $2::uuid, lifted_at = $3::timestamptz, lift_reason = $4, version = version + 1 where id = $1::uuid", [id, by, now.toISOString(), reason]);
    await bumpScopeVersion(tx, [before.membershipId]);
    return { before, after: (await this.find(tx, id)) as PeriodScopeRecord };
  }
}
