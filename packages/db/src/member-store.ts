import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const TENANT_OWNER = 'TENANT_OWNER';

export type MembershipStatus = 'Invited' | 'Active' | 'Suspended' | 'Ended' | 'Expired';
export type InvitationStatus = 'Pending' | 'Accepted' | 'Expired' | 'Revoked';

/** A membership with the unit it belongs to, as the lifecycle commands need it. */
export interface MemberRecord {
  id: string;
  userAccountId: string;
  status: MembershipStatus;
  membershipType: string;
  contractorId: string | null;
  organizationId: string;
  unitPath: string;
  version: number;
  validUntil: Date | null;
}

export interface UnitRecord {
  id: string;
  path: string;
  status: string;
}

export interface NewInvitedMember {
  userAccountId: string;
  organizationId: string;
  membershipType: 'STAFF' | 'GUEST_CONTRACTOR';
  contractorId?: string;
  validUntil?: Date;
  invitedBy: string;
}

export interface NewInvitation {
  membershipId: string;
  emailHash: string;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
}

export interface InvitationRecord {
  id: string;
  membershipId: string;
  emailHash: string;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  expired: boolean;
}

/** What the member directory shows beside the membership itself (ADM-02, ADM-17). */
export interface DirectoryDetail {
  /** The version the lifecycle commands expect in If-Match. */
  version: number;
  roleCodes: string[];
  invitationStatus: InvitationStatus | null;
  contractorId: string | null;
  contractorName: string | null;
  contracts: Array<{ id: string; code: string }>;
}

/**
 * A SQL condition over the owner unit of a contract (columns `cu.path` and `cu.id`) with its parameters; the caller
 * numbers them from the first parameter the query leaves free (`$2` in `directoryDetails`, `$4` in `contractsInReach`).
 */
export interface ContractReach {
  sql: string;
  params: readonly unknown[];
}

/** A contract as the guest invitation picks it: the minimum of the CTR module (R1) that ADM needs. */
export interface ContractSummary {
  id: string;
  code: string;
  status: string;
  contractorId: string;
  contractorName: string | null;
  projectId: string;
  ownerUnitId: string;
  /** Planned completion (YYYY-MM-DD); null when none is set. */
  completionDue: string | null;
}

/**
 * What the tenant may have: seats of staff members and of guest contractors (null: no limit recorded). The staff seats are the lower of the licence
 * and the plan (the `member.seats` quota of the entitlements, an override in force replacing the plan's number); the guest seats are the licence's.
 */
export interface SeatLimits {
  seats: number | null;
  guestSeats: number | null;
}

interface MemberRow {
  id: string;
  user_id: string;
  status: MembershipStatus;
  membership_type: string;
  contractor_id: string | null;
  organization_id: string;
  unit_path: string;
  version: string;
  valid_until: Date | null;
}

// The membership is locked first and the invitation second, the order of an acceptance and of ending a membership, so the
// three cannot wait for each other.
const EXPIRE_STALE_SQL = `with candidates as (
    select m.id from machvon.membership m
     where m.user_id = $1::uuid and m.organization_id = $2::uuid and m.status = 'Invited'
     order by m.id
       for update
  ), lapsed as (
    update machvon.membership_invitation i set status = 'Expired'
      from candidates c
     where i.membership_id = c.id and i.status = 'Pending' and i.expires_at <= now()
       and not exists (select 1 from machvon.membership_invitation live where live.membership_id = c.id and live.status = 'Pending' and live.expires_at > now())
    returning i.membership_id
  )
  update machvon.membership set status = 'Expired', version = version + 1
   where id in (select membership_id from lapsed) and status = 'Invited'`;

const MEMBER_COLUMNS = `m.id, m.user_id, m.status, m.membership_type, m.contractor_id, m.organization_id, ou.path as unit_path,
  m.version::text as version, m.valid_until`;

function memberOf(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    userAccountId: row.user_id,
    status: row.status,
    membershipType: row.membership_type,
    contractorId: row.contractor_id,
    organizationId: row.organization_id,
    unitPath: row.unit_path,
    version: Number(row.version),
    validUntil: row.valid_until,
  };
}

interface InvitationRow {
  id: string;
  membership_id: string;
  email_hash: string;
  token_hash: string;
  status: InvitationStatus;
  expires_at: Date;
  expired: boolean;
}

