import type { TenantTx } from './tenant-database.ts';

export interface GuestGrantChange {
  grantId: string;
  membershipId: string;
  /** `Expired` when the closed contract was the last one the grant covered, `Narrowed` when it still covers others. */
  outcome: 'Expired' | 'Narrowed';
  /** The contracts the grant still covers (empty for an expired grant). */
  remaining: string[];
}

export interface GuestAccessChange {
  grants: GuestGrantChange[];
  /** The guest memberships that were ended because no grant of theirs remains. */
  endedMembershipIds: string[];
}

const GRANTS_SQL = `select g.id, g.membership_id, g.scope_ref_ids::text[] as scope_ref_ids
    from machvon.role_grant g join machvon.membership m on m.tenant_id = g.tenant_id and m.id = g.membership_id
   where g.status = 'Active' and g.scope_kind = 'CONTRACT' and g.scope_ref_ids @> array[$1::uuid] and m.membership_type = 'GUEST_CONTRACTOR'
   order by g.membership_id, g.id
     for update of g`;
const EXPIRE_SQL = `update machvon.role_grant set status = 'Expired', version = version + 1 where id = $1::uuid`;
const NARROW_SQL = `update machvon.role_grant
     set scope_ref_ids = $2::uuid[], scope_json = jsonb_set(scope_json, '{ref_ids}', to_jsonb($2::text[])), version = version + 1
   where id = $1::uuid`;
const LIVE_SQL = `select count(*)::int as n from machvon.role_grant where membership_id = $1::uuid and status = 'Active'`;
const END_SQL = `update machvon.membership set status = 'Ended', version = version + 1, ended_reason = $2
   where id = $1::uuid and status in ('Invited', 'Active', 'Suspended') returning id`;

/**
 * Access of guest contractors that follows their contracts (BR-IAM-08, ST-ADM-007): when a contract ends, the grants that name it lose it. A grant that covered only that contract
 * expires; one that covers others is narrowed to them (the access to the others stays). A guest with no grant left is ended, so that the person loses access when the last
 * contract closes. It runs in the transaction of the consumer of the contract events, in the name of the system; only guests are touched (staff grants on a contract are not).
 */
export class GuestAccessStore {
  async endContractAccess(tx: TenantTx, contractId: string, reason: string): Promise<GuestAccessChange> {
    const rows = await tx.query<{ id: string; membership_id: string; scope_ref_ids: string[] }>(GRANTS_SQL, [contractId]);
    const grants: GuestGrantChange[] = [];
    for (const row of rows) {
      const remaining = row.scope_ref_ids.filter((ref) => ref.toLowerCase() !== contractId.toLowerCase());
      if (remaining.length === 0) await tx.query(EXPIRE_SQL, [row.id]);
      else await tx.query(NARROW_SQL, [row.id, remaining]);
      grants.push({ grantId: row.id, membershipId: row.membership_id, outcome: remaining.length === 0 ? 'Expired' : 'Narrowed', remaining });
    }
    const endedMembershipIds: string[] = [];
    for (const membershipId of [...new Set(grants.map((grant) => grant.membershipId))]) {
      const [live] = await tx.query<{ n: number }>(LIVE_SQL, [membershipId]);
      if ((live?.n ?? 0) > 0) continue;
      const ended = await tx.query(END_SQL, [membershipId, reason]);
      if (ended.length > 0) endedMembershipIds.push(membershipId);
    }
    return { grants, endedMembershipIds };
  }
}
