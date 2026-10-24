import { DomainError, asUuid } from '@machvon/kernel';
import { IN_APP_CHANNEL } from './delivery-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

export type NotificationPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export interface NewNotification {
  /** The outbox event the notification answers: the `source_event_id` of the dedupe key. */
  eventId: string;
  workflowVersionId: string;
  recipientId: string;
  purpose: string;
  dedupeKey: string;
  expiresAt: Date;
  sourceEventType: string;
  eventVersion: number;
  priority: NotificationPriority;
  ackRequired: boolean;
  /**
   * The channels in the order they are tried (NOT 3.1 step 4). IN_APP is the inbox: it is delivered by the insert itself, so a plan that holds it
   * starts Delivered; the others are sent by the delivery engine, one channel at a time, the next one only when a channel is exhausted. Default: IN_APP.
   */
  channelPlan?: readonly string[];
}

/** What an event says about the thing a notification is about (the `notification` member of its payload). */
export interface NotificationRef {
  resource?: { type: string; id: string; ownerUnitId?: string; ownerUnitPath?: string; projectId?: string; contractId?: string };
  deepLink?: string;
}

export interface NotificationRow {
  id: string;
  eventId: string;
  workflowVersionId: string;
  recipientId: string;
  purpose: string;
  status: string;
  priority: string;
  ackRequired: boolean;
  readAt: Date | null;
  acknowledgedAt: Date | null;
  expiresAt: Date;
  sourceEventType: string;
  version: number;
  createdAt: Date;
  /** Microsecond-precise text form of `createdAt`: the ordering key of the keyset cursor. */
  createdKey: string;
  /** From the payload of the source event, when it is still on file. */
  ref: NotificationRef | null;
}

export interface NotificationPageAnchor {
  code: string;
  id: string;
}

export interface NotificationPage {
  limit: number;
  after: NotificationPageAnchor | undefined;
}

interface Row {
  id: string;
  event_id: string;
  workflow_version_id: string;
  recipient_id: string;
  purpose: string;
  status: string;
  priority: string;
  ack_required: boolean;
  read_at: Date | null;
  acknowledged_at: Date | null;
  expires_at: Date;
  source_event_type: string;
  version: string;
  created_at: Date;
  created_key: string;
  ref: NotificationRef | null;
}

const COLUMNS = `n.id, n.event_id, n.workflow_version_id, n.recipient_id, n.purpose, n.status, n.priority, n.ack_required,
  n.read_at, n.acknowledged_at, n.expires_at, n.source_event_type, n.version::text as version, n.created_at,
  to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_key,
  e.payload -> 'notification' as ref`;
// The event stays on file in the outbox: its payload is where content is re-rendered from, under the reader's current access.
const FROM = `from machvon.notification_instance n
  left join machvon.outbox_event e on e.tenant_id = n.tenant_id and e.id = n.event_id`;
// Keyset over (created_at, id) newest first; the cursor carries the microsecond text of created_at.
const AFTER = `($1::text is null or (n.created_at, n.id) < ($1::timestamptz, $2::uuid))`;

const INSERT_SQL = `insert into machvon.notification_instance
    (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status,
     source_event_type, event_version, priority, ack_required, channel_plan)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
     case when 'IN_APP' = any($11::text[]) then 'Delivered' else 'Queued' end, $7, $8, $9, $10, $11::text[])
  on conflict (tenant_id, dedupe_key) do nothing
  returning id`;

function toRow(row: Row): NotificationRow {
  return {
    id: row.id,
    eventId: row.event_id,
    workflowVersionId: row.workflow_version_id,
    recipientId: row.recipient_id,
    purpose: row.purpose,
    status: row.status,
    priority: row.priority,
    ackRequired: row.ack_required,
    readAt: row.read_at,
    acknowledgedAt: row.acknowledged_at,
    expiresAt: row.expires_at,
    sourceEventType: row.source_event_type,
    version: Number(row.version),
    createdAt: row.created_at,
    createdKey: row.created_key,
    ref: row.ref,
  };
}

function assertCursor(after: NotificationPageAnchor | undefined): void {
  assertTimestampCursor(after?.code);
}

function notFound(): DomainError {
  return new DomainError('RESOURCE_NOT_FOUND', 404);
}

/**
 * Notification instances (NOT 3.1, 3.2). Every query runs inside the caller's tenant transaction, so row-level
 * security keeps tenants apart; the recipient filter keeps members apart.
 */
export class NotificationStore {
  /** Inserts a Delivered in-app notification; a second insert with the same dedupe key changes nothing (BR-NOT-01). */
  async insert(tx: TenantTx, notification: NewNotification): Promise<{ id: string; created: boolean }> {
    const inserted = await tx.query<{ id: string }>(INSERT_SQL, [
      notification.eventId,
      notification.workflowVersionId,
      notification.recipientId,
      notification.purpose,
      notification.dedupeKey,
      notification.expiresAt.toISOString(),
      notification.sourceEventType,
      notification.eventVersion,
      notification.priority,
      notification.ackRequired,
      notification.channelPlan ?? [IN_APP_CHANNEL],
    ]);
    const created = inserted[0];
    if (created !== undefined) return { id: created.id, created: true };
    const [existing] = await tx.query<{ id: string }>('select id from machvon.notification_instance where dedupe_key = $1', [notification.dedupeKey]);
    if (existing === undefined) throw new Error('notification vanished after a dedupe conflict');
    return { id: existing.id, created: false };
  }

