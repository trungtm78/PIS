// Administration of the realm from INSIDE the compose network (the administration console of Keycloak is not offered on the public edge):
// host\keycloak-admin.ps1 runs this file with the Node of the api image, in a one-shot container, with the secret files of Keycloak mounted.
//
//   keycloak-admin.mjs disable-directory
//       Switches the directory federation provider of the realm OFF (enabled=false). For an installation without a directory: the realm file of the product names
//       one, and a provider that cannot reach its directory makes every sign-in wait for it. The realm file is not changed; `enable-directory` switches it on again.
//   keycloak-admin.mjs enable-directory
//   keycloak-admin.mjs create-user --username <name> --email <address> --first-name <text> --last-name <text> --password-file <file> [--realm-role SystemAdmin]
//       A person of the realm with the password of the file (one line). The realm makes the one-time password a required action: the person enrols it at the first
//       sign-in. Creating a person that exists sets the password again and keeps everything else.
//
// The administrator is the first administrator of Keycloak (KEYCLOAK_ADMIN_USER, password file KEYCLOAK_ADMIN_PASSWORD_FILE). Nothing secret is printed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export class AdminError extends Error {}

const firstLine = (path) => readFileSync(path, 'utf8').split(/\r?\n/)[0];

export class KeycloakAdmin {
  constructor({ base, realm, username, password, fetch = globalThis.fetch }) {
    this.base = base.replace(/\/+$/, '');
    this.realm = realm;
    this.username = username;
    this.password = password;
    this.fetch = fetch;
    this.token = undefined;
  }

  async signIn() {
    const response = await this.fetch(`${this.base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: this.username, password: this.password }).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') throw new AdminError(`the first administrator cannot sign in: ${response.status} ${body.error ?? ''}`.trim());
    this.token = body.access_token;
  }

  async call(method, path, body) {
    if (this.token === undefined) await this.signIn();
    const response = await this.fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok && response.status !== 409) throw new AdminError(`${method} ${path} answered ${response.status}: ${text.slice(0, 200)}`);
    let parsed;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  }

  /** Switches every directory federation provider of the realm on or off; returns their names. */
  async setDirectory(enabled) {
    const { body } = await this.call('GET', '/components?type=org.keycloak.storage.UserStorageProvider');
    const providers = (body ?? []).filter((component) => component.providerId === 'ldap');
    for (const provider of providers) {
      await this.call('PUT', `/components/${provider.id}`, { ...provider, config: { ...provider.config, enabled: [String(enabled)] } });
    }
    return providers.map((provider) => provider.name);
  }

  /** Creates the person, or finds it; sets the password; grants the realm role when one is named. Returns `created` or `existing`. */
  async ensureUser({ username, email, firstName, lastName, password, realmRole }) {
    const created = await this.call('POST', '/users', { username, email, firstName, lastName, enabled: true, emailVerified: true });
    const { body: found } = await this.call('GET', `/users?exact=true&username=${encodeURIComponent(username)}`);
    const user = (found ?? []).find((entry) => entry.username === username.toLowerCase());
    if (user === undefined) throw new AdminError(`the person ${username} was not created`);
    await this.call('PUT', `/users/${user.id}/reset-password`, { type: 'password', value: password, temporary: false });
    if (realmRole !== undefined) {
      const { body: role } = await this.call('GET', `/roles/${encodeURIComponent(realmRole)}`);
      await this.call('POST', `/users/${user.id}/role-mappings/realm`, [{ id: role.id, name: role.name }]);
    }
    return created.status === 409 ? 'existing' : 'created';
  }
}

export async function main(argv, { env = process.env, log = (line) => process.stdout.write(`${line}\n`), fetch = globalThis.fetch, read = firstLine } = {}) {
  const [command, ...rest] = argv;
  const options = { username: { type: 'string' }, email: { type: 'string' }, 'first-name': { type: 'string' }, 'last-name': { type: 'string' }, 'password-file': { type: 'string' }, 'realm-role': { type: 'string' } };
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options, allowPositionals: false }));
  } catch (error) {
    log(`keycloak-admin: ${error.message}`);
    return 2;
  }
  try {
    const admin = new KeycloakAdmin({
      base: env.KEYCLOAK_INTERNAL_URL ?? 'http://keycloak:8080/idp',
      realm: env.OIDC_REALM ?? 'machvon',
      username: env.KEYCLOAK_ADMIN_USER ?? '',
      password: read(env.KEYCLOAK_ADMIN_PASSWORD_FILE ?? 'C:\\run\\secrets\\keycloak_admin_password'),
      fetch,
    });
    if (command === 'disable-directory' || command === 'enable-directory') {
      const names = await admin.setDirectory(command === 'enable-directory');
      log(names.length === 0 ? 'keycloak-admin: the realm has no directory federation provider' : `keycloak-admin: directory federation ${command === 'enable-directory' ? 'ON' : 'OFF'}: ${names.join(', ')}`);
      return 0;
    }
    if (command === 'create-user') {
      const missing = ['username', 'email', 'first-name', 'last-name', 'password-file'].filter((name) => typeof values[name] !== 'string' || values[name] === '');
      if (missing.length > 0) {
        log(`keycloak-admin: missing ${missing.map((name) => `--${name}`).join(', ')}`);
        return 2;
      }
      const outcome = await admin.ensureUser({ username: values.username, email: values.email, firstName: values['first-name'], lastName: values['last-name'], password: read(values['password-file']), realmRole: values['realm-role'] });
      log(`keycloak-admin: ${values.username} ${outcome}${values['realm-role'] === undefined ? '' : `, realm role ${values['realm-role']}`}`);
      return 0;
    }
    log('keycloak-admin: commands are disable-directory, enable-directory, create-user');
    return 2;
  } catch (error) {
    if (!(error instanceof AdminError)) throw error;
    log(`keycloak-admin: FAILED ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
