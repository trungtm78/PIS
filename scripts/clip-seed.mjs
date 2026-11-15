#!/usr/bin/env node
// The seed layer of the demo data (and of the two intro clips). Usage (from the repository root):
//   node scripts/clip-seed.mjs plan   --dataset camau|public|enterprise [--out plan.json]
//   node scripts/clip-seed.mjs apply  --dataset camau|public|enterprise --api <url> [--stack-info <file>] [--groups a,b]
//   node scripts/clip-seed.mjs verify --dataset camau|public|enterprise --api <url> [--stack-info <file>]
// `apply` runs the real commands of the product (apps/web/e2e/hdsd/seed groups) against a running API; it never writes to a database.
// On the development stack the session key comes from E2E_SESSION_KEY (local environment only).
//
// On an INSTALLATION (the released images, no development session) the people sign in at the realm instead, each with the account the installation gave them:
//   ssh <server> "type <demo-credentials.json>" | node scripts/clip-seed.mjs apply  --dataset camau --api https://host:8443/api --credentials - [--wait-baseline 400]
//   ssh <server> "type <demo-credentials.json>" | node scripts/clip-seed.mjs verify --dataset camau --api https://host:8443/api --credentials - [--tolerate "check a,check b"]
//   ...                                          node scripts/clip-seed.mjs preflight --dataset camau --api https://host:8443/api --credentials -
// The credentials (scripts/clip-seed-auth.mjs says their shape) are written on the server by infra/onprem-windows/tools/demo-tenant.mjs; `-` reads them from the standard input.
// docs/runbooks/demo-data-camau.md is the whole procedure (load, wipe, load again).

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiReader } from './clip-seed-client.mjs';
import { brokerOf, credentialProblems, readCredentials } from './clip-seed-auth.mjs';
import { DATASETS, DATASET_GROUPS, buildPlan, phasesFor, checkPlan, judgeAll, parseArgs, planDigest, planForSeeds } from './clip-seed-lib.mjs';
import { verifyChecks } from './clip-seed-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WEB = join(ROOT, 'apps', 'web');
const FIXTURES = join(ROOT, 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json');

export function loadDataset(name) {
  if (!DATASETS.includes(name)) throw new Error(`unknown dataset "${String(name)}" (known: ${DATASETS.join(', ')})`);
  return JSON.parse(readFileSync(join(HERE, 'fixtures', 'clip-data', `${name}.json`), 'utf8'));
}

function stackInfoOf(flags) {
  const path = typeof flags['stack-info'] === 'string' ? flags['stack-info'] : process.env.E2E_STACK_INFO;
  if (path === undefined || path === '') throw new Error('give --stack-info <file> or set E2E_STACK_INFO (the file the stack wrote about itself)');
  return { path: resolve(path), info: JSON.parse(readFileSync(resolve(path), 'utf8')) };
}

function requireKey() {
  const key = process.env.E2E_SESSION_KEY;
  if (key === undefined || key === '') throw new Error('E2E_SESSION_KEY is not set: it must be the key the stack was started with (local environment only)');
  return key;
}

async function commandPlan(flags) {
  const dataset = loadDataset(flags.dataset);
  const plan = buildPlan(dataset);
  const problems = checkPlan(plan);
  process.stdout.write(`dataset ${plan.variant ?? plan.dataset} seed ${plan.seed} digest ${planDigest(plan)}\n`);
  process.stdout.write(`${Object.entries(plan.expect).map(([name, value]) => `${name}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' ')}\n`);
  process.stdout.write(`groups: ${DATASET_GROUPS[plan.dataset].join(', ')}\n`);
  for (const problem of problems) process.stderr.write(`plan problem: ${problem}\n`);
  if (typeof flags.out === 'string') {
    mkdirSync(dirname(resolve(flags.out)), { recursive: true });
    writeFileSync(resolve(flags.out), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    process.stdout.write(`plan written to ${resolve(flags.out)}\n`);
  }
  return problems.length === 0 ? 0 : 1;
}

/** Moves the clock of the stack (POST /__e2e/clock) when it has one; a stack without the route is left alone. */
export async function setClock(api, days, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${api.replace(/\/+$/u, '')}/__e2e/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offset_days: days }) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The hour (Vietnam time) at which the daily sweep of the overdue advances runs (ADVANCE_OVERDUE_HOUR in packages/db/src/jobs.ts). */
export const OVERDUE_SWEEP_HOUR = 6;

/** The offset in days that puts the clock of the stack at `hour`:30 Vietnam time of the same day (in the past or ahead by under a day). Pure. */
export function offsetToHour(now, hour = OVERDUE_SWEEP_HOUR) {
  const vietnam = new Date(now.getTime() + 7 * 3_600_000);
  const target = Date.UTC(vietnam.getUTCFullYear(), vietnam.getUTCMonth(), vietnam.getUTCDate(), hour, 30, 0);
  return (target - vietnam.getTime()) / 86_400_000;
}

/**
 * The sweep that raises the alert levels of the advances runs once a day, at six in the morning. The clip data needs it to have run (an advance over its recovery deadline is listed
 * as overdue), so the clock of the stack is put at half past six of the same day for a short while, the sweep runs on its own, and the clock comes back.
 */
export async function sweepOverdueAdvances(api, { waitMs = 30_000, fetchImpl = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  if (!(await setClock(api, offsetToHour(new Date()), fetchImpl))) return false;
  try {
    await sleep(waitMs);
  } finally {
    await setClock(api, 0, fetchImpl);
  }
  return true;
}

// ---- an installation without the development session ---------------------------------------------------------------------------------

/** The people of the seed layer who must have an account on an installation: the ones the dataset names accounts for. */
export function requiredPeople(dataset) {
  return (dataset.tenant?.accounts ?? []).map((account) => account.person);
}

/** Every row of a list of the API as a person (follows the cursor), with a token of the broker. */
async function listAs(api, broker, person, path, query = {}, fetchImpl = fetch) {
  const reader = new ApiReader({ base: api, tokenOf: (key) => broker.token(key), fetchImpl });
  return reader.list(person, path, query);
}

/**
 * What the seed groups read from the stack info file, made for an installation: the tenant and the id of each unit of the dataset, under the key the seeds ask it by
 * (a unit without a key under its code). A unit of the dataset the installation does not have is an error that names it: infra/onprem-windows/tools/demo-tenant.mjs makes them.
 */
export function installationInfo(dataset, credentials, units) {
  const byCode = new Map(units.map((unit) => [String(unit.code), String(unit.id)]));
  const missing = [];
  const map = {};
  for (const unit of dataset.tenant?.units ?? []) {
    const id = byCode.get(unit.code);
    if (id === undefined) missing.push(unit.code);
    else map[unit.key ?? unit.code] = id;
  }
  if (missing.length > 0) throw new Error(`the installation has no unit ${missing.join(', ')} (make the tenant of the demo first: docs/runbooks/demo-data-camau.md)`);
  return { apiPort: 0, tenants: { A: credentials.tenantId, B: credentials.tenantId, C: credentials.tenantId }, units: { A: map } };
}

/** The province of the dataset in the master catalogue of the tenant, in force: the platform baseline reaches a new tenant only when the worker job `master-baseline-sync` has run (every six hours). */
export async function baselineReady(api, broker, dataset, fetchImpl = fetch) {
  const province = dataset.tenant?.province;
  if (province === undefined) return true;
  const areas = await listAs(api, broker, 'owner', '/master-records', { master_type: 'AREA' }, fetchImpl);
  return areas.some((record) => record.business_key === province && record.status === 'EFFECTIVE');
}

/** Waits for the baseline (asking once a minute) up to `minutes`; true when it is there. */
export async function waitForBaseline(api, broker, dataset, minutes, { fetchImpl = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  for (let minute = 0; ; minute += 1) {
    if (await baselineReady(api, broker, dataset, fetchImpl)) return true;
    if (minute >= minutes) return false;
    if (minute % 10 === 0) log(`the master catalogue of the tenant has no province ${dataset.tenant.province} yet (the job master-baseline-sync runs every six hours): waiting, minute ${minute} of ${minutes}`);
    await sleep(60_000);
  }
}

/** The installation of a run, when `--credentials` is given: the credentials, the token broker, the directory of the run (plan, stack info, token cache) and what removes it. */
function installationOf(flags, dataset) {
  if (typeof flags.credentials !== 'string') return undefined;
  if (dataset.tenant === undefined) throw new Error(`the dataset ${flags.dataset} names no tenant: it cannot be loaded on an installation`);
  const credentials = readCredentials(flags.credentials);
  const problems = credentialProblems(credentials, requiredPeople(dataset));
  if (problems.length > 0) throw new Error(`the credentials cannot be used:\n${problems.join('\n')}`);
  const directory = mkdtempSync(join(tmpdir(), 'clip-seed-'));
  const cacheFile = join(directory, 'tokens.json');
  return { credentials, directory, cacheFile, broker: brokerOf(credentials, { cacheFile }), remove: () => rmSync(directory, { recursive: true, force: true }) };
}

async function commandPreflight(flags) {
  if (typeof flags.api !== 'string') throw new Error('--api <url> is required');
  const dataset = loadDataset(flags.dataset);
  const installation = installationOf(flags, dataset);
  if (installation === undefined) throw new Error('--credentials <file|-> is required (preflight is for an installation)');
  let failed = 0;
  const say = (ok, name, detail) => {
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}\n`);
  };
  try {
    for (const person of requiredPeople(dataset)) {
      try {
        await installation.broker.token(person);
        say(true, `sign-in of ${person}`, installation.credentials.people[person].username);
      } catch (error) {
        say(false, `sign-in of ${person}`, String(error?.message ?? error).slice(0, 200));
      }
    }
    try {
      const units = await listAs(flags.api, installation.broker, 'owner', '/resources/organization_unit');
      const info = installationInfo(dataset, installation.credentials, units);
      say(true, 'units of the dataset', `${Object.keys(info.units.A).length} of ${units.length} units of the tenant`);
    } catch (error) {
      say(false, 'units of the dataset', String(error?.message ?? error).slice(0, 300));
    }
    try {
      const ready = await baselineReady(flags.api, installation.broker, dataset);
      say(ready, 'master catalogue (platform baseline)', ready ? `province ${dataset.tenant.province} in force` : `no province ${dataset.tenant.province} yet: the job master-baseline-sync has not reached this tenant (every six hours after the workers start)`);
    } catch (error) {
      say(false, 'master catalogue (platform baseline)', String(error?.message ?? error).slice(0, 200));
    }
  } finally {
    installation.remove();
  }
  process.stdout.write(failed === 0 ? 'preflight passed\n' : `preflight FAILED (${failed})\n`);
  return failed === 0 ? 0 : 1;
}

