import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFindings, checkSupplyChain, main, satisfies } from './supply-chain-check.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = { alg: 'SHA-512', content: 'b'.repeat(128) };
const SBOM = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: 'urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79',
  version: 1,
  metadata: { timestamp: '2026-10-23T00:00:00.000Z' },
  components: [{ 'bom-ref': 'left-pad@1.3.0', type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', hashes: [HASH] }],
};

function write(root, path, content) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/**
 * A scratch monorepo: root with workspaces `packages/*`, workspace `packages/app` (name @scratch/app) that depends on
 * `left-pad` as given and on the sibling `@scratch/lib` with `*`. The lockfile is consistent with the manifests unless a
 * test changes it.
 */
function scratch({ spec = '1.3.0', locked = '1.3.0', lockSpec = spec, policy, sbom = SBOM, extra = {}, libSpec = '*', libLock = { resolved: 'packages/lib', link: true }, lockedResolved, omitLocked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-supply-'));
  write(root, 'package.json', { name: 'scratch', private: true, workspaces: ['packages/*'], devDependencies: {} });
  write(root, 'packages/app/package.json', { name: '@scratch/app', version: '1.0.0', dependencies: { 'left-pad': spec, '@scratch/lib': libSpec }, ...extra });
  write(root, 'packages/lib/package.json', { name: '@scratch/lib', version: '1.0.0' });
  write(root, 'package-lock.json', {
    name: 'scratch',
    lockfileVersion: 3,
    packages: {
      '': { name: 'scratch', workspaces: ['packages/*'] },
      'packages/app': { name: '@scratch/app', version: '1.0.0', dependencies: { 'left-pad': lockSpec, '@scratch/lib': libSpec } },
      'packages/lib': { name: '@scratch/lib', version: '1.0.0' },
      'node_modules/@scratch/app': { resolved: 'packages/app', link: true },
      ...(libLock === null ? {} : { 'node_modules/@scratch/lib': libLock }),
      ...(omitLocked ? {} : { 'node_modules/left-pad': { version: locked, resolved: lockedResolved ?? `https://registry.npmjs.org/left-pad/-/left-pad-${locked}.tgz`, integrity: 'sha512-abc' } }),
    },
  });
  if (policy !== undefined) write(root, 'supply-chain.json', policy);
  if (sbom !== null) write(root, 'dist/sbom.cdx.json', sbom);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const codes = (findings) => findings.map((finding) => finding.code).sort();
const SBOM_PATH = join('dist', 'sbom.cdx.json');

function check(options, checkOptions = {}) {
  const { root, cleanup } = scratch(options);
  try {
    return checkSupplyChain(root, { sbomPath: SBOM_PATH, ...checkOptions });
  } finally {
    cleanup();
  }
}

test('exact pins, a lockfile in sync with the manifests, a valid SBOM and no Dockerfile make a clean workspace', () => {
  assert.deepEqual(check({}), []);
});

test('a caret or tilde range is an unpinned dependency under the default exact policy', () => {
  assert.deepEqual(check({ spec: '^1.3.0' }), [{ code: 'UNPINNED_RANGE', file: 'packages/app/package.json', detail: 'left-pad@^1.3.0' }]);
  assert.deepEqual(codes(check({ spec: '~1.3.0' })), ['UNPINNED_RANGE']);
});

test('the lockfile policy accepts a range that the locked version satisfies and reports one that it does not', () => {
  const policy = { rangePolicy: 'lockfile' };
  assert.deepEqual(check({ spec: '^1.2.0', locked: '1.9.4', policy }), []);
  assert.deepEqual(check({ spec: '~1.3.0', locked: '1.3.9', policy }), []);
  assert.deepEqual(check({ spec: '^1.2.0', locked: '2.0.0', policy }), [{ code: 'LOCKFILE_OUT_OF_SYNC', file: 'packages/app/package.json', detail: 'left-pad@^1.2.0 is locked at 2.0.0' }]);
  assert.deepEqual(codes(check({ spec: '~1.3.0', locked: '1.4.0', policy })), ['LOCKFILE_OUT_OF_SYNC']);
  assert.deepEqual(codes(check({ spec: '^0.2.3', locked: '0.3.0', policy })), ['LOCKFILE_OUT_OF_SYNC']);
  assert.deepEqual(codes(check({ spec: '^0.0.3', locked: '0.0.4', policy })), ['LOCKFILE_OUT_OF_SYNC']);
  assert.deepEqual(check({ spec: '^0.0.3', locked: '0.0.3', policy }), []);
});

test('an exact pin must be the locked version even under the lockfile policy', () => {
  assert.deepEqual(codes(check({ spec: '1.3.0', locked: '1.3.1', lockSpec: '1.3.0', policy: { rangePolicy: 'lockfile' } })), ['LOCKFILE_OUT_OF_SYNC']);
});

test('floating specifications are always reported, whatever the range policy', () => {
  for (const spec of ['*', 'latest', '>=1.0.0', '1.x', 'next', '', '1.2.3 - 2.0.0', '^1.0.0 || ^2.0.0']) {
    assert.deepEqual(codes(check({ spec, lockSpec: spec, policy: { rangePolicy: 'lockfile' } })), ['FLOATING_SPEC'], `spec "${spec}"`);
  }
});

test('a tarball URL, a git dependency without a commit and a local path are unpinned sources; a git commit is a pin', () => {
  for (const spec of ['https://example.test/left-pad.tgz', 'github:owner/left-pad', 'git+https://example.test/left-pad.git#main', 'file:../left-pad']) {
    assert.deepEqual(codes(check({ spec, lockSpec: spec })), ['UNPINNED_SOURCE'], `spec "${spec}"`);
  }
  const commit = 'a'.repeat(40);
  const pinned = { spec: `github:owner/left-pad#${commit}`, lockSpec: `github:owner/left-pad#${commit}` };
  assert.deepEqual(check({ ...pinned, lockedResolved: `git+ssh://git@github.com/owner/left-pad.git#${commit}` }), []);
});

test('a git commit pin still needs a locked package that resolves to that commit', () => {
  const commit = 'a'.repeat(40);
  const pinned = { spec: `github:owner/left-pad#${commit}`, lockSpec: `github:owner/left-pad#${commit}` };
  assert.deepEqual(check({ ...pinned, omitLocked: true }).map((item) => [item.code, item.detail]), [['LOCKFILE_OUT_OF_SYNC', 'left-pad has no locked package']]);
  const other = 'b'.repeat(40);
  assert.deepEqual(check({ ...pinned, lockedResolved: `git+ssh://git@github.com/owner/left-pad.git#${other}` }).map((item) => [item.code, item.detail]), [
    ['LOCKFILE_OUT_OF_SYNC', `left-pad@github:owner/left-pad#${commit} is locked at ${other}`],
  ]);
  // The registry tarball of a version is not the commit that was asked for.
  assert.deepEqual(codes(check({ ...pinned })), ['LOCKFILE_OUT_OF_SYNC']);
});

test('a sibling workspace package may use any specification: it is linked, not downloaded', () => {
  assert.deepEqual(check({}), []);
});

test('a dependency named like a workspace is exempt only when the lockfile links it to that workspace', () => {
  // Resolved from the registry instead of the workspace: the name alone proves nothing.
  const external = { resolved: 'https://registry.npmjs.org/@scratch/lib/-/lib-2.0.0.tgz', version: '2.0.0', integrity: 'sha512-abc' };
  assert.deepEqual(codes(check({ libLock: external })), ['FLOATING_SPEC']);
  assert.deepEqual(codes(check({ libSpec: '^2.0.0', libLock: external })), ['UNPINNED_RANGE']);
  assert.deepEqual(check({ libSpec: '2.0.0', libLock: external }), []);
  assert.deepEqual(codes(check({ libSpec: 'github:owner/lib', libLock: external })), ['UNPINNED_SOURCE']);
  // Linked to some other directory, or not in the lockfile at all.
  assert.deepEqual(codes(check({ libLock: { resolved: 'packages/elsewhere', link: true } })), ['FLOATING_SPEC']);
  assert.deepEqual(codes(check({ libLock: null })), ['FLOATING_SPEC']);
});

test('a missing lockfile is reported and ends the check of the manifests', () => {
  const { root, cleanup } = scratch({});
  try {
    rmSync(join(root, 'package-lock.json'));
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), [{ code: 'LOCKFILE_MISSING', file: 'package-lock.json', detail: '' }]);
  } finally {
    cleanup();
  }
});

test('a manifest that the lockfile does not describe is out of sync: a changed dependency, a workspace missing from the lock and a dependency with no locked package', () => {
  assert.deepEqual(check({ spec: '1.3.0', lockSpec: '1.2.0' }), [{ code: 'LOCKFILE_OUT_OF_SYNC', file: 'packages/app/package.json', detail: 'left-pad is 1.3.0 in the manifest and 1.2.0 in the lockfile' }]);

  const { root, cleanup } = scratch({});
  try {
    write(root, 'packages/new/package.json', { name: '@scratch/new', version: '1.0.0' });
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), [{ code: 'LOCKFILE_OUT_OF_SYNC', file: 'packages/new/package.json', detail: 'workspace is not in the lockfile' }]);
  } finally {
    cleanup();
  }

  const noPackage = scratch({});
  try {
    write(noPackage.root, 'package-lock.json', {
      lockfileVersion: 3,
      packages: {
        '': {},
        'packages/app': { dependencies: { 'left-pad': '1.3.0', '@scratch/lib': '*' } },
        'packages/lib': {},
        'node_modules/@scratch/lib': { resolved: 'packages/lib', link: true },
      },
    });
    assert.deepEqual(checkSupplyChain(noPackage.root, { sbomPath: SBOM_PATH }), [{ code: 'LOCKFILE_OUT_OF_SYNC', file: 'packages/app/package.json', detail: 'left-pad has no locked package' }]);
  } finally {
    noPackage.cleanup();
  }
});

