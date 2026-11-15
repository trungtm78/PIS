import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPILE_OPTIONS, RESOLVE_LOADER, compileSource, isCompiled, isShipped, main, manifestOf, parseOrigin, shipTree, windowsNginx } from './onprem-windows-pack.mjs';
import { loadSecretFiles } from '../infra/onprem-windows/docker/secret-files.mjs';
import { AdminError, KeycloakAdmin, main as keycloakAdmin } from '../infra/onprem-windows/tools/keycloak-admin.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const { transformSync } = createRequire(join(REPO_ROOT, 'apps', 'api', 'package.json'))('@swc/core');

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'onprem-windows-pack-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('parseOrigin accepts https://host[:port] and nothing else', () => {
  assert.deepEqual(parseOrigin('https://180-93-34-176.sslip.io:8443'), { origin: 'https://180-93-34-176.sslip.io:8443', host: '180-93-34-176.sslip.io:8443', hostname: '180-93-34-176.sslip.io', port: '8443' });
  assert.deepEqual(parseOrigin('https://machvon.example.vn'), { origin: 'https://machvon.example.vn', host: 'machvon.example.vn', hostname: 'machvon.example.vn', port: '443' });
  for (const wrong of ['http://machvon.example.vn', 'https://machvon.example.vn/path', 'https://user:pass@machvon.example.vn', 'https://machvon.example.vn?x=1', 'machvon.example.vn', '', undefined]) {
    assert.equal(parseOrigin(wrong), undefined, String(wrong));
  }
});

test('isShipped leaves tests and development configuration out; isCompiled names the TypeScript sources', () => {
  for (const kept of ['index.ts', 'modules/adm/index.ts', 'fonts/a.ttf', 'data/x.json', 'types.d.ts']) assert.equal(isShipped(kept), true, kept);
  for (const left of ['a.test.ts', 'x/b.spec.ts', 'test/helper.ts', 'modules/__tests__/a.ts', 'serve.stack.ts', 'jest.config.cjs', 'tsconfig.json', 'node_modules/x/index.js', 'README.md']) assert.equal(isShipped(left), false, left);
  assert.equal(isCompiled('a.ts'), true);
  assert.equal(isCompiled('a.d.ts'), false);
  assert.equal(isCompiled('a.json'), false);
});

test('compileSource gives JavaScript without types or comments that keeps decorators working and class names', () => {
  const source = `
    // SECRET-COMMENT: how the thing works
    import type { Other } from './other';
    function Mark(): ClassDecorator { return (target) => { (target as { marked?: boolean }).marked = true; }; }
    @Mark()
    export class Widget { constructor(private readonly size: number) {} area(): number { return this.size * 2; } }
    export const typed: Other | undefined = undefined;
  `;
  const code = compileSource(source, 'widget.ts', transformSync);
  assert.ok(!code.includes('SECRET-COMMENT'));
  assert.ok(!code.includes(': number'));
  assert.ok(!code.includes('./other'), 'an import of types only is dropped');
  assert.ok(code.includes('class Widget'));
  assert.equal(COMPILE_OPTIONS.sourceMaps, false);
});

test('shipTree compiles the sources, copies the other files and skips the tests; the result runs under Node with the resolve hook', async (t) => {
  const from = join(scratch(t), 'src');
  const to = join(scratch(t), 'out');
  mkdirSync(join(from, 'lib'), { recursive: true });
  mkdirSync(join(from, 'test'), { recursive: true });
  writeFileSync(join(from, 'main.ts'), "import { twice } from './lib/twice';\nimport data from './data.json' with { type: 'json' };\nexport const answer: number = twice(data.value);\n");
  writeFileSync(join(from, 'lib', 'twice.ts'), '/* how */ export function twice(value: number): number { return value * 2; }\n');
  writeFileSync(join(from, 'data.json'), '{"value":21}');
  writeFileSync(join(from, 'main.test.ts'), 'throw new Error("a test");\n');
  writeFileSync(join(from, 'test', 'helper.ts'), 'export const helper = 1;\n');
  assert.deepEqual(shipTree(from, to, transformSync), { compiled: 2, copied: 1 });
  assert.throws(() => readFileSync(join(to, 'main.test.ts')));
  assert.throws(() => readFileSync(join(to, 'test', 'helper.ts')));
  assert.ok(!readFileSync(join(to, 'lib', 'twice.ts'), 'utf8').includes('how'));
  assert.equal(readFileSync(join(to, 'data.json'), 'utf8'), '{"value":21}');
  // The loader of the image: imports without an extension resolve to the .ts file or to index.ts of a directory, everything else is left alone.
  const loader = await import(`data:text/javascript,${encodeURIComponent(RESOLVE_LOADER)}`);
  const asked = [];
  const next = async (specifier) => {
    asked.push(specifier);
    if (specifier === './lib/twice.ts' || specifier === './dir/index.ts' || specifier === 'node:fs' || specifier === './a.json') return { url: specifier };
    throw new Error('not found');
  };
  assert.deepEqual(await loader.resolve('./lib/twice', {}, next), { url: './lib/twice.ts' });
  assert.deepEqual(await loader.resolve('./dir', {}, next), { url: './dir/index.ts' });
  assert.deepEqual(await loader.resolve('node:fs', {}, next), { url: 'node:fs' });
  assert.deepEqual(await loader.resolve('./a.json', {}, next), { url: './a.json' });
  await assert.rejects(loader.resolve('./missing', {}, next));
});

