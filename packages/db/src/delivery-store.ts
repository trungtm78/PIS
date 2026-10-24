import { CIRCUIT_ALERT_SECONDS, CIRCUIT_OPEN_SECONDS, DomainError, RECONCILE_WINDOW_SECONDS, SENDING_STALE_SECONDS, circuitAfterFailure, circuitVerdict, rollupNotificationStatus } from '@machvon/kernel';
import type { CircuitState } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

export type AttemptStatus = 'Queued' | 'Sending' | 'ProviderAccepted' | 'Delivered' | 'Read' | 'Failed' | 'Unknown' | 'Cancelled' | 'Suppressed';
export type FailureClass = 'RETRYABLE' | 'PERMANENT' | 'UNKNOWN';

/** The channel of the inbox: it is delivered by the insert of the notification itself and has no attempts. */
export const IN_APP_CHANNEL = 'IN_APP';

/** A notification as the engine locks it. */
export interface LockedNotification {
  id: string;
  status: string;
  version: number;
  expiresAt: Date;
  channelPlan: readonly string[];
  recipientId: string;
  purpose: string;
  eventId: string;
  workflowVersionId: string;
  sourceEventType: string;
  eventVersion: number;
  priority: string;
  ackRequired: boolean;
  dedupeKey: string;
  replayOf: string | null;
  replaySeq: number | null;
  /** A cancel arrived while a send was in flight: no retry and no fallback follows. */
  cancelRequestedAt: Date | null;
}

/** An attempt as the engine reads it. */
export interface AttemptRecord {
  id: string;
  notificationId: string;
  channel: string;
  channelAccountId: string;
  templateVersionId: string;
  attemptNo: number;
  status: AttemptStatus;
  failureClass: FailureClass | null;
  errorCode: string | null;
  providerMessageId: string | null;
  nextRetryAt: Date | null;
  sendingAt: Date | null;
  unknownAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
}

/** What the operator reads of one attempt (NOT-11, NOT-12, NOT-13): never an address, a payload or a message body. */
export interface AttemptView {
  id: string;
  notificationId: string;
  notificationStatus: string;
  notificationVersion: number;
  expiresAt: string;
  ackRequired: boolean;
  acknowledgedAt: string | null;
  channel: string;
  attemptNo: number;
  status: AttemptStatus;
  failureClass: FailureClass | null;
  errorCode: string | null;
  providerMessageId: string | null;
  queuedAt: string;
  nextRetryAt: string | null;
  sendingAt: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  fallbackChannel: string | null;
  needsReconcile: boolean;
  reconcileDueAt: string | null;
  replayOf: string | null;
  cursorKey: string;
}

export interface AttemptFilter {
  statuses?: readonly AttemptStatus[];
  notificationId?: string;
  /** Only the attempts that end a chain the notification could not complete: the failed queue (NOT-13). */
  deadLetter?: boolean;
}

export interface AttemptPage {
  limit: number;
  after: { code: string; id: string } | undefined;
}

export interface AttemptHistoryRow {
  fromStatus: string | null;
  toStatus: string;
  cause: string;
  occurredAt: string;
}

export type QueueRefusal = 'NO_CHANNEL_ACCOUNT' | 'NO_TEMPLATE';

interface AttemptSql {
  id: string;
  notification_id: string;
  channel: string;
  channel_account_id: string;
  template_version_id: string;
  attempt_no: number;
  status: AttemptStatus;
  failure_class: FailureClass | null;
  error_code: string | null;
  provider_message_id: string | null;
  next_retry_at: Date | null;
  sending_at: Date | null;
  unknown_at: Date | null;
  failed_at: Date | null;
  created_at: Date;
}

const ATTEMPT_COLUMNS = `id, notification_id, channel, channel_account_id, template_version_id, attempt_no, status, failure_class, error_code, provider_message_id,
  next_retry_at, sending_at, unknown_at, failed_at, created_at`;

