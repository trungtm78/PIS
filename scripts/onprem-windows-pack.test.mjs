import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPILE_OPTIONS, EDITION_IDENTITY, RESOLVE_LOADER, compileSource, copyIdentity, isCompiled, isShipped, main, manifestOf, parseOrigin, shipTree, windowsNginx } from './onprem-windows-pack.mjs';
import { loadSecretFiles } from '../infra/onprem-windows/docker/secret-files.mjs';
import { inputProblems, newPassword, readInvitations } from '../infra/onprem-windows/tools/first-accounts.mjs';
import { AdminError, KeycloakAdmin, PRESENTATION_FIELDS, SECOND_FACTOR, base32, main as keycloakAdmin, newTotpSecret, otpauthOf, productLabel } from '../infra/onprem-windows/tools/keycloak-admin.mjs';

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

test('keycloak-admin creates a person with the password and a provisioned one-time password, clears the enrolment action, grants the role, and prints neither secret', async () => {
  const stub = keycloakStub({
    ...TOKEN,
    'POST /idp/admin/realms/machvon/users': { status: 201 },
    'GET /idp/admin/realms/machvon/users?exact=true&username=First.Admin': { status: 200, body: [{ id: 'u1', username: 'first.admin' }] },
    'GET /idp/admin/realms/machvon/users/u1/credentials': { status: 200, body: [{ type: 'password' }, { type: 'otp' }] },
    'GET /idp/admin/realms/machvon/users/u1': { status: 200, body: { id: 'u1', username: 'first.admin', email: 'a@example.vn', requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PROFILE'] } },
    'PUT /idp/admin/realms/machvon/users/u1': { status: 204 },
    'GET /idp/admin/realms/machvon/roles/SystemAdmin': { status: 200, body: { id: 'r1', name: 'SystemAdmin' } },
    'POST /idp/admin/realms/machvon/users/u1/role-mappings/realm': { status: 204 },
  });
  const lines = [];
  const files = { pw: 'the-password', otp: 'Abcdefghij0123456789' };
  const status = await keycloakAdmin(['create-user', '--username', 'First.Admin', '--email', 'a@example.vn', '--first-name', 'First', '--last-name', 'Admin', '--password-file', 'pw', '--totp-secret-file', 'otp', '--realm-role', 'SystemAdmin'], { env: {}, fetch: stub.fetch, log: (line) => lines.push(line), read: (path) => files[path] ?? 'admin-password' });
  assert.equal(status, 0);
  const created = JSON.parse(stub.calls.find((call) => call.key === 'POST /idp/admin/realms/machvon/users').body);
  assert.deepEqual(created.credentials[0], { type: 'password', value: 'the-password', temporary: false });
  assert.equal(created.credentials[1].type, 'otp');
  assert.deepEqual(JSON.parse(created.credentials[1].secretData), { value: 'Abcdefghij0123456789' });
  assert.deepEqual(JSON.parse(created.credentials[1].credentialData), { subType: 'totp', digits: 6, counter: 0, period: 30, algorithm: 'HmacSHA1' });
  assert.deepEqual(JSON.parse(stub.calls.find((call) => call.key === 'PUT /idp/admin/realms/machvon/users/u1').body), { id: 'u1', username: 'first.admin', email: 'a@example.vn', requiredActions: ['UPDATE_PROFILE'] });
  assert.deepEqual(JSON.parse(stub.calls.at(-1).body), [{ id: 'r1', name: 'SystemAdmin' }]);
  assert.match(lines[0], /First\.Admin created with a password and a one-time password, realm role SystemAdmin/);
  assert.ok(!lines.join('\n').includes('the-password') && !lines.join('\n').includes('Abcdefghij'));
});

test('keycloak-admin refuses a person that exists, a secret that is not one, and credentials that were not stored; delete-user removes a person', async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const args = ['create-user', '--username', 'a.b', '--email', 'a@example.vn', '--first-name', 'A', '--last-name', 'B', '--password-file', 'pw', '--totp-secret-file', 'otp'];
  const read = (secret) => (path) => ({ pw: 'p', otp: secret })[path] ?? 'x';
  const exists = keycloakStub({ ...TOKEN, 'POST /idp/admin/realms/machvon/users': { status: 409, body: { errorMessage: 'exists' } } });
  assert.equal(await keycloakAdmin(args, { env: {}, fetch: exists.fetch, log, read: read('Abcdefghij0123456789') }), 1);
  assert.match(lines.at(-1), /exists already/);
  assert.equal(await keycloakAdmin(args, { env: {}, fetch: exists.fetch, log, read: read('short') }), 1);
  assert.match(lines.at(-1), /20 to 64 letters and digits/);
  const lost = keycloakStub({ ...TOKEN, 'POST /idp/admin/realms/machvon/users': { status: 201 }, 'GET /idp/admin/realms/machvon/users?exact=true&username=a.b': { status: 200, body: [{ id: 'u2', username: 'a.b' }] }, 'GET /idp/admin/realms/machvon/users/u2/credentials': { status: 200, body: [{ type: 'password' }] } });
  assert.equal(await keycloakAdmin(args, { env: {}, fetch: lost.fetch, log, read: read('Abcdefghij0123456789') }), 1);
  assert.match(lines.at(-1), /credentials of a\.b were not stored \(found: password\)/);
  const removal = keycloakStub({ ...TOKEN, 'GET /idp/admin/realms/machvon/users?exact=true&username=a.b': { status: 200, body: [{ id: 'u2', username: 'a.b' }] }, 'DELETE /idp/admin/realms/machvon/users/u2': { status: 204 }, 'GET /idp/admin/realms/machvon/users?exact=true&username=no.one': { status: 200, body: [] } });
  assert.equal(await keycloakAdmin(['delete-user', '--username', 'a.b'], { env: {}, fetch: removal.fetch, log, read: () => 'x' }), 0);
  assert.match(lines.at(-1), /a\.b removed/);
  assert.equal(await keycloakAdmin(['delete-user', '--username', 'no.one'], { env: {}, fetch: removal.fetch, log, read: () => 'x' }), 0);
  assert.match(lines.at(-1), /no\.one does not exist/);
  assert.equal(await keycloakAdmin(['delete-user'], { env: {}, fetch: removal.fetch, log, read: () => 'x' }), 2);
});

test('the one-time password secret is twenty letters and digits, and the address of an authenticator carries it in base32', () => {
  assert.match(newTotpSecret(), /^[A-Za-z0-9]{20}$/);
  assert.notEqual(newTotpSecret(), newTotpSecret());
  // RFC 4648: the base32 of the ASCII secret of the RFC 6238 test vectors.
  assert.equal(base32('12345678901234567890'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(otpauthOf({ issuerName: 'MACHVON host:8443', username: 'a.b', secret: '12345678901234567890' }), 'otpauth://totp/MACHVON%20host%3A8443:a.b?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=MACHVON%20host%3A8443&algorithm=SHA1&digits=6&period=30');
});

test('first-accounts checks its input file and makes passwords a person can type', () => {
  const person = (username) => ({ username, email: `${username}@example.vn`, firstName: 'A', lastName: 'B' });
  const input = { systemAdmin: person('sys.admin'), owner: person('the.owner'), tenant: { code: 'so-xd', name: 'So Xay dung', rootUnitName: 'So Xay dung', subdomain: 'so-xd' }, members: [{ ...person('a.member'), role: 'SPECIALIST' }] };
  assert.deepEqual(inputProblems(input), []);
  assert.ok(inputProblems({}).length >= 6);
  assert.deepEqual(inputProblems({ ...input, members: [{ ...person('the.owner'), role: 'SPECIALIST' }] }), ['a user name is used twice', 'an e-mail address is used twice']);
  assert.deepEqual(inputProblems({ ...input, members: [person('a.member')] }), ['members[0].role (the code of a role of the tenant) is missing']);
  assert.deepEqual(inputProblems({ ...input, tenant: { ...input.tenant, code: 'X' } }), ['tenant.code must be 3 to 31 lower-case letters, digits or dashes']);
  assert.match(newPassword(), /^[a-km-np-zA-HJ-NP-Z2-9]{16}-aA7#$/);
  assert.notEqual(newPassword(), newPassword());
  const files = { 'b.json': '{"to_email":"b@x.vn","n":2}', 'a.json': '{"to_email":"a@x.vn","n":1}', 'note.txt': 'no' };
  assert.deepEqual(readInvitations('dir', { list: () => Object.keys(files), read: (path) => files[path.split(/[\\/]/).pop()] }).map((entry) => entry.n), [1, 2]);
});

test('keycloak-admin reports a refused sign-in, a missing option and an unknown command', async () => {
  const refused = keycloakStub({ 'POST /idp/realms/master/protocol/openid-connect/token': { status: 401, body: { error: 'invalid_grant' } } });
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await keycloakAdmin(['disable-directory'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 1);
  assert.match(lines.at(-1), /FAILED the first administrator cannot sign in: 401 invalid_grant/);
  assert.equal(await keycloakAdmin(['create-user', '--username', 'a'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 2);
  assert.match(lines.at(-1), /missing --email, --first-name, --last-name, --password-file, --totp-secret-file/);
  assert.equal(await keycloakAdmin(['what'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 2);
  assert.equal(await keycloakAdmin(['create-user', '--bad'], { env: {}, fetch: refused.fetch, log, read: () => 'x' }), 2);
  const admin = new KeycloakAdmin({ base: 'http://keycloak:8080/idp/', realm: 'machvon', username: 'a', password: 'b', fetch: keycloakStub({ ...TOKEN, 'GET /idp/admin/realms/machvon/x': { status: 500, body: { error: 'boom' } } }).fetch });
  await assert.rejects(admin.call('GET', '/x'), AdminError);
});

const properties = (path) => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => /^[^#\s][^=]*=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const PUBLIC_THEME = join(REPO_ROOT, 'infra', 'keycloak', 'themes', 'pis-public', 'login');

test('the pack of the public edition carries its login theme and the presentation of the realm; the enterprise pack carries neither', (t) => {
  const out = scratch(t);
  assert.deepEqual(copyIdentity({ out: join(out, 'public'), edition: 'public' }), ['pis-public']);
  assert.ok(existsSync(join(out, 'public', 'infra', 'keycloak', 'machvon-realm.json')));
  assert.ok(existsSync(join(out, 'public', 'infra', 'keycloak', 'themes', 'pis-public', 'login', 'theme.properties')));
  const presentation = JSON.parse(readFileSync(join(out, 'public', 'tools', 'infra', 'onprem-windows', 'tools', 'realm-presentation.json'), 'utf8'));
  assert.equal(presentation.loginTheme, 'pis-public');
  assert.deepEqual(copyIdentity({ out: join(out, 'enterprise'), edition: 'enterprise' }), []);
  // The themes directory exists in every pack (the Dockerfile copies it) and holds no theme for an edition without one.
  assert.deepEqual(readdirSync(join(out, 'enterprise', 'infra', 'keycloak', 'themes')), ['README.md']);
  assert.ok(!existsSync(join(out, 'enterprise', 'tools')));
  // The realm file of the product is the same for both: an edition is presented by the overlay, never by a second realm file.
  assert.equal(readFileSync(join(out, 'enterprise', 'infra', 'keycloak', 'machvon-realm.json'), 'utf8'), readFileSync(join(out, 'public', 'infra', 'keycloak', 'machvon-realm.json'), 'utf8'));
});

test('the presentation and the login theme of the public edition say the names of its manifest, and never the code name', async () => {
  const { PUBLIC_EDITION_MANIFEST: manifest } = await import('../packages/kernel/src/edition.ts');
  const presentation = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'keycloak', EDITION_IDENTITY.public.presentation), 'utf8'));
  assert.deepEqual(Object.keys(presentation).filter((name) => !PRESENTATION_FIELDS.includes(name)), []);
  assert.equal(presentation.displayName, manifest.productName.vi);
  assert.equal(presentation.displayNameHtml, manifest.productName.vi);
  assert.equal(presentation.defaultLocale, 'vi');
  assert.deepEqual(presentation.supportedLocales, ['vi', 'en']);
  assert.ok(EDITION_IDENTITY.public.themes.includes(presentation.loginTheme));
  const vi = properties(join(PUBLIC_THEME, 'messages', 'messages_vi.properties'));
  const en = properties(join(PUBLIC_THEME, 'messages', 'messages_en.properties'));
  assert.equal(vi.pisProductName, manifest.productName.vi);
  assert.equal(en.pisProductName, manifest.productName.en);
  assert.equal(vi.pisShortName, manifest.brand.launcherName.vi);
  assert.equal(en.pisShortName, manifest.brand.launcherName.en);
  assert.equal(vi.pisTagline, manifest.brand.tagline.vi);
  assert.equal(en.pisTagline, manifest.brand.tagline.en);
  // Every text the template of the theme asks for exists in both languages.
  const template = readFileSync(join(PUBLIC_THEME, 'template.ftl'), 'utf8');
  for (const key of new Set([...template.matchAll(/msg\("(pis[A-Za-z0-9]+)"\)/g)].map((match) => match[1]))) {
    assert.ok(vi[key] !== undefined && vi[key] !== '', `messages_vi misses ${key}`);
    assert.ok(en[key] !== undefined && en[key] !== '', `messages_en misses ${key}`);
  }
  for (const file of ['template.ftl', 'theme.properties', 'messages/messages_vi.properties', 'messages/messages_en.properties', 'resources/css/pis.css', 'resources/img/hero-art.svg']) {
    const text = readFileSync(join(PUBLIC_THEME, file), 'utf8').split(/\r?\n/).filter((line) => !/^\s*(#|\/\/|\/\*|\*|<#--|<!--)/.test(line)).join('\n');
    assert.ok(!/machvon/i.test(text.replace(/kc\.org\.name/g, '')), `${file} shows the code name`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/)/.test(text), `${file} loads from another origin`);
  }
  // The fonts are files of the theme (no CDN): every file the sheet names exists.
  for (const [, font] of readFileSync(join(PUBLIC_THEME, 'resources', 'css', 'fonts.css'), 'utf8').matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g)) assert.ok(existsSync(join(PUBLIC_THEME, 'resources', 'fonts', font)), font);
});

test('keycloak-admin writes the presentation of the release into the running realm, and nothing where the release carries none', async () => {
  const stub = keycloakStub({ ...TOKEN, 'PUT /idp/admin/realms/machvon': { status: 204 } });
  const lines = [];
  const options = { env: {}, fetch: stub.fetch, log: (line) => lines.push(line), read: () => 'admin-password' };
  const presentation = { displayName: 'Hệ thống quản lý đầu tư công', loginTheme: 'pis-public', internationalizationEnabled: true, supportedLocales: ['vi', 'en'], defaultLocale: 'vi' };
  assert.equal(await keycloakAdmin(['apply-presentation'], { ...options, readJson: () => presentation }), 0);
  assert.deepEqual(JSON.parse(stub.calls.find((call) => call.key === 'PUT /idp/admin/realms/machvon').body), presentation);
  assert.match(lines[0], /displayName, loginTheme/);
  const before = stub.calls.length;
  assert.equal(await keycloakAdmin(['apply-presentation'], { ...options, readJson: () => undefined }), 0);
  assert.equal(stub.calls.length, before);
  assert.match(lines[1], /nothing changed/);
  // A presentation is how the realm looks: it may not carry a field of how the realm authenticates.
  assert.equal(await keycloakAdmin(['apply-presentation'], { ...options, readJson: () => ({ displayName: 'x', browserFlow: 'browser', sslRequired: 'none' }) }), 1);
  assert.match(lines[2], /may not set browserFlow, sslRequired/);
  assert.equal(await keycloakAdmin(['apply-presentation'], { ...options, readJson: () => ['x'] }), 1);
  assert.equal(stub.calls.filter((call) => call.key.startsWith('PUT')).length, 1);
});

test('keycloak-admin single-factor on stops the browser flow after the password and releases the pending enrolments; off restores the second factor', async () => {
  const executions = '/idp/admin/realms/machvon/authentication/flows/machvon%20browser%20forms/executions';
  const action = '/idp/admin/realms/machvon/authentication/required-actions/CONFIGURE_TOTP';
  const answers = (requirement, defaultAction) => ({
    ...TOKEN,
    [`GET ${executions}`]: { status: 200, body: [{ id: 'e1', displayName: 'machvon level 1', level: 0, requirement: 'CONDITIONAL' }, { id: 'e2', displayName: SECOND_FACTOR.step, level: 0, requirement, authenticationFlow: true }, { id: 'e3', displayName: SECOND_FACTOR.step, level: 1, requirement: 'REQUIRED' }] },
    [`PUT ${executions}`]: { status: 202 },
    [`GET ${action}`]: { status: 200, body: { alias: 'CONFIGURE_TOTP', enabled: true, defaultAction, priority: 10 } },
    [`PUT ${action}`]: { status: 204 },
    'GET /idp/admin/realms/machvon/users?first=0&max=100': { status: 200, body: [{ id: 'u1', username: 'a', requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PROFILE'] }, { id: 'u2', username: 'b', requiredActions: [] }, { id: 'u3', username: 'c' }] },
    'PUT /idp/admin/realms/machvon/users/u1': { status: 204 },
  });
  const lines = [];
  const on = keycloakStub(answers('CONDITIONAL', true));
  assert.equal(await keycloakAdmin(['single-factor', 'on'], { env: {}, fetch: on.fetch, log: (line) => lines.push(line), read: () => 'admin-password' }), 0);
  const puts = (stub) => stub.calls.filter((call) => call.key.startsWith('PUT')).map((call) => [call.key, JSON.parse(call.body)]);
  assert.deepEqual(puts(on), [
    [`PUT ${executions}`, { id: 'e2', displayName: SECOND_FACTOR.step, level: 0, requirement: 'DISABLED', authenticationFlow: true }],
    [`PUT ${action}`, { alias: 'CONFIGURE_TOTP', enabled: true, defaultAction: false, priority: 10 }],
    ['PUT /idp/admin/realms/machvon/users/u1', { id: 'u1', username: 'a', requiredActions: ['UPDATE_PROFILE'] }],
  ]);
  assert.match(lines[0], /DEMONSTRATION MODE, one factor.*DISABLED; 1 pending/);

  const off = keycloakStub(answers('DISABLED', false));
  assert.equal(await keycloakAdmin(['single-factor', 'off'], { env: {}, fetch: off.fetch, log: (line) => lines.push(line), read: () => 'admin-password' }), 0);
  assert.deepEqual(puts(off), [
    [`PUT ${executions}`, { id: 'e2', displayName: SECOND_FACTOR.step, level: 0, requirement: 'CONDITIONAL', authenticationFlow: true }],
    [`PUT ${action}`, { alias: 'CONFIGURE_TOTP', enabled: true, defaultAction: true, priority: 10 }],
  ]);
  // No person is read or changed on the way back, and a realm that is already as asked is not written at all.
  assert.ok(!off.calls.some((call) => call.key.includes('/users')));
  const already = keycloakStub(answers('CONDITIONAL', true));
  assert.equal(await keycloakAdmin(['single-factor', 'off'], { env: {}, fetch: already.fetch, log: () => {}, read: () => 'admin-password' }), 0);
  assert.deepEqual(puts(already), []);

  assert.equal(await keycloakAdmin(['single-factor'], { env: {}, fetch: on.fetch, log: (line) => lines.push(line), read: () => 'x' }), 2);
  assert.equal(await keycloakAdmin(['single-factor', 'maybe'], { env: {}, fetch: on.fetch, log: (line) => lines.push(line), read: () => 'x' }), 2);
  // A realm that is not the one of the product is not guessed at.
  const foreign = keycloakStub({ ...TOKEN, [`GET ${executions}`]: { status: 200, body: [{ id: 'x', displayName: 'forms', level: 0, requirement: 'REQUIRED' }] } });
  assert.equal(await keycloakAdmin(['single-factor', 'on'], { env: {}, fetch: foreign.fetch, log: (line) => lines.push(line), read: () => 'x' }), 1);
  assert.ok(!foreign.calls.some((call) => call.key.startsWith('PUT')));
});

test('the realm file of the product still asks every member for the second factor: the demonstration mode exists only in a running realm', () => {
  const realm = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'keycloak', 'onprem', 'machvon-realm.json'), 'utf8'));
  const forms = realm.authenticationFlows.find((flow) => flow.alias === SECOND_FACTOR.flow);
  assert.equal(forms.authenticationExecutions.find((execution) => execution.flowAlias === SECOND_FACTOR.step).requirement, 'CONDITIONAL');
  assert.equal(realm.requiredActions.find((action) => action.alias === SECOND_FACTOR.action).defaultAction, true);
  for (const client of realm.clients) assert.equal(client.attributes['minimum.acr.value'], 'aal2', client.clientId);
  const compose = readFileSync(join(REPO_ROOT, 'infra', 'onprem-windows', 'compose', 'compose.yaml'), 'utf8');
  assert.match(compose, /MACHVON_DEMO_SINGLE_FACTOR: \$\{MACHVON_DEMO_SINGLE_FACTOR:-false\}/);
  assert.match(readFileSync(join(REPO_ROOT, 'infra', 'onprem-windows', 'compose', 'env.template'), 'utf8'), /^MACHVON_DEMO_SINGLE_FACTOR=false$/m);
});

test('productLabel is the display name of the presentation of the release, or the code name where the release carries none', () => {
  assert.equal(productLabel(() => ({ displayName: ' Hệ thống quản lý đầu tư công ' })), 'Hệ thống quản lý đầu tư công');
  assert.equal(productLabel(() => undefined), 'MACHVON');
  assert.equal(productLabel(() => ({ displayName: '' })), 'MACHVON');
});
