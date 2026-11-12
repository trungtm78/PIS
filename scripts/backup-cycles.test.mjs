import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBackupPolicy, drillStatus, main, verifyBucket } from './backup-verify.mjs';

// YCK.06: the day, week and month cycles, the minimum of three backups, the archive repository, the offline copy and the restore drill ledger.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = 'infra/backup/backup-policy.json';
const LEDGER = 'infra/backup/restore-drill-ledger.json';
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

function scratch(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-cycles-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(REPO_ROOT, 'infra'), join(root, 'infra'), { recursive: true });
  mkdirSync(join(root, 'docs/runbooks/infra'), { recursive: true });
  for (const file of ['backup-immutable.md', 'restore-drill.md']) cpSync(join(REPO_ROOT, 'docs/runbooks/infra', file), join(root, 'docs/runbooks/infra', file));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/restore-drill.mjs'), 'x');
  const api = {
    root,
    json(path, change) {
      const file = join(root, path);
      const value = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify(change(value) ?? value, null, 2));
    },
    text(path, change) {
      writeFileSync(join(root, path), change(readFileSync(join(root, path), 'utf8')));
    },
  };
  edit(api);
  return api;
}

const codes = (root) => checkBackupPolicy(root).findings.map((entry) => entry.code);
const details = (root) => checkBackupPolicy(root).findings.map((entry) => entry.detail).join(' | ');

test('the real policy takes full, differential and incremental backups on a day, a week and a month cycle', () => {
  const policy = JSON.parse(readFileSync(join(REPO_ROOT, POLICY), 'utf8'));
  assert.deepEqual(Object.keys(policy.cycles), ['daily', 'weekly', 'monthly']);
  assert.deepEqual(checkBackupPolicy(REPO_ROOT).findings, []);
});

test('cycles: a missing cycle, a missing backup kind, an unknown schedule entry, a missing timer or a timer that starts the wrong unit are refused', () => {
  const noWeek = scratch((s) => s.json(POLICY, (p) => { delete p.cycles.weekly; }));
  assert.match(details(noWeek.root), /weekly cycle/);
  const noDifferential = scratch((s) => s.json(POLICY, (p) => { p.cycles.weekly = ['full']; }));
  assert.match(details(noDifferential.root), /no cycle takes a diff backup/);
  const unknown = scratch((s) => s.json(POLICY, (p) => { p.cycles.monthly = ['yearly']; }));
  assert.ok(codes(unknown.root).includes('BACKUP_CYCLES'));
  const noTimer = scratch((s) => rmSync(join(s.root, 'infra/onprem/systemd/machvon-backup-diff.timer')));
  assert.match(details(noTimer.root), /machvon-backup-diff\.timer: missing/);
  const wrongUnit = scratch((s) => s.text('infra/onprem/systemd/machvon-backup-diff.timer', (x) => x.replace('machvon-backup@diff.service', 'machvon-backup@incr.service')));
  assert.match(details(wrongUnit.root), /must start machvon-backup@diff\.service/);
  const monthlyRepo = scratch((s) => s.text('infra/onprem/systemd/machvon-backup-monthly.service', (x) => x.replace('--repo=2', '--repo=1')));
  assert.match(details(monthlyRepo.root), /repository 2/);
});

test('at least three latest backups are kept: the minimum, the differential count and both repositories', () => {
  const policyMinimum = scratch((s) => s.json(POLICY, (p) => { p.retention.minimumBackups = 2; }));
  assert.ok(codes(policyMinimum.root).includes('BACKUP_MINIMUM'));
  const countRetention = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (x) => x.replace('repo1-retention-full-type=time', 'repo1-retention-full-type=count').replace('repo1-retention-full=35', 'repo1-retention-full=2')));
  assert.match(details(countRetention.root), /repo1-retention-full keeps 2/);
  const shortDays = scratch((s) => s.json(POLICY, (p) => { p.retention.minimumBackups = 40; }));
  assert.match(details(shortDays.root), /cannot keep 40 daily/);
  const archiveCount = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (x) => x.replace('repo2-retention-full=12', 'repo2-retention-full=2')));
  assert.match(details(archiveCount.root), /repo2-retention-full keeps 2/);
  const differential = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (x) => x.replace('repo1-retention-diff=5', 'repo1-retention-diff=1')));
  assert.match(details(differential.root), /repo1-retention-diff/);
});

