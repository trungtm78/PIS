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
  'BACKUP_CYCLES',
  'BACKUP_MINIMUM',
  'BACKUP_ARCHIVE',
  'BACKUP_OFFLINE_COPY',
  'BACKUP_DRILL_LEDGER',
  'BACKUP_DRILL_OVERDUE',
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

const TIMERS = { full: 'machvon-backup-full.timer', incremental: 'machvon-backup-incr.timer', differential: 'machvon-backup-diff.timer', monthly: 'machvon-backup-monthly.timer', verify: 'machvon-backup-verify.timer' };
/** The kind of backup each schedule entry takes (pgBackRest --type), and the cycles and kinds the policy must cover. */
const SCHEDULE_TYPE = { full: 'full', incremental: 'incr', differential: 'diff', monthly: 'full' };
const REQUIRED_CYCLES = ['daily', 'weekly', 'monthly'];
const REQUIRED_TYPES = ['full', 'diff', 'incr'];
const DRILL_VERDICTS = ['matches', 'targets-missed', 'does-not-match'];
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const calendarOf =(text) => /^OnCalendar=(.+)$/m.exec(text ?? '')?.[1]?.trim();

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

  const { wal } = policy.schedule;
  const systemd = join(root, 'infra', 'onprem', 'systemd');
  for (const [name, timer] of Object.entries(TIMERS)) {
    const entry = policy.schedule[name];
    if (typeof entry?.onCalendar !== 'string' || entry.onCalendar === '') findings.push(finding('BACKUP_SCHEDULE_INCOMPLETE', name));
    else {
      const unit = calendarOf(readText(join(systemd, timer)));
      if (unit !== entry.onCalendar) findings.push(finding('BACKUP_SCHEDULE_UNITS', `${timer}: ${unit ?? 'missing'} instead of ${entry.onCalendar}`));
    }
  }
  const differentialTimer = readText(join(systemd, TIMERS.differential));
  if (differentialTimer !== undefined && !/^Unit=machvon-backup@diff\.service\r?$/m.test(differentialTimer)) findings.push(finding('BACKUP_SCHEDULE_UNITS', `${TIMERS.differential} must start machvon-backup@diff.service`));
  const monthlyService = readText(join(systemd, 'machvon-backup-monthly.service')) ?? '';
  if (!/--type=full\b/.test(monthlyService) || !/--repo=2\b/.test(monthlyService)) findings.push(finding('BACKUP_SCHEDULE_UNITS', 'machvon-backup-monthly.service must run a full backup into repository 2 (--type=full --repo=2)'));

  const covered = new Set();
  for (const cycle of REQUIRED_CYCLES) {
    const members = policy.cycles?.[cycle];
    if (!Array.isArray(members) || members.length === 0 || members.some((member) => SCHEDULE_TYPE[member] === undefined || policy.schedule[member] === undefined)) findings.push(finding('BACKUP_CYCLES', `the ${cycle} cycle must name scheduled backups`));
    else for (const member of members) covered.add(SCHEDULE_TYPE[member]);
  }
  for (const type of REQUIRED_TYPES) if (!covered.has(type)) findings.push(finding('BACKUP_CYCLES', `no cycle takes a ${type} backup`));
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
  if (!/^aes-256-/.test(String(cipher?.cipher)) || conf2.get('global.repo1-cipher-type') !== cipher?.cipher || typeof cipher?.passphraseFile !== 'string') findings.push(finding('BACKUP_ENCRYPTION', 'client-side AES-256 encryption must be configured in the policy and in pgbackrest.conf'));
  else {
    const compose = readText(join(root, 'infra', 'onprem', 'compose', 'compose.yaml')) ?? '';
    if (!compose.includes(`/run/secrets/${cipher.passphraseFile}`)) findings.push(finding('BACKUP_ENCRYPTION', `compose.yaml does not hand the secret ${cipher.passphraseFile} to the database and backup services`));
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
  checkCopies({ root, policy, conf: conf2, findings });
  checkLedger({ root, policy, findings });
  return { findings, policy };
}

