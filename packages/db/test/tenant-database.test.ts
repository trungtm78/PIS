import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DomainError } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { SCHEMA_SOURCE_PATH, generateMigrations } from '../src/generate-migrations';
import { migrate } from '../src/migrate';
import { TenantDatabase } from '../src/tenant-database';
import type { TenantTx } from '../src/tenant-database';
import { startTestDatabase } from '../src/test-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
// The fixture tenants TNT-A and TNT-B are not UUIDs, so fixed UUIDs stand in for them.
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000f1';

const INSERT_UNIT = `insert into machvon.organization_unit (tenant_id, id, code, name, valid_from)
  values ($1, $2, $3, $4, date '2026-01-01')`;

function context(tenantId: string): TenantContext {
  return { tenantId, membershipId: MEMBERSHIP, scopeVersion: 1 };
}

function unitId(tenantIndex: number, n: number): string {
  return `00000000-0000-4000-${tenantIndex.toString(16).padStart(4, '0')}-${n.toString(16).padStart(12, '0')}`;
}

async function seedUnits(url: string, tenantId: string, tenantIndex: number, count: number): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    for (let n = 1; n <= count; n += 1) {
      await client.query(INSERT_UNIT, [tenantId, unitId(tenantIndex, n), `U${tenantIndex}-${n}`, `Unit ${tenantIndex}-${n}`]);
    }
    await client.query('commit');
  } finally {
    await client.end();
  }
}

