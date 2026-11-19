#!/usr/bin/env node
// Makes the build pack of the Windows-container deployment (infra/onprem-windows, docs/runbooks/deploy-windows-containers.md).
//
//   node scripts/onprem-windows-pack.mjs --version 1.0.0 --public-origin https://host.example.vn:8443 [--edition public|enterprise] --out <directory>
//
// The server that runs the containers never holds the repository. This script, run on the build machine (Windows x64, Node 24, `npm ci` done), writes a directory with
// only what the image builds need:
//   web/dist        the built single-page application (the OIDC issuer of the public origin is compiled in);
//   api/app         the API as COMPILED JavaScript (types, comments and tests removed; the files keep their names so that every relative path of the product holds),
//                   the production dependencies for win32-x64, the migrations and the two design files the migration job reads;
//   infra, tools    the Dockerfiles, the compose file and the host scripts of infra/onprem-windows, the realm of Keycloak and the first-tenant tool;
//                   for the public edition also its login theme (infra/keycloak/themes/pis-public) and the presentation of the realm (display name, theme,
//                   languages: infra/keycloak/onprem/presentation.public.json), which host\install.ps1 writes into the running realm. The enterprise edition
//                   keeps the realm as its file says: its pack carries neither;
//   VERSION, manifest.json (every file with its SHA-256).
// The pack is copied to the server, the images are built there, and the pack is deleted (infra/onprem-windows/host/build-images.ps1).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EDITIONS = new Set(['public', 'enterprise']);
export const REALM = 'machvon';
export const WEB_CLIENT = 'machvon-web';
/** The scripts of the repository the tools of the image import. */
export const TOOL_SCRIPTS = ['onprem-first-tenant.mjs', 'onprem-messages.mjs', 'messages/onprem.vi.json', 'messages/onprem.en.json', 'onprem-smoke/keycloak-login.mjs'];

/** The compiler options of the API loader (apps/api/scripts/ts-loader.mjs) without source maps, and with comments and white space removed. */
export const COMPILE_OPTIONS = {
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    keepClassNames: true,
    minify: { compress: false, mangle: false, format: { comments: false } },
  },
  module: { type: 'es6' },
  sourceMaps: false,
  minify: true,
};

/** `https://host[:port]` only: no path, no query, no credentials. Returns the origin, the host with its port and the bare host name. */
export function parseOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  if (String(value).replace(/\/$/, '') !== url.origin) return undefined;
  return { origin: url.origin, host: url.host, hostname: url.hostname, port: url.port === '' ? '443' : url.port };
}

/** What of a source tree goes into the pack: no test, no test helper directory, no configuration of the development tools. */
export function isShipped(relativePath) {
  const path = relativePath.split(sep).join('/');
  if (/(^|\/)(test|tests|__tests__|__mocks__|coverage|node_modules|dist)\//.test(`${path}`)) return false;
  if (/\.(test|spec|stack)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/(^|\/)(jest\.config\.[cm]?js|tsconfig(\.[a-z]+)?\.json|\.eslintrc.*|README\.md)$/.test(path)) return false;
  return true;
}

/** A source file that is compiled (TypeScript that is not a declaration); everything else that ships is copied as it is. */
export const isCompiled = (relativePath) => /\.ts$/.test(relativePath) && !/\.d\.ts$/.test(relativePath);

/** Compiles one TypeScript source to JavaScript. `transformSync` is the one of @swc/core. */
export function compileSource(source, filename, transformSync) {
  return transformSync(source, { ...COMPILE_OPTIONS, filename }).code;
}

function walk(directory, base = directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(full, base, found);
    else if (entry.isFile()) found.push(relative(base, full));
  }
  return found;
}

/** Copies one source tree into the pack, compiling the TypeScript sources. Returns the count of compiled and of copied files. */
export function shipTree(from, to, transformSync) {
  let compiled = 0;
  let copied = 0;
  for (const file of walk(from)) {
    if (!isShipped(file)) continue;
    const target = join(to, file);
    mkdirSync(dirname(target), { recursive: true });
    if (isCompiled(file)) {
      writeFileSync(target, compileSource(readFileSync(join(from, file), 'utf8'), join(from, file), transformSync));
      compiled += 1;
    } else {
      cpSync(join(from, file), target);
      copied += 1;
    }
  }
  return { compiled, copied };
}