test('the archive repository has its own bucket, credentials, pass phrase and a COMPLIANCE lock that outlives the months kept', () => {
  const shared = scratch((s) => s.json(POLICY, (p) => { p.archive.separateBucket = false; }));
  assert.match(details(shared.root), /its own bucket/);
  const governance = scratch((s) => s.json(POLICY, (p) => { p.archive.objectLock.mode = 'GOVERNANCE'; }));
  assert.match(details(governance.root), /archive object lock/);
  const short = scratch((s) => s.json(POLICY, (p) => { p.archive.objectLock.retentionDays = 300; }));
  assert.match(details(short.root), /archive object lock/);
  const samePass = scratch((s) => s.json(POLICY, (p) => { p.archive.passphraseFile = p.encryption.clientSide.passphraseFile; }));
  assert.match(details(samePass.root), /own pass phrase/);
  const plain = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (x) => x.replace('repo2-cipher-type=aes-256-cbc', 'repo2-cipher-type=none')));
  assert.match(details(plain.root), /repo2 as an encrypted S3/);
  const samePath = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (x) => x.replace('repo2-path=/machvon-archive', 'repo2-path=/machvon')));
  assert.match(details(samePath.root), /path of its own/);
  const secret = scratch((s) => s.text('infra/onprem/compose/compose.yaml', (x) => x.split('/run/secrets/pgbackrest_archive_cipher_pass').join('/run/secrets/other')));
  assert.match(details(secret.root), /does not hand the secret pgbackrest_archive_cipher_pass/);
  const bucketVariable = scratch((s) => s.text('infra/onprem/compose/compose.yaml', (x) => x.replace('PGBACKREST_REPO2_S3_BUCKET: ${BACKUP_ARCHIVE_S3_BUCKET}', 'PGBACKREST_REPO2_S3_BUCKET: ${BACKUP_S3_BUCKET}')));
  assert.match(details(bucketVariable.root), /own bucket variable/);
  const lockFile = scratch((s) => s.json('infra/backup/bucket/archive/object-lock-configuration.json', (c) => { c.Rule.DefaultRetention.Days = 30; }));
  assert.match(details(lockFile.root), /archive\/object-lock-configuration/);
});

test('the offline copy is declared with custodians and its runbook section exists', () => {
  const absent = scratch((s) => s.json(POLICY, (p) => { p.offlineCopy.required = false; }));
  assert.ok(codes(absent.root).includes('BACKUP_OFFLINE_COPY'));
  const oneCustodian = scratch((s) => s.json(POLICY, (p) => { p.offlineCopy.custodians = 1; }));
  assert.ok(codes(oneCustodian.root).includes('BACKUP_OFFLINE_COPY'));
  const noSection = scratch((s) => s.text('docs/runbooks/infra/backup-immutable.md', (x) => x.replace('## Offline copy', '## Something else')));
  assert.match(details(noSection.root), /no section "Offline copy"/);
});

const ENTRY = {
  id: 'drill-2027-01',
  performedOn: '2027-01-20',
  release: '1.0.0',
  recoveryPoint: '2027-01-20T01:00:00Z',
  source: 'repo1',
  rpoSeconds: 40,
  rtoSeconds: 5400,
  verdict: 'matches',
  reportSha256: 'a'.repeat(64),
  sourceManifestSha256: 'b'.repeat(64),
  restoredManifestSha256: 'c'.repeat(64),
  operator: 'operator.one',
  witness: 'witness.two',
};
const withEntries = (...entries) => scratch((s) => s.json(LEDGER, (l) => { l.entries = entries; }));

test('the restore drill ledger: complete, ordered, witnessed by another person; the empty ledger of a new installation is valid', () => {
  assert.deepEqual(codes(withEntries().root), []);
  assert.deepEqual(codes(withEntries(ENTRY).root), []);
  assert.deepEqual(codes(withEntries(ENTRY, { ...ENTRY, id: 'drill-2027-04', performedOn: '2027-04-10' }).root), []);
  const broken = (change) => details(withEntries({ ...ENTRY, ...change }).root);
  assert.match(broken({ reportSha256: 'x' }), /sha256 of the report/);
  assert.match(broken({ witness: ENTRY.operator }), /must be two people/);
  assert.match(broken({ verdict: 'fine' }), /verdict must be/);
  assert.match(broken({ performedOn: 'yesterday' }), /performedOn/);
  assert.match(broken({ rtoSeconds: undefined }), /rpoSeconds and rtoSeconds/);
  assert.match(broken({ release: '' }), /restored release/);
  // A rehearsal on a laptop (a copy of a development database) is practice, not evidence: the ledger takes only a restore from a repository or from the offline media.
  assert.match(broken({ source: 'local-rehearsal' }), /source must be one of repo1, repo2, offline-media/);
  assert.match(broken({ source: undefined }), /source must be one of repo1, repo2, offline-media/);
  for (const source of ['repo2', 'offline-media']) assert.deepEqual(codes(withEntries({ ...ENTRY, source }).root), []);
  assert.match(details(withEntries(ENTRY, { ...ENTRY, performedOn: '2027-02-01' }).root), /id missing or repeated/);
  assert.match(details(withEntries(ENTRY, { ...ENTRY, id: 'other', performedOn: '2026-12-01' }).root), /not earlier/);
  const missing = scratch((s) => rmSync(join(s.root, LEDGER)));
  assert.ok(codes(missing.root).includes('BACKUP_DRILL_LEDGER'));
  const noDue = scratch((s) => s.json(LEDGER, (l) => { delete l.firstDrillDueBy; }));
  assert.ok(codes(noDue.root).includes('BACKUP_DRILL_LEDGER'));
});

