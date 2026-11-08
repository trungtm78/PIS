import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDING_CODES, checkBackupPolicy, main, parsePgbackrestConf, verifyBucket } from './backup-verify.mjs';
import { loadOnpremMessages } from './onprem-messages.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanups = [];
process.on('exit', () => cleanups.forEach((clean) => clean()));

/** A scratch repository: the real infra/, the files the drill points at, and the edits of one case. */
function scratch(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'machvon-backup-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(REPO_ROOT, 'infra'), join(root, 'infra'), { recursive: true });
  for (const file of ['docs/runbooks/infra/restore-drill.md', 'scripts/restore-drill.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'x');
  }
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
const POLICY = 'infra/backup/backup-policy.json';

test('the real backup policy holds: schedule, timers, immutability, encryption, retention, targets, second site and drill', () => {
  assert.deepEqual(checkBackupPolicy(REPO_ROOT).findings, []);
});

test('an object lock that is off, in GOVERNANCE mode, or shorter than the recovery window is refused', () => {
  const off = scratch((s) => s.json(POLICY, (p) => { p.immutability.objectLock.enabled = false; }));
  assert.ok(codes(off.root).includes('BACKUP_IMMUTABLE'));
  const governance = scratch((s) => s.json(POLICY, (p) => { p.immutability.objectLock.mode = 'GOVERNANCE'; }));
  assert.match(details(governance.root), /COMPLIANCE/);
  const short = scratch((s) => s.json(POLICY, (p) => { p.immutability.objectLock.retentionDays = 35; }));
  assert.match(details(short.root), /outlive the recovery window/);
  const noVersioning = scratch((s) => s.json(POLICY, (p) => { p.immutability.versioning = false; }));
  assert.match(details(noVersioning.root), /versioning/);
  const sameIdentity = scratch((s) => s.json(POLICY, (p) => { p.immutability.adminAndWriterAreDifferentPeople = false; }));
  assert.match(details(sameIdentity.root), /different identities/);
});

test('the bucket setting files must say what the policy says', () => {
  const lock = scratch((s) => s.json('infra/backup/bucket/object-lock-configuration.json', (c) => { c.Rule.DefaultRetention.Days = 7; }));
  assert.match(details(lock.root), /object-lock-configuration/);
  const versioning = scratch((s) => s.json('infra/backup/bucket/versioning.json', (c) => { c.Status = 'Suspended'; }));
  assert.match(details(versioning.root), /versioning\.json/);
  const encryption = scratch((s) => s.json('infra/backup/bucket/encryption.json', (c) => { c.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm = 'none'; }));
  assert.match(details(encryption.root), /encryption\.json/);
});

test('the writer policy must deny every action that weakens the lock and allow no delete, retention or bucket change', () => {
  const missing = scratch((s) => s.json('infra/backup/bucket/writer-policy.json', (c) => { c.Statement[2].Action = c.Statement[2].Action.filter((action) => action !== 's3:DeleteObjectVersion'); }));
  assert.match(details(missing.root), /does not deny s3:DeleteObjectVersion/);
  const allowsDelete = scratch((s) => s.json('infra/backup/bucket/writer-policy.json', (c) => { c.Statement[0].Action.push('s3:DeleteObject'); }));
  assert.match(details(allowsDelete.root), /allows s3:DeleteObject/);
  const star = scratch((s) => s.json('infra/backup/bucket/writer-policy.json', (c) => { c.Statement[0].Action = ['s3:*']; }));
  assert.match(details(star.root), /allows s3:\*/);
  const policyGap = scratch((s) => s.json(POLICY, (p) => { p.immutability.writerCannot = ['s3:DeleteObjectVersion']; }));
  assert.ok(codes(policyGap.root).includes('BACKUP_IMMUTABLE'));
});

test('encryption: client-side AES-256 in the policy and in pgbackrest.conf, the pass phrase as a secret of the compose file, TLS to the store, no secret option in the configuration', () => {
  const cipher = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (t) => t.replace('repo1-cipher-type=aes-256-cbc', 'repo1-cipher-type=none')));
  assert.ok(codes(cipher.root).includes('BACKUP_ENCRYPTION'));
  const secretMissing = scratch((s) => s.text('infra/onprem/compose/compose.yaml', (t) => t.split('/run/secrets/pgbackrest_cipher_pass').join('/run/secrets/other')));
  assert.match(details(secretMissing.root), /does not hand the secret pgbackrest_cipher_pass/);
  const transport = scratch((s) => s.json(POLICY, (p) => { p.encryption.transport = 'plain'; }));
  assert.match(details(transport.root), /TLS 1\.2/);
  const leaked = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (t) => `${t}\nrepo1-cipher-pass=do-not-write-this\n`));
  assert.ok(codes(leaked.root).includes('BACKUP_CONFIG_SECRET'));
  const keyed = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (t) => `${t}\nrepo1-s3-key-secret=x\n`));
  assert.ok(codes(keyed.root).includes('BACKUP_CONFIG_SECRET'));
});