test('the root manifest and a workspace in a plain directory are checked too', () => {
  const { root, cleanup } = scratch({});
  try {
    write(root, 'package.json', { name: 'scratch', private: true, workspaces: ['packages/*', 'tools'], devDependencies: { 'left-pad': '^1.0.0' } });
    write(root, 'tools/package.json', { name: '@scratch/tools', version: '1.0.0' });
    assert.deepEqual(codes(checkSupplyChain(root, { sbomPath: SBOM_PATH })), ['LOCKFILE_OUT_OF_SYNC', 'LOCKFILE_OUT_OF_SYNC', 'UNPINNED_RANGE'].sort());
  } finally {
    cleanup();
  }
});

test('a missing or invalid SBOM is reported; the SBOM check can be left out for a check of the manifests alone', () => {
  assert.deepEqual(check({ sbom: null }), [{ code: 'SBOM_MISSING', file: SBOM_PATH, detail: '' }]);
  assert.deepEqual(check({ sbom: { ...SBOM, bomFormat: 'SPDX' } }), [{ code: 'SBOM_FORMAT', file: SBOM_PATH, detail: '' }]);
  assert.deepEqual(check({ sbom: null }, { sbomPath: null }), []);
  const { root, cleanup } = scratch({ sbom: null });
  try {
    write(root, SBOM_PATH, 'not json');
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), [{ code: 'SBOM_INVALID', file: SBOM_PATH, detail: '' }]);
  } finally {
    cleanup();
  }
});

