import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { loadCommittedMigrations } from '../src/generate-migrations';
import { migrate } from '../src/migrate';
import type { Migration } from '../src/migrate';
import { startTestDatabase } from '../src/test-database';
import type { TestDatabase } from '../src/test-database';
import { compatibilityBreaks, readSchemaShape } from './support/schema-compatibility';
import type { ColumnShape, SchemaShape } from './support/schema-compatibility';

// ST-KERNEL-014 AC-1 (UAT-NFR-OPERABILITY-03): the compatibility suite of the pipeline. Application N-1 runs against a schema migrated for application N; the suite names every change N-1 cannot live with.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CONTRACT_MARKER = /^--\s*contract:/im;
const VERSION = /^V(\d+)__/;
/**
 * Breaks the catalog shows that the text check of the migrations cannot declare: V1461 adds quality_acceptance.content_hash with a placeholder default and drops the default in the same migration, so the
 * column is required of every insert; the marker for a contract step cannot sit in a migration that also expands. No release exists that wrote a quality acceptance (the baseline of
 * db/migrations/expand-contract.json is not frozen), so nothing is lost; the list has to shrink when the migration is replaced, and it must name every other break exactly.
 */
const KNOWN_UNMARKED_BREAKS = ['V1461__qms1_quality_acceptance: REQUIRED_COLUMN_ADDED quality_acceptance.content_hash'];

const column = (type: string, options: Partial<ColumnShape> = {}): ColumnShape => ({ type, notNull: false, filled: false, ...options });
const shape = (tables: Record<string, Record<string, ColumnShape>>): SchemaShape => new Map(Object.entries(tables).map(([table, columns]) => [table, new Map(Object.entries(columns))]));

describe('AC-ST-KERNEL-014-1 (UAT-NFR-OPERABILITY-03) what application N-1 cannot live with, read from two shapes of the schema', () => {
  const previous = shape({ unit: { id: column('uuid', { notNull: true }), name: column('text', { notNull: true, filled: true }), note: column('text') } });
  const next = (changes: Record<string, Record<string, ColumnShape>>): SchemaShape => shape({ ...Object.fromEntries([...previous].map(([table, columns]) => [table, Object.fromEntries(columns)])), ...changes });

  it('finds nothing when the schema only grew: a nullable column, a defaulted required column, an identity column, a new table', () => {
    const grown = next({
      unit: {
        id: column('uuid', { notNull: true }),
        name: column('text', { notNull: true, filled: true }),
        note: column('text'),
        extra: column('text'),
        state: column('text', { notNull: true, filled: true }),
        seq: column('bigint', { notNull: true, filled: true }),
      },
      detail: { id: column('uuid', { notNull: true }), body: column('text', { notNull: true }) },
    });
    expect(compatibilityBreaks(previous, grown)).toEqual([]);
    expect(compatibilityBreaks(previous, previous)).toEqual([]);
  });

  it.each([
    ['a table that was dropped', { unit: undefined }, [{ kind: 'TABLE_REMOVED', table: 'unit' }]],
    ['a column that was dropped', { unit: { id: column('uuid', { notNull: true }), name: column('text', { notNull: true, filled: true }) } }, [{ kind: 'COLUMN_REMOVED', table: 'unit', column: 'note' }]],
    [
      'a column that was renamed',
      { unit: { id: column('uuid', { notNull: true }), name: column('text', { notNull: true, filled: true }), remark: column('text') } },
      [{ kind: 'COLUMN_REMOVED', table: 'unit', column: 'note' }],
    ],
    [
      'a column whose type changed, even by a longer numeric',
      { unit: { id: column('uuid', { notNull: true }), name: column('text', { notNull: true, filled: true }), note: column('integer') } },
      [{ kind: 'COLUMN_RETYPED', table: 'unit', column: 'note' }],
    ],
    [
      'a column that N-1 may write as null and no longer accepts null',
      { unit: { id: column('uuid', { notNull: true }), name: column('text', { notNull: true, filled: true }), note: column('text', { notNull: true }) } },
      [{ kind: 'COLUMN_REQUIRED', table: 'unit', column: 'note' }],
    ],
    [
      'a default that N-1 relied on and that was removed from a required column',
      { unit: { id: column('uuid', { notNull: true }), name: column('text', { notNull: true }), note: column('text') } },
      [{ kind: 'COLUMN_FILL_REMOVED', table: 'unit', column: 'name' }],
    ],
    [
      'a new required column with nothing to fill it',
      { unit: { id: column('uuid', { notNull: true }), name: column('text', { notNull: true, filled: true }), note: column('text'), owner: column('uuid', { notNull: true }) } },
      [{ kind: 'REQUIRED_COLUMN_ADDED', table: 'unit', column: 'owner' }],
    ],
  ])('names %s', (_label, change, expected) => {
    const changed = new Map(next({}));
    for (const [table, columns] of Object.entries(change)) {
      if (columns === undefined) changed.delete(table);
      else changed.set(table, new Map(Object.entries(columns)));
    }
    expect(compatibilityBreaks(previous, changed)).toEqual(expected);
  });

  it('does not count a column as new when only its place moved, and leaves out a required column of a table that is new', () => {
    const reordered = shape({ unit: { note: column('text'), name: column('text', { notNull: true, filled: true }), id: column('uuid', { notNull: true }) } });
    expect(compatibilityBreaks(previous, reordered)).toEqual([]);
    expect(compatibilityBreaks(previous, next({ fresh: { id: column('uuid', { notNull: true }) } }))).toEqual([]);
  });
});