test('schedule: the timers run when the policy says, the WAL archive is continuous within the RPO and matches archive_timeout', () => {
  const timer = scratch((s) => s.text('infra/onprem/systemd/machvon-backup-full.timer', (t) => t.replace('01:30:00', '03:00:00')));
  assert.match(details(timer.root), /machvon-backup-full\.timer/);
  const noTimer = scratch((s) => rmSync(join(s.root, 'infra/onprem/systemd/machvon-backup-incr.timer')));
  assert.match(details(noTimer.root), /machvon-backup-incr\.timer: missing/);
  const noIncremental = scratch((s) => s.json(POLICY, (p) => { delete p.schedule.incremental; }));
  assert.ok(codes(noIncremental.root).includes('BACKUP_SCHEDULE_INCOMPLETE'));
  const slowWal = scratch((s) => s.json(POLICY, (p) => { p.schedule.wal.archiveTimeoutSeconds = 600; }));
  assert.ok(codes(slowWal.root).includes('BACKUP_SCHEDULE_INCOMPLETE'));
  const notContinuous = scratch((s) => s.json(POLICY, (p) => { p.schedule.wal.mode = 'nightly'; }));
  assert.ok(codes(notContinuous.root).includes('BACKUP_SCHEDULE_INCOMPLETE'));
  const mismatch = scratch((s) => s.text('infra/postgres/postgresql.conf.tpl', (t) => t.replace('archive_timeout = 60s', 'archive_timeout = 30s')));
  assert.ok(codes(mismatch.root).includes('BACKUP_SCHEDULE_INCOMPLETE'));
});

test('retention, targets, second site and drill: too short, above the limit, different from the PostgreSQL declaration, or not required', () => {
  const retention = scratch((s) => s.json(POLICY, (p) => { p.retention.fullDays = 7; }));
  assert.ok(codes(retention.root).includes('BACKUP_RETENTION'));
  const conf = scratch((s) => s.text('infra/onprem/config/pgbackrest.conf', (t) => t.replace('repo1-retention-full=35', 'repo1-retention-full=10')));
  assert.match(details(conf.root), /pgbackrest\.conf retention/);
  const rpo = scratch((s) => s.json(POLICY, (p) => { p.targets.rpoMinutes = 60; }));
  assert.ok(codes(rpo.root).includes('BACKUP_TARGETS'));
  const declared = scratch((s) => s.json('infra/postgres/backup.json', (b) => { b.rtoHours = 3; }));
  assert.match(details(declared.root), /backup\.json differs/);
  const site = scratch((s) => s.json(POLICY, (p) => { p.secondSite.required = false; }));
  assert.ok(codes(site.root).includes('BACKUP_SECOND_SITE'));
  const yearly = scratch((s) => s.json(POLICY, (p) => { p.restoreDrill.frequency = 'yearly'; }));
  assert.ok(codes(yearly.root).includes('BACKUP_DRILL'));
  const noChecksum = scratch((s) => s.json(POLICY, (p) => { p.restoreDrill.verify = ['row-counts']; }));
  assert.ok(codes(noChecksum.root).includes('BACKUP_DRILL'));
  const noRunbook = scratch((s) => rmSync(join(s.root, 'docs/runbooks/infra/restore-drill.md')));
  assert.ok(codes(noRunbook.root).includes('BACKUP_DRILL'));
});