test('a Dockerfile needs an image scan policy and base images that are pinned', () => {
  const { root, cleanup } = scratch({});
  try {
    write(root, 'deploy/Dockerfile', 'FROM node:24.1.0-alpine AS build\nFROM scratch\nFROM build\nRUN true\n');
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), [{ code: 'IMAGE_SCAN_POLICY_MISSING', file: 'deploy/Dockerfile', detail: '' }]);
    write(root, 'supply-chain.json', { imageScan: { tool: 'trivy', failOn: 'HIGH' } });
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), []);
    write(root, 'deploy/Dockerfile', 'FROM node:latest\nFROM node\nFROM --platform=linux/amd64 alpine:3.20@sha256:' + 'c'.repeat(64) + '\nFROM ${BASE}\n');
    assert.deepEqual(
      checkSupplyChain(root, { sbomPath: SBOM_PATH }).map((finding) => finding.detail),
      ['node:latest', 'node'],
    );
    write(root, 'supply-chain.json', { imageScan: { tool: 'trivy' } });
    assert.deepEqual(codes(checkSupplyChain(root, { sbomPath: SBOM_PATH })), ['IMAGE_SCAN_POLICY_MISSING', 'IMAGE_UNPINNED', 'IMAGE_UNPINNED']);
  } finally {
    cleanup();
  }
});

