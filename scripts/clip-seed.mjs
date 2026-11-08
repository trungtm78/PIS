#!/usr/bin/env node
// The seed layer of the two intro clips. Usage (from the repository root):
//   node scripts/clip-seed.mjs plan   --dataset public|enterprise [--out plan.json]
//   node scripts/clip-seed.mjs apply  --dataset public|enterprise --api <url> [--stack-info <file>] [--groups a,b]
//   node scripts/clip-seed.mjs verify --dataset public|enterprise --api <url> [--stack-info <file>]
// `apply` runs the real commands of the product (apps/web/e2e/hdsd/seed groups) against a running API; it never writes to a database.
// The session key of the stack comes from E2E_SESSION_KEY (local environment only).

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiReader } from './clip-seed-client.mjs';
import { DATASETS, DATASET_GROUPS, buildPlan, phasesFor, checkPlan, judgeAll, parseArgs, planDigest } from './clip-seed-lib.mjs';
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
  process.stdout.write(`dataset ${plan.dataset} seed ${plan.seed} digest ${planDigest(plan)}\n`);
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

function run(command, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('exit', (code) => resolveRun(code ?? 1));
    child.on('error', () => resolveRun(1));
  });
}

async function commandApply(flags) {
  if (typeof flags.api !== 'string') throw new Error('--api <url> is required');
  requireKey();
  const dataset = loadDataset(flags.dataset);
  const plan = buildPlan(dataset);
  const problems = checkPlan(plan);
  if (problems.length > 0) throw new Error(`the plan is not sound:\n${problems.join('\n')}`);
  const stack = stackInfoOf(flags);
  const planFile = join(dirname(stack.path), `clip-plan.${plan.dataset}.json`);
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  const asked = typeof flags.groups === 'string' ? flags.groups.split(',').map((name) => name.trim()) : undefined;
  const phases = phasesFor(plan.dataset, asked);
  process.stdout.write(`applying dataset ${plan.dataset} (digest ${planDigest(plan)}) to ${flags.api}: ${phases.map((phase) => `[clock ${phase.clockDays} days: ${phase.groups.join(', ')}]`).join(' ')}\n`);
  let code = 0;
  try {
    for (const phase of phases) {
      await setClock(flags.api, phase.clockDays);
      code = await run(process.execPath, ['--experimental-strip-types', 'e2e/hdsd/seed/run.ts', '--groups', phase.groups.join(',')], {
        cwd: WEB,
        env: { ...process.env, CLIP_PLAN_FILE: planFile, CLIP_API_URL: flags.api, E2E_STACK_INFO: stack.path },
      });
      if (code !== 0) break;
    }
  } finally {
    // The clock of the stack always comes back to the real day, whatever happened.
    await setClock(flags.api, 0);
  }
  return code;
}

async function commandVerify(flags) {
  if (typeof flags.api !== 'string') throw new Error('--api <url> is required');
  const key = requireKey();
  const dataset = loadDataset(flags.dataset);
  const plan = buildPlan(dataset);
  const stack = stackInfoOf(flags);
  const reader = new ApiReader({ base: flags.api, key, tenantId: stack.info.tenants.A, fixturesPath: FIXTURES });
  const checks = await verifyChecks(plan, reader);
  const verdict = judgeAll(checks);
  for (const result of verdict.results) process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}: ${result.detail}\n`);
  process.stdout.write(verdict.ok ? `verify passed (${verdict.results.length} checks, ${reader.calls} reads)\n` : 'verify FAILED\n');
  return verdict.ok ? 0 : 1;
}

export async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (command === 'plan') return commandPlan(flags);
  if (command === 'apply') return commandApply(flags);
  if (command === 'verify') return commandVerify(flags);
  process.stderr.write('usage: node scripts/clip-seed.mjs plan|apply|verify --dataset public|enterprise [--api <url>] [--stack-info <file>] [--groups a,b] [--out file]\n');
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
