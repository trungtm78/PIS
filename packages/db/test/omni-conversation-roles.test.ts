import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SYSTEM_ROLES } from '../src/system-roles';
import { AuthzHarness, TENANT_A, TENANT_B } from './support/authz-fixtures';

const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', 'db', 'migrations', 'V1288__omni1_conversation_roles.sql'), 'utf8');
const READS = ['conversation.read', 'channel_message.read'];
const AGENT_NEW = ['omni.conversation.reply', 'omni.conversation.convert', ...READS];
const SUPERVISOR_NEW = [...READS, 'adm.integration.read', 'adm.integration.operate'];

describe('the omnichannel roles read the conversations (ST-OMNI-004, V1288, OMNI.md 2)', () => {
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

  it('gives the agent the answer and the conversion but not the assignment, and the supervisor the reads and the inbox of the webhooks', () => {
    const agent = SYSTEM_ROLES.find((candidate) => candidate.code === 'OMNI_AGENT')?.permissions ?? [];
    expect(agent).toEqual(expect.arrayContaining(AGENT_NEW));
    // `omni.conversation.*` carries the assignment too: assigning is the supervisor's (OMNI.md 3.2).
    expect(agent).not.toContain('omni.conversation.*');
    expect(agent).not.toContain('omni.conversation.assign');
    const supervisor = SYSTEM_ROLES.find((candidate) => candidate.code === 'OMNI_SUPERVISOR')?.permissions ?? [];
    expect(supervisor).toEqual(expect.arrayContaining(['omni.*', ...SUPERVISOR_NEW]));
  });

  it('brings roles seeded before this change up to date in every tenant, once, and leaves the others alone', async () => {
    const insert = (tenant: string, code: string, permissions: string[]) =>
      privileged(
        `insert into machvon.role_definition (tenant_id, id, code, name, is_system, permissions, rank, version, status, created_by) values ($1, gen_random_uuid(), $2, $2, true, $3::text[], 50, 1, 'Active', gen_random_uuid())`,
        [tenant, code, permissions],
      );
    await insert(TENANT_A, 'OMNI_AGENT', ['omni.conversation.*', 'omni.contact.manage', 'contact.read']);
    await insert(TENANT_A, 'OMNI_SUPERVISOR', ['omni.*', 'channel_account.read']);
    await insert(TENANT_B, 'OMNI_AGENT', ['omni.contact.manage', ...AGENT_NEW]);
    await insert(TENANT_B, 'OMNI_SUPERVISOR', ['omni.*', ...SUPERVISOR_NEW]);
    await insert(TENANT_B, 'NOTIFICATION_ADMIN', ['notification.*']);
    const read = () =>
      privileged<{ tenant_id: string; code: string; permissions: string[]; version: string }>(
        "select tenant_id, code, permissions, version::text as version from machvon.role_definition where code in ('NOTIFICATION_ADMIN', 'OMNI_AGENT', 'OMNI_SUPERVISOR')",
      );
    const of = (rows: Awaited<ReturnType<typeof read>>, tenant: string, code: string) => rows.find((row) => row.tenant_id === tenant && row.code === code);
    await privileged(MIGRATION);
    const after = await read();
    // The wildcard is replaced by the two it was meant to give; what the role held besides is kept.
    const agent = of(after, TENANT_A, 'OMNI_AGENT');
    expect(agent?.version).toBe('2');
    expect(agent?.permissions).toEqual(expect.arrayContaining(['omni.contact.manage', 'contact.read', ...AGENT_NEW]));
    expect(agent?.permissions).not.toContain('omni.conversation.*');
    const supervisor = of(after, TENANT_A, 'OMNI_SUPERVISOR');
    expect(supervisor?.version).toBe('2');
    expect(supervisor?.permissions).toEqual(expect.arrayContaining(['omni.*', 'channel_account.read', ...SUPERVISOR_NEW]));
    // A role that holds them already, and a role of another kind, are not touched, their version included.
    expect(of(after, TENANT_B, 'OMNI_AGENT')).toMatchObject({ version: '1' });
    expect(of(after, TENANT_B, 'OMNI_SUPERVISOR')).toMatchObject({ version: '1' });
    expect(of(after, TENANT_B, 'NOTIFICATION_ADMIN')).toMatchObject({ permissions: ['notification.*'], version: '1' });
    await privileged(MIGRATION);
    const again = await read();
    expect(of(again, TENANT_A, 'OMNI_AGENT')?.version).toBe('2');
    expect(of(again, TENANT_A, 'OMNI_SUPERVISOR')?.version).toBe('2');
  });
});