test('windowsNginx turns the edge configuration of the product into the one nginx for Windows reads', () => {
  const template = readFileSync(join(REPO_ROOT, 'infra', 'onprem', 'nginx', 'default.conf.template'), 'utf8');
  const rendered = windowsNginx(template, { host: 'name.example.vn:8443', hostname: 'name.example.vn' });
  assert.ok(rendered.includes('server_name name.example.vn;'));
  assert.ok(rendered.includes('return 301 https://name.example.vn:8443$request_uri;'));
  assert.ok(rendered.includes('proxy_pass http://api:3000/;'));
  assert.ok(rendered.includes('proxy_pass http://keycloak:8080;'));
  assert.ok(rendered.includes('include snippets/tls.conf;'));
  assert.ok(rendered.includes('root html;'));
  assert.ok(!rendered.includes('/etc/nginx') && !/\$\{[A-Z_]+\}/.test(rendered));
  // The routes and the refusal of the administration console are the ones of the product.
  assert.ok(rendered.includes('location ~ ^/idp/(admin|metrics|health)'));
  const tls = windowsNginx(readFileSync(join(REPO_ROOT, 'infra', 'onprem', 'nginx', 'snippets', 'tls.conf'), 'utf8'), { host: 'h:1', hostname: 'h' });
  assert.ok(tls.includes('ssl_certificate     C:/run/secrets/tls_cert;'));
  assert.ok(tls.includes('ssl_certificate_key C:/run/secrets/tls_key;'));
  assert.throws(() => windowsNginx('listen ${NEW_VALUE};', { host: 'h:1', hostname: 'h' }), /NEW_VALUE/);
});

test('manifestOf lists every file with its SHA-256, without the manifest and the dependencies', (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'api', 'app', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'VERSION'), '1.0.0\n');
  writeFileSync(join(root, 'manifest.json'), '{}');
  writeFileSync(join(root, 'api', 'app', 'node_modules', 'x', 'index.js'), '');
  writeFileSync(join(root, 'api', 'app', 'a.ts'), 'a');
  assert.deepEqual(manifestOf(root), {
    VERSION: '59854984853104df5c353e2f681a15fc7924742f9a2e468c29af248dce45ce03',
    'api/app/a.ts': 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
  });
});

test('main refuses wrong arguments and a directory that is not empty, before it builds anything', async (t) => {
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await main(['--version', 'latest', '--public-origin', 'http://x', '--edition', 'other'], { log }), 2);
  assert.match(lines.at(-1), /--version.*--public-origin.*--edition.*--out/);
  assert.equal(await main(['--no-such-option'], { log }), 2);
  const full = scratch(t);
  writeFileSync(join(full, 'file'), '');
  assert.equal(await main(['--version', '1.0.0', '--public-origin', 'https://name.example.vn:8443', '--out', full], { log }), 2);
  assert.match(lines.at(-1), /not empty/);
});

test('secret-env turns NAME_FILE into NAME, strips the line end, and names an unreadable file without its content', () => {
  const env = { DATABASE_URL_FILE: 'a', OUTBOX_SIGNING_KEY_FILE: 'b', PLAIN: 'kept', EMPTY_FILE: '', PROFILE: 'x' };
  assert.equal(loadSecretFiles(env, (path) => ({ a: 'postgres://u:p@db/x\r\n', b: 'key\n\n' })[path]), undefined);
  assert.deepEqual(env, { DATABASE_URL: 'postgres://u:p@db/x', OUTBOX_SIGNING_KEY: 'key', PLAIN: 'kept', EMPTY_FILE: '', PROFILE: 'x' });
  assert.equal(loadSecretFiles({ TOKEN_FILE: 'missing' }, () => { throw new Error('ENOENT'); }), 'TOKEN_FILE');
});

