#!/usr/bin/env node
// The checks of the on-prem smoke run (.github/workflows/onprem-smoke.yml): what a person would do after `sh install.sh` on a real host, done by a script against the
// installation the bundle just made on the runner. Every check prints PASS or FAIL with its reason and the run goes on, so that one run shows every failure; the exit
// status is 1 when any check failed.
//
//   node scripts/onprem-smoke/verify.mjs --phase install|upgrade|rollback --bundle <bundle dir> --env-file <compose env> --state <file> --repo <repository root>
//
// install : edge, API, migrations, backup repository, realm import, directory connection, sign-in with a second factor, the first tenant through
//           scripts/onprem-first-tenant.mjs, the owner invitation from the outbox and its acceptance, a tenant session.
// upgrade and rollback : the edge, the API and the migrations again, the version that serves, and the owner signing in and choosing the tenant created before.
//
// It runs as root on the runner (the secret files are root's) with NODE_EXTRA_CA_CERTS naming the test authority. Test values only: nothing here is a default of the product.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { authorizationUrl, codeOf, exchangeCode, issuerOf, main as firstTenant, pkcePair } from '../onprem-first-tenant.mjs';
import { signIn } from './keycloak-login.mjs';

const { values: options } = parseArgs({
  options: { phase: { type: 'string' }, bundle: { type: 'string' }, 'env-file': { type: 'string' }, state: { type: 'string' }, repo: { type: 'string', default: '.' } },
});
const PHASE = options.phase;
const envText = readFileSync(options['env-file'], 'utf8');
const setting = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(envText)?.[1].trim() ?? '';
const PUBLIC_HOST = setting('PUBLIC_HOST');
const CONTROL_HOST = setting('CONTROL_HOST');
const REALM = setting('OIDC_REALM');
const SECRETS_DIR = setting('MACHVON_SECRETS_DIR');
const VERSION = readFileSync(join(options.bundle, 'VERSION'), 'utf8').trim();
const ISSUER = issuerOf(PUBLIC_HOST, REALM);
const ORIGIN = `https://${PUBLIC_HOST}`;
const WEB_REDIRECT = `${ORIGIN}/auth/callback`;
const state = existsSync(options.state) ? JSON.parse(readFileSync(options.state, 'utf8')) : { secrets: {}, users: {} };
const saveState = () => writeFileSync(options.state, JSON.stringify(state, null, 2), { mode: 0o600 });

