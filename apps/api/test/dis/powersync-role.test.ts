import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DIS_SYNC_TABLES } from '@machvon/contracts';
import { AuthzHarness } from '../../../../packages/db/test/support/authz-fixtures';

const ROOT_DIR = join(__dirname, '..', '..', '..', '..');
const ROLE_SQL = readFileSync(join(ROOT_DIR, 'infra', 'powersync', 'role.sql'), 'utf8');
const SCOPE_TABLE = 'sync_membership_scope';
/** Every privilege PostgreSQL knows on a table: the role may hold SELECT and none of the others. */
const OTHER_TABLE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** The login of the PowerSync service (ST-KERNEL-045): it replicates and reads what the sync contract publishes, and nothing else. */
describe('the replication role machvon_sync (ST-KERNEL-045)', () => {
  const harness = new AuthzHarness();
  let admin: Client;

  const rows = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await admin.query(sql, params)).rows as T[];
  const published = async (): Promise<string[]> =>
    (await rows<{ tablename: string }>("select tablename from pg_publication_tables where pubname = 'powersync' and schemaname = 'machvon' order by tablename")).map((row) => row.tablename);
  const readable = async (privilege: string): Promise<string[]> =>
    (
      await rows<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'machvon' and c.relkind in ('r', 'p') and has_table_privilege('machvon_sync', c.oid, $1) order by c.relname`,
        [privilege],
      )
    ).map((row) => row.relname);

  beforeAll(async () => {
    await harness.start();
    admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    await admin.query(ROLE_SQL);
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await harness.stop();
  }, 60_000);

  it('AC-ST-KERNEL-045-3 UAT-AC500: has REPLICATION, is neither a superuser nor able to bypass row-level security, and inherits nothing from another role', async () => {
    const [role] = await rows<Record<string, boolean>>(
      "select rolreplication, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname = 'machvon_sync'",
    );
    expect(role).toEqual({ rolreplication: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true });
    expect(await rows("select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'machvon_sync'")).toEqual([]);
  });

  it('AC-ST-KERNEL-045-3 UAT-AC500: has SELECT on every table of the publication powersync and on no other table', async () => {
    const tables = await published();
    expect(tables.length).toBeGreaterThan(0);
    expect(await readable('SELECT')).toEqual(tables);
  });

  it('AC-ST-KERNEL-045-3 UAT-AC500: holds no other privilege on any table, column, sequence, the schema or the database', async () => {
    for (const privilege of OTHER_TABLE_PRIVILEGES) expect(await readable(privilege)).toEqual([]);
    expect(
      await rows(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'machvon' and c.relkind in ('r', 'p') and not (c.relname = any($1::text[]))
            and has_any_column_privilege('machvon_sync', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')`,
        [await published()],
      ),
    ).toEqual([]);
    expect(await rows("select sequencename from pg_sequences where schemaname = 'machvon' and has_sequence_privilege('machvon_sync', format('%I.%I', schemaname, sequencename), 'USAGE, SELECT, UPDATE')")).toEqual([]);
    expect(await rows("select has_schema_privilege('machvon_sync', 'machvon', 'CREATE') as can_create")).toEqual([{ can_create: false }]);
    expect(await rows("select has_database_privilege('machvon_sync', current_database(), 'CREATE') as can_create")).toEqual([{ can_create: false }]);
  });

  it('AC-ST-KERNEL-045-3 UAT-AC500: publishes the tables of the sync contract and the scope table of the bucket parameters, and none of the tables that must not reach a phone', async () => {
    const contract = DIS_SYNC_TABLES.map((entry) => entry.table);
    expect(await published()).toEqual([...contract, SCOPE_TABLE].sort());
    for (const forbidden of ['period_snapshot_line', 'user_account', 'tenant', 'membership', 'audit_event']) expect(await readable('SELECT')).not.toContain(forbidden);
  });

  it('AC-ST-KERNEL-045-3 UAT-AC500: running the script again leaves the same privileges, and takes back a privilege that crept onto a table outside the publication', async () => {
    const before = { published: await published(), select: await readable('SELECT') };
    await admin.query('grant select, update on machvon.audit_event to machvon_sync');
    expect(await readable('SELECT')).toContain('audit_event');
    await admin.query(ROLE_SQL);
    expect({ published: await published(), select: await readable('SELECT') }).toEqual(before);
    expect(await readable('UPDATE')).toEqual([]);
  });
});