/** A stand-in of the administration API of Keycloak: records the calls, answers from a table. */
function keycloakStub(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`;
    calls.push({ key, body: init.body, authorization: init.headers?.authorization });
    const answer = answers[key] ?? { status: 404, body: {} };
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body, text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)) };
  };
  return { calls, fetch };
}
const TOKEN = { 'POST /idp/realms/master/protocol/openid-connect/token': { status: 200, body: { access_token: 'admin-token' } } };

test('keycloak-admin switches the directory federation off and on, keeping the rest of the provider', async () => {
  const provider = { id: 'p1', name: 'corporate-directory', providerId: 'ldap', config: { connectionUrl: ['ldaps://x'], enabled: ['true'] } };
  const stub = keycloakStub({ ...TOKEN, 'GET /idp/admin/realms/machvon/components?type=org.keycloak.storage.UserStorageProvider': { status: 200, body: [provider, { id: 'p2', providerId: 'other' }] }, 'PUT /idp/admin/realms/machvon/components/p1': { status: 204 } });
  const lines = [];
  const env = { KEYCLOAK_ADMIN_USER: 'machvon-admin', KEYCLOAK_ADMIN_PASSWORD_FILE: 'pw' };
  assert.equal(await keycloakAdmin(['disable-directory'], { env, fetch: stub.fetch, log: (line) => lines.push(line), read: () => 'admin-password' }), 0);
  const put = stub.calls.find((call) => call.key.startsWith('PUT'));
  assert.deepEqual(JSON.parse(put.body).config, { connectionUrl: ['ldaps://x'], enabled: ['false'] });
  assert.equal(put.authorization, 'Bearer admin-token');
  assert.ok(stub.calls[0].body.includes('grant_type=password') && stub.calls[0].body.includes('client_id=admin-cli'));
  assert.match(lines[0], /OFF: corporate-directory/);
  assert.ok(!lines.join('\n').includes('admin-password'));
  assert.equal(await keycloakAdmin(['enable-directory'], { env, fetch: stub.fetch, log: (line) => lines.push(line), read: () => 'admin-password' }), 0);
  assert.deepEqual(JSON.parse(stub.calls.filter((call) => call.key.startsWith('PUT'))[1].body).config.enabled, ['true']);
});

test('keycloak-admin creates a person with the password of the file and the realm role, and says so without the password', async () => {
  const stub = keycloakStub({
    ...TOKEN,
    'POST /idp/admin/realms/machvon/users': { status: 201 },
    'GET /idp/admin/realms/machvon/users?exact=true&username=First.Admin': { status: 200, body: [{ id: 'u1', username: 'first.admin' }] },
    'PUT /idp/admin/realms/machvon/users/u1/reset-password': { status: 204 },
    'GET /idp/admin/realms/machvon/roles/SystemAdmin': { status: 200, body: { id: 'r1', name: 'SystemAdmin' } },
    'POST /idp/admin/realms/machvon/users/u1/role-mappings/realm': { status: 204 },
  });
  const lines = [];
  const status = await keycloakAdmin(['create-user', '--username', 'First.Admin', '--email', 'a@example.vn', '--first-name', 'First', '--last-name', 'Admin', '--password-file', 'f', '--realm-role', 'SystemAdmin'], { env: {}, fetch: stub.fetch, log: (line) => lines.push(line), read: () => 'the-password' });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stub.calls.find((call) => call.key.endsWith('reset-password')).body), { type: 'password', value: 'the-password', temporary: false });
  assert.deepEqual(JSON.parse(stub.calls.at(-1).body), [{ id: 'r1', name: 'SystemAdmin' }]);
  assert.match(lines[0], /First\.Admin created, realm role SystemAdmin/);
  assert.ok(!lines.join('\n').includes('the-password'));
});

test('keycloak-admin reports a refused sign-in, a missing option and an unknown command', async () => {
  const refused = keycloakStub({ 'POST /idp/realms/master/protocol/openid-connect/token': { status: 401, body: { error: 'invalid_grant' } } });
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await keycloakAdmin(['disable-directory'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 1);
  assert.match(lines.at(-1), /FAILED the first administrator cannot sign in: 401 invalid_grant/);
  assert.equal(await keycloakAdmin(['create-user', '--username', 'a'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 2);
  assert.match(lines.at(-1), /missing --email, --first-name, --last-name, --password-file/);
  assert.equal(await keycloakAdmin(['what'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 2);
  assert.equal(await keycloakAdmin(['create-user', '--bad'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 2);
  const admin = new KeycloakAdmin({ base: 'http://keycloak:8080/idp/', realm: 'machvon', username: 'a', password: 'b', fetch: keycloakStub({ ...TOKEN, 'GET /idp/admin/realms/machvon/x': { status: 500, body: { error: 'boom' } } }).fetch });
  await assert.rejects(admin.call('GET', '/x'), AdminError);
});
