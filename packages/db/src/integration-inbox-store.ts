import { DomainError, versionConflict } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type InboxStatus = 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DEAD';
export const INBOX_STATUSES: readonly InboxStatus[] = ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'];

/**
 * An event of the integration inbox as the monitor shows it. The payload is never part of it: the row names where the payload is kept
 * only for the worker that processes it, and says whether it is still there (`payloadKept`). The monitor and its read never carry it.
 */
export interface InboxEventRow {
  id: string;
  provider: string;
  eventKey: string;
  eventType: string | null;
  /** The channel account a webhook event is for; none for the events of the other providers. */
  channelAccountId: string | null;
  status: InboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  receivedAt: string;
  processedAt: string | null;
  payloadKept: boolean;
  replayCount: number;
  lastReplayedAt: string | null;
  version: number;
}

interface Row {
  id: string;
  provider: string;
  event_key: string;
  provider_event_type: string | null;
  channel_account_id: string | null;
  status: InboxStatus;
  attempts: number;
  next_attempt_at: string | null;
  error_code: string | null;
  received_at: string;
  processed_at: string | null;
  payload_kept: boolean;
  replay_count: number;
  last_replayed_at: string | null;
  version: string;
  received_key: string;
}

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const COLUMNS = `id, provider, event_key, provider_event_type, channel_account_id, status, attempts, ${TIME('next_attempt_at')} as next_attempt_at, error_code,
  ${TIME('received_at')} as received_at, ${TIME('processed_at')} as processed_at, (payload_reference is not null) as payload_kept, replay_count,
  ${TIME('last_replayed_at')} as last_replayed_at, version::text as version, to_char(received_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') as received_key`;

const toRow = (row: Row): InboxEventRow => ({
  id: row.id,
  provider: row.provider,
  eventKey: row.event_key,
  eventType: row.provider_event_type,
  channelAccountId: row.channel_account_id,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  errorCode: row.error_code,
  receivedAt: row.received_at,
  processedAt: row.processed_at,
  payloadKept: row.payload_kept,
  replayCount: row.replay_count,
  lastReplayedAt: row.last_replayed_at,
  version: Number(row.version),
});

/** The ordering key of the last row of a page: events come newest first, by the moment of reception to the microsecond, then id. */
export interface InboxPageAnchor {
  code: string;
  id: string;
}

export interface InboxFilter {
  status?: InboxStatus | undefined;
  provider?: string | undefined;
}

/** The events that a replay may take up again. */
export const REPLAYABLE: readonly InboxStatus[] = ['FAILED', 'DEAD'];

/**
 * The integration inbox as the sync monitor (ADM-10) manages it (ST-ADM-018): events are listed without their payload and a failed or dead
 * one can be taken up again. A replay puts the event back as RECEIVED with a clean count of attempts and a due time of now, so the worker (or
 * the replay itself, right after the command commits) processes it; it never edits the payload. Every query runs inside the caller's tenant
 * transaction, so row-level security keeps tenants apart.
 */
export class IntegrationInboxStore {
  async find(tx: TenantTx, id: string): Promise<InboxEventRow | undefined> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.integration_event_inbox where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** Newest first, optionally of one status or one provider. The caller asks for one more row than it shows. */
  async list(tx: TenantTx, filter: InboxFilter, request: { limit: number; after: InboxPageAnchor | undefined }): Promise<Array<InboxEventRow & { cursorKey: string }>> {
    if (request.after !== undefined && !/^\d{20}$/.test(request.after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    if (filter.status !== undefined && !INBOX_STATUSES.includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.integration_event_inbox
        where ($1::text is null or status = $1) and ($2::text is null or provider = $2)
          and ($3::text is null or (to_char(received_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'), id::text) < ($3::text, $4::text))
        order by received_at desc, id desc limit $5`,
      [filter.status ?? null, filter.provider ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map((row) => ({ ...toRow(row), cursorKey: row.received_key }));
  }

  /**
   * Takes a failed or dead event up again (BR-ADM-10, AC-ST-ADM-018-2). A missing event is 404; one in any other state (received, processing,
   * processed) is 409 INBOX_STATE_INVALID whatever the version the caller sent, so a second replay of an event that the first one already
   * processed is told the state, not a stale version; an event whose payload has been purged cannot be replayed (409 INBOX_STATE_INVALID);
   * a stale version is 409 VERSION_CONFLICT.
   */
  async requeue(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ before: InboxEventRow; row: InboxEventRow }> {
    const locked = await tx.query<Row>(`select ${COLUMNS} from machvon.integration_event_inbox where id = $1::uuid for update`, [id]);
    const before = locked[0] === undefined ? undefined : toRow(locked[0]);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!REPLAYABLE.includes(before.status) || !before.payloadKept) throw new DomainError('INBOX_STATE_INVALID', 409);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    await tx.query(
      `update machvon.integration_event_inbox
          set status = 'RECEIVED', attempts = 0, next_attempt_at = now(), error_code = null, replay_count = replay_count + 1,
              last_replayed_at = now(), last_replayed_by = $2::uuid
        where id = $1::uuid`,
      [id, actor],
    );
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, row };
  }
}
