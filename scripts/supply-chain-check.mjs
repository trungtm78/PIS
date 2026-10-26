import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_SBOM_PATH, runNpm, validateSbom } from './sbom.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCALE = 'vi';
const POLICY_FILE = 'supply-chain.json';
const LOCKFILE = 'package-lock.json';
const RANGE_POLICIES = new Set(['exact', 'lockfile']);
const AUDIT_SCOPES = new Set(['production', 'all']);
const DEFAULT_AUDIT_LEVEL = 'high';
const SEVERITIES = ['low', 'moderate', 'high', 'critical'];
/** The longest an exception to the audit may run: a finding is accepted for a quarter at most, then it is fixed or decided again. */
export const EXCEPTION_MAX_DAYS = 90;
const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON_LENGTH = 10;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.test-locks']);
const DOCKERFILE_NAME = /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/;
const NETWORK_FAILURE = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ESOCKETTIMEDOUT/;

const EXACT = /^(\d+)\.(\d+)\.(\d+)$/;
const EXACT_SPEC = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE_SPEC = /^([\^~])(\d+\.\d+\.\d+)$/;
const GIT_SPEC = /^(?:git\+[a-z]+:\/\/|git:\/\/|git@|github:|gitlab:|bitbucket:|gist:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/;
const GIT_COMMIT = /#([0-9a-f]{40})$/;
const URL_SPEC = /^(?:https?:\/\/|file:|link:|portal:)/;

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const finding = (code, file, detail = '') => ({ code, file, detail });
const auditFinding = (code, detail = '') => ({ code, detail });

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function numbers(version) {
  const match = EXACT.exec(version);
  return match === null ? undefined : match.slice(1).map(Number);
}

/** Whether `version` satisfies an exact version, a caret range or a tilde range; no other range is understood. */
export function satisfies(version, range) {
  if (version === range) return true;
  const actual = numbers(version);
  if (actual === undefined) return false;
  const exact = numbers(range);
  if (exact !== undefined) return actual.every((part, index) => part === exact[index]);
  const match = RANGE_SPEC.exec(range);
  if (match === null) return false;
  const [major, minor, patch] = numbers(match[2]);
  const [aMajor, aMinor, aPatch] = actual;
  const atLeast = aMajor > major || (aMajor === major && (aMinor > minor || (aMinor === minor && aPatch >= patch)));
  if (!atLeast) return false;
  if (match[1] === '~') return aMajor === major && aMinor === minor;
  if (major > 0) return aMajor === major;
  if (minor > 0) return aMajor === 0 && aMinor === minor;
  return aMajor === 0 && aMinor === 0 && aPatch === patch;
}

function loadPolicy(root, findings) {
  const defaults = { rangePolicy: 'exact', auditLevel: DEFAULT_AUDIT_LEVEL, auditScope: 'production' };
  const path = join(root, POLICY_FILE);
  if (!existsSync(path)) return defaults;
  const policy = readJson(path);
  if (policy === undefined || typeof policy !== 'object' || policy === null || (policy.rangePolicy !== undefined && !RANGE_POLICIES.has(policy.rangePolicy)) || (policy.auditScope !== undefined && !AUDIT_SCOPES.has(policy.auditScope)) || (policy.auditLevel !== undefined && !SEVERITIES.includes(policy.auditLevel))) {
    findings.push(finding('POLICY_INVALID', POLICY_FILE));
    return defaults;
  }
  return { ...defaults, ...policy };
}

/** The directories of the workspaces named by the root manifest (`dir/*` patterns and plain directories). */
function workspaceDirectories(root, manifest) {
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
  const directories = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      const base = join(root, parent);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(base, entry.name, 'package.json'))) directories.push(posix.join(parent, entry.name));
      }
    } else if (existsSync(join(root, pattern, 'package.json'))) {
      directories.push(pattern);
    }
  }
  return directories.sort();
}

/** The lockfile entry that `name` resolves to for the manifest in `directory` (a nested install wins over the root one). */
function lockedEntry(lock, directory, name) {
  const nested = directory === '' ? undefined : lock.packages?.[posix.join(directory, 'node_modules', name)];
  return nested ?? lock.packages?.[posix.join('node_modules', name)];
}

/** Whether the lockfile resolves `name` to the workspace directory that carries that name, not to a registry or a source. */
function linksToWorkspace(lock, directory, name, workspaceDirectoryByName) {
  const entry = lockedEntry(lock, directory, name);
  const target = workspaceDirectoryByName.get(name);
  return entry?.link === true && target !== undefined && entry.resolved === target;
}

