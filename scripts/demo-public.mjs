#!/usr/bin/env node
// One-command launcher of the PUBLIC edition demo ("Hệ thống quản lý đầu tư công") with its demo data. Usage, from the repository root:
//   node scripts/demo-public.mjs [--dataset camau] [--dir <run directory>] [--web-port 5180] [--api-port 47411] [--idp-port 47412] [--no-seed]
// It starts, in order:
//   1. a static build of the web in development mode (the development session `?devUser=<key>` exists only there), into <dir>/dist
//   2. the API stack: `npm run e2e:stack -w @machvon/api` (embedded PostgreSQL, every migration, the real application, the people of docs-people.json; E2E_SEED=docs).
//      The tenant of the stack is the one of the dataset (E2E_TENANT_PROFILE: name, units, role names); the name of the PRODUCT is never changed by a dataset.
//   3. the seed layer: `node scripts/clip-seed.mjs apply --dataset <dataset>`, then `verify` (docs/clip-data.md)
//   4. `vite preview` of the build, /api proxied to the stack
// The default dataset is the demo data of the province of Cà Mau (scripts/fixtures/clip-data/camau.json). It stays up until <dir>/stack-info.json.stop exists (or Ctrl+C).
// Illustrative data only: nothing here is a figure of a real province. For an installation that runs the released images see docs/runbooks/demo-data-camau.md.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASETS, DEFAULT_DEMO_DATASET } from './clip-seed-lib.mjs';
import { buildDevUsers } from './demo-enterprise.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
export const DEFAULT_PORTS = Object.freeze({ web: 5180, api: 47411, idp: 47412 });