test('a missing or malformed policy is one finding', () => {
  const none = scratch((s) => rmSync(join(s.root, POLICY)));
  assert.deepEqual(codes(none.root), ['BACKUP_POLICY_INVALID']);
  const broken = scratch((s) => writeFileSync(join(s.root, POLICY), '{"schedule": 3}'));
  assert.deepEqual(codes(broken.root), ['BACKUP_POLICY_INVALID']);
});

test('the pgBackRest configuration is read by section and option', () => {
  const parsed = parsePgbackrestConf('# comment\n[global]\nrepo1-type=s3\n\n[machvon]\npg1-path = /data\n');
  assert.equal(parsed.get('global.repo1-type'), 's3');
  assert.equal(parsed.get('machvon.pg1-path'), '/data');
});

/** The fake of the AWS CLI: answers by action; an action not in the table fails. */
function fakeAws(answers, calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    const action = args[1];
    const answer = answers[action];
    if (answer === undefined) return { status: 255, stdout: '', stderr: 'An error occurred (AccessDenied)\nlast line' };
    return typeof answer === 'function' ? answer(args) : { status: 0, stdout: JSON.stringify(answer), stderr: '' };
  };
}

const goodAnswers = () => ({
  'get-object-lock-configuration': { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 36 } } } },
  'get-bucket-versioning': { Status: 'Enabled' },
  'get-bucket-encryption': { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } },
});
const policy = () => JSON.parse(readFileSync(join(REPO_ROOT, POLICY), 'utf8'));
const live = (answers, extra = {}) => verifyBucket({ policy: policy(), bucket: 'machvon-backup', endpoint: 'https://s3.example.vn', region: 'vn-sgn-1', run: fakeAws(answers), now: () => new Date('2026-11-08T00:00:00Z'), ...extra });

test('live: a bucket with the lock, versioning and encryption of the policy passes', () => {
  const result = live(goodAnswers());
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [['object-lock', true], ['versioning', true], ['encryption', true]]);
});

test('live: a lock that is missing, weaker, shorter or counted in years is judged, and the commands carry the endpoint and region', () => {
  const calls = [];
  const none = live({ ...goodAnswers(), 'get-object-lock-configuration': { status: 1 } }, { run: fakeAws({ ...goodAnswers(), 'get-object-lock-configuration': undefined }, calls) });
  assert.deepEqual(none.findings.map((entry) => entry.code), ['BACKUP_LIVE_COMMAND']);
  assert.ok(calls.every((call) => call.includes('https://s3.example.vn') && call.includes('vn-sgn-1') && call.includes('--bucket')));
  const governance = live({ ...goodAnswers(), 'get-object-lock-configuration': { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 36 } } } } });
  assert.deepEqual(governance.findings.map((entry) => entry.code), ['BACKUP_LIVE_LOCK']);
  const short = live({ ...goodAnswers(), 'get-object-lock-configuration': { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 10 } } } } });
  assert.deepEqual(short.findings.map((entry) => entry.code), ['BACKUP_LIVE_LOCK']);
  const years = live({ ...goodAnswers(), 'get-object-lock-configuration': { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Years: 1 } } } } });
  assert.deepEqual(years.findings, []);
  const disabled = live({ ...goodAnswers(), 'get-object-lock-configuration': { ObjectLockConfiguration: { ObjectLockEnabled: 'Disabled' } } });
  assert.deepEqual(disabled.findings.map((entry) => entry.code), ['BACKUP_LIVE_LOCK']);
});

