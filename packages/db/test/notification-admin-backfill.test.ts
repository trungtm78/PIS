import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SYSTEM_ROLES } from '../src/system-roles';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', 'db', 'migrations', 'V1444__not1_notification_admin_template_read.sql'), 'utf8');
const PERMISSION = 'notification_template_version.read';

describe('the notification administrators read the template revisions (ST-NOT-005)', () => {
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

  it('gives the role the read of the template revisions, next to everything it holds under notification.*', () => {
    const role = SYSTEM_ROLES.find((candidate) => candidate.code === 'NOTIFICATION_ADMIN');
    expect(role?.permissions).toEqual(expect.arrayContaining(['notification.*', PERMISSION]));
  });

  it('brings a role seeded before this change up to date in every tenant, once, and leaves the others alone', async () => {
    const insert = (tenant: string, code: string, permissions: string[]) =>
      privileged(
        `insert into machvon.role_definition (tenant_id, id, code, name, is_system, permissions, rank, version, status, created_by) values ($1, gen_random_uuid(), $2, $2, true, $3::text[], 50, 1, 'Active', gen_random_uuid())`,
        [tenant, code, permissions],
      );
    await insert(TENANT_A, 'NOTIFICATION_ADMIN', ['notification.*']);
    await insert(TENANT_B, 'NOTIFICATION_ADMIN', ['notification.*', PERMISSION]);
    await insert(TENANT_B, 'OMNI_SUPERVISOR', ['omni.*']);
    const read = () => privileged<{ tenant_id: string; code: string; permissions: string[]; version: string }>('select tenant_id, code, permissions, version::text as version from machvon.role_definition where code in (\'NOTIFICATION_ADMIN\', \'OMNI_SUPERVISOR\')');
    await privileged(MIGRATION);
    const after = await read();
    const of = (tenant: string, code: string) => after.find((row) => row.tenant_id === tenant && row.code === code);
    expect(of(TENANT_A, 'NOTIFICATION_ADMIN')).toMatchObject({ permissions: ['notification.*', PERMISSION], version: '2' });
    // A role that held it already, and a role of another kind, are not touched, their version included.
    expect(of(TENANT_B, 'NOTIFICATION_ADMIN')).toMatchObject({ permissions: ['notification.*', PERMISSION], version: '1' });
    expect(of(TENANT_B, 'OMNI_SUPERVISOR')).toMatchObject({ permissions: ['omni.*'], version: '1' });
    await privileged(MIGRATION);
    expect(of(TENANT_A, 'NOTIFICATION_ADMIN')).toMatchObject({ version: '2' });
    expect((await read()).find((row) => row.tenant_id === TENANT_A && row.code === 'NOTIFICATION_ADMIN')).toMatchObject({ version: '2' });
  });
});
