import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_LOCALE, format, loadOnpremMessages } from './onprem-messages.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const POLICY_FILE = 'infra/backup/backup-policy.json';
const SERVER_SIDE_ALGORITHMS = new Set(['AES256', 'aws:kms']);
const REQUIRED_WRITER_DENIALS = ['s3:BypassGovernanceRetention', 's3:PutBucketObjectLockConfiguration', 's3:DeleteObjectVersion'];
const REQUIRED_DRILL_CHECKS = ['checksum', 'row-counts'];
const SECRET_OPTION = /^\s*[a-z0-9-]*(?:cipher-pass|s3-key|s3-key-secret|s3-token)\s*=/im;

export const FINDING_CODES = [
  'BACKUP_POLICY_INVALID',
  'BACKUP_SCHEDULE_INCOMPLETE',
  'BACKUP_SCHEDULE_UNITS',
  'BACKUP_IMMUTABLE',
  'BACKUP_BUCKET_CONFIG',
  'BACKUP_WRITER_POLICY',
  'BACKUP_ENCRYPTION',
  'BACKUP_RETENTION',
  'BACKUP_TARGETS',
  'BACKUP_SECOND_SITE',
  'BACKUP_DRILL',
  'BACKUP_CONFIG_SECRET',
  'BACKUP_LIVE_COMMAND',
  'BACKUP_LIVE_LOCK',
  'BACKUP_LIVE_VERSIONING',
  'BACKUP_LIVE_ENCRYPTION',
  'BACKUP_LIVE_PROBE',
];

const finding = (code, detail = '') => ({ code, detail });

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** The `[global]` options of a pgBackRest configuration file, and the value of every key of every section. */
export function parsePgbackrestConf(text) {
  const options = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header !== null) section = header[1];
    else {
      const pair = /^([a-z0-9-]+)\s*=\s*(.*)$/.exec(trimmed);
      if (pair !== null) options.set(`${section}.${pair[1]}`, pair[2]);
    }
  }
  return options;
}

const calendarOf = (text) => /^OnCalendar=(.+)$/m.exec(text ?? '')?.[1]?.trim();

/**
 * The offline check of the backup policy and of every file that implements it: the schedule (and the systemd timers that run it), immutability (object lock in COMPLIANCE mode with
 * a retention that outlives the recovery window, versioning, a writer that cannot weaken it), encryption, retention, the RPO and RTO targets against the operations policy and the
 * PostgreSQL declaration, the second site and the restore drill. Needs no network and no credentials.
 */
