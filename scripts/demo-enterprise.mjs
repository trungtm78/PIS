#!/usr/bin/env node
// One-command launcher of the ENTERPRISE edition demo (Dam Phu My / PVFCCo). Usage, from the repository root:
//   npm run demo:enterprise [-- --web-port 5173 --api-port 47311 --idp-port 47312 --open --no-seed --dry-run]
// It starts, in this order, the pieces the browser end-to-end tests and the clips already use (nothing is forked, only run):
//   1. the API stack:  `npm run e2e:stack -w @machvon/api`   (apps/api/test/e2e-stack/serve.stack.ts: embedded PostgreSQL, every migration, the real Nest
//      application, the people of docs-people.json; MACHVON_EDITION=enterprise, E2E_SEED=docs, DEMO_FORMS=true)
//   2. the seed layer: `node scripts/clip-seed.mjs apply --dataset enterprise` (docs/clip-data.md), once per start (the database is new at every start)
//   3. the web app:    `npm run dev -w @machvon/web` (vite dev server, VITE_EDITION=enterprise, the development session `?devUser=<key>`, /api proxied to the stack)
// Why vite DEV and not build + preview: the sign-in of these demo people is the development session (`import.meta.env.DEV`); a production build has no
// such session and would need a real identity provider. So the demo web is the dev server, the same one the e2e tests and the clips run against.
// Ctrl+C stops everything this script started (the stop file of the stack, then the process trees); nothing else on the machine is touched.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { freemem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const HOST = '127.0.0.1';
export const DEFAULT_PORTS = Object.freeze({ web: 5173, api: 47311, idp: 47312 });
/** The least free memory (bytes) at which a start is comfortable: the embedded PostgreSQL, the API and the Vite server together. */
export const MIN_FREE_BYTES = 2.5 * 1024 ** 3;
export const MIN_NODE_MAJOR = 24;
/** The name of the enterprise tenant in the sidebar of the development session. */
export const TENANT_NAME = 'Đạm Phú Mỹ';

/** What each person of the demo shows (the key is the `devUser` of the address). Texts without diacritics: the console of Windows may not be UTF-8. */
export const DEMO_PERSONAS = Object.freeze([
  { key: 'owner', who: 'Nguyen Van An - chu tenant', shows: 'Trung tam dieu hanh (HOME-09), co cau von, giao ban/chi dao, dau tu, tat ca man hinh doc', home: '/home/home-09' },
  { key: 'capApprover', who: 'Tran Thi Bich - lanh dao', shows: 'Duyet ke hoach von, ky bao cao, chot so lieu ky (vai tro LANH_DAO_SO + LEADER)', home: '/home/home-01' },
  { key: 'projectManager', who: 'Pham Quoc Dung - can bo ban QLDA', shows: 'Du an, mua sam thiet bi, ho so nha thau, tro ly AI', home: '/prj/prj-01' },
  { key: 'docHead', who: 'Tran Van Hung - truong phong soan thao', shows: 'Bieu mau bao cao, so sanh cheo RPT-09, phat hanh, day HPM', home: '/rpt/rpt-01' },
  { key: 'unitAdmin', who: 'Le Minh Cuong - quan tri don vi', shows: 'Quan tri don vi, lich nhac, thanh vien', home: '/home/home-01' },
  { key: 'treasuryMaker', who: 'Hoang Thi Lan - ke toan', shows: 'Thanh toan, doi chieu ke toan', home: '/home/home-01' },
  { key: 'auditor', who: 'Vu Duc Minh - kiem toan', shows: 'Chi doc: kiem toan, nhat ky', home: '/home/home-01' },
  { key: 'nobody', who: 'Do Thi Ha - thanh vien thuong', shows: 'Quyen toi thieu: de minh hoa man hinh tu choi quyen', home: '/home/home-02' },
]);

/** Reads the command line. Pure. */
export function parseArgs(argv) {
  const flags = { open: false, seed: true, dryRun: false, help: false };
  const bad = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--open') flags.open = true;
    else if (arg === '--no-seed') flags.seed = false;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--web-port' || arg === '--api-port' || arg === '--idp-port' || arg === '--dir') {
      const value = argv[index + 1];
      index += 1;
      const name = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      if (value === undefined || value.startsWith('--')) bad.push(`${arg} needs a value`);
      else flags[name] = value;
    } else bad.push(`unknown option ${String(arg)}`);
  }
  return { flags, bad };
}