test('drill-status: never drilled, current, targets missed, failed and overdue are told apart by the clock', () => {
  const at = (iso) => new Date(iso);
  assert.equal(drillStatus(REPO_ROOT, at('2026-11-09T00:00:00Z')).state, 'NEVER_DRILLED');
  assert.equal(drillStatus(REPO_ROOT, at('2027-02-02T00:00:00Z')).state, 'OVERDUE');
  assert.equal(drillStatus(withEntries(ENTRY).root, at('2027-03-01T00:00:00Z')).state, 'CURRENT');
  assert.equal(drillStatus(withEntries(ENTRY).root, at('2027-03-01T00:00:00Z')).daysSince, 40);
  assert.equal(drillStatus(withEntries(ENTRY).root, at('2027-04-23T00:00:00Z')).state, 'OVERDUE');
  assert.equal(drillStatus(withEntries({ ...ENTRY, verdict: 'targets-missed' }).root, at('2027-02-01T00:00:00Z')).state, 'TARGETS_MISSED');
  assert.equal(drillStatus(withEntries({ ...ENTRY, verdict: 'does-not-match' }).root, at('2027-02-01T00:00:00Z')).state, 'FAILED');
  assert.equal(drillStatus(scratch((s) => rmSync(join(s.root, LEDGER))).root).state, 'OVERDUE');
  const lines = [];
  assert.equal(main(['drill-status', '--locale', 'en'], { log: (line) => lines.push(line), now: () => new Date('2026-11-09T00:00:00Z') }), 0);
  assert.match(lines[0], /NEVER_DRILLED/);
  assert.equal(main(['drill-status', '--locale', 'en'], { log: (line) => lines.push(line), now: () => new Date('2027-06-01T00:00:00Z') }), 1);
  assert.ok(lines.some((line) => /overdue or failed/.test(line)));
});

function fakeAws(answers) {
  return (command, args) => {
    const answer = answers[args[1]];
    return answer === undefined ? { status: 255, stdout: '', stderr: 'AccessDenied' } : { status: 0, stdout: JSON.stringify(answer), stderr: '' };
  };
}
const operationalAnswers = () => ({
  'get-object-lock-configuration': { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 36 } } } },
  'get-bucket-versioning': { Status: 'Enabled' },
  'get-bucket-encryption': { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } },
});
const archiveAnswers = () => ({ ...operationalAnswers(), 'get-object-lock-configuration': { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 400 } } } } });

test('live: the archive bucket is judged against the archive lock of the policy, with its own check names', () => {
  const policy = JSON.parse(readFileSync(join(REPO_ROOT, POLICY), 'utf8'));
  const archive = (answers) => verifyBucket({ policy, bucket: 'machvon-archive', endpoint: 'https://s3.example.vn', run: fakeAws(answers), lock: policy.archive.objectLock, label: 'archive:' });
  assert.deepEqual(archive(archiveAnswers()).findings, []);
  assert.deepEqual(archive(archiveAnswers()).checks.map((check) => check.name), ['archive:object-lock', 'archive:versioning', 'archive:encryption']);
  assert.deepEqual(archive(operationalAnswers()).findings.map((entry) => entry.code), ['BACKUP_LIVE_LOCK']);
  const lines = [];
  const both = (command, args) => (args.includes('machvon-archive') ? fakeAws(archiveAnswers())(command, args) : fakeAws(operationalAnswers())(command, args));
  assert.equal(main(['live', '--root', REPO_ROOT, '--bucket', 'machvon-backup', '--endpoint', 'https://s3.example.vn', '--archive-bucket', 'machvon-archive', '--locale', 'en'], { log: (line) => lines.push(line), run: both }), 0);
  assert.ok(lines.some((line) => line.includes('archive:object-lock: ok')));
  assert.equal(main(['live', '--root', REPO_ROOT, '--bucket', 'machvon-backup', '--endpoint', 'https://s3.example.vn', '--archive-bucket', 'machvon-archive', '--locale', 'en'], { log: () => {}, run: fakeAws(operationalAnswers()) }), 1);
});
