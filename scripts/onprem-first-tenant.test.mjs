import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ControlApi, FirstTenantError, authorizationUrl, codeOf, exchangeCode, idempotencyKeyOf, issuerOf, main, missingOptions, pkcePair, publishedPlan, redirectUriOf, waitForTenant } from './onprem-first-tenant.mjs';
import { loadOnpremMessages } from './onprem-messages.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PLAN = '00000000-0000-4000-9000-000000000001';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fixedRandom = (size) => Buffer.alloc(size, 7);
const STATE = fixedRandom(16).toString('base64url');
const ARGS = ['--public-host', 'machvon.example.vn', '--control-host', 'control.example.vn', '--code', 'dpm', '--name', 'Dam Phu My', '--owner-email', 'owner@example.vn', '--root-unit-name', 'Tong cong ty', '--subdomain', 'dpm', '--locale', 'en'];

/** A stand-in of the identity provider and of the control-plane API: it records every request and answers like the real ones. */
function installation({ statuses = ['Provisioning', 'Active'], tokenStatus = 200, tenantStatus = 202, roles = true } = {}) {
  const calls = [];
  let reads = 0;
  let access = 0;
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const call = { method: init.method ?? 'GET', path: pathname, headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    if (pathname.endsWith('/protocol/openid-connect/token')) {
      const form = new URLSearchParams(init.body);
      call.form = Object.fromEntries(form);
      if (tokenStatus !== 200) return json(tokenStatus, { error: 'invalid_grant' });
      access += 1;
      return json(200, { access_token: `access-${access}`, refresh_token: `refresh-${access}` });
    }
    if (call.headers.authorization === 'Bearer access-1' && reads >= 1 && statuses.length > 2) return json(401, { code: 'SESSION_EXPIRED' });
    if (!roles) return json(403, { code: 'SCOPE_DENIED' });
    if (pathname === '/api/system/plans') return json(200, { items: [{ id: 'old', plan_code: searchParams.get('plan_code'), status: 'Published', revision: 1 }, { id: PLAN, plan_code: searchParams.get('plan_code'), status: 'Published', revision: 2 }, { id: 'draft', plan_code: 'STANDARD', status: 'Draft', revision: 3 }] });
    if (pathname === '/api/system/tenants' && call.method === 'POST') return tenantStatus === 202 ? json(202, { tenant_id: TENANT, status: 'Requested', version: 1 }) : json(tenantStatus, { code: 'TENANT_CODE_TAKEN' });
    if (pathname === `/api/system/tenants/${TENANT}`) {
      const status = statuses[Math.min(reads, statuses.length - 1)];
      reads += 1;
      return json(200, { id: TENANT, code: 'dpm', status, version: 2, provisioning: { current_step: status === 'Active' ? 'INVITE_OWNER' : 'RLS_SEED', steps: status === 'Failed' ? [{ step: 'RLS_SEED', status: 'FAILED', error_code: 'PLACEMENT_UNAVAILABLE' }] : [] } });
    }
    if (pathname === `/api/system/tenants/${TENANT}/owners`) return json(201, { result: 'OWNER_ASSIGNED' });
    return json(404, { code: 'RESOURCE_NOT_FOUND' });
  };
  return { fetch, calls };
}

const run = async (argv, world, pasted = `https://control.example.vn/auth/callback?state=${STATE}&code=the-code`) => {
  const lines = [];
  const status = await main(argv, { log: (line) => lines.push(line), fetch: world.fetch, random: fixedRandom, sleep: async () => {}, ask: async () => pasted });
  return { status, lines };
};

