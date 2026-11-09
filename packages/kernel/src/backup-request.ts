/**
 * The manual backup request (INFRA-2, HSKT YCK.06). A person asks for a full, differential or incremental backup; a different person allows it; the host runner of the installation runs it with pgBackRest; the
 * outcome is recorded. The platform never runs a backup itself. These are the rules that do not need a database.
 */
export const BACKUP_KINDS = ['full', 'diff', 'incr'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/** Repository 1 is the operational one, repository 2 the archive (monthly full backups only). */
export const BACKUP_REPOSITORIES = [1, 2] as const;
export type BackupRepository = (typeof BACKUP_REPOSITORIES)[number];

export type BackupRequestStatus = 'Requested' | 'Approved' | 'Rejected' | 'Cancelled' | 'Completed' | 'Failed';

export const BACKUP_REASON_MIN = 10;
export const BACKUP_REASON_MAX = 2000;
/** A backup label of pgBackRest looks like `20261109-010000F` or `20261109-010000F_20261110-050000I`. */
export const BACKUP_LABEL_PATTERN = /^[0-9]{8}-[0-9]{6}[FDI](_[0-9]{8}-[0-9]{6}[DI])?$/;

export interface BackupRequestInput {
  kind: string;
  repository: number;
  reason: string;
}

/** The reasons a request is refused as not valid; the first one is reported. */
export function backupRequestDefects(input: BackupRequestInput): string[] {
  const defects: string[] = [];
  if (!(BACKUP_KINDS as readonly string[]).includes(input.kind)) defects.push('kind');
  if (!(BACKUP_REPOSITORIES as readonly number[]).includes(input.repository)) defects.push('repository');
  else if (input.repository === 2 && input.kind !== 'full') defects.push('repository');
  const reason = input.reason.trim();
  if (reason.length < BACKUP_REASON_MIN || reason.length > BACKUP_REASON_MAX) defects.push('reason');
  return defects;
}

/** The kind a pgBackRest label stands for: the last letter is F (full), D (differential) or I (incremental); undefined for anything that is not a label. */
export function backupKindOfLabel(label: string): BackupKind | undefined {
  if (!BACKUP_LABEL_PATTERN.test(label)) return undefined;
  const letter = label.slice(-1);
  return letter === 'F' ? 'full' : letter === 'D' ? 'diff' : 'incr';
}

/** The state of the last backups as the platform shows it. UNKNOWN means no state source is configured or it cannot be read: never a made-up value. */
export type BackupHealth = 'OK' | 'STALE' | 'FAILED' | 'UNKNOWN';

export interface BackupStateEntry {
  label: string;
  kind: BackupKind;
  finishedAt: string;
  repository: number;
  failed: boolean;
}

export interface BackupState {
  source: 'FILE' | 'NONE';
  readAt: string;
  /** Newest first, at most ten. */
  backups: BackupStateEntry[];
  lastVerifyAt: string | null;
  health: BackupHealth;
  detail: string | null;
}

/** The oldest last-full-backup age (hours) that is still healthy: the alert `pg-backup-age` pages beyond this. */
export const BACKUP_MAX_AGE_HOURS = 26;

/** Health of the repository from its backups and the clock: FAILED when the newest backup failed, STALE when the newest full backup is older than the limit, UNKNOWN with no backup at all. */
export function backupHealthOf(backups: readonly BackupStateEntry[], now: Date): BackupHealth {
  if (backups.length === 0) return 'UNKNOWN';
  if (backups[0]?.failed === true) return 'FAILED';
  const full = backups.find((entry) => entry.kind === 'full' && !entry.failed);
  if (full === undefined) return 'STALE';
  return now.getTime() - Date.parse(full.finishedAt) > BACKUP_MAX_AGE_HOURS * 3_600_000 ? 'STALE' : 'OK';
}
