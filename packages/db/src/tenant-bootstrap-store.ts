import { DomainError } from '@machvon/kernel';
import type { FeatureEntry } from '@machvon/kernel';
import { MemberStore } from './member-store.ts';
import { RoleStore } from './role-store.ts';
import { bumpScopeVersion } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** A new tenant starts on a trial of this many days: the pilot license and the trial subscription end together. */
export const TRIAL_DAYS = 90;
const DAY_MS = 86_400_000;
export const ROOT_UNIT_CODE = 'ROOT';
export const TENANT_OWNER_ROLE = 'TENANT_OWNER';
const OWNER_REPLACED = 'OWNER_REPLACED';
const OWNER_GRANT_REASON = 'tenant owner assigned from the control plane';
const MEMBERSHIP_STATE_INVALID = 'MEMBERSHIP_STATE_INVALID';

export interface AssignOwnerInput {
  email: string;
  displayName?: string | undefined;
  /** The membership of the System Admin (or of the requester of the tenant) who assigns the owner. */
  assignedBy: string;
  /** SHA-256 hashes: the invitation stores the hash of the token and of the email, never the token. */
  tokenHash: string;
  emailHash: string;
  expiresAt: Date;
}

export interface AssignedOwner {
  membershipId: string;
  /** The version of the membership after the assignment, as the lifecycle commands expect it in If-Match. */
  membershipVersion: number;
  unitId: string;
  /** The invitation to send; absent when the person already is an active member of the root unit. */
  invitationId: string | undefined;
  grantId: string | undefined;
  /** Memberships whose pending owner invitation was revoked because another person was named. */
  superseded: string[];
}

interface PlanFeatureRow {
  feature_code: string;
  limit_kind: FeatureEntry['limitKind'];
  limit_value: string | null;
  grace_behavior: FeatureEntry['graceBehavior'];
  expired_behavior: FeatureEntry['expiredBehavior'];
}

const PLAN_FEATURES_SQL = `select feature_code, limit_kind, limit_value::text as limit_value, grace_behavior, expired_behavior
  from machvon.plan_feature where plan_version_id = $1::uuid order by feature_code`;
const SUBSCRIPTION_SQL = 'select id from machvon.subscription order by id limit 1';
const INSERT_SUBSCRIPTION_SQL = `insert into machvon.subscription
    (tenant_id, id, plan_version_id, cycle, billing_anchor, status, payment_terms, started_at, trial_ends_at, current_period_start, current_period_end)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'ANNUAL', $2::date, 'Trialing', '{}'::jsonb, $3::timestamptz, $4::timestamptz, $2::date, (($2::date + interval '1 year')::date - 1))
  returning id`;
const ROOT_UNIT_SQL = `select id from machvon.organization_unit where parent_id is null and status = 'Active' order by (code = '${ROOT_UNIT_CODE}') desc, created_at, id limit 1`;
const INSERT_ROOT_UNIT_SQL = `insert into machvon.organization_unit (tenant_id, id, code, name, parent_id, valid_from, unit_type, path, depth, status)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, '${ROOT_UNIT_CODE}', $2, null, $3::date, 'GOVERNING_BODY', '/' || $1::text || '/', 0, 'Active')`;
// Serialises every change to the pending owner invitations of one tenant: the pending-owner query cannot see the uncommitted
// membership of a concurrent assignment, so two assignments to different people would otherwise both stay pending.
const OWNERS_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('tenant_owners:' || current_setting('app.tenant_id'), 0))";
const LIVE_MEMBERSHIP_SQL = `select id, status, membership_type from machvon.membership where user_id = $1::uuid and organization_id = $2::uuid
  and status in ('Invited', 'Active', 'Suspended') order by created_at limit 1 for update`;
const OWNER_GRANT_SQL = `select g.id from machvon.role_grant g where g.membership_id = $1::uuid and g.role_id = $2::uuid and g.status = 'Active' limit 1`;
// Other people who were named owner and have not accepted yet: their invitation is not the one to follow any more.
const PENDING_OWNERS_SQL = `select m.id from machvon.membership m where m.status = 'Invited' and m.id <> $2::uuid
  and exists (select 1 from machvon.role_grant g where g.membership_id = m.id and g.role_id = $1::uuid and g.status = 'Active') for update of m`;
const REVOKE_GRANTS_SQL = `update machvon.role_grant set status = 'Revoked', revoked_by = $3::uuid, revoked_at = now(), revoke_reason = $4, version = version + 1
  where membership_id = $1::uuid and role_id = $2::uuid and status = 'Active'`;

const todayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * The tenant-owned rows that provisioning (SAS 3.1 steps 6, 9 and 11) and the assignment of an owner write from the
 * control plane. Every method runs in the transaction it is given, which names the tenant, and is idempotent by its natural key.
 */
export class TenantBootstrapStore {
  private readonly members = new MemberStore();
  private readonly roles = new RoleStore();

  /** The feature rows of a plan version, the entitlements the first version of a tenant carries. */
  async planFeatures(tx: TenantTx, planVersionId: string): Promise<FeatureEntry[]> {
    const rows = await tx.query<PlanFeatureRow>(PLAN_FEATURES_SQL, [planVersionId]);
    return rows.map((row) => ({
      featureCode: row.feature_code,
      limitKind: row.limit_kind,
      ...(row.limit_value === null ? {} : { limitValue: Number(row.limit_value) }),
      graceBehavior: row.grace_behavior,
      expiredBehavior: row.expired_behavior,
    }));
  }

