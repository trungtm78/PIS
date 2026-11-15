#!/usr/bin/env node
// Creates the first tenant of an on-prem installation and invites its owner, through the official path: the control-plane API
// (requestTenantProvisioning, POST /system/tenants) called with a token of the control client `machvon-control`.
//
//   node scripts/onprem-first-tenant.mjs --public-host <host> --control-host <host> --code <tenant code> --name "<tenant name>" \
//        --owner-email <email> --root-unit-name "<name of the root unit>" --subdomain <subdomain> [--locale vi|en]
//   node scripts/onprem-first-tenant.mjs --public-host <host> --control-host <host> --reinvite <tenant id> --owner-email <email> \
//        --reason "<why, 10 characters or more>" --document-ref "<request document>"
//
// The person who runs it is a system administrator of the realm (role SystemAdmin: a member of the directory group MACHVON-SYSTEM-ADMINS). The script holds no
// password and no client secret: it prints the sign-in address of the identity provider, the administrator signs in there in a browser with the second factor the realm
// demands, and pastes the address the browser was sent back to. The authorization code of that address is exchanged with PKCE (the control client is a public client),
// and the token lives only in the memory of this process.
//
// It needs Node 24 and nothing else. With a certificate of a private authority on the edge, name the authority: NODE_EXTRA_CA_CERTS=/path/to/ca.pem.
// The bundle carries this file (scripts/onprem-first-tenant.mjs); docs/runbooks/deploy-web-quickstart.md, section 7, shows how to run it on the server with the api image.
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_LOCALE, format, loadOnpremMessages } from './onprem-messages.mjs';

export const CONTROL_CLIENT = 'machvon-control';
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_SECONDS = 3;

/** A failure the operator can act on: `code` names the message, `detail` what the server or the input said. */
export class FirstTenantError extends Error {
  constructor(code, detail = '') {
    super(`${code}${detail === '' ? '' : `: ${detail}`}`);
    this.code = code;
    this.detail = detail;
  }
}

