import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_LOCALE, format, loadOnpremMessages } from './onprem-messages.mjs';
import { generateSbom } from './sbom.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EDITIONS = new Set(['public', 'enterprise']);
const BLOCK = 512;
/** What the bundle carries of the repository, at the same relative paths, so that the compose file finds its neighbours unchanged. */
export const BUNDLE_TREES = ['infra/onprem/compose', 'infra/onprem/config', 'infra/onprem/docker/secret-env.sh', 'infra/onprem/systemd', 'infra/onprem/images.json', 'infra/onprem/secrets.json', 'infra/onprem/secrets-bi.json', 'infra/keycloak/onprem', 'infra/backup', 'docs/runbooks/infra'];
export const BUNDLE_SCRIPTS = ['install.sh', 'rollback.sh'];

export const FINDING_CODES = [
  'BUNDLE_VERSION_INVALID',
  'BUNDLE_HOST_INVALID',
  'BUNDLE_EDITION_INVALID',
  'BUNDLE_IMAGES_FILE_INVALID',
  'BUNDLE_PLATFORMS_INCOMPLETE',
  'BUNDLE_COMMAND_FAILED',
  'BUNDLE_SBOM_FAILED',
  'BUNDLE_MANIFEST_INVALID',
  'BUNDLE_SUMS_MISSING',
  'BUNDLE_FILE_MISSING',
  'BUNDLE_CHECKSUM_MISMATCH',
  'BUNDLE_FILE_UNLISTED',
  'BUNDLE_IMAGE_MISSING',
  'BUNDLE_IMAGE_ARCH_MISSING',
  'BUNDLE_IMAGE_UNREADABLE',
];

const finding = (code, detail = '') => ({ code, detail });
const runs = (image) => image.role === 'runtime';

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function* filesUnder(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

const toPosix = (path) => path.split(sep).join('/');

/** The plan of a build, as data: one entry per command. Nothing is run here; the tests and `plan` read it. */
export function buildPlan({ images, version, publicHost, edition, out }) {
  const steps = [];
  const platforms = images.platforms.join(',');
  for (const image of images.built) {
    const archive = posix.join('images', `${image.name}-${version}.oci.tar`);
    const args = ['buildx', 'build', '--platform', platforms, '--file', image.dockerfile, '--tag', `${image.repository}:${version}`, '--output', `type=oci,dest=${toPosix(join(out, archive))},name=${image.repository}:${version}`];
    if (image.name === 'web') args.push('--build-arg', `PUBLIC_HOST=${publicHost}`, '--build-arg', `MACHVON_EDITION=${edition}`);
    args.push('.');
    steps.push({ kind: 'build', name: image.name, command: 'docker', args, archive, ref: `${image.repository}:${version}` });
  }
  // Only runtime images are exported: a base image is a layer inside the images built from it and is never started on its own.
  for (const image of images.thirdParty.filter(runs)) {
    const archive = posix.join('images', `${image.name}-${image.tag}.oci.tar`);
    const ref = `${image.reference}:${image.tag}`;
    steps.push({ kind: 'copy', name: image.name, command: 'skopeo', args: ['copy', '--all', `docker://${image.reference}@${image.digest}`, `oci-archive:${toPosix(join(out, archive))}:${ref}`], archive, ref });
  }
  return steps;
}

/** Reads the entries of a tar file by header, without loading the file: name to { offset, size }. Handles ustar and the GNU long name entry. */
export function tarEntries(path) {
  const entries = new Map();
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(BLOCK);
    let offset = 0;
    let longName;
    for (;;) {
      if (readSync(descriptor, header, 0, BLOCK, offset) < BLOCK || header.every((byte) => byte === 0)) break;
      const text = (start, length) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
      const size = Number.parseInt(text(124, 12).trim() || '0', 8);
      const type = text(156, 1);
      const prefix = text(345, 155);
      const name = longName ?? (prefix === '' ? text(0, 100) : `${prefix}/${text(0, 100)}`);
      const dataOffset = offset + BLOCK;
      if (type === 'L') {
        const buffer = Buffer.alloc(size);
        readSync(descriptor, buffer, 0, size, dataOffset);
        longName = buffer.toString('utf8').replace(/\0.*$/s, '');
      } else {
        if (type === '0' || type === '' || type === '\0') entries.set(name.replace(/^\.\//, ''), { offset: dataOffset, size });
        longName = undefined;
      }
      offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
    }
  } finally {
    closeSync(descriptor);
  }
  return entries;
}

function readEntry(path, entries, name) {
  const entry = entries.get(name);
  if (entry === undefined) return undefined;
  const buffer = Buffer.alloc(entry.size);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, buffer, 0, entry.size, entry.offset);
  } finally {
    closeSync(descriptor);
  }
  return buffer.toString('utf8');
}

