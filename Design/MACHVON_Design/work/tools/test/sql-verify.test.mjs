import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INITDB_FLAGS,
  TEST_ROLES,
  applyTestProfile,
  evaluateRls,
  startDatabase,
  verifySql,
} from '../src/sql-verify.mjs';
import { formatVerification, main } from '../src/sql-verify-cli.mjs';
import { loadMessages } from '../src/i18n.mjs';

const REAL_SCHEMA = fileURLToPath(new URL('../../../03_Engineering/schema_reference.sql', import.meta.url));
const SAMPLE_FILE = fileURLToPath(new URL('./fixtures.mjs', import.meta.url));

const good = (name) => ({ name, rowSecurity: true, forceRowSecurity: true, hasTenantId: true });
const policyRows = (table) => [
  { table, name: 'tenant_boundary', kind: 'RESTRICTIVE' },
  { table, name: 'tenant_access', kind: 'PERMISSIVE' },
];

test('the test profile drops the pgvector extension and maps vector columns to real[]', () => {
  const sql = 'CREATE EXTENSION IF NOT EXISTS vector;\nCREATE TABLE t (\n  embedding vector(1024) NOT NULL,\n  small vector(3)\n);';
  const profiled = applyTestProfile(sql);
  assert.equal(profiled.includes('CREATE EXTENSION'), false);
  assert.match(profiled, /embedding real\[\] NOT NULL/);
  assert.match(profiled, /small real\[\]/);
  assert.equal(profiled.includes('vector('), false);
});

test('the test profile leaves a script without pgvector untouched and keeps unrelated names', () => {
  const sql = 'CREATE TABLE t (\n  vector_clock bigint\n);';
  assert.equal(applyTestProfile(sql), sql);
});

test('evaluateRls accepts tables that enable, force and police tenant access', () => {
  const result = evaluateRls({
    tables: [good('a'), { name: 'tenant', rowSecurity: false, forceRowSecurity: false, hasTenantId: false }],
    policies: policyRows('a'),
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.counts, { tables: 2, tenantTables: 1, rlsTables: 1, policies: 2 });
});

test('evaluateRls reports each missing guarantee with the table it concerns', () => {
  const result = evaluateRls({
    tables: [
      { name: 'open', rowSecurity: false, forceRowSecurity: false, hasTenantId: true },
      { name: 'unforced', rowSecurity: true, forceRowSecurity: false, hasTenantId: true },
      good('wrongkind'),
      good('nopolicy'),
    ],
    policies: [
      ...policyRows('open'),
      ...policyRows('unforced'),
      { table: 'wrongkind', name: 'tenant_boundary', kind: 'PERMISSIVE' },
      { table: 'wrongkind', name: 'tenant_access', kind: 'PERMISSIVE' },
    ],
  });
  assert.deepEqual(
    result.problems.map((item) => [item.key, item.params.table, item.params.policy]),
    [
      ['sqlVerify.failed.rlsNotEnabled', 'open', undefined],
      ['sqlVerify.failed.rlsNotForced', 'unforced', undefined],
      ['sqlVerify.failed.policyMissing', 'wrongkind', 'tenant_boundary'],
      ['sqlVerify.failed.policyMissing', 'nopolicy', 'tenant_boundary'],
      ['sqlVerify.failed.policyMissing', 'nopolicy', 'tenant_access'],
    ],
  );
  assert.equal(result.problems.find((item) => item.params.policy === 'tenant_boundary').params.kind, 'RESTRICTIVE');
  assert.deepEqual(result.counts, { tables: 4, tenantTables: 4, rlsTables: 2, policies: 6 });
});

test('evaluateRls reports an empty database', () => {
  assert.deepEqual(evaluateRls({ tables: [], policies: [] }).problems.map((item) => item.key), ['sqlVerify.failed.noTables']);
});

function fakeDatabase({ failOn, state } = {}) {
  const calls = { queries: [], closed: 0 };
  const database = {
    async query(text) {
      calls.queries.push(text);
      if (failOn?.test(text)) throw Object.assign(new Error('relation "x" does not exist'), { position: String(text.indexOf('BAD') + 1) });
      if (text.includes('pg_policies')) return state?.policies ?? [];
      if (text.includes('pg_class')) return state?.tables ?? [];
      return [];
    },
    async close() {
      calls.closed += 1;
    },
  };
  return { database, calls };
}

test('verifySql creates the roles, runs the profiled script and checks tenant tables', async () => {
  const { database, calls } = fakeDatabase({ state: { tables: [good('a')], policies: policyRows('a') } });
  const result = await verifySql('CREATE EXTENSION IF NOT EXISTS vector;\nCREATE TABLE a (embedding vector(2));', { start: async () => database });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.counts, { tables: 1, tenantTables: 1, rlsTables: 1, policies: 2 });
  assert.equal(calls.closed, 1);
  for (const role of TEST_ROLES) assert.ok(calls.queries[0].includes(`CREATE ROLE ${role} NOLOGIN`));
  assert.ok(calls.queries[1].includes('real[]'));
  assert.equal(calls.queries[1].includes('CREATE EXTENSION'), false);
});