export function checkBackupPolicy(root) {
  const findings = [];
  const policy = readJson(join(root, POLICY_FILE));
  const operations = readJson(join(root, 'infra', 'policies', 'operations.json'));
  if (policy === undefined || operations === undefined || typeof policy.schedule !== 'object' || policy.schedule === null) return { findings: [finding('BACKUP_POLICY_INVALID', POLICY_FILE)], policy: undefined };
  const limits = operations.postgres;

  const { full, incremental, wal, verify } = policy.schedule;
  const timers = { full: 'machvon-backup-full.timer', incremental: 'machvon-backup-incr.timer', verify: 'machvon-backup-verify.timer' };
  for (const [name, entry] of Object.entries({ full, incremental, verify })) {
    if (typeof entry?.onCalendar !== 'string' || entry.onCalendar === '') findings.push(finding('BACKUP_SCHEDULE_INCOMPLETE', name));
    else {
      const unit = calendarOf(readText(join(root, 'infra', 'onprem', 'systemd', timers[name])));
      if (unit !== entry.onCalendar) findings.push(finding('BACKUP_SCHEDULE_UNITS', `${timers[name]}: ${unit ?? 'missing'} instead of ${entry.onCalendar}`));
    }
  }
  const conf = readText(join(root, 'infra', 'postgres', 'postgresql.conf.tpl')) ?? '';
  const archiveTimeout = /^\s*archive_timeout\s*=\s*'?(\d+)s?'?/m.exec(conf)?.[1];
  if (wal?.mode !== 'continuous' || !(wal.archiveTimeoutSeconds > 0 && wal.archiveTimeoutSeconds <= limits.maxArchiveTimeoutSeconds) || (archiveTimeout !== undefined && Number(archiveTimeout) !== wal.archiveTimeoutSeconds)) {
    findings.push(finding('BACKUP_SCHEDULE_INCOMPLETE', 'wal'));
  }

  const lock = policy.immutability?.objectLock;
  const retentionDays = policy.retention?.pitrDays;
  if (lock?.enabled !== true || lock.mode !== 'COMPLIANCE') findings.push(finding('BACKUP_IMMUTABLE', 'object lock must be enabled in COMPLIANCE mode'));
  if (!(Number.isInteger(lock?.retentionDays) && Number.isInteger(retentionDays) && lock.retentionDays >= retentionDays + 1)) findings.push(finding('BACKUP_IMMUTABLE', `the lock must outlive the recovery window (${retentionDays} days + 1)`));
  if (policy.immutability?.versioning !== true) findings.push(finding('BACKUP_IMMUTABLE', 'versioning must be enabled'));
  if (policy.immutability?.adminAndWriterAreDifferentPeople !== true) findings.push(finding('BACKUP_IMMUTABLE', 'the bucket administrator and the backup writer must be different identities'));
  const writerDenied = policy.immutability?.writerCannot ?? [];
  for (const action of REQUIRED_WRITER_DENIALS) if (!writerDenied.includes(action)) findings.push(finding('BACKUP_IMMUTABLE', `the writer must be unable to ${action}`));

  const bucket = join(root, 'infra', 'backup', 'bucket');
  const lockFile = readJson(join(bucket, 'object-lock-configuration.json'));
  const rule = lockFile?.Rule?.DefaultRetention;
  if (lockFile?.ObjectLockEnabled !== 'Enabled' || rule?.Mode !== lock?.mode || rule?.Days !== lock?.retentionDays) findings.push(finding('BACKUP_BUCKET_CONFIG', 'object-lock-configuration.json differs from the policy'));
  if (readJson(join(bucket, 'versioning.json'))?.Status !== 'Enabled') findings.push(finding('BACKUP_BUCKET_CONFIG', 'versioning.json must say Enabled'));
  const encryptionRule = readJson(join(bucket, 'encryption.json'))?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
  if (encryptionRule !== policy.encryption?.serverSide?.algorithm || !SERVER_SIDE_ALGORITHMS.has(encryptionRule)) findings.push(finding('BACKUP_BUCKET_CONFIG', 'encryption.json differs from the policy'));
  const writer = readJson(join(bucket, 'writer-policy.json'));
  const denied = new Set((writer?.Statement ?? []).filter((statement) => statement.Effect === 'Deny').flatMap((statement) => statement.Action ?? []));
  for (const action of writerDenied) if (!denied.has(action)) findings.push(finding('BACKUP_WRITER_POLICY', `writer-policy.json does not deny ${action}`));
  const allowed = (writer?.Statement ?? []).filter((statement) => statement.Effect === 'Allow').flatMap((statement) => statement.Action ?? []);
  for (const action of allowed) if (denied.has(action) || action === 's3:*' || /^s3:Delete/.test(action) || /^s3:Put(?:Bucket|ObjectRetention|ObjectLegalHold)/.test(action)) findings.push(finding('BACKUP_WRITER_POLICY', `writer-policy.json allows ${action}`));

  const confText = readText(join(root, 'infra', 'onprem', 'config', 'pgbackrest.conf'));
  const conf2 = confText === undefined ? new Map() : parsePgbackrestConf(confText);
  const cipher = policy.encryption?.clientSide;
  if (!/^aes-256-/.test(String(cipher?.cipher)) || conf2.get('global.repo1-cipher-type') !== cipher?.cipher || typeof cipher?.passphraseSecret !== 'string') findings.push(finding('BACKUP_ENCRYPTION', 'client-side AES-256 encryption must be configured in the policy and in pgbackrest.conf'));
  else {
    const compose = readText(join(root, 'infra', 'onprem', 'compose', 'compose.yaml')) ?? '';
    if (!compose.includes(`/run/secrets/${cipher.passphraseSecret}`)) findings.push(finding('BACKUP_ENCRYPTION', `compose.yaml does not hand the secret ${cipher.passphraseSecret} to the database and backup services`));
  }
  if (!/TLS 1\.[23]/.test(String(policy.encryption?.transport))) findings.push(finding('BACKUP_ENCRYPTION', 'the transport to the object store must be TLS 1.2 or newer'));
  if (confText !== undefined && SECRET_OPTION.test(confText)) findings.push(finding('BACKUP_CONFIG_SECRET', 'pgbackrest.conf carries a secret option; use the PGBACKREST_REPO1_* environment through secret files'));

  const pitr = limits.pitrRetentionDays;
  if (!(policy.retention?.fullDays >= pitr && policy.retention?.pitrDays >= pitr && policy.retention?.archiveDays >= pitr)) findings.push(finding('BACKUP_RETENTION', `retention must be at least ${pitr} days`));
  if (conf2.size > 0 && (Number(conf2.get('global.repo1-retention-full')) !== policy.retention?.fullDays || Number(conf2.get('global.repo1-retention-archive')) !== policy.retention?.archiveDays)) findings.push(finding('BACKUP_RETENTION', 'pgbackrest.conf retention differs from the policy'));

  const declared = readJson(join(root, 'infra', 'postgres', 'backup.json'));
  const { rpoMinutes, rtoHours } = policy.targets ?? {};
  if (!(rpoMinutes <= limits.maxRpoMinutes) || !(rtoHours <= limits.maxRtoHours)) findings.push(finding('BACKUP_TARGETS', `rpoMinutes ${rpoMinutes}, rtoHours ${rtoHours}`));
  if (declared !== undefined && (declared.rpoMinutes !== rpoMinutes || declared.rtoHours !== rtoHours || declared.pitrRetentionDays !== policy.retention?.pitrDays)) findings.push(finding('BACKUP_TARGETS', 'infra/postgres/backup.json differs from the policy'));

  if (policy.secondSite?.required !== true) findings.push(finding('BACKUP_SECOND_SITE', 'the backups must be written to a second site'));
  const drill = policy.restoreDrill;
  const missingChecks = REQUIRED_DRILL_CHECKS.filter((check) => !(drill?.verify ?? []).includes(check));
  if (drill?.frequency !== 'quarterly' || !(drill.maxDaysBetweenDrills <= 92) || missingChecks.length > 0 || !existsSync(join(root, String(drill?.runbook))) || !existsSync(join(root, String(drill?.script)))) {
    findings.push(finding('BACKUP_DRILL', `a quarterly drill with a script, a runbook and the checks ${REQUIRED_DRILL_CHECKS.join(', ')} is required`));
  }
  return { findings, policy };
}

