import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_LOCALE, format, loadOnpremMessages } from './onprem-messages.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const POLICY_FILE = 'infra/onprem/native-deps.json';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.test-locks', 'test-results']);
const SOURCE_FILE = /\.(?:tsx?|mjs|cjs|js)$/;
const TEST_SOURCE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|e2e|__tests__)\/)/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const PLATFORM_TOKEN = /^(?:linux|darwin|win32|windows|android|freebsd|netbsd|openbsd|openharmony|aix|sunos|wasm32)(?:-|$)/;

export const FINDING_CODES = ['NATIVE_POLICY_INVALID', 'NATIVE_LOCKFILE_MISSING', 'NATIVE_NO_ARM64_PRODUCTION', 'NATIVE_NO_ARM64_UNACKNOWLEDGED', 'NATIVE_INSTALL_SCRIPT_UNACKNOWLEDGED', 'NATIVE_ACK_STALE', 'NATIVE_TESTONLY_IMPORTED'];

const finding = (code, detail = '') => ({ code, detail });

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const nameOf = (path) => path.replace(/^.*node_modules\//, '');

/**
 * The family of a platform binary package: `@esbuild/linux-arm64` is `@esbuild`, `@napi-rs/lzma-linux-x64-gnu` is `@napi-rs/lzma`,
 * `@rollup/rollup-linux-x64-gnu` is `@rollup/rollup`. A package that is not named for a platform is its own family.
 */
export function familyOf(name) {
  const scoped = name.startsWith('@');
  const [scope, local] = scoped ? name.split('/') : [undefined, name];
  const parts = local.split('-');
  for (let index = 0; index < parts.length; index += 1) {
    if (PLATFORM_TOKEN.test(parts.slice(index).join('-'))) return index === 0 ? (scope ?? local) : `${scope === undefined ? '' : `${scope}/`}${parts.slice(0, index).join('-')}`;
  }
  return name;
}

const hasLinuxArm64 = (entry) => (entry.os === undefined || entry.os.includes('linux')) && (entry.cpu === undefined || entry.cpu.includes('arm64'));
const isLinux = (entry) => entry.os === undefined || entry.os.includes('linux');

/**
 * Reads the lockfile and lists every native or binary package family: the packages that name an os or a cpu (the platform siblings of a binary), grouped by family, with whether
 * the family has a linux arm64 build and whether any member reaches production. Packages with an install script that belong to no family are listed apart.
 */
export function nativeInventory(lock) {
  const families = new Map();
  const installScripts = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || entry.link === true) continue;
    const name = nameOf(path);
    if (entry.os !== undefined || entry.cpu !== undefined) {
      const family = familyOf(name);
      const record = families.get(family) ?? { family, members: [], linux: false, arm64: false, production: false };
      record.members.push({ name, version: entry.version, os: entry.os ?? [], cpu: entry.cpu ?? [], dev: entry.dev === true });
      record.linux ||= isLinux(entry);
      record.arm64 ||= isLinux(entry) && hasLinuxArm64(entry);
      record.production ||= entry.dev !== true;
      families.set(family, record);
    } else if (entry.hasInstallScript === true || entry.gypfile === true) {
      installScripts.push({ name, version: entry.version, dev: entry.dev === true });
    }
  }
  // An install-script package that is not itself a platform family (esbuild installs the binary of its `@esbuild/*` siblings) must be acknowledged in the policy.
  const orphanScripts = installScripts.filter((script) => !families.has(script.name));
  return { families: [...families.values()].sort((a, b) => a.family.localeCompare(b.family)), installScripts, orphanScripts };
}