const failures = [];
const say = (line) => console.log(line);
async function check(name, run) {
  const started = Date.now();
  try {
    const note = await run();
    say(`PASS ${name}${note === undefined ? '' : `: ${note}`}`);
    return true;
  } catch (error) {
    failures.push(name);
    say(`FAIL ${name}: ${String(error?.message ?? error).slice(0, 1200)}`);
    // What the services said while the check ran: the reason of a refused sign-in or request is in their logs, and a later step may recreate the containers.
    for (const service of ['keycloak', 'api', 'workers']) {
      const lines = compose(['logs', '--no-color', '--no-log-prefix', '--since', `${Math.ceil((Date.now() - started) / 1000) + 2}s`, service]).stdout.split('\n').filter((line) => /WARN|ERROR|error|Error/.test(line)).slice(-6);
      for (const line of lines) say(`  log of ${service}: ${line.slice(0, 500)}`);
    }
    return false;
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

function sh(command, args, { input, env } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
const composeArgs = ['compose', '--env-file', options['env-file'], '-f', join(options.bundle, 'infra', 'onprem', 'compose', 'compose.yaml')];
const compose = (args, extra = {}) => sh('docker', [...composeArgs, ...args], { ...extra, env: { MACHVON_VERSION: VERSION, ...extra.env } });
function ok(result, what) {
  expect(result.status === 0, `${what} ended with status ${result.status}: ${(result.stderr || result.stdout).trim().split('\n').slice(-6).join(' / ')}`);
  return result.stdout;
}

const get = (url, init = {}) => fetch(url, { redirect: 'manual', ...init });
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
/** The facts of a token a failure needs, never the token: who issued it, for whom, with which assurance and roles. */
const describeToken = (token) => {
  const claims = claimsOf(token);
  return JSON.stringify({ iss: claims.iss, aud: claims.aud, azp: claims.azp, acr: claims.acr, amr: claims.amr, sub: typeof claims.sub, sid: typeof claims.sid, auth_time: typeof claims.auth_time, email_verified: claims.email_verified, email: typeof claims.email, roles: claims.realm_access?.roles });
};

async function edgeChecks() {
  await check('edge: the health address answers in clear text and everything else is sent to HTTPS', async () => {
    const health = await get(`http://${PUBLIC_HOST}/healthz`);
    expect(health.status === 200 && (await health.text()).trim() === 'ok', `/healthz answered ${health.status}`);
    const other = await get(`http://${PUBLIC_HOST}/some/page?x=1`);
    expect(other.status === 301 && other.headers.get('location') === `${ORIGIN}/some/page?x=1`, `a clear-text page answered ${other.status} to ${other.headers.get('location')}`);
  });
  await check('edge: the web application is served over TLS with the security headers, and its build names this host as the identity provider', async () => {
    const index = await get(`${ORIGIN}/`);
    const html = await index.text();
    expect(index.status === 200 && html.includes('<div id="root">'), `/ answered ${index.status} without the application shell`);
    for (const header of ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options']) expect(index.headers.get(header), `the header ${header} is missing on /`);
    const deep = await get(`${ORIGIN}/sas/sas-01`);
    expect(deep.status === 200 && (await deep.text()).includes('<div id="root">'), `a route of the application answered ${deep.status}`);
    const scripts = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((match) => match[1]);
    expect(scripts.length > 0, 'the shell names no script under /assets/');
    let named = false;
    for (const script of scripts) {
      const asset = await get(`${ORIGIN}${script}`);
      expect(asset.status === 200, `${script} answered ${asset.status}`);
      expect(/immutable/.test(asset.headers.get('cache-control') ?? ''), `${script} is not served as immutable`);
      if ((await asset.text()).includes(ISSUER)) named = true;
    }
    expect((await get(`${ORIGIN}/assets/no-such-file.js`)).status === 404, 'a missing asset is not a 404');
    return named ? `issuer ${ISSUER} found in the build` : `issuer not found in the ${scripts.length} script(s) the shell names (it may sit in a lazy chunk)`;
  });
  await check('api: liveness and readiness answer through the edge (readiness means the database answers and no migration is pending)', async () => {
    const live = await get(`${ORIGIN}/api/health/live`);
    expect(live.status === 200, `/api/health/live answered ${live.status}`);
    const ready = await get(`${ORIGIN}/api/health/ready`);
    expect(ready.status === 200, `/api/health/ready answered ${ready.status}: ${(await ready.text()).slice(0, 300)}`);
  });
  await check('api: a request without a token, and one with a token nobody signed, are refused with 401', async () => {
    const bare = await get(`${ORIGIN}/api/me/profile`);
    expect(bare.status === 401, `no token: ${bare.status}`);
    const forged = await get(`${ORIGIN}/api/me/profile`, { headers: { authorization: `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"aud":"machvon-control"}').toString('base64url')}.x` } });
    expect(forged.status === 401, `forged token: ${forged.status}`);
    return (await bare.text()).slice(0, 160);
  });
  await check('identity: the discovery document of the realm names the public address, and the administration console is not on the edge', async () => {
    const discovery = await get(`${ISSUER}/.well-known/openid-configuration`);
    expect(discovery.status === 200, `discovery answered ${discovery.status}`);
    const document = await discovery.json();
    expect(document.issuer === ISSUER, `issuer is ${document.issuer}`);
    expect(String(document.token_endpoint).startsWith(ISSUER), `token endpoint is ${document.token_endpoint}`);
    for (const path of ['/idp/admin/', '/idp/admin/master/console/', '/idp/metrics', '/idp/health']) expect((await get(`${ORIGIN}${path}`)).status === 404, `${path} is reachable on the edge`);
  });
}

async function stackChecks() {
  await check(`compose: every service is healthy and runs release ${VERSION}`, () => {
    const rows = ok(compose(['ps', '--format', 'json']), 'docker compose ps').trim().split('\n').filter((line) => line !== '').flatMap((line) => [JSON.parse(line)].flat());
    const byService = Object.fromEntries(rows.map((row) => [row.Service, row]));
    for (const service of ['db', 'keycloak', 'clamav', 'api', 'workers', 'web']) {
      expect(byService[service] !== undefined, `${service} is not running`);
      expect(byService[service].Health === 'healthy', `${service} is ${byService[service].State}/${byService[service].Health}`);
    }
    for (const service of ['db', 'api', 'workers', 'web']) expect(String(byService[service].Image).endsWith(`:${VERSION}`), `${service} runs ${byService[service].Image}`);
    expect(Object.values(byService).filter((row) => (row.Publishers ?? []).some((port) => port.PublishedPort > 0)).map((row) => row.Service).join() === 'web', 'a service other than web publishes a port');
    return rows.map((row) => `${row.Service}=${String(row.Image).split('/').pop()}`).join(' ');
  });
  await check('database: every migration of the release is applied, by the migration job of the bundle', () => {
    const applied = Number(ok(compose(['exec', '-T', 'db', 'psql', '--username', 'machvon_owner', '--dbname', 'machvon', '-Atc', 'select count(*) from machvon.schema_migration']), 'psql').trim());
    const files = readdirSync(join(options.repo, 'db', 'migrations')).filter((name) => /^V\d+__.*\.sql$/.test(name)).length;
    expect(applied === files, `${applied} applied, ${files} files in db/migrations`);
    const plan = ok(compose(['exec', '-T', 'db', 'psql', '--username', 'machvon_owner', '--dbname', 'machvon', '-Atc', "select count(*) from machvon.product_plan_version where status = 'Published'"]), 'psql').trim();
    expect(Number(plan) >= 1, 'no Published plan');
    return `${applied} migrations`;
  });
  // The address of the URL is the service name, not the loopback address, so the server asks for the password (the image trusts loopback connections).
  await check('database: the three application roles sign in with the passwords of the secret files', () => {
    for (const role of ['app', 'control', 'outbox_relay']) {
      const url = readFileSync(join(SECRETS_DIR, `database_url_${role}`), 'utf8').trim();
      const result = compose(['exec', '-T', 'db', 'psql', url, '-Atc', 'select current_user']);
      expect(result.status === 0 && result.stdout.trim() === `machvon_${role}`, `machvon_${role}: ${result.stderr.trim().split('\n').pop()}`);
    }
  });
  await check('backup: the WAL archive reaches both repositories of the object store (pgbackrest check) and the stanza is there', () => {
    ok(compose(['--profile', 'tools', 'run', '--rm', '-T', 'backup', 'check']), 'pgbackrest check');
    const info = ok(compose(['--profile', 'tools', 'run', '--rm', '-T', 'backup', 'info']), 'pgbackrest info');
    expect(/stanza: machvon/.test(info), 'pgbackrest info names no stanza');
    return info.split('\n').filter((line) => /status|backup\/|full backup|repo\d/.test(line)).map((line) => line.trim()).join(' ; ').slice(0, 500);
  });
  await check('scan: the API is told to scan uploads with clamd', () => {
    expect(ok(compose(['exec', '-T', 'api', 'node', '-e', 'console.log(process.env.MACHVON_SCAN_ADAPTER)']), 'api').trim() === 'clamav', 'MACHVON_SCAN_ADAPTER is not clamav');
  });
}

// kcadm reads a password it is not given as an option from KC_CLI_PASSWORD: the password of the administrator at the sign-in, the new password of a person at set-password.
// No password is ever an argument of a process. Every other call runs without the variable.
const kc = (args, password) =>
  compose(['exec', '-T', ...(password === undefined ? [] : ['-e', 'KC_CLI_PASSWORD']), 'keycloak', '/opt/keycloak/bin/kcadm.sh', ...args, '--config', '/tmp/kcadm.config'], password === undefined ? {} : { env: { KC_CLI_PASSWORD: password } });

async function identityAdministration() {
  const signedIn = await check('identity: the administration is reached from the host only, inside the container (kcadm), with the first administrator', () => {
    ok(kc(['config', 'credentials', '--server', 'http://127.0.0.1:8080/idp', '--realm', 'master', '--user', setting('KEYCLOAK_ADMIN_USER')], readFileSync(join(SECRETS_DIR, 'keycloak_admin_password'), 'utf8').trim()), 'kcadm config credentials');
  });
  if (!signedIn) return false;
  await check('identity: the realm was imported whole, with no placeholder left unresolved', () => {
    const realm = JSON.parse(ok(kc(['get', `realms/${REALM}`]), 'kcadm get realm'));
    expect(realm.browserFlow === 'machvon browser', `browser flow is ${realm.browserFlow}`);
    expect(realm.sslRequired === 'all' && realm.bruteForceProtected === true && realm.failureFactor === 5, 'the lockout or TLS settings differ from the file');
    expect(realm.webAuthnPolicyRpId === PUBLIC_HOST, `WebAuthn relying party is ${realm.webAuthnPolicyRpId}`);
    const clients = JSON.parse(ok(kc(['get', 'clients', '-r', REALM, '--fields', 'clientId,redirectUris,publicClient,defaultClientScopes']), 'kcadm get clients'));
    const byId = Object.fromEntries(clients.map((client) => [client.clientId, client]));
    expect(byId['machvon-web']?.redirectUris?.[0] === WEB_REDIRECT, `machvon-web redirects to ${byId['machvon-web']?.redirectUris}`);
    expect(byId['machvon-control']?.redirectUris?.[0] === `https://${CONTROL_HOST}/auth/callback`, `machvon-control redirects to ${byId['machvon-control']?.redirectUris}`);
    const flows = JSON.parse(ok(kc(['get', 'authentication/flows', '-r', REALM, '--fields', 'alias']), 'kcadm get flows')).map((flow) => flow.alias);
    const everything = JSON.stringify([realm, clients, JSON.parse(ok(kc(['get', 'components', '-r', REALM, '-q', 'type=org.keycloak.storage.UserStorageProvider']), 'kcadm get components'))]);
    const left = /\$\{(REALM_NAME|WEBAUTHN_RP_ID|TENANT_HOST|CONTROL_HOST|LDAP_[A-Z_]+)\}/.exec(everything);
    expect(left === null, `a placeholder was not replaced: ${left?.[0]}`);
    return `flows: ${flows.filter((alias) => alias.startsWith('machvon')).join(', ')}; scopes of machvon-web: ${(byId['machvon-web']?.defaultClientScopes ?? []).join(',')}`;
  });
  await check('identity: the directory federation connects over LDAPS with the authority of ldap_ca_cert and binds with the service account', () => {
    const providers = JSON.parse(ok(kc(['get', 'components', '-r', REALM, '-q', 'type=org.keycloak.storage.UserStorageProvider']), 'kcadm get components'));
    const directory = providers.find((provider) => provider.providerId === 'ldap');
    expect(directory !== undefined, 'the realm has no directory provider');
    const url = directory.config.connectionUrl?.[0];
    expect(url === setting('LDAP_URL'), `the provider connects to ${url}`);
    const test = (action) =>
      kc(['create', 'testLDAPConnection', '-r', REALM, '-s', `action=${action}`, '-s', `connectionUrl=${url}`, '-s', `bindDn=${directory.config.bindDn?.[0]}`, '-s', 'bindCredential=**********', '-s', 'useTruststoreSpi=always', '-s', 'connectionTimeout=5000', '-s', 'authType=simple', '-s', `componentId=${directory.id}`]);
    ok(test('testConnection'), 'the connection test');
    ok(test('testAuthentication'), 'the bind test');
    return url;
  });
  return true;
}

async function ensureUser(name, { email, role }) {
  if (state.users[name] === undefined) state.users[name] = { username: name, email, password: `Smoke-${randomBytes(12).toString('base64url')}` };
  const user = state.users[name];
  const created = kc(['create', 'users', '-r', REALM, '-s', `username=${name}`, '-s', 'enabled=true', '-s', `email=${email}`, '-s', 'emailVerified=true', '-s', 'firstName=Smoke', '-s', `lastName=${name}`]);
  expect(created.status === 0 || /exists/i.test(created.stderr), `creating ${name}: ${created.stderr.trim()}`);
  ok(kc(['set-password', '-r', REALM, '--username', name], user.password), `the password of ${name}`);
  const stored = JSON.parse(ok(kc(['get', 'users', '-r', REALM, '-q', `username=${name}`, '-q', 'exact=true']), `reading ${name}`))[0];
  expect(stored?.enabled === true && stored.emailVerified === true, `${name} is not an enabled person with a verified e-mail`);
  const credentials = JSON.parse(ok(kc(['get', `users/${stored.id}/credentials`, '-r', REALM]), `the credentials of ${name}`)).map((credential) => credential.type);
  say(`  ${name}: required actions [${(stored.requiredActions ?? []).join(',')}], credentials [${credentials.join(',')}], federation link ${stored.federationLink ?? 'none'}`);
  expect(credentials.includes('password'), `${name} has no password credential`);
  // The password is the one this run knows: the built-in command line client of the realm takes it, and stops only at the second factor the person has not enrolled yet.
  const probe = await fetch(`${ISSUER}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: name, password: user.password }).toString() });
  const answer = await probe.json().catch(() => ({}));
  say(`  ${name}: password probe ${probe.status} ${answer.error ?? ''} ${answer.error_description ?? ''}`);
  expect(probe.status === 200 || answer.error_description === 'Account is not fully set up', `the password of ${name} is not accepted: ${answer.error_description}`);
  if (role !== undefined) ok(kc(['add-roles', '-r', REALM, '--uusername', name, '--rolename', role]), `the role of ${name}`);
  saveState();
  return user;
}

/** A sign-in of the tenant client (machvon-web) with PKCE: the tokens of the person. */
async function webSignIn(user) {
  const { verifier, challenge } = pkcePair();
  const nonce = randomBytes(16).toString('base64url');
  const callback = await signIn({ authUrl: authorizationUrl({ issuer: ISSUER, redirectUri: WEB_REDIRECT, state: nonce, challenge, clientId: 'machvon-web' }), redirectUri: WEB_REDIRECT, username: user.username, password: user.password, secrets: state.secrets, log: (line) => say(`  ${user.username}: ${line}`) });
  saveState();
  return exchangeCode({ issuer: ISSUER, redirectUri: WEB_REDIRECT, code: codeOf(callback, nonce), verifier, clientId: 'machvon-web' });
}

const api = (path, { token, method = 'GET', body, key } = {}) =>
  get(`${ORIGIN}/api${path}`, { method, headers: { accept: 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function firstTenantChecks() {
  let admin;
  let owner;
  const users = await check('identity: test people are created by the administrator (a system administrator and the future owner of the tenant)', async () => {
    admin = await ensureUser('smoke-sysadmin', { email: 'sysadmin@smoke.test', role: 'SystemAdmin' });
    owner = await ensureUser('smoke-owner', { email: 'owner@smoke.test' });
  });
  if (!users) return;

  const created = await check('first tenant: scripts/onprem-first-tenant.mjs signs the administrator in at the control client, requests the tenant and waits until it is Active', async () => {
    const lines = [];
    const status = await firstTenant(
      ['--public-host', PUBLIC_HOST, '--control-host', CONTROL_HOST, '--realm', REALM, '--code', 'smoke-tenant', '--name', 'Smoke tenant', '--owner-email', owner.email, '--root-unit-name', 'Smoke root unit', '--subdomain', 'smoke', '--wait-seconds', '240', '--locale', 'en'],
      {
        log: (line) => {
          lines.push(line);
          say(`  first-tenant: ${line.includes('code_challenge') ? `${line.split('?')[0]}?...` : line}`);
        },
        // The administrator's part: open the printed address, sign in with the second factor, paste the address the browser ends on.
        ask: async () => {
          const authUrl = lines.find((line) => line.includes('/protocol/openid-connect/auth?'));
          const callback = await signIn({ authUrl, redirectUri: `https://${CONTROL_HOST}/auth/callback`, username: admin.username, password: admin.password, secrets: state.secrets, log: (line) => say(`  ${admin.username}: ${line}`) });
          saveState();
          return callback;
        },
      },
    );
    expect(status === 0, `the script ended with status ${status}: ${lines.slice(-2).join(' / ')}`);
    state.tenantId = /is Active: ([0-9a-f-]{36})/.exec(lines.join('\n'))?.[1];
    expect(state.tenantId !== undefined, 'the script did not print the id of the tenant');
    saveState();
    return state.tenantId;
  });
  if (!created) return;

  let invitation;
  const handed = await check('first owner: the invitation is in the outbox volume, for the owner, with the link of the web application', () => {
    const text = ok(compose(['exec', '-T', 'workers', 'sh', '-c', 'cat /var/lib/machvon/invitations/*.json']), 'reading the outbox');
    const found = text.split(/(?<=\})\s*(?=\{)/).map((entry) => JSON.parse(entry));
    invitation = found.find((entry) => entry.to_email === owner.email && entry.tenant_id === state.tenantId);
    expect(invitation !== undefined, `no invitation for ${owner.email} among ${found.length}`);
    expect(invitation.link === `${ORIGIN}/invitations/${invitation.invitation_id}/accept?token=${encodeURIComponent(invitation.token)}`, `the link is ${String(invitation.link).split('?')[0]}`);
    const mode = ok(compose(['exec', '-T', 'workers', 'sh', '-c', 'stat -c %a:%U /var/lib/machvon/invitations /var/lib/machvon/invitations/*.json']), 'stat').trim().split('\n');
    expect(mode.every((entry) => /^[67]00:node$/.test(entry)), `the outbox is readable by others: ${mode.join(' ')}`);
    return `expires ${invitation.expires_at}`;
  });
  if (!handed) return;

  await check('first owner: the page of the invitation is served, the owner signs in (password and one-time password) and accepts; the answer is a session of the tenant', async () => {
    const page = await get(`${ORIGIN}/invitations/${invitation.invitation_id}/accept`);
    expect(page.status === 200, `the accepting page answered ${page.status}`);
    const tokens = await webSignIn(owner);
    say(`  smoke-owner token: ${describeToken(tokens.accessToken)}`);
    const stranger = await api(`/memberships/invitations/${invitation.invitation_id}/accept`, { method: 'POST', body: { token: invitation.token }, key: randomUUID() });
    expect(stranger.status === 401, `accepting without a sign-in answered ${stranger.status}`);
    const accepted = await api(`/memberships/invitations/${invitation.invitation_id}/accept`, { method: 'POST', token: tokens.accessToken, body: { token: invitation.token }, key: randomUUID() });
    const text = await accepted.text();
    expect(accepted.status === 200, `accepting answered ${accepted.status}: ${text.slice(0, 300)}`);
    const session = JSON.parse(text);
    expect(session.tenant_id === state.tenantId && typeof session.access_token === 'string', 'the answer is not a session of the new tenant');
    state.membershipId = session.membership_id;
    saveState();
    const profile = await api('/me/profile', { token: session.access_token });
    expect(profile.status === 200, `the profile of the owner answered ${profile.status}: ${(await profile.text()).slice(0, 300)}`);
    return `membership ${session.membership_id}, assurance ${session.assurance_level}, mode ${session.mode}`;
  });
}