test('an execution error is reported with its line and the server is still released', async () => {
  const { database, calls } = fakeDatabase({ failOn: /BAD/ });
  const result = await verifySql('SELECT 1;\nSELECT 2;\nBAD statement;', { start: async () => database });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].key, 'sqlVerify.failed.execution');
  assert.deepEqual(result.problems[0].params, { message: 'relation "x" does not exist', line: 3 });
  assert.equal(result.counts, undefined);
  assert.equal(calls.closed, 1);
});

test('an execution error without a position still reports the message', async () => {
  const database = {
    async query(text) {
      if (text.includes('CREATE ROLE')) return [];
      throw new Error('boom');
    },
    async close() {},
  };
  const result = await verifySql('SELECT 1;', { start: async () => database });
  assert.deepEqual(result.problems[0].params, { message: 'boom', line: 0 });
});

test('the server is released even when verification itself throws', async () => {
  const { database, calls } = fakeDatabase();
  database.query = async () => {
    throw new Error('role creation failed');
  };
  await assert.rejects(verifySql('SELECT 1;', { start: async () => database }), /role creation failed/);
  assert.equal(calls.closed, 1);
});

test('assertion problems make the result fail', async () => {
  const { database } = fakeDatabase({ state: { tables: [{ ...good('a'), forceRowSecurity: false }], policies: policyRows('a') } });
  const result = await verifySql('SELECT 1;', { start: async () => database });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((item) => item.key), ['sqlVerify.failed.rlsNotForced']);
  assert.equal(result.counts.tables, 1);
});

class FakeEmbeddedPostgres {
  static instances = [];

  static failConnect = false;

  /** How many of the next starts never answer (the server process died before it said it was ready). */
  static hangStarts = 0;

  constructor(options) {
    this.options = options;
    this.events = [];
    FakeEmbeddedPostgres.instances.push(this);
  }

  async initialise() {
    this.events.push('initialise');
  }

  async start() {
    this.events.push('start');
    if (FakeEmbeddedPostgres.hangStarts > 0) {
      FakeEmbeddedPostgres.hangStarts -= 1;
      await new Promise(() => {});
    }
  }

  async stop() {
    this.events.push('stop');
  }

  getPgClient() {
    const { events } = this;
    return {
      async connect() {
        events.push('connect');
        if (FakeEmbeddedPostgres.failConnect) throw new Error('connect failed');
      },
      async query(text) {
        events.push(`query:${text}`);
        return { rows: [{ ok: true }] };
      },
      async end() {
        events.push('end');
      },
    };
  }
}

test('startDatabase uses a UTF-8 C-locale non-persistent cluster and releases it in order', async () => {
  FakeEmbeddedPostgres.failConnect = false;
  const database = await startDatabase({ EmbeddedPostgres: FakeEmbeddedPostgres, directory: 'dir', port: 54000 });
  const instance = FakeEmbeddedPostgres.instances.at(-1);
  assert.deepEqual(instance.options.initdbFlags, INITDB_FLAGS);
  assert.deepEqual(INITDB_FLAGS, ['--encoding=UTF8', '--locale=C']);
  assert.equal(instance.options.persistent, false);
  assert.equal(instance.options.databaseDir, 'dir');
  assert.equal(instance.options.port, 54000);
  assert.deepEqual(await database.query('select 1'), [{ ok: true }]);
  instance.options.onLog('server says hello');
  instance.options.onError('server complains');
  await database.close();
  assert.deepEqual(instance.events, ['initialise', 'start', 'connect', 'query:select 1', 'end', 'stop']);
});

test('startDatabase stops the server when the client cannot connect', async () => {
  FakeEmbeddedPostgres.failConnect = true;
  try {
    await assert.rejects(startDatabase({ EmbeddedPostgres: FakeEmbeddedPostgres, directory: 'dir', port: 54001 }), /connect failed/);
    assert.deepEqual(FakeEmbeddedPostgres.instances.at(-1).events, ['initialise', 'start', 'connect', 'stop']);
  } finally {
    FakeEmbeddedPostgres.failConnect = false;
  }
});

test('startDatabase gives up on a server that never says it is ready, stops it, and starts another in a directory of its own', async () => {
  FakeEmbeddedPostgres.hangStarts = 1;
  try {
    const before = FakeEmbeddedPostgres.instances.length;
    const database = await startDatabase({ EmbeddedPostgres: FakeEmbeddedPostgres, startTimeoutMs: 30 });
    const [hung, started] = FakeEmbeddedPostgres.instances.slice(before);
    assert.deepEqual(hung.events, ['initialise', 'start', 'stop']);
    assert.deepEqual(started.events, ['initialise', 'start', 'connect']);
    assert.notEqual(hung.options.databaseDir, started.options.databaseDir);
    assert.notEqual(hung.options.port, started.options.port);
    await database.close();
  } finally {
    FakeEmbeddedPostgres.hangStarts = 0;
  }
});

