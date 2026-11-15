// Administration of the realm from INSIDE the compose network (the administration console of Keycloak is not offered on the public edge):
// host\keycloak-admin.ps1 runs this file with the Node of the api image, in a one-shot container, with the secret files of Keycloak mounted.
//
//   keycloak-admin.mjs disable-directory
//       Switches the directory federation provider of the realm OFF (enabled=false). For an installation without a directory: the realm file of the product names
//       one, and a provider that cannot reach its directory makes every sign-in wait for it. The realm file is not changed; `enable-directory` switches it on again.
//   keycloak-admin.mjs enable-directory
//   keycloak-admin.mjs create-user --username <name> --email <address> --first-name <text> --last-name <text> --password-file <file> --totp-secret-file <file> [--realm-role SystemAdmin]
//       A person of the realm with the password of the first file and a one-time password credential whose secret is the second file (twenty letters and digits,
//       one line each). The realm asks for a second factor at every sign-in and offers no enrolment to a person without one, so the administrator provisions it;
//       the person gets both and puts the secret into an authenticator application (the tool prints nothing of either). A person that exists is refused.
//   keycloak-admin.mjs delete-user --username <name>
//   keycloak-admin.mjs apply-presentation [--file <json>]
//       Writes the presentation of the realm the pack carries for its edition (display name, login theme, languages; realm-presentation.json beside this file,
//       written by scripts/onprem-windows-pack.mjs) into the RUNNING realm: the realm file is imported once, at the first start, so a later release reaches the realm here.
//       A pack without that file (the enterprise edition keeps the realm as its file says) changes nothing.
//   keycloak-admin.mjs single-factor on | off
//       `on` is the DEMONSTRATION mode with one factor (MACHVON_DEMO_SINGLE_FACTOR=true of the installation, docs/runbooks/deploy-windows-containers.md): the browser
//       flow of the running realm stops after the password (its level-2 step is DISABLED), a new person is not asked to configure a one-time password and the pending
//       request of that kind is taken from every person. `off` puts the realm back as the product ships it: the second factor at every sign-in. The realm file of the
//       product is never changed, and the credentials of the people (their one-time passwords, their keys) are kept in both directions.
//
// The administrator is the first administrator of Keycloak (KEYCLOAK_ADMIN_USER, password file KEYCLOAK_ADMIN_PASSWORD_FILE). Nothing secret is printed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export class AdminError extends Error {}