function run(command, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('exit', (code) => resolveRun(code ?? 1));
    child.on('error', () => resolveRun(1));
  });
}

async function commandApply(flags) {
  if (typeof flags.api !== 'string') throw new Error('--api <url> is required');
  const dataset = loadDataset(flags.dataset);
  const plan = buildPlan(dataset);
  const problems = checkPlan(plan);
  if (problems.length > 0) throw new Error(`the plan is not sound:\n${problems.join('\n')}`);
  const installation = installationOf(flags, dataset);
  if (installation === undefined) requireKey();
  try {
    return await applyPlan(flags, dataset, plan, installation);
  } finally {
    installation?.remove();
  }
}

async function applyPlan(flags, dataset, plan, installation) {
  let stack;
  let childEnv = {};
  if (installation === undefined) stack = stackInfoOf(flags);
  else {
    // The installation is asked what the stack info file would say; the people sign in at the realm (the credentials go to the seed processes in their environment, never to a file).
    const wait = Number(flags['wait-baseline'] ?? 0);
    if (!(await waitForBaseline(flags.api, installation.broker, dataset, Number.isFinite(wait) ? wait : 0))) {
      process.stderr.write(`clip-seed: the master catalogue of the tenant has no province ${dataset.tenant.province} in force yet. The platform baseline reaches a new tenant when the worker job master-baseline-sync runs (every six hours after the workers started; do not restart them). Run again later, or give --wait-baseline <minutes>.\n`);
      return 3;
    }
    const units = await listAs(flags.api, installation.broker, 'owner', '/resources/organization_unit');
    const path = join(installation.directory, 'stack-info.json');
    writeFileSync(path, `${JSON.stringify(installationInfo(dataset, installation.credentials, units), null, 2)}\n`, 'utf8');
    stack = { path };
    childEnv = { CLIP_CREDENTIALS: JSON.stringify(installation.credentials), CLIP_TOKEN_CACHE: installation.cacheFile, E2E_SESSION_KEY: '' };
  }
  const planFile = join(dirname(stack.path), `clip-plan.${plan.variant ?? plan.dataset}.json`);
  // The seed groups are given the plan in the words of the guide; what they send is rewritten into the words of the dataset (planForSeeds).
  writeFileSync(planFile, `${JSON.stringify(planForSeeds(plan), null, 2)}\n`, 'utf8');
  const asked = typeof flags.groups === 'string' ? flags.groups.split(',').map((name) => name.trim()) : undefined;
  const phases = phasesFor(plan.dataset, asked);
  process.stdout.write(`applying dataset ${plan.variant ?? plan.dataset} (digest ${planDigest(plan)}) to ${flags.api}: ${phases.map((phase) => `[clock ${phase.clockDays} days: ${phase.groups.join(', ')}]`).join(' ')}\n`);
  let code = 0;
  try {
    for (const phase of phases) {
      await setClock(flags.api, phase.clockDays);
      code = await run(process.execPath, ['--experimental-strip-types', 'e2e/hdsd/seed/run.ts', '--groups', phase.groups.join(',')], {
        cwd: WEB,
        env: { ...process.env, ...(phase.env ?? {}), ...childEnv, CLIP_PLAN_FILE: planFile, CLIP_API_URL: flags.api, E2E_STACK_INFO: stack.path },
      });
      if (code !== 0) break;
    }
    if (code === 0 && plan.dataset === 'public' && asked === undefined) {
      process.stdout.write('sweep of the overdue advances (the clock of the stack at 06:30 for 30 seconds)\n');
      await sweepOverdueAdvances(flags.api);
    }
  } finally {
    // The clock of the stack always comes back to the real day, whatever happened.
    await setClock(flags.api, 0);
  }
  return code;
}

