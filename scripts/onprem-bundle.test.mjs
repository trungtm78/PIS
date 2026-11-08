import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_SCRIPTS, BUNDLE_TREES, FINDING_CODES, buildBundle, buildPlan, main, ociPlatforms, tarEntries, verifyBundle } from './onprem-bundle.mjs';
import { loadOnpremMessages } from './onprem-messages.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = JSON.parse(readFileSync(join(REPO_ROOT, 'infra', 'onprem', 'images.json'), 'utf8'));

const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));
const temp = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** A tar file with the given entries (name to text), in ustar form; a name over 100 characters is split into prefix and name. */
function tar(entries) {
  const blocks = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    const split = name.length > 100 ? name.lastIndexOf('/', 100) : -1;
    header.write(split === -1 ? name : name.slice(split + 1), 0, 100);
    if (split !== -1) header.write(name.slice(0, split), 345, 155);
    header.write('0000644\0', 100);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const descriptor = (arch, os = 'linux') => ({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${arch.padEnd(64, '0')}`, size: 1, platform: { os, architecture: arch } });
const flat = (...arches) => tar({ 'index.json': JSON.stringify({ manifests: arches.map((arch) => descriptor(arch)) }), 'oci-layout': '{"imageLayoutVersion":"1.0.0"}' });
const nested = (...arches) => {
  const inner = JSON.stringify({ manifests: [...arches.map((arch) => descriptor(arch)), descriptor('unknown', 'unknown')] });
  const digest = `sha256:${'a'.repeat(64)}`;
  return tar({ 'index.json': JSON.stringify({ manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', digest, size: inner.length }] }), [`blobs/sha256/${'a'.repeat(64)}`]: inner });
};

/** The fake of docker buildx and skopeo: it writes an archive at the destination named in the arguments. */
function fakeRun(archive = () => flat('amd64', 'arm64'), calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    const output = args.find((arg) => arg.startsWith('type=oci,dest='));
    const target = args.find((arg) => arg.startsWith('oci-archive:'));
    const path = output !== undefined ? /dest=(.*?)(?:,name=|$)/.exec(output)[1] : /^oci-archive:(.*\.oci\.tar):/.exec(target)[1];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, archive(path));
    return { status: 0, stdout: '', stderr: '' };
  };
}

const fakeSbom = ({ out }) => {
  writeFileSync(out, '{"bomFormat":"CycloneDX"}');
  return { ok: true, components: 1, problems: [] };
};

/** A small repository: the image list of the real one and one file in every tree the bundle carries. */
function scratchRoot() {
  const root = temp('machvon-bundle-root-');
  mkdirSync(join(root, 'infra', 'onprem', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'infra', 'onprem', 'images.json'), JSON.stringify(IMAGES));
  for (const tree of BUNDLE_TREES) {
    if (tree === 'infra/onprem/images.json') continue;
    const path = join(root, tree);
    if (/\.\w+$/.test(tree)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'x');
    } else {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'file.txt'), 'x');
    }
  }
  for (const script of BUNDLE_SCRIPTS) writeFileSync(join(root, 'infra', 'onprem', 'bundle', script), `#!/bin/sh\n# ${script}\n`);
  return root;
}

const options = (root, out) => ({ root, out, version: '1.2.3', publicHost: 'machvon.example.vn', edition: 'public', now: () => new Date('2026-11-08T00:00:00Z'), sbom: fakeSbom });
const codes = (items) => items.map((entry) => entry.code);

function built(archive) {
  const root = scratchRoot();
  const out = join(temp('machvon-bundle-out-'), 'bundle');
  const result = buildBundle({ ...options(root, out), run: fakeRun(archive) });
  return { root, out, result };
}

test('the plan builds each product image for both platforms, the web image for one host, and exports only runtime third-party images', () => {
  const steps = buildPlan({ images: IMAGES, version: '1.2.3', publicHost: 'h.example.vn', edition: 'enterprise', out: 'out' });
  assert.deepEqual(steps.filter((step) => step.kind === 'build').map((step) => step.name), ['api', 'workers', 'web', 'db']);
  for (const step of steps.filter((entry) => entry.kind === 'build')) assert.ok(step.args.includes('linux/amd64,linux/arm64'), step.name);
  const web = steps.find((step) => step.name === 'web');
  assert.ok(web.args.includes('PUBLIC_HOST=h.example.vn') && web.args.includes('MACHVON_EDITION=enterprise'));
  assert.ok(!steps.find((step) => step.name === 'api').args.some((arg) => arg.startsWith('PUBLIC_HOST')));
  const copies = steps.filter((step) => step.kind === 'copy');
  assert.deepEqual(copies.map((step) => step.name), ['keycloak']);
  assert.ok(copies[0].args.includes('--all') && copies[0].args.some((arg) => arg.includes('@sha256:')));
  assert.ok(steps.every((step) => !step.ref.endsWith(':latest')));
});

test('a dry run runs nothing and writes nothing', () => {
  const calls = [];
  const out = join(temp('machvon-bundle-dry-'), 'bundle');
  const result = buildBundle({ ...options(scratchRoot(), out), dryRun: true, run: fakeRun(undefined, calls) });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(out), false);
});

test('the version must be exact, the host a DNS name, the edition known and the image list complete for both platforms', () => {
  const root = scratchRoot();
  const bad = (change) => codes(buildBundle({ ...options(root, 'out'), dryRun: true, ...change }).findings);
  assert.deepEqual(bad({ version: 'latest' }), ['BUNDLE_VERSION_INVALID']);
  assert.deepEqual(bad({ version: '1.2' }), ['BUNDLE_VERSION_INVALID']);
  assert.deepEqual(bad({ publicHost: 'bad host/x' }), ['BUNDLE_HOST_INVALID']);
  assert.deepEqual(bad({ edition: 'community' }), ['BUNDLE_EDITION_INVALID']);
  const one = scratchRoot();
  writeFileSync(join(one, 'infra', 'onprem', 'images.json'), JSON.stringify({ ...IMAGES, platforms: ['linux/amd64'] }));
  assert.deepEqual(codes(buildBundle({ ...options(one, 'out'), dryRun: true }).findings), ['BUNDLE_PLATFORMS_INCOMPLETE']);
  const none = scratchRoot();
  writeFileSync(join(none, 'infra', 'onprem', 'images.json'), '{}');
  assert.deepEqual(codes(buildBundle({ ...options(none, 'out'), dryRun: true }).findings), ['BUNDLE_IMAGES_FILE_INVALID']);
});

test('a built bundle carries the archives, the SBOM, the deployment trees, the scripts, the manifest and a checksum list that verifies', () => {
  const { out, result } = built();
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.builtAt, '2026-11-08T00:00:00.000Z');
  assert.deepEqual(manifest.platforms, ['linux/amd64', 'linux/arm64']);
  assert.deepEqual(manifest.images.map((image) => image.name), ['api', 'workers', 'web', 'db', 'keycloak']);
  assert.ok(manifest.images.every((image) => image.platforms.join() === 'linux/amd64,linux/arm64' && /^[0-9a-f]{64}$/.test(image.sha256)));
  assert.ok(manifest.thirdPartyDigests.postgres.startsWith('sha256:'));
  assert.equal(readFileSync(join(out, 'VERSION'), 'utf8'), '1.2.3\n');
  for (const name of ['install.sh', 'rollback.sh', 'sbom.cdx.json', 'SHA256SUMS']) assert.ok(existsSync(join(out, name)), name);
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.ok(sums.every((line) => /^[0-9a-f]{64} {2}\S/.test(line)));
  assert.ok(!sums.some((line) => line.endsWith('SHA256SUMS')));
  assert.deepEqual(verifyBundle(out), []);
});

