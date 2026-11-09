import { ApiError } from '@machvon/api-client';
import type { Tone } from '../../../ui';

export const BACKUP_READ = 'adm.backup.read';
export const BACKUP_REQUEST = 'adm.backup.request';
export const BACKUP_DECIDE = 'adm.backup.decide';
export const BACKUP_RECORD = 'adm.backup.record';
export const REASON_MIN = 10;

export type BackupKind = 'full' | 'diff' | 'incr';
export type BackupStatus = 'Requested' | 'Approved' | 'Rejected' | 'Cancelled' | 'Completed' | 'Failed';
export type BackupHealth = 'OK' | 'STALE' | 'FAILED' | 'UNKNOWN';

export interface BackupRequestView {
  id: string;
  kind: BackupKind;
  repository: number;
  reason: string;
  status: BackupStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  backupLabel: string | null;
  version: number;
}

export interface BackupEntryView {
  label: string;
  kind: BackupKind;
  finishedAt: string;
  repository: number;
  failed: boolean;
}

export interface BackupStateView {
  source: 'FILE' | 'NONE';
  health: BackupHealth;
  detail: string | null;
  lastVerifyAt: string | null;
  backups: BackupEntryView[];
}

export interface BackupPageView {
  state: BackupStateView;
  items: BackupRequestView[];
}

const KINDS: readonly string[] = ['full', 'diff', 'incr'];
const STATUSES: readonly string[] = ['Requested', 'Approved', 'Rejected', 'Cancelled', 'Completed', 'Failed'];
const HEALTHS: readonly string[] = ['OK', 'STALE', 'FAILED', 'UNKNOWN'];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function toRequest(raw: unknown): BackupRequestView | undefined {
  if (!isObject(raw)) return undefined;
  const id = text(raw.id);
  const kind = text(raw.kind);
  const reason = text(raw.reason);
  const status = text(raw.status);
  if (id === undefined || kind === undefined || !KINDS.includes(kind) || reason === undefined || status === undefined || !STATUSES.includes(status)) return undefined;
  return {
    id,
    kind: kind as BackupKind,
    repository: typeof raw.repository === 'number' ? raw.repository : 1,
    reason,
    status: status as BackupStatus,
    requestedBy: text(raw.requested_by) ?? '',
    requestedAt: text(raw.requested_at) ?? '',
    decidedBy: text(raw.decided_by) ?? null,
    backupLabel: text(raw.backup_label) ?? null,
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

function toEntry(raw: unknown): BackupEntryView | undefined {
  if (!isObject(raw)) return undefined;
  const label = text(raw.label);
  const kind = text(raw.kind);
  if (label === undefined || kind === undefined || !KINDS.includes(kind)) return undefined;
  return { label, kind: kind as BackupKind, finishedAt: text(raw.finished_at) ?? '', repository: typeof raw.repository === 'number' ? raw.repository : 1, failed: raw.failed === true };
}

/** The page of the list operation; an answer without a readable state is shown as UNKNOWN, never as healthy. */
export function toBackupPage(raw: unknown): BackupPageView {
  const body = isObject(raw) ? raw : {};
  const state = isObject(body.state) ? body.state : {};
  const health = text(state.health);
  return {
    state: {
      source: state.source === 'FILE' ? 'FILE' : 'NONE',
      health: health !== undefined && HEALTHS.includes(health) ? (health as BackupHealth) : 'UNKNOWN',
      detail: text(state.detail) ?? null,
      lastVerifyAt: text(state.last_verify_at) ?? null,
      backups: (Array.isArray(state.backups) ? state.backups : []).flatMap((entry) => toEntry(entry) ?? []),
    },
    items: (Array.isArray(body.items) ? body.items : []).flatMap((item) => toRequest(item) ?? []),
  };
}

export function healthTone(health: BackupHealth): Tone {
  return health === 'OK' ? 'success' : health === 'UNKNOWN' ? 'neutral' : 'danger';
}

export function statusTone(status: BackupStatus): Tone {
  return status === 'Completed' ? 'success' : status === 'Requested' || status === 'Approved' ? 'warning' : status === 'Failed' || status === 'Rejected' ? 'danger' : 'neutral';
}

/** The kinds a repository takes: the archive (2) takes full backups only. */
export function kindsFor(repository: number): BackupKind[] {
  return repository === 2 ? ['full'] : ['full', 'diff', 'incr'];
}

export type RefusalReason = 'selfApproval' | 'open' | 'conflict' | 'state' | 'invalid' | 'denied' | 'general';

export function refusalOf(error: unknown): RefusalReason {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'BACKUP_REQUEST_OPEN':
      return 'open';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'STAGE_TRANSITION_DENIED':
      return 'state';
    case 'VALIDATION_FAILED':
      return 'invalid';
    case 'SCOPE_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}
