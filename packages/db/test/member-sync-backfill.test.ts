import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SYSTEM_ROLES } from '../src/system-roles';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', 'db', 'migrations', 'V1101__mob1_member_sync_permissions.sql'), 'utf8');
const PERMISSIONS = ['sync.submit', 'sync.upload'];

describe('every member’s phone sends its queued commands and uploads (ST-MOB-005, ST-MOB-009)', () => {
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
  }, 120_000);
  afterAll(() => harness.stop(), 60_000);

  it('gives the role MEMBER the two sync permissions, and no other role', () => {
    expect(SYSTEM_ROLES.find((candidate) => candidate.code === 'MEMBER')?.permissions).toEqual(expect.arrayContaining(PERMISSIONS));
    for (const role of SYSTEM_ROLES.filter((candidate) => candidate.code !== 'MEMBER' && candidate.code !== 'TENANT_OWNER')) {
      for (const permission of PERMISSIONS) expect(role.permissions).not.toContain(permission);
    }
  });

  it('brings a role seeded before this change up to date in every tenant, once, and leaves the others alone', async () => {
    const insert = (tenant: string, code: string, permissions: string[]) =>
      privileged(
        `insert into machvon.role_definition (tenant_id, id, code, name, is_system, permissions, rank, version, status, created_by) values ($1, gen_random_uuid(), $2, $2, true, $3::text[], 5, 1, 'Active', gen_random_uuid())`,
        [tenant, code, permissions],
      );
    await insert(TENANT_A, 'MEMBER', ['notification.self']);
    await insert(TENANT_B, 'MEMBER', ['notification.self', ...PERMISSIONS]);
    await insert(TENANT_B, 'AUDITOR', ['audit.read']);
    const read = () => privileged<{ tenant_id: string; code: string; permissions: string[]; version: string }>("select tenant_id, code, permissions, version::text as version from machvon.role_definition where code in ('MEMBER', 'AUDITOR')");
    await privileged(MIGRATION);
    const of = (rows: Awaited<ReturnType<typeof read>>, tenant: string, code: string) => rows.find((row) => row.tenant_id === tenant && row.code === code);
    const after = await read();
    expect(of(after, TENANT_A, 'MEMBER')).toMatchObject({ permissions: ['notification.self', ...PERMISSIONS], version: '2' });
    // A role that held them already, and a role of another kind, are not touched, their version included.
    expect(of(after, TENANT_B, 'MEMBER')).toMatchObject({ permissions: ['notification.self', ...PERMISSIONS], version: '1' });
    expect(of(after, TENANT_B, 'AUDITOR')).toMatchObject({ permissions: ['audit.read'], version: '1' });
    await privileged(MIGRATION);
    expect(of(await read(), TENANT_A, 'MEMBER')).toMatchObject({ version: '2' });
  });
});