  /** The Trialing subscription a new tenant starts on; one that exists is returned as it is. */
  async ensureTrialSubscription(tx: TenantTx, planVersionId: string, now: Date): Promise<string> {
    const [existing] = await tx.query<{ id: string }>(SUBSCRIPTION_SQL);
    if (existing !== undefined) return existing.id;
    const [created] = await tx.query<{ id: string }>(INSERT_SUBSCRIPTION_SQL, [planVersionId, todayOf(now), now.toISOString(), new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString()]);
    if (created === undefined) throw new Error('subscription insert returned no row');
    return created.id;
  }

  /** The root unit of the tenant (a GOVERNING_BODY with the code ROOT); one that exists is left as it is. */
  async ensureRootUnit(tx: TenantTx, id: string, name: string, now: Date): Promise<{ id: string; created: boolean }> {
    const existing = await this.rootUnitId(tx);
    if (existing !== undefined) return { id: existing, created: false };
    await tx.query(INSERT_ROOT_UNIT_SQL, [id, name, todayOf(now)]);
    return { id, created: true };
  }

  async rootUnitId(tx: TenantTx): Promise<string | undefined> {
    const [row] = await tx.query<{ id: string }>(ROOT_UNIT_SQL);
    return row?.id;
  }

  /**
   * Names a person owner of the tenant (BR-IAM-05: only the control plane grants TENANT_OWNER). The person gets a
   * membership in the root unit, the TENANT_OWNER grant and a fresh invitation; an earlier pending invitation of the same
   * person is revoked and replaced (the message can be sent again), and so is the pending owner invitation of anyone else.
   * A person who already owns the tenant, whose membership is suspended or who is a guest contractor (BR-IAM-05: a guest
   * never holds a tenant-wide role), is refused (409 MEMBERSHIP_STATE_INVALID). The authorization version of an existing
   * member is raised so that the cached access of that person is rebuilt with the new grant.
   */
  async assignOwner(tx: TenantTx, input: AssignOwnerInput): Promise<AssignedOwner> {
    await tx.query(OWNERS_LOCK_SQL);
    const unitId = await this.rootUnitId(tx);
    const role = await this.members.activeRoleByCode(tx, TENANT_OWNER_ROLE);
    if (unitId === undefined || role === undefined) throw new DomainError(MEMBERSHIP_STATE_INVALID, 409, 'tenant is not ready');
    const userAccountId = await this.members.ensureInvitedAccount(tx, input.email, input.displayName);
    const [live] = await tx.query<{ id: string; status: string; membership_type: string }>(LIVE_MEMBERSHIP_SQL, [userAccountId, unitId]);
    if (live?.status === 'Suspended') throw new DomainError(MEMBERSHIP_STATE_INVALID, 409, live.status);
    if (live !== undefined && live.membership_type !== 'STAFF') throw new DomainError(MEMBERSHIP_STATE_INVALID, 409, live.membership_type);
    const membershipId = live?.id ?? (await this.members.insertInvitedMember(tx, { userAccountId, organizationId: unitId, membershipType: 'STAFF', invitedBy: input.assignedBy })).id;
    const [holding] = await tx.query<{ id: string }>(OWNER_GRANT_SQL, [membershipId, role.id]);
    if (live?.status === 'Active' && holding !== undefined) throw new DomainError(MEMBERSHIP_STATE_INVALID, 409, 'already owner');
    const grantId =
      holding?.id ??
      (await this.roles.insertGrant(tx, { membershipId, roleId: role.id, scopeKind: 'TENANT', scopeRefIds: [], paths: [], grantedBy: input.assignedBy, reason: OWNER_GRANT_REASON })).id;

    const superseded: string[] = [];
    for (const other of await tx.query<{ id: string }>(PENDING_OWNERS_SQL, [role.id, membershipId])) {
      await this.members.revokePendingInvitations(tx, other.id);
      await tx.query(REVOKE_GRANTS_SQL, [other.id, role.id, input.assignedBy, OWNER_REPLACED]);
      await this.members.setStatus(tx, other.id, 'Ended', OWNER_REPLACED);
      superseded.push(other.id);
    }

    const newGrantId = holding === undefined ? grantId : undefined;
    if (live?.status === 'Active') {
      await bumpScopeVersion(tx, [membershipId]);
      return { membershipId, membershipVersion: await this.versionOf(tx, membershipId), unitId, invitationId: undefined, grantId: newGrantId, superseded };
    }
    await this.members.revokePendingInvitations(tx, membershipId);
    const invitation = await this.members.insertInvitation(tx, {
      membershipId,
      emailHash: input.emailHash,
      tokenHash: input.tokenHash,
      invitedBy: input.assignedBy,
      expiresAt: input.expiresAt,
    });
    return { membershipId, membershipVersion: await this.versionOf(tx, membershipId), unitId, invitationId: invitation.id, grantId: newGrantId, superseded };
  }

  private async versionOf(tx: TenantTx, membershipId: string): Promise<number> {
    const member = await this.members.membershipOf(tx, membershipId);
    if (member === undefined) throw new Error('the membership of the assigned owner disappeared');
    return member.version;
  }

  /** Revokes the pending owner invitations and grants of the tenant (provisioning cancelled): nobody is left half invited. */
  async revokePendingOwners(tx: TenantTx, revokedBy: string): Promise<number> {
    await tx.query(OWNERS_LOCK_SQL);
    const role = await this.members.activeRoleByCode(tx, TENANT_OWNER_ROLE);
    if (role === undefined) return 0;
    const pending = await tx.query<{ id: string }>(PENDING_OWNERS_SQL, [role.id, '00000000-0000-4000-8000-000000000000']);
    for (const member of pending) {
      await this.members.revokePendingInvitations(tx, member.id);
      await tx.query(REVOKE_GRANTS_SQL, [member.id, role.id, revokedBy, 'PROVISIONING_CANCELLED']);
      await this.members.setStatus(tx, member.id, 'Ended', 'PROVISIONING_CANCELLED');
    }
    return pending.length;
  }
}