test('a nested image index is read down to its manifests, and a platform "unknown" (attestations) is not a platform', () => {
  const { out, result } = built(() => nested('amd64', 'arm64'));
  assert.equal(result.ok, true);
  assert.deepEqual(verifyBundle(out), []);
  const archive = join(out, 'images', 'api-1.2.3.oci.tar');
  assert.deepEqual([...ociPlatforms(archive)].sort(), ['linux/amd64', 'linux/arm64']);
});

test('verify finds a changed file, a missing file, a file that is not listed and a missing checksum list', () => {
  const { out } = built();
  appendFileSync(join(out, 'VERSION'), 'tampered');
  assert.deepEqual(codes(verifyBundle(out)).filter((code) => code === 'BUNDLE_CHECKSUM_MISMATCH'), ['BUNDLE_CHECKSUM_MISMATCH']);
  rmSync(join(out, 'install.sh'));
  assert.ok(codes(verifyBundle(out)).includes('BUNDLE_FILE_MISSING'));
  writeFileSync(join(out, 'extra.txt'), 'x');
  assert.ok(verifyBundle(out).some((entry) => entry.code === 'BUNDLE_FILE_UNLISTED' && entry.detail === 'extra.txt'));
  rmSync(join(out, 'SHA256SUMS'));
  assert.deepEqual(codes(verifyBundle(out)), ['BUNDLE_SUMS_MISSING']);
});

