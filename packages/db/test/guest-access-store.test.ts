import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { GuestAccessStore } from '../src/guest-access-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new GuestAccessStore();
const ACTOR = memberId(1);
const CONTRACTOR = id(0x54, 1);
const CONTRACT_A = id(0x53, 11);
const CONTRACT_B = id(0x53, 12);
const CONTRACT_C = id(0x53, 13);
const GUEST_ROLE = 1;
const MEMBER_ROLE = 2;

const inTenant = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, ACTOR), work);

describe('GuestAccessStore (ST-ADM-007, BR-IAM-08)', () => {
  let counter = 100;

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    await harness.seedMembership(TENANT_A, 1, 1);
    await harness.seedRole(TENANT_A, GUEST_ROLE, 'GUEST_CONTRACTOR', ['contract.read'], 10);
    await harness.seedRole(TENANT_A, MEMBER_ROLE, 'MEMBER', ['session.read'], 5);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  const admin = async <R extends object>(text: string, params: unknown[] = [], replica = false): Promise<R[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      if (replica) await client.query('set session_replication_role = replica');
      return (await client.query(text, params)).rows as R[];
    } finally {
      await client.end();
    }
  };

  /** A guest of the contractor with the two grants an invitation gives (the role and the baseline), both on the contracts named. */
  async function guest(contracts: readonly string[], options: { staff?: boolean } = {}): Promise<number> {
    counter += 1;
    const n = counter;
    await harness.seedMembership(TENANT_A, n, 1, { validUntil: '2030-01-01T00:00:00Z' });
    if (options.staff !== true) {
      await admin(`update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2 where id = $1`, [memberId(n), CONTRACTOR], true);
    }
    await harness.seedGrants(TENANT_A, [
      { n: n * 10, member: n, role: GUEST_ROLE, kind: 'CONTRACT', refs: contracts },
      { n: n * 10 + 1, member: n, role: MEMBER_ROLE, kind: 'CONTRACT', refs: contracts },
    ]);
    return n;
  }

  const grantsOf = (n: number) =>
    admin<{ id: string; status: string; scope_ref_ids: string[]; scope_json: { ref_ids: string[] }; version: string }>(
      'select id, status, scope_ref_ids::text[] as scope_ref_ids, scope_json, version::text as version from machvon.role_grant where membership_id = $1 order by id',
      [memberId(n)],
    );
  const statusOf = async (n: number): Promise<string> => (await admin<{ status: string }>('select status from machvon.membership where id = $1', [memberId(n)]))[0]?.status ?? '';

  it('expires the grants that name only the closed contract and ends the guest who has none left', async () => {
    const n = await guest([CONTRACT_A]);
    const change = await inTenant((tx) => store.endContractAccess(tx, CONTRACT_A, 'The last contract of the guest has ended.'));
    const mine = change.grants.filter((grant) => grant.membershipId === memberId(n));
    expect(mine.map((grant) => grant.outcome)).toEqual(['Expired', 'Expired']);
    expect(change.endedMembershipIds).toContain(memberId(n));
    expect((await grantsOf(n)).map((grant) => grant.status)).toEqual(['Expired', 'Expired']);
    expect(await statusOf(n)).toBe('Ended');
    const [row] = await admin<{ ended_reason: string }>('select ended_reason from machvon.membership where id = $1', [memberId(n)]);
    expect(row?.ended_reason).toBe('The last contract of the guest has ended.');
  });

  it('narrows a grant that covers other contracts too and keeps the guest', async () => {
    const n = await guest([CONTRACT_B, CONTRACT_C]);
    const before = (await grantsOf(n)).map((grant) => Number(grant.version));
    const change = await inTenant((tx) => store.endContractAccess(tx, CONTRACT_B, 'ended'));
    expect(change.grants.filter((grant) => grant.membershipId === memberId(n)).map((grant) => [grant.outcome, grant.remaining])).toEqual([
      ['Narrowed', [CONTRACT_C]],
      ['Narrowed', [CONTRACT_C]],
    ]);
    const after = await grantsOf(n);
    expect(after.map((grant) => grant.status)).toEqual(['Active', 'Active']);
    expect(after.every((grant) => grant.scope_ref_ids.length === 1 && grant.scope_ref_ids[0] === CONTRACT_C && grant.scope_json.ref_ids[0] === CONTRACT_C)).toBe(true);
    expect(after.map((grant) => Number(grant.version))).toEqual(before.map((version) => version + 1));
    expect(change.endedMembershipIds).not.toContain(memberId(n));
    expect(await statusOf(n)).toBe('Active');
    // The last contract then ends the rest.
    const last = await inTenant((tx) => store.endContractAccess(tx, CONTRACT_C, 'ended'));
    expect(last.endedMembershipIds).toContain(memberId(n));
    expect(await statusOf(n)).toBe('Ended');
  });

  it('does nothing for a contract no guest holds, for a second call, and for staff who hold a grant on the contract', async () => {
    const staff = await guest([randomUUID()], { staff: true });
    const unrelated = await inTenant((tx) => store.endContractAccess(tx, randomUUID(), 'ended'));
    expect(unrelated).toEqual({ grants: [], endedMembershipIds: [] });
    const [staffRef] = (await grantsOf(staff))[0]?.scope_ref_ids ?? [];
    const touched = await inTenant((tx) => store.endContractAccess(tx, staffRef ?? randomUUID(), 'ended'));
    expect(touched).toEqual({ grants: [], endedMembershipIds: [] });
    expect((await grantsOf(staff)).map((grant) => grant.status)).toEqual(['Active', 'Active']);
    const once = await guest([randomUUID()]);
    const [guestRef] = (await grantsOf(once))[0]?.scope_ref_ids ?? [];
    await inTenant((tx) => store.endContractAccess(tx, guestRef ?? randomUUID(), 'ended'));
    expect(await inTenant((tx) => store.endContractAccess(tx, guestRef ?? randomUUID(), 'ended'))).toEqual({ grants: [], endedMembershipIds: [] });
  });

  it('leaves a guest who was already ended, and one whose other grant is still live, as they are', async () => {
    const ended = await guest([randomUUID()]);
    const [ref] = (await grantsOf(ended))[0]?.scope_ref_ids ?? [];
    await admin("update machvon.membership set status = 'Ended' where id = $1", [memberId(ended)]);
    const change = await inTenant((tx) => store.endContractAccess(tx, ref ?? randomUUID(), 'ended'));
    expect(change.endedMembershipIds).toEqual([]);
    expect(await statusOf(ended)).toBe('Ended');

    const mixed = await guest([randomUUID()]);
    const [mixedRef] = (await grantsOf(mixed))[0]?.scope_ref_ids ?? [];
    await harness.seedGrants(TENANT_A, [{ n: mixed * 10 + 5, member: mixed, role: MEMBER_ROLE, kind: 'UNIT_ONLY', refs: [id(0x50, 1)] }]);
    const kept = await inTenant((tx) => store.endContractAccess(tx, mixedRef ?? randomUUID(), 'ended'));
    expect(kept.endedMembershipIds).toEqual([]);
    expect(await statusOf(mixed)).toBe('Active');
  });
});
