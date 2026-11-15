import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDiff } from '../ci/src/scan.mjs';
import { SECRET_RULES } from '../ci/src/rules.mjs';

/**
 * UAT-NFR-SECURITY-06, the part a machine without the hosted pipeline can measure: the secret scan of the push gate goes red on a fake access key and a fake PEM key and names the file and
 * the line without repeating the secret, and the pipeline declares the scan of the whole history and the secret scan of every image. What stays manual: the red run of the hosted pipeline
 * on a test branch, the scan of a built image and its build environment, and the provider log that shows the key masked.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n');

// The fakes are put together here so that this file itself holds no line a secret scanner takes for a credential.
const FAKE_ACCESS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const FAKE_PEM_HEADER = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
const FAKE_PEM_BODY = 'MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake';

function diffAdding(file, firstLine, lines) {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +${firstLine},${lines.length} @@`, ...lines.map((line) => `+${line}`), ''].join('\n');
}

test('UAT-NFR-SECURITY-06: a commit with a fake access key and a fake PEM key turns the secret scan red at the file and the line of each, and the report never repeats the secret', () => {
  const diff = [
    diffAdding('apps/api/src/provider-settings.ts', 40, ['const region = "vn";', `const accessKeyId = "${FAKE_ACCESS_KEY}";`]),
    diffAdding('infra/onprem/docker/signing.pem', 1, [FAKE_PEM_HEADER, FAKE_PEM_BODY]),
  ].join('');
  const findings = scanDiff(diff, SECRET_RULES);

  assert.deepEqual(
    findings.map((entry) => ({ code: entry.code, severity: entry.severity, ...entry.params })),
    [
      { code: 'SECRET_FOUND', severity: 'error', file: 'apps/api/src/provider-settings.ts', line: 41 },
      { code: 'SECRET_FOUND', severity: 'error', file: 'infra/onprem/docker/signing.pem', line: 1 },
    ],
  );
  const report = JSON.stringify(findings);
  for (const secret of [FAKE_ACCESS_KEY, FAKE_PEM_HEADER, FAKE_PEM_BODY]) assert.equal(report.includes(secret), false);
});

test('UAT-NFR-SECURITY-06: the same commit without the two secrets passes the scan, so the red above is the secrets and nothing else', () => {
  const diff = [
    diffAdding('apps/api/src/provider-settings.ts', 40, ['const region = "vn";', 'const accessKeyId = process.env.PROVIDER_KEY_ID;']),
    diffAdding('infra/onprem/docker/signing.pem', 1, ['-----BEGIN CERTIFICATE-----', FAKE_PEM_BODY]),
  ].join('');
  assert.deepEqual(scanDiff(diff, SECRET_RULES), []);
});

test('UAT-NFR-SECURITY-06: the pipeline scans the whole history for secrets and fails on a finding without printing it', () => {
  const workflow = read('.github/workflows/security.yml');
  const job = workflow.slice(workflow.indexOf('\n  secrets:'), workflow.indexOf('\n  dependency-review:'));
  assert.match(job, /fetch-depth: 0/);
  const command = job.slice(job.indexOf('zricethezav/gitleaks:'));
  assert.match(command, /^zricethezav\/gitleaks:v[\d.]+@sha256:[0-9a-f]{64}/);
  for (const flag of ['detect --source /repo', '--config /repo/.gitleaks.toml', '--redact', '--exit-code 1']) assert.equal(command.includes(flag), true, flag);
  // The default rules stay on (they hold the access key and the private key rules), and no allowance forgives product code or the images.
  const rules = read('.gitleaks.toml');
  assert.match(rules, /\[extend\]\s+useDefault = true/);
  const allowedPaths = rules.slice(rules.indexOf('paths = ['), rules.indexOf(']', rules.indexOf('paths = [')));
  for (const path of ['apps/api/src/provider-settings.ts', 'infra/onprem/docker/signing.pem']) {
    const forgiven = [...allowedPaths.matchAll(/'''(.+?)'''/g)].some((match) => new RegExp(match[1]).test(path));
    assert.equal(forgiven, false, path);
  }
});

test('UAT-NFR-SECURITY-06: every image is scanned with the secret scanner and a finding fails the build', () => {
  const policy = read('infra/scan/trivy.yaml');
  assert.match(policy, /^exit-code: 1$/m);
  assert.match(policy, /^scan:\n {2}scanners:\n(?: {4}- \w+\n)*? {4}- secret\n/m);
  const images = read('.github/workflows/images.yml');
  const scan = images.slice(images.indexOf('- name: Scan the image'), images.indexOf('- name: SBOM of the image'));
  assert.match(scan, /aquasec\/trivy:[\d.]+@sha256:[0-9a-f]{64}/);
  assert.match(scan, /image --config infra\/scan\/trivy\.yaml machvon\/\$\{\{ matrix\.image \}\}/);
  // The scan step has no switch that would let a finding through.
  assert.equal(/continue-on-error|--exit-code 0|\|\| true/.test(scan), false);
});