const defaultRun = (command, args) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 24 });

const parse = (result) => {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
};

/**
 * Checks the bucket itself through the AWS CLI (credentials and endpoint come from the CLI's own configuration): object lock enabled in the mode and for the number of days of the policy, versioning
 * on, default encryption on. With `probe`, writes one tiny object, then tries to delete its version and to shorten its retention: both must be refused (the object stays until its retention ends).
 * `run` is injected, so the tests need neither a network nor the CLI.
 */
export function verifyBucket({ policy, bucket, endpoint, region, probe = false, run = defaultRun, now = () => new Date() }) {
  const findings = [];
  const checks = [];
  const base = ['s3api', '--endpoint-url', endpoint, ...(region === undefined ? [] : ['--region', region]), '--output', 'json'];
  const call = (action, extra) => run('aws', [base[0], action, ...base.slice(1), '--bucket', bucket, ...extra]);
  const record = (name, ok, detail = '') => checks.push({ name, ok, detail });

  const lock = call('get-object-lock-configuration', []);
  if (lock.status !== 0) {
    findings.push(finding('BACKUP_LIVE_COMMAND', `get-object-lock-configuration: ${String(lock.stderr ?? '').trim().split('\n').pop() ?? ''}`));
    record('object-lock', false, 'command failed');
  } else {
    const configuration = parse(lock)?.ObjectLockConfiguration;
    const rule = configuration?.Rule?.DefaultRetention;
    const days = rule?.Days ?? (rule?.Years === undefined ? undefined : rule.Years * 365);
    const ok = configuration?.ObjectLockEnabled === 'Enabled' && rule?.Mode === policy.immutability.objectLock.mode && days >= policy.immutability.objectLock.retentionDays;
    record('object-lock', ok, `${rule?.Mode ?? 'none'} ${days ?? 0} days`);
    if (!ok) findings.push(finding('BACKUP_LIVE_LOCK', `${rule?.Mode ?? 'no default retention'} ${days ?? 0} days; the policy needs ${policy.immutability.objectLock.mode} ${policy.immutability.objectLock.retentionDays} days`));
  }
  const versioning = call('get-bucket-versioning', []);
  const versioningOk = versioning.status === 0 && parse(versioning)?.Status === 'Enabled';
  record('versioning', versioningOk);
  if (!versioningOk) findings.push(finding('BACKUP_LIVE_VERSIONING', bucket));
  const encryption = call('get-bucket-encryption', []);
  const algorithm = encryption.status === 0 ? parse(encryption)?.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm : undefined;
  record('encryption', algorithm === policy.encryption.serverSide.algorithm, String(algorithm));
  if (algorithm !== policy.encryption.serverSide.algorithm) findings.push(finding('BACKUP_LIVE_ENCRYPTION', `${algorithm ?? 'none'} instead of ${policy.encryption.serverSide.algorithm}`));

  if (probe) {
    const directory = mkdtempSync(join(tmpdir(), 'machvon-lock-probe-'));
    try {
      const body = join(directory, 'probe.txt');
      writeFileSync(body, 'immutability probe\n');
      const key = `_immutability-probe/${now().toISOString().replace(/[:.]/g, '-')}`;
      const put = call('put-object', ['--key', key, '--body', body]);
      const versionId = put.status === 0 ? parse(put)?.VersionId : undefined;
      if (versionId === undefined) {
        findings.push(finding('BACKUP_LIVE_PROBE', 'the probe object could not be written (no version id: is versioning on?)'));
        record('probe', false, 'write failed');
      } else {
        const removed = call('delete-object', ['--key', key, '--version-id', versionId]);
        const shortened = call('put-object-retention', ['--key', key, '--version-id', versionId, '--retention', `Mode=COMPLIANCE,RetainUntilDate=${now().toISOString()}`]);
        const refused = removed.status !== 0 && shortened.status !== 0;
        record('probe', refused, refused ? 'delete and shortening refused' : 'a locked version could be changed');
        if (!refused) findings.push(finding('BACKUP_LIVE_PROBE', `delete ${removed.status === 0 ? 'SUCCEEDED' : 'refused'}, shortening ${shortened.status === 0 ? 'SUCCEEDED' : 'refused'}`));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return { findings, checks };
}

export function main(argv, { log = console.log, run = defaultRun, now = () => new Date() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { root: { type: 'string', default: REPO_ROOT }, bucket: { type: 'string' }, endpoint: { type: 'string' }, region: { type: 'string' }, probe: { type: 'boolean', default: false }, evidence: { type: 'string' }, locale: { type: 'string', default: DEFAULT_LOCALE } },
    });
  } catch {
    log(loadOnpremMessages(DEFAULT_LOCALE)['backupVerify.usage']);
    return 2;
  }
  const { values, positionals } = parsed;
  const messages = loadOnpremMessages(values.locale);
  const root = resolve(values.root);
  const mode = positionals[0] ?? 'offline';
  if (mode !== 'offline' && mode !== 'live') {
    log(messages['backupVerify.usage']);
    return 2;
  }
  const offline = checkBackupPolicy(root);
  let findings = [...offline.findings];
  let checks = [];
  if (mode === 'live') {
    if (values.bucket === undefined || values.endpoint === undefined) {
      log(messages['backupVerify.usage']);
      return 2;
    }
    if (offline.policy !== undefined) {
      const live = verifyBucket({ policy: offline.policy, bucket: values.bucket, endpoint: values.endpoint, region: values.region, probe: values.probe, run, now });
      findings = [...findings, ...live.findings];
      checks = live.checks;
    }
  }
  for (const entry of findings) log(format(messages[`backupVerify.code.${entry.code}`], { detail: entry.detail }));
  for (const check of checks) log(format(messages['backupVerify.check'], { name: check.name, state: check.ok ? 'ok' : 'FAILED', detail: check.detail }));
  if (values.evidence !== undefined) {
    const policyText = readText(join(root, POLICY_FILE)) ?? '';
    mkdirSync(dirname(resolve(values.evidence)), { recursive: true });
    writeFileSync(resolve(values.evidence), `${JSON.stringify({ mode, at: now().toISOString(), policySha256: createHash('sha256').update(policyText).digest('hex'), passed: findings.length === 0, checks, findings }, null, 2)}\n`);
  }
  log(findings.length === 0 ? messages[`backupVerify.summary.pass.${mode}`] : format(messages['backupVerify.summary.fail'], { count: findings.length }));
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