/** Retention minimum (at least three latest backups), the archive repository, the offline copy: YCK.06. */
function checkCopies({ root, policy, conf, findings }) {
  const minimum = policy.retention?.minimumBackups;
  if (!(Number.isInteger(minimum) && minimum >= 3)) findings.push(finding('BACKUP_MINIMUM', 'retention.minimumBackups must be at least 3'));
  else {
    const fullType = conf.get('global.repo1-retention-full-type');
    const fullKept = Number(conf.get('global.repo1-retention-full'));
    if (conf.size > 0 && fullType === 'count' && !(fullKept >= minimum)) findings.push(finding('BACKUP_MINIMUM', `repo1-retention-full keeps ${fullKept} full backups, the policy keeps at least ${minimum}`));
    // With time based retention the daily full backup yields one full backup a day: the days must reach the minimum.
    if (fullType === 'time' && !(policy.retention.fullDays >= minimum)) findings.push(finding('BACKUP_MINIMUM', `fullDays ${policy.retention.fullDays} cannot keep ${minimum} daily full backups`));
    const archiveKept = Number(conf.get('global.repo2-retention-full'));
    if (conf.size > 0 && !(archiveKept >= minimum)) findings.push(finding('BACKUP_MINIMUM', `repo2-retention-full keeps ${archiveKept} full backups, the policy keeps at least ${minimum}`));
  }
  const differentialCount = policy.retention?.differentialCount;
  if (!(Number.isInteger(differentialCount) && differentialCount >= 1) || (conf.size > 0 && Number(conf.get('global.repo1-retention-diff')) !== differentialCount)) findings.push(finding('BACKUP_MINIMUM', 'repo1-retention-diff must equal retention.differentialCount (at least 1)'));

  const archive = policy.archive;
  const lock = archive?.objectLock;
  if (archive?.repository !== 2 || archive.separateBucket !== true || archive.separateCredentials !== true) findings.push(finding('BACKUP_ARCHIVE', 'the archive must be repository 2 with its own bucket and its own credentials'));
  if (lock?.enabled !== true || lock.mode !== 'COMPLIANCE' || !(Number.isInteger(lock.retentionDays) && Number.isInteger(archive?.monthsKept) && lock.retentionDays >= archive.monthsKept * 31)) findings.push(finding('BACKUP_ARCHIVE', 'the archive object lock must be COMPLIANCE and outlive the months kept'));
  if (archive?.passphraseFile === undefined || archive.passphraseFile === policy.encryption?.clientSide?.passphraseFile) findings.push(finding('BACKUP_ARCHIVE', 'the archive needs its own pass phrase file, different from the operational one'));
  if (conf.size > 0) {
    const path = conf.get('global.repo2-path');
    if (conf.get('global.repo2-type') !== 's3' || !/^aes-256-/.test(String(conf.get('global.repo2-cipher-type'))) || path === undefined || path === conf.get('global.repo1-path')) findings.push(finding('BACKUP_ARCHIVE', 'pgbackrest.conf must configure repo2 as an encrypted S3 repository at a path of its own'));
    if (Number(conf.get('global.repo2-retention-full')) !== archive?.retentionFull) findings.push(finding('BACKUP_ARCHIVE', 'repo2-retention-full must equal archive.retentionFull'));
  }
  const compose = readText(join(root, 'infra', 'onprem', 'compose', 'compose.yaml')) ?? '';
  if (archive?.passphraseFile !== undefined && !compose.includes(`/run/secrets/${archive.passphraseFile}`)) findings.push(finding('BACKUP_ARCHIVE', `compose.yaml does not hand the secret ${archive.passphraseFile} to the database and backup services`));
  if (!compose.includes('PGBACKREST_REPO2_S3_BUCKET: ${BACKUP_ARCHIVE_S3_BUCKET}') || !compose.includes('/run/secrets/backup_archive_s3_access_key')) findings.push(finding('BACKUP_ARCHIVE', 'compose.yaml must give repo2 its own bucket variable and its own access keys'));
  const archiveLock = readJson(join(root, 'infra', 'backup', 'bucket', 'archive', 'object-lock-configuration.json'));
  const archiveRule = archiveLock?.Rule?.DefaultRetention;
  if (archiveLock?.ObjectLockEnabled !== 'Enabled' || archiveRule?.Mode !== lock?.mode || archiveRule?.Days !== lock?.retentionDays) findings.push(finding('BACKUP_ARCHIVE', 'bucket/archive/object-lock-configuration.json differs from the policy'));

  const offline = policy.offlineCopy;
  const runbook = readText(join(root, String(offline?.runbook))) ?? '';
  if (offline?.required !== true || !(offline.custodians >= 2) || typeof offline.frequency !== 'string' || typeof offline.medium !== 'string') findings.push(finding('BACKUP_OFFLINE_COPY', 'an offline copy with a frequency, a medium and two custodians is required'));
  else if (!runbook.split(/\r?\n/).some((line) => /^#{2,4} /.test(line) && line.replace(/^#+ /, '').trim() === offline.runbookSection)) findings.push(finding('BACKUP_OFFLINE_COPY', `${offline.runbook} has no section "${offline.runbookSection}"`));
}

/** The structure of the restore drill ledger: dated, ordered, complete, witnessed by somebody other than the operator. The age is judged by drillStatus, not here. */
function checkLedger({ root, policy, findings }) {
  const path = policy.restoreDrill?.ledger;
  const ledger = typeof path === 'string' ? readJson(join(root, path)) : undefined;
  const problem = (detail) => findings.push(finding('BACKUP_DRILL_LEDGER', detail));
  if (ledger === undefined || !Array.isArray(ledger.entries) || !DAY.test(String(ledger.firstDrillDueBy))) {
    problem(`${path ?? 'restoreDrill.ledger'} is missing or malformed (entries[], firstDrillDueBy)`);
    return;
  }
  let previous = '';
  const ids = new Set();
  ledger.entries.forEach((entry, index) => {
    const label = `entry ${index + 1}`;
    if (typeof entry.id !== 'string' || entry.id === '' || ids.has(entry.id)) problem(`${label}: id missing or repeated`);
    ids.add(entry.id);
    if (!DAY.test(String(entry.performedOn)) || entry.performedOn < previous) problem(`${label}: performedOn must be a date and not earlier than the entry before`);
    previous = String(entry.performedOn);
    if (['reportSha256', 'sourceManifestSha256', 'restoredManifestSha256'].some((key) => !HEX64.test(String(entry[key])))) problem(`${label}: the sha256 of the report and of both manifests are required`);
    if (!DRILL_VERDICTS.includes(entry.verdict)) problem(`${label}: verdict must be one of ${DRILL_VERDICTS.join(', ')}`);
    if (!(entry.rpoSeconds >= 0) || !(entry.rtoSeconds >= 0)) problem(`${label}: rpoSeconds and rtoSeconds are required`);
    if (typeof entry.operator !== 'string' || typeof entry.witness !== 'string' || entry.operator === '' || entry.witness === '' || entry.operator === entry.witness) problem(`${label}: operator and witness are required and must be two people`);
    if (typeof entry.release !== 'string' || entry.release === '') problem(`${label}: the restored release is required`);
  });
}

/**
 * The age of the last restore drill against restoreDrill.maxDaysBetweenDrills. A clock dependent judgement, so it is not part of the offline lint: `backup-verify drill-status` prints it and
 * exits 1 when the last drill is too old or did not match. States: NEVER_DRILLED (before the date the first drill is due), OVERDUE, FAILED, TARGETS_MISSED, CURRENT.
 */
export function drillStatus(root, now = new Date()) {
  const policy = readJson(join(root, POLICY_FILE));
  const ledger = readJson(join(root, String(policy?.restoreDrill?.ledger)));
  const maxDays = policy?.restoreDrill?.maxDaysBetweenDrills;
  if (policy === undefined || ledger === undefined || !Array.isArray(ledger.entries) || !(maxDays > 0)) return { state: 'OVERDUE', lastDrill: null, daysSince: null, maxDays: maxDays ?? null, detail: 'ledger or policy unreadable' };
  const last = ledger.entries.at(-1);
  if (last === undefined) return { state: now.getTime() > Date.parse(`${ledger.firstDrillDueBy}T23:59:59Z`) ? 'OVERDUE' : 'NEVER_DRILLED', lastDrill: null, daysSince: null, maxDays, detail: `first drill due by ${ledger.firstDrillDueBy}` };
  const daysSince = Math.floor((now.getTime() - Date.parse(`${last.performedOn}T00:00:00Z`)) / 86_400_000);
  const state = daysSince > maxDays ? 'OVERDUE' : last.verdict === 'does-not-match' ? 'FAILED' : last.verdict === 'targets-missed' ? 'TARGETS_MISSED' : 'CURRENT';
  return { state, lastDrill: last.performedOn, daysSince, maxDays, detail: `last drill ${last.performedOn}, verdict ${last.verdict}` };
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
export function verifyBucket({ policy, bucket, endpoint, region, probe = false, run = defaultRun, now = () => new Date(), lock: lockPolicy = policy.immutability.objectLock, label = '' }) {
  const findings = [];
  const checks = [];
  const base = ['s3api', '--endpoint-url', endpoint, ...(region === undefined ? [] : ['--region', region]), '--output', 'json'];
  const call = (action, extra) => run('aws', [base[0], action, ...base.slice(1), '--bucket', bucket, ...extra]);
  const record = (name, ok, detail = '') => checks.push({ name: `${label}${name}`, ok, detail });

  const lock = call('get-object-lock-configuration', []);
  if (lock.status !== 0) {
    findings.push(finding('BACKUP_LIVE_COMMAND', `get-object-lock-configuration: ${String(lock.stderr ?? '').trim().split('\n').pop() ?? ''}`));
    record('object-lock', false, 'command failed');
  } else {
    const configuration = parse(lock)?.ObjectLockConfiguration;
    const rule = configuration?.Rule?.DefaultRetention;
    const days = rule?.Days ?? (rule?.Years === undefined ? undefined : rule.Years * 365);
    const ok = configuration?.ObjectLockEnabled === 'Enabled' && rule?.Mode === lockPolicy.mode && days >= lockPolicy.retentionDays;
    record('object-lock', ok, `${rule?.Mode ?? 'none'} ${days ?? 0} days`);
    if (!ok) findings.push(finding('BACKUP_LIVE_LOCK', `${rule?.Mode ?? 'no default retention'} ${days ?? 0} days; the policy needs ${lockPolicy.mode} ${lockPolicy.retentionDays} days`));
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
      options: { root: { type: 'string', default: REPO_ROOT }, bucket: { type: 'string' }, endpoint: { type: 'string' }, region: { type: 'string' }, probe: { type: 'boolean', default: false }, 'archive-bucket': { type: 'string' }, 'archive-endpoint': { type: 'string' }, evidence: { type: 'string' }, locale: { type: 'string', default: DEFAULT_LOCALE } },
    });
  } catch {
    log(loadOnpremMessages(DEFAULT_LOCALE)['backupVerify.usage']);
    return 2;
  }
  const { values, positionals } = parsed;
  const messages = loadOnpremMessages(values.locale);
  const root = resolve(values.root);
  const mode = positionals[0] ?? 'offline';
  if (mode !== 'offline' && mode !== 'live' && mode !== 'drill-status') {
    log(messages['backupVerify.usage']);
    return 2;
  }
  if (mode === 'drill-status') {
    const status = drillStatus(root, now());
    log(format(messages['backupVerify.drillStatus'], { state: status.state, detail: status.detail }));
    const failing = status.state === 'OVERDUE' || status.state === 'FAILED';
    if (failing) log(format(messages['backupVerify.code.BACKUP_DRILL_OVERDUE'], { detail: status.detail }));
    return failing ? 1 : 0;
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
      if (values['archive-bucket'] !== undefined) {
        const archive = verifyBucket({ policy: offline.policy, bucket: values['archive-bucket'], endpoint: values['archive-endpoint'] ?? values.endpoint, region: values.region, probe: values.probe, run, now, lock: offline.policy.archive?.objectLock ?? offline.policy.immutability.objectLock, label: 'archive:' });
        findings = [...findings, ...archive.findings];
        checks = [...checks, ...archive.checks];
      }
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
