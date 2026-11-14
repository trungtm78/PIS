#!/usr/bin/env node
// Prints a development session token of the e2e stack for one membership: the token the web application signs for `?devUser=<key>` (apps/web/src/session/dev-token.ts) and the browser tests
// send (apps/web/e2e/support/api.ts). It lives 300 seconds by default, so a run that lasts longer asks for a new one: this is the command for `node scripts/perf-budget.mjs --token-command`.
//
//   node scripts/dev-session-token.mjs --tenant <tenant id> --membership <membership id> [--ttl 300] [--scope-version 1]
//
// The signing key is read from E2E_SESSION_KEY (base64, the key the stack was started with) and never from the command line, so that it is in no process list. Local stacks only:
// a deployed environment has no development session and no such key.
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token of the claims under the key: `<base64url claims>.<base64url HMAC-SHA256>`. */
export function signDevSessionToken({ tenantId, membershipId, scopeVersion = 1, ttlSeconds = 300, nowMs = Date.now() }, keyBase64) {
  const payload = Buffer.from(JSON.stringify({ tenantId, membershipId, scopeVersion, exp: Math.floor(nowMs / 1000) + ttlSeconds }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(keyBase64, 'base64')).update(payload).digest('base64url')}`;
}

const USAGE = 'usage: E2E_SESSION_KEY=<base64 key of the stack> node scripts/dev-session-token.mjs --tenant <uuid> --membership <uuid> [--ttl <seconds>] [--scope-version <n>]';

export function main(argv, { env = process.env, log = console.log, nowMs = Date.now() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { tenant: { type: 'string' }, membership: { type: 'string' }, ttl: { type: 'string' }, 'scope-version': { type: 'string' } } }));
  } catch {
    log(USAGE);
    return 2;
  }
  const ttl = values.ttl === undefined ? 300 : Number(values.ttl);
  const scopeVersion = values['scope-version'] === undefined ? 1 : Number(values['scope-version']);
  const key = env.E2E_SESSION_KEY;
  if (!UUID.test(values.tenant ?? '') || !UUID.test(values.membership ?? '') || !(Number.isInteger(ttl) && ttl > 0) || !(Number.isInteger(scopeVersion) && scopeVersion >= 0)) {
    log(USAGE);
    return 2;
  }
  if (key === undefined || key === '') {
    log('E2E_SESSION_KEY is not set: it must be the key the stack was started with');
    return 2;
  }
  log(signDevSessionToken({ tenantId: values.tenant, membershipId: values.membership, scopeVersion, ttlSeconds: ttl, nowMs }, key));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
