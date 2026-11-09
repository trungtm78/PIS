import { readFile, stat } from 'node:fs/promises';
import { backupHealthOf } from '@machvon/kernel';
import type { BackupKind, BackupState, BackupStateEntry } from '@machvon/kernel';

/** Injection token of the port that tells the screen how the backups are (INFRA-2, HSKT YCK.06). */
export const BACKUP_STATE_PORT = Symbol('BACKUP_STATE_PORT');

/**
 * Where the last backups and the last repository verification are read from. The API never runs a backup and never reaches the repository: the host writes the state to files (`machvon-backup-info.timer`
 * writes `pgbackrest info --output=json`, the verify service writes the time of its last good run) and an adapter reads them. No adapter configured is `NONE`: the state is UNKNOWN, never a made-up value.
 */
export interface BackupStatePort {
  read(now: Date): Promise<BackupState>;
}

export class NoBackupState implements BackupStatePort {
  read(now: Date): Promise<BackupState> {
    return Promise.resolve({ source: 'NONE', readAt: now.toISOString(), backups: [], lastVerifyAt: null, health: 'UNKNOWN', detail: 'NOT_CONFIGURED' });
  }
}

interface PgbackrestBackup {
  label?: unknown;
  type?: unknown;
  error?: unknown;
  timestamp?: { stop?: unknown };
  database?: { 'repo-key'?: unknown };
}

const KINDS = new Set<string>(['full', 'diff', 'incr']);
const MAX_ENTRIES = 10;
/** A state file older than this was not refreshed by the host timer (every 15 minutes): it is not trusted. */
export const STATE_FILE_MAX_AGE_MS = 2 * 3_600_000;

/** The backups of the stanza from the output of `pgbackrest info --output=json`, newest first; entries without a label, a known type or a stop time are skipped. */
export function backupsFromPgbackrestInfo(text: string, stanza: string): BackupStateEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const found = (parsed as Array<{ name?: unknown; backup?: unknown }>).find((entry) => entry.name === stanza);
  if (found === undefined || !Array.isArray(found.backup)) return undefined;
  const entries: Array<BackupStateEntry & { stop: number }> = [];
  for (const raw of found.backup as PgbackrestBackup[]) {
    const stop = raw.timestamp?.stop;
    if (typeof raw.label !== 'string' || typeof raw.type !== 'string' || !KINDS.has(raw.type) || typeof stop !== 'number') continue;
    const repository = raw.database?.['repo-key'];
    entries.push({ label: raw.label, kind: raw.type as BackupKind, finishedAt: new Date(stop * 1000).toISOString(), repository: typeof repository === 'number' ? repository : 1, failed: raw.error === true, stop });
  }
  return entries
    .sort((a, b) => b.stop - a.stop)
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({ label: entry.label, kind: entry.kind, finishedAt: entry.finishedAt, repository: entry.repository, failed: entry.failed }));
}

/** Reads the two state files the host writes. A missing, old or unreadable file is UNKNOWN with the reason in `detail`. */
export class FileBackupState implements BackupStatePort {
  constructor(private readonly options: { infoFile: string; verifyFile?: string; stanza?: string }) {}

  async read(now: Date): Promise<BackupState> {
    const base = { source: 'FILE' as const, readAt: now.toISOString(), lastVerifyAt: await this.verifiedAt() };
    let text: string;
    try {
      const [content, info] = await Promise.all([readFile(this.options.infoFile, 'utf8'), stat(this.options.infoFile)]);
      if (now.getTime() - info.mtimeMs > STATE_FILE_MAX_AGE_MS) return { ...base, backups: [], health: 'UNKNOWN', detail: 'STATE_FILE_OLD' };
      text = content;
    } catch {
      return { ...base, backups: [], health: 'UNKNOWN', detail: 'STATE_FILE_UNREADABLE' };
    }
    const backups = backupsFromPgbackrestInfo(text, this.options.stanza ?? 'machvon');
    if (backups === undefined) return { ...base, backups: [], health: 'UNKNOWN', detail: 'STATE_FILE_MALFORMED' };
    return { ...base, backups, health: backupHealthOf(backups, now), detail: backups.length === 0 ? 'NO_BACKUP' : null };
  }

  private async verifiedAt(): Promise<string | null> {
    if (this.options.verifyFile === undefined) return null;
    try {
      const parsed = JSON.parse(await readFile(this.options.verifyFile, 'utf8')) as { at?: unknown };
      return typeof parsed.at === 'string' && !Number.isNaN(Date.parse(parsed.at)) ? new Date(parsed.at).toISOString() : null;
    } catch {
      return null;
    }
  }
}

/** `MACHVON_BACKUP_INFO_FILE` (and optionally `MACHVON_BACKUP_VERIFY_FILE`, `MACHVON_BACKUP_STANZA`) select the file adapter; without the info file there is no state. */
export function backupStateFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): BackupStatePort {
  const infoFile = env.MACHVON_BACKUP_INFO_FILE?.trim();
  if (infoFile === undefined || infoFile === '') return new NoBackupState();
  const verifyFile = env.MACHVON_BACKUP_VERIFY_FILE?.trim();
  return new FileBackupState({ infoFile, verifyFile: verifyFile === undefined || verifyFile === '' ? undefined : verifyFile, stanza: env.MACHVON_BACKUP_STANZA?.trim() || undefined });
}