test('the sign-in address is the authorization request of the control client with PKCE, and the code is only taken from the address of this sign-in', () => {
  const { verifier, challenge } = pkcePair(fixedRandom);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  const url = new URL(authorizationUrl({ issuer: issuerOf('machvon.example.vn'), redirectUri: redirectUriOf('control.example.vn'), state: 's1', challenge }));
  assert.equal(`${url.origin}${url.pathname}`, 'https://machvon.example.vn/idp/realms/machvon/protocol/openid-connect/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), { response_type: 'code', client_id: 'machvon-control', redirect_uri: 'https://control.example.vn/auth/callback', scope: 'openid', state: 's1', code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal(codeOf(' https://control.example.vn/auth/callback?state=s1&code=abc \n', 's1'), 'abc');
  for (const [pasted, code] of [['not an address', 'CALLBACK_INVALID'], ['https://control.example.vn/auth/callback?state=other&code=abc', 'CALLBACK_INVALID'], ['https://control.example.vn/auth/callback?state=s1', 'CALLBACK_INVALID'], ['https://control.example.vn/auth/callback?error=access_denied&state=s1', 'SIGN_IN_REFUSED']]) {
    assert.throws(() => codeOf(pasted, 's1'), (error) => error instanceof FirstTenantError && error.code === code, pasted);
  }
});

test('the code is exchanged without a secret, with the verifier of this sign-in', async () => {
  const world = installation();
  const tokens = await exchangeCode({ issuer: issuerOf('h.example.vn', 'r1'), redirectUri: redirectUriOf('c.example.vn'), code: 'c1', verifier: 'v1', fetch: world.fetch });
  assert.deepEqual(tokens, { accessToken: 'access-1', refreshToken: 'refresh-1' });
  assert.equal(world.calls[0].path, '/idp/realms/r1/protocol/openid-connect/token');
  assert.deepEqual(world.calls[0].form, { grant_type: 'authorization_code', client_id: 'machvon-control', redirect_uri: 'https://c.example.vn/auth/callback', code: 'c1', code_verifier: 'v1' });
  await assert.rejects(exchangeCode({ issuer: 'https://h/idp/realms/r', redirectUri: 'x', code: 'c', verifier: 'v', fetch: installation({ tokenStatus: 400 }).fetch }), (error) => error.code === 'TOKEN_REFUSED' && error.detail === 'invalid_grant');
  await assert.rejects(exchangeCode({ issuer: 'https://h/idp/realms/r', redirectUri: 'x', code: 'c', verifier: 'v', fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } }), (error) => error.code === 'UNREACHABLE' && error.detail.includes('ENOTFOUND'));
});

test('the whole procedure: sign-in, the newest Published plan, the request with a stable idempotency key, the wait until Active, the hand-over of the invitation', async () => {
  const world = installation();
  const { status, lines } = await run(ARGS, world);
  assert.equal(status, 0, lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('https://machvon.example.vn/idp/realms/machvon/protocol/openid-connect/auth?')));
  const request = world.calls.find((call) => call.method === 'POST' && call.path === '/api/system/tenants');
  const body = JSON.parse(request.body);
  assert.deepEqual(body, { code: 'dpm', name: 'Dam Phu My', governing_body_type: 'PROVINCE', region: 'vn-south', isolation_mode: 'POOL', plan_version_id: PLAN, root_unit_name: 'Tong cong ty', initial_owner_email: 'owner@example.vn', platform_subdomain: 'dpm' });
  assert.equal(request.headers.authorization, 'Bearer access-1');
  assert.equal(request.headers['idempotency-key'], idempotencyKeyOf('requestTenantProvisioning', body));
  assert.ok(request.headers['idempotency-key'].length >= 16 && request.headers['idempotency-key'].length <= 128);
  assert.ok(lines.some((line) => line.includes(`tenant dpm is Active: ${TENANT}`)));
  assert.ok(lines.some((line) => line.includes('owner@example.vn')));
  assert.ok(lines.some((line) => line.includes('/var/lib/machvon/invitations')));
  // Running it again sends the same key: the server replays the stored answer and requests no second tenant.
  const again = installation();
  await run(ARGS, again);
  assert.equal(again.calls.find((call) => call.path === '/api/system/tenants').headers['idempotency-key'], request.headers['idempotency-key']);
  assert.ok(!lines.join('\n').includes('access-1'), 'a token is never printed');
});

test('an access token that expires while the workers provision is replaced once with the refresh token', async () => {
  const world = installation({ statuses: ['Provisioning', 'Provisioning', 'Active'] });
  const { status } = await run(ARGS, world);
  assert.equal(status, 0);
  const refresh = world.calls.find((call) => call.form?.grant_type === 'refresh_token');
  assert.deepEqual(refresh.form, { grant_type: 'refresh_token', client_id: 'machvon-control', refresh_token: 'refresh-1' });
  assert.equal(world.calls.at(-1).headers.authorization, 'Bearer access-2');
});

test('every refusal ends with status 1 and a message that names what to do', async () => {
  const messages = loadOnpremMessages('en');
  const said = async (world, pasted) => (await run(ARGS, world, pasted)).lines.at(-1);
  assert.equal(await said(installation(), 'https://control.example.vn/auth/callback?state=wrong&code=x'), messages['tenant.error.CALLBACK_INVALID']);
  assert.match(await said(installation({ tokenStatus: 400 })), /did not issue a token: invalid_grant/);
  assert.match(await said(installation({ roles: false })), /may not do this: GET \/system\/plans\S* 403 SCOPE_DENIED/);
  assert.match(await said(installation({ tenantStatus: 409 })), /refused the request: POST \/system\/tenants 409 TENANT_CODE_TAKEN/);
  assert.match(await said(installation({ statuses: ['Failed'] })), /provisioning failed at RLS_SEED PLACEMENT_UNAVAILABLE/);
  for (const world of [installation({ tokenStatus: 400 }), installation({ roles: false }), installation({ statuses: ['Failed'] })]) assert.equal((await run(ARGS, world)).status, 1);
});