test('verify refuses an image archive that lacks arm64 or amd64 and one that is not an OCI layout', () => {
  const { out } = built((path) => (path.includes('db-') ? flat('amd64') : path.includes('web-') ? flat('arm64') : path.includes('workers-') ? tar({ 'other.txt': 'x' }) : flat('amd64', 'arm64')));
  const found = verifyBundle(out);
  assert.ok(found.some((entry) => entry.code === 'BUNDLE_IMAGE_ARCH_MISSING' && entry.detail === 'db: linux/arm64'));
  assert.ok(found.some((entry) => entry.code === 'BUNDLE_IMAGE_ARCH_MISSING' && entry.detail === 'web: linux/amd64'));
  assert.ok(found.some((entry) => entry.code === 'BUNDLE_IMAGE_UNREADABLE' && entry.detail.includes('workers-')));
});

test('verify refuses a manifest that lacks an image of the image list or disagrees with VERSION', () => {
  const { out } = built();
  const manifestPath = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.images = manifest.images.filter((image) => image.name !== 'keycloak');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.ok(verifyBundle(out).some((entry) => entry.code === 'BUNDLE_IMAGE_MISSING' && entry.detail === 'keycloak'));
  writeFileSync(manifestPath, '{"schema":2}');
  assert.ok(codes(verifyBundle(out)).includes('BUNDLE_MANIFEST_INVALID'));
});

test('a failing build command, a failing SBOM and a missing tree stop the build with a named finding', () => {
  const root = scratchRoot();
  const failing = () => ({ status: 1, stdout: '', stderr: 'boom\nlast line' });
  const first = buildBundle({ ...options(root, join(temp('machvon-bundle-fail-'), 'b')), run: failing });
  assert.deepEqual(codes(first.findings), ['BUNDLE_COMMAND_FAILED']);
  assert.match(first.findings[0].detail, /last line/);
  const sbomFailed = buildBundle({ ...options(root, join(temp('machvon-bundle-sbom-'), 'b')), run: fakeRun(), sbom: () => ({ ok: false, problems: [{ code: 'SBOM_EMPTY' }] }) });
  assert.deepEqual(codes(sbomFailed.findings), ['BUNDLE_SBOM_FAILED']);
  rmSync(join(root, 'infra', 'onprem', 'config'), { recursive: true });
  const missing = buildBundle({ ...options(root, join(temp('machvon-bundle-tree-'), 'b')), run: fakeRun() });
  assert.deepEqual(missing.findings, [{ code: 'BUNDLE_FILE_MISSING', detail: 'infra/onprem/config' }]);
  rmSync(join(root, 'infra', 'onprem', 'bundle', 'install.sh'));
  mkdirSync(join(root, 'infra', 'onprem', 'config'));
  const noScript = buildBundle({ ...options(root, join(temp('machvon-bundle-script-'), 'b')), run: fakeRun() });
  assert.equal(noScript.findings[0].detail, 'infra/onprem/bundle/install.sh');
});