/** Judges the inventory against the policy. Returns findings and the families that lack a linux arm64 build, with their status. */
export function judgeNative(inventory, policy, today = new Date()) {
  const findings = [];
  const acknowledged = new Map((policy.acknowledged ?? []).map((item) => [item.family, item]));
  const testOnly = new Map((policy.testOnly ?? []).map((item) => [item.package, item]));
  const gaps = [];
  for (const family of inventory.families) {
    if (!family.linux || family.arm64) continue;
    const ack = acknowledged.get(family.family);
    const scope = family.production ? 'production' : 'dev';
    gaps.push({ family: family.family, scope, acknowledged: ack !== undefined });
    if (family.production) findings.push(finding('NATIVE_NO_ARM64_PRODUCTION', family.family));
    else if (ack === undefined || ack.scope !== 'dev' || typeof ack.reason !== 'string' || ack.reason.trim().length < 10) findings.push(finding('NATIVE_NO_ARM64_UNACKNOWLEDGED', family.family));
  }
  const gapNames = new Set(gaps.map((gap) => gap.family));
  for (const family of acknowledged.keys()) if (!gapNames.has(family)) findings.push(finding('NATIVE_ACK_STALE', family));
  const knownScripts = new Set(policy.installScripts?.acknowledged ?? []);
  for (const script of inventory.orphanScripts) if (!knownScripts.has(script.name)) findings.push(finding('NATIVE_INSTALL_SCRIPT_UNACKNOWLEDGED', script.name));
  return { findings, gaps, testOnly: [...testOnly.values()], today: today.toISOString().slice(0, 10) };
}

function sourceFiles(root, directory = '') {
  const found = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = directory === '' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...sourceFiles(root, relative));
    } else if (SOURCE_FILE.test(entry.name)) found.push(relative);
  }
  return found;
}

/** A test-only package may be imported by test files and by the files the policy names, nowhere else: product code that imports it would need its binary in production. */
export function testOnlyImports(root, policy) {
  const found = [];
  const roots = ['apps', 'packages', 'scripts'].filter((directory) => existsSync(join(root, directory)));
  const files = roots.flatMap((directory) => sourceFiles(root, directory));
  for (const entry of policy.testOnly) {
    const allowed = new Set(entry.allowedImporters ?? []);
    const pattern = new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"]${escapeRegExp(entry.package)}(?:/[^'"]*)?['"]`);
    for (const file of files) {
      if (allowed.has(file) || TEST_SOURCE.test(file)) continue;
      if (pattern.test(readFileSync(join(root, file), 'utf8'))) found.push(finding('NATIVE_TESTONLY_IMPORTED', `${entry.package} in ${file}`));
    }
  }
  return found;
}

export function checkNativeDeps(root) {
  const policy = readJson(join(root, POLICY_FILE));
  const valid = policy !== undefined && Array.isArray(policy.testOnly) && Array.isArray(policy.acknowledged) && policy.requiredPlatform?.os === 'linux' && policy.requiredPlatform?.cpu === 'arm64';
  if (!valid) return { findings: [finding('NATIVE_POLICY_INVALID', POLICY_FILE)], inventory: undefined, report: undefined };
  const lock = readJson(join(root, 'package-lock.json'));
  if (lock === undefined) return { findings: [finding('NATIVE_LOCKFILE_MISSING', 'package-lock.json')], inventory: undefined, report: undefined };
  const inventory = nativeInventory(lock);
  const report = judgeNative(inventory, policy);
  return { findings: [...report.findings, ...testOnlyImports(root, policy)], inventory, report };
}

export function main(argv, { log = console.log } = {}) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string', default: REPO_ROOT }, locale: { type: 'string', default: DEFAULT_LOCALE }, list: { type: 'boolean', default: false } } });
  const messages = loadOnpremMessages(values.locale);
  const root = resolve(values.root);
  if (!existsSync(root)) return 2;
  const { findings, inventory, report } = checkNativeDeps(root);
  if (inventory !== undefined && report !== undefined) {
    if (values.list) {
      for (const family of inventory.families) {
        const status = family.arm64 ? 'arm64' : family.linux ? 'NO-ARM64' : 'not-linux';
        log(format(messages['nativeDeps.family'], { family: family.family, members: family.members.length, status, scope: family.production ? 'production' : 'dev' }));
      }
    }
    for (const entry of report.testOnly) log(format(messages['nativeDeps.testOnly'], { package: entry.package }));
    for (const gap of report.gaps) log(format(messages['nativeDeps.gap'], { family: gap.family, scope: gap.scope, state: gap.acknowledged ? 'acknowledged' : 'open' }));
  }
  for (const entry of findings) log(format(messages[`nativeDeps.code.${entry.code}`], { detail: entry.detail }));
  log(findings.length === 0 ? messages['nativeDeps.summary.pass'] : format(messages['nativeDeps.summary.fail'], { count: findings.length }));
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