/** Checks one manifest against the lockfile and the policy. */
function checkManifest({ manifest, directory, file, lock, policy, workspaceDirectoryByName, findings }) {
  const lockEntry = lock.packages?.[directory];
  if (lockEntry === undefined) {
    findings.push(finding('LOCKFILE_OUT_OF_SYNC', file, 'workspace is not in the lockfile'));
    return;
  }
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest[field] ?? {};
    const locked = lockEntry[field] ?? {};
    for (const name of new Set([...Object.keys(declared), ...Object.keys(locked)])) {
      if (declared[name] !== locked[name]) {
        findings.push(finding('LOCKFILE_OUT_OF_SYNC', file, `${name} is ${declared[name] ?? 'absent'} in the manifest and ${locked[name] ?? 'absent'} in the lockfile`));
      }
    }
    for (const [name, spec] of Object.entries(declared)) {
      if (linksToWorkspace(lock, directory, name, workspaceDirectoryByName)) continue;
      checkSpecification({ name, spec, directory, file, lock, policy, findings, inSync: spec === locked[name] });
    }
  }
}

function checkSpecification({ name, spec, directory, file, lock, policy, findings, inSync }) {
  const label = `${name}@${spec}`;
  if (URL_SPEC.test(spec) || (GIT_SPEC.test(spec) && !GIT_COMMIT.test(spec))) {
    findings.push(finding('UNPINNED_SOURCE', file, label));
    return;
  }
  if (GIT_SPEC.test(spec)) {
    // The commit is a valid pin, but the lockfile must still hold a package that was resolved from that very commit.
    if (!inSync) return;
    const entry = lockedEntry(lock, directory, name);
    const locked = typeof entry?.resolved === 'string' ? GIT_COMMIT.exec(entry.resolved)?.[1] : undefined;
    if (entry === undefined) findings.push(finding('LOCKFILE_OUT_OF_SYNC', file, `${name} has no locked package`));
    else if (locked !== GIT_COMMIT.exec(spec)[1]) findings.push(finding('LOCKFILE_OUT_OF_SYNC', file, `${label} is locked at ${locked ?? 'no commit'}`));
    return;
  }
  const isExact = EXACT_SPEC.test(spec);
  const isRange = RANGE_SPEC.test(spec);
  if (!isExact && !isRange) {
    findings.push(finding('FLOATING_SPEC', file, label));
    return;
  }
  if (isRange && policy.rangePolicy === 'exact') {
    findings.push(finding('UNPINNED_RANGE', file, label));
    return;
  }
  if (!inSync) return;
  const version = lockedEntry(lock, directory, name)?.version;
  if (version === undefined) findings.push(finding('LOCKFILE_OUT_OF_SYNC', file, `${name} has no locked package`));
  else if (!satisfies(version, spec)) findings.push(finding('LOCKFILE_OUT_OF_SYNC', file, `${label} is locked at ${version}`));
}

function dockerfilesIn(root, relative = '') {
  const found = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...dockerfilesIn(root, posix.join(relative, entry.name)));
    } else if (DOCKERFILE_NAME.test(entry.name)) {
      found.push(posix.join(relative, entry.name));
    }
  }
  return found;
}

/** Base images of a Dockerfile that are neither a digest nor a tag other than `latest`; stages and variables are not images. */
function unpinnedImages(text) {
  const stages = new Set();
  const unpinned = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (match === null) continue;
    const image = match[1];
    if (match[2] !== undefined) stages.add(match[2].toLowerCase());
    if (image === 'scratch' || image.includes('$') || stages.has(image.toLowerCase())) continue;
    const tag = image.split('/').pop().split(':')[1];
    if (!image.includes('@sha256:') && (tag === undefined || tag === 'latest')) unpinned.push(image);
  }
  return unpinned;
}

function checkImages(root, policy, findings) {
  for (const file of dockerfilesIn(root)) {
    if (typeof policy.imageScan?.tool !== 'string' || typeof policy.imageScan.failOn !== 'string') findings.push(finding('IMAGE_SCAN_POLICY_MISSING', file));
    for (const image of unpinnedImages(readFileSync(join(root, file), 'utf8'))) findings.push(finding('IMAGE_UNPINNED', file, image));
  }
}

