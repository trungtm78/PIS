import { resolve } from 'node:path';
import { Client } from 'pg';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import type { MachvonRole, TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT = '00000000-0000-4000-8000-00000000000a';
const ACTOR = '00000000-0000-4000-8000-0000000000f1';
const UNIT = '00000000-0000-4000-8000-0000000000a1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000b1';
const ROLE = '00000000-0000-4000-8000-0000000000c1';
const GRANT = '00000000-0000-4000-8000-0000000000d1';

async function session(url: string, tenantId: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
  return client;
}

async function failureCode(client: Client, text: string): Promise<string | undefined> {
  try {
    await client.query(text);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const insertRole = (id: string, code: string, rank: number, isSystem: boolean, permissions = "'{iam.unit.manage}'"): string =>
  `insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, status, created_by)
   values ('${TENANT}', '${id}', '${code}', 'n', ${permissions}, ${rank}, ${isSystem}, 'Active', '${ACTOR}')`;

describe('migration V004 authorization core', () => {
  let database: TestDatabase;
  const urlFor = (role: MachvonRole): string => database.urlFor(role);

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    const owner = await session(urlFor('machvon_owner'), TENANT);
    try {
      await owner.query(
        `insert into machvon.organization_unit (tenant_id, id, code, name, valid_from) values ('${TENANT}', '${UNIT}', 'ROOT', 'Root', date '2026-01-01')`,
      );
      await owner.query(
        `insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ('${ACTOR}', 'sub-1', 'a@example.test', 'A', 'Active')`,
      );
      await owner.query(
        `insert into machvon.membership (tenant_id, id, user_id, organization_id, status) values ('${TENANT}', '${MEMBERSHIP}', '${ACTOR}', '${UNIT}', 'Active')`,
      );
      await owner.query(insertRole(ROLE, 'SEEDED', 70, true));
      await owner.query(
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, granted_by, grant_reason, scope_kind, scope_ref_ids)
         values ('${TENANT}', '${GRANT}', '${MEMBERSHIP}', '${ROLE}', '{}', now(), '${ACTOR}', 'seed', 'UNIT_ONLY', array['${UNIT}']::uuid[])`,
      );
    } finally {
      await owner.end();
    }
  }, 180_000);

  afterAll(async () => {
    if (database) await database.stop();
  }, 60_000);

  it('adds membership.scope_version with default 1', async () => {
    const owner = await session(urlFor('machvon_owner'), TENANT);
    try {
      const { rows } = await owner.query<{ scope_version: string }>(`select scope_version::text from machvon.membership where id = '${MEMBERSHIP}'`);
      expect(rows).toEqual([{ scope_version: '1' }]);
    } finally {
      await owner.end();
    }
  });

  it('refuses DELETE and TRUNCATE on role_grant for the application role, even a superuser, but not for the owner', async () => {
    const app = await session(urlFor('machvon_app'), TENANT);
    const admin = await session(database.adminUrl, TENANT);
    try {
      expect(await failureCode(app, 'delete from machvon.role_grant')).toBe('42501');
      expect(await failureCode(app, 'truncate machvon.role_grant')).toBe('42501');
      expect(await failureCode(admin, 'delete from machvon.role_grant')).toBe('42501');
      // The period scope of IAM-2 refers to role_grant, so a plain TRUNCATE is refused earlier (0A000); with CASCADE the statement reaches the guard of the table itself.
      expect(await failureCode(admin, 'truncate machvon.role_grant')).toBe('0A000');
      expect(await failureCode(admin, 'truncate machvon.role_grant cascade')).toBe('42501');
      // A revoked grant stays: the application may still update it.
      expect(await failureCode(app, `update machvon.role_grant set version = version + 1 where id = '${GRANT}'`)).toBeUndefined();
    } finally {
      await app.end();
      await admin.end();
    }
    const owner = await session(urlFor('machvon_owner'), TENANT);
    try {
      expect(await failureCode(owner, `delete from machvon.role_grant where id = '${GRANT}'`)).toBeUndefined();
    } finally {
      await owner.end();
    }
  });

  it('limits custom roles to rank 89 while system roles may use 90 to 99', async () => {
    const owner = await session(urlFor('machvon_owner'), TENANT);
    try {
      expect(await failureCode(owner, insertRole('00000000-0000-4000-8000-0000000000c2', 'CUSTOM95', 95, false))).toBe('23514');
      expect(await failureCode(owner, insertRole('00000000-0000-4000-8000-0000000000c3', 'CUSTOM89', 89, false))).toBeUndefined();
      expect(await failureCode(owner, insertRole('00000000-0000-4000-8000-0000000000c4', 'SYS99', 99, true))).toBeUndefined();
    } finally {
      await owner.end();
    }
  });

  it('keeps refusing system permissions in a role', async () => {
    const owner = await session(urlFor('machvon_owner'), TENANT);
    try {
      expect(
        await failureCode(owner, insertRole('00000000-0000-4000-8000-0000000000c5', 'BADPERM', 40, false, "'{iam.unit.manage,system.tenant.manage}'")),
      ).toBe('23514');
    } finally {
      await owner.end();
    }
  });

  it('indexes active grants per membership and scope reference ids', async () => {
    const admin = await session(database.adminUrl, TENANT);
    try {
      const { rows } = await admin.query<{ indexname: string; indexdef: string }>(
        "select indexname, indexdef from pg_indexes where schemaname = 'machvon' and tablename = 'role_grant'",
      );
      const membership = rows.find((row) => row.indexname === 'role_grant_membership_idx');
      expect(membership?.indexdef).toMatch(/\(tenant_id, membership_id\)/);
      expect(membership?.indexdef).toMatch(/WHERE .*Active/);
      expect(rows.some((row) => /USING gin \(scope_ref_ids\)/.test(row.indexdef))).toBe(true);
    } finally {
      await admin.end();
    }
  });
});
