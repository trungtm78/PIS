import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBLEM_CODES, canonicalJson, changelogSection, main, nextVersion, parseCommit, parseImage, readCommits, verifyRelease } from './release.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-11-03T08:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

const scratch = mkdtempSync(join(tmpdir(), 'release-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const pem = (key, type) => key.export({ type, format: 'pem' }).toString();
const privatePem = pem(keys.privateKey, 'pkcs8');
const publicPem = pem(keys.publicKey, 'spki');
const otherPublicPem = pem(otherKeys.publicKey, 'spki');
const keyFile = (name, text) => {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
};
const SIGNING_KEY = keyFile('signing.pem', privatePem);
const PUBLIC_KEY = keyFile('public.pem', publicPem);

const sbomDocument = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: 'urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79',
  metadata: { timestamp: '2026-11-03T07:00:00.000Z' },
  components: [{ 'bom-ref': 'pkg:npm/left-pad@1.3.0', type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', hashes: [{ alg: 'SHA-256', content: 'c'.repeat(64) }] }],
};
const SBOM_FILE = keyFile('sbom.cdx.json', JSON.stringify(sbomDocument));

// ---------------------------------------------------------------------------------------------------------------------
// A real git repository with a merged set of conventional commits.
// ---------------------------------------------------------------------------------------------------------------------

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(subjects) {
  const root = mkdtempSync(join(scratch, 'repo-'));
  git(root, 'init', '--quiet');
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'chore: baseline');
  git(root, 'tag', 'v1.4.2');
  for (const subject of subjects) git(root, 'commit', '--quiet', '--allow-empty', '-m', subject);
  return root;
}

const MERGED = [
  'feat(bid,web): clarification requests to contractors (ST-BID-011)',
  'fix(pay): a settlement posted twice is refused',
  'feat(cap): reallocation proposals under the workflow version in force',
  'docs(kernel): explain the burn rate',
  'Merge branch topic into main',
  'refactor(web): split the shell',
];

function run(argv, extra = {}) {
  const lines = [];
  const code = main(argv, { log: (line) => lines.push(line), now: () => NOW, ...extra });
  return { code, lines };
}

const cutArgs = (root, out, images = [`api=${DIGEST}`, `worker=${OTHER_DIGEST}`]) => [
  'cut',
  '--locale',
  'en',
  '--root',
  root,
  '--from',
  'v1.4.2',
  '--current',
  '1.4.2',
  '--sbom',
  SBOM_FILE,
  '--signing-key',
  SIGNING_KEY,
  '--out',
  out,
  ...images.flatMap((image) => ['--image', image]),
];

// ---------------------------------------------------------------------------------------------------------------------

test('parseCommit reads the type, the modules of the scope, a breaking mark and the description', () => {
  assert.deepEqual(parseCommit('feat(bid,web): clarification requests (ST-BID-011)'), { type: 'feat', modules: ['bid', 'web'], breaking: false, description: 'clarification requests (ST-BID-011)' });
  assert.deepEqual(parseCommit('fix(PAY): x'), { type: 'fix', modules: ['pay'], breaking: false, description: 'x' });
  assert.deepEqual(parseCommit('perf: faster'), { type: 'perf', modules: ['general'], breaking: false, description: 'faster' });
  assert.equal(parseCommit('feat(api)!: drop the old field').breaking, true);
  assert.equal(parseCommit('fix(api): x', 'Details\n\nBREAKING CHANGE: the field is gone').breaking, true);
  assert.equal(parseCommit('fix(api): x', 'a line that says BREAKING CHANGE: later in a sentence').breaking, false);
  assert.equal(parseCommit('feat(): empty scope').modules[0], 'general');
});

test('parseCommit leaves out what is not a conventional commit', () => {
  for (const subject of ['Merge branch topic into main', 'update stuff', 'feat add a thing', 'feat(a):nospace']) assert.equal(parseCommit(subject), undefined, subject);
});

test('nextVersion: a breaking change raises the major, a feature the minor, a fix the patch, and anything else makes no release', () => {
  const commit = (type, breaking = false) => ({ type, modules: ['x'], breaking, description: 'd' });
  assert.equal(nextVersion('1.4.2', [commit('fix'), commit('feat'), commit('feat', true)]), '2.0.0');
  assert.equal(nextVersion('1.4.2', [commit('fix'), commit('feat')]), '1.5.0');
  assert.equal(nextVersion('1.4.2', [commit('docs'), commit('fix')]), '1.4.3');
  assert.equal(nextVersion('1.4.2', [commit('perf')]), '1.4.3');
  assert.equal(nextVersion('1.4.2', [commit('revert')]), '1.4.3');
  assert.equal(nextVersion('1.4.2', [commit('docs'), commit('test'), commit('refactor'), commit('chore')]), undefined);
  assert.equal(nextVersion('1.4.2', []), undefined);
  assert.equal(nextVersion('0.0.0', [commit('feat')]), '0.1.0');
  for (const bad of ['1.4', 'v1.4.2', '01.4.2', '1.4.2-rc.1']) assert.throws(() => nextVersion(bad, []), /RELEASE_VERSION_INVALID/, bad);
});

test('changelogSection groups by module in alphabetical order, lists a commit under every module it names, and puts breaking changes and features first', () => {
  const section = changelogSection('1.5.0', '2026-11-03', [
    parseCommit('fix(pay): a settlement posted twice is refused'),
    parseCommit('feat(bid,web): clarification requests'),
    parseCommit('docs(pay): note'),
    parseCommit('feat(pay)!: new ledger shape'),
    parseCommit('fix(pay)!: the amount becomes a string'),
    parseCommit('feat(pay): a plain feature'),
    parseCommit('feat: something general'),
  ]);
  assert.equal(
    section,
    [
      '## 1.5.0 (2026-11-03)',
      '',
      '### bid',
      '',
      '- feat: clarification requests',
      '',
      '### general',
      '',
      '- feat: something general',
      '',
      '### pay',
      '',
      '- **BREAKING** feat: new ledger shape',
      '- **BREAKING** fix: the amount becomes a string',
      '- feat: a plain feature',
      '- fix: a settlement posted twice is refused',
      '- docs: note',
      '',
      '### web',
      '',
      '- feat: clarification requests',
      '',
      '',
    ].join('\n'),
  );
});

test('readCommits reads the conventional commits of a range from git, oldest first, and leaves out the rest', () => {
  const root = repository(['feat(bid): one', 'Merge branch x', 'fix(pay): two\n\nBREAKING CHANGE: the amount is now a string']);
  const commits = readCommits('v1.4.2', 'HEAD', { cwd: root });
  assert.deepEqual(commits.map((commit) => [commit.type, commit.modules[0], commit.breaking]), [
    ['feat', 'bid', false],
    ['fix', 'pay', true],
  ]);
  assert.throws(() => readCommits('no-such-tag', 'HEAD', { cwd: root }), /RELEASE_GIT_FAILED/);
});

test('canonicalJson writes the keys in alphabetical order at every depth', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
});

test('parseImage splits the name from the digest at the first equals sign', () => {
  assert.deepEqual(parseImage(`api=${DIGEST}`), { name: 'api', digest: DIGEST });
});

// ---------------------------------------------------------------------------------------------------------------------

test('AC-ST-KERNEL-033-1 UAT-NFR-OPERABILITY-02: a release cut from merged conventional commits has a semantic version, signed image digests, an SBOM and a changelog grouped by module, and all of it verifies', () => {
  const root = repository(MERGED);
  const out = join(scratch, 'release-1');
  const cut = run(cutArgs(root, out));
  assert.equal(cut.code, 0);
  assert.match(cut.lines[0], /release 1\.5\.0 written to/);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.5.0');
  assert.equal(manifest.commit, git(root, 'rev-parse', 'HEAD'));
  assert.equal(manifest.createdAt, NOW.toISOString());
  assert.deepEqual(manifest.images, [
    { name: 'api', digest: DIGEST },
    { name: 'worker', digest: OTHER_DIGEST },
  ]);
  const changelog = readFileSync(join(out, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## 1\.5\.0 \(2026-11-03\)\n/);
  assert.deepEqual([...changelog.matchAll(/^### (.+)$/gm)].map((match) => match[1]), ['bid', 'cap', 'kernel', 'pay', 'web']);
  assert.match(changelog, /### pay\n\n- fix: a settlement posted twice is refused/);
  assert.equal(readFileSync(join(out, 'sbom.cdx.json'), 'utf8'), JSON.stringify(sbomDocument));
  assert.deepEqual(verifyRelease({ dir: out, publicKeyPem: publicPem }), []);
  const verified = run(['verify', '--locale', 'en', '--dir', out, '--public-key', PUBLIC_KEY]);
  assert.equal(verified.code, 0);
  assert.match(verified.lines.at(-1), /the release holds together/);
});

test('AC-ST-KERNEL-033-1 UAT-NFR-OPERABILITY-02: a release that was altered after it was signed does not verify: an image digest, the changelog, the SBOM, the manifest, the key', () => {
  const root = repository(MERGED);
  const fresh = (name) => {
    const out = join(scratch, name);
    assert.equal(run(cutArgs(root, out)).code, 0);
    return out;
  };
  const codes = (dir, key = publicPem) => verifyRelease({ dir, publicKeyPem: key }).map((problem) => problem.code);
  const edit = (dir, file, change) => writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));

  const digest = fresh('tamper-digest');
  edit(digest, 'manifest.json', (text) => text.replace('a'.repeat(64), 'd'.repeat(64)));
  assert.deepEqual(codes(digest), ['SIGNATURE_INVALID']);

  const version = fresh('tamper-version');
  edit(version, 'manifest.json', (text) => text.replace('"1.5.0"', '"9.9.9"'));
  assert.deepEqual(codes(version), ['SIGNATURE_INVALID']);

  const changelog = fresh('tamper-changelog');
  edit(changelog, 'CHANGELOG.md', (text) => `${text}- feat: slipped in\n`);
  assert.deepEqual(codes(changelog), ['CHANGELOG_HASH_MISMATCH']);

  const sbom = fresh('tamper-sbom');
  edit(sbom, 'sbom.cdx.json', (text) => text.replace('left-pad', 'right-pad'));
  assert.deepEqual(codes(sbom), ['SBOM_HASH_MISMATCH']);

  assert.deepEqual(codes(fresh('other-key'), otherPublicPem), ['SIGNATURE_INVALID']);

  const unsigned = fresh('unsigned');
  rmSync(join(unsigned, 'manifest.sig'));
  assert.deepEqual(codes(unsigned), ['SIGNATURE_MISSING']);

  const noSbom = fresh('no-sbom');
  rmSync(join(noSbom, 'sbom.cdx.json'));
  assert.deepEqual(codes(noSbom), ['SBOM_MISSING']);

  const noChangelog = fresh('no-changelog');
  rmSync(join(noChangelog, 'CHANGELOG.md'));
  assert.deepEqual(codes(noChangelog), ['CHANGELOG_MISSING']);

  const garbled = fresh('garbled');
  writeFileSync(join(garbled, 'manifest.sig'), '!!!\n');
  assert.deepEqual(codes(garbled), ['SIGNATURE_INVALID']);

  const noManifest = fresh('no-manifest');
  rmSync(join(noManifest, 'manifest.json'));
  assert.deepEqual(codes(noManifest), ['MANIFEST_INVALID']);
  writeFileSync(join(noManifest, 'manifest.json'), 'null');
  assert.deepEqual(codes(noManifest), ['MANIFEST_INVALID']);
  const failed = run(['verify', '--locale', 'en', '--dir', digest, '--public-key', PUBLIC_KEY]);
  assert.equal(failed.code, 1);
  assert.match(failed.lines.at(-1), /1 problem\(s\) with the release/);
});

test('a manifest that is signed but wrong in itself is refused: an unsemantic version, a short commit, no image, a digest that is not sha256, an SBOM that is not CycloneDX', () => {
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const signedWith = (overrides, document = sbomDocument) => {
    const dir = mkdtempSync(join(scratch, 'signed-'));
    const sbom = JSON.stringify(document);
    const changelog = '## 1.5.0 (2026-11-03)\n';
    writeFileSync(join(dir, 'sbom.cdx.json'), sbom);
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    const manifest = {
      version: '1.5.0',
      commit: 'f'.repeat(40),
      createdAt: NOW.toISOString(),
      images: [{ name: 'api', digest: DIGEST }],
      sbom: { file: 'sbom.cdx.json', sha256: sha(sbom) },
      changelog: { file: 'CHANGELOG.md', sha256: sha(changelog) },
      ...overrides,
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'manifest.sig'), sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString('base64'));
    return verifyRelease({ dir, publicKeyPem: publicPem }).map((problem) => problem.code);
  };
  assert.deepEqual(signedWith({}), []);
  assert.deepEqual(signedWith({ version: '1.5' }), ['VERSION_INVALID']);
  assert.deepEqual(signedWith({ commit: 'abc123' }), ['COMMIT_INVALID']);
  assert.deepEqual(signedWith({ images: [] }), ['IMAGES_EMPTY']);
  assert.deepEqual(signedWith({ images: undefined }), ['IMAGES_EMPTY']);
  assert.deepEqual(signedWith({ images: [{ name: 'api', digest: 'sha1:abc' }] }), ['IMAGE_DIGEST_INVALID']);
  assert.deepEqual(signedWith({ images: [{ name: '', digest: DIGEST }] }), ['IMAGE_DIGEST_INVALID']);
  assert.deepEqual(signedWith({ images: [{ name: 'api', digest: `sha256:${'A'.repeat(64)}` }] }), ['IMAGE_DIGEST_INVALID']);
  assert.deepEqual(signedWith({}, { bomFormat: 'SPDX' }), ['SBOM_INVALID']);
});

test('next prints the version, notes prints the changelog section, and a range with nothing to release exits 1 with no version', () => {
  const root = repository(MERGED);
  const next = run(['next', '--locale', 'en', '--root', root, '--from', 'v1.4.2', '--current', '1.4.2']);
  assert.deepEqual(next, { code: 0, lines: ['1.5.0'] });
  const notes = run(['notes', '--locale', 'en', '--root', root, '--from', 'v1.4.2', '--version', '1.5.0']);
  assert.equal(notes.code, 0);
  assert.match(notes.lines[0], /^## 1\.5\.0 \(2026-11-03\)\n\n### bid\n\n- feat: clarification requests to contractors \(ST-BID-011\)/);
  const quiet = repository(['docs(kernel): explain', 'test(web): more']);
  const nothing = run(['next', '--locale', 'en', '--root', quiet, '--from', 'v1.4.2', '--current', '1.4.2']);
  assert.equal(nothing.code, 1);
  assert.match(nothing.lines[0], /nothing to release/);
  const noCut = run(cutArgs(quiet, join(scratch, 'never')));
  assert.equal(noCut.code, 1);
  assert.match(noCut.lines[0], /nothing to release/);
});

test('cut asks git for the commit unless it is given, and fails when git cannot name it', () => {
  const root = repository(MERGED);
  const out = join(scratch, 'explicit-commit');
  assert.equal(run([...cutArgs(root, out), '--commit', 'e'.repeat(40)]).code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).commit, 'e'.repeat(40));
  assert.throws(() => run([...cutArgs(root, join(scratch, 'bad-to')), '--to', 'no-such-ref']), /RELEASE_GIT_FAILED/);
});

test('missing or unknown arguments print the usage and exit 2', () => {
  for (const argv of [['--nope'], [], ['next', '--from', 'v1'], ['cut', '--from', 'v1', '--current', '1.0.0'], ['verify', '--dir', scratch], ['notes', '--from', 'v1']]) {
    const { code, lines } = run(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(lines[0], /^(usage|cách\sdùng)/);
  }
});

test('every problem code has a message in both catalogues, and so do the other lines of the script', () => {
  for (const locale of ['vi', 'en']) {
    const messages = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'messages', `${locale}.json`), 'utf8'));
    for (const code of PROBLEM_CODES) assert.ok(messages[`release.${code}`], `${locale} ${code}`);
    for (const key of ['usage', 'nothing', 'cut', 'verify.pass', 'verify.fail']) assert.ok(messages[`release.${key}`], `${locale} ${key}`);
  }
});

test('the release workflow publishes the changelog grouped by module that this script writes', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(workflow, /node scripts\/release\.mjs notes [^\n]*--from "\$PREVIOUS"[^\n]*--version/);
  assert.match(workflow, /gh release create [^\n]*--notes-file/);
  assert.doesNotMatch(workflow, /--generate-notes/);
});