test('the tar reader follows the prefix of a long name and stops at the end marker', () => {
  const directory = temp('machvon-tar-');
  const longName = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.json`;
  writeFileSync(join(directory, 'a.tar'), tar({ [longName]: '{}', 'small.txt': 'hello' }));
  const entries = tarEntries(join(directory, 'a.tar'));
  assert.deepEqual([...entries.keys()], [longName, 'small.txt']);
  assert.equal(entries.get('small.txt').size, 5);
  writeFileSync(join(directory, 'b.json'), 'not a tar');
  assert.equal(ociPlatforms(join(directory, 'b.json')), undefined);
  writeFileSync(join(directory, 'c.tar'), tar({ 'index.json': 'not json' }));
  assert.equal(ociPlatforms(join(directory, 'c.tar')), undefined);
});

test('main: plan prints the commands, build and verify return their status, a wrong call prints the usage', () => {
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(main(['plan', '--version', '1.2.3', '--public-host', 'machvon.example.vn', '--locale', 'en'], { log }), 0);
  assert.ok(lines.some((line) => line.startsWith('build api: docker buildx build')));
  assert.equal(main(['plan', '--version', 'latest', '--public-host', 'machvon.example.vn', '--locale', 'en'], { log }), 1);
  const root = scratchRoot();
  const out = join(temp('machvon-bundle-main-'), 'bundle');
  assert.equal(main(['build', '--root', root, '--out', out, '--version', '1.2.3', '--public-host', 'machvon.example.vn', '--locale', 'en'], { log, run: fakeRun(), sbom: fakeSbom }), 0);
  assert.equal(main(['verify', out, '--locale', 'en'], { log }), 0);
  appendFileSync(join(out, 'VERSION'), 'x');
  assert.equal(main(['verify', out, '--locale', 'en'], { log }), 1);
  assert.equal(main(['verify', '--locale', 'en'], { log }), 2);
  assert.equal(main(['nonsense'], { log }), 2);
  assert.equal(main(['--no-such-flag'], { log }), 2);
});

test('the install and rollback scripts check the bundle before they load anything and never name a floating tag', () => {
  const install = readFileSync(join(REPO_ROOT, 'infra', 'onprem', 'bundle', 'install.sh'), 'utf8');
  const rollback = readFileSync(join(REPO_ROOT, 'infra', 'onprem', 'bundle', 'rollback.sh'), 'utf8');
  assert.ok(install.indexOf('sha256sum --check') < install.indexOf('docker load'));
  assert.ok(rollback.indexOf('sha256sum --check') < rollback.indexOf('up --detach'));
  for (const script of [install, rollback]) {
    assert.match(script, /^set -eu$/m);
    assert.doesNotMatch(script, /:latest/);
    assert.doesNotMatch(script, /curl|wget|docker pull/);
  }
  assert.match(install, /\*\[!A-Za-z0-9_.~-\]\*\)/, 'a role password is checked before it goes into a statement');
  assert.ok(install.indexOf('*[!A-Za-z0-9_.~-]*)') < install.indexOf('ALTER ROLE'));
  assert.ok(install.indexOf("stat -c '%g'") > 0 && install.indexOf("stat -c '%g'") < install.indexOf('up --detach'), 'the ownership of the secret files is checked before anything starts');
  assert.match(install, /stanza-create/);
  assert.match(install, /backup --type=full/);
  assert.match(rollback, /schema is NOT rolled back/);
});

test('the shell scripts are syntactically valid when a POSIX shell is available', (context) => {
  const probe = spawnSync('sh', ['-c', 'exit 0']);
  if (probe.error !== undefined || probe.status !== 0) return context.skip('no POSIX shell on this host');
  for (const file of ['bundle/install.sh', 'bundle/rollback.sh', 'docker/secret-env.sh', 'config/db-init/10-keycloak.sh', 'config/egress-firewall.sh']) {
    const result = spawnSync('sh', ['-n', join(REPO_ROOT, 'infra', 'onprem', file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('secret-env turns NAME_FILE into NAME, fails by name on an unreadable file and never prints a value', (context) => {
  const probe = spawnSync('sh', ['-c', 'exit 0']);
  if (probe.error !== undefined || probe.status !== 0) return context.skip('no POSIX shell on this host');
  const directory = temp('machvon-secret-env-');
  writeFileSync(join(directory, 'token'), 'value-1\n');
  const script = join(REPO_ROOT, 'infra', 'onprem', 'docker', 'secret-env.sh');
  const ok = spawnSync('sh', [script, 'sh', '-c', 'printf "%s|%s" "$TOKEN" "${TOKEN_FILE-unset}"'], { encoding: 'utf8', env: { ...process.env, TOKEN_FILE: join(directory, 'token') } });
  assert.equal(ok.stdout, 'value-1|unset');
  const bad = spawnSync('sh', [script, 'sh', '-c', 'echo should-not-run'], { encoding: 'utf8', env: { ...process.env, MISSING_FILE: join(directory, 'nope') } });
  assert.equal(bad.status, 78);
  assert.match(bad.stderr, /MISSING_FILE names a file that cannot be read/);
  assert.equal(bad.stdout, '');
});

test('every finding code has a message in both languages and both catalogues have the same keys', () => {
  for (const locale of ['vi', 'en']) {
    const messages = loadOnpremMessages(locale);
    for (const code of FINDING_CODES) assert.ok(messages[`bundle.code.${code}`], `${locale}: ${code}`);
  }
  assert.deepEqual(Object.keys(loadOnpremMessages('vi')).sort(), Object.keys(loadOnpremMessages('en')).sort());
  assert.ok(readdirSync(join(REPO_ROOT, 'infra', 'onprem', 'bundle')).includes('install.sh'));
});

test('the egress firewall script prints rules that allow the object store and the directory and drop the rest of the egress network (no change without --apply)', (context) => {
  const probe = spawnSync('sh', ['-c', 'command -v getent >/dev/null']);
  if (probe.error !== undefined || probe.status !== 0) return context.skip('no getent on this host');
  const script = join(REPO_ROOT, 'infra', 'onprem', 'config', 'egress-firewall.sh');
  const printed = spawnSync('sh', [script, 'localhost', '443', 'localhost', '636'], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /iptables -A MACHVON-EGRESS -d 127\.0\.0\.1 -p tcp --dport 443 -j ACCEPT/);
  assert.match(printed.stdout, /--dport 636 -j ACCEPT/);
  assert.match(printed.stdout, /MACHVON-EGRESS -j DROP/);
  assert.match(printed.stdout, /DOCKER-USER[^\n]*172\.29\.250\.0\/24/);
  assert.equal(spawnSync('sh', [script, 'only', 'three'], { encoding: 'utf8' }).status, 2);
  assert.match(readFileSync(join(REPO_ROOT, 'infra', 'onprem', 'compose', 'compose.yaml'), 'utf8'), /172\.29\.250\.0\/24/, 'the subnet of the script is the one of the compose file');
});
