// The tenant of a DEMO installation, made through the official paths of the product, without a browser and without a statement against the business database:
//   1 the tenant owner signs in (the account first-accounts.mjs or the operator made: `--owner`), and the units of the input are created under the root unit
//     (createOrganizationUnit; the root unit takes the code and the name of the input);
//   2 the unit roles of the input are created (createCustomRole);
//   3 every other person of the input is created in the realm (administration API of Keycloak, inside the compose network) with a random password and a one-time
//     password credential, invited by the owner into their unit with their roles (inviteMember; more than five roles: grantRole), and accepts the invitation.
// The input has no secret: scripts/demo-tenant-input.mjs writes it from a demo dataset (the units, roles and people the seed commands of `clip-seed apply` need).
// The result is ONE file, readable by administrators of the host only (`--output`): the credentials `node scripts/clip-seed.mjs ... --credentials -` reads, and for each
// person the user name, the password and the secret of the one-time password (with the otpauth:// address an authenticator application imports).
//
//   demo-tenant.mjs --input C:\run\admin\demo-tenant.input.json --owner C:\run\admin\demo-account.json --output C:\run\admin\demo-credentials.json --invitations C:\data\invitations
//
// It can be run again: what the output file says is done is not done twice, and a unit or a role that exists is left as it is. Nothing secret is printed.
// host\demo-tenant.ps1 runs this file with the Node of the api image in a one-shot container.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readInvitations } from './first-accounts.mjs';
import { KeycloakAdmin, newTotpSecret, otpauthOf } from './keycloak-admin.mjs';
import { authorizationUrl, codeOf, exchangeCode, issuerOf, pkcePair } from '../../../scripts/onprem-first-tenant.mjs';
import { signIn } from '../../../scripts/onprem-smoke/keycloak-login.mjs';

const WEB_CLIENT = 'machvon-web';
/** inviteMember takes at most this many grants; the rest are given with grantRole after the person accepted. */
export const INVITATION_GRANT_LIMIT = 5;
const GRANT_REASON = 'Vai trò của người dùng minh họa trong tenant demo';

export class DemoError extends Error {}

/**
 * A password a person can type at a demonstration: thirteen letters and digits without look-alikes (no 0 O 1 l I), with a lower-case letter, an upper-case letter and a digit.
 * Random (about 74 bits); the accounts of a demonstration are handed over on paper and typed by hand.
 */
export function newDemoPassword(random = randomBytes) {
  const classes = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
  const all = classes.join('');
  for (;;) {
    let text = '';
    for (const byte of random(64)) if (byte < 216 && text.length < 13) text += all[byte % 54];
    if (text.length === 13 && classes.every((letters) => [...text].some((letter) => letters.includes(letter)))) return text;
  }
}

/**
 * The account of the tenant owner from the file given as `--owner`: either the account itself ({ origin, username, password, totpSecret, tenantId, membershipId }) or the
 * output of first-accounts.mjs, where the owner of the input is looked up among its people.
 */
export function ownerOf(file, input) {
  if (typeof file?.people !== 'object' || file.people === null) return file;
  const username = input?.people?.find?.((person) => person.owner === true)?.username;
  const entry = file.people[username];
  if (entry === undefined) return { origin: file.origin, tenantId: file.tenantId };
  return { origin: file.origin, tenantId: file.tenantId, username: entry.username, password: entry.password, totpSecret: entry.totpSecret, membershipId: entry.membershipId, ...(entry.otpauth === undefined ? {} : { otpauth: entry.otpauth }) };
}

/** What is wrong with the input and the owner account, as sentences; empty when they can be used. */
export function inputProblems(input, owner) {
  const problems = [];
  if (input?.schema !== 'demo-tenant-input/1') problems.push('the input is not a demo-tenant-input/1 file (scripts/demo-tenant-input.mjs writes it)');
  for (const name of ['units', 'roles', 'people']) if (!Array.isArray(input?.[name])) problems.push(`the input has no ${name}`);
  if (problems.length > 0) return problems;
  const owners = input.people.filter((person) => person.owner === true);
  if (owners.length !== 1) problems.push('the input must name exactly one owner');
  for (const name of ['origin', 'username', 'password', 'totpSecret', 'tenantId', 'membershipId']) if (typeof owner?.[name] !== 'string' || owner[name] === '') problems.push(`the owner account has no ${name}`);
  if (owners.length === 1 && typeof owner?.username === 'string' && owners[0].username !== owner.username) problems.push(`the owner of the input is ${owners[0].username}, the owner account is ${owner.username}`);
  if (input.units.filter((unit) => unit.parent === undefined).length !== 1) problems.push('the input must name exactly one root unit');
  return problems;
}