test('a Dockerfile inside node_modules is not part of the repository', () => {
  const { root, cleanup } = scratch({});
  try {
    write(root, 'node_modules/some/Dockerfile', 'FROM node:latest\n');
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), []);
  } finally {
    cleanup();
  }
});

test('the policy file must be JSON and name a known range policy', () => {
  const { root, cleanup } = scratch({});
  try {
    write(root, 'supply-chain.json', 'not json');
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), [{ code: 'POLICY_INVALID', file: 'supply-chain.json', detail: '' }]);
    write(root, 'supply-chain.json', { rangePolicy: 'anything' });
    assert.deepEqual(codes(checkSupplyChain(root, { sbomPath: SBOM_PATH })), ['POLICY_INVALID']);
    write(root, 'supply-chain.json', { auditLevel: 'hgh' });
    assert.deepEqual(codes(checkSupplyChain(root, { sbomPath: SBOM_PATH })), ['POLICY_INVALID']);
    write(root, 'supply-chain.json', { auditLevel: 'moderate' });
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), []);
  } finally {
    cleanup();
  }
});

test('satisfies understands exact versions, carets and tildes and nothing else', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('1.9.0', '^1.2.3'), true);
  assert.equal(satisfies('1.2.2', '^1.2.3'), false);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.2.3-beta.1', '^1.2.0'), false);
  assert.equal(satisfies('not-a-version', '^1.0.0'), false);
  assert.equal(satisfies('1.0.0', '>=1.0.0'), false);
});

const audit = (stdout, status = 0) => () => ({ status, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });

test('the audit passes without vulnerabilities at or above the level', () => {
  const report = { metadata: { vulnerabilities: { info: 0, low: 3, moderate: 2, high: 0, critical: 0, total: 5 } } };
  assert.deepEqual(auditFindings({ run: audit(report), level: 'high' }), { status: 'pass', findings: [] });
});

test('the audit fails on a vulnerability at or above the level and counts each severity (AC-ST-KERNEL-013-1)', () => {
  const report = { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 4, high: 2, critical: 1, total: 7 } } };
  assert.deepEqual(auditFindings({ run: audit(report, 1), level: 'high' }), { status: 'fail', findings: [{ code: 'AUDIT_VULNERABLE', detail: 'critical 1, high 2' }] });
  assert.deepEqual(auditFindings({ run: audit(report, 1), level: 'moderate' }).findings[0].detail, 'critical 1, high 2, moderate 4');
  assert.deepEqual(auditFindings({ run: audit(report, 1), level: 'critical' }).findings[0].detail, 'critical 1');
});

test('an unknown audit level is refused before anything is judged, never read as critical only', () => {
  const report = { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 5, critical: 0, total: 5 } } };
  let ran = false;
  const run = (...args) => {
    ran = true;
    return audit(report, 1)(...args);
  };
  assert.deepEqual(auditFindings({ run, level: 'hgh' }), { status: 'fail', findings: [{ code: 'AUDIT_LEVEL_INVALID', detail: 'hgh' }] });
  assert.equal(ran, false);
});

test('main fails on a misspelled --audit-level instead of auditing at critical only', () => {
  const { root, cleanup } = scratch({});
  try {
    const lines = [];
    const report = { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 5, critical: 0, total: 5 } } };
    assert.equal(main(['--root', root, '--skip-sbom', '--audit', '--audit-level', 'hgh', '--locale', 'en'], { log: (line) => lines.push(line), run: audit(report, 1) }), 1);
    assert.match(lines.join('\n'), /hgh/);
  } finally {
    cleanup();
  }
});