function portOf(text, fallback, name, bad) {
  if (text === undefined || text === '') return fallback;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    bad.push(`${name} must be a port between 1024 and 65535 (got "${text}")`);
    return fallback;
  }
  return port;
}

/** The three ports: option, then environment (DEMO_WEB_PORT ...), then the default. Pure. */
export function resolvePorts(flags, env = {}) {
  const bad = [];
  const ports = {
    web: portOf(flags.webPort ?? env.DEMO_WEB_PORT, DEFAULT_PORTS.web, 'web port', bad),
    api: portOf(flags.apiPort ?? env.DEMO_API_PORT, DEFAULT_PORTS.api, 'api port', bad),
    idp: portOf(flags.idpPort ?? env.DEMO_IDP_PORT, DEFAULT_PORTS.idp, 'idp port', bad),
  };
  if (new Set(Object.values(ports)).size !== 3) bad.push('the web, api and idp ports must differ');
  return { ports, bad };
}

/** The environment of the API stack, as docs/clip-data.md sets it for the enterprise window. Pure. */
export function buildStackEnv({ ports, sessionKey, infoPath }) {
  return {
    E2E_SEED: 'docs',
    E2E_API_PORT: String(ports.api),
    E2E_IDP_PORT: String(ports.idp),
    E2E_SESSION_KEY: sessionKey,
    E2E_STACK_INFO: infoPath,
    MACHVON_EDITION: 'enterprise',
    DEMO_FORMS: 'true',
    // The stack is one process of its own: it takes no part in the shared database lane of the test runs.
    MACHVON_TEST_LANE: 'unit',
  };
}

/** The development users of the web: the people of the docs stack on the accounts of the fixture users (what playwright.hdsd.config.ts builds). Pure. */
export function buildDevUsers(fixtureUsers, people) {
  return people.map((person) => ({
    key: person.key,
    displayName: person.name,
    initials: person.initials,
    membershipId: fixtureUsers.find((user) => user.key === person.key)?.membershipId,
    permissions: null,
  }));
}

/** The environment of the Vite dev server of the enterprise edition. Pure. */
export function buildWebEnv({ ports, sessionKey, devUsers }) {
  return {
    VITE_EDITION: 'enterprise',
    VITE_DEV_SESSION_KEY: sessionKey,
    VITE_DEV_USERS: JSON.stringify(devUsers),
    VITE_DEV_TENANT_NAME: TENANT_NAME,
    VITE_API_BASE_URL: '/api',
    VITE_API_PROXY_TARGET: `http://${HOST}:${ports.api}`,
    VITE_OIDC_ISSUER: `http://${HOST}:${ports.idp}/realms/machvon`,
  };
}

/** The sign-in address of one person: the development session reads `?devUser=` when the page loads. Pure. */
export function loginUrl(webPort, persona) {
  return `http://${HOST}:${webPort}${persona.home}?devUser=${encodeURIComponent(persona.key)}`;
}

/** The lines that tell how to sign in. Pure. */
export function loginHint(webPort, personas = DEMO_PERSONAS) {
  const lines = ['Dang nhap = mo dia chi co ?devUser=<khoa> (khong co mat khau, chi o may demo):'];
  for (const persona of personas) lines.push(`  ${persona.key.padEnd(15)} ${loginUrl(webPort, persona)}\n  ${' '.repeat(15)} ${persona.who}: ${persona.shows}`);
  lines.push('Sau khi tai lai trang (F5) nho giu ?devUser=... tren dia chi, neu khong phien se tro ve nguoi dung mac dinh va bi tu choi quyen.');
  return lines.join('\n');
}

/** A warning when the free memory is low (the start is not refused: a loaded machine may still manage). Pure. */
export function lowMemoryWarning(freeBytes, minBytes = MIN_FREE_BYTES) {
  if (freeBytes >= minBytes) return undefined;
  const gb = (value) => (value / 1024 ** 3).toFixed(1);
  return `Bo nho trong con ${gb(freeBytes)} GB (nen co tu ${gb(minBytes)} GB). Dong bot ung dung khac (Chrome nhieu tab, IDE, may ao) truoc khi bat dau, neu khong PostgreSQL nhung co the khong khoi dong duoc.`;
}

