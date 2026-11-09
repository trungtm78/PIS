import { DomainError, backupKindOfLabel, backupRequestDefects, versionConflict } from '@machvon/kernel';
import type { BackupKind, BackupRequestStatus } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import type { TenantTx } from './tenant-database.ts';

const RESOURCE_TYPE = 'backup_request';

export interface BackupRequestRow {
  id: string;
  kind: BackupKind;
  repository: number;
  reason: string;
  status: BackupRequestStatus;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  recordedBy: string | null;
  finishedAt: Date | null;
  backupLabel: string | null;
  outcomeNote: string | null;
  version: number;
}

interface BackupRequestDbRow {
  id: string;
  kind: BackupKind;
  repository: number;
  reason: string;
  status: BackupRequestStatus;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  recorded_by: string | null;
  finished_at: Date | null;
  backup_label: string | null;
  outcome_note: string | null;
  version: string;
}

const COLUMNS = `id, kind, repository::int as repository, reason, status, requested_by, requested_at, decided_by, decided_at, decision_reason, recorded_by, finished_at, backup_label, outcome_note, version::text as version`;

const backupRequestOf = (row: BackupRequestDbRow): BackupRequestRow => ({
  id: row.id,
  kind: row.kind,
  repository: row.repository,
  reason: row.reason,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  recordedBy: row.recorded_by,
  finishedAt: row.finished_at,
  backupLabel: row.backup_label,
  outcomeNote: row.outcome_note,
  version: Number(row.version),
});

export type BackupDecision = 'approve' | 'reject';

/**
 * The manual backup requests (INFRA-2, HSKT YCK.06). One person asks, a different person decides (403 SELF_APPROVAL_DENIED whichever way they decide), the requester may cancel their own request while it waits,
 * and after the host runner ran an approved backup the outcome is recorded (the pgBackRest label, or the failure). Only one request for the same kind and repository is open at a time (409 BACKUP_REQUEST_OPEN).
 */