test('the audit is skipped, never passed, when the registry cannot be reached', () => {
  const offline = { message: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org', error: { summary: '', detail: '' } };
  assert.deepEqual(auditFindings({ run: audit(offline, 1), level: 'high' }), { status: 'skipped', findings: [] });
  const refused = { message: 'reason: connect ECONNREFUSED 127.0.0.1:9', error: {} };
  assert.equal(auditFindings({ run: audit(refused, 1), level: 'high' }).status, 'skipped');
  const code = { error: { code: 'EAI_AGAIN', summary: 'network', detail: '' } };
  assert.equal(auditFindings({ run: audit(code, 1), level: 'high' }).status, 'skipped');
});

test('the audit fails, instead of being skipped, when npm gives an answer that is neither a report nor a network error', () => {
  assert.deepEqual(auditFindings({ run: audit('garbage', 1), level: 'high' }), { status: 'fail', findings: [{ code: 'AUDIT_FAILED', detail: '' }] });
  assert.deepEqual(auditFindings({ run: audit({ error: { code: 'E403', summary: 'forbidden' } }, 1), level: 'high' }).findings, [{ code: 'AUDIT_FAILED', detail: 'forbidden' }]);
});

test('main prints each finding and exits 1, or exits 0 for a clean workspace', () => {
  const { root, cleanup } = scratch({ spec: '^1.3.0' });
  try {
    const lines = [];
    assert.equal(main(['--root', root, '--sbom', SBOM_PATH, '--locale', 'en'], { log: (line) => lines.push(line) }), 1);
    assert.match(lines.join('\n'), /packages[\\/]app[\\/]package\.json: left-pad@\^1\.3\.0 is a version range/);
    assert.match(lines.join('\n'), /1 supply chain problem/);
  } finally {
    cleanup();
  }
  const clean = scratch({});
  try {
    const lines = [];
    assert.equal(main(['--root', clean.root, '--sbom', SBOM_PATH, '--locale', 'en'], { log: (line) => lines.push(line) }), 0);
    assert.match(lines.join('\n'), /Supply chain rules hold/);
  } finally {
    clean.cleanup();
  }
});

test('main reports an offline audit as SKIPPED and still exits 0; a vulnerable audit exits 1', () => {
  const { root, cleanup } = scratch({});
  try {
    const offline = [];
    const run = audit({ message: 'getaddrinfo ENOTFOUND registry.npmjs.org', error: {} }, 1);
    assert.equal(main(['--root', root, '--sbom', SBOM_PATH, '--audit', '--locale', 'en'], { log: (line) => offline.push(line), run }), 0);
    assert.match(offline.join('\n'), /SKIPPED.*audit/i);

    const vulnerable = [];
    const report = { metadata: { vulnerabilities: { high: 1, critical: 0, moderate: 0, low: 0, info: 0, total: 1 } } };
    assert.equal(main(['--root', root, '--sbom', SBOM_PATH, '--audit', '--locale', 'en'], { log: (line) => vulnerable.push(line), run: audit(report, 1) }), 1);
    assert.match(vulnerable.join('\n'), /high 1/);

    const passing = [];
    assert.equal(main(['--root', root, '--sbom', SBOM_PATH, '--audit', '--audit-level', 'critical', '--locale', 'en'], { log: (line) => passing.push(line), run: audit(report) }), 0);
    assert.match(passing.join('\n'), /audit.*no vulnerabilit/i);
  } finally {
    cleanup();
  }
});

test('main without --sbom checks the default SBOM path of the repository layout', () => {
  const { root, cleanup } = scratch({ sbom: null });
  try {
    const lines = [];
    assert.equal(main(['--root', root, '--locale', 'en'], { log: (line) => lines.push(line) }), 1);
    assert.match(lines.join('\n'), /dist[\\/]sbom\.cdx\.json: the SBOM is missing/);
  } finally {
    cleanup();
  }
});

test('the repository itself keeps its supply chain rules (manifests and lockfile; the SBOM is generated in CI)', () => {
  assert.deepEqual(checkSupplyChain(REPO_ROOT, { sbomPath: null }), []);
});

test('main --skip-sbom checks the manifests and the lockfile only', () => {
  const { root, cleanup } = scratch({ sbom: null });
  try {
    const lines = [];
    assert.equal(main(['--root', root, '--skip-sbom', '--locale', 'en'], { log: (line) => lines.push(line) }), 0);
    assert.match(lines.join('\n'), /Supply chain rules hold/);
  } finally {
    cleanup();
  }
});

test('the audit covers the production dependencies unless the policy asks for all of them', () => {
  const seen = [];
  const run = (command, args) => {
    seen.push([command, ...args].join(' '));
    return { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: {} } }), stderr: '' };
  };
  auditFindings({ run, level: 'high' });
  auditFindings({ run, level: 'high', scope: 'all' });
  assert.deepEqual(seen, ['npm audit --json --omit=dev', 'npm audit --json']);
});

