import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountProblems, main } from './onprem-api-token.mjs';

const ACCOUNT = { origin: 'https://name.example.vn:8443', username: 'a.b', password: 'the-password', totpSecret: 'Abcdefghij0123456789', tenantId: 'c6f3621b-059a-4d97-bdce-489b16fbd18f', membershipId: '2682b7fc-1bcc-477d-a169-e0ff69dfe895' };

test('accountProblems names the fields that are missing or wrong', () => {
  assert.deepEqual(accountProblems(ACCOUNT), []);
  assert.deepEqual(accountProblems({}), ['origin', 'username', 'password', 'totpSecret', 'tenantId', 'membershipId']);
  assert.deepEqual(accountProblems({ ...ACCOUNT, origin: 'http://name.example.vn', tenantId: 'x' }), ['origin', 'tenantId']);
  assert.deepEqual(accountProblems({ ...ACCOUNT, tenantId: undefined, membershipId: undefined }, { identityOnly: true }), []);
});

/** A stand-in of the identity provider and the API: a sign-in page, the one-time password page, the token endpoint and the tenant selection. */
function stack({ selection = { status: 200, body: { access_token: 'tenant-token', expires_in: 300 } } } = {}) {
  const seen = [];
  const page = (form) => `<html><title>Sign in</title><form id="f" action="${ACCOUNT.origin}/idp/realms/machvon/login-actions/authenticate?step=${form}" method="post">${form === 'password' ? '<input name="username" value=""><input name="password" value="">' : '<input name="otp" value="">'}</form></html>`;
  const answer = (status, { body = '', location, json } = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (name) => (name === 'location' ? (location ?? null) : null), getSetCookie: () => [] }, text: async () => body, json: async () => json });
  const fetch = async (url, init = {}) => {
    const address = new URL(url);
    seen.push({ path: address.pathname, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : '', authorization: init.headers?.authorization });
    if (address.pathname.endsWith('/protocol/openid-connect/auth')) {
      stack.state = address.searchParams.get('state');
      return answer(200, { body: page('password') });
    }
    if (address.pathname.endsWith('/login-actions/authenticate')) {
      if (address.searchParams.get('step') === 'password') return answer(200, { body: page('otp') });
      return answer(302, { location: `${ACCOUNT.origin}/auth/callback?state=${stack.state}&code=the-code` });
    }
    if (address.pathname.endsWith('/protocol/openid-connect/token')) return answer(200, { json: { access_token: 'identity-token' } });
    if (address.pathname === '/api/me/session/tenant-selection') return answer(selection.status, { json: selection.body });
    return answer(404);
  };
  return { fetch, seen };
}

test('main signs the person in with the password and the one-time password, chooses the tenant and prints only the tenant token', async () => {
  const { fetch, seen } = stack();
  const out = [];
  const errors = [];
  const status = await main(['--account', '-'], { log: (line) => out.push(line), error: (line) => errors.push(line), read: () => `banner of the shell\n${JSON.stringify(ACCOUNT)}`, fetch, sleep: async () => {} });
  assert.deepEqual([status, out, errors], [0, ['tenant-token'], []]);
  const posts = seen.filter((call) => call.method === 'POST');
  assert.ok(posts[0].body.includes('username=a.b') && posts[0].body.includes('password=the-password'));
  assert.match(posts[1].body, /otp=\d{6}/);
  assert.ok(posts[2].body.includes('grant_type=authorization_code') && posts[2].body.includes('code=the-code') && posts[2].body.includes('client_id=machvon-web') && posts[2].body.includes('code_verifier='));
  assert.equal(posts[3].authorization, 'Bearer identity-token');
  assert.deepEqual(JSON.parse(posts[3].body), { tenant_id: ACCOUNT.tenantId, membership_id: ACCOUNT.membershipId });
});

test('main prints the identity token with --identity-only and a JSON object with --json', async () => {
  const lines = [];
  assert.equal(await main(['--account', 'f', '--identity-only'], { log: (line) => lines.push(line), error: () => {}, read: () => JSON.stringify(ACCOUNT), fetch: stack().fetch, sleep: async () => {} }), 0);
  assert.equal(lines[0], 'identity-token');
  assert.equal(await main(['--account', 'f', '--json'], { log: (line) => lines.push(line), error: () => {}, read: () => JSON.stringify(ACCOUNT), fetch: stack().fetch, sleep: async () => {} }), 0);
  assert.deepEqual(JSON.parse(lines[1]), { access_token: 'tenant-token', expires_in: 300, tenant_id: ACCOUNT.tenantId, membership_id: ACCOUNT.membershipId });
});

test('main reports wrong arguments, an unusable account file and a refused session, without the password or the secret', async () => {
  const errors = [];
  const error = (line) => errors.push(line);
  assert.equal(await main([], { log: () => {}, error }), 2);
  assert.equal(await main(['--nope'], { log: () => {}, error }), 2);
  assert.equal(await main(['--account', 'f'], { log: () => {}, error, read: () => 'not json' }), 2);
  assert.equal(await main(['--account', 'f'], { log: () => {}, error, read: () => JSON.stringify({ ...ACCOUNT, totpSecret: '' }) }), 2);
  assert.match(errors.at(-1), /totpSecret/);
  const refused = stack({ selection: { status: 403, body: { code: 'SCOPE_DENIED' } } });
  assert.equal(await main(['--account', 'f'], { log: () => {}, error, read: () => JSON.stringify(ACCOUNT), fetch: refused.fetch, sleep: async () => {} }), 1);
  assert.match(errors.at(-1), /FAILED the tenant session was refused: 403 SCOPE_DENIED/);
  assert.ok(!errors.join('\n').includes('the-password') && !errors.join('\n').includes('Abcdefghij'));
});