/** The platforms (os/arch) an OCI archive holds: from the platform of each manifest of the index, descending into nested indexes. Undefined when the archive is not an OCI layout. */
export function ociPlatforms(path) {
  const entries = tarEntries(path);
  const root = readEntry(path, entries, 'index.json');
  if (root === undefined) return undefined;
  const platforms = new Set();
  const visit = (index, depth) => {
    for (const descriptor of index.manifests ?? []) {
      const nested = typeof descriptor.mediaType === 'string' && descriptor.mediaType.includes('index');
      const os = descriptor.platform?.os;
      const arch = descriptor.platform?.architecture;
      if (nested && depth < 3) {
        const text = readEntry(path, entries, `blobs/${String(descriptor.digest).replace(':', '/')}`);
        if (text !== undefined) visit(JSON.parse(text), depth + 1);
      } else if (typeof os === 'string' && typeof arch === 'string' && os !== 'unknown') {
        platforms.add(`${os}/${arch}`);
      }
    }
  };
  try {
    visit(JSON.parse(root), 0);
  } catch {
    return undefined;
  }
  return platforms;
}

function checkOptions({ version, publicHost, edition }) {
  const problems = [];
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) problems.push(finding('BUNDLE_VERSION_INVALID', String(version)));
  if (typeof publicHost !== 'string' || !HOST_NAME.test(publicHost)) problems.push(finding('BUNDLE_HOST_INVALID', String(publicHost)));
  if (!EDITIONS.has(edition)) problems.push(finding('BUNDLE_EDITION_INVALID', String(edition)));
  return problems;
}

function loadImages(root) {
  const images = readJson(join(root, 'infra', 'onprem', 'images.json'));
  const valid = images !== undefined && Array.isArray(images.platforms) && Array.isArray(images.built) && Array.isArray(images.thirdParty);
  return valid ? images : undefined;
}

const defaultRun = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });

/**
 * Builds the offline bundle into `out`: every image of images.json as an OCI archive for linux/amd64 and linux/arm64 (the product images built with buildx, the third-party images copied by digest
 * with skopeo), the CycloneDX SBOM, the deployment files, `install.sh` and `rollback.sh`, `manifest.json` and `SHA256SUMS`. The build runs on the vendor build host with network access;
 * the bundle itself is installed with none. `run` and `sbom` are injected so that the tests run no daemon.
 */
