// Cuts a release (ST-KERNEL-033, AC-1): a semantic version worked out from the conventional commits since the previous
// release, a changelog grouped by module, the SBOM, the digests of the images that were built, and a manifest of all of it
// signed with an Ed25519 key, so that anyone with the public key can verify what a release is made of.
//
//   next   --from <rev> [--to <rev>] --current <version>      prints the next version, or nothing to release
//   notes  --from <rev> [--to <rev>] --version <version>      prints the changelog section of the release
//   cut    --from <rev> [--to <rev>] --current <version> --sbom <file> --image <name=sha256:digest> ... --signing-key <pem> --out <dir>
//   verify --dir <dir> --public-key <pem>                    exits 1 and names every way the release does not hold together
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateSbom } from './sbom.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCALE = 'vi';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SUBJECT = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_ID = /^[0-9a-f]{40}$/;
const GENERAL_MODULE = 'general';
const MANIFEST_FILE = 'manifest.json';
const SIGNATURE_FILE = 'manifest.sig';
const CHANGELOG_FILE = 'CHANGELOG.md';
const SBOM_FILE = 'sbom.cdx.json';
/** The record separators of the `git log` format below; a commit message cannot contain them. */
const FIELD = '\u001f';
const RECORD = '\u001e';

export const PROBLEM_CODES = [
  'MANIFEST_INVALID',
  'VERSION_INVALID',
  'COMMIT_INVALID',
  'IMAGES_EMPTY',
  'IMAGE_DIGEST_INVALID',
  'SBOM_MISSING',
  'SBOM_HASH_MISMATCH',
  'SBOM_INVALID',
  'CHANGELOG_MISSING',
  'CHANGELOG_HASH_MISMATCH',
  'SIGNATURE_MISSING',
  'SIGNATURE_INVALID',
];

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

/**
 * A conventional commit: `type(scope1,scope2)!: description`. The scopes name the modules it changed; a commit with none
 * belongs to `general`. A commit that is not conventional is undefined and is left out of the release.
 *
 * @returns {{ type: string, modules: string[], breaking: boolean, description: string } | undefined}
 */
export function parseCommit(subject, body = '') {
  const match = COMMIT_SUBJECT.exec(subject.trim());
  if (match === null) return undefined;
  const modules = (match[2] ?? '').split(',').map((scope) => scope.trim().toLowerCase()).filter((scope) => scope !== '');
  return {
    type: match[1].toLowerCase(),
    modules: modules.length === 0 ? [GENERAL_MODULE] : modules,
    breaking: match[3] === '!' || /^BREAKING[ -]CHANGE:/m.test(body),
    description: match[4].trim(),
  };
}

/**
 * The next semantic version: a breaking change raises the major, a feature the minor, a fix, a performance change or a
 * revert the patch. Anything else (documentation, tests, refactoring, build) does not make a release, and then there is no next version.
 */
