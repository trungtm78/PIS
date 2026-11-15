// The people of `clip-seed` on an installation that has no development session (a demo installation that runs the released images): each person of the seed layer signs in
// at the realm as the account the installation gave them (authorization code with PKCE, password and one-time password: scripts/onprem-api-token.mjs), chooses the tenant, and
// the tenant token is kept until it is about to end. A tenant token lives five minutes, an apply runs for an hour in many processes: the tokens are shared through a cache file
// of the run (tokens only, never a password or a secret; the caller deletes it).
//
// The credentials are one JSON text: { "origin": "https://host:8443", "tenantId", "people": { "<person key>": { "username", "password", "totpSecret", "membershipId" } } }.
// infra/onprem-windows/tools/demo-tenant.mjs writes that file on the server; it is read from the standard input (`--credentials -`) so that it never lands on this machine.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tokensOf } from './onprem-api-token.mjs';

/** A token that ends within this many seconds is not used for a new call. */
export const TOKEN_MARGIN_SECONDS = 45;

/** What is wrong with the credentials, as sentences; empty when they can be used. `required` are the person keys that must have an account. */
export function credentialProblems(credentials, required = []) {
  const problems = [];
  if (typeof credentials !== 'object' || credentials === null) return ['the credentials are not a JSON object'];
  if (typeof credentials.origin !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(credentials.origin)) problems.push('origin must be the address of the installation, without a path');
  if (typeof credentials.tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(credentials.tenantId)) problems.push('tenantId is missing');
  const people = typeof credentials.people === 'object' && credentials.people !== null ? credentials.people : {};
  for (const key of required) if (people[key] === undefined) problems.push(`the person ${key} has no account`);
  for (const [key, account] of Object.entries(people)) {
    for (const name of ['username', 'password', 'totpSecret']) if (typeof account?.[name] !== 'string' || account[name] === '') problems.push(`people.${key}.${name} is missing`);
    if (typeof account?.membershipId !== 'string' || !/^[0-9a-f-]{36}$/i.test(account.membershipId)) problems.push(`people.${key}.membershipId is missing`);
  }
  return problems;
}

/** The credentials of a run: the text of a file, or of the standard input when the path is `-`. A leading line that is not JSON (a banner of ssh) is dropped. */
export function readCredentials(path, read = (file) => readFileSync(file === '-' ? 0 : file, 'utf8')) {
  const text = read(path);
  return JSON.parse(text.slice(text.indexOf('{')));
}

/**
 * `brokerOf(credentials, { cacheFile })`: `token(person)` gives a tenant token of the person that is good for at least TOKEN_MARGIN_SECONDS, signing in only when none is kept;
 * `forget(person)` drops the kept one (the API refused it). A sign-in that fails is not tried again by the broker: five failures in a row lock the account at the realm.
 */
export function brokerOf(credentials, { cacheFile, signIn = tokensOf, now = () => Date.now(), fetch = globalThis.fetch } = {}) {
  const kept = new Map();
  const failed = new Map();
  const load = () => {
    if (cacheFile === undefined || cacheFile === '' || !existsSync(cacheFile)) return;
    try {
      for (const [person, entry] of Object.entries(JSON.parse(readFileSync(cacheFile, 'utf8')))) {
        const mine = kept.get(person);
        if (mine === undefined || entry.expiresAt > mine.expiresAt) kept.set(person, entry);
      }
    } catch {
      // a cache another process is writing is read at the next call
    }
  };
  const save = () => {
    if (cacheFile === undefined || cacheFile === '') return;
    writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(kept)), { encoding: 'utf8', mode: 0o600 });
  };
  const fresh = (entry) => entry !== undefined && entry.expiresAt - now() > TOKEN_MARGIN_SECONDS * 1000;
  // One sign-in of a person at a time: callers that ask together wait for the same one (the realm must not see the same person sign in several times at once).
  const pending = new Map();
  const signInOnce = async (person) => {
    if (!pending.has(person)) pending.set(person, tokenOf(person).finally(() => pending.delete(person)));
    return pending.get(person);
  };
  const tokenOf = async (person) => {
      if (!fresh(kept.get(person))) load();
      const entry = kept.get(person);
      if (fresh(entry)) return entry.token;
      const account = credentials.people[person];
      if (account === undefined) throw new Error(`the person ${person} has no account in the credentials`);
      if (failed.has(person)) throw new Error(`the sign-in of ${person} failed before and is not tried again: ${failed.get(person)}`);
      let tokens;
      try {
        tokens = await signIn({ origin: credentials.origin, username: account.username, password: account.password, totpSecret: account.totpSecret, tenantId: credentials.tenantId, membershipId: account.membershipId }, { fetch });
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 300);
        failed.set(person, message);
        throw new Error(`the sign-in of ${person} (${account.username}) failed: ${message}`);
      }
      kept.set(person, { token: tokens.tenant, expiresAt: now() + Number(tokens.expiresIn ?? 300) * 1000 });
      save();
      return tokens.tenant;
  };
  return {
    token(person) {
      const entry = kept.get(person);
      return fresh(entry) ? Promise.resolve(entry.token) : signInOnce(person);
    },
    forget(person) {
      // The token the API refused is dropped here and in the cache, unless another process has already put a later one there.
      const refused = kept.get(person)?.token;
      load();
      if (kept.get(person)?.token === refused) kept.delete(person);
      save();
    },
  };
}
