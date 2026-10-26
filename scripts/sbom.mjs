import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCALE = 'vi';
export const DEFAULT_SBOM_PATH = join('dist', 'sbom.cdx.json');
const SPEC_VERSIONS = new Set(['1.4', '1.5', '1.6']);
const COMPONENT_PURL = /^pkg:(?:npm|pub|docker)\//;
const PUB_SOURCE_PROPERTY = 'cdx:pub:source';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.test-locks']);
const DOCKERFILE_NAME = /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/;
/** The shortest digest in use (SHA-256) is 64 hexadecimal characters. */
const MIN_HASH_LENGTH = 64;
const PRIVATE_PROPERTY = 'cdx:npm:package:private';
const NPM_ARGS = ['sbom', '--sbom-format', 'cyclonedx', '--package-lock-only'];

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const hasHash = (component) =>
  Array.isArray(component.hashes) && component.hashes.some((hash) => typeof hash?.alg === 'string' && typeof hash.content === 'string' && hash.content.length >= MIN_HASH_LENGTH);

/** Only a package that is downloaded has a hash to carry: a pub package from the SDK, a path or a git source has none that a registry published. */
const needsHash = (component) => {
  if (isPrivate(component)) return false;
  if (typeof component.purl === 'string' && component.purl.startsWith('pkg:docker/')) return false;
  const source = component.properties?.find((property) => property.name === PUB_SOURCE_PROPERTY)?.value;
  return source === undefined || source === 'hosted';
};

/** Workspace packages are private and are not downloaded, so npm gives them no integrity hash. */
const isPrivate = (component) => Array.isArray(component.properties) && component.properties.some((property) => property.name === PRIVATE_PROPERTY && property.value === 'true');

/**
 * The shape of the CycloneDX document that the supply chain gate relies on: the format and spec version, a serial
 * number and timestamp, and for every component a package URL of the npm, pub or docker ecosystem and, for each downloaded
 * third-party component, at least one hash. Returns the problems found, empty for a valid document.
 */
export function validateSbom(document) {
  if (document === null || typeof document !== 'object' || document.bomFormat !== 'CycloneDX') return [{ code: 'SBOM_FORMAT' }];
  const problems = [];
  if (!SPEC_VERSIONS.has(document.specVersion)) problems.push({ code: 'SBOM_SPEC_VERSION' });
  if (typeof document.serialNumber !== 'string' || document.serialNumber === '') problems.push({ code: 'SBOM_SERIAL' });
  if (typeof document.metadata?.timestamp !== 'string') problems.push({ code: 'SBOM_TIMESTAMP' });
  if (!Array.isArray(document.components) || document.components.length === 0) return [...problems, { code: 'SBOM_EMPTY' }];
  for (const component of document.components) {
    const label = component['bom-ref'] ?? component.name;
    if (typeof component.purl !== 'string' || !COMPONENT_PURL.test(component.purl)) problems.push({ code: 'SBOM_COMPONENT_PURL', detail: label });
    if (needsHash(component) && !hasHash(component)) problems.push({ code: 'SBOM_COMPONENT_HASH', detail: label });
  }
  return problems;
}

const SPAWN_OPTIONS = { encoding: 'utf8', maxBuffer: 1 << 28 };

/**
 * Runs a command; `npm` goes through the npm CLI script that started this process (`npm run` sets npm_execpath), so no
 * shell is needed on Windows. Run directly with node, it falls back to the shell.
 */
export function runNpm(command, args, options = {}) {
  const cli = process.env.npm_execpath;
  if (command === 'npm' && typeof cli === 'string' && cli.endsWith('.js')) return spawnSync(process.execPath, [cli, ...args], { ...SPAWN_OPTIONS, ...options });
  return spawnSync(command, args, { ...SPAWN_OPTIONS, shell: process.platform === 'win32' && command === 'npm', ...options });
}

function filesNamed(root, matches) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
      } else if (matches(entry.name)) found.push(join(directory, entry.name));
    }
  };
  visit(root);
  return found.sort();
}

const unquote = (value) => value.trim().replace(/^"(.*)"$/, '$1');

/**
 * The pub components of every `pubspec.lock` under the root (the mobile clients): name, locked version and, for a package from the pub registry, its SHA-256. A package from the
 * SDK, a path or a git reference has no registry hash and is marked by its source instead.
 */
