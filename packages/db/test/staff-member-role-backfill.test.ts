import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SYSTEM_ROLES } from '../src/system-roles';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from './support/authz-fixtures';

const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', 'db', 'migrations', 'V3042__pwf4_staff_member_role.sql'), 'utf8');
const OWN_READS = ['session.self', 'notification.self', 'pwf.task.work', 'staff_score.read_own', 'approval_task.read', 'pwf.preference.own'];
const OWNER = 1;
const STAFF = 2;
const SUSPENDED_STAFF = 3;
const ENDED_STAFF = 4;
const SERVICE = 5;
const B_STAFF = 7;

describe('every person of the staff reads and does what concerns themselves (PWF 20.9, V3042)', () => {
  const harness = new AuthzHarness();

  async function privileged<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const n of [OWNER, STAFF]) await harness.seedMembership(TENANT_A, n, 2);
    await harness.seedMembership(TENANT_A, SUSPENDED_STAFF, 2, { status: 'Suspended' });
    await harness.seedMembership(TENANT_A, ENDED_STAFF, 2, { status: 'Ended' });
    await harness.seedMembership(TENANT_A, SERVICE, 2);
    await harness.seedMembership(TENANT_B, B_STAFF, 2);
    await privileged("update machvon.membership set membership_type = 'SERVICE_ACCOUNT' where id = $1", [memberId(SERVICE)]);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await privileged(
        `insert into machvon.role_definition (tenant_id, id, code, name, is_system, permissions, rank, version, status, created_by) values ($1, gen_random_uuid(), 'TENANT_OWNER', 'TENANT_OWNER', true, '{}'::text[], 99, 1, 'Active', $2)`,
        [tenant, memberId(OWNER)],
      );
    }
  }, 120_000);
  afterAll(() => harness.stop(), 60_000);

  const grantsOf = (tenant: string) =>
    privileged<{ membership_id: string; scope_kind: string; version: string }>(
      `select g.membership_id, g.scope_kind, m.scope_version::text as version
         from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id join machvon.membership m on m.id = g.membership_id
        where g.tenant_id = $1 and r.code = 'STAFF_MEMBER' and g.status = 'Active' order by g.membership_id`,
      [tenant],
    );

  it('is a role of the system for people of the tenant: own reads only, never for a guest, and no right over anybody else', () => {
    const role = SYSTEM_ROLES.find((candidate) => candidate.code === 'STAFF_MEMBER');
    expect(role).toMatchObject({ rank: 6, guestAllowed: false });
    expect([...(role?.permissions ?? [])].sort()).toEqual([...OWN_READS].sort());
    // Nothing that reads or changes the records of others: no pwf.read, no approval.decide, no staff_score.read_unit, no home.read.
    for (const forbidden of ['pwf.read', 'pwf.task.approve', 'approval.decide', 'staff_score.read_unit', 'staff_score.approve', 'home.read', 'committee.read']) expect(role?.permissions).not.toContain(forbidden);
    // The role that is also the base of the guests does not carry the workflow rights.
    expect(SYSTEM_ROLES.find((candidate) => candidate.code === 'MEMBER')?.permissions).not.toContain('pwf.task.work');
  });

  it('adds the role to a tenant seeded before it, and gives it over the tenant to the staff who are invited, active or suspended: once, to nobody else', async () => {
    await privileged(
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       select $1, gen_random_uuid(), $2, r.id, '{}'::jsonb, now(), 'TENANT', '{}'::uuid[], 'Active', $2, 'earlier'
         from machvon.role_definition r where r.code = 'TENANT_OWNER' and r.tenant_id = $1`,
      [TENANT_A, memberId(OWNER)],
    );
    await privileged(MIGRATION);
    const roles = await privileged<{ tenant_id: string; permissions: string[]; rank: number; guest_allowed: boolean; is_system: boolean }>("select tenant_id, permissions, rank, guest_allowed, is_system from machvon.role_definition where code = 'STAFF_MEMBER' order by tenant_id");
    expect(roles).toHaveLength(2);
    for (const role of roles) expect(role).toMatchObject({ permissions: OWN_READS, rank: 6, guest_allowed: false, is_system: true });

    const grants = await grantsOf(TENANT_A);
    expect(grants.map((grant) => grant.membership_id).sort()).toEqual([memberId(OWNER), memberId(STAFF), memberId(SUSPENDED_STAFF)]
      .sort());
    for (const grant of grants) expect(grant).toMatchObject({ scope_kind: 'TENANT' });
    // A member of the other tenant gets the role of that tenant; the ended staff and a service account get nothing.
    expect((await grantsOf(TENANT_B)).map((grant) => grant.membership_id)).toEqual([memberId(B_STAFF)]);
    const given = new Set([...grants, ...(await grantsOf(TENANT_B))].map((grant) => grant.membership_id));
    expect(given.has(memberId(ENDED_STAFF))).toBe(false);
    expect(given.has(memberId(SERVICE))).toBe(false);
  });

  it('raises the scope version of the people it gave the role to, so the access in cache is read again, and does nothing the second time', async () => {
    const before = await grantsOf(TENANT_A);
    const versionOf = (rows: typeof before, member: number) => Number(rows.find((row) => row.membership_id === memberId(member))?.version);
    await privileged(MIGRATION);
    const after = await grantsOf(TENANT_A);
    expect(after).toHaveLength(before.length);
    for (const member of [STAFF, SUSPENDED_STAFF]) expect(versionOf(after, member)).toBe(versionOf(before, member));
    expect(versionOf(before, STAFF)).toBeGreaterThan(1);
  });
});
