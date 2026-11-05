import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Executes the reference schema on a real PostgreSQL and checks the tenant-isolation guarantees the
// design promises. The server is an embedded build (npm package embedded-postgres), so no Docker or
// system PostgreSQL is needed. The embedded build has no pgvector, hence the test profile below;
// production keeps the extension.

export const SCHEMA = 'machvon';
export const TEST_ROLES = [
  'machvon_app',
  'machvon_control',
  'machvon_outbox_relay',
  'machvon_reporting',
  'machvon_sync',
  'machvon_owner',
];
// The default Windows locale (WIN1252) cannot store the Vietnamese comments in the schema.
export const INITDB_FLAGS = ['--encoding=UTF8', '--locale=C'];
const REQUIRED_POLICIES = [
  { name: 'tenant_boundary', kind: 'RESTRICTIVE' },
  { name: 'tenant_access', kind: 'PERMISSIVE' },
];

const TABLES_QUERY = `
  select c.relname as name,
         c.relrowsecurity as "rowSecurity",
         c.relforcerowsecurity as "forceRowSecurity",
         exists (select 1 from pg_attribute a
                 where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped) as "hasTenantId"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname = '${SCHEMA}'
   order by c.relname`;
const POLICIES_QUERY = `
  select tablename as "table", policyname as name, permissive as kind
    from pg_policies
   where schemaname = '${SCHEMA}'`;

// Test profile: pgvector is unavailable in the embedded build, so embeddings become real[].
export function applyTestProfile(sql) {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS vector;/g, '-- test profile: pgvector is replaced by real[]')
    .replace(/\bvector\(\d+\)/g, 'real[]');
}

export function evaluateRls({ tables, policies }) {
  const problems = [];
  const tenantTables = tables.filter((table) => table.hasTenantId);
  if (tables.length === 0) problems.push({ key: 'sqlVerify.failed.noTables', params: {} });
  for (const table of tenantTables) {
    if (!table.rowSecurity) problems.push({ key: 'sqlVerify.failed.rlsNotEnabled', params: { table: table.name } });
    else if (!table.forceRowSecurity) problems.push({ key: 'sqlVerify.failed.rlsNotForced', params: { table: table.name } });
    const own = policies.filter((policy) => policy.table === table.name);
    for (const { name, kind } of REQUIRED_POLICIES) {
      if (!own.some((policy) => policy.name === name && policy.kind === kind)) {
        problems.push({ key: 'sqlVerify.failed.policyMissing', params: { table: table.name, policy: name, kind } });
      }
    }
  }
  const counts = {
    tables: tables.length,
    tenantTables: tenantTables.length,
    rlsTables: tenantTables.filter((table) => table.rowSecurity && table.forceRowSecurity).length,
    policies: policies.length,
  };
  return { problems, counts };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Rejects when `promise` has not settled within `ms`; the work behind it is not cancelled (a server that never answers cannot be). */
function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 10_000;
const START_ATTEMPTS = 2;

// Starts a throwaway cluster in a temporary directory (embedded-postgres removes it on stop). The embedded server reports that it is ready on its log,
// so a server process that dies before it does leaves the start waiting for ever: an attempt that is not ready in time is stopped (without waiting
// for a stop that may not come either) and the next one gets a directory and a port of its own.
export async function startDatabase({ EmbeddedPostgres, directory, port, startTimeoutMs = START_TIMEOUT_MS, stopTimeoutMs = STOP_TIMEOUT_MS, attempts = START_ATTEMPTS } = {}) {
  const Server = EmbeddedPostgres ?? (await import('embedded-postgres')).default;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const log = [];
    const databaseDir = directory ?? (await mkdtemp(join(tmpdir(), 'machvon-sql-verify-')));
    const server = new Server({
      databaseDir,
      port: port ?? (await freePort()),
      user: 'postgres',
      password: 'verify',
      persistent: false,
      initdbFlags: INITDB_FLAGS,
      onLog: (line) => log.push(String(line)),
      onError: (line) => log.push(String(line)),
    });
    try {
      await within(
        (async () => {
          await server.initialise();
          await server.start();
        })(),
        startTimeoutMs,
      );
    } catch (error) {
      if (error.message !== 'timeout') throw error;
      await within(Promise.resolve(server.stop()), stopTimeoutMs).catch(() => undefined);
      if (attempt === attempts) throw new Error(`the embedded PostgreSQL did not become ready within ${startTimeoutMs} ms (${attempts} attempts)`);
      directory = undefined;
      port = undefined;
      continue;
    }
    const client = server.getPgClient();
    try {
      await client.connect();
    } catch (error) {
      await server.stop();
      throw error;
    }
    return {
      async query(text) {
        return (await client.query(text)).rows;
      },
      async close() {
        try {
          await within(client.end(), stopTimeoutMs).catch(() => undefined);
        } finally {
          // The stop of the embedded server waits for the exit of the server process: when that has already exited (the process was ended before the stop was asked)
          // the wait never ends. What the run had to ask the database is in by now, so the wait is bounded and the data directory is removed here when it did not.
          await within(Promise.resolve(server.stop()), stopTimeoutMs).catch(() => undefined);
          await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  }
  throw new Error('the embedded PostgreSQL was not started');
}

function executionProblem(error, sql) {
  const position = Number(error.position);
  const line = Number.isFinite(position) && position > 0 ? sql.slice(0, position).split('\n').length : 0;
  return { key: 'sqlVerify.failed.execution', params: { message: error.message, line } };
}

export async function verifySql(sql, { start = startDatabase } = {}) {
  const database = await start();
  try {
    await database.query(TEST_ROLES.map((role) => `CREATE ROLE ${role} NOLOGIN`).join(';\n'));
    const profiled = applyTestProfile(sql);
    try {
      await database.query(profiled);
    } catch (error) {
      return { ok: false, problems: [executionProblem(error, profiled)] };
    }
    const { problems, counts } = evaluateRls({
      tables: await database.query(TABLES_QUERY),
      policies: await database.query(POLICIES_QUERY),
    });
    return { ok: problems.length === 0, counts, problems };
  } finally {
    await database.close();
  }
}