  /** The Published notification workflow of an event type, or undefined. */
  async workflowFor(tx: TenantTx, eventType: string): Promise<{ id: string; definition: unknown } | undefined> {
    const [row] = await tx.query<{ id: string; definition_json: unknown }>(
      `select id, definition_json from machvon.workflow_version
        where kind = 'NOTIFICATION' and event_type = $1 and status = 'Published'
        order by revision desc limit 1`,
      [eventType],
    );
    return row === undefined ? undefined : { id: row.id, definition: row.definition_json };
  }

  /**
   * The current path of organisation units, by id: the place of a unit can change after the event that names it was
   * written. A unit that does not exist (or whose id is not a UUID) is absent from the answer.
   */
  async currentUnitPaths(tx: TenantTx, unitIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(unitIds.map((unitId) => asUuid(unitId)).filter((unitId): unitId is string => unitId !== undefined))];
    if (ids.length === 0) return new Map();
    const rows = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = any($1::uuid[])', [ids]);
    return new Map(rows.map((row) => [row.id, row.path]));
  }

  /** When the event was written to the outbox: the base of `expires_at`. */
  async eventTime(tx: TenantTx, eventId: string): Promise<Date | undefined> {
    const [row] = await tx.query<{ created_at: Date }>('select created_at from machvon.outbox_event where id = $1::uuid', [eventId]);
    return row?.created_at;
  }

  /** The caller's own notifications, newest first (the inbox of NOT-01). */
  async listFor(tx: TenantTx, membershipId: string, page: NotificationPage): Promise<NotificationRow[]> {
    assertCursor(page.after);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} ${FROM}
        where ${AFTER} and n.recipient_id = $3::uuid and n.recipient_kind = 'MEMBERSHIP' and not n.is_test and 'IN_APP' = any(n.channel_plan)
        order by n.created_at desc, n.id desc limit $4`,
      [page.after?.code ?? null, page.after?.id ?? null, membershipId, page.limit],
    );
    return rows.map(toRow);
  }

  async findFor(tx: TenantTx, membershipId: string, id: string): Promise<NotificationRow | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} ${FROM} where n.id = $1::uuid and n.recipient_id = $2::uuid`, [id, membershipId]);
    return row === undefined ? undefined : toRow(row);
  }

  /**
   * The first read sets `read_at` and moves the status to Read; a later read changes nothing (BR-NOT-05: only the
   * in-app open counts as a read). A notification of another member is a missing one.
   */
  async markRead(tx: TenantTx, membershipId: string, id: string): Promise<NotificationRow> {
    await tx.query(
      `update machvon.notification_instance
          set read_at = now(), status = case when status in ('Created','Queued','Sending','ProviderAccepted','Delivered') then 'Read' else status end,
              version = version + 1
        where id = $1::uuid and recipient_id = $2::uuid and read_at is null`,
      [id, membershipId],
    );
    const row = await this.findFor(tx, membershipId, id);
    if (row === undefined) throw notFound();
    return row;
  }

  /**
   * Acknowledgement is a separate business act from reading (BR-NOT-05): refused with 422 ACK_NOT_REQUIRED when the
   * notification does not ask for it, 409 NOTIFICATION_EXPIRED after `expires_at`, 409 NOTIFICATION_STATE_INVALID before
   * it was read; a repeat answers the first acknowledgement.
   */
  async acknowledge(tx: TenantTx, membershipId: string, id: string): Promise<NotificationRow> {
    const [locked] = await tx.query<{ ack_required: boolean; read_at: Date | null; acknowledged_at: Date | null; expired: boolean }>(
      `select ack_required, read_at, acknowledged_at, expires_at <= now() as expired
         from machvon.notification_instance where id = $1::uuid and recipient_id = $2::uuid for update`,
      [id, membershipId],
    );
    if (locked === undefined) throw notFound();
    if (!locked.ack_required) throw new DomainError('ACK_NOT_REQUIRED', 422);
    if (locked.acknowledged_at === null) {
      if (locked.expired) throw new DomainError('NOTIFICATION_EXPIRED', 409);
      if (locked.read_at === null) throw new DomainError('NOTIFICATION_STATE_INVALID', 409);
      await tx.query('update machvon.notification_instance set acknowledged_at = now(), version = version + 1 where id = $1::uuid', [id]);
    }
    const row = await this.findFor(tx, membershipId, id);
    if (row === undefined) throw notFound();
    return row;
  }

  /** Every notification of the tenant, newest first: the metadata reads of the operator (no recipient filter). */
  async listAll(tx: TenantTx, page: NotificationPage): Promise<NotificationRow[]> {
    assertCursor(page.after);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} ${FROM} where ${AFTER} order by n.created_at desc, n.id desc limit $3`,
      [page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRow);
  }

  async findAny(tx: TenantTx, id: string): Promise<NotificationRow | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} ${FROM} where n.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRow(row);
  }
}