export function pubComponents(root) {
  const components = new Map();
  for (const file of filesNamed(root, (name) => name === 'pubspec.lock')) {
    let current;
    let inPackages = false;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (/^\S/.test(line)) inPackages = line.startsWith('packages:');
      if (!inPackages) continue;
      const header = /^ {2}([^\s:#][^:]*):\s*$/.exec(line);
      if (header !== null) {
        current = { name: header[1] };
        continue;
      }
      if (current === undefined) continue;
      const field = /^ {4,6}([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);
      if (field === null) continue;
      const value = unquote(field[2]);
      if (field[1] === 'sha256') current.sha256 = value;
      else if (field[1] === 'source') current.source = value;
      else if (field[1] === 'version') {
        current.version = value;
        const source = current.source ?? 'hosted';
        const purl = `pkg:pub/${current.name}@${value}`;
        components.set(purl, {
          'bom-ref': purl,
          type: 'library',
          name: current.name,
          version: value,
          purl,
          ...(current.sha256 === undefined ? {} : { hashes: [{ alg: 'SHA-256', content: current.sha256 }] }),
          properties: [{ name: PUB_SOURCE_PROPERTY, value: source }],
        });
      }
    }
  }
  return [...components.values()];
}

/** The images that the Dockerfiles under the root build from: one component for each base image, its tag or digest as the version; a digest is also its hash. */
export function imageComponents(root) {
  const components = new Map();
  for (const file of filesNamed(root, (name) => DOCKERFILE_NAME.test(name))) {
    const stages = new Set();
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      if (from === null) continue;
      const reference = from[1];
      if (from[2] !== undefined) stages.add(from[2].toLowerCase());
      if (reference.toLowerCase() === 'scratch' || stages.has(reference.toLowerCase())) continue;
      const digest = /@sha256:([0-9a-f]{64})$/i.exec(reference);
      const withoutDigest = digest === null ? reference : reference.slice(0, digest.index);
      const tagAt = withoutDigest.lastIndexOf(':');
      const hasTag = tagAt > withoutDigest.lastIndexOf('/');
      const name = hasTag ? withoutDigest.slice(0, tagAt) : withoutDigest;
      const version = hasTag ? withoutDigest.slice(tagAt + 1) : digest === null ? 'latest' : `sha256:${digest[1]}`;
      const purl = `pkg:docker/${name}@${version}`;
      components.set(purl, { 'bom-ref': purl, type: 'container', name, version, purl, ...(digest === null ? {} : { hashes: [{ alg: 'SHA-256', content: digest[1] }] }) });
    }
  }
  return [...components.values()];
}

/** Writes the CycloneDX SBOM of the repository: the npm lockfile through `npm sbom`, the pub lockfiles and the base images; writes nothing unless the document is valid. */
export function generateSbom({ root, out, run = runNpm }) {
  const result = run('npm', NPM_ARGS, { cwd: root });
  if (result.status !== 0) return { ok: false, components: 0, problems: [{ code: 'SBOM_NPM_FAILED', detail: String(result.stderr).trim() }] };
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    return { ok: false, components: 0, problems: [{ code: 'SBOM_NPM_FAILED', detail: 'the output is not JSON' }] };
  }
  // The npm document is the base; the pub packages of the mobile clients and the images of the Dockerfiles join it, so one document answers for everything that ships.
  if (Array.isArray(document?.components)) document.components.push(...pubComponents(root), ...imageComponents(root));
  const problems = validateSbom(document);
  if (problems.length > 0) return { ok: false, components: 0, problems };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  return { ok: true, components: document.components.length, problems: [] };
}

export function main(argv, { log = console.log, run = runNpm } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      out: { type: 'string', default: DEFAULT_SBOM_PATH },
      locale: { type: 'string', default: DEFAULT_LOCALE },
    },
  });
  const messages = loadMessages(values.locale);
  const root = resolve(values.root);
  const out = resolve(root, values.out);
  const result = generateSbom({ root, out, run });
  for (const problem of result.problems) log(format(messages[`sbom.code.${problem.code}`], { detail: problem.detail ?? '' }));
  log(result.ok ? format(messages['sbom.summary.pass'], { path: values.out, count: result.components }) : messages['sbom.summary.fail']);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