export function buildBundle({ root = REPO_ROOT, out, version, publicHost, edition = 'public', dryRun = false, run = defaultRun, sbom = generateSbom, now = () => new Date() }) {
  const problems = checkOptions({ version, publicHost, edition });
  const images = loadImages(root);
  if (images === undefined) problems.push(finding('BUNDLE_IMAGES_FILE_INVALID', 'infra/onprem/images.json'));
  if (images !== undefined && !REQUIRED_PLATFORMS.every((platform) => images.platforms.includes(platform))) problems.push(finding('BUNDLE_PLATFORMS_INCOMPLETE', images.platforms.join(',')));
  if (problems.length > 0) return { ok: false, findings: problems, steps: [] };
  const steps = buildPlan({ images, version, publicHost, edition, out });
  if (dryRun) return { ok: true, findings: [], steps };

  mkdirSync(join(out, 'images'), { recursive: true });
  for (const step of steps) {
    const result = run(step.command, step.args, { cwd: root });
    if (result.status !== 0) return { ok: false, findings: [finding('BUNDLE_COMMAND_FAILED', `${step.command} ${step.args.slice(0, 2).join(' ')} (${step.name}): ${String(result.stderr ?? '').trim().split('\n').pop() ?? ''}`)], steps };
  }
  const sbomResult = sbom({ root, out: join(out, 'sbom.cdx.json') });
  if (!sbomResult.ok) return { ok: false, findings: [finding('BUNDLE_SBOM_FAILED', (sbomResult.problems ?? []).map((problem) => problem.code).join(','))], steps };
  for (const tree of BUNDLE_TREES) {
    const source = join(root, tree);
    if (!existsSync(source)) return { ok: false, findings: [finding('BUNDLE_FILE_MISSING', tree)], steps };
    mkdirSync(dirname(join(out, tree)), { recursive: true });
    cpSync(source, join(out, tree), { recursive: true });
  }
  for (const script of BUNDLE_SCRIPTS) {
    const source = join(root, 'infra', 'onprem', 'bundle', script);
    if (!existsSync(source)) return { ok: false, findings: [finding('BUNDLE_FILE_MISSING', `infra/onprem/bundle/${script}`)], steps };
    cpSync(source, join(out, script));
  }
  writeFileSync(join(out, 'VERSION'), `${version}\n`);
  const archives = steps.map((step) => {
    const platforms = ociPlatforms(join(out, step.archive));
    return { name: step.name, ref: step.ref, kind: step.kind, file: step.archive, platforms: platforms === undefined ? [] : [...platforms].sort(), sha256: sha256File(join(out, step.archive)) };
  });
  const digests = Object.fromEntries(images.thirdParty.map((image) => [image.name, image.digest]));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ schema: 1, product: 'machvon', version, edition, publicHost, builtAt: now().toISOString(), platforms: images.platforms, images: archives, thirdPartyDigests: digests }, null, 2)}\n`);
  writeSums(out);
  return { ok: true, findings: [], steps };
}

/** Writes SHA256SUMS in the format of `sha256sum --check`: every file of the bundle except the list itself, sorted. */
function writeSums(out) {
  const lines = [...filesUnder(out)]
    .map((path) => toPosix(relative(out, path)))
    .filter((name) => name !== 'SHA256SUMS')
    .sort()
    .map((name) => `${sha256File(join(out, name))}  ${name}`);
  writeFileSync(join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

/** Verifies a bundle directory the way the install script does, and beyond it: the listed files are the files present, every checksum matches, and every image archive holds both platforms. */
export function verifyBundle(directory) {
  const findings = [];
  const sumsPath = join(directory, 'SHA256SUMS');
  if (!existsSync(sumsPath)) return [finding('BUNDLE_SUMS_MISSING', 'SHA256SUMS')];
  const listed = new Map();
  for (const line of readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match !== null) listed.set(match[2], match[1]);
  }
  for (const [name, hash] of listed) {
    const path = join(directory, name);
    if (!existsSync(path) || !statSync(path).isFile()) findings.push(finding('BUNDLE_FILE_MISSING', name));
    else if (sha256File(path) !== hash) findings.push(finding('BUNDLE_CHECKSUM_MISMATCH', name));
  }
  for (const path of filesUnder(directory)) {
    const name = toPosix(relative(directory, path));
    if (name !== 'SHA256SUMS' && !listed.has(name)) findings.push(finding('BUNDLE_FILE_UNLISTED', name));
  }
  const manifest = readJson(join(directory, 'manifest.json'));
  if (manifest === undefined || manifest.schema !== 1 || !Array.isArray(manifest.images) || !EXACT_VERSION.test(String(manifest.version))) {
    findings.push(finding('BUNDLE_MANIFEST_INVALID', 'manifest.json'));
    return findings;
  }
  const version = existsSync(join(directory, 'VERSION')) ? readFileSync(join(directory, 'VERSION'), 'utf8').trim() : '';
  if (version !== manifest.version) findings.push(finding('BUNDLE_MANIFEST_INVALID', 'VERSION differs from manifest.json'));
  const required = readJson(join(directory, 'infra', 'onprem', 'images.json'));
  const expected = required === undefined ? [] : [...(required.built ?? []).map((image) => image.name), ...(required.thirdParty ?? []).filter(runs).map((image) => image.name)];
  for (const name of expected) if (!manifest.images.some((image) => image.name === name)) findings.push(finding('BUNDLE_IMAGE_MISSING', name));
  for (const image of manifest.images) {
    const path = join(directory, String(image.file));
    if (!existsSync(path)) {
      findings.push(finding('BUNDLE_IMAGE_MISSING', String(image.file)));
      continue;
    }
    const platforms = ociPlatforms(path);
    if (platforms === undefined) findings.push(finding('BUNDLE_IMAGE_UNREADABLE', String(image.file)));
    else for (const platform of REQUIRED_PLATFORMS) if (!platforms.has(platform)) findings.push(finding('BUNDLE_IMAGE_ARCH_MISSING', `${image.name}: ${platform}`));
  }
  return findings;
}

export function main(argv, { log = console.log, run = defaultRun, sbom = generateSbom } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { root: { type: 'string', default: REPO_ROOT }, out: { type: 'string', default: 'dist/onprem' }, version: { type: 'string' }, 'public-host': { type: 'string' }, edition: { type: 'string', default: 'public' }, locale: { type: 'string', default: DEFAULT_LOCALE }, 'dry-run': { type: 'boolean', default: false } },
    });
  } catch {
    log(loadOnpremMessages(DEFAULT_LOCALE)['bundle.usage']);
    return 2;
  }
  const { values, positionals } = parsed;
  const messages = loadOnpremMessages(values.locale);
  const [command, target] = positionals;
  const report = (findings) => findings.forEach((entry) => log(format(messages[`bundle.code.${entry.code}`], { detail: entry.detail })));
  if (command === 'verify') {
    if (target === undefined) {
      log(messages['bundle.usage']);
      return 2;
    }
    const findings = verifyBundle(resolve(target));
    report(findings);
    log(findings.length === 0 ? messages['bundle.verify.pass'] : format(messages['bundle.verify.fail'], { count: findings.length }));
    return findings.length === 0 ? 0 : 1;
  }
  if (command === 'build' || command === 'plan') {
    const root = resolve(values.root);
    const out = resolve(root, values.out);
    const result = buildBundle({ root, out, version: values.version, publicHost: values['public-host'], edition: values.edition, dryRun: command === 'plan' || values['dry-run'], run, sbom });
    for (const step of result.steps) log(format(messages['bundle.step'], { kind: step.kind, name: step.name, command: `${step.command} ${step.args.join(' ')}` }));
    report(result.findings);
    log(result.ok ? format(messages[command === 'plan' || values['dry-run'] ? 'bundle.plan.done' : 'bundle.build.done'], { out: values.out, version: values.version }) : messages['bundle.build.fail']);
    return result.ok ? 0 : 1;
  }
  log(messages['bundle.usage']);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
