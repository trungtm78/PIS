import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { MIGRATIONS_DIR, loadCommittedMigrations } from '../src/generate-migrations';
import { MigrationChecksumError, migrate } from '../src/migrate';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import type { MachvonRole, TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const ACTOR = '00000000-0000-4000-8000-0000000000f1';
const ROW_ID = '00000000-0000-4000-8000-0000000000e1';
const SEAL_ID = '00000000-0000-4000-8000-0000000000d1';
const OUTBOX_A = '00000000-0000-4000-8000-0000000000c1';
const OUTBOX_B = '00000000-0000-4000-8000-0000000000c2';

async function session(url: string, tenantId?: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  if (tenantId !== undefined) await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
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

describe('migration V003 platform services', () => {
  let database: TestDatabase;
  const urlFor = (role: MachvonRole): string => database.urlFor(role);

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    const owner = await session(urlFor('machvon_owner'), TENANT_A);
    try {
      await owner.query(
        `insert into machvon.audit_event (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, correlation_id, request_id, occurred_at)
         values ($1, $2, $3, 'seed', 'seed', $2, '{}', $2, $2, now())`,
        [TENANT_A, ROW_ID, ACTOR],
      );
      await owner.query(
        `insert into machvon.audit_seal (tenant_id, id, from_seq, to_seq, merkle_root, seal_hash)
         values ($1, $2, 1, 1, repeat('a', 64), repeat('b', 64))`,
        [TENANT_A, SEAL_ID],
      );
      for (const [tenant, id] of [[TENANT_A, OUTBOX_A], [TENANT_B, OUTBOX_B]] as const) {
        await owner.query("select set_config('app.tenant_id', $1, false)", [tenant]);
        await owner.query(
          `insert into machvon.outbox_event (tenant_id, id, aggregate_id, type, schema_version, payload, created_at, aggregate_type, aggregate_version, event_key, correlation_id)
           values ($1, $2::uuid, $2::uuid, 'seed', 1, '{}', now(), 'seed', 1, $2::uuid::text, $2::uuid)`,
          [tenant, id],
        );
      }
    } finally {
      await owner.end();
    }
  }, 180_000);

  afterAll(async () => {
    if (database) await database.stop();
  }, 60_000);

  describe.each(['audit_event', 'audit_seal'])('%s is append-only', (table) => {
    it('lets the application role INSERT and SELECT but not UPDATE, DELETE or TRUNCATE (AC-ST-KERNEL-023-1)', async () => {
      const app = await session(urlFor('machvon_app'), TENANT_A);
      try {
        expect(await failureCode(app, `select count(*) from machvon.${table}`)).toBeUndefined();
        expect(await failureCode(app, `update machvon.${table} set tenant_id = tenant_id`)).toBe('42501');
        expect(await failureCode(app, `delete from machvon.${table}`)).toBe('42501');
        expect(await failureCode(app, `truncate machvon.${table}`)).toBe('42501');
      } finally {
        await app.end();
      }
    });

    it('rejects UPDATE, DELETE and TRUNCATE from every role but the owner, even a superuser', async () => {
      const admin = await session(database.adminUrl, TENANT_A);
      try {
        expect(await failureCode(admin, `update machvon.${table} set tenant_id = tenant_id`)).toBe('42501');
        expect(await failureCode(admin, `delete from machvon.${table}`)).toBe('42501');
        // audit_event is referenced by audit_event_detail (ENT-4e): a plain TRUNCATE is refused by the engine (0A000) before the trigger runs.
        expect(await failureCode(admin, `truncate machvon.${table}`)).toBe(table === 'audit_event' ? '0A000' : '42501');
        // With CASCADE the engine lets it through to the BEFORE TRUNCATE trigger, which is the guard that the superuser meets.
        expect(await failureCode(admin, `truncate machvon.${table} cascade`)).toBe('42501');
      } finally {
        await admin.end();
      }
    });
  });

  it('lets the application role append audit rows and seals', async () => {
    const app = await session(urlFor('machvon_app'), TENANT_B);
    try {
      expect(
        await failureCode(
          app,
          `insert into machvon.audit_event (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, correlation_id, request_id, occurred_at)
           values ('${TENANT_B}', '${OUTBOX_B}', '${ACTOR}', 'a', 'r', '${OUTBOX_B}', '{}', '${OUTBOX_B}', '${OUTBOX_B}', now())`,
        ),
      ).toBeUndefined();
    } finally {
      await app.end();
    }
  });

  it('lets the owner edit a row, which the tamper drill depends on', async () => {
    const owner = await session(urlFor('machvon_owner'), TENANT_A);
    try {
      expect(await failureCode(owner, `update machvon.audit_event set action = 'tampered' where id = '${ROW_ID}'`)).toBeUndefined();
      expect(await failureCode(owner, `update machvon.audit_event set action = 'seed' where id = '${ROW_ID}'`)).toBeUndefined();
    } finally {
      await owner.end();
    }
  });

  it('gives the relay role SELECT and UPDATE on outbox_event of every tenant, and nothing else', async () => {
    const relay = await session(urlFor('machvon_outbox_relay'));
    try {
      const { rows } = await relay.query<{ id: string }>('select id from machvon.outbox_event order by id');
      expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([OUTBOX_A, OUTBOX_B]));
      expect((await relay.query("update machvon.outbox_event set status = 'PUBLISHED' where status = 'PENDING' and id = $1", [OUTBOX_A])).rowCount).toBe(1);
      expect((await relay.query("update machvon.outbox_event set status = 'PENDING' where id = $1", [OUTBOX_A])).rowCount).toBe(1);
      expect(await failureCode(relay, `insert into machvon.outbox_event (tenant_id, id) values ('${TENANT_A}', '${ROW_ID}')`)).toBe('42501');
      expect(await failureCode(relay, 'select count(*) from machvon.organization_unit')).toBe('42501');
    } finally {
      await relay.end();
    }
  });

  it('keeps the tenant boundary on outbox_event for the application role', async () => {
    const app = await session(urlFor('machvon_app'), TENANT_B);
    try {
      const { rows } = await app.query<{ id: string }>('select id from machvon.outbox_event');
      expect(rows.map((row) => row.id)).toEqual([OUTBOX_B]);
    } finally {
      await app.end();
    }
  });

  it('applies nothing the second time and detects an edited V003', async () => {
    const migrations = await loadCommittedMigrations(REPO_ROOT);
    expect(migrations.map((migration) => migration.name).slice(0, 4)).toEqual(['V001__roles_and_grants', 'V002__schema', 'V003__platform_services', 'V004__authorization_core']);
    expect(await migrate(database.adminUrl, migrations, { profile: 'test' })).toEqual({ applied: [] });
    const edited = migrations.map((migration) => (migration.name.startsWith('V003') ? { ...migration, sql: `${migration.sql}\n-- edited` } : migration));
    await expect(migrate(database.adminUrl, edited, { profile: 'test' })).rejects.toBeInstanceOf(MigrationChecksumError);
  }, 120_000);
});

describe('startMigratedTestDatabase', () => {
  it('passes its options on: the working directory carries the given prefix', async () => {
    const prefix = `machvon-opt-${Date.now().toString(36)}-`;
    const database = await startMigratedTestDatabase(REPO_ROOT, { tempPrefix: prefix });
    try {
      expect(readdirSync(tmpdir()).some((name) => name.startsWith(prefix))).toBe(true);
    } finally {
      await database.stop();
    }
    expect(readdirSync(tmpdir()).some((name) => name.startsWith(prefix))).toBe(false);
  }, 180_000);

  it('stops the server and rethrows when a migration fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'machvon-bad-root-'));
    const directory = join(root, MIGRATIONS_DIR);
    mkdirSync(directory, { recursive: true });
    for (const file of readdirSync(join(REPO_ROOT, MIGRATIONS_DIR)).filter((name) => name.startsWith('V001'))) {
      copyFileSync(join(REPO_ROOT, MIGRATIONS_DIR, file), join(directory, file));
    }
    writeFileSync(join(directory, 'V002__broken.sql'), 'SELECT * FROM definitely_missing_table;');
    await expect(startMigratedTestDatabase(root)).rejects.toThrow(/definitely_missing_table/);
  }, 180_000);
});