/**
 * The work, with everything outside this process injected: `api(path, { token, method, body, key, ifMatch })` answers a fetch Response, `ownerToken()` and
 * `identityToken(person)` sign people in, `admin` is the Keycloak administration, `invitationFor(email)` waits for the invitation of the outbox.
 * `state` is the content of the output file and `save()` writes it; both are updated after every step that must not be done twice.
 */
export async function provision({ input, owner, state, save, api, ownerToken, identityToken, admin, invitationFor, say, today = () => new Date().toISOString().slice(0, 10), publicHost = '', ownerPasswordChanged = () => {}, demoPassword }) {
  const answerOf = async (response, what) => {
    const text = await response.text();
    if (!response.ok) throw new DemoError(`${what} answered ${response.status}: ${text.slice(0, 400)}`);
    return text === '' ? undefined : JSON.parse(text);
  };
  const list = async (path, what) => {
    const rows = [];
    let cursor;
    for (let page = 0; page < 50; page += 1) {
      const answer = await answerOf(await api(`${path}${path.includes('?') ? '&' : '?'}limit=200${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { token: await ownerToken() }), what);
      rows.push(...(answer.items ?? []));
      cursor = typeof answer.next_cursor === 'string' && answer.next_cursor !== '' ? answer.next_cursor : undefined;
      if (cursor === undefined) break;
    }
    return rows;
  };
  const command = async (path, body, what, { method = 'POST', ifMatch } = {}) => answerOf(await api(path, { token: await ownerToken(), method, body, key: randomUUID(), ifMatch }), what);

  say(`1/3 the units (${input.units.length})`);
  let units = await list('/resources/organization_unit', 'reading the units');
  const root = units.find((unit) => unit.parent_id === null || unit.parent_id === undefined);
  if (root === undefined) throw new DemoError('the tenant has no root unit');
  const wantedRoot = input.units.find((unit) => unit.parent === undefined);
  if (root.code !== wantedRoot.code || root.name !== wantedRoot.name) {
    if (units.some((unit) => unit.code === wantedRoot.code && unit.id !== root.id)) throw new DemoError(`another unit already has the code ${wantedRoot.code} of the root unit`);
    await command(`/org-units/${root.id}`, { code: wantedRoot.code, name: wantedRoot.name }, 'naming the root unit', { method: 'PUT', ifMatch: `"${root.version}"` });
    say(`  ${wantedRoot.code}: the root unit was ${root.code}, renamed`);
    units = await list('/resources/organization_unit', 'reading the units');
  }
  const unitId = new Map(units.map((unit) => [unit.code, unit.id]));
  const validFrom = String(root.valid_from ?? today()).slice(0, 10);
  let made = 0;
  for (const unit of input.units) {
    if (unitId.has(unit.code)) continue;
    const parent = unitId.get(unit.parent);
    if (parent === undefined) throw new DemoError(`the unit ${unit.code} has no parent ${unit.parent}`);
    const created = await command('/org-units', { code: unit.code, name: unit.name, parent_id: parent, unit_type: unit.type, valid_from: validFrom, ...(unit.investor === true ? { is_investor: true } : {}) }, `creating the unit ${unit.code}`);
    unitId.set(unit.code, created.resource_id);
    made += 1;
  }
  say(`  ${made} created, ${input.units.length - made} were there`);

  say(`2/3 the unit roles (${input.roles.length})`);
  let roles = await list('/resources/role_definition', 'reading the roles');
  made = 0;
  // A role cannot hold what its maker does not (the anti-escalation rule of createCustomRole): a permission outside the ones of the tenant owner is left out and counted.
  const held = roles.find((entry) => entry.code === 'TENANT_OWNER')?.permissions;
  const holds = (permission) => !Array.isArray(held) || held.some((pattern) => pattern === permission || (pattern.endsWith('.*') && permission.startsWith(pattern.slice(0, -1))));
  const left = new Set();
  for (const role of input.roles) {
    if (roles.some((entry) => entry.code === role.code)) continue;
    const permissions = role.permissions.filter(holds);
    for (const permission of role.permissions) if (!holds(permission)) left.add(permission);
    if (permissions.length === 0) throw new DemoError(`the role ${role.code} would hold no permission the tenant owner holds`);
    await command('/roles', { code: role.code, name: role.name, permissions, rank: role.rank }, `creating the role ${role.code} (${permissions.length} permissions)`);
    made += 1;
  }
  if (left.size > 0) say(`  ${left.size} permissions are not of the tenant plane and were left out of the roles: ${[...left].sort().join(', ')}`);
  say(`  ${made} created, ${input.roles.length - made} were there`);
  roles = await list('/resources/role_definition', 'reading the roles');
  const roleId = new Map(roles.map((role) => [role.code, role.id]));
  const unknown = [...new Set(input.people.flatMap((person) => person.grants.map((grant) => grant.role)))].filter((code) => !roleId.has(code));
  if (unknown.length > 0) throw new DemoError(`the tenant has no role ${unknown.join(', ')} (it has: ${[...roleId.keys()].join(', ')})`);

  say(`3/3 the people (${input.people.length})`);
  state.origin = owner.origin;
  state.tenantId = owner.tenantId;
  state.people ??= {};
  state.realm ??= {};
  const ownerPerson = input.people.find((person) => person.owner === true);
  // The owner gets a password of the demonstration once (the account was made with a long one); the sign-ins that follow use it.
  // `demoPassword` (the operator gave ONE password for every account of the demonstration) wins over a drawn one, also on a later run.
  if (demoPassword === undefined ? state.ownerPasswordSet !== true : owner.password !== demoPassword) {
    const password = demoPassword ?? newDemoPassword();
    await admin.setPassword(owner.username, password);
    owner.password = password;
    ownerPasswordChanged(password);
    state.ownerPasswordSet = true;
  }
  state.people[ownerPerson.person] = { username: owner.username, password: owner.password, totpSecret: owner.totpSecret, membershipId: owner.membershipId, displayName: ownerPerson.displayName, title: ownerPerson.title, ...(ownerPerson.sample === true ? { sample: true } : {}), otpauth: owner.otpauth ?? otpauthOf({ issuerName: `MACHVON ${publicHost}`, username: owner.username, secret: owner.totpSecret }) };
  save();
  const specOf = (person, grant) => {
    const unit = unitId.get(person.unit);
    if (unit === undefined) throw new DemoError(`the unit ${person.unit} of ${person.username} does not exist`);
    return { role_id: roleId.get(grant.role), scope_kind: grant.scope, ...(grant.scope === 'TENANT' ? {} : { scope_ref_ids: [unit] }) };
  };
  for (const person of input.people.filter((entry) => entry.owner !== true)) {
    const entry = (state.people[person.person] ??= { username: person.username, password: demoPassword ?? newDemoPassword(), totpSecret: newTotpSecret(), displayName: person.displayName, title: person.title, ...(person.sample === true ? { sample: true } : {}) });
    entry.otpauth ??= otpauthOf({ issuerName: `MACHVON ${publicHost}`, username: person.username, secret: entry.totpSecret });
    const progress = (state.realm[person.username] ??= {});
    save();
    if (progress.inRealm === true && demoPassword !== undefined && entry.password !== demoPassword) {
      await admin.setPassword(person.username, demoPassword);
      entry.password = demoPassword;
      save();
    }
    if (progress.inRealm !== true) {
      if (demoPassword !== undefined) entry.password = demoPassword;
      // The person gets the second factor here: the realm asks for it at every sign-in and offers no enrolment to a person who has none (tools/keycloak-admin.mjs, createUser).
      await admin.createUser({ username: person.username, email: person.email, firstName: person.firstName, lastName: person.lastName, password: entry.password, totpSecret: entry.totpSecret });
      progress.inRealm = true;
      save();
    }
    const first = person.grants.slice(0, INVITATION_GRANT_LIMIT);
    if (progress.invited !== true) {
      await command('/memberships/invitations', { email: person.email, display_name: person.displayName, organization_unit_id: unitId.get(person.unit), initial_grants: first.map((grant) => specOf(person, grant)) }, `inviting ${person.username}`);
      progress.invited = true;
      save();
    }
    if (typeof entry.membershipId !== 'string') {
      const invitation = await invitationFor(person.email);
      const session = await answerOf(await api(`/memberships/invitations/${invitation.invitation_id}/accept`, { method: 'POST', token: await identityToken(person, entry), body: { token: invitation.token }, key: randomUUID() }), `accepting the invitation of ${person.username}`);
      entry.membershipId = session.membership_id;
      save();
    }
    progress.granted ??= [];
    for (const grant of person.grants.slice(INVITATION_GRANT_LIMIT)) {
      const name = `${grant.role}:${grant.scope}`;
      if (progress.granted.includes(name)) continue;
      await command('/role-grants', { membership_id: entry.membershipId, ...specOf(person, grant), reason: GRANT_REASON }, `granting ${grant.role} to ${person.username}`);
      progress.granted.push(name);
      save();
    }
    say(`  ${person.username}: member of ${person.unit} with ${person.grants.map((grant) => grant.role).join(', ')}`);
  }
  return state;
}

export async function main(argv, { env = process.env, log = (line) => process.stdout.write(`${line}\n`), fetch = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const { values } = parseArgs({ args: argv, options: { input: { type: 'string' }, owner: { type: 'string' }, output: { type: 'string' }, invitations: { type: 'string' } }, allowPositionals: false });
  // One password for every account of the demonstration, when the operator gives one (DEMO_PASSWORD: never an argument, so that it is not in the list of processes).
  const demoPassword = (env.DEMO_PASSWORD ?? '') === '' ? undefined : env.DEMO_PASSWORD;
  if (demoPassword !== undefined && (demoPassword.length < 8 || /\s/.test(demoPassword))) {
    log('demo-tenant: DEMO_PASSWORD must be at least 8 characters without white space');
    return 2;
  }
  const say = (line) => log(`demo-tenant: ${line}`);
  if (!values.input || !values.owner || !values.output || !values.invitations) {
    say('--input, --owner, --output and --invitations are required');
    return 2;
  }
  const json = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const input = json(values.input);
  const ownerFile = json(values.owner);
  const owner = ownerOf(ownerFile, input);
  const problems = inputProblems(input, owner);
  if (problems.length > 0) {
    for (const problem of problems) say(problem);
    return 2;
  }
  const publicHost = env.PUBLIC_HOST ?? new URL(owner.origin).host;
  const realm = env.OIDC_REALM ?? 'machvon';
  const origin = owner.origin;
  const issuer = issuerOf(publicHost, realm);
  const state = existsSync(values.output) ? json(values.output) : {};
  const save = () => writeFileSync(values.output, `${JSON.stringify(state, null, 2)}\n`);
  // The one-time password of a person is accepted once: the counter of the last code is kept for the whole run (the sign-in helper waits for the next one).
  const secrets = {};
  const api = (path, { token, method = 'GET', body, key, ifMatch } = {}) =>
    fetch(`${origin}/api${path}`, {
      method,
      redirect: 'manual',
      headers: { accept: 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** The identity token of a person: authorization code with PKCE at the web client, password and one-time password. */
  const identityOf = async (username, password, totpSecret) => {
    secrets[username] ??= { secret: totpSecret };
    const { verifier, challenge } = pkcePair();
    const nonce = randomBytes(16).toString('base64url');
    const redirectUri = `${origin}/auth/callback`;
    const callback = await signIn({ authUrl: authorizationUrl({ issuer, redirectUri, state: nonce, challenge, clientId: WEB_CLIENT }), redirectUri, username, password, secrets, fetch, sleep });
    return (await exchangeCode({ issuer, redirectUri, code: codeOf(callback, nonce), verifier, clientId: WEB_CLIENT, fetch })).accessToken;
  };
  // The tenant token of the owner lives five minutes: it is taken again a minute before it ends.
  let kept;
  const ownerToken = async () => {
    if (kept !== undefined && kept.until > Date.now() && kept.password === owner.password) return kept.token;
    const identity = await identityOf(owner.username, owner.password, owner.totpSecret);
    const response = await api('/me/session/tenant-selection', { method: 'POST', token: identity, body: { tenant_id: owner.tenantId, membership_id: owner.membershipId }, key: randomUUID() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') throw new DemoError(`the tenant session of the owner was refused: ${response.status} ${body.code ?? ''}`.trim());
    kept = { token: body.access_token, password: owner.password, until: Date.now() + (Number(body.expires_in ?? 300) - 60) * 1000 };
    return kept.token;
  };
  const invitationFor = async (email) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = readInvitations(values.invitations).filter((entry) => String(entry.to_email).toLowerCase() === email.toLowerCase() && entry.tenant_id === owner.tenantId).at(-1);
      if (found !== undefined) return found;
      await sleep(3000);
    }
    throw new DemoError(`no invitation for ${email} appeared in the outbox`);
  };
  // The new password of the owner is written back to the file the account came from, so that no file keeps a password that no longer works.
  const ownerPasswordChanged = (password) => {
    if (typeof ownerFile.people === 'object' && ownerFile.people !== null) ownerFile.people[owner.username].password = password;
    else ownerFile.password = password;
    writeFileSync(values.owner, `${JSON.stringify(ownerFile, null, 2)}
`);
  };
  try {
    const admin = new KeycloakAdmin({ base: env.KEYCLOAK_INTERNAL_URL ?? 'http://keycloak:8080/idp', realm, username: env.KEYCLOAK_ADMIN_USER ?? '', password: readFileSync(env.KEYCLOAK_ADMIN_PASSWORD_FILE ?? 'C:\\run\\secrets\\keycloak_admin_password', 'utf8').split(/\r?\n/)[0], fetch });
    await provision({ input, owner, state, save, api, ownerToken, identityToken: (person, entry) => identityOf(person.username, entry.password, entry.totpSecret), admin, invitationFor, say, publicHost, ownerPasswordChanged, demoPassword });
    say(`done: ${Object.keys(state.people).length} people of the tenant ${owner.tenantId}; the credentials are in the output file (administrators only)`);
    return 0;
  } catch (error) {
    if (!(error instanceof DemoError) && error?.name !== 'AdminError') throw error;
    say(`FAILED ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