/** True when the Node version is enough. Pure. */
export function nodeVersionOk(version, minMajor = MIN_NODE_MAJOR) {
  const major = Number(/^v?(\d+)\./u.exec(version)?.[1]);
  return Number.isInteger(major) && major >= minMajor;
}

/** Tells which of the ports are busy (`probe(port)` resolves true when something already listens). Pure but for the probe. */
export async function busyPorts(ports, probe) {
  const busy = [];
  for (const [name, port] of Object.entries(ports)) if (await probe(port)) busy.push({ name, port });
  return busy;
}

/** The polite refusal for busy ports. Pure. */
export function busyMessage(busy) {
  const list = busy.map((item) => `${item.name} ${item.port}`).join(', ');
  const options = busy.map((item) => `--${item.name}-port <so khac>`).join(' ');
  return [
    `Cong dang duoc dung boi chuong trinh khac: ${list}. Chua khoi dong gi ca.`,
    '  - Neu la lan chay demo truoc con treo: dong cua so do (Ctrl+C), hoac tim va tat tien trinh node cua no.',
    '  - Xem ai giu cong: netstat -ano | findstr :<cong>   roi   tasklist /FI "PID eq <pid>"',
    `  - Hoac chay lai voi cong khac:  npm run demo:enterprise -- ${options}`,
  ].join('\n');
}

/** The phases of a start, in order, for `--dry-run` and the log. Pure. */
export function plannedSteps({ seed, ports }) {
  return [
    `API + PostgreSQL nhung: npm run e2e:stack -w @machvon/api (cong ${ports.api}, IdP thu ${ports.idp})`,
    ...(seed ? ['Nap du lieu mau Dam Phu My: node scripts/clip-seed.mjs apply --dataset enterprise'] : ['(bo qua nap du lieu: --no-seed)']),
    `Web (vite dev, VITE_EDITION=enterprise): npm run dev -w @machvon/web (cong ${ports.web})`,
  ];
}

/** Resolves true when something already listens on the port of the loopback address. */
export function portInUse(port, host = HOST) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(true));
    server.listen(port, host, () => server.close(() => done(false)));
  });
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Polls `url` until it answers with a success status, `child` ends, or the time runs out. */
export async function waitForUrl(url, { timeoutMs, child, fetchImpl = fetch, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child !== undefined && child.exitCode !== null) return false;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await wait(intervalMs);
  }
  return false;
}

function log(message) {
  process.stdout.write(`[demo] ${message}\n`);
}

/** Starts `npm run <script> -w <workspace>` in a child of its own (a shell on Windows, where npm is npm.cmd). */
function startNpm(args, { env, name }) {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
  const tail = [];
  const keep = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) if (line.trim() !== '') tail.push(line);
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.tail = () => tail.join('\n');
  child.demoName = name;
  return child;
}