test('the policy may scope the audit to production or all dependencies and nothing else', () => {
  const { root, cleanup } = scratch({});
  try {
    write(root, 'supply-chain.json', { auditScope: 'all' });
    assert.deepEqual(checkSupplyChain(root, { sbomPath: SBOM_PATH }), []);
    write(root, 'supply-chain.json', { auditScope: 'some' });
    assert.deepEqual(codes(checkSupplyChain(root, { sbomPath: SBOM_PATH })), ['POLICY_INVALID']);
  } finally {
    cleanup();
  }
});

// A report as `npm audit --json` writes it: the package that holds the advisory carries it in `via`; the packages that only depend on it name the package.
const advisoryReport = (vulnerabilities = {}) => ({
  vulnerabilities: {
    'bad-package': {
      name: 'bad-package',
      severity: 'high',
      via: [{ source: 1099999, name: 'bad-package', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', range: '<2.0.0' }],
    },
    'depends-on-bad': { name: 'depends-on-bad', severity: 'high', via: ['bad-package'] },
    'minor-package': { name: 'minor-package', severity: 'low', via: [{ source: 5, name: 'minor-package', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'low' }] },
    ...vulnerabilities,
  },
  metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 2, critical: 0, total: 3 } },
});
const NOW = new Date('2026-10-26T03:00:00Z');
const EXCEPTION = { package: 'bad-package', advisory: 'GHSA-aaaa-bbbb-cccc', owner: 'security@example.org', reason: 'No fixed release yet; the call path is not reachable', expires: '2026-12-01' };

test('a dependency with a published high advisory is red and names the package and the advisory id (AC-ST-KERNEL-013-1, UAT-NFR-SECURITY-07)', () => {
  const result = auditFindings({ run: audit(advisoryReport(), 1), level: 'high', now: NOW });
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.findings, [{ code: 'AUDIT_VULNERABLE', detail: 'bad-package GHSA-aaaa-bbbb-cccc (high)' }]);
});

test('a time-boxed exception turns the audit green and the exception appears in the report (AC-ST-KERNEL-013-1, UAT-NFR-SECURITY-07)', () => {
  const result = auditFindings({ run: audit(advisoryReport(), 1), level: 'high', exceptions: [EXCEPTION], now: NOW });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.excepted, [{ package: 'bad-package', advisory: 'GHSA-aaaa-bbbb-cccc', severity: 'high', owner: 'security@example.org', reason: EXCEPTION.reason, expires: '2026-12-01' }]);
  const { root, cleanup } = scratch({ policy: { rangePolicy: 'lockfile', auditExceptions: [EXCEPTION] } });
  try {
    const lines = [];
    assert.equal(main(['--root', root, '--skip-sbom', '--audit', '--locale', 'en'], { log: (line) => lines.push(line), run: audit(advisoryReport(), 1) }), 0);
    assert.match(lines.join('\n'), /EXCEPTED: bad-package GHSA-aaaa-bbbb-cccc \(high\) until 2026-12-01, owner security@example\.org/);
  } finally {
    cleanup();
  }
});