export class BackupRequestStore {
  async request(tx: TenantTx, effects: ApprovalEffects, input: { kind: string; repository: number; reason: string; requestedBy: string; now: Date }): Promise<BackupRequestRow> {
    const defect = backupRequestDefects(input)[0];
    if (defect !== undefined) throw new DomainError('VALIDATION_FAILED', 422, defect);
    const reason = input.reason.trim();
    const [row] = await tx
      .query<BackupRequestDbRow>(
        `insert into machvon.backup_request (tenant_id, id, kind, repository, reason, status, requested_by, requested_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2::smallint, $3, 'Requested', $4::uuid, $5::timestamptz)
         returning ${COLUMNS}`,
        [input.kind, input.repository, reason, input.requestedBy, input.now.toISOString()],
      )
      .catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === '23505') throw new DomainError('BACKUP_REQUEST_OPEN', 409);
        throw error;
      });
    if (row === undefined) throw new Error('backup request insert returned no row');
    const created = backupRequestOf(row);
    await effects.audit({ action: 'backup.requested', resourceType: RESOURCE_TYPE, resourceId: created.id, reason, classification: 'CONFIDENTIAL', diff: { kind: created.kind, repository: created.repository } });
    return created;
  }

  /** Approves or rejects a waiting request. 404 when it does not exist, 409 VERSION_CONFLICT for a stale version, 409 STAGE_TRANSITION_DENIED when it no longer waits, 403 SELF_APPROVAL_DENIED for the person who asked. */
  async decide(tx: TenantTx, effects: ApprovalEffects, input: { id: string; decision: BackupDecision; decidedBy: string; reason: string; expectedVersion: number; now: Date }): Promise<BackupRequestRow> {
    const current = await this.lock(tx, input.id);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'Requested') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (current.requestedBy.toLowerCase() === input.decidedBy.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const reason = input.reason.trim();
    if (input.decision === 'reject' && reason.length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const approved = input.decision === 'approve';
    const [row] = await tx.query<BackupRequestDbRow>(
      `update machvon.backup_request set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_reason = $5, version = version + 1 where id = $1::uuid returning ${COLUMNS}`,
      [current.id, approved ? 'Approved' : 'Rejected', input.decidedBy, input.now.toISOString(), reason === '' ? null : reason],
    );
    if (row === undefined) throw new Error('backup request update returned no row');
    const decided = backupRequestOf(row);
    await effects.audit({ action: 'backup.decided', resourceType: RESOURCE_TYPE, resourceId: decided.id, reason: reason === '' ? undefined : reason, classification: 'CONFIDENTIAL', diff: { decision: input.decision, kind: decided.kind, repository: decided.repository, requested_by: decided.requestedBy } });
    return decided;
  }

  /** The requester withdraws a request that still waits. */
  async cancel(tx: TenantTx, effects: ApprovalEffects, input: { id: string; by: string; reason: string; expectedVersion: number; now: Date }): Promise<BackupRequestRow> {
    const current = await this.lock(tx, input.id);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'Requested') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (current.requestedBy.toLowerCase() !== input.by.toLowerCase()) throw new DomainError('SCOPE_DENIED', 403);
    const reason = input.reason.trim();
    const [row] = await tx.query<BackupRequestDbRow>(
      `update machvon.backup_request set status = 'Cancelled', decided_at = $2::timestamptz, decision_reason = $3, version = version + 1 where id = $1::uuid returning ${COLUMNS}`,
      [current.id, input.now.toISOString(), reason === '' ? null : reason],
    );
    if (row === undefined) throw new Error('backup request update returned no row');
    const cancelled = backupRequestOf(row);
    await effects.audit({ action: 'backup.cancelled', resourceType: RESOURCE_TYPE, resourceId: cancelled.id, classification: 'INTERNAL', diff: { kind: cancelled.kind } });
    return cancelled;
  }

  /**
   * Records what came of an approved request after the host runner ran it: the backup label (Completed) or the failure note (Failed). The label must be a pgBackRest label of the kind that was asked for
   * (422 VALIDATION_FAILED on `backup_label`); a request that is not approved cannot be recorded (409 STAGE_TRANSITION_DENIED).
   */
  async record(tx: TenantTx, effects: ApprovalEffects, input: { id: string; outcome: 'completed' | 'failed'; backupLabel?: string; note?: string; recordedBy: string; expectedVersion: number; now: Date }): Promise<BackupRequestRow> {
    const current = await this.lock(tx, input.id);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'Approved') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const completed = input.outcome === 'completed';
    const label = (input.backupLabel ?? '').trim();
    const note = (input.note ?? '').trim();
    if (completed && backupKindOfLabel(label) !== current.kind) throw new DomainError('VALIDATION_FAILED', 422, 'backup_label');
    if (!completed && note.length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const [row] = await tx.query<BackupRequestDbRow>(
      `update machvon.backup_request set status = $2, recorded_by = $3::uuid, finished_at = $4::timestamptz, backup_label = $5, outcome_note = $6, version = version + 1 where id = $1::uuid returning ${COLUMNS}`,
      [current.id, completed ? 'Completed' : 'Failed', input.recordedBy, input.now.toISOString(), completed ? label : null, note === '' ? null : note],
    );
    if (row === undefined) throw new Error('backup request update returned no row');
    const recorded = backupRequestOf(row);
    await effects.audit({ action: 'backup.recorded', resourceType: RESOURCE_TYPE, resourceId: recorded.id, classification: 'CONFIDENTIAL', diff: { outcome: input.outcome, kind: recorded.kind, backup_label: recorded.backupLabel } });
    return recorded;
  }

  async find(tx: TenantTx, id: string): Promise<BackupRequestRow | undefined> {
    const [row] = await tx.query<BackupRequestDbRow>(`select ${COLUMNS} from machvon.backup_request where id = $1::uuid`, [id]);
    return row === undefined ? undefined : backupRequestOf(row);
  }

  /** The requests of the tenant, the newest first, a page at a time. */
  async list(tx: TenantTx, filter: { limit: number; after?: { requestedAt: string; id: string } }): Promise<BackupRequestRow[]> {
    const rows = await tx.query<BackupRequestDbRow>(
      `select ${COLUMNS} from machvon.backup_request where ($2::timestamptz is null or (requested_at, id) < ($2::timestamptz, $3::uuid)) order by requested_at desc, id desc limit $1::int`,
      [filter.limit, filter.after?.requestedAt ?? null, filter.after?.id ?? null],
    );
    return rows.map(backupRequestOf);
  }

  private async lock(tx: TenantTx, id: string): Promise<BackupRequestRow> {
    const [row] = await tx.query<BackupRequestDbRow>(`select ${COLUMNS} from machvon.backup_request where id = $1::uuid for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return backupRequestOf(row);
  }
}
