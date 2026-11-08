import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, argument, positionals } from './common.mjs';
import { loadScenario } from './scenario.mjs';

/**
 * The data manifest of a clip: every figure of the scenario is READ from the running, seeded stack through the operation named in its `source`, with the path
 * of the answer in `select`. A value that cannot be read is left out of the manifest and listed as missing (the tools that need it stop: a figure is never invented).
 * The session key (E2E_SESSION_KEY) signs the development token of the stack; it is read from the environment and never written anywhere.
 */
const OPENAPI = resolve(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json');
const FIXTURES = resolve(REPO_ROOT, 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json');

/** `a.b[code=X].c[0].d` to a list of steps. */
export function parseSelect(select) {
  const steps = [];
  for (const part of select.split('.')) {
    const found = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]+\])*)$/u.exec(part);
    if (found === null) throw new Error(`cannot read the path ${select}`);
    steps.push({ key: found[1] });
    for (const bracket of found[2].matchAll(/\[([^\]]+)\]/gu)) {
      const text = bracket[1];
      const equal = text.indexOf('=');
      steps.push(equal < 0 ? { index: Number(text) } : { field: text.slice(0, equal), value: text.slice(equal + 1) });
    }
  }
  return steps;
}

/** The value a path points at in an answer; `undefined` when something on the way is missing. */
export function selectValue(answer, select) {
  let node = answer;
  for (const step of parseSelect(select)) {
    if (node === null || node === undefined) return undefined;
    if (step.key !== undefined) node = node[step.key];
    else if (step.index !== undefined) node = Array.isArray(node) ? node[step.index] : undefined;
    else node = Array.isArray(node) ? node.find((item) => String(item?.[step.field]) === step.value) : undefined;
  }
  return node;
}