function invitationOf(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    membershipId: row.membership_id,
    emailHash: row.email_hash,
    tokenHash: row.token_hash,
    status: row.status,
    expiresAt: row.expires_at,
    expired: row.expired,
  };
}

const INVITATION_COLUMNS = 'id, membership_id, email_hash, token_hash, status, expires_at, expires_at <= now() as expired';

/**
 * Members and invitations (ADM-006, IAM section 3.3): creating an invited membership and its invitation, the
 * lifecycle transitions of a membership, seat counting and the guard for the last tenant owner. Every method runs in
 * the transaction of the command; row-level security keeps it inside the tenant.
 */
export class MemberStore {
  /** The account of the email, created as an unbound shell when it does not exist yet (migration V011). */
  async ensureInvitedAccount(tx: TenantTx, email: string, displayName: string | undefined): Promise<string> {
    const rows = await tx.query<{ id: string }>('select machvon.ensure_invited_account($1, $2) as id', [email, displayName ?? '']);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('ensure_invited_account returned nothing');
    return id;
  }

  async unitOf(tx: TenantTx, unitId: string): Promise<UnitRecord | undefined> {
    // Shared lock of the row, held to the end of the transaction: a reorganisation cannot retire the unit between this look and the membership that is inserted after it (the retirement waits for the invitation and then sees it).
    const rows = await tx.query<UnitRecord>('select id, path, status from machvon.organization_unit where id = $1::uuid for share', [unitId]);
    return rows[0];
  }

  /**
   * Creates the membership in state Invited. A person who already holds a live membership in the unit is refused (409
   * MEMBERSHIP_EXISTS); an earlier invitation of the same person that nobody opened and that ran out does not count: it and its
   * membership become Expired first, so the person can be invited again (the invitation is otherwise only expired when opened).
   */
  async insertInvitedMember(tx: TenantTx, input: NewInvitedMember): Promise<{ id: string; version: number }> {
    await tx.query(EXPIRE_STALE_SQL, [input.userAccountId, input.organizationId]);
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.membership (tenant_id, id, user_id, organization_id, status, membership_type, contractor_id, valid_until, invited_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'Invited', $3, $4::uuid, $5, $6::uuid)
         returning id`,
        [input.userAccountId, input.organizationId, input.membershipType, input.contractorId ?? null, input.validUntil ?? null, input.invitedBy],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('insert of the invited membership returned nothing');
      return { id, version: 1 };
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('MEMBERSHIP_EXISTS', 409);
      throw error;
    }
  }

  /** The Active role with this code, for the role every invited person receives by default. */
  async activeRoleByCode(tx: TenantTx, code: string): Promise<{ id: string } | undefined> {
    const rows = await tx.query<{ id: string }>(`select id from machvon.role_definition where code = $1 and status = 'Active'`, [code]);
    return rows[0];
  }

  async insertInvitation(tx: TenantTx, input: NewInvitation): Promise<{ id: string }> {
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.membership_invitation (tenant_id, id, membership_id, email_hash, token_hash, invited_by, expires_at, status)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5, 'Pending')
       returning id`,
      [input.membershipId, input.emailHash, input.tokenHash, input.invitedBy, input.expiresAt],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('insert of the invitation returned nothing');
    return { id };
  }

  /** Locks the membership and returns it with its unit; undefined when it does not exist (in this tenant). */
  async lockMember(tx: TenantTx, membershipId: string): Promise<MemberRecord | undefined> {
    const rows = await tx.query<MemberRow>(
      `select ${MEMBER_COLUMNS} from machvon.membership m join machvon.organization_unit ou on ou.tenant_id = m.tenant_id and ou.id = m.organization_id
        where m.id = $1::uuid for update of m`,
      [membershipId],
    );
    return rows[0] === undefined ? undefined : memberOf(rows[0]);
  }

  /** Sets the status of a membership locked by `lockMember` and returns the new version. */
  async setStatus(tx: TenantTx, membershipId: string, status: MembershipStatus, endedReason?: string): Promise<number> {
    const rows = await tx.query<{ version: string }>(
      `update machvon.membership set status = $2, version = version + 1, ended_reason = coalesce($3, ended_reason)
        where id = $1::uuid returning version::text as version`,
      [membershipId, status, endedReason ?? null],
    );
    return Number(rows[0]?.version);
  }

