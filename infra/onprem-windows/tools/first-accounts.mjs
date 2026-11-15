// The first accounts of an installation, made through the official paths of the product, without a browser:
//   1 the people of the input file are created in the realm (administration API of Keycloak, inside the compose network), each with a random password;
//   2 the system administrator signs in at the control client (password, then the one-time password the realm makes every person enrol at the first sign-in) and
//     scripts/onprem-first-tenant.mjs requests the first tenant (requestTenantProvisioning) and waits until the workers made it Active;
//   3 the owner signs in at the web client and accepts the invitation the product wrote for the owner (the invitation outbox volume);
//   4 the owner invites every member of the input file into the root unit with the named role (inviteMember), and each member signs in and accepts.
// host\first-accounts.ps1 runs this file with the Node of the api image in a one-shot container. The result is ONE file, readable by administrators of the host only:
// for each person the user name, the password and the secret of the one-time password (with an otpauth:// address an authenticator application imports).
// Hand each person their own entry, have them change the password and enrol their own second factor, then delete the file.
//
//   first-accounts.mjs --input C:\run\admin\first-accounts.input.json --output C:\run\admin\first-accounts.json --invitations C:\data\invitations
//
// It can be run again: what the output file says is done is not done twice. Nothing secret is printed.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { KeycloakAdmin } from './keycloak-admin.mjs';
import { authorizationUrl, codeOf, exchangeCode, issuerOf, main as firstTenant, pkcePair } from '../../../scripts/onprem-first-tenant.mjs';
import { signIn } from '../../../scripts/onprem-smoke/keycloak-login.mjs';

const WEB_CLIENT = 'machvon-web';
const USER_NAME = /^[a-z][a-z0-9._-]{2,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SetupError extends Error {}

/** What is wrong with the input file, as sentences; empty when it can be used. */
export function inputProblems(input) {
  const problems = [];
  const person = (value, where) => {
    if (typeof value !== 'object' || value === null) return problems.push(`${where} is missing`);
    if (!USER_NAME.test(value.username ?? '')) problems.push(`${where}.username must be 3 to 41 lower-case letters, digits, dot, dash or underscore`);
    if (!EMAIL.test(value.email ?? '')) problems.push(`${where}.email is not an address`);
    for (const name of ['firstName', 'lastName']) if (typeof value[name] !== 'string' || value[name].trim() === '') problems.push(`${where}.${name} is missing`);
    return undefined;
  };
  person(input?.systemAdmin, 'systemAdmin');
  person(input?.owner, 'owner');
  const tenant = input?.tenant ?? {};
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(tenant.code ?? '')) problems.push('tenant.code must be 3 to 31 lower-case letters, digits or dashes');
  if (!/^[a-z0-9-]{3,40}$/.test(tenant.subdomain ?? '')) problems.push('tenant.subdomain must be 3 to 40 lower-case letters, digits or dashes');
  for (const name of ['name', 'rootUnitName']) if (typeof tenant[name] !== 'string' || tenant[name].trim().length < 3) problems.push(`tenant.${name} is missing`);
  const members = input?.members ?? [];
  if (!Array.isArray(members)) problems.push('members must be a list');
  else {
    members.forEach((member, index) => {
      person(member, `members[${index}]`);
      if (typeof member?.role !== 'string' || member.role === '') problems.push(`members[${index}].role (the code of a role of the tenant) is missing`);
    });
  }
  const names = [input?.systemAdmin, input?.owner, ...(Array.isArray(members) ? members : [])].map((entry) => entry?.username);
  if (new Set(names).size !== names.length) problems.push('a user name is used twice');
  const emails = [input?.systemAdmin, input?.owner, ...(Array.isArray(members) ? members : [])].map((entry) => String(entry?.email).toLowerCase());
  if (new Set(emails).size !== emails.length) problems.push('an e-mail address is used twice');
  return problems;
}

/** A password a person can type once: 20 characters of an alphabet without look-alikes, with every class Keycloak may ask for. */
export function newPassword(random = randomBytes) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let text = '';
  for (const byte of random(64)) {
    if (byte < 224 && text.length < 16) text += alphabet[byte % 56];
  }
  return `${text}-aA7#`;
}

/** The address an authenticator application imports: the secret is the text Keycloak showed at the enrolment (already base32). */
export function otpauthOf({ issuerName, username, secret }) {
  return `otpauth://totp/${encodeURIComponent(issuerName)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuerName)}&algorithm=SHA1&digits=6&period=30`;
}

