import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { MemberStore } from '../src/member-store';
import { seedSystemRoles } from '../src/system-roles';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, grantId, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new MemberStore();
const ACTOR = memberId(1);

const inTenant = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, ACTOR), work);

describe('MemberStore (members and invitations, ADM-006)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }, { n: 2, path: '/u1/u2/', parent: 1 }]);
    for (const member of [1, 2, 3]) await harness.seedMembership(TENANT_A, member, 1);
    await inTenant((tx) => seedSystemRoles(tx, ACTOR));
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  const roleIdOf = async (code: string): Promise<string> => (await admin<{ id: string }>('select id from machvon.role_definition where tenant_id = $1 and code = $2', [TENANT_A, code]))[0]?.id ?? '';
  const makeOwner = async (n: number, member: number): Promise<void> => {
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
        [TENANT_A, grantId(n), memberId(member), await roleIdOf('TENANT_OWNER'), ACTOR],
      ],
    ]);
  };

  const admin = async <R extends object>(text: string, params: unknown[] = []): Promise<R[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as R[];
    } finally {
      await client.end();
    }
  };

  describe('the account of an invitation', () => {
    it('creates an unbound shell for a new email, named after the address when no name is given, and reuses it for the same address in any case', async () => {
      const first = await inTenant((tx) => store.ensureInvitedAccount(tx, '  New.Person@Example.TEST ', undefined));
      const again = await inTenant((tx) => store.ensureInvitedAccount(tx, 'new.person@example.test', 'Ignored Name'));
      expect(again).toBe(first);
      const [account] = await admin<{ idp_subject: string; display_name: string; email_normalized: string; status: string }>(
        'select idp_subject, display_name, email_normalized, status from machvon.user_account where id = $1',
        [first],
      );
      expect(account).toMatchObject({ display_name: 'new.person', email_normalized: 'new.person@example.test', status: 'Active' });
      expect(account?.idp_subject).toMatch(/^invitation:[0-9a-f-]{36}$/);
    });

    it('finds the account of a person who already has one', async () => {
      const found = await inTenant((tx) => store.ensureInvitedAccount(tx, 'user2@example.test', 'Another Name'));
      expect(found).toBe(id(0x60, 2));
    });

    it.each(['', '   ', 'no-at-sign', '@x', `${'a'.repeat(250)}@example.test`])('refuses the address %j', async (email) => {
      await expect(inTenant((tx) => store.ensureInvitedAccount(tx, email, undefined))).rejects.toMatchObject({ code: '22023' });
    });

    it('cannot be called by one tenant to read the accounts of another: it returns an id and nothing else', async () => {
      const id1 = await inTenant((tx) => store.ensureInvitedAccount(tx, 'shared@example.test', 'Shared'), TENANT_A);
      const id2 = await inTenant((tx) => store.ensureInvitedAccount(tx, 'shared@example.test', 'Shared'), TENANT_B);
      expect(id2).toBe(id1);
    });
  });

  describe('invited memberships and invitations', () => {
    it('refuses a second live membership of one person in one unit', async () => {
      const account = await inTenant((tx) => store.ensureInvitedAccount(tx, 'twice@example.test', undefined));
      const input = { userAccountId: account, organizationId: unitId(2), membershipType: 'STAFF' as const, invitedBy: ACTOR };
      await inTenant((tx) => store.insertInvitedMember(tx, input));
      await expect(inTenant((tx) => store.insertInvitedMember(tx, input))).rejects.toMatchObject({ code: 'MEMBERSHIP_EXISTS', status: 409 });
    });

    it('lets a person be invited again once the invitation nobody opened has run out, and not before', async () => {
      const account = await inTenant((tx) => store.ensureInvitedAccount(tx, 'abandoned@example.test', undefined));
      const input = { userAccountId: account, organizationId: unitId(2), membershipType: 'STAFF' as const, invitedBy: ACTOR };
      const token = (fill: string): string => randomUUID().replaceAll('-', '').padEnd(64, fill);
      const first = await inTenant((tx) => store.insertInvitedMember(tx, input));
      const open = await inTenant((tx) => store.insertInvitation(tx, { membershipId: first.id, emailHash: 'd'.repeat(64), tokenHash: token('3'), invitedBy: ACTOR, expiresAt: new Date(Date.now() + 60_000) }));
      // Still open: the person has a live membership and the refusal stands.
      await expect(inTenant((tx) => store.insertInvitedMember(tx, input))).rejects.toMatchObject({ code: 'MEMBERSHIP_EXISTS', status: 409 });
      expect((await inTenant((tx) => store.membershipOf(tx, first.id)))?.status).toBe('Invited');

      await admin("update machvon.membership_invitation set expires_at = now() - interval '1 minute' where id = $1", [open.id]);
      const second = await inTenant((tx) => store.insertInvitedMember(tx, input));
      expect(second.id).not.toBe(first.id);
      expect(await inTenant((tx) => store.membershipOf(tx, first.id))).toMatchObject({ status: 'Expired', version: 2 });
      expect((await inTenant((tx) => store.findInvitation(tx, open.id)))?.status).toBe('Expired');
      expect((await inTenant((tx) => store.membershipOf(tx, second.id)))?.status).toBe('Invited');
    });

    it('locks the membership before it touches the invitation, the order of an acceptance, so the two cannot deadlock', async () => {
      const account = await inTenant((tx) => store.ensureInvitedAccount(tx, 'lock-order@example.test', undefined));
      const input = { userAccountId: account, organizationId: unitId(2), membershipType: 'STAFF' as const, invitedBy: ACTOR };
      const member = await inTenant((tx) => store.insertInvitedMember(tx, input));
      const invitation = await inTenant((tx) =>
        store.insertInvitation(tx, { membershipId: member.id, emailHash: 'c'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '6'), invitedBy: ACTOR, expiresAt: new Date(Date.now() - 1000) }),
      );
      // Another transaction (an acceptance, an ending of the membership) holds the membership.
      const holder = new Client({ connectionString: harness.database.adminUrl });
      await holder.connect();
      const probe = new Client({ connectionString: harness.database.adminUrl });
      await probe.connect();
      let reinvited: Promise<{ id: string }> | undefined;
      try {
        await holder.query('begin');
        await holder.query('select id from machvon.membership where id = $1 for update', [member.id]);
        reinvited = inTenant((tx) => store.insertInvitedMember(tx, input));
        // Wait until the re-invitation is blocked on the lock of the membership.
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const waiting = await probe.query("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%membership_invitation%'");
          if (waiting.rowCount !== 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // It has not taken the invitation yet: whoever holds the membership can still take the invitation without waiting.
        await probe.query('begin');
        await expect(probe.query('select id from machvon.membership_invitation where id = $1 for update nowait', [invitation.id])).resolves.toMatchObject({ rowCount: 1 });
        await probe.query('rollback');
      } finally {
        await holder.query('commit');
        await holder.end();
        await probe.end();
      }
      expect((await reinvited)?.id).not.toBe(member.id);
      expect(await inTenant((tx) => store.membershipOf(tx, member.id))).toMatchObject({ status: 'Expired' });
    });

    it('does not expire a membership that has a second invitation still open', async () => {
      const account = await inTenant((tx) => store.ensureInvitedAccount(tx, 'two-invitations@example.test', undefined));
      const input = { userAccountId: account, organizationId: unitId(2), membershipType: 'STAFF' as const, invitedBy: ACTOR };
      const member = await inTenant((tx) => store.insertInvitedMember(tx, input));
      const stale = await inTenant((tx) => store.insertInvitation(tx, { membershipId: member.id, emailHash: 'e'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '4'), invitedBy: ACTOR, expiresAt: new Date(Date.now() - 1000) }));
      await inTenant((tx) => store.insertInvitation(tx, { membershipId: member.id, emailHash: 'f'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '5'), invitedBy: ACTOR, expiresAt: new Date(Date.now() + 60_000) }));
      await expect(inTenant((tx) => store.insertInvitedMember(tx, input))).rejects.toMatchObject({ code: 'MEMBERSHIP_EXISTS', status: 409 });
      expect((await inTenant((tx) => store.membershipOf(tx, member.id)))?.status).toBe('Invited');
      expect((await inTenant((tx) => store.findInvitation(tx, stale.id)))?.status).toBe('Pending');
    });

    it('moves an invitation through acceptance and expiry, and finds nothing for a missing one', async () => {
      const account = await inTenant((tx) => store.ensureInvitedAccount(tx, 'flow@example.test', undefined));
      const member = await inTenant((tx) => store.insertInvitedMember(tx, { userAccountId: account, organizationId: unitId(2), membershipType: 'STAFF', invitedBy: ACTOR }));
      const invitation = await inTenant((tx) =>
        store.insertInvitation(tx, { membershipId: member.id, emailHash: 'a'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'), invitedBy: ACTOR, expiresAt: new Date(Date.now() + 60_000) }),
      );
      const found = await inTenant((tx) => store.findInvitation(tx, invitation.id, { forUpdate: true }));
      expect(found).toMatchObject({ id: invitation.id, membershipId: member.id, status: 'Pending', expired: false });
      expect(await inTenant((tx) => store.findInvitation(tx, randomUUID()))).toBeUndefined();

      await inTenant((tx) => store.markInvitationAccepted(tx, invitation.id));
      expect((await inTenant((tx) => store.findInvitation(tx, invitation.id)))?.status).toBe('Accepted');

      const second = await inTenant((tx) => store.insertInvitation(tx, { membershipId: member.id, emailHash: 'b'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '1'), invitedBy: ACTOR, expiresAt: new Date(Date.now() - 1000) }));
      expect((await inTenant((tx) => store.findInvitation(tx, second.id)))?.expired).toBe(true);
      await inTenant((tx) => store.expireInvitation(tx, second.id, member.id));
      expect((await inTenant((tx) => store.findInvitation(tx, second.id)))?.status).toBe('Expired');
      expect((await inTenant((tx) => store.membershipOf(tx, member.id)))?.status).toBe('Expired');
      expect(await inTenant((tx) => store.membershipOf(tx, randomUUID()))).toBeUndefined();
    });

    it('revokes the pending invitations of a membership and nothing else', async () => {
      const account = await inTenant((tx) => store.ensureInvitedAccount(tx, 'revoke@example.test', undefined));
      const member = await inTenant((tx) => store.insertInvitedMember(tx, { userAccountId: account, organizationId: unitId(2), membershipType: 'STAFF', invitedBy: ACTOR }));
      const pending = await inTenant((tx) => store.insertInvitation(tx, { membershipId: member.id, emailHash: 'c'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '2'), invitedBy: ACTOR, expiresAt: new Date(Date.now() + 60_000) }));
      await inTenant((tx) => store.revokePendingInvitations(tx, member.id));
      expect((await inTenant((tx) => store.findInvitation(tx, pending.id)))?.status).toBe('Revoked');
    });

    it('locks a member with the path of their unit, sets the status with a new version and ends their sessions once', async () => {
      const member = await inTenant((tx) => store.lockMember(tx, memberId(2)));
      expect(member).toMatchObject({ id: memberId(2), status: 'Active', unitPath: '/u1/', version: 1, membershipType: 'STAFF' });
      expect(await inTenant((tx) => store.lockMember(tx, randomUUID()))).toBeUndefined();
      expect(await inTenant((tx) => store.setStatus(tx, memberId(2), 'Suspended'))).toBe(2);
      expect(await inTenant((tx) => store.setStatus(tx, memberId(2), 'Ended', 'left the company'))).toBe(3);
      expect((await admin<{ ended_reason: string }>('select ended_reason from machvon.membership where id = $1', [memberId(2)]))[0]?.ended_reason).toBe('left the company');
      await admin(
        `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary)
         values ($1, $2, $3, $4, 'idp-store', 'aal1', $5, 'test')`,
        [TENANT_A, randomUUID(), id(0x60, 2), memberId(2), '0'.repeat(64)],
      );
      expect(await inTenant((tx) => store.revokeSessions(tx, memberId(2), 'MEMBERSHIP_CHANGED'))).toHaveLength(1);
      expect(await inTenant((tx) => store.revokeSessions(tx, memberId(2), 'MEMBERSHIP_CHANGED'))).toHaveLength(0);
    });

    it('finds an active role by code and none for an unknown one', async () => {
      expect(await inTenant((tx) => store.activeRoleByCode(tx, 'MEMBER'))).toEqual({ id: await roleIdOf('MEMBER') });
      expect(await inTenant((tx) => store.activeRoleByCode(tx, 'NO_SUCH_ROLE'))).toBeUndefined();
    });
  });

  describe('owners', () => {
    it('knows the last owner: only an Active owner with no Active owner beside them is last', async () => {
      await makeOwner(1, 1);
      expect(await inTenant((tx) => store.isLastOwner(tx, memberId(1)))).toBe(true);
      expect(await inTenant((tx) => store.isLastOwner(tx, memberId(3)))).toBe(false);
      await makeOwner(2, 3);
      expect(await inTenant((tx) => store.isLastOwner(tx, memberId(1)))).toBe(false);
      expect(await inTenant((tx) => store.isLastOwner(tx, memberId(3)))).toBe(false);
      await admin("update machvon.membership set status = 'Suspended' where id = $1", [memberId(3)]);
      expect(await inTenant((tx) => store.isLastOwner(tx, memberId(1)))).toBe(true);
      expect(await inTenant((tx) => store.grantRoleCodes(tx, memberId(1)))).toEqual(['TENANT_OWNER']);
    });
  });

  describe('seats', () => {
    const revision = async (seats: number | null, quota: Record<string, unknown>, status = 'Active', from = "now() - interval '1 day'"): Promise<void> => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query('set session_replication_role = replica');
        await client.query(
          `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id, seats, quota_json)
           values ($1, $2, $3, 1, $4, ${from}, now() + interval '1 year', now() + interval '2 years', $5, 'claims', 'key', $6, $7::jsonb)`,
          [TENANT_A, randomUUID(), randomUUID(), randomUUID(), status, seats, JSON.stringify(quota)],
        );
      } finally {
        await client.end();
      }
    };

    it('has no limit when the tenant has no licence', async () => {
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: null, guestSeats: null });
      await inTenant((tx) => store.assertSeatFree(tx, 'STAFF'));
    });

    it('reads the seats and the guest seats of the latest valid revision, and ignores revoked, future and malformed ones', async () => {
      await revision(5, { guest_seats: 'many' }, 'Revoked');
      await revision(6, {}, 'Active', "now() + interval '1 day'");
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: null, guestSeats: null });
      await revision(4, { guest_seats: 'many' });
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: 4, guestSeats: null });
      await revision(3, { guest_seats: 2 }, 'Issued', "now() - interval '1 hour'");
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: 3, guestSeats: 2 });
    });

    it('counts staff and guests apart and refuses the seat that passes the limit', async () => {
      const used = await inTenant((tx) => store.seatsInUse(tx));
      expect(used.guests).toBe(0);
      expect(used.staff).toBeGreaterThanOrEqual(1);
      await expect(inTenant((tx) => store.assertSeatFree(tx, 'STAFF'))).resolves.toBeUndefined();
      await admin("update machvon.license_revision set seats = $1 where tenant_id = $2 and status = 'Issued'", [used.staff, TENANT_A]);
      await expect(inTenant((tx) => store.assertSeatFree(tx, 'STAFF'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 403 });
      await admin("update machvon.license_revision set quota_json = '{\"guest_seats\": 0}'::jsonb where tenant_id = $1 and status = 'Issued'", [TENANT_A]);
      await expect(inTenant((tx) => store.assertSeatFree(tx, 'GUEST_CONTRACTOR'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    });
  });

  describe('the seats of the plan', () => {
    const PLAN = '00000000-0000-4000-9000-000000000001';
    let versionNo = 0;

    // The plan of the tenant, as the entitlements say it: one version with the seat quota (null: a plan without it).
    const entitle = async (quota: number | null): Promise<void> => {
      versionNo += 1;
      const features = [
        { featureCode: 'reporting', limitKind: 'BOOLEAN', graceBehavior: 'ALLOW', expiredBehavior: 'READ_ONLY' },
        ...(quota === null ? [] : [{ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: quota, graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' }]),
      ];
      await admin(
        `insert into machvon.entitlement_version (tenant_id, id, version_no, plan_version_id, features_json, entitlements_hash, cause, effective_from)
         values ($1, $2, $3, $4, $5::jsonb, $6, 'SUBSCRIPTION_CHANGE', now())`,
        [TENANT_A, randomUUID(), 1000 + versionNo, PLAN, JSON.stringify(features), String(versionNo).padStart(64, '0')],
      );
    };
    const override = (limit: number | null, status = 'Active', from = "now() - interval '1 hour'", until = "now() + interval '1 day'"): Promise<unknown[]> =>
      admin(
        `insert into machvon.entitlement_override (tenant_id, id, feature_code, enabled, limit_value, reason, valid_from, valid_until, status, requested_by)
         values ($1, $2, 'member.seats', true, $3, 'a reason of ten letters', ${from}, ${until}, $4, $5)`,
        [TENANT_A, randomUUID(), limit, status, ACTOR],
      );
    const clearOverrides = (): Promise<unknown[]> => admin('delete from machvon.entitlement_override where tenant_id = $1', [TENANT_A]);

    beforeAll(async () => {
      await admin('delete from machvon.license_revision where tenant_id = $1', [TENANT_A]);
    });

    afterEach(async () => {
      await clearOverrides();
    });

    it('has no plan limit for a tenant without entitlements, or whose plan has no seat quota', async () => {
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: null, guestSeats: null });
      await entitle(null);
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: null, guestSeats: null });
    });

    it('limits the staff seats to the quota of the latest version of the plan, and a lowered quota applies at once (AC-ST-SAS-010-2)', async () => {
      await entitle(120);
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: 120, guestSeats: null });
      await entitle(100);
      expect(await inTenant((tx) => store.seatLimits(tx))).toEqual({ seats: 100, guestSeats: null });
    });

    it('refuses a further seat when the plan was lowered below the seats in use, and takes nobody away', async () => {
      const used = (await inTenant((tx) => store.seatsInUse(tx))).staff;
      expect(used).toBeGreaterThanOrEqual(1);
      await entitle(used - 1);
      await expect(inTenant((tx) => store.assertSeatFree(tx, 'STAFF'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 403 });
      expect((await inTenant((tx) => store.seatsInUse(tx))).staff).toBe(used);
      await entitle(used + 1);
      await expect(inTenant((tx) => store.assertSeatFree(tx, 'STAFF'))).resolves.toBeUndefined();
      await entitle(used);
      await expect(inTenant((tx) => store.assertSeatFree(tx, 'STAFF'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    });

    it('keeps the plan limit off the guests, who have the seats of the licence only', async () => {
      await entitle(1);
      await expect(inTenant((tx) => store.assertSeatFree(tx, 'GUEST_CONTRACTOR'))).resolves.toBeUndefined();
    });

    it('lets an override in force replace the number of the plan, and ignores one that is not in force', async () => {
      await entitle(5);
      await override(9);
      expect((await inTenant((tx) => store.seatLimits(tx))).seats).toBe(9);
      await clearOverrides();
      await override(9, 'PendingApproval');
      await override(9, 'Revoked');
      await override(9, 'Active', "now() + interval '1 hour'", "now() + interval '2 days'");
      await override(9, 'Active', "now() - interval '2 days'", "now() - interval '1 day'");
      expect((await inTenant((tx) => store.seatLimits(tx))).seats).toBe(5);
    });

    it('takes the override that started last when several are in force, and the plan number when the override names none', async () => {
      await entitle(5);
      await override(7, 'Active', "now() - interval '3 hours'");
      await override(11, 'Active', "now() - interval '1 hour'");
      expect((await inTenant((tx) => store.seatLimits(tx))).seats).toBe(11);
      await clearOverrides();
      await override(null);
      expect((await inTenant((tx) => store.seatLimits(tx))).seats).toBe(5);
    });

    it('uses the lower of the licence and the plan, whichever it is', async () => {
      await entitle(8);
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        // The licence has foreign keys to unrelated rows: the superuser seeds it with them switched off, as the licence tests do.
        await client.query('set session_replication_role = replica');
        await client.query(
          `insert into machvon.license_revision (tenant_id, id, serial, revision, entitlement_version_id, valid_from, valid_until, grace_until, status, signed_claims, key_id, seats, quota_json)
           values ($1, $2, $3, 1, $4, now() - interval '1 day', now() + interval '1 year', now() + interval '2 years', 'Active', 'claims', 'key', 6, '{}'::jsonb)`,
          [TENANT_A, randomUUID(), randomUUID(), randomUUID()],
        );
      } finally {
        await client.end();
      }
      expect((await inTenant((tx) => store.seatLimits(tx))).seats).toBe(6);
      await entitle(4);
      expect((await inTenant((tx) => store.seatLimits(tx))).seats).toBe(4);
    });
  });

  describe('guest contractors', () => {
    const CONTRACTOR = id(0x54, 1);
    const PROJECT = id(0x50, 7);
    const OTHER_PROJECT = id(0x50, 8);
    const CONTRACT_A = id(0x51, 1);
    const CONTRACT_B = id(0x51, 2);
    const CONTRACT_OTHER_UNIT = id(0x51, 3);
    const GUEST = memberId(11);

    beforeAll(async () => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        // Foreign keys to unrelated modules are out of scope here, so the superuser seeds with them switched off.
        await client.query('set session_replication_role = replica');
        await client.query(
          `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
           values ($1, $2, '0100000001', 'Cao Bang Builders', 'VERIFIED', $3)`,
          [TENANT_A, CONTRACTOR, id(0x55, 1)],
        );
        await client.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
           values ($1, $2, 'GP1', 'Guest project 1', $3, $4, 'INTERNAL', 1000, 'CONCEPT', 1), ($1, $5, 'GP2', 'Guest project 2', $6, $4, 'INTERNAL', 1000, 'CONCEPT', 1)`,
          [TENANT_A, PROJECT, unitId(2), id(0x52, 1), OTHER_PROJECT, unitId(1)],
        );
        await client.query(
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, signed_on, effective_from, completion_due, contract_value_vnd)
           values ($1, $2, $5, $6, $7, 'GC-A', 'LUMP_SUM', 'VND', 'ACTIVE', 1, '2026-01-01', '2026-01-01', '2027-03-31', 1000),
                  ($1, $3, $5, $6, $7, 'GC-B', 'LUMP_SUM', 'VND', 'DRAFT', 1, null, null, null, 0),
                  ($1, $4, $8, $6, $7, 'GC-C', 'LUMP_SUM', 'VND', 'ACTIVE', 1, '2026-01-01', '2026-01-01', '2026-12-31', 1000)`,
          [TENANT_A, CONTRACT_A, CONTRACT_B, CONTRACT_OTHER_UNIT, PROJECT, id(0x53, 1), CONTRACTOR, OTHER_PROJECT],
        );
      } finally {
        await client.end();
      }
      await admin(
        `insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, 'sub-guest', 'guest@example.test', 'Guest One', 'Active')`,
        [id(0x60, 11)],
      );
      await admin(
        `insert into machvon.membership (tenant_id, id, user_id, organization_id, status, membership_type, contractor_id, valid_until)
         values ($1, $2, $3, $4, 'Invited', 'GUEST_CONTRACTOR', $5, now() + interval '30 days')`,
        [TENANT_A, GUEST, id(0x60, 11), unitId(2), CONTRACTOR],
      );
    }, 60_000);

    it('finds the latest planned completion among the contracts, and nothing when none of them has one', async () => {
      expect(await inTenant((tx) => store.latestContractEnd(tx, [CONTRACT_A]))).toEqual(new Date('2027-03-31T00:00:00Z'));
      expect(await inTenant((tx) => store.latestContractEnd(tx, [CONTRACT_OTHER_UNIT, CONTRACT_A]))).toEqual(new Date('2027-03-31T00:00:00Z'));
      expect(await inTenant((tx) => store.latestContractEnd(tx, [CONTRACT_B]))).toBeUndefined();
      expect(await inTenant((tx) => store.latestContractEnd(tx, []))).toBeUndefined();
    });

    it('does not see the contracts of another tenant', async () => {
      expect(await inTenant((tx) => store.latestContractEnd(tx, [CONTRACT_A]), TENANT_B)).toBeUndefined();
    });

    describe('contracts in reach', () => {
      const everything = { sql: 'true', params: [] as unknown[] };

      it('lists the contracts with their contractor, project and owner unit in the order of their codes', async () => {
        const rows = await inTenant((tx) => store.contractsInReach(tx, { limit: 10, reach: everything }));
        expect(rows.map((row) => row.code)).toEqual(['GC-A', 'GC-B', 'GC-C']);
        expect(rows[0]).toEqual({
          id: CONTRACT_A,
          code: 'GC-A',
          status: 'ACTIVE',
          contractorId: CONTRACTOR,
          contractorName: 'Cao Bang Builders',
          projectId: PROJECT,
          ownerUnitId: unitId(2),
          completionDue: '2027-03-31',
        });
        expect(rows[1]).toMatchObject({ code: 'GC-B', status: 'DRAFT', completionDue: null });
      });

      it('pages by code and id and stops at the limit', async () => {
        const first = await inTenant((tx) => store.contractsInReach(tx, { limit: 2, reach: everything }));
        expect(first.map((row) => row.code)).toEqual(['GC-A', 'GC-B']);
        const second = await inTenant((tx) => store.contractsInReach(tx, { limit: 2, after: { code: 'GC-B', id: CONTRACT_B }, reach: everything }));
        expect(second.map((row) => row.code)).toEqual(['GC-C']);
      });

      it('keeps to the owner units the reader reaches, and shows nothing without a reach', async () => {
        const reach = { sql: 'starts_with(cu.path, $4)', params: ['/u1/u2/'] };
        expect((await inTenant((tx) => store.contractsInReach(tx, { limit: 10, reach }))).map((row) => row.code)).toEqual(['GC-A', 'GC-B']);
        expect(await inTenant((tx) => store.contractsInReach(tx, { limit: 10, reach: { sql: 'false', params: [] } }))).toEqual([]);
      });

      it('does not list the contracts of another tenant', async () => {
        expect(await inTenant((tx) => store.contractsInReach(tx, { limit: 10, reach: everything }), TENANT_B)).toEqual([]);
      });
    });

    describe('directory details', () => {
      const everything = { sql: 'true', params: [] as unknown[] };
      const grantGuest = async (n: number, contracts: string[], status = 'Active'): Promise<void> => {
        await harness.owner(TENANT_A, [
          [
            `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason, revoked_at)
             values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', 'CONTRACT', $6::uuid[], $7, $8, 'test', case when $7 = 'Revoked' then now() end)`,
            [TENANT_A, grantId(n), GUEST, await roleIdOf('GUEST_CONTRACTOR'), JSON.stringify({ kind: 'CONTRACT', ref_ids: contracts }), contracts, status, ACTOR],
          ],
        ]);
      };

      it('lists roles, the contractor, the contracts and the newest invitation of each membership', async () => {
        await grantGuest(60, [CONTRACT_B, CONTRACT_A]);
        await grantGuest(61, [CONTRACT_OTHER_UNIT], 'Revoked');
        await inTenant((tx) => store.insertInvitation(tx, { membershipId: GUEST, emailHash: 'd'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '3'), invitedBy: ACTOR, expiresAt: new Date(Date.now() + 60_000) }));
        const details = await inTenant((tx) => store.directoryDetails(tx, [GUEST, memberId(1), randomUUID()], everything));
        expect(details.get(GUEST)).toEqual({
          version: 1,
          roleCodes: ['GUEST_CONTRACTOR'],
          invitationStatus: 'Pending',
          contractorId: CONTRACTOR,
          contractorName: 'Cao Bang Builders',
          contracts: [
            { id: CONTRACT_A, code: 'GC-A' },
            { id: CONTRACT_B, code: 'GC-B' },
          ],
        });
        expect(details.get(memberId(1))).toEqual({ version: 1, roleCodes: ['TENANT_OWNER'], invitationStatus: null, contractorId: null, contractorName: null, contracts: [] });
        expect(details.size).toBe(2);
      });

      it('lists only the contracts whose owner unit the reader reaches', async () => {
        await grantGuest(62, [CONTRACT_OTHER_UNIT]);
        const reach = { sql: 'starts_with(cu.path, $2)', params: ['/u1/u2/'] };
        const details = await inTenant((tx) => store.directoryDetails(tx, [GUEST], reach));
        expect(details.get(GUEST)?.contracts.map((contract) => contract.code)).toEqual(['GC-A', 'GC-B']);
        const wide = await inTenant((tx) => store.directoryDetails(tx, [GUEST], everything));
        expect(wide.get(GUEST)?.contracts.map((contract) => contract.code)).toEqual(['GC-A', 'GC-B', 'GC-C']);
        const none = await inTenant((tx) => store.directoryDetails(tx, [GUEST], { sql: 'false', params: [] }));
        expect(none.get(GUEST)?.contracts).toEqual([]);
      });

      it('answers an empty map for no membership', async () => {
        expect((await inTenant((tx) => store.directoryDetails(tx, [], everything))).size).toBe(0);
      });
    });
  });
});