function killTree(child) {
  if (child === undefined || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function runSeed({ ports, env, infoPath }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['scripts/clip-seed.mjs', 'apply', '--dataset', 'enterprise', '--api', `http://${HOST}:${ports.api}`, '--stack-info', infoPath], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
}

const USAGE = `Dung: npm run demo:enterprise -- [--web-port N] [--api-port N] [--idp-port N] [--dir <thu muc tam>] [--no-seed] [--open] [--dry-run]
  --no-seed   khong nap du lieu mau (chi dung khi kiem tra nhanh)
  --open      mo trinh duyet vao trang chu cua lanh dao
  --dry-run   chi in cac buoc va dia chi, khong khoi dong gi`;

export async function main(argv, env = process.env) {
  const { flags, bad } = parseArgs(argv);
  if (flags.help) {
    log(USAGE);
    return 0;
  }
  const { ports, bad: portProblems } = resolvePorts(flags, env);
  const problems = [...bad, ...portProblems];
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n${USAGE}\n`);
    return 2;
  }
  if (!nodeVersionOk(process.version)) {
    process.stderr.write(`Can Node ${MIN_NODE_MAJOR} tro len (dang chay ${process.version}). Cai Node LTS moi tu nodejs.org roi chay lai.\n`);
    return 1;
  }
  if (!existsSync(join(ROOT, 'node_modules', 'embedded-postgres')) && !existsSync(join(ROOT, 'node_modules', '@machvon'))) {
    process.stderr.write('Chua cai thu vien: chay `npm ci` o thu muc goc truoc.\n');
    return 1;
  }
  log(plannedSteps({ seed: flags.seed, ports }).map((step, index) => `${index + 1}. ${step}`).join('\n       '));
  if (flags.dryRun) {
    log(loginHint(ports.web));
    return 0;
  }
  const busy = await busyPorts(ports, portInUse);
  if (busy.length > 0) {
    process.stderr.write(`${busyMessage(busy)}\n`);
    return 3;
  }
  const warning = lowMemoryWarning(freemem());
  if (warning !== undefined) log(`CANH BAO: ${warning}`);

  const dir = resolve(typeof flags.dir === 'string' ? flags.dir : join(tmpdir(), 'machvon-demo'));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const infoPath = join(dir, 'stack-info.json');
  const sessionKey = randomBytes(32).toString('base64');
  const fixtureUsers = JSON.parse(readFileSync(join(ROOT, 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json'), 'utf8')).users;
  const people = JSON.parse(readFileSync(join(ROOT, 'apps', 'web', 'e2e', 'support', 'docs-people.json'), 'utf8'));
  const stackEnv = buildStackEnv({ ports, sessionKey, infoPath });
  const webEnv = buildWebEnv({ ports, sessionKey, devUsers: buildDevUsers(fixtureUsers, people) });

  let stack;
  let web;
  let stopping = false;
  const shutdown = async (code) => {
    if (stopping) return;
    stopping = true;
    log('Dang dung moi thu...');
    killTree(web);
    if (stack !== undefined && stack.exitCode === null) {
      writeFileSync(`${infoPath}.stop`, 'stop');
      for (let waited = 0; waited < 20_000 && stack.exitCode === null; waited += 500) await wait(500);
      killTree(stack);
    }
    rmSync(dir, { recursive: true, force: true });
    log('Da dung. Co the dong cua so nay.');
    process.exitCode = code;
    setTimeout(() => process.exit(code), 300).unref();
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  log('Khoi dong API + PostgreSQL nhung (lan dau mat 1-3 phut)...');
  // The orphan cleaner of the e2e stack looks at the default stack files only; this stack lives in its own folder, so there is nothing stale to clean.
  stack = startNpm(['run', 'e2e:stack', '-w', '@machvon/api'], { env: stackEnv, name: 'api' });
  const apiUp = await waitForUrl(`http://${HOST}:${ports.api}/__e2e/health`, { timeoutMs: 360_000, child: stack });
  if (!apiUp) {
    process.stderr.write(`API khong len duoc. Dong cuoi cua no:\n${stack.tail()}\n`);
    await shutdown(1);
    return 1;
  }
  log(`API san sang tren cong ${ports.api}.`);

  if (flags.seed) {
    log('Nap du lieu mau Dam Phu My (khoang 2-5 phut, dung tat cua so)...');
    const code = await runSeed({ ports, env: { ...stackEnv, VITE_EDITION: 'enterprise' }, infoPath });
    if (code !== 0) {
      process.stderr.write(`Nap du lieu that bai (ma ${code}). Dung lai; xem docs/demo/demo-enterprise.md muc Xu ly su co.\n`);
      await shutdown(1);
      return 1;
    }
    log('Da nap du lieu mau.');
  }

  log('Khoi dong web (vite)...');
  web = startNpm(['run', 'dev', '-w', '@machvon/web', '--', '--host', HOST, '--port', String(ports.web), '--strictPort'], { env: webEnv, name: 'web' });
  const webUp = await waitForUrl(`http://${HOST}:${ports.web}/`, { timeoutMs: 180_000, child: web });
  if (!webUp) {
    process.stderr.write(`Web khong len duoc. Dong cuoi cua no:\n${web.tail()}\n`);
    await shutdown(1);
    return 1;
  }
  const home = loginUrl(ports.web, DEMO_PERSONAS[0]);
  log('=================================================================');
  log(`SAN SANG. Mo bang Google Chrome:  ${home}`);
  log('=================================================================');
  log(loginHint(ports.web));
  log('Dung demo: nhan Ctrl+C trong cua so nay.');
  if (flags.open) openBrowser(home);
  // The children end only when told to (or when one of them dies, which ends the demo).
  stack.on('exit', () => void shutdown(1));
  web.on('exit', () => void shutdown(1));
  return await new Promise(() => undefined);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`demo-enterprise: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