const toAttempt = (row: AttemptSql): AttemptRecord => ({
  id: row.id,
  notificationId: row.notification_id,
  channel: row.channel,
  channelAccountId: row.channel_account_id,
  templateVersionId: row.template_version_id,
  attemptNo: row.attempt_no,
  status: row.status,
  failureClass: row.failure_class,
  errorCode: row.error_code,
  providerMessageId: row.provider_message_id,
  nextRetryAt: row.next_retry_at,
  sendingAt: row.sending_at,
  unknownAt: row.unknown_at,
  failedAt: row.failed_at,
  createdAt: row.created_at,
});

interface NotificationSql {
  id: string;
  status: string;
  version: string;
  expires_at: Date;
  channel_plan: string[];
  recipient_id: string;
  purpose: string;
  event_id: string;
  workflow_version_id: string;
  source_event_type: string;
  event_version: number;
  priority: string;
  ack_required: boolean;
  dedupe_key: string;
  replay_of: string | null;
  replay_seq: number | null;
  cancel_requested_at: Date | null;
}

const toNotification = (row: NotificationSql): LockedNotification => ({
  id: row.id,
  status: row.status,
  version: Number(row.version),
  expiresAt: row.expires_at,
  channelPlan: row.channel_plan,
  recipientId: row.recipient_id,
  purpose: row.purpose,
  eventId: row.event_id,
  workflowVersionId: row.workflow_version_id,
  sourceEventType: row.source_event_type,
  eventVersion: row.event_version,
  priority: row.priority,
  ackRequired: row.ack_required,
  dedupeKey: row.dedupe_key,
  replayOf: row.replay_of,
  replaySeq: row.replay_seq,
  cancelRequestedAt: row.cancel_requested_at,
});

