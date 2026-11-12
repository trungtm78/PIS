import { randomBytes } from 'node:crypto';
import { OutboxRelay, TenantDatabase, enqueueOutbox } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { startMigratedTestDatabase } from '@machvon/db/src/migrated-test-database';
import type { TestDatabase } from '@machvon/db/src/test-database';
import type { OpenApiDocument } from '@machvon/contracts';
import { Client, Pool } from 'pg';
import { breakingChanges } from '../../../../packages/contracts/src/breaking-changes';
import { TENANT_A, TENANT_B, contextFor, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { compatibilityBreaks, readSchemaShape } from '../../../../packages/db/test/support/schema-compatibility';
import { loadOpenApi, REPO_ROOT } from '../isolation/test-app';
import { expectCheckFails } from '../uat/uat-kit';

/**
 * Rolling the application back after a schema expand (the release N is replaced by the release N-1 while the database stays at the schema of N). The case is proved on a real database that carries every
 * committed migration: the schema of N still lets N-1 read and write, what N received is still there after N-1 ran, the events N wrote and could not deliver are delivered by N-1 once each, and the
 * events of the other tenant are not touched. The OpenAPI document that the previous mobile version was built from is compared with the one of N.
 */

const AGGREGATE = '00000000-0000-4000-8000-0000000000a1';
const CORRELATION = '00000000-0000-4000-8000-0000000000b1';
const SIGNING_KEY = randomBytes(32);
const PER_TENANT = { [TENANT_A]: 60, [TENANT_B]: 40 };

/** The rows `count` events leave in the outbox of `tenant`, by their event keys. */
const keysOf = (tenant: string, count: number): string[] => Array.from({ length: count }, (_unused, index) => `${tenant}:${String(index + 1)}`);

/** The delivery set of a rollback is complete: every key came exactly once. */
function assertDeliveredOnce(delivered: Map<string, number>, expected: string[]): void {
  const wrong = expected.filter((key) => delivered.get(key) !== 1);
  if (wrong.length > 0 || delivered.size !== expected.length) throw new Error(`events not delivered exactly once: ${wrong.slice(0, 3).join(', ')} (${String(delivered.size)} delivered of ${String(expected.length)})`);
}

describe('the checks of this suite can go red (negative control)', () => {
  it('a delivery set that lost an event or delivered one twice is refused', () => {
    expectCheckFails(() => assertDeliveredOnce(new Map([['a:1', 1]]), ['a:1', 'a:2']));
    expectCheckFails(() => assertDeliveredOnce(new Map([['a:1', 2]]), ['a:1']));
  });
});

describe('TC-OPS02 the application is rolled back after a schema expand, with the previous mobile version', () => {
  let database: TestDatabase;
  let admin: Client;
  let appPool: Pool;
  let tenants: TenantDatabase;
  const relayPools: Pool[] = [];

  function relayPool(): Pool {
    const pool = new Pool({ connectionString: database.urlFor('machvon_outbox_relay'), max: 2 });
    pool.on('error', () => undefined); // a backend that the test ends on purpose is reported by the pool as an error event
    relayPools.push(pool);
    return pool;
  }

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    admin = new Client({ connectionString: database.adminUrl });
    await admin.connect();
    appPool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 4 });
    appPool.on('error', () => undefined);
    tenants = new TenantDatabase(appPool);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(relayPools.map((pool) => pool.end()));
    await appPool?.end();
    await admin?.end();
    if (database) await database.stop();
  }, 60_000);

  it('lets release N-1 read and write after the expand, reads what N wrote, and keeps what N received after the rollback', async () => {
    const table = 'rollback_unit';
    await admin.query(`create table machvon.${table} (id int primary key, label text not null, note text, state text not null default 'new')`);
    const before = await readSchemaShape(admin);
    // The expand step of release N: a nullable column, a required column with a default, a new table and an index.
    await admin.query(`alter table machvon.${table} add column extra text, add column version int not null default 2; create table machvon.${table}_detail (id int primary key, body text not null); create index on machvon.${table} (label)`);
    expect(compatibilityBreaks(before, await readSchemaShape(admin))).toEqual([]);

    // Release N receives a row with its new columns.
    await admin.query(`insert into machvon.${table} (id, label, note, extra, version) values (1, 'received by N', 'n', 'new', 3)`);
    // The rollback: release N-1 runs against the schema of N. It reads the columns it knows, writes a row of its own and updates the row of N.
    const read = await admin.query(`select id, label, note, state from machvon.${table}`);
    expect(read.rows).toEqual([{ id: 1, label: 'received by N', note: 'n', state: 'new' }]);
    await admin.query(`insert into machvon.${table} (id, label, note) values (2, 'written by N-1', 'n')`);
    await admin.query(`update machvon.${table} set label = 'changed by N-1' where id = 1`);
    // Nothing that N received is destroyed: its columns still hold what it wrote, and the row of N-1 got the defaults of N.
    const after = await admin.query<{ id: number; label: string; extra: string | null; version: number }>(`select id, label, extra, version from machvon.${table} order by id`);
    expect(after.rows).toEqual([
      { id: 1, label: 'changed by N-1', extra: 'new', version: 3 },
      { id: 2, label: 'written by N-1', extra: null, version: 2 },
    ]);

    // The contrast: a contract step (the column N-1 writes is dropped) is flagged before the release, and N-1 really fails on it with the database's own code.
    const expanded = await readSchemaShape(admin);
    await admin.query(`alter table machvon.${table} drop column note`);
    expect(compatibilityBreaks(expanded, await readSchemaShape(admin))).toEqual([{ kind: 'COLUMN_REMOVED', table, column: 'note' }]);
    await expect(admin.query(`insert into machvon.${table} (id, label, note) values (3, 'written by N-1', 'n')`)).rejects.toMatchObject({ code: '42703' });
  });

  it('keeps the response contract of the previous mobile version: an added field is compatible, a removed field is flagged', () => {
    const previous = loadOpenApi();
    const schemas = (previous.components?.schemas ?? {}) as Record<string, { properties?: Record<string, unknown> }>;
    const named = new Set<string>();
    for (const item of Object.values(previous.paths ?? {})) {
      const reply = (item as { get?: { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> } }).get?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
      if (reply !== undefined) named.add(reply.replace('#/components/schemas/', ''));
    }
    const name = [...named].find((candidate) => Object.keys(schemas[candidate]?.properties ?? {}).length >= 2) as string;
    expect(name).toBeDefined();
    const [field] = Object.keys(schemas[name]?.properties ?? {}) as [string];
    const edited = (change: (properties: Record<string, unknown>) => void): OpenApiDocument => {
      const copy = JSON.parse(JSON.stringify(previous)) as OpenApiDocument;
      change(((copy.components?.schemas as Record<string, { properties: Record<string, unknown> }>)[name] as { properties: Record<string, unknown> }).properties);
      return copy;
    };
    // The release N adds a field to a response the phone reads: the phone of the previous version ignores it.
    expect(breakingChanges(previous, edited((properties) => void (properties.added_by_release_n = { type: 'string' })))).toEqual([]);
    // The release that drops a field the phone reads is flagged, naming the operation and the field.
    const removed = breakingChanges(previous, edited((properties) => void delete properties[field]));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((change) => change.kind === 'FIELD_REMOVED' && change.side === 'response' && (change.location ?? '').endsWith(field))).toBe(true);
  });

  it('loses no event of the outbox: release N dies in the middle of its delivery, release N-1 delivers every event of both tenants once, and the other tenant is not touched', async () => {
    for (const [tenant, count] of Object.entries(PER_TENANT)) {
      for (let n = 1; n <= count; n += 1) {
        await tenants.withTenant(contextFor(tenant, memberId(1)), (tx) =>
          enqueueOutbox(tx, { aggregateType: 'contract', aggregateId: AGGREGATE, aggregateVersion: n, type: 'ContractSubmitted', schemaVersion: 1, payload: { n }, eventKey: `${tenant}:${String(n)}`, correlationId: CORRELATION }),
        );
      }
    }
    // The events carry what release N added: a version of its own and a field N-1 does not know.
    await admin.query("update machvon.outbox_event set schema_version = 2, payload = payload || '{\"added_by_n\": true}'::jsonb");

    let attempted = 0;
    const releaseN = new OutboxRelay(
      relayPool(),
      async () => {
        attempted += 1;
        if (attempted === 30) {
          await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where usename = 'machvon_outbox_relay' and datname = current_database() and pid <> pg_backend_pid()");
        }
      },
      { signingKey: SIGNING_KEY },
    );
    await expect(releaseN.runOnce()).rejects.toThrow();
    const pending = await admin.query<{ tenant_id: string; n: string }>("select tenant_id, count(*) as n from machvon.outbox_event where status = 'PENDING' group by tenant_id order by tenant_id");
    expect(Object.fromEntries(pending.rows.map((row) => [row.tenant_id, Number(row.n)]))).toEqual(PER_TENANT);

    // The rollback starts release N-1: a relay of its own, which reads only what N-1 knows of an event.
    const delivered = new Map<string, number>();
    const tenantsSeen = new Map<string, string>();
    const releaseNMinus1 = new OutboxRelay(
      relayPool(),
      async (delivery: OutboxDelivery) => {
        expect({ type: delivery.type, aggregateId: delivery.aggregateId, n: typeof delivery.payload.n }).toEqual({ type: 'ContractSubmitted', aggregateId: AGGREGATE, n: 'number' });
        delivered.set(delivery.eventKey, (delivered.get(delivery.eventKey) ?? 0) + 1);
        tenantsSeen.set(delivery.eventKey, delivery.tenantId);
      },
      { signingKey: SIGNING_KEY },
    );
    expect(await releaseNMinus1.runOnce()).toEqual({ published: 100, retried: 0, dead: 0 });
    assertDeliveredOnce(delivered, [...keysOf(TENANT_A, PER_TENANT[TENANT_A]), ...keysOf(TENANT_B, PER_TENANT[TENANT_B])]);
    // Each event reached the consumer under its own tenant: the key names the tenant, and so does the delivery.
    expect([...tenantsSeen].filter(([key, tenant]) => !key.startsWith(`${tenant}:`))).toEqual([]);
    const rows = await admin.query<{ tenant_id: string; status: string; schema_version: number; added: boolean }>("select tenant_id, status, schema_version, payload ? 'added_by_n' as added from machvon.outbox_event");
    expect(rows.rows).toHaveLength(100);
    expect(rows.rows.every((row) => row.status === 'PUBLISHED' && row.schema_version === 2 && row.added)).toBe(true);
    expect(rows.rows.filter((row) => row.tenant_id === TENANT_B)).toHaveLength(PER_TENANT[TENANT_B]);
  }, 180_000);
});