test('live: versioning that is off and encryption that is missing or different are findings', () => {
  const versioning = live({ ...goodAnswers(), 'get-bucket-versioning': { Status: 'Suspended' } });
  assert.deepEqual(versioning.findings.map((entry) => entry.code), ['BACKUP_LIVE_VERSIONING']);
  const encryption = live({ ...goodAnswers(), 'get-bucket-encryption': undefined });
  assert.deepEqual(encryption.findings.map((entry) => entry.code), ['BACKUP_LIVE_ENCRYPTION']);
  const other = live({ ...goodAnswers(), 'get-bucket-encryption': { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }] } } });
  assert.match(other.findings[0].detail, /aws:kms instead of AES256/);
});

test('live probe: a locked version that cannot be deleted or shortened passes; one that can is a finding; no version id is a finding', () => {
  const probe = (change) => live({ ...goodAnswers(), 'put-object': { VersionId: 'v1' }, ...change }, { probe: true });
  const refused = probe({});
  assert.deepEqual(refused.findings, []);
  assert.deepEqual(refused.checks.find((check) => check.name === 'probe'), { name: 'probe', ok: true, detail: 'delete and shortening refused' });
  const deletable = probe({ 'delete-object': { DeleteMarker: false } });
  assert.deepEqual(deletable.findings.map((entry) => entry.code), ['BACKUP_LIVE_PROBE']);
  assert.match(deletable.findings[0].detail, /delete SUCCEEDED, shortening refused/);
  const shortenable = probe({ 'put-object-retention': {} });
  assert.match(shortenable.findings[0].detail, /shortening SUCCEEDED/);
  const unversioned = probe({ 'put-object': { ETag: 'x' } });
  assert.match(unversioned.findings[0].detail, /no version id/);
  const calls = [];
  live({ ...goodAnswers(), 'put-object': { VersionId: 'v1' } }, { probe: true, run: fakeAws({ ...goodAnswers(), 'put-object': { VersionId: 'v1' } }, calls) });
  const put = calls.find((call) => call[2] === 'put-object' || call.includes('put-object'));
  assert.ok(put.some((arg) => arg.startsWith('_immutability-probe/2026-11-08T00-00-00-000Z')));
});

test('main: offline passes on the real policy, writes an evidence file, and live needs a bucket and an endpoint', () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const evidence = join(mkdtempSync(join(tmpdir(), 'machvon-evidence-')), 'evidence', 'offline.json');
  cleanups.push(() => rmSync(dirname(dirname(evidence)), { recursive: true, force: true }));
  assert.equal(main(['--locale', 'en', '--evidence', evidence], { log, now: () => new Date('2026-11-08T00:00:00Z') }), 0);
  const written = JSON.parse(readFileSync(evidence, 'utf8'));
  assert.equal(written.passed, true);
  assert.match(written.policySha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(evidence));
  assert.equal(main(['live', '--locale', 'en'], { log }), 2);
  assert.equal(main(['nonsense'], { log }), 2);
  assert.equal(main(['--no-such-flag'], { log }), 2);
  const bad = scratch((s) => s.json(POLICY, (p) => { p.immutability.objectLock.enabled = false; }));
  assert.equal(main(['--root', bad.root, '--locale', 'en'], { log }), 1);
  assert.equal(main(['live', '--root', REPO_ROOT, '--bucket', 'b', '--endpoint', 'https://s3.example.vn', '--locale', 'en'], { log, run: fakeAws(goodAnswers()) }), 0);
  assert.equal(main(['live', '--root', REPO_ROOT, '--bucket', 'b', '--endpoint', 'https://s3.example.vn', '--locale', 'en'], { log, run: fakeAws({ ...goodAnswers(), 'get-bucket-versioning': { Status: 'Suspended' } }) }), 1);
  assert.ok(lines.some((line) => line.includes('object-lock: ok')));
});

test('every finding code has a message in both languages', () => {
  for (const locale of ['vi', 'en']) {
    const messages = loadOnpremMessages(locale);
    for (const code of FINDING_CODES) assert.ok(messages[`backupVerify.code.${code}`], `${locale}: ${code}`);
  }
  assert.deepEqual(Object.keys(loadOnpremMessages('vi')).sort(), Object.keys(loadOnpremMessages('en')).sort());
});