function checkSbom(root, sbomPath, findings) {
  const path = join(root, sbomPath);
  if (!existsSync(path)) {
    findings.push(finding('SBOM_MISSING', sbomPath));
    return;
  }
  const document = readJson(path);
  if (document === undefined) {
    findings.push(finding('SBOM_INVALID', sbomPath));
    return;
  }
  for (const problem of validateSbom(document)) findings.push(finding(problem.code, sbomPath, problem.detail ?? ''));
}

/**
 * The static supply chain rules: no floating or unpinned dependency source in any workspace, a lockfile that describes
 * every manifest, a valid SBOM at `sbomPath` (null leaves the SBOM out) and, when the repository builds images, a scan
 * policy and pinned base images. Returns findings `{ code, file, detail }`.
 */
export function checkSupplyChain(root, { sbomPath = DEFAULT_SBOM_PATH } = {}) {
  const findings = [];
  const policy = loadPolicy(root, findings);
  const rootManifest = readJson(join(root, 'package.json')) ?? {};
  const lock = readJson(join(root, LOCKFILE));
  if (lock === undefined) {
    findings.push(finding('LOCKFILE_MISSING', LOCKFILE));
    return findings;
  }
  const directories = workspaceDirectories(root, rootManifest);
  const workspaces = directories.map((directory) => ({ directory, manifest: readJson(join(root, directory, 'package.json')) ?? {} }));
  const workspaceDirectoryByName = new Map(workspaces.filter((workspace) => typeof workspace.manifest.name === 'string').map((workspace) => [workspace.manifest.name, workspace.directory]));
  for (const { directory, manifest } of [{ directory: '', manifest: rootManifest }, ...workspaces]) {
    const file = directory === '' ? 'package.json' : posix.join(directory, 'package.json');
    checkManifest({ manifest, directory, file, lock, policy, workspaceDirectoryByName, findings });
  }
  if (sbomPath !== null) checkSbom(root, sbomPath, findings);
  checkImages(root, policy, findings);
  return findings;
}

/** The advisory an `npm audit` entry names: the GHSA or CVE id at the end of its URL, else the numeric source id. */
function advisoryId(via) {
  const last = typeof via.url === 'string' ? via.url.split('/').pop() : undefined;
  if (last !== undefined && /^(?:GHSA|CVE)-/i.test(last)) return last;
  return via.source === undefined ? 'unknown' : String(via.source);
}

/** The advisories at or above `level` that the report names, one for each package and advisory; a vulnerability that only comes through a dependency is named by the package that holds the advisory. */
function advisoriesOf(report, level) {
  const rank = SEVERITIES.indexOf(level);
  const found = new Map();
  for (const [name, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of Array.isArray(entry?.via) ? entry.via : []) {
      if (typeof via !== 'object' || via === null || SEVERITIES.indexOf(via.severity) < rank) continue;
      const item = { package: via.name ?? name, advisory: advisoryId(via), severity: via.severity };
      found.set(`${item.package}|${item.advisory}`, item);
    }
  }
  return [...found.values()].sort((a, b) => a.package.localeCompare(b.package) || a.advisory.localeCompare(b.advisory));
}

/**
 * The time-boxed exceptions of `supply-chain.json` (`auditExceptions`): each names the package, the advisory, an owner, a reason and a last day (YYYY-MM-DD) that is not past and not
 * more than `EXCEPTION_MAX_DAYS` ahead. An exception that is incomplete, past or too long is a finding and excepts nothing. Returns the valid ones by `package|advisory`.
 */
export function judgeExceptions(entries, now = new Date()) {
  const valid = new Map();
  const findings = [];
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const named = typeof entry?.package === 'string' && typeof entry?.advisory === 'string' ? `${entry.package} ${entry.advisory}` : `#${index + 1}`;
    const complete =
      typeof entry === 'object' && entry !== null && entry.package !== '' && entry.advisory !== '' && typeof entry.owner === 'string' && entry.owner.trim() !== '' &&
      typeof entry.reason === 'string' && entry.reason.trim().length >= MIN_REASON_LENGTH && typeof entry.expires === 'string' && ISO_DAY.test(entry.expires) && typeof entry.package === 'string' && typeof entry.advisory === 'string';
    if (!complete || Number.isNaN(Date.parse(`${entry.expires}T00:00:00Z`))) {
      findings.push(auditFinding('EXCEPTION_INVALID', named));
      return;
    }
    const end = Date.parse(`${entry.expires}T00:00:00Z`);
    if (end < today) findings.push(auditFinding('EXCEPTION_EXPIRED', `${named} ${entry.expires}`));
    else if (end - today > EXCEPTION_MAX_DAYS * DAY_MS) findings.push(auditFinding('EXCEPTION_TOO_LONG', `${named} ${entry.expires}`));
    else valid.set(`${entry.package}|${entry.advisory}`, entry);
  });
  return { valid, findings };
}

