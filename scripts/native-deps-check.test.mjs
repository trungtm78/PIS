import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDING_CODES, checkNativeDeps, familyOf, judgeNative, main, nativeInventory, testOnlyImports } from './native-deps-check.mjs';
import { loadOnpremMessages } from './onprem-messages.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = {
  requiredPlatform: { os: 'linux', cpu: 'arm64' },
  testOnly: [{ package: 'embedded-postgres', reason: 'test only', allowedImporters: ['packages/db/src/test-database.ts'] }],
  acknowledged: [],
  installScripts: { acknowledged: [] },
};

const pkg = (version, extra = {}) => ({ version, ...extra });
const lock = (packages) => ({ packages: { '': {}, ...packages } });
const codes = (report) => report.findings.map((entry) => entry.code);

const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));
function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-native-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('the family of a platform binary package is its scope or its name before the platform', () => {
  assert.equal(familyOf('@esbuild/linux-arm64'), '@esbuild');
  assert.equal(familyOf('@embedded-postgres/windows-x64'), '@embedded-postgres');
  assert.equal(familyOf('@napi-rs/lzma-linux-x64-gnu'), '@napi-rs/lzma');
  assert.equal(familyOf('@rollup/rollup-linux-arm64-gnu'), '@rollup/rollup');
  assert.equal(familyOf('left-pad'), 'left-pad');
});

test('a family with a linux arm64 sibling passes; one without it is a gap', () => {
  const inventory = nativeInventory(
    lock({
      'node_modules/@x/linux-x64': pkg('1.0.0', { os: ['linux'], cpu: ['x64'] }),
      'node_modules/@x/linux-arm64': pkg('1.0.0', { os: ['linux'], cpu: ['arm64'] }),
      'node_modules/@y/linux-x64': pkg('1.0.0', { os: ['linux'], cpu: ['x64'] }),
      'node_modules/fsevents': pkg('2.0.0', { os: ['darwin'] }),
    }),
  );
  const report = judgeNative(inventory, POLICY);
  assert.deepEqual(report.gaps.map((gap) => gap.family), ['@y']);
  // @y reaches production (no dev flag), so it is an error and nothing can excuse it.
  assert.deepEqual(codes(report), ['NATIVE_NO_ARM64_PRODUCTION']);
});

test('a dev-only gap needs an acknowledgement with a reason, and a stale acknowledgement is reported', () => {
  const inventory = nativeInventory(lock({ 'node_modules/@napi-rs/lzma-linux-x64-gnu': pkg('1.5.1', { os: ['linux'], cpu: ['x64'], dev: true }) }));
  assert.deepEqual(codes(judgeNative(inventory, POLICY)), ['NATIVE_NO_ARM64_UNACKNOWLEDGED']);
  const acknowledged = { ...POLICY, acknowledged: [{ family: '@napi-rs/lzma', scope: 'dev', reason: 'rollup falls back to its own code' }] };
  assert.deepEqual(codes(judgeNative(inventory, acknowledged)), []);
  const short = { ...POLICY, acknowledged: [{ family: '@napi-rs/lzma', scope: 'dev', reason: 'ok' }] };
  assert.deepEqual(codes(judgeNative(inventory, short)), ['NATIVE_NO_ARM64_UNACKNOWLEDGED']);
  const fixed = nativeInventory(lock({ 'node_modules/@napi-rs/lzma-linux-arm64-gnu': pkg('1.5.1', { os: ['linux'], cpu: ['arm64'], dev: true }) }));
  assert.deepEqual(codes(judgeNative(fixed, acknowledged)), ['NATIVE_ACK_STALE']);
});

test('an install-script package that is not a platform family must be acknowledged', () => {
  const inventory = nativeInventory(lock({ 'node_modules/esbuild': pkg('0.25.0', { hasInstallScript: true, dev: true }), 'node_modules/@esbuild/linux-arm64': pkg('0.25.0', { os: ['linux'], cpu: ['arm64'], dev: true }) }));
  assert.deepEqual(codes(judgeNative(inventory, POLICY)), ['NATIVE_INSTALL_SCRIPT_UNACKNOWLEDGED']);
  assert.deepEqual(codes(judgeNative(inventory, { ...POLICY, installScripts: { acknowledged: ['esbuild'] } })), []);
});

test('a family without os or cpu members is not listed, and a workspace link is skipped', () => {
  const inventory = nativeInventory(lock({ 'node_modules/@machvon/kernel': { link: true, resolved: 'packages/kernel' }, 'node_modules/plain': pkg('1.0.0') }));
  assert.deepEqual(inventory.families, []);
  assert.deepEqual(inventory.installScripts, []);
});

test('a test-only package imported by product code is a finding; tests and the named files may import it', () => {
  const root = scratch({
    'packages/db/src/test-database.ts': "import EmbeddedPostgres from 'embedded-postgres';\n",
    'packages/db/test/helper.test.ts': "import EmbeddedPostgres from 'embedded-postgres';\n",
    'apps/api/src/serve.ts': "const pg = require('embedded-postgres/dist/index.js');\n",
    'apps/api/src/clean.ts': "import { x } from 'embedded-postgres-fork';\n",
  });
  assert.deepEqual(
    testOnlyImports(root, POLICY).map((entry) => entry.detail),
    ['embedded-postgres in apps/api/src/serve.ts'],
  );
});

test('the policy and the lockfile must exist', () => {
  assert.deepEqual(checkNativeDeps(scratch({})).findings.map((entry) => entry.code), ['NATIVE_POLICY_INVALID']);
  assert.deepEqual(checkNativeDeps(scratch({ 'infra/onprem/native-deps.json': POLICY })).findings.map((entry) => entry.code), ['NATIVE_LOCKFILE_MISSING']);
});

test('the real repository: every production family has a linux arm64 build, embedded-postgres is declared test-only', () => {
  const result = checkNativeDeps(REPO_ROOT);
  assert.deepEqual(result.findings, []);
  assert.ok(result.inventory.families.some((family) => family.family === '@embedded-postgres' && family.arm64));
  assert.ok(result.report.testOnly.some((entry) => entry.package === 'embedded-postgres'));
});

test('main prints the list and the gaps, returns 0 when clean and 1 on a finding', () => {
  const lines = [];
  assert.equal(main(['--list', '--locale', 'en'], { log: (line) => lines.push(line) }), 0);
  assert.ok(lines.some((line) => line.includes('test-only dependency: embedded-postgres')));
  assert.ok(lines.some((line) => line.startsWith('family @embedded-postgres')));
  const broken = scratch({ 'infra/onprem/native-deps.json': POLICY, 'package-lock.json': lock({ 'node_modules/@y/linux-x64': pkg('1.0.0', { os: ['linux'], cpu: ['x64'] }) }) });
  const out = [];
  assert.equal(main(['--root', broken, '--locale', 'en'], { log: (line) => out.push(line) }), 1);
  assert.ok(out.some((line) => line.includes('@y')));
  assert.equal(main(['--root', join(broken, 'missing')], { log: () => {} }), 2);
});

test('every finding code has a message in both languages', () => {
  for (const locale of ['vi', 'en']) {
    const messages = loadOnpremMessages(locale);
    for (const code of FINDING_CODES) assert.ok(messages[`nativeDeps.code.${code}`], `${locale}: ${code}`);
  }
  assert.deepEqual(Object.keys(loadOnpremMessages('vi')).sort(), Object.keys(loadOnpremMessages('en')).sort());
  assert.ok(readFileSync(join(REPO_ROOT, 'infra', 'onprem', 'native-deps.json'), 'utf8').includes('embedded-postgres'));
});