describe('AC-ST-KERNEL-014-1 (UAT-NFR-OPERABILITY-03) the compatibility suite against a real database', () => {
  let database: TestDatabase;
  let migrations: Migration[];
  let client: Client;
  /** The migrations up to this version were never released (db/migrations/expand-contract.json): no earlier release runs against them. */
  let baselineThrough: number;

  const versionOf = (migration: Migration): number => Number(VERSION.exec(migration.name)?.[1]);

  beforeAll(async () => {
    migrations = await loadCommittedMigrations(REPO_ROOT);
    baselineThrough = (JSON.parse(readFileSync(resolve(REPO_ROOT, 'db', 'migrations', 'expand-contract.json'), 'utf8')) as { baselineThrough: number }).baselineThrough;
    database = await startTestDatabase();
    await migrate(database.adminUrl, migrations.filter((migration) => versionOf(migration) <= baselineThrough), { profile: 'test' });
    client = new Client({ connectionString: database.adminUrl });
    await client.connect();
  }, 240_000);

  afterAll(async () => {
    await client?.end();
    if (database) await database.stop();
  }, 60_000);

  it('lets application N-1 live with every migration after the first release, unless the migration is a marked contract step', async () => {
    const later = migrations.filter((migration) => versionOf(migration) > baselineThrough);
    let before = await readSchemaShape(client);
    const first = before;
    const unmarked: string[] = [];
    let declared = 0;
    for (const migration of later) {
      await migrate(database.adminUrl, migrations.slice(0, migrations.indexOf(migration) + 1), { profile: 'test' });
      const after = await readSchemaShape(client);
      const breaks = compatibilityBreaks(before, after);
      if (breaks.length > 0 && CONTRACT_MARKER.test(migration.sql)) declared += breaks.length;
      else if (breaks.length > 0) unmarked.push(`${migration.name}: ${breaks.map((entry) => `${entry.kind} ${entry.table}.${entry.column ?? ''}`).join(', ')}`);
      before = after;
    }
    expect(later.length).toBeGreaterThan(100);
    expect(first.size).toBeGreaterThan(50);
    expect(before.size).toBeGreaterThan(first.size);
    expect(unmarked).toEqual(KNOWN_UNMARKED_BREAKS);
    // The contract steps that were declared are real breaks (the marker is not decoration), so the suite does see them.
    expect(declared).toBeGreaterThan(0);
  }, 900_000);

  /** Runs application N-1's statement and rolls it back; returns the SQLSTATE of its failure, or undefined when it succeeded. */
  async function attempt(statement: string): Promise<string | undefined> {
    await client.query('BEGIN');
    try {
      await client.query(statement);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await client.query('ROLLBACK');
    }
  }

  const SETUP = 'create table machvon.%T (id int primary key, label text not null, note text, state text not null default \'new\')';
  const N1_WRITE = "insert into machvon.%T (id, label, note) values (1, 'a', 'n')";
  const N1_READ = (table: string): string => `select id, label, note, state from machvon.${table}`;

  it.each([
    ['dropping a column N-1 writes', 'alter table machvon.%T drop column note', 'COLUMN_REMOVED', '42703', N1_WRITE],
    ['renaming a column N-1 writes', 'alter table machvon.%T rename column note to remark', 'COLUMN_REMOVED', '42703', N1_WRITE],
    ['changing the type of a column N-1 writes', 'alter table machvon.%T alter column label type integer using 0', 'COLUMN_RETYPED', '22P02', N1_WRITE],
    ['requiring a column N-1 writes as null', 'alter table machvon.%T alter column note set not null', 'COLUMN_REQUIRED', '23502', "insert into machvon.%T (id, label, note) values (1, 'a', null)"],
    ['adding a required column with no default', 'alter table machvon.%T add column owner text not null', 'REQUIRED_COLUMN_ADDED', '23502', N1_WRITE],
    ['removing the default of a required column', 'alter table machvon.%T alter column state drop default', 'COLUMN_FILL_REMOVED', '23502', N1_WRITE],
    ['dropping the table', 'drop table machvon.%T', 'TABLE_REMOVED', '42P01', N1_WRITE],
  ])('flags %s before the release, and N-1 really fails on it', async (_label, migrationSql, kind, sqlstate, writeSql) => {
    const table = `compat_${kind.toLowerCase()}`;
    await client.query(SETUP.replace('%T', table));
    const previousShape = await readSchemaShape(client);
    expect(await attempt(N1_WRITE.replaceAll('%T', table))).toBeUndefined();
    await client.query(migrationSql.replaceAll('%T', table));
    const breaks = compatibilityBreaks(previousShape, await readSchemaShape(client));
    expect(breaks.map((entry) => entry.kind)).toEqual([kind]);
    // The N-1 statement that the suite predicted to fail does fail, with the database's own code.
    expect(await attempt(writeSql.replaceAll('%T', table))).toBe(sqlstate);
    await client.query(`drop table if exists machvon.${table}`);
  });

  it('lets N-1 read and write after an expand step, and N-1 reads what N wrote', async () => {
    const table = 'compat_expand';
    await client.query(SETUP.replace('%T', table));
    const previousShape = await readSchemaShape(client);
    await client.query(`alter table machvon.${table} add column extra text, add column version int not null default 2; create table machvon.${table}_detail (id int primary key, body text not null); create index on machvon.${table} (label)`);
    expect(compatibilityBreaks(previousShape, await readSchemaShape(client))).toEqual([]);
    // Application N writes a row with its new columns; application N-1 reads it and writes its own.
    await client.query(`insert into machvon.${table} (id, label, note, extra, version) values (1, 'written by N', 'n', 'new', 3)`);
    const read = await client.query(N1_READ(table));
    expect(read.rows).toEqual([{ id: 1, label: 'written by N', note: 'n', state: 'new' }]);
    await client.query(`insert into machvon.${table} (id, label, note) values (2, 'written by N-1', 'n')`);
    await client.query(`update machvon.${table} set label = 'changed by N-1' where id = 1`);
    const after = await client.query<{ id: number; label: string; version: number }>(`select id, label, version from machvon.${table} order by id`);
    expect(after.rows).toEqual([
      { id: 1, label: 'changed by N-1', version: 3 },
      { id: 2, label: 'written by N-1', version: 2 },
    ]);
    await client.query(`drop table machvon.${table}_detail; drop table machvon.${table}`);
  });
});
