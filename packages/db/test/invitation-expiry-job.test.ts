import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AuditWriter } from '../src/audit-writer';
import { InvitationExpiryJob } from '../src/invitation-expiry-job';
import { MemberStore } from '../src/member-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new MemberStore();
const ACTOR = memberId(1);
const NOW = new Date();

const inTenant = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, ACTOR), work);

describe('the invitation expiry job (ST-ADM-006)', () => {
  let job: InvitationExpiryJob;
  let counter = 0;

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }, { n: 2, path: '/u1/u2/', parent: 1 }]);
    await harness.seedMembership(TENANT_A, 1, 1);
    job = new InvitationExpiryJob(new AuditWriter(harness.tenants));
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  const admin = async <R extends object>(text: string, params: unknown[] = []): Promise<R[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as R[];
    } finally {
      await client.end();
    }
  };

  /** An invited member whose single invitation ends `minutes` from now (negative: already ended). */
  async function invited(minutes: number): Promise<{ membershipId: string; invitationId: string }> {
    counter += 1;
    const account = await inTenant((tx) => store.ensureInvitedAccount(tx, `expiry-${counter}@example.test`, undefined));
    const member = await inTenant((tx) => store.insertInvitedMember(tx, { userAccountId: account, organizationId: unitId(2), membershipType: 'STAFF', invitedBy: ACTOR }));
    const invitation = await inTenant((tx) =>
      store.insertInvitation(tx, { membershipId: member.id, emailHash: 'a'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '7'), invitedBy: ACTOR, expiresAt: new Date(NOW.getTime() + 60_000) }),
    );
    await admin(`update machvon.membership_invitation set expires_at = now() + ($2 || ' minutes')::interval where id = $1`, [invitation.id, String(minutes)]);
    return { membershipId: member.id, invitationId: invitation.id };
  }

  const statusOf = async (membershipId: string): Promise<{ status: string; version: string }> =>
    (await admin<{ status: string; version: string }>('select status, version::text from machvon.membership where id = $1', [membershipId]))[0] ?? { status: '', version: '' };
  const invitationStatus = async (invitationId: string): Promise<string> => (await admin<{ status: string }>('select status from machvon.membership_invitation where id = $1', [invitationId]))[0]?.status ?? '';
  const events = async (membershipId: string): Promise<number> =>
    Number((await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where type = 'iam.membership.expired.v1' and aggregate_id = $1", [membershipId]))[0]?.n);
  const audits = async (membershipId: string): Promise<Array<{ safe_diff: Record<string, unknown> }>> =>
    admin("select safe_diff from machvon.audit_event where action = 'membership.invitation_expired' and resource_id = $1", [membershipId]);

  it('expires an invitation that ran out and the membership it was for, with one event and one audit row that name no address or token', async () => {
    const lapsed = await invited(-5);
    const result = await inTenant((tx) => job.run(tx, ACTOR, new Date()));
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await statusOf(lapsed.membershipId)).toEqual({ status: 'Expired', version: '2' });
    expect(await invitationStatus(lapsed.invitationId)).toBe('Expired');
    expect(await events(lapsed.membershipId)).toBe(1);
    const trail = await audits(lapsed.membershipId);
    expect(trail).toHaveLength(1);
    expect(JSON.stringify(trail[0]?.safe_diff)).not.toMatch(/example\.test|token/);
  });

  it('leaves an invitation that is still open, and changes nothing when it runs again', async () => {
    const open = await invited(60);
    const lapsed = await invited(-1);
    await inTenant((tx) => job.run(tx, ACTOR, new Date()));
    expect((await statusOf(open.membershipId)).status).toBe('Invited');
    expect(await invitationStatus(open.invitationId)).toBe('Pending');
    expect((await statusOf(lapsed.membershipId)).status).toBe('Expired');
    const again = await inTenant((tx) => job.run(tx, ACTOR, new Date()));
    expect(again.expired).toBe(0);
    expect(await events(lapsed.membershipId)).toBe(1);
  });

  it('keeps the membership when the person was invited again with a live invitation', async () => {
    const lapsed = await invited(-10);
    const second = await inTenant((tx) =>
      store.insertInvitation(tx, { membershipId: lapsed.membershipId, emailHash: 'b'.repeat(64), tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '8'), invitedBy: ACTOR, expiresAt: new Date(NOW.getTime() + 3_600_000) }),
    );
    await inTenant((tx) => job.run(tx, ACTOR, new Date()));
    expect((await statusOf(lapsed.membershipId)).status).toBe('Invited');
    expect(await invitationStatus(second.id)).toBe('Pending');
    expect(await events(lapsed.membershipId)).toBe(0);
  });

  it('leaves alone a membership that is no longer Invited', async () => {
    const accepted = await invited(-30);
    await admin("update machvon.membership set status = 'Active' where id = $1", [accepted.membershipId]);
    await inTenant((tx) => job.run(tx, ACTOR, new Date()));
    expect((await statusOf(accepted.membershipId)).status).toBe('Active');
    expect(await events(accepted.membershipId)).toBe(0);
  });

  it('refuses to run outside a tenant', async () => {
    await expect(harness.tenants.withTenant(contextFor(TENANT_A, ACTOR), async (tx) => {
      await tx.query("select set_config('app.tenant_id', '', true)");
      return job.run(tx, ACTOR, new Date());
    })).rejects.toThrow('outside a tenant');
  });
});