/** The loader of the compiled API: the files are JavaScript already, so only the resolution of imports without an extension is left of apps/api/scripts/ts-loader.mjs. */
export const RESOLVE_LOADER = `// Written by scripts/onprem-windows-pack.mjs. The sources of this image are compiled JavaScript under their original names:
// Node reads them as they are, and this hook only resolves the imports that name a sibling without an extension.
const HAS_EXTENSION = /\\.[cm]?[jt]s$|\\.json$/;
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !HAS_EXTENSION.test(specifier)) {
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await nextResolve(\`\${specifier}\${suffix}\`, context);
      } catch {
        // try the next form
      }
    }
  }
  return nextResolve(specifier, context);
}
`;

/**
 * The edge configuration of the Linux deployment (infra/onprem/nginx: one source for the security headers, the TLS standard and the routes) turned into the one nginx for
 * Windows reads: paths relative to its `conf` directory, the secrets under C:/run/secrets, and the values the Linux image fills in at its start written in here.
 * `host` is the public host with its port (what a browser is sent to), `hostname` the bare name (what nginx compares the Host header with).
 */
export function windowsNginx(text, { host, hostname }) {
  const rendered = text
    .replaceAll('/etc/nginx/snippets/', 'snippets/')
    .replaceAll('/usr/share/nginx/html', 'html')
    .replaceAll('/run/secrets/', 'C:/run/secrets/')
    .replace(/server_name \$\{PUBLIC_HOST\};/g, `server_name ${hostname};`)
    .replaceAll('${PUBLIC_HOST}', host)
    .replaceAll('${API_UPSTREAM}', 'api:3000')
    .replaceAll('${KEYCLOAK_UPSTREAM}', 'keycloak:8080');
  const left = /\$\{[A-Z_]+\}/.exec(rendered);
  if (left !== null) throw new Error(`the edge configuration names a value this script does not know: ${left[0]}`);
  return rendered;
}

