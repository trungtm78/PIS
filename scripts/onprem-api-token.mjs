#!/usr/bin/env node
// Prints an access token of the API of an on-prem installation for ONE person of the realm, for a script that calls the API (a data load, an acceptance run).
//
//   node scripts/onprem-api-token.mjs --account <account.json> [--client machvon-web] [--identity-only]
//   ssh <server> "type <account.json>" | node scripts/onprem-api-token.mjs --account -
//
// The account file (kept on the server, readable by its administrators only; `-` reads it from the standard input so that it never lands on this machine):
//   { "origin": "https://host:8443", "username", "password", "totpSecret", "tenantId", "membershipId" }
//
// How the token is obtained, which is the only way the realm offers (it has no password grant and no client secret; every sign-in asks for the second factor):
//   1 OAuth 2.0 authorization code with PKCE (S256) at the public client `machvon-web`, redirect https://<host>/auth/callback: the sign-in pages of Keycloak are
//     answered as a browser would (user name and password, then the one-time password computed from `totpSecret`, RFC 6238);
//   2 the code is exchanged at <origin>/idp/realms/machvon/protocol/openid-connect/token: this is the IDENTITY token (audience machvon-api, acr aal2, five minutes);
//   3 POST <origin>/api/me/session/tenant-selection { tenant_id, membership_id } with the identity token gives the TENANT token every tenant route asks for
//     (`Authorization: Bearer <token>`); a command also sends `Idempotency-Key`, and `If-Match: "<version>"` where the operation is versioned.
// Only the token is written to the standard output; `--json` writes { access_token, expires_in, tenant_id, membership_id } instead. A token lives minutes:
// call this again when the API answers 401.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { authorizationUrl, codeOf, exchangeCode, pkcePair } from './onprem-first-tenant.mjs';
import { signIn } from './onprem-smoke/keycloak-login.mjs';

/** What is wrong with an account file, as the names of its fields; empty when it can be used. */
export function accountProblems(account, { identityOnly = false } = {}) {
  const wrong = [];
  if (typeof account?.origin !== 'string' || !/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(account.origin)) wrong.push('origin');
  for (const name of ['username', 'password', 'totpSecret']) if (typeof account?.[name] !== 'string' || account[name] === '') wrong.push(name);
  if (!identityOnly) for (const name of ['tenantId', 'membershipId']) if (typeof account?.[name] !== 'string' || !/^[0-9a-f-]{36}$/i.test(account[name])) wrong.push(name);
  return wrong;
}

/** The tokens of the person: `identity` always, `tenant` unless `identityOnly`. */
export async function tokensOf(account, { clientId = 'machvon-web', realm = 'machvon', identityOnly = false, fetch = globalThis.fetch, sleep } = {}) {
  const issuer = `${account.origin}/idp/realms/${realm}`;
  const redirectUri = `${account.origin}/auth/callback`;
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');
  const callback = await signIn({
    authUrl: authorizationUrl({ issuer, redirectUri, state, challenge, clientId }),
    redirectUri,
    username: account.username,
    password: account.password,
    secrets: { [account.username]: { secret: account.totpSecret } },
    fetch,
    ...(sleep === undefined ? {} : { sleep }),
  });
  const identity = await exchangeCode({ issuer, redirectUri, code: codeOf(callback, state), verifier, clientId, fetch });
  if (identityOnly) return { identity: identity.accessToken };
  const response = await fetch(`${account.origin}/api/me/session/tenant-selection`, {
    method: 'POST',
    headers: { authorization: `Bearer ${identity.accessToken}`, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ tenant_id: account.tenantId, membership_id: account.membershipId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== 'string') throw new Error(`the tenant session was refused: ${response.status} ${body.code ?? ''}`.trim());
  return { identity: identity.accessToken, tenant: body.access_token, expiresIn: body.expires_in };
}

export async function main(argv, { log = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`), read = (path) => readFileSync(path === '-' ? 0 : path, 'utf8'), fetch = globalThis.fetch, sleep } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { account: { type: 'string' }, client: { type: 'string', default: 'machvon-web' }, 'identity-only': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } }, allowPositionals: false }));
  } catch (failure) {
    error(`onprem-api-token: ${failure.message}`);
    return 2;
  }
  if (typeof values.account !== 'string' || values.account === '') {
    error('onprem-api-token: --account <file> is required (- reads the standard input)');
    return 2;
  }
  let account;
  try {
    const text = read(values.account);
    account = JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    error('onprem-api-token: the account file cannot be read as JSON');
    return 2;
  }
  const wrong = accountProblems(account, { identityOnly: values['identity-only'] });
  if (wrong.length > 0) {
    error(`onprem-api-token: the account file misses or has a wrong: ${wrong.join(', ')}`);
    return 2;
  }
  try {
    const tokens = await tokensOf(account, { clientId: values.client, identityOnly: values['identity-only'], fetch, ...(sleep === undefined ? {} : { sleep }) });
    const token = tokens.tenant ?? tokens.identity;
    log(values.json ? JSON.stringify({ access_token: token, expires_in: tokens.expiresIn, tenant_id: account.tenantId, membership_id: account.membershipId }) : token);
    return 0;
  } catch (failure) {
    // The message of a failed sign-in names the page of the identity provider, never the password or the secret.
    error(`onprem-api-token: FAILED ${String(failure?.message ?? failure).slice(0, 400)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