export function nextVersion(current, commits) {
  const match = SEMVER.exec(current);
  if (match === null) throw new Error(`RELEASE_VERSION_INVALID ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (commits.some((commit) => commit.breaking)) return `${major + 1}.0.0`;
  if (commits.some((commit) => commit.type === 'feat')) return `${major}.${minor + 1}.0`;
  if (commits.some((commit) => ['fix', 'perf', 'revert'].includes(commit.type))) return `${major}.${minor}.${patch + 1}`;
  return undefined;
}

const TYPE_ORDER = ['feat', 'fix', 'perf', 'revert'];

/** The changelog section of a release, grouped by module (a commit that names two modules is listed under both), the modules in alphabetical order. */
export function changelogSection(version, date, commits) {
  const byModule = new Map();
  for (const commit of commits) {
    for (const module of commit.modules) byModule.set(module, [...(byModule.get(module) ?? []), commit]);
  }
  const lines = [`## ${version} (${date})`, ''];
  for (const module of [...byModule.keys()].sort()) {
    lines.push(`### ${module}`, '');
    const entries = byModule.get(module);
    const rank = (commit) => (TYPE_ORDER.includes(commit.type) ? TYPE_ORDER.indexOf(commit.type) : TYPE_ORDER.length);
    for (const commit of [...entries].sort((a, b) => Number(b.breaking) - Number(a.breaking) || rank(a) - rank(b))) {
      lines.push(`- ${commit.breaking ? '**BREAKING** ' : ''}${commit.type}: ${commit.description}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** The conventional commits of `from..to`, oldest first. `run` is the git runner, replaceable in tests. */
export function readCommits(from, to, { cwd, run = spawnSync } = {}) {
  const result = run('git', ['log', '--reverse', `--format=%H${FIELD}%s${FIELD}%b${RECORD}`, `${from}..${to}`], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`RELEASE_GIT_FAILED ${from}..${to}`);
  return result.stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim() !== '')
    .flatMap((record) => {
      const [, subject = '', body = ''] = record.split(FIELD);
      const commit = parseCommit(subject, body);
      return commit === undefined ? [] : [commit];
    });
}

/** The manifest as bytes: keys in alphabetical order at every depth, so that signing and verifying read the same text. */
export function canonicalJson(value) {
  const order = (node) => {
    if (Array.isArray(node)) return node.map(order);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.keys(node).sort().map((key) => [key, order(node[key])]));
  };
  return JSON.stringify(order(value));
}

/** An image given as `name=sha256:<64 hex digits>`. */
export function parseImage(text) {
  const at = text.indexOf('=');
  return { name: text.slice(0, at), digest: text.slice(at + 1) };
}

/**
 * Writes the release into `out`: the changelog section, the SBOM and the manifest (version, commit, the digests of the
 * images, the SHA-256 of the SBOM and of the changelog) with the Ed25519 signature of the manifest.
 */
export function cutRelease({ version, commit, createdAt, commits, images, sbomFile, signingKeyPem, out }) {
  mkdirSync(out, { recursive: true });
  const changelog = changelogSection(version, createdAt.slice(0, 10), commits);
  const sbom = readFileSync(sbomFile);
  writeFileSync(join(out, CHANGELOG_FILE), changelog);
  writeFileSync(join(out, SBOM_FILE), sbom);
  const manifest = {
    version,
    commit,
    createdAt,
    images: images.map(({ name, digest }) => ({ name, digest })),
    sbom: { file: SBOM_FILE, sha256: sha256(sbom) },
    changelog: { file: CHANGELOG_FILE, sha256: sha256(changelog) },
  };
  writeFileSync(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign(null, Buffer.from(canonicalJson(manifest)), createPrivateKey(signingKeyPem));
  writeFileSync(join(out, SIGNATURE_FILE), `${signature.toString('base64')}\n`);
  return manifest;
}

/**
 * Checks that a release holds together: the manifest is well formed, every image has a digest, the SBOM and the changelog
 * are the files the manifest hashes (and the SBOM is a valid one), and the signature is the one of the key given.
 * Returns the problems found (`{ code, detail }`), empty for a release that can be trusted.
 */
export function verifyRelease({ dir, publicKeyPem }) {
  const problems = [];
  const add = (code, detail = '') => problems.push({ code, detail });
  const manifestPath = join(dir, MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [{ code: 'MANIFEST_INVALID', detail: manifestPath }];
  }
  if (typeof manifest !== 'object' || manifest === null) return [{ code: 'MANIFEST_INVALID', detail: manifestPath }];
  if (!SEMVER.test(String(manifest.version))) add('VERSION_INVALID', String(manifest.version));
  if (!COMMIT_ID.test(String(manifest.commit))) add('COMMIT_INVALID', String(manifest.commit));
  const images = Array.isArray(manifest.images) ? manifest.images : [];
  if (images.length === 0) add('IMAGES_EMPTY');
  for (const image of images) {
    if (typeof image?.name !== 'string' || image.name === '' || !IMAGE_DIGEST.test(String(image?.digest))) add('IMAGE_DIGEST_INVALID', String(image?.name));
  }
  const sbomPath = join(dir, String(manifest.sbom?.file ?? SBOM_FILE));
  if (!existsSync(sbomPath)) {
    add('SBOM_MISSING', sbomPath);
  } else {
    const sbom = readFileSync(sbomPath);
    if (sha256(sbom) !== manifest.sbom?.sha256) add('SBOM_HASH_MISMATCH', sbomPath);
    let document;
    try {
      document = JSON.parse(sbom.toString('utf8'));
    } catch {
      document = undefined;
    }
    for (const problem of validateSbom(document)) add('SBOM_INVALID', problem.code);
  }
  const changelogPath = join(dir, String(manifest.changelog?.file ?? CHANGELOG_FILE));
  if (!existsSync(changelogPath)) add('CHANGELOG_MISSING', changelogPath);
  else if (sha256(readFileSync(changelogPath)) !== manifest.changelog?.sha256) add('CHANGELOG_HASH_MISMATCH', changelogPath);
  const signaturePath = join(dir, SIGNATURE_FILE);
  if (!existsSync(signaturePath)) {
    add('SIGNATURE_MISSING', signaturePath);
  } else {
    const signature = Buffer.from(readFileSync(signaturePath, 'utf8').trim(), 'base64');
    let valid = false;
    try {
      valid = verify(null, Buffer.from(canonicalJson(manifest)), createPublicKey(publicKeyPem), signature);
    } catch {
      valid = false;
    }
    if (!valid) add('SIGNATURE_INVALID', signaturePath);
  }
  return problems;
}

const OPTIONS = {
  from: { type: 'string' },
  to: { type: 'string', default: 'HEAD' },
  current: { type: 'string' },
  version: { type: 'string' },
  image: { type: 'string', multiple: true },
  sbom: { type: 'string' },
  'signing-key': { type: 'string' },
  'public-key': { type: 'string' },
  out: { type: 'string' },
  dir: { type: 'string' },
  commit: { type: 'string' },
  root: { type: 'string', default: resolve(SCRIPT_DIR, '..') },
  locale: { type: 'string', default: DEFAULT_LOCALE },
};

/** The commit a release is cut at: the one given, or what `to` resolves to. */
function resolveCommit(to, root, run) {
  const result = run('git', ['rev-parse', to], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`RELEASE_GIT_FAILED ${to}`);
  return result.stdout.trim();
}

export function main(argv, { log = console.log, run = spawnSync, now = () => new Date() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch {
    log(loadMessages(DEFAULT_LOCALE)['release.usage']);
    return 2;
  }
  const { values, positionals } = parsed;
  const messages = loadMessages(values.locale);
  const [command] = positionals;
  const root = resolve(values.root);
  const ranged = values.from !== undefined;
  if (command === 'next' && ranged && values.current !== undefined) {
    const version = nextVersion(values.current, readCommits(values.from, values.to, { cwd: root, run }));
    log(version ?? messages['release.nothing']);
    return version === undefined ? 1 : 0;
  }
  if (command === 'notes' && ranged && values.version !== undefined) {
    log(changelogSection(values.version, now().toISOString().slice(0, 10), readCommits(values.from, values.to, { cwd: root, run })).trimEnd());
    return 0;
  }
  if (command === 'cut' && ranged && values.current !== undefined && values.sbom !== undefined && values['signing-key'] !== undefined && values.out !== undefined) {
    const commits = readCommits(values.from, values.to, { cwd: root, run });
    const version = nextVersion(values.current, commits);
    if (version === undefined) {
      log(messages['release.nothing']);
      return 1;
    }
    const out = resolve(values.out);
    cutRelease({
      version,
      commit: values.commit ?? resolveCommit(values.to, root, run),
      createdAt: now().toISOString(),
      commits,
      images: (values.image ?? []).map(parseImage),
      sbomFile: resolve(values.sbom),
      signingKeyPem: readFileSync(resolve(values['signing-key']), 'utf8'),
      out,
    });
    log(format(messages['release.cut'], { version, out }));
    return 0;
  }
  if (command === 'verify' && values.dir !== undefined && values['public-key'] !== undefined) {
    const problems = verifyRelease({ dir: resolve(values.dir), publicKeyPem: readFileSync(resolve(values['public-key']), 'utf8') });
    for (const problem of problems) log(format(messages[`release.${problem.code}`], { detail: problem.detail }));
    log(problems.length === 0 ? messages['release.verify.pass'] : format(messages['release.verify.fail'], { count: problems.length }));
    return problems.length === 0 ? 0 : 1;
  }
  log(messages['release.usage']);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