/** SHA-256 of every file of the pack, by its path with forward slashes, sorted. */
export function manifestOf(root, skip = (path) => path.startsWith('api/app/node_modules/')) {
  const files = {};
  for (const file of walk(root).map((path) => path.split(sep).join('/')).sort()) {
    if (file === 'manifest.json' || skip(file)) continue;
    files[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  }
  return files;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} ended with status ${result.status}`);
}

function workspaceDirectories() {
  const found = [];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(REPO_ROOT, group, entry.name, 'package.json'))) found.push(`${group}/${entry.name}`);
    }
  }
  return found;
}

/** The short commit the pack is built from, or '' outside a git checkout. */
export function commitOf(root = REPO_ROOT, spawn = spawnSync) {
  const result = spawn('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout).trim() : '';
}

/** `version.json` of a web build: what a running tab compares with the release it was loaded from. */
export function versionDocument(version, commit) {
  return `${JSON.stringify({ version, commit })}
`;
}

function buildWeb({ out, origin, edition, version }) {
  const dist = join(out, 'web', 'dist');
  const commit = commitOf();
  run('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: join(REPO_ROOT, 'apps', 'web'),
    // The release and the commit are stamped into the build (shown to the person, and compared with version.json by a running tab).
    env: { ...process.env, VITE_EDITION: edition, VITE_API_BASE_URL: '/api', VITE_OIDC_CLIENT_ID: WEB_CLIENT, VITE_OIDC_ISSUER: `${origin}/idp/realms/${REALM}`, VITE_APP_VERSION: version, VITE_APP_COMMIT: commit },
  });
  if (!existsSync(join(dist, 'index.html'))) throw new Error('the web build wrote no index.html');
  writeFileSync(join(dist, 'version.json'), versionDocument(version, commit), 'utf8');
}

function writeEdge({ out, origin }) {
  const source = join(REPO_ROOT, 'infra', 'onprem', 'nginx');
  const target = join(out, 'web', 'nginx');
  mkdirSync(join(target, 'snippets'), { recursive: true });
  writeFileSync(join(target, 'default.conf'), windowsNginx(readFileSync(join(source, 'default.conf.template'), 'utf8'), origin));
  for (const snippet of readdirSync(join(source, 'snippets'))) {
    writeFileSync(join(target, 'snippets', snippet), windowsNginx(readFileSync(join(source, 'snippets', snippet), 'utf8'), origin));
  }
}

function buildApi({ out, transformSync }) {
  const app = join(out, 'api', 'app');
  mkdirSync(app, { recursive: true });
  // The dependencies: the lock file of the repository, production only, for this platform (the server is win32-x64 as well).
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(REPO_ROOT, file), join(app, file));
  for (const workspace of workspaceDirectories()) {
    mkdirSync(join(app, workspace), { recursive: true });
    cpSync(join(REPO_ROOT, workspace, 'package.json'), join(app, workspace, 'package.json'));
  }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--workspace', '@machvon/api', '--include-workspace-root=false'], { cwd: app });
  // The workspace links are made again inside the image (a link does not survive the copy to the server); the embedded PostgreSQL is a test tool; the native
  // TypeScript compiler is not needed by compiled sources.
  for (const gone of ['node_modules/@machvon', 'node_modules/embedded-postgres', 'node_modules/@embedded-postgres', 'node_modules/@swc', 'node_modules/.package-lock.json', 'package-lock.json']) {
    rmSync(join(app, gone), { recursive: true, force: true });
  }
  for (const workspace of workspaceDirectories()) {
    if (workspace.startsWith('apps/') && workspace !== 'apps/api') rmSync(join(app, workspace), { recursive: true, force: true });
  }
  const counts = { compiled: 0, copied: 0 };
  const add = (result) => {
    counts.compiled += result.compiled;
    counts.copied += result.copied;
  };
  add(shipTree(join(REPO_ROOT, 'apps', 'api', 'src'), join(app, 'apps', 'api', 'src'), transformSync));
  for (const workspace of workspaceDirectories().filter((name) => name.startsWith('packages/'))) {
    const source = join(REPO_ROOT, workspace, 'src');
    if (existsSync(source)) add(shipTree(source, join(app, workspace, 'src'), transformSync));
  }
  mkdirSync(join(app, 'apps', 'api', 'scripts'), { recursive: true });
  writeFileSync(join(app, 'apps', 'api', 'scripts', 'ts-loader.mjs'), RESOLVE_LOADER);
  cpSync(join(REPO_ROOT, 'apps', 'api', 'scripts', 'ts-register.mjs'), join(app, 'apps', 'api', 'scripts', 'ts-register.mjs'));
  cpSync(join(REPO_ROOT, 'db', 'migrations'), join(app, 'db', 'migrations'), { recursive: true });
  const design = join('Design', 'MACHVON_Design', '03_Engineering');
  mkdirSync(join(app, design), { recursive: true });
  for (const file of ['error_codes.json', 'schema_reference.sql']) cpSync(join(REPO_ROOT, design, file), join(app, design, file));
  return counts;
}

/** The login themes and the presentation of the realm an edition ships with (paths below infra/keycloak of the repository); an edition that is not named ships none. */
export const EDITION_IDENTITY = { public: { themes: ['pis-public'], presentation: 'onprem/presentation.public.json' } };

/**
 * Copies what the Keycloak image and the administration tool need for the edition: the realm file as it is, the themes of the edition below `infra/keycloak/themes`
 * (the directory always exists: the Dockerfile copies it) and the presentation of the realm beside the administration tool. Returns the names of the themes.
 */
export function copyIdentity({ out, edition, root = REPO_ROOT }) {
  const source = join(root, 'infra', 'keycloak');
  const themes = join(out, 'infra', 'keycloak', 'themes');
  mkdirSync(themes, { recursive: true });
  cpSync(join(source, 'onprem', 'machvon-realm.json'), join(out, 'infra', 'keycloak', 'machvon-realm.json'));
  writeFileSync(join(themes, 'README.md'), 'The login themes of the edition this pack was made for (scripts/onprem-windows-pack.mjs). None means the themes of Keycloak.\n');
  const identity = EDITION_IDENTITY[edition];
  if (identity === undefined) return [];
  for (const theme of identity.themes) cpSync(join(source, 'themes', theme), join(themes, theme), { recursive: true });
  const tools = join(out, 'tools', 'infra', 'onprem-windows', 'tools');
  mkdirSync(tools, { recursive: true });
  cpSync(join(source, identity.presentation), join(tools, 'realm-presentation.json'));
  return identity.themes;
}

function copyInfra({ out, edition }) {
  cpSync(join(REPO_ROOT, 'infra', 'onprem-windows'), join(out, 'infra', 'onprem-windows'), { recursive: true });
  // The tools an operator runs with the Node of the api image, at the relative paths they have in the repository (they import each other): the first tenant,
  // the sign-in helper, and the administration tools of this deployment.
  const tools = join(out, 'tools');
  for (const file of TOOL_SCRIPTS) {
    mkdirSync(dirname(join(tools, 'scripts', file)), { recursive: true });
    cpSync(join(REPO_ROOT, 'scripts', file), join(tools, 'scripts', file));
  }
  cpSync(join(REPO_ROOT, 'infra', 'onprem-windows', 'tools'), join(tools, 'infra', 'onprem-windows', 'tools'), { recursive: true });
  copyIdentity({ out, edition });
}

/** The authorship-and-recipient notice written to the pack root when a customer or a copyright owner is named. Plain text, so an operator reads it without a tool. */
export function noticeText({ customer, copyright, builtAt, version, edition }) {
  const lines = [];
  if (copyright) lines.push(`Bản quyền © ${new Date(builtAt).getUTCFullYear()} ${copyright}. Giữ mọi quyền.`, `Copyright © ${new Date(builtAt).getUTCFullYear()} ${copyright}. All rights reserved.`, '');
  lines.push(
    'Phần mềm này được giao để sử dụng theo thỏa thuận cấp phép. Không được sao chép, phân phối lại,',
    'dịch ngược hay sử dụng ngoài phạm vi đã thỏa thuận. This software is licensed, not sold.',
    '',
    `Bản giao / build: ${version} (${edition})`,
  );
  if (customer) lines.push(`Giao cho / licensed to: ${customer}`);
  lines.push(`Đóng gói lúc / built at: ${builtAt}`, '');
  return `${lines.join('\n')}`;
}

export async function main(argv, { log = console.log } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { version: { type: 'string' }, 'public-origin': { type: 'string' }, edition: { type: 'string', default: 'public' }, out: { type: 'string' }, customer: { type: 'string' }, copyright: { type: 'string' } }, allowPositionals: false }));
  } catch (error) {
    log(String(error.message));
    return 2;
  }
  const origin = parseOrigin(values['public-origin']);
  const wrong = [];
  if (!EXACT_VERSION.test(values.version ?? '')) wrong.push('--version (an exact version such as 1.0.0)');
  if (origin === undefined) wrong.push('--public-origin (https://host[:port], nothing after it)');
  if (!EDITIONS.has(values.edition)) wrong.push('--edition (public or enterprise)');
  if (typeof values.out !== 'string' || values.out === '') wrong.push('--out (a directory that does not exist yet, or is empty)');
  if (wrong.length > 0) {
    log(`onprem-windows-pack: wrong or missing: ${wrong.join('; ')}`);
    return 2;
  }
  const out = resolve(values.out);
  if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) {
    log(`onprem-windows-pack: ${out} exists and is not empty`);
    return 2;
  }
  mkdirSync(out, { recursive: true });
  const { transformSync } = createRequire(join(REPO_ROOT, 'apps', 'api', 'package.json'))('@swc/core');
  log(`onprem-windows-pack: web (${values.edition}, ${origin.origin})`);
  buildWeb({ out, origin: origin.origin, edition: values.edition, version: values.version });
  writeEdge({ out, origin });
  log('onprem-windows-pack: api (production dependencies, compiled sources)');
  const counts = buildApi({ out, transformSync });
  copyInfra({ out, edition: values.edition });
  writeFileSync(join(out, 'VERSION'), `${values.version}\n`);
  // The mark of authorship and of the recipient: who the pack is for (`--customer`) and who owns the work (`--copyright`), with the moment it was built. It names the
  // recipient of each pack, so a copy that leaves its installation can be traced to the recipient it was built for; it does not restrict what the recipient can do.
  const builtAt = new Date().toISOString();
  const watermark = { customer: values.customer ?? null, copyright: values.copyright ?? null, builtAt };
  if (values.customer !== undefined || values.copyright !== undefined) writeFileSync(join(out, 'NOTICE.txt'), noticeText({ ...watermark, version: values.version, edition: values.edition }));
  const manifest = { version: values.version, edition: values.edition, publicOrigin: origin.origin, publicHost: origin.host, platform: `${process.platform}-${process.arch}`, node: process.version, ...watermark, files: manifestOf(out) };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`onprem-windows-pack: ${counts.compiled} sources compiled, ${counts.copied} files copied, ${Object.keys(manifest.files).length} files in the manifest: ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