/** The invitations of the outbox directory (one JSON object per file), newest last. */
export function readInvitations(directory, { list = readdirSync, read = (path) => readFileSync(path, 'utf8') } = {}) {
  return list(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(read(join(directory, name))));
}

export async function main(argv, { env = process.env, log = (line) => process.stdout.write(`${line}\n`), fetch = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const { values } = parseArgs({ args: argv, options: { input: { type: 'string' }, output: { type: 'string' }, invitations: { type: 'string' } }, allowPositionals: false });
  if (!values.input || !values.output || !values.invitations) {
    log('first-accounts: --input, --output and --invitations are required');
    return 2;
  }
  const input = JSON.parse(readFileSync(values.input, 'utf8').replace(/^\uFEFF/, ''));
  const problems = inputProblems(input);
  if (problems.length > 0) {
    for (const problem of problems) log(`first-accounts: ${problem}`);
    return 2;
  }
  const publicHost = env.PUBLIC_HOST ?? '';
  const controlHost = env.CONTROL_HOST ?? publicHost;
  const realm = env.OIDC_REALM ?? 'machvon';
  const origin = `https://${publicHost}`;
  const issuer = issuerOf(publicHost, realm);
  const state = existsSync(values.output) ? JSON.parse(readFileSync(values.output, 'utf8')) : { origin, people: {}, totp: {} };
  const save = () => writeFileSync(values.output, `${JSON.stringify(state, null, 2)}\n`);
  const say = (line) => log(`first-accounts: ${line}`);

  const api = (path, { token, method = 'GET', body, key } = {}) =>
    fetch(`${origin}/api${path}`, {
      method,
      redirect: 'manual',
      headers: { accept: 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const answerOf = async (response, what) => {
    const text = await response.text();
    if (!response.ok) throw new SetupError(`${what} answered ${response.status}: ${text.slice(0, 300)}`);
    return text === '' ? undefined : JSON.parse(text);
  };
  const remember = (person) => {
    const totp = state.totp[person.username];
    if (totp?.secret !== undefined) {
      state.people[person.username].totpSecret = totp.secret;
      state.people[person.username].otpauth = otpauthOf({ issuerName: `MACHVON ${publicHost}`, username: person.username, secret: totp.secret });
    }
    save();
  };
  /** A sign-in of a person at a public client with PKCE: the tokens of the person. */
  const signInAt = async (person, clientId, redirectUri) => {
    const { verifier, challenge } = pkcePair();
    const nonce = randomBytes(16).toString('base64url');
    const callback = await signIn({ authUrl: authorizationUrl({ issuer, redirectUri, state: nonce, challenge, clientId }), redirectUri, username: person.username, password: state.people[person.username].password, secrets: state.totp, fetch, sleep });
    remember(person);
    return exchangeCode({ issuer, redirectUri, code: codeOf(callback, nonce), verifier, clientId, fetch });
  };

  try {
    say(`1/4 the people of the realm (${origin})`);
    const admin = new KeycloakAdmin({ base: env.KEYCLOAK_INTERNAL_URL ?? 'http://keycloak:8080/idp', realm, username: env.KEYCLOAK_ADMIN_USER ?? '', password: readFileSync(env.KEYCLOAK_ADMIN_PASSWORD_FILE ?? 'C:\\run\\secrets\\keycloak_admin_password', 'utf8').split(/\r?\n/)[0], fetch });
    const people = [{ ...input.systemAdmin, realmRole: 'SystemAdmin', kind: 'system administrator' }, { ...input.owner, kind: 'tenant owner' }, ...input.members.map((member) => ({ ...member, kind: `member (${member.role})` }))];
    for (const person of people) {
      if (state.people[person.username] === undefined) {
        state.people[person.username] = { username: person.username, email: person.email, kind: person.kind, password: newPassword() };
        save();
      }
      if (state.people[person.username].inRealm !== true) {
        await admin.ensureUser({ username: person.username, email: person.email, firstName: person.firstName, lastName: person.lastName, password: state.people[person.username].password, realmRole: person.realmRole });
        state.people[person.username].inRealm = true;
        save();
        say(`  ${person.username}: created`);
      }
    }

    if (state.tenantId === undefined) {
      say('2/4 the first tenant (scripts/onprem-first-tenant.mjs, signed in as the system administrator)');
      const lines = [];
      const status = await firstTenant(
        ['--public-host', publicHost, '--control-host', controlHost, '--realm', realm, '--code', input.tenant.code, '--name', input.tenant.name, '--owner-email', input.owner.email, '--root-unit-name', input.tenant.rootUnitName, '--subdomain', input.tenant.subdomain, '--wait-seconds', '600', '--locale', 'en'],
        {
          fetch,
          log: (line) => {
            lines.push(line);
            if (!line.includes('code_challenge')) say(`  ${line}`);
          },
          // The administrator's part of the script, done here: open the printed address, sign in with the second factor, give back the address the browser ends on.
          ask: async () => {
            const redirectUri = `https://${controlHost}/auth/callback`;
            const callback = await signIn({ authUrl: lines.find((line) => line.includes('/protocol/openid-connect/auth?')), redirectUri, username: input.systemAdmin.username, password: state.people[input.systemAdmin.username].password, secrets: state.totp, fetch, sleep });
            remember(input.systemAdmin);
            return callback;
          },
        },
      );
      state.tenantId = /is Active: ([0-9a-f-]{36})/.exec(lines.join('\n'))?.[1];
      if (status !== 0 || state.tenantId === undefined) throw new SetupError(`the first tenant was not created: ${lines.slice(-2).join(' / ')}`);
      save();
    } else {
      say(`2/4 the tenant exists already: ${state.tenantId}`);
    }

    /** The newest invitation of the outbox for this address in this tenant; the workers write it shortly after the command. */
    const invitationFor = async (email) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const found = readInvitations(values.invitations).filter((entry) => String(entry.to_email).toLowerCase() === email.toLowerCase() && entry.tenant_id === state.tenantId).at(-1);
        if (found !== undefined) return found;
        await sleep(3000);
      }
      throw new SetupError(`no invitation for ${email} appeared in the outbox`);
    };
    const accept = async (person) => {
      const invitation = await invitationFor(person.email);
      const tokens = await signInAt(person, WEB_CLIENT, `${origin}/auth/callback`);
      const session = await answerOf(await api(`/memberships/invitations/${invitation.invitation_id}/accept`, { method: 'POST', token: tokens.accessToken, body: { token: invitation.token }, key: randomUUID() }), `accepting the invitation of ${person.username}`);
      state.people[person.username].membershipId = session.membership_id;
      state.people[person.username].accepted = true;
      save();
      return session;
    };

    let ownerSession;
    if (state.people[input.owner.username].accepted !== true) {
      say('3/4 the owner accepts the invitation');
      ownerSession = await accept(input.owner);
    } else {
      say('3/4 the owner is a member already');
    }

    const waiting = input.members.filter((member) => state.people[member.username].accepted !== true);
    if (waiting.length > 0) {
      say('4/4 the members');
      if (ownerSession === undefined) {
        const tokens = await signInAt(input.owner, WEB_CLIENT, `${origin}/auth/callback`);
        ownerSession = await answerOf(await api('/me/session/tenant-selection', { method: 'POST', token: tokens.accessToken, body: { tenant_id: state.tenantId, membership_id: state.people[input.owner.username].membershipId }, key: randomUUID() }), 'choosing the tenant');
      }
      const token = ownerSession.access_token;
      const units = await answerOf(await api('/organization-units?limit=50', { token }), 'reading the units');
      const root = (units.items ?? []).find((unit) => unit.parent_id === null || unit.parent_id === undefined) ?? (units.items ?? [])[0];
      if (root === undefined) throw new SetupError('the tenant has no unit');
      const roles = await answerOf(await api('/roles?limit=200', { token }), 'reading the roles');
      for (const member of waiting) {
        const role = (roles.items ?? []).find((entry) => entry.code === member.role);
        if (role === undefined) throw new SetupError(`the tenant has no role ${member.role} (it has: ${(roles.items ?? []).map((entry) => entry.code).join(', ')})`);
        if (state.people[member.username].invited !== true) {
          await answerOf(
            await api('/memberships/invitations', { method: 'POST', token, key: randomUUID(), body: { email: member.email, display_name: `${member.lastName} ${member.firstName}`.trim(), organization_unit_id: root.id, initial_grants: [{ role_id: role.id, scope_kind: 'UNIT_SUBTREE', scope_ref_ids: [root.id] }] } }),
            `inviting ${member.username}`,
          );
          state.people[member.username].invited = true;
          save();
        }
        await accept(member);
        say(`  ${member.username}: member with the role ${member.role}`);
      }
    } else {
      say('4/4 every member is a member already');
    }
    say(`done: ${Object.keys(state.people).length} accounts; hand each person their entry of the output file, then delete it`);
    return 0;
  } catch (error) {
    if (!(error instanceof SetupError) && error?.name !== 'AdminError') throw error;
    say(`FAILED ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
