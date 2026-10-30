import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SYSTEM_ROLES } from '../src/system-roles';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', 'db', 'migrations', 'V1281__omni1_supervisor_channel_account_read.sql'), 'utf8');
const PERMISSION = 'channel_account.read';

describe('the omnichannel supervisors read the channel accounts (ST-OMNI-001)', () => {
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

  it('gives the role the read of the channel accounts, next to everything it holds under omni.*', () => {
    const role = SYSTEM_ROLES.find((candidate) => candidate.code === 'OMNI_SUPERVISOR');
    expect(role?.permissions).toEqual(expect.arrayContaining(['omni.*', PERMISSION]));
    // The agents answer conversations; they do not look at the accounts.
    expect(SYSTEM_ROLES.find((candidate) => candidate.code === 'OMNI_AGENT')?.permissions).not.toContain(PERMISSION);
  });

  it('brings a role seeded before this change up to date in every tenant, once, and leaves the others alone', async () => {
    const insert = (tenant: string, code: string, permissions: string[]) =>
      privileged(
        `insert into machvon.role_definition (tenant_id, id, code, name, is_system, permissions, rank, version, status, created_by) values ($1, gen_random_uuid(), $2, $2, true, $3::text[], 50, 1, 'Active', gen_random_uuid())`,
        [tenant, code, permissions],
      );
    await insert(TENANT_A, 'OMNI_SUPERVISOR', ['omni.*']);
    await insert(TENANT_B, 'OMNI_SUPERVISOR', ['omni.*', PERMISSION]);
    await insert(TENANT_B, 'NOTIFICATION_ADMIN', ['notification.*']);
    const read = () => privileged<{ tenant_id: string; code: string; permissions: string[]; version: string }>("select tenant_id, code, permissions, version::text as version from machvon.role_definition where code in ('NOTIFICATION_ADMIN', 'OMNI_SUPERVISOR')");
    await privileged(MIGRATION);
    const of = (rows: Awaited<ReturnType<typeof read>>, tenant: string, code: string) => rows.find((row) => row.tenant_id === tenant && row.code === code);
    const after = await read();
    expect(of(after, TENANT_A, 'OMNI_SUPERVISOR')).toMatchObject({ permissions: ['omni.*', PERMISSION], version: '2' });
    // A role that held it already, and a role of another kind, are not touched, their version included.
    expect(of(after, TENANT_B, 'OMNI_SUPERVISOR')).toMatchObject({ permissions: ['omni.*', PERMISSION], version: '1' });
    expect(of(after, TENANT_B, 'NOTIFICATION_ADMIN')).toMatchObject({ permissions: ['notification.*'], version: '1' });
    await privileged(MIGRATION);
    expect(of(await read(), TENANT_A, 'OMNI_SUPERVISOR')).toMatchObject({ version: '2' });
  });
});