/** The verifier and the challenge of one sign-in (RFC 7636, S256). */
export function pkcePair(random = randomBytes) {
  const verifier = random(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const issuerOf = (publicHost, realm = 'machvon') => `https://${publicHost}/idp/realms/${realm}`;
export const redirectUriOf = (controlHost) => `https://${controlHost}/auth/callback`;

/** The address the administrator opens: the authorization request of the control client. */
export function authorizationUrl({ issuer, redirectUri, state, challenge, clientId = CONTROL_CLIENT }) {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid', state, code_challenge: challenge, code_challenge_method: 'S256' });
  return `${issuer}/protocol/openid-connect/auth?${query.toString()}`;
}

/** The authorization code of the address the browser was sent back to. Anything else (another state, an error of the identity provider, no code) is refused. */
export function codeOf(callbackUrl, state) {
  let url;
  try {
    url = new URL(String(callbackUrl).trim());
  } catch {
    throw new FirstTenantError('CALLBACK_INVALID');
  }
  const error = url.searchParams.get('error');
  if (error !== null) throw new FirstTenantError('SIGN_IN_REFUSED', error);
  const code = url.searchParams.get('code');
  if (code === null || code === '' || url.searchParams.get('state') !== state) throw new FirstTenantError('CALLBACK_INVALID');
  return code;
}

async function tokenRequest({ issuer, form, fetch }) {
  let response;
  try {
    response = await fetch(`${issuer}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  } catch (error) {
    throw new FirstTenantError('UNREACHABLE', `${issuer}: ${error?.cause?.code ?? error?.message ?? ''}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== 'string') throw new FirstTenantError('TOKEN_REFUSED', String(body.error ?? response.status));
  return { accessToken: body.access_token, refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined };
}

/** Exchanges the authorization code for the tokens of the administrator (public client, PKCE: no secret is sent). */
export function exchangeCode({ issuer, redirectUri, code, verifier, clientId = CONTROL_CLIENT, fetch = globalThis.fetch }) {
  return tokenRequest({ issuer, fetch, form: { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier } });
}

export function refreshTokens({ issuer, refreshToken, clientId = CONTROL_CLIENT, fetch = globalThis.fetch }) {
  return tokenRequest({ issuer, fetch, form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken } });
}

/**
 * The control-plane API as this script uses it. A 401 is answered once with fresh tokens when `refresh` is given (an access token lives five minutes and provisioning
 * may take longer); every other refusal is an error that carries the problem code of the server.
 */
export class ControlApi {
  constructor({ baseUrl, tokens, refresh, fetch = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokens = tokens;
    this.refresh = refresh;
    this.fetch = fetch;
  }

  async call(method, path, { body, idempotencyKey } = {}) {
    const send = async () => {
      const headers = { authorization: `Bearer ${this.tokens.accessToken}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
      try {
        return await this.fetch(`${this.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (error) {
        throw new FirstTenantError('UNREACHABLE', `${this.baseUrl}: ${error?.cause?.code ?? error?.message ?? ''}`);
      }
    };
    let response = await send();
    if (response.status === 401 && this.refresh !== undefined && this.tokens.refreshToken !== undefined) {
      this.tokens = await this.refresh(this.tokens.refreshToken);
      response = await send();
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const code = typeof parsed?.code === 'string' ? parsed.code : typeof parsed?.title === 'string' ? parsed.title : '';
      throw new FirstTenantError(response.status === 401 ? 'NOT_SIGNED_IN' : response.status === 403 ? 'NOT_ALLOWED' : 'API_REFUSED', `${method} ${path} ${response.status} ${code}`.trim());
    }
    return parsed;
  }
}

/** The newest Published revision of a plan (the STANDARD plan is seeded by the migrations). */
export async function publishedPlan(api, planCode = 'STANDARD') {
  const page = await api.call('GET', `/system/plans?status=Published&plan_code=${encodeURIComponent(planCode)}&limit=200`);
  const found = (page?.items ?? []).filter((plan) => plan.plan_code === planCode && plan.status === 'Published').sort((left, right) => right.revision - left.revision)[0];
  if (found === undefined) throw new FirstTenantError('PLAN_NOT_PUBLISHED', planCode);
  return found;
}

/** The key of the request: the same input gives the same key, so that running the script again replays the stored answer and never requests a second tenant. */
export function idempotencyKeyOf(operation, body) {
  return `${operation}-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 40)}`;
}

/** requestTenantProvisioning: the answer names the tenant and its provisioning run. */
export function requestTenant(api, input) {
  const body = {
    code: input.code,
    name: input.name,
    governing_body_type: input.governingBodyType,
    region: input.region,
    isolation_mode: input.isolationMode,
    plan_version_id: input.planVersionId,
    root_unit_name: input.rootUnitName,
    initial_owner_email: input.ownerEmail,
    platform_subdomain: input.subdomain,
  };
  return api.call('POST', '/system/tenants', { body, idempotencyKey: idempotencyKeyOf('requestTenantProvisioning', body) });
}

/** Reads the tenant until the workers finished the provisioning steps: Active is the end, Failed names the step and its code, and the wait has a limit. */
export async function waitForTenant(api, tenantId, { timeoutSeconds = 300, sleep = (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)), now = () => Date.now(), onStep = () => {} } = {}) {
  const deadline = now() + timeoutSeconds * 1000;
  let seen = '';
  for (;;) {
    const detail = await api.call('GET', `/system/tenants/${tenantId}`);
    const step = detail?.provisioning?.current_step ?? '';
    if (`${detail?.status}:${step}` !== seen) {
      seen = `${detail?.status}:${step}`;
      onStep(detail);
    }
    if (detail?.status === 'Active') return detail;
    if (detail?.status === 'Failed') {
      const failed = (detail.provisioning?.steps ?? []).find((entry) => entry.status === 'FAILED');
      throw new FirstTenantError('PROVISIONING_FAILED', `${failed?.step ?? step} ${failed?.error_code ?? ''}`.trim());
    }
    if (now() >= deadline) throw new FirstTenantError('PROVISIONING_TIMEOUT', `${detail?.status ?? ''} ${step}`.trim());
    await sleep(POLL_SECONDS);
  }
}

/** assignTenantOwner: names the owner again, which also replaces a pending invitation by a new one (how an invitation is sent again). */
export function assignOwner(api, tenantId, { email, reason, documentRef }) {
  const body = { user_email: email, request_document_ref: documentRef, reason };
  return api.call('POST', `/system/tenants/${tenantId}/owners`, { body, idempotencyKey: idempotencyKeyOf(`assignTenantOwner-${tenantId}-${Date.now()}`, body) });
}

const OPTIONS = {
  'public-host': { type: 'string' },
  'control-host': { type: 'string' },
  realm: { type: 'string', default: 'machvon' },
  code: { type: 'string' },
  name: { type: 'string' },
  'owner-email': { type: 'string' },
  'root-unit-name': { type: 'string' },
  subdomain: { type: 'string' },
  'governing-body-type': { type: 'string', default: 'PROVINCE' },
  region: { type: 'string', default: 'vn-south' },
  'isolation-mode': { type: 'string', default: 'POOL' },
  'plan-code': { type: 'string', default: 'STANDARD' },
  'wait-seconds': { type: 'string', default: '300' },
  reinvite: { type: 'string' },
  reason: { type: 'string' },
  'document-ref': { type: 'string' },
  locale: { type: 'string', default: DEFAULT_LOCALE },
};

/** What is wrong with the arguments, as the names of the options; empty when the call can go on. */
export function missingOptions(values) {
  const email = (value) => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const wrong = [];
  for (const name of ['public-host', 'control-host']) if (typeof values[name] !== 'string' || !HOST_NAME.test(values[name])) wrong.push(name);
  if (!email(values['owner-email'])) wrong.push('owner-email');
  if (!/^[1-9][0-9]{0,3}$/.test(String(values['wait-seconds']))) wrong.push('wait-seconds');
  if (values.reinvite !== undefined) {
    if (!UUID.test(values.reinvite)) wrong.push('reinvite');
    if (typeof values.reason !== 'string' || values.reason.trim().length < 10) wrong.push('reason');
    if (typeof values['document-ref'] !== 'string' || values['document-ref'].trim().length < 5) wrong.push('document-ref');
    return wrong;
  }
  if (typeof values.code !== 'string' || !/^[a-z][a-z0-9-]{2,30}$/.test(values.code)) wrong.push('code');
  if (typeof values.name !== 'string' || values.name.trim().length < 3) wrong.push('name');
  if (typeof values['root-unit-name'] !== 'string' || values['root-unit-name'].trim().length < 3) wrong.push('root-unit-name');
  if (typeof values.subdomain !== 'string' || !/^[a-z0-9-]{3,40}$/.test(values.subdomain)) wrong.push('subdomain');
  if (!['PROVINCE', 'MINISTRY', 'CENTRAL_AGENCY'].includes(values['governing-body-type'])) wrong.push('governing-body-type');
  if (!['vn-north', 'vn-south'].includes(values.region)) wrong.push('region');
  if (!['POOL', 'SILO'].includes(values['isolation-mode'])) wrong.push('isolation-mode');
  return wrong;
}

async function askOnTerminal(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

/**
 * The whole procedure. `fetch`, `ask` (prints the sign-in address and returns what the administrator pasted) and `random` are injected so that the tests run it against
 * a stand-in of the identity provider and of the API.
 */
export async function main(argv, { log = console.log, fetch = globalThis.fetch, ask = askOnTerminal, random = randomBytes, sleep } = {}) {
  let values;
  let messages = loadOnpremMessages(DEFAULT_LOCALE);
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
    messages = loadOnpremMessages(values.locale);
  } catch {
    log(messages['tenant.usage']);
    return 2;
  }
  const wrong = missingOptions(values);
  if (wrong.length > 0) {
    log(format(messages['tenant.options'], { names: wrong.map((name) => `--${name}`).join(', ') }));
    log(messages['tenant.usage']);
    return 2;
  }
  const issuer = issuerOf(values['public-host'], values.realm);
  const redirectUri = redirectUriOf(values['control-host']);
  try {
    const { verifier, challenge } = pkcePair(random);
    const state = random(16).toString('base64url');
    log(messages['tenant.open']);
    log(authorizationUrl({ issuer, redirectUri, state, challenge }));
    const pasted = await ask(`${messages['tenant.paste']}\n> `);
    const tokens = await exchangeCode({ issuer, redirectUri, code: codeOf(pasted, state), verifier, fetch });
    const api = new ControlApi({ baseUrl: `https://${values['public-host']}/api`, tokens, fetch, refresh: (refreshToken) => refreshTokens({ issuer, refreshToken, fetch }) });

    if (values.reinvite !== undefined) {
      await assignOwner(api, values.reinvite, { email: values['owner-email'], reason: values.reason.trim(), documentRef: values['document-ref'].trim() });
      log(format(messages['tenant.invited'], { email: values['owner-email'] }));
      log(messages['tenant.handover']);
      return 0;
    }

    const plan = await publishedPlan(api, values['plan-code']);
    const requested = await requestTenant(api, {
      code: values.code,
      name: values.name.trim(),
      governingBodyType: values['governing-body-type'],
      region: values.region,
      isolationMode: values['isolation-mode'],
      planVersionId: plan.id,
      rootUnitName: values['root-unit-name'].trim(),
      ownerEmail: values['owner-email'],
      subdomain: values.subdomain,
    });
    log(format(messages['tenant.requested'], { id: requested.tenant_id, plan: `${plan.plan_code} ${plan.revision}` }));
    const detail = await waitForTenant(api, requested.tenant_id, {
      timeoutSeconds: Number(values['wait-seconds']),
      ...(sleep === undefined ? {} : { sleep }),
      onStep: (seen) => log(format(messages['tenant.step'], { status: seen?.status ?? '', step: seen?.provisioning?.current_step ?? '' })),
    });
    log(format(messages['tenant.active'], { id: detail.id, code: detail.code }));
    log(format(messages['tenant.invited'], { email: values['owner-email'] }));
    log(messages['tenant.handover']);
    return 0;
  } catch (error) {
    if (!(error instanceof FirstTenantError)) throw error;
    // The one refusal with a cause on the host: no active shared placement in the region asked for.
    const code = error.detail.includes('PLACEMENT_UNAVAILABLE') ? 'PLACEMENT_UNAVAILABLE' : error.code;
    log(format(messages[`tenant.error.${code}`] ?? messages['tenant.error.API_REFUSED'], { detail: error.detail }));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