export function tokenFor({ key, tenantId, membershipId, now = Date.now() }) {
  const payload = Buffer.from(JSON.stringify({ tenantId, membershipId, scopeVersion: 1, exp: Math.floor(now / 1000) + 600 }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64url')}`;
}

const operationIndex = () => {
  const index = {};
  for (const [path, methods] of Object.entries(JSON.parse(readFileSync(OPENAPI, 'utf8')).paths)) {
    for (const [method, operation] of Object.entries(methods)) if (operation?.operationId !== undefined) index[operation.operationId] = { method: method.toUpperCase(), path };
  }
  return index;
};

/**
 * Where the product really keeps a figure when the `source` of the scenario (written before the operations were built) names another place. The tiles of the command
 * center are keyed `metric_code` and hold decimal strings (money in dong); the contract reports are read by their codes; the concentration report keeps the
 * contractor dimension in a list. `scale` turns dong into billions. Nothing here invents a number: each entry is a path into an answer of the stack.
 */
const READERS = {
  'disb-rate-pm': { path: '/home/command-center', select: 'tiles[metric_code=DISBURSEMENT_RATE_PM].value' },
  'disb-rate-total': { path: '/home/command-center', select: 'tiles[metric_code=DISBURSEMENT_RATE_TOTAL].value' },
  'disbursed-treasury': { path: '/home/command-center', select: 'tiles[metric_code=DISBURSED_TREASURY].value', scale: 1e-9 },
  'ctr-count': { path: '/contracts/analytics/portfolio', select: 'totals.rows' },
  'ctr-value': { path: '/contracts/analytics/portfolio', select: 'totals.cells.contract_value_vnd', scale: 1e-9 },
  'price-gap-pct': { path: '/contracts/analytics/reports/bid-variance', select: 'totals.cells.bid_variance_pct' },
  hhi: { path: '/contracts/analytics/reports/contractor-concentration', select: 'dimensions[dimension=contractor].hhi.value' },
  'top5-share': { path: '/contracts/analytics/reports/contractor-concentration', select: 'dimensions[dimension=contractor].top_share.value' },
  'single-bid-rate': { path: '/contracts/analytics/reports/contractor-concentration', select: 'single_bidder.value' },
  'tree-median-days': { path: '/package-workflows/process-tree/node?node_id=ROOT', select: 'median_days' },
};

/** The requests that need more than the path: the report code, the node of the tree. Returns a list of candidates tried in order. */
function requestsFor(operationId, path, select) {
  const code = /rows\[code=([A-Z_]+)\]/u.exec(select)?.[1];
  if (operationId === 'getContractReport') return [path.replace('{code}', code ?? 'CONCENTRATION')];
  if (operationId === 'getPackageProcessTreeNode') return ['/package-workflows/process-tree/node?node_id=__first__'];
  if (operationId === 'get_resources_approval_task') return [`${path}?limit=50`];
  if (operationId === 'listEbsDifferences') return [`${path}?limit=50`];
  return [path];
}

async function getJson(base, headers, path) {
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) return { error: `${response.status}` };
  return { json: await response.json() };
}

/** Reads every figure of the scenario. Returns { figures: { id: { value, source, readAt } }, missing: [{ id, reason }] }. */
export async function buildManifest({ scenario, apiUrl, key, tenantId, membershipId, applyLog, log = console.log }) {
  const operations = operationIndex();
  const headers = { authorization: `Bearer ${tokenFor({ key, tenantId, membershipId })}` };
  const figures = {};
  const missing = [];
  const cache = new Map();
  let firstNode;
  for (const [id, declaration] of Object.entries(scenario.figures)) {
    const { operation, select } = declaration.source;
    const reader = READERS[id];
    // The counts of the dry run of the plan file are not kept by the product after the import (an import record keeps the counts of the applied rows): they are
    // the answer of the preview command, which the apply of the clip data printed; they are read from that log of the real run.
    const dryRun = id === 'egp-rows-valid' || id === 'egp-rows-error' ? /\[egp\] KHLCNT dry run (\{[^\n]*\})/u.exec(applyLog ?? '') : null;
    if (dryRun !== null) {
      const counts = JSON.parse(dryRun[1]);
      figures[id] = { value: id === 'egp-rows-valid' ? counts.valid : counts.errors, source: 'the dry run of the plan file (POST /egp/imports/preview), printed by the apply of the clip data' };
      log(`figure ${id} = ${figures[id].value}`);
      continue;
    }
    const spec = operations[operation];
    if (reader !== undefined) {
      if (!cache.has(reader.path)) cache.set(reader.path, await getJson(apiUrl, headers, reader.path));
      const answer = cache.get(reader.path);
      const found = answer.error === undefined ? selectValue(answer.json, reader.select) : undefined;
      if (found !== undefined && found !== null && !Number.isNaN(Number(found))) {
        figures[id] = { value: Math.round(Number(found) * (reader.scale ?? 1) * 1e4) / 1e4, source: `${reader.path} ${reader.select}` };
        log(`figure ${id} = ${figures[id].value}`);
      } else {
        missing.push({ id, reason: `${reader.path}: ${answer.error ?? 'not found'}` });
        log(`figure ${id}: MISSING`);
      }
      continue;
    }
    if (spec === undefined) {
      missing.push({ id, reason: `no operation ${operation}` });
      continue;
    }
    if (spec.method !== 'GET') {
      missing.push({ id, reason: `${operation} is a ${spec.method} (not read here)` });
      continue;
    }
    let value;
    let reason = 'not found in the answer';
    for (let path of requestsFor(operation, spec.path, select)) {
      if (path.includes('__first__')) {
        if (firstNode === undefined) {
          const tree = await getJson(apiUrl, headers, '/package-workflows/process-tree');
          const node = tree.json?.nodes?.find((item) => (item.count ?? item.package_count ?? 0) > 0) ?? tree.json?.nodes?.[0];
          firstNode = node?.id ?? node?.node_id ?? node?.code;
        }
        if (firstNode === undefined) {
          reason = 'the process tree has no node';
          continue;
        }
        path = path.replace('__first__', encodeURIComponent(firstNode));
      }
      if (!cache.has(path)) cache.set(path, await getJson(apiUrl, headers, path));
      const answer = cache.get(path);
      if (answer.error !== undefined) {
        reason = `${path}: HTTP ${answer.error}`;
        continue;
      }
      const found = selectValue(answer.json, select);
      if (found !== undefined && found !== null && !Number.isNaN(Number(found))) {
        value = Number(found);
        break;
      }
      if (declaration.kind === 'text' && typeof found === 'string') {
        value = found;
        break;
      }
    }
    if (value === undefined) {
      missing.push({ id, reason });
      log(`figure ${id}: MISSING (${reason})`);
    } else {
      figures[id] = { value, source: `${operation} ${select}` };
      log(`figure ${id} = ${value}`);
    }
  }
  return { clip: scenario.clip, figures, missing };
}

async function main(argv) {
  const [clip] = positionals(argv, ['api', 'user', 'out', 'tenant', 'apply-log']);
  const apiUrl = argument(argv, 'api');
  const out = argument(argv, 'out');
  const key = process.env.E2E_SESSION_KEY;
  if (clip === undefined || apiUrl === undefined || out === undefined || key === undefined) {
    console.error('usage: E2E_SESSION_KEY=... node scripts/clips/manifest.mjs <clip> --api http://127.0.0.1:47311 [--user capApprover] [--tenant <uuid>] --out data-manifest.json');
    return 2;
  }
  const users = JSON.parse(readFileSync(FIXTURES, 'utf8')).users;
  const user = users.find((candidate) => candidate.key === argument(argv, 'user', 'capApprover'));
  if (user === undefined) throw new Error('unknown user');
  const info = JSON.parse(readFileSync(process.env.E2E_STACK_INFO ?? 'D:/tmp/clipstack/stack-info.json', 'utf8'));
  const manifest = await buildManifest({ scenario: loadScenario(clip), apiUrl, key, tenantId: argument(argv, 'tenant', info.tenants.A), membershipId: user.membershipId, applyLog: argument(argv, 'apply-log') === undefined ? undefined : readFileSync(argument(argv, 'apply-log'), 'utf8') });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${clip}: ${Object.keys(manifest.figures).length} figures read, ${manifest.missing.length} missing`);
  return manifest.missing.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
