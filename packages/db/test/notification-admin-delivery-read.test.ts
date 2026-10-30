import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SYSTEM_ROLES } from '../src/system-roles';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', 'db', 'migrations', 'V1446__not1_notification_admin_delivery_read.sql'), 'utf8');
const PERMISSIONS = ['delivery_attempt.read', 'channel_account.read'];

describe('the notification administrators read the delivery attempts and the channel accounts (ST-NOT-010)', () => {
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

  it('gives the role the two reads next to everything it holds under notification.*, and no other role of the notification side', () => {
    expect(SYSTEM_ROLES.find((candidate) => candidate.code === 'NOTIFICATION_ADMIN')?.permissions).toEqual(expect.arrayContaining(['notification.*', ...PERMISSIONS]));
    expect(SYSTEM_ROLES.find((candidate) => candidate.code === 'OMNI_AGENT')?.permissions).not.toContain('delivery_attempt.read');
  });

  it('brings a role seeded before this change up to date in every tenant, once, and leaves the others alone', async () => {
    const insert = (tenant: string, code: string, permissions: string[]) =>
      privileged(
        `insert into machvon.role_definition (tenant_id, id, code, name, is_system, permissions, rank, version, status, created_by) values ($1, gen_random_uuid(), $2, $2, true, $3::text[], 50, 1, 'Active', gen_random_uuid())`,
        [tenant, code, permissions],
      );
    await insert(TENANT_A, 'NOTIFICATION_ADMIN', ['notification.*', 'delivery_attempt.read']);
    await insert(TENANT_B, 'NOTIFICATION_ADMIN', ['notification.*', ...PERMISSIONS]);
    await insert(TENANT_B, 'AUDITOR', ['audit.read']);
    const read = () => privileged<{ tenant_id: string; code: string; permissions: string[]; version: string }>("select tenant_id, code, permissions, version::text as version from machvon.role_definition where code in ('NOTIFICATION_ADMIN', 'AUDITOR')");
    await privileged(MIGRATION);
    const of = (rows: Awaited<ReturnType<typeof read>>, tenant: string, code: string) => rows.find((row) => row.tenant_id === tenant && row.code === code);
    const after = await read();
    // Only the permission the role lacked is added.
    expect(of(after, TENANT_A, 'NOTIFICATION_ADMIN')).toMatchObject({ permissions: ['notification.*', 'delivery_attempt.read', 'channel_account.read'], version: '2' });
    expect(of(after, TENANT_B, 'NOTIFICATION_ADMIN')).toMatchObject({ permissions: ['notification.*', ...PERMISSIONS], version: '1' });
    expect(of(after, TENANT_B, 'AUDITOR')).toMatchObject({ permissions: ['audit.read'], version: '1' });
    await privileged(MIGRATION);
    expect(of(await read(), TENANT_A, 'NOTIFICATION_ADMIN')).toMatchObject({ version: '2' });
  });
});