/** Where the realm of the product asks for the second factor (infra/keycloak/onprem/machvon-realm.json): the level-2 step of the browser forms, and the action a new person gets. */
export const SECOND_FACTOR = { flow: 'machvon browser forms', step: 'machvon level 2', action: 'CONFIGURE_TOTP' };
/** The presentation of the realm for the edition of the pack, beside this file in the image (absent in a pack whose edition keeps the realm file as it is). */
export const PRESENTATION_FILE = fileURLToPath(new URL('./realm-presentation.json', import.meta.url));
/** What a presentation may set: how the realm looks and reads, nothing of how it authenticates. */
export const PRESENTATION_FIELDS = ['displayName', 'displayNameHtml', 'loginTheme', 'emailTheme', 'internationalizationEnabled', 'supportedLocales', 'defaultLocale', 'webAuthnPolicyRpEntityName'];

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

  /**
   * Creates the person with the password and, when `totpSecret` is given, with a one-time password credential of that secret (RFC 6238, HMAC-SHA1, six digits,
   * thirty seconds: the policy of the realm). The realm asks every member for a second factor at EVERY sign-in and offers no enrolment to a person who has none
   * yet, so a person created without one cannot sign in at all: the administrator provisions it here and hands the secret over with the password.
   * A person that exists already is refused (nothing of an existing person is changed).
   */
  async createUser({ username, email, firstName, lastName, password, totpSecret, realmRole }) {
    const credentials = [{ type: 'password', value: password, temporary: false }];
    if (totpSecret !== undefined) {
      credentials.push({ type: 'otp', userLabel: productLabel(), secretData: JSON.stringify({ value: totpSecret }), credentialData: JSON.stringify({ subType: 'totp', digits: 6, counter: 0, period: 30, algorithm: 'HmacSHA1' }) });
    }
    const created = await this.call('POST', '/users', { username, email, firstName, lastName, enabled: true, emailVerified: true, credentials });
    if (created.status === 409) throw new AdminError(`the person ${username}, or a person with that e-mail address, exists already`);
    const { body: found } = await this.call('GET', `/users?exact=true&username=${encodeURIComponent(username)}`);
    const user = (found ?? []).find((entry) => entry.username === username.toLowerCase());
    if (user === undefined) throw new AdminError(`the person ${username} was not created`);
    const { body: stored } = await this.call('GET', `/users/${user.id}/credentials`);
    const types = (stored ?? []).map((credential) => credential.type);
    if (!types.includes('password') || (totpSecret !== undefined && !types.includes('otp'))) throw new AdminError(`the credentials of ${username} were not stored (found: ${types.join(', ') || 'none'})`);
    if (totpSecret !== undefined) {
      // The second factor exists: the required action "configure a one-time password" the realm gives every new person is taken away, the rest of the person is kept.
      const { body: whole } = await this.call('GET', `/users/${user.id}`);
      await this.call('PUT', `/users/${user.id}`, { ...whole, requiredActions: (whole.requiredActions ?? []).filter((action) => action !== 'CONFIGURE_TOTP') });
    }
    if (realmRole !== undefined) {
      const { body: role } = await this.call('GET', `/roles/${encodeURIComponent(realmRole)}`);
      await this.call('POST', `/users/${user.id}/role-mappings/realm`, [{ id: role.id, name: role.name }]);
    }
    return user.id;
  }

  /** Writes the given fields of the realm (a partial representation: Keycloak keeps every field that is not named). */
  async applyPresentation(presentation) {
    await this.call('PUT', '', presentation);
    return Object.keys(presentation);
  }

  /**
   * Whether the browser flow of the running realm asks for the second factor. `false` is the demonstration mode with one factor: the level-2 step of the flow is
   * DISABLED (the sign-in ends after the password, the tokens say `aal1`), `CONFIGURE_TOTP` is no default action any more and is taken from the people it waits for.
   * `true` restores what the realm file of the product says. Returns what was changed.
   */
  async setSecondFactor(required) {
    const flow = `/authentication/flows/${encodeURIComponent(SECOND_FACTOR.flow)}/executions`;
    const { body: executions } = await this.call('GET', flow);
    const step = (executions ?? []).find((execution) => execution.displayName === SECOND_FACTOR.step && execution.level === 0);
    if (step === undefined) throw new AdminError(`the flow "${SECOND_FACTOR.flow}" of the realm has no step "${SECOND_FACTOR.step}": this is not the realm of the product`);
    const requirement = required ? 'CONDITIONAL' : 'DISABLED';
    if (step.requirement !== requirement) await this.call('PUT', flow, { ...step, requirement });
    const { body: action } = await this.call('GET', `/authentication/required-actions/${SECOND_FACTOR.action}`);
    if (action !== undefined && action.defaultAction !== required) await this.call('PUT', `/authentication/required-actions/${SECOND_FACTOR.action}`, { ...action, defaultAction: required });
    let released = 0;
    if (!required) {
      for (let first = 0; ; first += 100) {
        const { body: page } = await this.call('GET', `/users?first=${first}&max=100`);
        for (const user of page ?? []) {
          if (!(user.requiredActions ?? []).includes(SECOND_FACTOR.action)) continue;
          await this.call('PUT', `/users/${user.id}`, { ...user, requiredActions: user.requiredActions.filter((name) => name !== SECOND_FACTOR.action) });
          released += 1;
        }
        if ((page ?? []).length < 100) break;
      }
    }
    return { requirement, defaultAction: required, released };
  }

  /** Removes a person of the realm by user name; false when there is no such person. */
  async deleteUser(username) {
    const { body: found } = await this.call('GET', `/users?exact=true&username=${encodeURIComponent(username)}`);
    const user = (found ?? []).find((entry) => entry.username === username.toLowerCase());
    if (user === undefined) return false;
    await this.call('DELETE', `/users/${user.id}`);
    return true;
  }
}

/**
 * The name of the product a person reads beside a one-time password (in the authenticator application, in the account pages): the display name of the presentation
 * of the edition, or the code name where the release carries none. Entries a person imported earlier keep the name they were imported with.
 */
export function productLabel(readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined)) {
  const name = readJson(PRESENTATION_FILE)?.displayName;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'MACHVON';
}