test('the wait has a limit, and a plan with no Published revision is named', async () => {
  const world = installation({ statuses: ['Provisioning'] });
  const api = new ControlApi({ baseUrl: 'https://machvon.example.vn/api/', tokens: { accessToken: 'access-1' }, fetch: world.fetch });
  let clock = 0;
  const steps = [];
  await assert.rejects(
    waitForTenant(api, TENANT, { timeoutSeconds: 9, sleep: async (seconds) => { clock += seconds * 1000; }, now: () => clock, onStep: (detail) => steps.push(detail.status) }),
    (error) => error.code === 'PROVISIONING_TIMEOUT' && error.detail === 'Provisioning RLS_SEED',
  );
  assert.deepEqual(steps, ['Provisioning'], 'a step is reported once, not at every read');
  const none = new ControlApi({ baseUrl: 'https://h/api', tokens: { accessToken: 't' }, fetch: async () => json(200, { items: [] }) });
  await assert.rejects(publishedPlan(none, 'GOLD'), (error) => error.code === 'PLAN_NOT_PUBLISHED' && error.detail === 'GOLD');
});

test('sending the owner invitation again is assignTenantOwner with a reason and the request document', async () => {
  const world = installation();
  const { status, lines } = await run(['--public-host', 'machvon.example.vn', '--control-host', 'control.example.vn', '--reinvite', TENANT, '--owner-email', 'owner@example.vn', '--reason', 'the first invitation expired', '--document-ref', 'CV-12/2026', '--locale', 'en'], world);
  assert.equal(status, 0, lines.join('\n'));
  const call = world.calls.find((entry) => entry.path === `/api/system/tenants/${TENANT}/owners`);
  assert.deepEqual(JSON.parse(call.body), { user_email: 'owner@example.vn', request_document_ref: 'CV-12/2026', reason: 'the first invitation expired' });
  assert.ok(call.headers['idempotency-key'].length >= 16);
  assert.ok(!world.calls.some((entry) => entry.path === '/api/system/tenants'));
});

test('wrong arguments print what is wrong and the usage, and nothing is contacted', async () => {
  const world = installation();
  const short = await run(['--public-host', 'machvon.example.vn', '--locale', 'en'], world);
  assert.equal(short.status, 2);
  assert.match(short.lines[0], /--control-host, --owner-email, --code, --name, --root-unit-name, --subdomain/);
  assert.equal((await run(['--no-such-option'], world)).status, 2);
  assert.equal(world.calls.length, 0);
  assert.deepEqual(missingOptions({ 'public-host': 'h.vn', 'control-host': 'c.vn', 'owner-email': 'a@b.vn', 'wait-seconds': '0', reinvite: 'x', reason: 'short' }), ['wait-seconds', 'reinvite', 'reason', 'document-ref']);
  assert.deepEqual(missingOptions({ 'public-host': 'h.vn', 'control-host': 'c.vn', 'owner-email': 'a@b.vn', 'wait-seconds': '300', code: 'Bad Code', name: 'ab', 'root-unit-name': 'Root', subdomain: 'x', 'governing-body-type': 'CITY', region: 'eu', 'isolation-mode': 'NONE' }), ['code', 'name', 'subdomain', 'governing-body-type', 'region', 'isolation-mode']);
});

test('every message of the script exists in both languages', () => {
  for (const locale of ['vi', 'en']) {
    const messages = loadOnpremMessages(locale);
    for (const key of ['usage', 'options', 'open', 'paste', 'requested', 'step', 'active', 'invited', 'handover']) assert.ok(messages[`tenant.${key}`], `${locale}: tenant.${key}`);
    for (const code of ['CALLBACK_INVALID', 'SIGN_IN_REFUSED', 'TOKEN_REFUSED', 'UNREACHABLE', 'NOT_SIGNED_IN', 'NOT_ALLOWED', 'API_REFUSED', 'PLAN_NOT_PUBLISHED', 'PROVISIONING_FAILED', 'PROVISIONING_TIMEOUT']) assert.ok(messages[`tenant.error.${code}`], `${locale}: ${code}`);
  }
});

test('a refusal for want of a placement names the region setting of the installation', async () => {
  const world = installation({ tenantStatus: 422 });
  const original = world.fetch;
  world.fetch = async (url, init) => (new URL(url).pathname === '/api/system/tenants' && init?.method === 'POST' ? json(422, { code: 'PLACEMENT_UNAVAILABLE' }) : original(url, init));
  const { status, lines } = await run(ARGS, world);
  assert.equal(status, 1);
  assert.match(lines.at(-1), /MACHVON_REGION/);
});
