// keycloak-admin set-host: the browser clients of the realm follow the installation to a new public address (host\install.ps1 -Rehost).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../infra/onprem-windows/tools/keycloak-admin.mjs';

/** A Keycloak that answers the token request and the clients of the realm, and keeps what is written to them. */
function fakeKeycloak(clients) {
  const puts = [];
  const fetch = async (url, init = {}) => {
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
    if (url.endsWith('/protocol/openid-connect/token')) return reply(200, { access_token: 'token' });
    if (url.includes('/clients?max=')) return reply(200, clients);
    const put = /\/clients\/([^/]+)$/.exec(url);
    if (put && init.method === 'PUT') {
      puts.push({ id: put[1], body: JSON.parse(init.body) });
      return reply(204, undefined);
    }
    return reply(404, { error: 'not found' });
  };
  return { fetch, puts };
}

const CLIENTS = [
  { id: '1', clientId: 'machvon-web', redirectUris: ['https://old.example/auth/callback'], webOrigins: ['https://old.example'], attributes: { 'post.logout.redirect.uris': 'https://old.example/*', 'default.acr.values': 'aal2' } },
  { id: '2', clientId: 'machvon-control', redirectUris: ['https://old.example/auth/callback'], webOrigins: ['https://old.example'], attributes: { 'post.logout.redirect.uris': 'https://old.example/*' } },
  { id: '3', clientId: 'machvon-mobile', redirectUris: ['vn.machvon.app:/oauth2redirect'], webOrigins: [], attributes: {} },
];

const run = (argv, fetch) => {
  const lines = [];
  const env = { KEYCLOAK_ADMIN_USER: 'admin', OIDC_REALM: 'machvon', KEYCLOAK_INTERNAL_URL: 'http://kc/idp' };
  return main(argv, { env, fetch, log: (line) => lines.push(line), read: () => 'secret' }).then((code) => ({ code, lines }));
};

test('set-host points the callback, the origin and the sign-out of both browser clients at the new address, and keeps their other settings', async () => {
  const kc = fakeKeycloak(structuredClone(CLIENTS));
  const { code, lines } = await run(['set-host', '--tenant-host', 'machvon.vn:8443'], kc.fetch);
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(kc.puts.map((put) => put.id).sort(), ['1', '2']);
  for (const put of kc.puts) {
    assert.deepEqual(put.body.redirectUris, ['https://machvon.vn:8443/auth/callback']);
    assert.deepEqual(put.body.webOrigins, ['https://machvon.vn:8443']);
    assert.equal(put.body.attributes['post.logout.redirect.uris'], 'https://machvon.vn:8443/*');
  }
  assert.equal(kc.puts.find((put) => put.id === '1').body.attributes['default.acr.values'], 'aal2');
});

test('set-host leaves the mobile client alone: its callback is the scheme of the application, not an address', async () => {
  const kc = fakeKeycloak(structuredClone(CLIENTS));
  await run(['set-host', '--tenant-host', 'machvon.vn:8443'], kc.fetch);
  assert.equal(kc.puts.some((put) => put.id === '3'), false);
});

test('set-host refuses an address that is not host[:port] and writes nothing', async () => {
  for (const bad of ['https://machvon.vn', 'machvon.vn/path', 'machvon vn', '']) {
    const kc = fakeKeycloak(structuredClone(CLIENTS));
    const { code } = await run(['set-host', '--tenant-host', bad], kc.fetch);
    assert.equal(code, 2, bad);
    assert.equal(kc.puts.length, 0, bad);
  }
});

test('set-host fails when a browser client is missing from the realm, instead of saying it moved', async () => {
  const kc = fakeKeycloak(structuredClone(CLIENTS.filter((client) => client.clientId !== 'machvon-control')));
  const { code, lines } = await run(['set-host', '--tenant-host', 'machvon.vn:8443'], kc.fetch);
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /no client machvon-control/);
  assert.equal(kc.puts.length, 0, 'nothing is written when the move cannot be whole');
});