/**
 * The verdict of a verify with the checks the caller tolerates by name (`--tolerate "a,b"`): on an installation the clock cannot be moved, so what the dataset makes late on the
 * development stack (steps past their limit, advances past their recovery day) is not late there. A tolerated check that fails is printed as such and does not fail the run; a
 * tolerated name that matches no check is an error (a typo must not hide a failure).
 */
export function tolerated(verdict, names) {
  const known = new Set(verdict.results.map((result) => result.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`--tolerate names no check: ${unknown.join(', ')}`);
  const results = verdict.results.map((result) => (!result.ok && names.includes(result.name) ? { ...result, tolerated: true } : result));
  return { ok: results.length > 0 && results.every((result) => result.ok || result.tolerated === true), results };
}

async function commandVerify(flags) {
  if (typeof flags.api !== 'string') throw new Error('--api <url> is required');
  const dataset = loadDataset(flags.dataset);
  const plan = buildPlan(dataset);
  const installation = installationOf(flags, dataset);
  try {
    const reader =
      installation === undefined
        ? new ApiReader({ base: flags.api, key: requireKey(), tenantId: stackInfoOf(flags).info.tenants.A, fixturesPath: FIXTURES })
        : new ApiReader({ base: flags.api, tokenOf: (person) => installation.broker.token(person) });
    const checks = await verifyChecks(plan, reader);
    const names = typeof flags.tolerate === 'string' ? flags.tolerate.split(',').map((name) => name.trim()).filter((name) => name !== '') : [];
    const verdict = tolerated(judgeAll(checks), names);
    for (const result of verdict.results) process.stdout.write(`${result.ok ? 'ok  ' : result.tolerated === true ? 'tol ' : 'FAIL'} ${result.name}: ${result.detail}\n`);
    const waived = verdict.results.filter((result) => result.tolerated === true).length;
    process.stdout.write(verdict.ok ? `verify passed (${verdict.results.length} checks${waived === 0 ? '' : `, ${waived} tolerated by name`}, ${reader.calls} reads)\n` : 'verify FAILED\n');
    return verdict.ok ? 0 : 1;
  } finally {
    installation?.remove();
  }
}

export async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (command === 'plan') return commandPlan(flags);
  if (command === 'apply') return commandApply(flags);
  if (command === 'verify') return commandVerify(flags);
  if (command === 'preflight') return commandPreflight(flags);
  process.stderr.write('usage: node scripts/clip-seed.mjs plan|apply|verify|preflight --dataset camau|public|enterprise [--api <url>] [--stack-info <file>] [--credentials <file|->] [--wait-baseline <minutes>] [--tolerate "check,check"] [--groups a,b] [--out file]\n');
  return 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`clip-seed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