test('an exception does not cover another advisory of the package, another package, or a vulnerability the report only counts', () => {
  const other = { ...EXCEPTION, advisory: 'GHSA-zzzz-zzzz-zzzz' };
  assert.equal(auditFindings({ run: audit(advisoryReport(), 1), level: 'high', exceptions: [other], now: NOW }).status, 'fail');
  const counted = { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } };
  const result = auditFindings({ run: audit(counted, 1), level: 'high', exceptions: [EXCEPTION], now: NOW });
  assert.deepEqual(result.findings, [{ code: 'AUDIT_VULNERABLE', detail: 'high 1' }]);
});

test('an exception that is past, longer than a quarter or incomplete is a finding and excepts nothing (AC-ST-KERNEL-013-1)', () => {
  const past = auditFindings({ run: audit(advisoryReport(), 1), level: 'high', exceptions: [{ ...EXCEPTION, expires: '2026-10-25' }], now: NOW });
  assert.deepEqual(codes(past.findings), ['AUDIT_VULNERABLE', 'EXCEPTION_EXPIRED']);
  const today = auditFindings({ run: audit(advisoryReport(), 1), level: 'high', exceptions: [{ ...EXCEPTION, expires: '2026-10-26' }], now: NOW });
  assert.equal(today.status, 'pass');
  const long = auditFindings({ run: audit(advisoryReport(), 1), level: 'high', exceptions: [{ ...EXCEPTION, expires: '2027-02-01' }], now: NOW });
  assert.deepEqual(codes(long.findings), ['AUDIT_VULNERABLE', 'EXCEPTION_TOO_LONG']);
  for (const broken of [{ ...EXCEPTION, owner: '' }, { ...EXCEPTION, reason: 'short' }, { ...EXCEPTION, expires: 'soon' }, { ...EXCEPTION, expires: '2026-13-45' }, { package: 'bad-package' }, null]) {
    const result = auditFindings({ run: audit(advisoryReport(), 1), level: 'high', exceptions: [broken], now: NOW });
    assert.deepEqual(codes(result.findings), ['AUDIT_VULNERABLE', 'EXCEPTION_INVALID']);
  }
  const stale = auditFindings({ run: audit({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }), level: 'high', exceptions: [{ ...EXCEPTION, expires: '2026-01-01' }], now: NOW });
  assert.deepEqual(codes(stale.findings), ['EXCEPTION_EXPIRED']);
});

test('names the advisory by its numeric source when the report has no GHSA or CVE link, and reports each advisory once', () => {
  const report = advisoryReport({
    'other-package': { name: 'other-package', severity: 'critical', via: [{ source: 77, name: 'other-package', severity: 'critical' }, { source: 77, name: 'other-package', severity: 'critical' }, { source: 78, severity: 'critical', url: 'https://example.org/page' }] },
  });
  const details = auditFindings({ run: audit(report, 1), level: 'high', now: NOW }).findings.map((item) => item.detail);
  assert.deepEqual(details, ['bad-package GHSA-aaaa-bbbb-cccc (high)', 'other-package 77 (critical)', 'other-package 78 (critical)']);
});

test('the daily audit workflow runs every day, audits the lockfile, and raises an issue with an owner on a failure (AC-ST-KERNEL-013-3, UAT-NFR-OBSERVABILITY-02)', () => {
  const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'supply-chain-daily.yml'), 'utf8');
  assert.match(text, /^on:\s*\n\s+schedule:\s*\n\s+- cron: '\d{1,2} \d{1,2} \* \* \*'/m, 'a daily cron: minute and hour fixed, every day');
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /npm run supply-chain:check -- --audit/);
  assert.match(text, /issues: write/);
  assert.match(text, /gh issue (?:create|comment)/);
  assert.match(text, /--assignee "\$\{\{ env\.SUPPLY_CHAIN_OWNER \}\}"/);
  assert.match(text, /SUPPLY_CHAIN_OWNER: \$\{\{ vars\.SUPPLY_CHAIN_OWNER/);
  assert.match(text, /if: steps\.audit\.outcome == 'failure'/);
  assert.match(text, /osv-scanner/, 'the pub packages are audited with the OSV scanner');
});