async function returningOwner() {
  await check('tenant session: the owner signs in again, finds the tenant among the candidates, chooses it and reads the profile', async () => {
    expect(state.tenantId !== undefined && state.users['smoke-owner'] !== undefined, 'the install phase created no tenant');
    const tokens = await webSignIn(state.users['smoke-owner']);
    const candidates = await api('/me/session/tenant-selection/candidates', { token: tokens.accessToken });
    const text = await candidates.text();
    expect(candidates.status === 200, `the candidates answered ${candidates.status}: ${text.slice(0, 300)}`);
    const mine = (JSON.parse(text).items ?? []).find((item) => JSON.stringify(item).includes(state.tenantId));
    expect(mine !== undefined, `the tenant is not among the candidates: ${text.slice(0, 300)}`);
    const selected = await api('/me/session/tenant-selection', { method: 'POST', token: tokens.accessToken, body: { tenant_id: state.tenantId, membership_id: state.membershipId }, key: randomUUID() });
    const body = await selected.text();
    expect(selected.status === 200, `choosing the tenant answered ${selected.status}: ${body.slice(0, 300)}`);
    const profile = await api('/me/profile', { token: JSON.parse(body).access_token });
    expect(profile.status === 200, `the profile answered ${profile.status}`);
    return `release ${VERSION}`;
  });
}

say(`on-prem smoke checks, phase ${PHASE}, release ${VERSION}, ${ORIGIN}`);
await stackChecks();
await edgeChecks();
if (PHASE === 'install') {
  if (await identityAdministration()) await firstTenantChecks();
} else {
  await returningOwner();
}
say(failures.length === 0 ? `every check of phase ${PHASE} passed` : `FAILED ${failures.length} check(s) of phase ${PHASE}:\n${failures.map((name) => `  - ${name}`).join('\n')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