/** A secret of a one-time password as Keycloak makes them: twenty letters and digits. */
export function newTotpSecret(random = randomBytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  while (text.length < 20) {
    for (const byte of random(32)) if (byte < 248 && text.length < 20) text += alphabet[byte % 62];
  }
  return text;
}

/** RFC 4648 base32 without padding: the form in which an authenticator application takes the secret. */
export function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text, 'utf8')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let at = 0; at < bits.length; at += 5) out += alphabet[Number.parseInt(bits.slice(at, at + 5).padEnd(5, '0'), 2)];
  return out;
}

/** The address an authenticator application imports (as a QR code or typed in). */
export function otpauthOf({ issuerName, username, secret }) {
  return `otpauth://totp/${encodeURIComponent(issuerName)}:${encodeURIComponent(username)}?secret=${base32(secret)}&issuer=${encodeURIComponent(issuerName)}&algorithm=SHA1&digits=6&period=30`;
}

export async function main(argv, { env = process.env, log = (line) => process.stdout.write(`${line}\n`), fetch = globalThis.fetch, read = firstLine, readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined) } = {}) {
  const [command, ...rest] = argv;
  const options = { username: { type: 'string' }, email: { type: 'string' }, 'first-name': { type: 'string' }, 'last-name': { type: 'string' }, 'password-file': { type: 'string' }, 'totp-secret-file': { type: 'string' }, 'realm-role': { type: 'string' }, file: { type: 'string' } };
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: rest, options, allowPositionals: command === 'single-factor' }));
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
      const missing = ['username', 'email', 'first-name', 'last-name', 'password-file', 'totp-secret-file'].filter((name) => typeof values[name] !== 'string' || values[name] === '');
      if (missing.length > 0) {
        log(`keycloak-admin: missing ${missing.map((name) => `--${name}`).join(', ')}`);
        return 2;
      }
      const totpSecret = read(values['totp-secret-file']);
      if (!/^[A-Za-z0-9]{20,64}$/.test(totpSecret)) throw new AdminError('the one-time password secret must be 20 to 64 letters and digits');
      await admin.createUser({ username: values.username, email: values.email, firstName: values['first-name'], lastName: values['last-name'], password: read(values['password-file']), totpSecret, realmRole: values['realm-role'] });
      log(`keycloak-admin: ${values.username} created with a password and a one-time password${values['realm-role'] === undefined ? '' : `, realm role ${values['realm-role']}`}`);
      return 0;
    }
    if (command === 'delete-user') {
      if (typeof values.username !== 'string' || values.username === '') {
        log('keycloak-admin: missing --username');
        return 2;
      }
      log(`keycloak-admin: ${values.username} ${(await admin.deleteUser(values.username)) ? 'removed' : 'does not exist'}`);
      return 0;
    }
    if (command === 'apply-presentation') {
      const presentation = readJson(values.file ?? PRESENTATION_FILE);
      if (presentation === undefined) {
        log('keycloak-admin: this release carries no presentation of the realm: nothing changed');
        return 0;
      }
      if (presentation === null || typeof presentation !== 'object' || Array.isArray(presentation)) throw new AdminError('the presentation of the realm must be a JSON object');
      const unknown = Object.keys(presentation).filter((name) => !PRESENTATION_FIELDS.includes(name));
      if (unknown.length > 0) throw new AdminError(`the presentation of the realm may not set ${unknown.join(', ')}`);
      log(`keycloak-admin: presentation of the realm written: ${(await admin.applyPresentation(presentation)).join(', ')}`);
      return 0;
    }
    if (command === 'single-factor') {
      const [word, ...more] = positionals;
      if ((word !== 'on' && word !== 'off') || more.length > 0) {
        log('keycloak-admin: single-factor takes on or off');
        return 2;
      }
      const result = await admin.setSecondFactor(word === 'off');
      log(
        word === 'on'
          ? `keycloak-admin: DEMONSTRATION MODE, one factor: the second factor of the browser flow is ${result.requirement}; ${result.released} pending request(s) to configure a one-time password removed`
          : `keycloak-admin: the second factor of the browser flow is ${result.requirement} again (every sign-in asks for it)`,
      );
      return 0;
    }
    log('keycloak-admin: commands are disable-directory, enable-directory, create-user, delete-user, apply-presentation, single-factor');
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