test('startDatabase fails with the reason when every attempt hangs, and does not wait for a server that cannot be stopped', async () => {
  FakeEmbeddedPostgres.hangStarts = 2;
  const stuckStop = FakeEmbeddedPostgres.prototype.stop;
  FakeEmbeddedPostgres.prototype.stop = () => new Promise(() => {});
  try {
    await assert.rejects(startDatabase({ EmbeddedPostgres: FakeEmbeddedPostgres, startTimeoutMs: 20, stopTimeoutMs: 20 }), /did not become ready within 20 ms \(2 attempts\)/);
  } finally {
    FakeEmbeddedPostgres.prototype.stop = stuckStop;
    FakeEmbeddedPostgres.hangStarts = 0;
  }
});

test('closing does not wait for a server that cannot be stopped: the answer is already in, and the directory of the cluster is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sql-verify-close-'));
  writeFileSync(join(directory, 'PG_VERSION'), '18');
  const stuckStop = FakeEmbeddedPostgres.prototype.stop;
  FakeEmbeddedPostgres.prototype.stop = () => new Promise(() => {});
  try {
    const database = await startDatabase({ EmbeddedPostgres: FakeEmbeddedPostgres, directory, port: 54002, stopTimeoutMs: 20 });
    await database.close();
    assert.equal(existsSync(directory), false);
  } finally {
    FakeEmbeddedPostgres.prototype.stop = stuckStop;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startDatabase picks a free port and temporary directory when none is given', async () => {
  const database = await startDatabase({ EmbeddedPostgres: FakeEmbeddedPostgres });
  const { options } = FakeEmbeddedPostgres.instances.at(-1);
  assert.ok(Number.isInteger(options.port) && options.port > 0);
  assert.match(options.databaseDir, /machvon-sql-verify-/);
  await database.close();
});

test('formatVerification prints counts and problems in the chosen language', () => {
  const messages = loadMessages('en');
  const counts = { tables: 3, tenantTables: 2, rlsTables: 1, policies: 4 };
  const passed = formatVerification({ ok: true, counts, problems: [] }, messages, 1.5).join('\n');
  assert.match(passed, /Tables: 3/);
  assert.match(passed, /passed in 1\.5s/);
  const failed = formatVerification(
    { ok: false, counts, problems: [{ key: 'sqlVerify.failed.rlsNotEnabled', params: { table: 'open' } }] },
    messages,
    2,
  ).join('\n');
  assert.match(failed, /open/);
  assert.match(failed, /1 problem/);
  const withoutCounts = formatVerification(
    { ok: false, problems: [{ key: 'sqlVerify.failed.execution', params: { message: 'x', line: 4 } }] },
    messages,
    0,
  );
  assert.equal(withoutCounts.some((line) => line.includes('Tables:')), false);
});

test('Vietnamese and English define the same SQL verification messages', () => {
  const keys = (locale) => Object.keys(loadMessages(locale)).filter((key) => /^(sqlVerify|sqlNormalize)\./.test(key)).sort();
  assert.deepEqual(keys('vi'), keys('en'));
  assert.ok(keys('en').length > 5);
});

test('the CLI exits 0 on success and 1 on problems, verifying the file it is given', async () => {
  const lines = [];
  const seen = [];
  const verify = async (sql) => {
    seen.push(sql);
    const ok = seen.length === 1;
    return { ok, counts: { tables: 1, tenantTables: 1, rlsTables: 1, policies: 2 }, problems: ok ? [] : [{ key: 'sqlVerify.failed.noTables', params: {} }] };
  };
  assert.equal(await main(['--file', SAMPLE_FILE, '--locale', 'en'], (line) => lines.push(line), verify), 0);
  assert.equal(await main(['--file', SAMPLE_FILE, '--locale', 'en'], (line) => lines.push(line), verify), 1);
  assert.ok(seen[0].includes('validModel'));
  assert.ok(lines.length >= 2);
});

// Slow: starts a real PostgreSQL and runs the reference schema. SQL_VERIFY_SKIP=1 skips it.
test('the reference schema executes on PostgreSQL and every tenant table is protected', { skip: process.env.SQL_VERIFY_SKIP === '1', timeout: 300_000 }, async () => {
  const sql = readFileSync(REAL_SCHEMA, 'utf8');
  const result = await verifySql(sql);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.counts.tables, [...sql.matchAll(/CREATE TABLE\s+\w+/g)].length);
  assert.equal(result.counts.rlsTables, result.counts.tenantTables);
  assert.ok(result.counts.policies >= 2 * result.counts.tenantTables);
});