  /** Ends every session of the membership in the database; the ids are returned so the caller can tell the deny-list. */
  async revokeSessions(tx: TenantTx, membershipId: string, reason: string): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      `update machvon.user_session set revoked_at = now(), revoke_reason = $2 where membership_id = $1::uuid and revoked_at is null returning id`,
      [membershipId, reason],
    );
    return rows.map((row) => row.id);
  }

  /** Revokes the invitations of a membership that are still pending (the membership was ended or replaced). */
  async revokePendingInvitations(tx: TenantTx, membershipId: string): Promise<void> {
    await tx.query(
      `update machvon.membership_invitation set status = 'Revoked', revoked_at = now() where membership_id = $1::uuid and status = 'Pending'`,
      [membershipId],
    );
  }

  /** The invitation by id, optionally locked; undefined when it does not exist in this tenant. */
  async findInvitation(tx: TenantTx, invitationId: string, options: { forUpdate?: boolean } = {}): Promise<InvitationRecord | undefined> {
    const rows = await tx.query<InvitationRow>(
      `select ${INVITATION_COLUMNS} from machvon.membership_invitation where id = $1::uuid ${options.forUpdate === true ? 'for update' : ''}`,
      [invitationId],
    );
    return rows[0] === undefined ? undefined : invitationOf(rows[0]);
  }

  async markInvitationAccepted(tx: TenantTx, invitationId: string): Promise<void> {
    await tx.query(`update machvon.membership_invitation set status = 'Accepted', accepted_at = now() where id = $1::uuid`, [invitationId]);
  }

  /** An invitation that ran out: it and its membership become Expired, so the person can be invited again. */
  async expireInvitation(tx: TenantTx, invitationId: string, membershipId: string): Promise<void> {
    await tx.query(`update machvon.membership_invitation set status = 'Expired' where id = $1::uuid and status = 'Pending'`, [invitationId]);
    await tx.query(`update machvon.membership set status = 'Expired', version = version + 1 where id = $1::uuid and status = 'Invited'`, [membershipId]);
  }

  async membershipOf(tx: TenantTx, membershipId: string): Promise<MemberRecord | undefined> {
    const rows = await tx.query<MemberRow>(
      `select ${MEMBER_COLUMNS} from machvon.membership m join machvon.organization_unit ou on ou.tenant_id = m.tenant_id and ou.id = m.organization_id
        where m.id = $1::uuid`,
      [membershipId],
    );
    return rows[0] === undefined ? undefined : memberOf(rows[0]);
  }

  /**
   * Whether the membership is the last Active tenant owner (an Active membership inside its validity holding an
   * Active TENANT_OWNER grant). The TENANT_OWNER role row is locked first, so two concurrent commands cannot each see
   * the other owner still in place (BR-IAM-07).
   */
  async isLastOwner(tx: TenantTx, membershipId: string): Promise<boolean> {
    await tx.query(`select id from machvon.role_definition where code = $1 for update`, [TENANT_OWNER]);
    const rows = await tx.query<{ holder: boolean; others: string }>(
      `select exists (select 1 from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id
                       where g.membership_id = $1::uuid and r.code = $2 and g.status = 'Active') as holder,
              (select count(distinct g.membership_id) from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id
                 join machvon.membership m on m.id = g.membership_id
                where r.code = $2 and g.status = 'Active' and g.membership_id <> $1::uuid and m.status = 'Active'
                  and g.effective_from <= now() and (g.effective_until is null or g.effective_until > now())
                  and (m.valid_until is null or m.valid_until > now()))::text as others`,
      [membershipId, TENANT_OWNER],
    );
    const row = rows[0];
    return row !== undefined && row.holder && Number(row.others) === 0;
  }

  /** Seats taken now: staff members (service accounts excluded) and guest contractors, counted apart (BR-SAS-09). */
  async seatsInUse(tx: TenantTx): Promise<{ staff: number; guests: number }> {
    // The count comes from a function that answers for the tenant the transaction acts as, so the control plane, which reads no membership, asks the same way.
    const rows = await tx.query<{ staff: string; guests: string }>("select staff::text, guests::text from machvon.seats_in_use(nullif(current_setting('app.tenant_id', true), '')::uuid)");
    return { staff: Number(rows[0]?.staff ?? 0), guests: Number(rows[0]?.guests ?? 0) };
  }

  /**
   * The seat limits in force now: those of the licence (the latest valid revision that is not revoked) and the plan's quota of staff seats, whichever
   * is lower. Lowering a quota takes nobody away, it only keeps the next one out (BR-SAS-09), so a tenant above its new limit has no free seat.
   */
  async seatLimits(tx: TenantTx): Promise<SeatLimits> {
    const rows = await tx.query<{ seats: number | null; guest_seats: string | null }>(
      `select seats, quota_json ->> 'guest_seats' as guest_seats from machvon.license_revision
        where status in ('Issued','Active','Grace') and valid_from <= now() order by valid_from desc, revision desc limit 1`,
    );
    const row = rows[0];
    const plan = await this.planSeats(tx);
    const licensed = row?.seats ?? null;
    const seats = licensed === null ? plan : plan === null ? licensed : Math.min(licensed, plan);
    const guest = row?.guest_seats === null || row?.guest_seats === undefined ? Number.NaN : Number(row.guest_seats);
    return { seats, guestSeats: Number.isFinite(guest) ? guest : null };
  }

  /** The `member.seats` quota of the latest entitlement version, replaced by the override in force when it names a limit; null when there is none. */
  private async planSeats(tx: TenantTx): Promise<number | null> {
    const rows = await tx.query<{ plan_limit: string | null; has_override: boolean; override_limit: string | null }>(
      `select (select trim_scale((f ->> 'limitValue')::numeric)::text
                 from (select features_json from machvon.entitlement_version order by version_no desc limit 1) v, jsonb_array_elements(v.features_json) f
                where f ->> 'featureCode' = 'member.seats') as plan_limit,
              exists (select 1 from machvon.entitlement_override where feature_code = 'member.seats' and status = 'Active' and valid_from <= now() and now() < valid_until) as has_override,
              (select trim_scale(limit_value)::text from machvon.entitlement_override
                where feature_code = 'member.seats' and status = 'Active' and valid_from <= now() and now() < valid_until order by valid_from desc limit 1) as override_limit`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    const limit = row.has_override ? (row.override_limit ?? row.plan_limit) : row.plan_limit;
    return limit === null ? null : Number(limit);
  }

  /** Serialises seat decisions of one tenant (accept and reactivate) so two of them cannot both take the last seat. */
  async lockSeats(tx: TenantTx): Promise<void> {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('seats:' || current_setting('app.tenant_id'), 0))`);
  }

  /** Refuses (403 QUOTA_EXCEEDED) when one more active member of this type would pass the seats of the licence or the plan (BR-SAS-09). */
  async assertSeatFree(tx: TenantTx, membershipType: string): Promise<void> {
    await this.lockSeats(tx);
    const [limits, used] = [await this.seatLimits(tx), await this.seatsInUse(tx)];
    const guest = membershipType === 'GUEST_CONTRACTOR';
    const limit = guest ? limits.guestSeats : limits.seats;
    if (limit !== null && (guest ? used.guests : used.staff) + 1 > limit) throw new DomainError('QUOTA_EXCEEDED', 403);
  }

  /**
   * The latest planned completion among these contracts (BR-IAM-08 bounds the validity of a guest by it); undefined
   * when none of them has one or none exists in the tenant.
   */
  async latestContractEnd(tx: TenantTx, contractIds: readonly string[]): Promise<Date | undefined> {
    if (contractIds.length === 0) return undefined;
    const rows = await tx.query<{ latest: string | null }>(
      `select max(completion_due)::text as latest from machvon.contract where id = any($1::uuid[])`,
      [[...new Set(contractIds)]],
    );
    const latest = rows[0]?.latest;
    return latest === null || latest === undefined ? undefined : new Date(`${latest}T00:00:00Z`);
  }

  /** One page of the contracts whose owner unit satisfies `reach`, ordered by (code, id); `after` is the last row of the page before. */
  async contractsInReach(tx: TenantTx, input: { limit: number; after?: { code: string; id: string }; reach: ContractReach }): Promise<ContractSummary[]> {
    const rows = await tx.query<{
      id: string;
      code: string;
      status: string;
      contractor_id: string;
      contractor_name: string | null;
      project_id: string;
      owner_unit_id: string;
      completion_due: string | null;
    }>(
      `select c.id, c.code, c.status, c.contractor_id, k.legal_name as contractor_name, p.id as project_id, cu.id as owner_unit_id, c.completion_due::text as completion_due
         from machvon.contract c
         join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         join machvon.organization_unit cu on cu.tenant_id = p.tenant_id and cu.id = p.owner_unit_id
         left join machvon.contractor k on k.tenant_id = c.tenant_id and k.id = c.contractor_id
        where ($1::text is null or (c.code, c.id) > ($1::text, $2::uuid)) and ${input.reach.sql}
        order by c.code, c.id limit $3`,
      [input.after?.code ?? null, input.after?.id ?? null, input.limit, ...input.reach.params],
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      status: row.status,
      contractorId: row.contractor_id,
      contractorName: row.contractor_name,
      projectId: row.project_id,
      ownerUnitId: row.owner_unit_id,
      completionDue: row.completion_due,
    }));
  }

  /**
   * Roles in force, newest invitation status, contractor and contracts of the given memberships, for the member
   * directory. The contracts come from Active CONTRACT grants and only the ones whose owner unit satisfies `reach`
   * (`$1` is taken by the ids), so a reader never learns the contracts outside their scope.
   */
  async directoryDetails(tx: TenantTx, membershipIds: readonly string[], reach: ContractReach): Promise<Map<string, DirectoryDetail>> {
    const details = new Map<string, DirectoryDetail>();
    if (membershipIds.length === 0) return details;
    const ids = [...new Set(membershipIds)];
    const memberships = await tx.query<{ id: string; version: string; contractor_id: string | null; contractor_name: string | null }>(
      `select m.id, m.version::text as version, m.contractor_id, c.legal_name as contractor_name from machvon.membership m
         left join machvon.contractor c on c.tenant_id = m.tenant_id and c.id = m.contractor_id where m.id = any($1::uuid[])`,
      [ids],
    );
    for (const row of memberships) details.set(row.id, { version: Number(row.version), roleCodes: [], invitationStatus: null, contractorId: row.contractor_id, contractorName: row.contractor_name, contracts: [] });

    const roles = await tx.query<{ membership_id: string; code: string }>(
      `select g.membership_id, r.code from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id
        where g.membership_id = any($1::uuid[]) and g.status = 'Active' and r.status = 'Active'
          and g.effective_from <= now() and (g.effective_until is null or g.effective_until > now())
        group by g.membership_id, r.code order by r.code`,
      [ids],
    );
    for (const row of roles) details.get(row.membership_id)?.roleCodes.push(row.code);

    const invitations = await tx.query<{ membership_id: string; status: InvitationStatus }>(
      `select distinct on (membership_id) membership_id, status from machvon.membership_invitation
        where membership_id = any($1::uuid[]) order by membership_id, expires_at desc`,
      [ids],
    );
    for (const row of invitations) {
      const detail = details.get(row.membership_id);
      if (detail !== undefined) detail.invitationStatus = row.status;
    }

    const contracts = await tx.query<{ membership_id: string; id: string; code: string }>(
      `select distinct g.membership_id, c.id, c.code
         from machvon.role_grant g
         cross join lateral unnest(g.scope_ref_ids) as ref(id)
         join machvon.contract c on c.id = ref.id
         join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         join machvon.organization_unit cu on cu.tenant_id = p.tenant_id and cu.id = p.owner_unit_id
        where g.membership_id = any($1::uuid[]) and g.scope_kind = 'CONTRACT' and g.status = 'Active' and ${reach.sql}
        order by c.code`,
      [ids, ...reach.params],
    );
    for (const row of contracts) details.get(row.membership_id)?.contracts.push({ id: row.id, code: row.code });
    return details;
  }

  /** The initial grants of an invited membership stay as they are; this lists them for the audit row (role codes only). */
  async grantRoleCodes(tx: TenantTx, membershipId: string): Promise<string[]> {
    const rows = await tx.query<{ code: string }>(
      `select r.code from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id
        where g.membership_id = $1::uuid and g.status = 'Active' order by r.code`,
      [membershipId],
    );
    return rows.map((row) => row.code);
  }
}