/**
 * Runs `npm audit` (production dependencies unless the policy says `all`) and judges it. A registry that cannot be reached is `skipped` (the gate earned no credit, it did not
 * pass); any other answer that is not a report is a failure, never a pass.
 */
export function auditFindings({ run = runNpm, level = DEFAULT_AUDIT_LEVEL, scope = 'production', root = REPO_ROOT, exceptions = [], now = new Date() } = {}) {
  // An unknown level must not be read as "critical only": nothing is judged until the level is one of the severities.
  if (!SEVERITIES.includes(level)) return { status: 'fail', findings: [auditFinding('AUDIT_LEVEL_INVALID', String(level))] };
  const result = run('npm', ['audit', '--json', ...(scope === 'production' ? ['--omit=dev'] : [])], { cwd: root });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { status: 'fail', findings: [auditFinding('AUDIT_FAILED')] };
  }
  const counts = report?.metadata?.vulnerabilities;
  if (counts === undefined) {
    const code = report?.error?.code;
    if (NETWORK_FAILURE.test(`${code ?? ''} ${JSON.stringify(report)}`)) return { status: 'skipped', findings: [] };
    return { status: 'fail', findings: [auditFinding('AUDIT_FAILED', report?.error?.summary ?? '')] };
  }
  const flagged = SEVERITIES.slice(SEVERITIES.indexOf(level))
    .reverse()
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${severity} ${counts[severity]}`);
  const judged = judgeExceptions(exceptions, now);
  const advisories = advisoriesOf(report, level);
  // A report that counts vulnerabilities but names none cannot be excepted: it fails with the counts, never passes.
  if (flagged.length > 0 && advisories.length === 0) return { status: 'fail', findings: [auditFinding('AUDIT_VULNERABLE', flagged.join(', ')), ...judged.findings] };
  const excepted = advisories.filter((item) => judged.valid.has(`${item.package}|${item.advisory}`)).map((item) => ({ ...item, ...judged.valid.get(`${item.package}|${item.advisory}`) }));
  const open = advisories.filter((item) => !judged.valid.has(`${item.package}|${item.advisory}`));
  const findings = [...open.map((item) => auditFinding('AUDIT_VULNERABLE', `${item.package} ${item.advisory} (${item.severity})`)), ...judged.findings];
  return { status: findings.length === 0 ? 'pass' : 'fail', findings, ...(excepted.length > 0 ? { excepted } : {}) };
}

export function main(argv, { log = console.log, run = runNpm } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', default: REPO_ROOT },
      sbom: { type: 'string', default: DEFAULT_SBOM_PATH },
      'skip-sbom': { type: 'boolean', default: false },
      audit: { type: 'boolean', default: false },
      'audit-level': { type: 'string' },
      locale: { type: 'string', default: DEFAULT_LOCALE },
    },
  });
  const messages = loadMessages(values.locale);
  const root = resolve(values.root);
  const findings = checkSupplyChain(root, { sbomPath: values['skip-sbom'] ? null : values.sbom });
  if (values.audit) {
    const policy = loadPolicy(root, []);
    const level = values['audit-level'] ?? policy.auditLevel;
    const audit = auditFindings({ run, level, scope: policy.auditScope, root, exceptions: policy.auditExceptions ?? [] });
    findings.push(...audit.findings);
    for (const item of audit.excepted ?? []) log(format(messages['supplyChain.audit.excepted'], item));
    if (audit.status === 'skipped') log(messages['supplyChain.audit.skipped']);
    if (audit.status === 'pass') log(format(messages['supplyChain.audit.pass'], { level }));
  }
  for (const item of findings) {
    log(format(messages['supplyChain.finding'], { file: item.file ?? '-', message: format(messages[`supplyChain.code.${item.code}`] ?? messages[`sbom.code.${item.code}`], { detail: item.detail }) }));
  }
  log(findings.length === 0 ? messages['supplyChain.summary.pass'] : format(messages['supplyChain.summary.fail'], { count: findings.length }));
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
