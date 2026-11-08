import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { MACHVON_ROLES } from './roles.ts';
import type { MachvonRole } from './roles.ts';

export { MACHVON_ROLES };
export type { MachvonRole };

export interface TestDatabase {
  adminUrl: string;
  urlFor(role: MachvonRole): string;
  stop(): Promise<void>;
}

export type RoleProvisioner = (adminUrl: string, passwords: Record<MachvonRole, string>) => Promise<void>;

export interface TestDatabaseOptions {
  /** Connection limit of the server; the default of 40 is enough for one suite, a server shared by several needs more. */
  maxConnections?: number;
  /** Prefix of the unique temporary working directory. Defaults to `machvon-pg-`. */
  tempPrefix?: string;
  /** Creates the MACHVON roles once the server accepts connections. Defaults to the real six-role setup. */
  provisionRoles?: RoleProvisioner;
}

const DEFAULT_TEMP_PREFIX = 'machvon-pg-';
const DATABASE_NAME = 'postgres';
const ADMIN_USER = 'postgres';
// Tests start many servers at once. On Windows each one reserves commit memory, and a full machine fails with
// error 1455 (could not create shared memory segment), so every test server stays small. fsync is off: the data
// directory is thrown away.
const DEFAULT_MAX_CONNECTIONS = 40;
/** How long a server may take to stop before it is killed by its process tree; a stop takes one to two seconds, even on a loaded machine. */
const STOP_GRACE_MS = 30_000;

/**
 * Stops the server, never waiting for something that has already happened or will not happen. `EmbeddedPostgres.stop()` registers a handler for the `exit` event of the postmaster and then kills it; a postmaster that
 * ended before that (it crashed, or it was killed with the tree of a neighbouring run) never emits `exit` again, so the library waits for ever and the test dies of its own timeout five minutes later with nothing to say
 * why. So: a process that has already exited needs no stop; one that does not stop within the grace period is killed with its tree by pid and the stop goes on. A server that survives even that is a leak and throws; the
 * directory removal that follows still fails loudly if a file is held, so nothing is hidden.
 */
export async function stopServer(server: Pick<EmbeddedPostgres, 'stop'>, graceMs: number = STOP_GRACE_MS): Promise<void> {
  const child = (server as unknown as { process?: ChildProcess }).process;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), graceMs);
  });
  try {
    const outcome = await Promise.race([server.stop().then(() => 'stopped' as const), late]);
    if (outcome === 'stopped') return;
  } finally {
    clearTimeout(timer);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  process.stderr.write(`test database: the server (pid ${child.pid}) did not stop within ${graceMs} ms; killing its process tree\n`);
  if (child.pid === undefined) throw new Error('the test server has no process id to kill');
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
  else spawnSync('kill', ['-KILL', String(child.pid)], { stdio: 'ignore' });
  // The kill reports failure for a process that is not there any more, which is the outcome wanted; what counts is that the process is gone shortly after.
  for (let waited = 0; waited < 10_000 && child.exitCode === null && child.signalCode === null; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  if (child.exitCode === null && child.signalCode === null) throw new Error(`the test server (pid ${child.pid}) is still running after it was killed`);
}

function smallServerFlags(maxConnections: number): string[] {
  return [
    '-c', 'shared_buffers=16MB',
    '-c', `max_connections=${maxConnections}`,
    '-c', 'max_worker_processes=4',
    '-c', 'autovacuum=off',
    '-c', 'fsync=off',
    '-c', 'synchronous_commit=off',
    '-c', 'full_page_writes=off',
  ];
}

function randomPassword(): string {
  return randomBytes(24).toString('hex');
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close((closeError) => (closeError ? reject(closeError) : resolve(port)));
    });
  });
}

export function connectionUrl(user: string, password: string, port: number, database: string = DATABASE_NAME): string {
  return `postgres://${user}:${password}@localhost:${port}/${database}`;
}

const createRoles: RoleProvisioner = async (adminUrl, passwords) => {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const role of MACHVON_ROLES) {
      await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${passwords[role]}'`);
      await client.query(`GRANT CONNECT ON DATABASE ${DATABASE_NAME} TO ${role}`);
    }
  } finally {
    await client.end();
  }
};

/** A running server with the MACHVON roles created; `stop` stops it and removes its directory. */
export interface TestServer {
  port: number;
  adminPassword: string;
  passwords: Record<MachvonRole, string>;
  adminUrl: string;
  /** The URL of a role on a database of this server (default: the `postgres` database). */
  urlFor(role: MachvonRole, database?: string): string;
  /** The URL of the superuser on a database of this server. */
  adminUrlFor(database: string): string;
  stop(): Promise<void>;
}

/**
 * Starts a real PostgreSQL server (UTF8, C locale) on a free port in a unique temporary
 * directory and creates the six MACHVON roles. Options let tests use a private directory prefix and inject
 * role provisioning (for deterministic failure injection). Callers must stop it in a finally block or afterAll.
 */
export async function startTestServer(options: TestDatabaseOptions = {}): Promise<TestServer> {
  const { tempPrefix = DEFAULT_TEMP_PREFIX, provisionRoles = createRoles, maxConnections = DEFAULT_MAX_CONNECTIONS } = options;
  const workDir = await mkdtemp(join(tmpdir(), tempPrefix));
  const adminPassword = randomPassword();
  const passwords = Object.fromEntries(MACHVON_ROLES.map((role) => [role, randomPassword()])) as Record<
    MachvonRole,
    string
  >;
  let server: EmbeddedPostgres | undefined;
  let started = false;

  const stop = async (): Promise<void> => {
    try {
      if (server !== undefined && started) {
        started = false;
        await stopServer(server);
      }
    } finally {
      // Windows keeps files locked for a short moment after the process tree is killed.
      await rm(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  };

  try {
    const port = await findFreePort();
    server = new EmbeddedPostgres({
      databaseDir: join(workDir, 'data'),
      user: ADMIN_USER,
      password: adminPassword,
      port,
      // The harness removes the directory itself (with retries); the library delete races on Windows.
      persistent: true,
      onLog: () => undefined,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: smallServerFlags(maxConnections),
    });
    await server.initialise();
    await server.start();
    started = true;
    const adminUrl = connectionUrl(ADMIN_USER, adminPassword, port);
    await provisionRoles(adminUrl, passwords);
    return {
      port,
      adminPassword,
      passwords,
      adminUrl,
      urlFor: (role, database) => connectionUrl(role, passwords[role], port, database),
      adminUrlFor: (database) => connectionUrl(ADMIN_USER, adminPassword, port, database),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A server of its own with the roles created: the default for tests that need a pristine server. */
export async function startTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const server = await startTestServer(options);
  return { adminUrl: server.adminUrl, urlFor: (role) => server.urlFor(role), stop: server.stop };
}