/** `--flag value` and `--no-seed` into the options of a run; an unknown flag or a dataset that is not of the public edition is refused by name. Pure. */
export function parseArgs(argv) {
  const options = { dataset: DEFAULT_DEMO_DATASET.public, dir: join(ROOT, '.demo-public'), ports: { ...DEFAULT_PORTS }, seed: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--no-seed') options.seed = false;
    else if (['--dataset', '--dir', '--web-port', '--api-port', '--idp-port'].includes(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      index += 1;
      if (flag === '--dataset') options.dataset = value;
      else if (flag === '--dir') options.dir = resolve(value);
      else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${flag} must be a port between 1024 and 65535`);
        options.ports[flag.slice(2, -5)] = port;
      }
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!DATASETS.includes(options.dataset) || options.dataset === 'enterprise') throw new Error(`the dataset ${options.dataset} is not one of the public edition (camau, public)`);
  return options;
}

/** The dataset file and, when the dataset names a tenant, the tenant the stack and the web must show. Pure but for the read. */
export function datasetOf(name, read = (path) => readFileSync(path, 'utf8')) {
  const path = join(ROOT, 'scripts', 'fixtures', 'clip-data', `${name}.json`);
  const dataset = JSON.parse(read(path));
  return { path, tenantName: dataset.tenant?.name };
}

/** The environment of the stack. Pure. */
export function buildStackEnv({ ports, sessionKey, infoPath, profilePath }) {
  return {
    E2E_SEED: 'docs',
    E2E_API_PORT: String(ports.api),
    E2E_IDP_PORT: String(ports.idp),
    E2E_SESSION_KEY: sessionKey,
    E2E_STACK_INFO: infoPath,
    MACHVON_TEST_LANE: 'unit',
    ...(profilePath === undefined ? {} : { E2E_TENANT_PROFILE: profilePath }),
  };
}

/** The environment of the web build and preview. Pure. */
export function buildWebEnv({ ports, sessionKey, devUsers, tenantName }) {
  return {
    NODE_ENV: 'development',
    VITE_DEV_SESSION_KEY: sessionKey,
    VITE_DEV_USERS: JSON.stringify(devUsers),
    VITE_API_BASE_URL: '/api',
    VITE_API_PROXY_TARGET: `http://${HOST}:${ports.api}`,
    VITE_OIDC_ISSUER: `http://${HOST}:${ports.idp}/realms/machvon`,
    ...(tenantName === undefined ? {} : { VITE_DEV_TENANT_NAME: tenantName }),
  };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function up(url, attempts, child) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A process that ended will never answer.
    if (child !== undefined && child.exitCode !== null) return false;
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await wait(500);
  }
  return false;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const { dir, ports } = options;
  const say = (line) => process.stdout.write(`[demo-public] ${line}\n`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const infoPath = join(dir, 'stack-info.json');
  const sessionKey = randomBytes(32).toString('base64');
  const dataset = datasetOf(options.dataset);
  const fixtureUsers = JSON.parse(readFileSync(join(ROOT, 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json'), 'utf8')).users;
  const people = JSON.parse(readFileSync(join(ROOT, 'apps', 'web', 'e2e', 'support', 'docs-people.json'), 'utf8'));
  const webEnv = { ...process.env, ...buildWebEnv({ ports, sessionKey, devUsers: buildDevUsers(fixtureUsers, people), tenantName: dataset.tenantName }) };
  delete webEnv.VITE_EDITION;
  const stackEnv = { ...process.env, ...buildStackEnv({ ports, sessionKey, infoPath, profilePath: dataset.tenantName === undefined ? undefined : dataset.path }) };
  delete stackEnv.MACHVON_EDITION;
  const distDir = join(dir, 'dist');

  say(`building the web (development mode) into ${distDir}`);
  const build = spawnSync('npx', ['vite', 'build', '--mode', 'development', '--outDir', distDir, '--emptyOutDir'], { cwd: join(ROOT, 'apps', 'web'), env: webEnv, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    say(`BUILD-FAILED ${build.status}`);
    return 1;
  }
  const kill = (child) => (process.platform === 'win32' ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: true }) : child.kill('SIGTERM'));
  const stack = spawn('npm', ['run', 'e2e:stack', '-w', '@machvon/api'], { cwd: ROOT, env: stackEnv, stdio: ['ignore', 'inherit', 'inherit'], shell: true });
  if (!(await up(`http://${HOST}:${ports.api}/__e2e/health`, 1440, stack))) {
    say('STACK-DID-NOT-COME-UP');
    kill(stack);
    return 1;
  }
  let seedCode = 0;
  if (options.seed) {
    say(`API up, loading the dataset ${options.dataset}`);
    const common = ['--dataset', options.dataset, '--api', `http://${HOST}:${ports.api}`, '--stack-info', infoPath];
    seedCode = spawnSync(process.execPath, ['scripts/clip-seed.mjs', 'apply', ...common], { cwd: ROOT, env: stackEnv, stdio: 'inherit' }).status ?? 1;
    say(`SEED-EXIT ${seedCode}`);
    if (seedCode === 0) {
      seedCode = spawnSync(process.execPath, ['scripts/clip-seed.mjs', 'verify', ...common], { cwd: ROOT, env: stackEnv, stdio: 'inherit' }).status ?? 1;
      say(`VERIFY-EXIT ${seedCode}`);
    }
  }
  const preview = spawn('npx', ['vite', 'preview', '--host', HOST, '--port', String(ports.web), '--strictPort', '--outDir', distDir], { cwd: join(ROOT, 'apps', 'web'), env: webEnv, stdio: ['ignore', 'inherit', 'inherit'], shell: true });
  const webUp = await up(`http://${HOST}:${ports.web}/`, 120);
  writeFileSync(join(dir, 'session-key.txt'), sessionKey);
  say(webUp ? `READY web=http://${HOST}:${ports.web}/?devUser=owner api=http://${HOST}:${ports.api} (stop: create ${infoPath}.stop)` : 'WEB-DID-NOT-COME-UP');
  while (!existsSync(`${infoPath}.stop`)) await wait(1000);
  kill(preview);
  await wait(15_000);
  kill(stack);
  say('stopped');
  return seedCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`demo-public: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