describe('TenantDatabase', () => {
  let database: TestDatabase;
  const pools: Pool[] = [];

  function appPool(max: number): Pool {
    const pool = new Pool({ connectionString: database.urlFor('machvon_app'), max });
    // An idle connection that the server ends is reported by the pool as an error event; the test must not die of it (see TenantDatabase).
    pool.on('error', () => undefined);
    pools.push(pool);
    return pool;
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    const schema = readFileSync(join(REPO_ROOT, SCHEMA_SOURCE_PATH), 'utf8');
    await migrate(database.adminUrl, generateMigrations(schema), { profile: 'test' });
    await seedUnits(database.urlFor('machvon_owner'), TENANT_A, 1, 3);
    await seedUnits(database.urlFor('machvon_owner'), TENANT_B, 2, 2);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (database) await database.stop();
  }, 60_000);

  const SETTING = "select current_setting('app.tenant_id', true) as value";

  it('leaves no tenant setting on the pooled connection after the work throws', async () => {
    const pool = appPool(1);
    const db = new TenantDatabase(pool);
    let seenInside: string | undefined;
    await expect(
      db.withTenant(context(TENANT_A), async (tx) => {
        seenInside = (await tx.query<{ value: string }>(SETTING))[0]?.value;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seenInside).toBe(TENANT_A);
    const after = await pool.query<{ value: string | null }>(SETTING);
    expect([null, '']).toContain(after.rows[0]?.value);
  }, 30_000);

  it('leaves no tenant setting on the pooled connection after a successful call (AC-ST-KERNEL-021-2)', async () => {
    const pool = appPool(1);
    const db = new TenantDatabase(pool);
    const rows = await db.withTenant(context(TENANT_A), (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from machvon.organization_unit'),
    );
    expect(rows).toEqual([{ n: 3 }]);
    const after = await pool.query<{ value: string | null }>(SETTING);
    expect([null, '']).toContain(after.rows[0]?.value);
  }, 30_000);

  it('rolls back earlier writes when the work fails afterwards', async () => {
    const db = new TenantDatabase(appPool(1));
    await expect(
      db.withTenant(context(TENANT_A), async (tx) => {
        await tx.query(INSERT_UNIT, [TENANT_A, unitId(1, 99), 'ROLLED', 'Rolled back']);
        throw new Error('abort after write');
      }),
    ).rejects.toThrow('abort after write');
    const rows = await db.withTenant(context(TENANT_A), (tx) =>
      tx.query<{ code: string }>("select code from machvon.organization_unit where code = 'ROLLED'"),
    );
    expect(rows).toEqual([]);
  }, 30_000);

  it('isolates two interleaved calls for different tenants on a pool of two (AC-ST-KERNEL-021-2)', async () => {
    const db = new TenantDatabase(appPool(2));
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolveGate) => {
      releaseA = resolveGate;
    });
    let signalBStarted!: () => void;
    const bStarted = new Promise<void>((resolveStarted) => {
      signalBStarted = resolveStarted;
    });
    const read = (tx: TenantTx) => tx.query<{ tenant_id: string }>('select tenant_id from machvon.organization_unit order by id');

    const resultA = db.withTenant(context(TENANT_A), async (tx) => {
      const first = await read(tx);
      await bStarted;
      await gateA;
      return [...first, ...(await read(tx))];
    });
    const resultB = db.withTenant(context(TENANT_B), async (tx) => {
      signalBStarted();
      const rows = await read(tx);
      releaseA();
      return rows;
    });
    const [rowsA, rowsB] = await Promise.all([resultA, resultB]);
    expect(rowsA).toHaveLength(6);
    expect(new Set(rowsA.map((r) => r.tenant_id))).toEqual(new Set([TENANT_A]));
    expect(rowsB).toHaveLength(2);
    expect(new Set(rowsB.map((r) => r.tenant_id))).toEqual(new Set([TENANT_B]));
  }, 30_000);

  it('returns no rows for a query through the pool outside withTenant (AC-ST-KERNEL-021-2)', async () => {
    const pool = appPool(2);
    const result = await pool.query<{ n: number }>('select count(*)::int as n from machvon.organization_unit');
    expect(result.rows).toEqual([{ n: 0 }]);
  }, 30_000);

  it('rejects an invalid context with TENANT_CONTEXT_INVALID before touching the database', async () => {
    const pool = appPool(1);
    const connect = jest.spyOn(pool, 'connect');
    const db = new TenantDatabase(pool);
    const work = jest.fn();
    const invalid = { tenantId: "'; drop table x;--", membershipId: MEMBERSHIP, scopeVersion: 1 };
    const failure: unknown = await db.withTenant(invalid, work).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code: 'TENANT_CONTEXT_INVALID', status: 400 });
    expect(connect).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  }, 30_000);

  it('fails with SQLSTATE 42501 when writing a foreign tenant row and rolls the transaction back (AC-ST-KERNEL-021-2)', async () => {
    const pool = appPool(1);
    const db = new TenantDatabase(pool);
    const failure: unknown = await db
      .withTenant(context(TENANT_A), async (tx) => {
        await tx.query(INSERT_UNIT, [TENANT_A, unitId(1, 98), 'OWN', 'Own row']);
        await tx.query(INSERT_UNIT, [TENANT_B, unitId(2, 98), 'FOREIGN', 'Foreign row']);
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: '42501' });
    const rows = await db.withTenant(context(TENANT_A), (tx) =>
      tx.query<{ code: string }>("select code from machvon.organization_unit where code in ('OWN','FOREIGN')"),
    );
    expect(rows).toEqual([]);
  }, 30_000);

  it('round-trips Vietnamese text exactly', async () => {
    const db = new TenantDatabase(appPool(1));
    const name = 'Đà Nẵng';
    const stored = await db.withTenant(context(TENANT_A), async (tx) => {
      await tx.query(INSERT_UNIT, [TENANT_A, unitId(1, 97), 'DN', name]);
      return tx.query<{ name: string }>('select name from machvon.organization_unit where code = $1', ['DN']);
    });
    expect(stored).toEqual([{ name }]);
  }, 30_000);

  it.each([
    ['an Error', new Error('connection lost'), 'connection lost'],
    ['a non-Error value', 'lost', 'tenant transaction rollback failed'],
  ])('destroys the connection when ROLLBACK itself fails with %s', async (_label, rollbackFailure, message) => {
    const query = jest.fn((sql: string): Promise<{ rows: unknown[] }> => {
      return sql === 'ROLLBACK' ? Promise.reject(rollbackFailure) : Promise.resolve({ rows: [] });
    });
    const release = jest.fn();
    const pool = { connect: () => Promise.resolve({ query, release, on: jest.fn(), off: jest.fn() }) } as unknown as Pool;
    await expect(
      new TenantDatabase(pool).withTenant(context(TENANT_A), () => Promise.reject(new Error('work failed'))),
    ).rejects.toThrow('work failed');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ message }));
  });

  it('returns the client to the pool when the work throws', async () => {
    const pool = appPool(1);
    const db = new TenantDatabase(pool);
    await expect(db.withTenant(context(TENANT_A), () => Promise.reject(new Error('first')))).rejects.toThrow('first');
    expect(pool.idleCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
  }, 30_000);

  it('survives a backend killed during the work: rejects, raises no uncaught error and discards the connection', async () => {
    const pool = appPool(1);
    const db = new TenantDatabase(pool);
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => void uncaught.push(error);
    process.on('uncaughtException', record);
    try {
      await expect(
        db.withTenant(context(TENANT_A), async (tx) => {
          const [self] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          const admin = new Client({ connectionString: database.adminUrl });
          await admin.connect();
          try {
            await admin.query('select pg_terminate_backend($1)', [self?.pid]);
          } finally {
            await admin.end();
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
          return tx.query('select 1');
        }),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(uncaught).toEqual([]);
      expect(await db.withTenant(context(TENANT_A), (tx) => tx.query<{ n: number }>('select 1 as n'))).toEqual([{ n: 1 }]);
    } finally {
      process.off('uncaughtException', record);
    }
  }, 30_000);
});