const NOTIFICATION_COLUMNS = `id, status, version::text as version, expires_at, channel_plan, recipient_id, purpose, event_id, workflow_version_id, source_event_type,
  event_version, priority, ack_required, dedupe_key, replay_of, replay_seq, cancel_requested_at`;

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = (column: string): string => `to_char((${column}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The first channel of the plan after the one of the attempt that is not the inbox: the channel that takes over when this one is exhausted.
const FALLBACK = `(select u.c from unnest(n.channel_plan) with ordinality as u(c, i)
   where u.c <> 'IN_APP' and u.i > coalesce((select p.i from unnest(n.channel_plan) with ordinality as p(c, i) where p.c = a.channel limit 1), 0)
   order by u.i limit 1)`;

const VIEW_COLUMNS = `a.id, a.notification_id, n.status as notification_status, n.version::text as notification_version, ${ISO('n.expires_at')} as expires_at,
  n.ack_required, ${ISO('n.acknowledged_at')} as acknowledged_at, a.channel, a.attempt_no, a.status, a.failure_class, a.error_code, a.provider_message_id,
  ${ISO('a.created_at')} as queued_at, ${ISO('a.next_retry_at')} as next_retry_at, ${ISO('a.sending_at')} as sending_at, ${ISO('a.accepted_at')} as accepted_at,
  ${ISO('a.delivered_at')} as delivered_at, ${ISO('a.read_at')} as read_at, ${ISO('a.failed_at')} as failed_at, ${FALLBACK} as fallback_channel,
  (a.status = 'Unknown' and a.unknown_at + make_interval(secs => ${RECONCILE_WINDOW_SECONDS}) > now()) as needs_reconcile,
  case when a.status = 'Unknown' then ${ISO(`a.unknown_at + make_interval(secs => ${RECONCILE_WINDOW_SECONDS})`)} end as reconcile_due_at,
  n.replay_of, ${timestampKey('a.created_at')} as cursor_key`;

const VIEW_FROM = 'from machvon.delivery_attempt a join machvon.notification_instance n on n.tenant_id = a.tenant_id and n.id = a.notification_id';

interface ViewSql {
  id: string;
  notification_id: string;
  notification_status: string;
  notification_version: string;
  expires_at: string;
  ack_required: boolean;
  acknowledged_at: string | null;
  channel: string;
  attempt_no: number;
  status: AttemptStatus;
  failure_class: FailureClass | null;
  error_code: string | null;
  provider_message_id: string | null;
  queued_at: string;
  next_retry_at: string | null;
  sending_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  fallback_channel: string | null;
  needs_reconcile: boolean;
  reconcile_due_at: string | null;
  replay_of: string | null;
  cursor_key: string;
}

const toView = (row: ViewSql): AttemptView => ({
  id: row.id,
  notificationId: row.notification_id,
  notificationStatus: row.notification_status,
  notificationVersion: Number(row.notification_version),
  expiresAt: row.expires_at,
  ackRequired: row.ack_required,
  acknowledgedAt: row.acknowledged_at,
  channel: row.channel,
  attemptNo: row.attempt_no,
  status: row.status,
  failureClass: row.failure_class,
  errorCode: row.error_code,
  providerMessageId: row.provider_message_id,
  queuedAt: row.queued_at,
  nextRetryAt: row.next_retry_at,
  sendingAt: row.sending_at,
  acceptedAt: row.accepted_at,
  deliveredAt: row.delivered_at,
  readAt: row.read_at,
  failedAt: row.failed_at,
  fallbackChannel: row.fallback_channel,
  needsReconcile: row.needs_reconcile,
  reconcileDueAt: row.reconcile_due_at,
  replayOf: row.replay_of,
  cursorKey: row.cursor_key,
});

/** The failed queue: a notification the engine could not deliver, and the last attempt of each of its channels. */
const DEAD_LETTER = `n.status in ('Failed', 'Unknown') and a.status in ('Failed', 'Unknown')
  and not exists (select 1 from machvon.delivery_attempt later where later.notification_id = a.notification_id and later.channel = a.channel and later.attempt_no > a.attempt_no)
  and not exists (select 1 from machvon.notification_instance copy where copy.replay_of = coalesce(n.replay_of, n.id) and coalesce(copy.replay_seq, 0) > coalesce(n.replay_seq, 0))`;

/**
 * The SQL of the delivery engine (NOT 3.1, 3.6): attempts of a notification, the circuit of a channel account and the reads of the operator. Every
 * method runs in the caller's tenant transaction. A transaction that changes a notification locks the notification first and its attempts after, so
 * the dispatcher, a callback, a cancel and a replay never wait for each other in a circle.
 */
export class DeliveryStore {
  /** The notification, locked for the rest of the transaction. */
  async lockNotification(tx: TenantTx, id: string): Promise<LockedNotification | undefined> {
    const [row] = await tx.query<NotificationSql>(`select ${NOTIFICATION_COLUMNS} from machvon.notification_instance where id = $1::uuid for update`, [id]);
    return row === undefined ? undefined : toNotification(row);
  }

  /** The id of the notification of an attempt, without any lock: the caller then locks the notification and only then the attempt. */
  async notificationOf(tx: TenantTx, attemptId: string): Promise<string | undefined> {
    const [row] = await tx.query<{ notification_id: string }>('select notification_id from machvon.delivery_attempt where id = $1::uuid', [attemptId]);
    return row?.notification_id;
  }

  async lockAttempt(tx: TenantTx, id: string): Promise<AttemptRecord | undefined> {
    const [row] = await tx.query<AttemptSql>(`select ${ATTEMPT_COLUMNS} from machvon.delivery_attempt where id = $1::uuid for update`, [id]);
    return row === undefined ? undefined : toAttempt(row);
  }

  async attemptsOf(tx: TenantTx, notificationId: string): Promise<AttemptRecord[]> {
    const rows = await tx.query<AttemptSql>(
      `select ${ATTEMPT_COLUMNS} from machvon.delivery_attempt where notification_id = $1::uuid order by created_at, attempt_no, id`,
      [notificationId],
    );
    return rows.map(toAttempt);
  }

  /** The attempt a provider message id names, for one channel account. */
  async attemptByProviderMessage(tx: TenantTx, channelAccountId: string, providerMessageId: string): Promise<AttemptRecord | undefined> {
    const [row] = await tx.query<AttemptSql>(
      `select ${ATTEMPT_COLUMNS} from machvon.delivery_attempt where channel_account_id = $1::uuid and provider_message_id = $2`,
      [channelAccountId, providerMessageId],
    );
    return row === undefined ? undefined : toAttempt(row);
  }

  /** The template code a workflow names for a channel (`definition_json.channels`), or undefined. */
  async templateCodeOf(tx: TenantTx, workflowVersionId: string, channel: string): Promise<string | undefined> {
    const [row] = await tx.query<{ code: string | null }>(
      `select e ->> 'templateCode' as code
         from machvon.workflow_version w,
              jsonb_array_elements(case when jsonb_typeof(w.definition_json -> 'channels') = 'array' then w.definition_json -> 'channels' else '[]'::jsonb end) e
        where w.id = $1::uuid and e ->> 'channel' = $2 limit 1`,
      [workflowVersionId, channel],
    );
    return row?.code ?? undefined;
  }

  /**
   * Queues the first send on a channel of the plan: the Active channel account of that channel and the Active template the workflow names for it
   * (the Vietnamese one first). A channel without either is refused with the reason, so the caller moves on to the next channel of the plan.
   */
  async queueFirstSend(tx: TenantTx, notification: Pick<LockedNotification, 'id' | 'workflowVersionId'>, channel: string, attemptNo: number, dueAt: Date | null): Promise<{ attemptId: string } | { refused: QueueRefusal }> {
    const [account] = await tx.query<{ id: string }>("select id from machvon.channel_account where channel = $1 and status = 'Active' order by id limit 1", [channel]);
    if (account === undefined) return { refused: 'NO_CHANNEL_ACCOUNT' };
    const code = await this.templateCodeOf(tx, notification.workflowVersionId, channel);
    const [template] =
      code === undefined
        ? []
        : await tx.query<{ id: string }>(
            "select id from machvon.notification_template_version where code = $1 and channel = $2 and status = 'Active' order by (locale = 'vi-VN') desc, revision desc limit 1",
            [code, channel],
          );
    if (template === undefined) return { refused: 'NO_TEMPLATE' };
    return { attemptId: await this.insertAttempt(tx, notification.id, channel, account.id, template.id, attemptNo, dueAt) };
  }

  async insertAttempt(tx: TenantTx, notificationId: string, channel: string, channelAccountId: string, templateVersionId: string, attemptNo: number, dueAt: Date | null): Promise<string> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, next_retry_at)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3, 'Queued', 0, $4, $5::uuid, $6::timestamptz) returning id`,
      [notificationId, channelAccountId, attemptNo, channel, templateVersionId, dueAt?.toISOString() ?? null],
    );
    if (row === undefined) throw new Error('delivery attempt not inserted');
    return row.id;
  }

  /** The number of the next send on a channel of a notification (the highest so far plus one); 1 for a channel never used. */
  async nextAttemptNo(tx: TenantTx, notificationId: string, channel: string): Promise<number> {
    const [row] = await tx.query<{ n: number }>('select coalesce(max(attempt_no), 0) + 1 as n from machvon.delivery_attempt where notification_id = $1::uuid and channel = $2', [notificationId, channel]);
    return row?.n ?? 1;
  }

  /** The attempts that are due on a channel, oldest first. They are not locked: the dispatcher claims one at a time. */
  async dueAttempts(tx: TenantTx, channel: string, now: Date, limit: number): Promise<Array<{ id: string; notificationId: string }>> {
    const rows = await tx.query<{ id: string; notification_id: string }>(
      `select id, notification_id from machvon.delivery_attempt
        where channel = $1 and status = 'Queued' and (next_retry_at is null or next_retry_at <= $2::timestamptz)
        order by coalesce(next_retry_at, created_at), id limit $3`,
      [channel, now.toISOString(), limit],
    );
    return rows.map((row) => ({ id: row.id, notificationId: row.notification_id }));
  }

  /** The channels that have attempts waiting, so the dispatcher gives each its own turn (the bulkhead). */
  async channelsWithWork(tx: TenantTx, now: Date): Promise<string[]> {
    const rows = await tx.query<{ channel: string }>(
      "select distinct channel from machvon.delivery_attempt where status = 'Queued' and (next_retry_at is null or next_retry_at <= $1::timestamptz) order by channel",
      [now.toISOString()],
    );
    return rows.map((row) => row.channel);
  }

  /** The sends that were taken up and never reported back, oldest first. */
  async staleSending(tx: TenantTx, now: Date, limit: number): Promise<Array<{ id: string; notificationId: string }>> {
    const rows = await tx.query<{ id: string; notification_id: string }>(
      "select id, notification_id from machvon.delivery_attempt where status = 'Sending' and sending_at < $1::timestamptz order by sending_at, id limit $2",
      [new Date(now.getTime() - SENDING_STALE_SECONDS * 1000).toISOString(), limit],
    );
    return rows.map((row) => ({ id: row.id, notificationId: row.notification_id }));
  }

  /** The sends whose result is unknown and still inside the window of the reconcile job, oldest first. */
  async unknownToReconcile(tx: TenantTx, now: Date, limit: number): Promise<Array<{ id: string; notificationId: string; channel: string; attemptNo: number }>> {
    const rows = await tx.query<{ id: string; notification_id: string; channel: string; attempt_no: number }>(
      "select id, notification_id, channel, attempt_no from machvon.delivery_attempt where status = 'Unknown' and unknown_at > $1::timestamptz order by unknown_at, id limit $2",
      [new Date(now.getTime() - RECONCILE_WINDOW_SECONDS * 1000).toISOString(), limit],
    );
    return rows.map((row) => ({ id: row.id, notificationId: row.notification_id, channel: row.channel, attemptNo: row.attempt_no }));
  }

  /** Moves a locked notification to a status; the version moves with it. */
  async moveNotification(tx: TenantTx, id: string, status: string, suppressionReason?: string): Promise<void> {
    await tx.query(
      'update machvon.notification_instance set status = $2, version = version + 1, suppression_reason = coalesce($3, suppression_reason) where id = $1::uuid',
      [id, status, suppressionReason ?? null],
    );
  }

  /**
   * Brings the status of a locked notification in line with its attempts (BR-NOT-06): forward only, a late delivery lifts Failed and Unknown, a
   * provider read does not stand for the reading of the person. Returns the status it has now.
   */
  async syncNotification(tx: TenantTx, notification: LockedNotification): Promise<string> {
    const attempts = await this.attemptsOf(tx, notification.id);
    const status = rollupNotificationStatus({ current: notification.status, attempts: attempts.map((attempt) => attempt.status) });
    if (status !== notification.status) await this.moveNotification(tx, notification.id, status);
    return status;
  }

  // The circuit breaker of a channel account (BR-NOT-16).

  /** Whether a send on the account may go now: ADMIT, PROBE (this send tests the provider after the open period) or REJECT with the time to try again. */
  async circuitAdmit(tx: TenantTx, channelAccountId: string, now: Date): Promise<{ verdict: 'ADMIT' | 'PROBE' | 'REJECT'; retryAt?: Date }> {
    await tx.query(`insert into machvon.channel_account_circuit (tenant_id, channel_account_id) values (${TENANT}, $1::uuid) on conflict do nothing`, [channelAccountId]);
    const [row] = await tx.query<{ state: CircuitState; opened_at: Date | null; probe_started_at: Date | null }>(
      'select state, opened_at, probe_started_at from machvon.channel_account_circuit where channel_account_id = $1::uuid for update',
      [channelAccountId],
    );
    if (row === undefined) throw new Error('circuit row vanished');
    // A probe that never reported (its process died) is a failed probe: the circuit is open again from the moment the probe started.
    const lost = row.state === 'HALF_OPEN' && row.probe_started_at !== null && now.getTime() - row.probe_started_at.getTime() > SENDING_STALE_SECONDS * 1000;
    const state: CircuitState = lost ? 'OPEN' : row.state;
    const openedAt = lost ? (row.probe_started_at ?? undefined) : (row.opened_at ?? undefined);
    const verdict = circuitVerdict(state, openedAt, now);
    if (verdict === 'PROBE') {
      await tx.query("update machvon.channel_account_circuit set state = 'HALF_OPEN', opened_at = coalesce(opened_at, $2::timestamptz), probe_started_at = $2::timestamptz, updated_at = now() where channel_account_id = $1::uuid", [
        channelAccountId,
        now.toISOString(),
      ]);
    }
    if (verdict !== 'REJECT') return { verdict };
    return openedAt === undefined ? { verdict } : { verdict, retryAt: new Date(openedAt.getTime() + CIRCUIT_OPEN_SECONDS * 1000) };
  }

  /** A send on the account was accepted: the circuit closes. */
  async circuitSuccess(tx: TenantTx, channelAccountId: string): Promise<void> {
    await tx.query(
      "update machvon.channel_account_circuit set state = 'CLOSED', opened_at = null, probe_started_at = null, alerted_at = null, updated_at = now() where channel_account_id = $1::uuid and state <> 'CLOSED'",
      [channelAccountId],
    );
  }

  /** The probe ended in a refusal that says nothing about the provider: the circuit stays open and the next send is the next probe. */
  async circuitProbeUndecided(tx: TenantTx, channelAccountId: string): Promise<void> {
    await tx.query("update machvon.channel_account_circuit set state = 'OPEN', probe_started_at = null, updated_at = now() where channel_account_id = $1::uuid and state = 'HALF_OPEN'", [channelAccountId]);
  }

  /** A send on the account failed or was lost: the circuit opens after enough failures in the window, or again after a failed probe. Returns the state. */
  async circuitFailure(tx: TenantTx, channelAccountId: string, now: Date): Promise<CircuitState> {
    await tx.query(`insert into machvon.channel_account_circuit (tenant_id, channel_account_id) values (${TENANT}, $1::uuid) on conflict do nothing`, [channelAccountId]);
    const [row] = await tx.query<{ state: CircuitState; failures: string }>(
      `select c.state, (select count(*) from machvon.delivery_attempt a
                         where a.channel_account_id = c.channel_account_id and a.failure_class is distinct from 'PERMANENT'
                           and a.failed_at > $2::timestamptz - make_interval(secs => 60) and a.failed_at <= $2::timestamptz)::text as failures
         from machvon.channel_account_circuit c where c.channel_account_id = $1::uuid for update`,
      [channelAccountId, now.toISOString()],
    );
    if (row === undefined) throw new Error('circuit row vanished');
    const state = circuitAfterFailure(row.state, Number(row.failures));
    if (state === 'OPEN' && row.state !== 'OPEN') {
      await tx.query("update machvon.channel_account_circuit set state = 'OPEN', opened_at = $2::timestamptz, probe_started_at = null, alerted_at = null, updated_at = now() where channel_account_id = $1::uuid", [
        channelAccountId,
        now.toISOString(),
      ]);
    }
    return state;
  }

  /** The circuits that have stayed open longer than ten minutes and were not reported yet; they are marked reported. */
  async circuitsToAlert(tx: TenantTx, now: Date): Promise<Array<{ channelAccountId: string; channel: string }>> {
    const rows = await tx.query<{ channel_account_id: string; channel: string }>(
      `update machvon.channel_account_circuit c set alerted_at = $1::timestamptz
         from machvon.channel_account a
        where a.tenant_id = c.tenant_id and a.id = c.channel_account_id and c.state <> 'CLOSED' and c.alerted_at is null
          and c.opened_at < $1::timestamptz - make_interval(secs => ${CIRCUIT_ALERT_SECONDS})
        returning c.channel_account_id, a.channel`,
      [now.toISOString()],
    );
    return rows.map((row) => ({ channelAccountId: row.channel_account_id, channel: row.channel }));
  }

  // Reads of the operator (NOT-11, NOT-12, NOT-13).

  async list(tx: TenantTx, filter: AttemptFilter, page: AttemptPage): Promise<AttemptView[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<ViewSql>(
      `select ${VIEW_COLUMNS} ${VIEW_FROM}
        where ($1::text is null or (a.created_at, a.id) < ($1::timestamptz, $2::uuid))
          and ($3::text[] is null or a.status = any($3::text[]))
          and ($4::uuid is null or a.notification_id = $4::uuid)
          and (not $5::boolean or (${DEAD_LETTER}))
        order by a.created_at desc, a.id desc limit $6`,
      [page.after?.code ?? null, page.after?.id ?? null, filter.statuses === undefined ? null : [...filter.statuses], filter.notificationId ?? null, filter.deadLetter === true, page.limit],
    );
    return rows.map(toView);
  }

  async find(tx: TenantTx, id: string): Promise<AttemptView | undefined> {
    const [row] = await tx.query<ViewSql>(`select ${VIEW_COLUMNS} ${VIEW_FROM} where a.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toView(row);
  }

  /** Every attempt of the notification, in the order they were made: the journey of NOT-12. */
  async journey(tx: TenantTx, notificationId: string): Promise<AttemptView[]> {
    const rows = await tx.query<ViewSql>(`select ${VIEW_COLUMNS} ${VIEW_FROM} where a.notification_id = $1::uuid order by a.created_at, a.attempt_no, a.id`, [notificationId]);
    return rows.map(toView);
  }

  /** The changes of status of one attempt, from the generic history of the provider callbacks. */
  async history(tx: TenantTx, attemptId: string): Promise<AttemptHistoryRow[]> {
    const rows = await tx.query<{ from_status: string | null; to_status: string; cause: string; occurred_at: string }>(
      `select h.from_status, h.to_status, h.cause, ${ISO('h.occurred_at')} as occurred_at
         from machvon.provider_status_history h join machvon.provider_status_item i on i.tenant_id = h.tenant_id and i.id = h.item_id
        where i.subject_type = 'delivery_attempt' and i.subject_id = $1::uuid order by h.item_version`,
      [attemptId],
    );
    return rows.map((row) => ({ fromStatus: row.from_status, toStatus: row.to_status, cause: row.cause, occurredAt: row.occurred_at }));
  }

  /** The gauges of the alerts: notifications waiting in the failed queue, and the age in seconds of the oldest send whose result is unknown. */
  async gauges(tx: TenantTx): Promise<{ deadLetter: number; oldestUnknownSeconds: number }> {
    const [row] = await tx.query<{ dead: string; oldest: string | null }>(
      // The notifications the failed queue lists (NOT-13): one that a replay copy has taken over is not waiting there any more.
      `select (select count(*) from machvon.notification_instance n
                where n.status in ('Failed', 'Unknown')
                  and not exists (select 1 from machvon.notification_instance copy where copy.replay_of = coalesce(n.replay_of, n.id) and coalesce(copy.replay_seq, 0) > coalesce(n.replay_seq, 0)))::text as dead,
              (select extract(epoch from now() - min(a.unknown_at))::text from machvon.delivery_attempt a join machvon.notification_instance n on n.tenant_id = a.tenant_id and n.id = a.notification_id
                where a.status = 'Unknown' and n.status = 'Unknown'
                  and not exists (select 1 from machvon.notification_instance copy where copy.replay_of = coalesce(n.replay_of, n.id) and coalesce(copy.replay_seq, 0) > coalesce(n.replay_seq, 0))) as oldest`,
    );
    return { deadLetter: Number(row?.dead ?? 0), oldestUnknownSeconds: Math.floor(Number(row?.oldest ?? 0)) };
  }

  /** Throws 404 for a notification that is not in the tenant. */
  async requireNotification(tx: TenantTx, id: string): Promise<LockedNotification> {
    const notification = await this.lockNotification(tx, id);
    if (notification === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return notification;
  }
}

/** The channels of a plan that the engine sends to (everything but the inbox), in order. */
export const externalChannelsOf = (plan: readonly string[]): string[] => plan.filter((channel) => channel !== IN_APP_CHANNEL);
