import { randomUUID } from 'node:crypto';
import {
  DELIVERY_STATUS_TABLE,
  DomainError,
  MAX_ATTEMPTS_PER_CHANNEL,
  NOOP_METRICS,
  RECONCILE_WINDOW_SECONDS,
  attemptStatusOf,
  decideRetry,
  versionConflict,
} from '@machvon/kernel';
import type { ChannelLookupResult, ChannelSendResult, DeliveryStatus, MetricsSink } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import { DeliveryGate, QUIET_HOURS_CODE } from './delivery-gate.ts';
import { DeliveryStore, externalChannelsOf } from './delivery-store.ts';
import type { AttemptRecord, FailureClass, LockedNotification } from './delivery-store.ts';
import { ProviderCallbackStore } from './provider-callback-store.ts';
import type { ProviderItemRef } from './provider-callback-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const DELIVERY_ATTEMPTS_METRIC = 'delivery_attempts_total';
export const DELIVERY_LATENCY_METRIC = 'delivery_latency_seconds';
export const OUT_OF_ORDER_METRIC = 'out_of_order_callbacks_total';
export const CHANNEL_SKIPPED_METRIC = 'notification_channel_skipped_total';
/** BR-NOT-08: an urgent message that went out in the quiet hours of its recipient (NOT 9). */
export const QUIET_HOURS_OVERRIDE_METRIC = 'quiet_hours_override_total';
/** The subject type of the status items the engine tracks, one per send that was taken up. */
export const ATTEMPT_SUBJECT_TYPE = 'delivery_attempt';

const RESOLVED_BY_PROVIDER = 'Resolved by the delivery engine: the provider reported the result of the send.';

/** What the dispatcher needs to make one send: everything about the attempt that is not an address. */
export interface ClaimedSend {
  attempt: AttemptRecord;
  notification: LockedNotification;
  /** The `external_account_id` of the channel account: the sender identity at the provider. */
  accountId: string;
  template: { id: string; code: string; contentAst: unknown; variableSchema: unknown };
  /** The payload of the event that raised the notification, when it is still on file (the variables of the template come from it). */
  eventPayload: Record<string, unknown> | null;
  /** `{notification_id}:{channel}:{attempt_no}`. */
  idempotencyKey: string;
}

export type ClaimOutcome =
  | { kind: 'CLAIMED'; send: ClaimedSend }
  /**
   * Nothing to send now: another process has it, it is not due, the notification is closed or expired, the circuit of the account is open, the person
   * does not accept the message on this channel (SUPPRESSED: the send is over and the plan has moved on) or is in their quiet hours (DEFERRED: the send waits).
   */
  | { kind: 'SKIPPED'; reason: 'NOT_DUE' | 'CLOSED' | 'EXPIRED' | 'CIRCUIT_OPEN' | 'SUPPRESSED' | 'DEFERRED' };

export type ResultNext = 'ACCEPTED' | 'RETRY' | 'FALLBACK' | 'EXPIRED' | 'FAILED' | 'UNKNOWN' | 'IGNORED';

export interface CallbackInput {
  inboxId: string;
  channelAccountId: string;
  providerMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
}

export interface ReplayInput {
  notificationId: string;
  expectedVersion: number;
  tenantId: string;
  now: Date;
}

export interface ReplayResult {
  /** The notification that carries the new sends: the same one, or a new one when the channel had used its five sends. */
  notificationId: string;
  version: number;
  startedNewChain: boolean;
  channel: string;
}

export interface CancelInput {
  notificationId: string;
  expectedVersion: number;
  now: Date;
}

export interface CancelResult {
  /** CANCELLED: nothing had gone out. CANCEL_REQUESTED: something is in flight or delivered; only the sends that were waiting are cancelled. */
  outcome: 'CANCELLED' | 'CANCEL_REQUESTED';
  version: number;
  cancelledAttempts: number;
}

export interface DeliveryEngineOptions {
  metrics?: MetricsSink;
  /** A number in [0, 1) for the jitter of the retry schedule; tests inject it. */
  random?: () => number;
  /** BR-NOT-01 for a replay that starts a new chain: the dedupe key of `(tenant, source event id, recipient, purpose)`. */
  dedupeKeyOf: (input: { tenantId: string; sourceEventId: string; recipientId: string; purpose: string }) => string;
  /** Writes the audit row of an urgent message that breaks the quiet hours (BR-NOT-08): without it the engine could not prove why it sent. */
  audit: Pick<AuditWriter, 'recordInTx'>;
  /** The preference, consent and quiet-hours check made when a send is taken up; tests replace it. */
  gate?: DeliveryGate;
}

const itemTable = DELIVERY_STATUS_TABLE;

/**
 * The delivery engine (ST-NOT-002, NOT 3.1 and 3.6). It owns what happens to a send once it is queued: taking it up, recording what the provider
 * answered, retrying on the schedule of BR-NOT-03, falling back to the next channel of the plan, asking about a send whose answer was lost,
 * applying the callbacks of the provider through the monotonic reducer of KERNEL-1, and the replay and the cancel of an operator. Adapters are
 * called by the dispatcher outside any transaction; the engine never calls a provider. Every method runs in the caller's tenant transaction.
 */
export class DeliveryEngine {
  private readonly store = new DeliveryStore();
  private readonly callbacks = new ProviderCallbackStore();
  private readonly metrics: MetricsSink;
  private readonly random: (() => number) | undefined;
  private readonly dedupeKeyOf: DeliveryEngineOptions['dedupeKeyOf'];
  private readonly audit: DeliveryEngineOptions['audit'];
  private readonly gate: DeliveryGate;

  constructor(options: DeliveryEngineOptions) {
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.random = options.random;
    this.dedupeKeyOf = options.dedupeKeyOf;
    this.audit = options.audit;
    this.gate = options.gate ?? new DeliveryGate();
  }

  /**
   * Starts the chain of a notification: queues the first send on the first channel of the plan that has an Active account and an Active template. A
   * channel without either is skipped (counted); when no channel can be queued and the inbox is not in the plan, the notification is Suppressed.
   */
  async startChain(tx: TenantTx, notification: LockedNotification): Promise<{ queuedChannel: string | undefined }> {
    const queued = await this.queueFrom(tx, notification, externalChannelsOf(notification.channelPlan), 1);
    if (queued === undefined && !notification.channelPlan.includes('IN_APP')) {
      await this.store.moveNotification(tx, notification.id, 'Suppressed', 'NO_CHANNEL_AVAILABLE');
    }
    return { queuedChannel: queued };
  }

  /** Queues the first send on the first of the channels that can take one; returns the channel, or undefined when none can. */
  private async queueFrom(tx: TenantTx, notification: LockedNotification, channels: readonly string[], attemptNo: 1 | 'next'): Promise<string | undefined> {
    for (const channel of channels) {
      const number = attemptNo === 1 ? 1 : await this.store.nextAttemptNo(tx, notification.id, channel);
      if (number > MAX_ATTEMPTS_PER_CHANNEL) continue;
      const queued = await this.store.queueFirstSend(tx, notification, channel, number, null);
      if ('attemptId' in queued) return channel;
      this.metrics.increment(CHANNEL_SKIPPED_METRIC, { channel, reason: queued.refused });
    }
    return undefined;
  }

  /**
   * Takes up one queued send: from Queued to Sending, in the transaction that commits before the provider is called, so a crash between the two leaves
   * a send that is Sending (a result that was lost, found by the reconcile job) and never one that is sent twice. Returns what the dispatcher needs to
   * make the call, or why there is nothing to send.
   */
  async claim(tx: TenantTx, attemptId: string, provider: string, now: Date): Promise<ClaimOutcome> {
    const notificationId = await this.store.notificationOf(tx, attemptId);
    if (notificationId === undefined) return { kind: 'SKIPPED', reason: 'NOT_DUE' };
    const notification = await this.store.lockNotification(tx, notificationId);
    const attempt = await this.store.lockAttempt(tx, attemptId);
    if (notification === undefined || attempt === undefined || attempt.status !== 'Queued') return { kind: 'SKIPPED', reason: 'NOT_DUE' };
    if (attempt.nextRetryAt !== null && attempt.nextRetryAt.getTime() > now.getTime()) return { kind: 'SKIPPED', reason: 'NOT_DUE' };
    if (notification.status === 'Cancelled' || notification.status === 'Suppressed' || notification.status === 'Expired') {
      await this.cancelAttempt(tx, attempt, 'NOTIFICATION_CLOSED');
      return { kind: 'SKIPPED', reason: 'CLOSED' };
    }
    if (notification.expiresAt.getTime() <= now.getTime()) {
      await this.cancelAttempt(tx, attempt, 'EXPIRED');
      await this.expire(tx, notification);
      return { kind: 'SKIPPED', reason: 'EXPIRED' };
    }
    // The person decides before the provider does: a preference, a consent or quiet hours are checked here, in the transaction that takes the send up.
    const decision = await this.gate.decide(tx, notification, attempt.channel, now);
    if (decision.kind === 'SUPPRESS') {
      await this.suppressAttempt(tx, notification, attempt, decision.reason, now);
      return { kind: 'SKIPPED', reason: 'SUPPRESSED' };
    }
    if (decision.kind === 'DEFER') {
      await tx.query('update machvon.delivery_attempt set next_retry_at = $2::timestamptz, error_code = $3 where id = $1::uuid', [attempt.id, decision.until.toISOString(), QUIET_HOURS_CODE]);
      this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: 'deferred' });
      return { kind: 'SKIPPED', reason: 'DEFERRED' };
    }
    const circuit = await this.store.circuitAdmit(tx, attempt.channelAccountId, now);
    if (circuit.verdict === 'REJECT') {
      // Put back for when the circuit may admit a probe: the attempt is not lost, and the next tick does not look at it again before then.
      await tx.query('update machvon.delivery_attempt set next_retry_at = $2::timestamptz where id = $1::uuid', [attempt.id, (circuit.retryAt ?? new Date(now.getTime() + 120_000)).toISOString()]);
      return { kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' };
    }
    await tx.query("update machvon.delivery_attempt set status = 'Sending', sending_at = $2::timestamptz, next_retry_at = null, error_code = null where id = $1::uuid", [attempt.id, now.toISOString()]);
    if (decision.quietHoursOverride === true) await this.recordOverride(tx, notification, attempt, decision.quietEndsAt, now);
    await this.callbacks.track(tx, { provider, subjectType: ATTEMPT_SUBJECT_TYPE, subjectId: attempt.id }, itemTable, 'SENDING');
    await this.store.syncNotification(tx, notification);
    const [account] = await tx.query<{ external_account_id: string }>('select external_account_id from machvon.channel_account where id = $1::uuid', [attempt.channelAccountId]);
    const [template] = await tx.query<{ id: string; code: string; content_ast: unknown; variable_schema: unknown }>(
      'select id, code, content_ast, variable_schema from machvon.notification_template_version where id = $1::uuid',
      [attempt.templateVersionId],
    );
    const [event] = await tx.query<{ payload: Record<string, unknown> | null }>('select payload from machvon.outbox_event where id = $1::uuid', [notification.eventId]);
    if (account === undefined || template === undefined) throw new Error('claimed attempt without its account or template');
    return {
      kind: 'CLAIMED',
      send: {
        attempt: { ...attempt, status: 'Sending', sendingAt: now, nextRetryAt: null },
        notification,
        accountId: account.external_account_id,
        template: { id: template.id, code: template.code, contentAst: template.content_ast, variableSchema: template.variable_schema },
        eventPayload: event?.payload ?? null,
        idempotencyKey: `${notification.id}:${attempt.channel}:${attempt.attemptNo}`,
      },
    };
  }

  /** The send is not made because the recipient or the notification no longer qualifies (no access, no longer a member): Suppressed, and the plan moves on. */
  async suppress(tx: TenantTx, attemptId: string, reason: string, now: Date): Promise<void> {
    const notificationId = await this.store.notificationOf(tx, attemptId);
    if (notificationId === undefined) return;
    const notification = await this.store.lockNotification(tx, notificationId);
    const attempt = await this.store.lockAttempt(tx, attemptId);
    if (notification === undefined || attempt === undefined || attempt.status !== 'Queued') return;
    await this.suppressAttempt(tx, notification, attempt, reason, now);
  }

  private async suppressAttempt(tx: TenantTx, notification: LockedNotification, attempt: AttemptRecord, reason: string, now: Date): Promise<void> {
    await tx.query("update machvon.delivery_attempt set status = 'Suppressed', error_code = $2, next_retry_at = null where id = $1::uuid", [attempt.id, reason]);
    this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: 'suppressed' });
    await this.moveOn(tx, notification, attempt, now);
  }

  /** BR-NOT-08: every urgent send inside the quiet hours of its recipient leaves an audit row, in the transaction that takes the send up. */
  private async recordOverride(tx: TenantTx, notification: LockedNotification, attempt: AttemptRecord, quietEndsAt: Date | undefined, now: Date): Promise<void> {
    await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
      action: 'notification.quiet_hours_override',
      resourceType: 'notification',
      resourceId: notification.id,
      diff: { channel: attempt.channel, attempt_no: attempt.attemptNo, priority: notification.priority, sent_at: now.toISOString(), quiet_ends_at: quietEndsAt?.toISOString() ?? null },
      correlationId: randomUUID(),
      requestId: randomUUID(),
    });
    this.metrics.increment(QUIET_HOURS_OVERRIDE_METRIC, { channel: attempt.channel });
  }

  /** Records what the adapter answered to the send (BR-NOT-03, BR-NOT-04). A result for a send that is no longer Sending is ignored. */
  async recordSendResult(tx: TenantTx, attemptId: string, result: ChannelSendResult, now: Date): Promise<ResultNext> {
    const notificationId = await this.store.notificationOf(tx, attemptId);
    if (notificationId === undefined) return 'IGNORED';
    const notification = await this.store.lockNotification(tx, notificationId);
    const attempt = await this.store.lockAttempt(tx, attemptId);
    if (notification === undefined || attempt === undefined || attempt.status !== 'Sending') return 'IGNORED';
    const ref = await this.refOf(tx, attempt.id);
    if (result.kind === 'ACCEPTED') {
      await tx.query(
        "update machvon.delivery_attempt set status = 'ProviderAccepted', provider_message_id = $2, accepted_at = $3::timestamptz, error_code = null, failure_class = null where id = $1::uuid",
        [attempt.id, result.providerMessageId, now.toISOString()],
      );
      await this.callbacks.recordResponse(tx, { ref, table: itemTable, status: 'ACCEPTED', occurredAt: now, metrics: this.metrics });
      await this.store.circuitSuccess(tx, attempt.channelAccountId);
      await this.store.syncNotification(tx, notification);
      this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: 'accepted' });
      this.metrics.gauge(DELIVERY_LATENCY_METRIC, Math.max(0, (now.getTime() - attempt.createdAt.getTime()) / 1000), { channel: attempt.channel });
      return 'ACCEPTED';
    }
    if (result.kind === 'UNKNOWN') {
      await tx.query(
        "update machvon.delivery_attempt set status = 'Unknown', failure_class = 'UNKNOWN', error_code = $2, unknown_at = $3::timestamptz, failed_at = $3::timestamptz where id = $1::uuid",
        [attempt.id, result.errorCode, now.toISOString()],
      );
      await this.callbacks.markUncertain(tx, { ref, table: itemTable, correlationId: attempt.id, detail: result.errorCode, now });
      await this.store.circuitFailure(tx, attempt.channelAccountId, now);
      await this.store.syncNotification(tx, notification);
      this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: 'unknown' });
      return 'UNKNOWN';
    }
    await this.failAttempt(tx, attempt, ref, result.failureClass, result.errorCode, now);
    this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: result.failureClass === 'RETRYABLE' ? 'failed_retryable' : 'failed_permanent' });
    return await this.afterFailure(tx, notification, attempt, result.failureClass, result.retryAfterSeconds, now);
  }

  /** A send that was taken up and never reported back is a result that was lost: Unknown, never sent again on its own. */
  async markLost(tx: TenantTx, attemptId: string, now: Date): Promise<boolean> {
    const outcome = await this.recordSendResult(tx, attemptId, { kind: 'UNKNOWN', errorCode: 'SEND_RESULT_LOST' }, now);
    return outcome === 'UNKNOWN';
  }

  /**
   * Applies what the provider says about a send whose result was lost. A send the provider holds moves to the status it reports (and the
   * reconciliation task closes); a send the provider has never seen is a failed send that may be retried; a provider that cannot tell leaves it Unknown.
   */
  async reconcile(tx: TenantTx, attemptId: string, lookup: ChannelLookupResult, now: Date): Promise<'RESOLVED' | 'RETRIED' | 'UNCHANGED'> {
    if (lookup.kind === 'UNDETERMINED') return 'UNCHANGED';
    const notificationId = await this.store.notificationOf(tx, attemptId);
    if (notificationId === undefined) return 'UNCHANGED';
    const notification = await this.store.lockNotification(tx, notificationId);
    const attempt = await this.store.lockAttempt(tx, attemptId);
    if (notification === undefined || attempt === undefined || attempt.status !== 'Unknown') return 'UNCHANGED';
    if (lookup.kind === 'FOUND') {
      await this.resolveUncertainty(tx, notification, attempt, lookup.status, lookup.providerMessageId, now);
      return 'RESOLVED';
    }
    // The provider has no such request: nothing was sent, so the send is a failed one that the schedule may repeat.
    const ref = await this.refOf(tx, attempt.id);
    await this.callbacks.recordResponse(tx, { ref, table: itemTable, status: 'FAILED', occurredAt: now, metrics: this.metrics });
    await this.closeTask(tx, ref);
    await tx.query("update machvon.delivery_attempt set status = 'Failed', failure_class = 'RETRYABLE', error_code = 'NOT_FOUND_AT_PROVIDER', failed_at = $2::timestamptz where id = $1::uuid", [attempt.id, now.toISOString()]);
    await this.afterFailure(tx, notification, attempt, 'RETRYABLE', undefined, now);
    return 'RETRIED';
  }

  /**
   * Applies one callback of a provider to the send it names. The reducer of KERNEL-1 decides: only a later status moves the send, a repeat or a late
   * callback changes nothing and adds no history, a callback that contradicts the send opens a reconciliation task. A message id that is not known
   * is 404, so the inbox keeps the event and tries it again later.
   */
  async applyCallback(tx: TenantTx, input: CallbackInput): Promise<'APPLIED' | 'DUPLICATE' | 'STALE' | 'CONFLICT' | 'UNKNOWN_STATUS' | 'ALREADY_PROCESSED'> {
    const found = await this.store.attemptByProviderMessage(tx, input.channelAccountId, input.providerMessageId);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const notification = await this.store.lockNotification(tx, found.notificationId);
    const attempt = await this.store.lockAttempt(tx, found.id);
    if (notification === undefined || attempt === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const ref = await this.refOf(tx, attempt.id);
    const applied = await this.callbacks.applyEvent(tx, { inboxId: input.inboxId, ref, table: itemTable, status: input.status, occurredAt: input.occurredAt, metrics: this.metrics });
    if (applied.outcome === 'STALE' || applied.outcome === 'CONFLICT') this.metrics.increment(OUT_OF_ORDER_METRIC, { channel: attempt.channel });
    if (applied.outcome === 'APPLIED') await this.resolveUncertainty(tx, notification, attempt, input.status, undefined, input.occurredAt, true);
    return applied.outcome;
  }

  /**
   * Replays a notification that ended Failed or Unknown (NOT 3.6): the consent and access of the recipient are checked again when each send is
   * taken up; here the notification must still be open (not expired), its recipient a member, and an Unknown send must have been reconciled for a
   * day first (409 RECONCILE_REQUIRED). The new send continues the numbering of its channel; a channel that has had its five sends starts a new
   * notification instead (dedupe key of "replay:<id>:<n>"), so no channel is ever sent to more than five times per notification.
   */
  async replay(tx: TenantTx, input: ReplayInput): Promise<ReplayResult> {
    const notification = await this.store.requireNotification(tx, input.notificationId);
    if (notification.version !== input.expectedVersion) throw versionConflict(notification.version);
    if (notification.status !== 'Failed' && notification.status !== 'Unknown') throw new DomainError('NOTIFICATION_STATE_INVALID', 409);
    if (notification.expiresAt.getTime() <= input.now.getTime()) throw new DomainError('NOTIFICATION_EXPIRED', 409);
    const attempts = await this.store.attemptsOf(tx, notification.id);
    const waiting = attempts.some((attempt) => attempt.status === 'Unknown' && attempt.unknownAt !== null && attempt.unknownAt.getTime() + RECONCILE_WINDOW_SECONDS * 1000 > input.now.getTime());
    if (waiting) throw new DomainError('RECONCILE_REQUIRED', 409);
    const root = notification.replayOf ?? notification.id;
    const [later] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.notification_instance where replay_of = $1::uuid and coalesce(replay_seq, 0) > $2', [root, notification.replaySeq ?? 0]);
    if (Number(later?.n ?? 0) > 0) throw new DomainError('NOTIFICATION_STATE_INVALID', 409);
    const [member] = await tx.query<{ ok: boolean }>(
      "select (status = 'Active' and valid_from <= $2::timestamptz and (valid_until is null or valid_until > $2::timestamptz)) as ok from machvon.membership where id = $1::uuid",
      [notification.recipientId, input.now.toISOString()],
    );
    if (member?.ok !== true) throw new DomainError('NOTIFICATION_STATE_INVALID', 409, 'RECIPIENT_INACTIVE');

    const external = externalChannelsOf(notification.channelPlan);
    // An Unknown notification is replayed on the channel that may already have sent it; a Failed one starts again from the top of its plan.
    const unknownChannel = attempts.find((attempt) => attempt.status === 'Unknown')?.channel;
    const channels = unknownChannel === undefined ? external : external.slice(Math.max(0, external.indexOf(unknownChannel)));
    const startChannel = channels[0];
    if (startChannel === undefined) throw new DomainError('NOTIFICATION_STATE_INVALID', 409, 'NO_CHANNEL_AVAILABLE');
    if ((await this.store.nextAttemptNo(tx, notification.id, startChannel)) <= MAX_ATTEMPTS_PER_CHANNEL) {
      const channel = await this.queueFrom(tx, notification, channels, 'next');
      if (channel === undefined) throw new DomainError('NOTIFICATION_STATE_INVALID', 409, 'NO_CHANNEL_AVAILABLE');
      await tx.query('update machvon.notification_instance set cancel_requested_at = null where id = $1::uuid', [notification.id]);
      await this.store.syncNotification(tx, notification);
      const [moved] = await tx.query<{ version: string }>('select version::text as version from machvon.notification_instance where id = $1::uuid', [notification.id]);
      return { notificationId: notification.id, version: Number(moved?.version ?? notification.version), startedNewChain: false, channel };
    }
    return await this.startReplayChain(tx, notification, root, channels, input);
  }

  private async startReplayChain(tx: TenantTx, original: LockedNotification, root: string, channels: readonly string[], input: ReplayInput): Promise<ReplayResult> {
    const [seq] = await tx.query<{ n: number }>('select coalesce(max(replay_seq), 0) + 1 as n from machvon.notification_instance where replay_of = $1::uuid', [root]);
    const replaySeq = seq?.n ?? 1;
    const dedupeKey = this.dedupeKeyOf({ tenantId: input.tenantId, sourceEventId: `replay:${root}:${replaySeq}`, recipientId: original.recipientId, purpose: original.purpose });
    const [created] = await tx.query<{ id: string }>(
      `insert into machvon.notification_instance
         (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, event_version, priority, ack_required,
          channel_plan, replay_of, replay_seq)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, 'Queued', $7, $8, $9, $10,
          $11::text[], $12::uuid, $13)
       returning id`,
      [
        original.eventId,
        original.workflowVersionId,
        original.recipientId,
        original.purpose,
        dedupeKey,
        original.expiresAt.toISOString(),
        original.sourceEventType,
        original.eventVersion,
        original.priority,
        original.ackRequired,
        [...channels],
        root,
        replaySeq,
      ],
    );
    if (created === undefined) throw new Error('replay notification not inserted');
    const fresh = await this.store.requireNotification(tx, created.id);
    const channel = await this.queueFrom(tx, fresh, channels, 1);
    if (channel === undefined) throw new DomainError('NOTIFICATION_STATE_INVALID', 409, 'NO_CHANNEL_AVAILABLE');
    // The original keeps its Failed or Unknown record; its version moves so a stale view of it cannot replay it again.
    await this.store.moveNotification(tx, original.id, original.status);
    return { notificationId: fresh.id, version: fresh.version, startedNewChain: true, channel };
  }

  /**
   * Cancels what has not gone out (NOT 3.6): the sends that are waiting are Cancelled, and a notification that had nothing in flight or delivered is
   * Cancelled. Once a provider has accepted something, or a send is in flight, the notification keeps its status and only the request is recorded.
   */
  async cancel(tx: TenantTx, input: CancelInput): Promise<CancelResult> {
    const notification = await this.store.requireNotification(tx, input.notificationId);
    if (notification.version !== input.expectedVersion) throw versionConflict(notification.version);
    if (['Failed', 'Unknown', 'Expired', 'Cancelled', 'Suppressed'].includes(notification.status)) throw new DomainError('NOTIFICATION_STATE_INVALID', 409);
    const cancelled = await tx.query<{ id: string; channel: string }>(
      "update machvon.delivery_attempt set status = 'Cancelled', error_code = 'CANCELLED' where notification_id = $1::uuid and status = 'Queued' returning id, channel",
      [notification.id],
    );
    cancelled.forEach((row) => this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: row.channel, outcome: 'cancelled' }));
    // A notification that is only waiting for a retry is still "Sending" (an earlier send failed and the next one is queued): once the waiting sends are
    // cancelled nothing is in flight or delivered any more, and nobody would ever move it on, so it ends Cancelled like one that never went out.
    const nothingOut = ['Created', 'Scheduled', 'Queued'].includes(notification.status) || (notification.status === 'Sending' && (await this.nothingInFlight(tx, notification.id)));
    if (nothingOut) {
      await this.store.moveNotification(tx, notification.id, 'Cancelled');
    } else {
      await tx.query('update machvon.notification_instance set cancel_requested_at = $2::timestamptz, version = version + 1 where id = $1::uuid', [notification.id, input.now.toISOString()]);
    }
    return { outcome: nothingOut ? 'CANCELLED' : 'CANCEL_REQUESTED', version: notification.version + 1, cancelledAttempts: cancelled.length };
  }

  /** Whether no send of the notification is in flight, uncertain or accepted by a provider: every attempt it has is over without reaching the person. */
  private async nothingInFlight(tx: TenantTx, notificationId: string): Promise<boolean> {
    const [row] = await tx.query<{ n: string }>(
      "select count(*)::text as n from machvon.delivery_attempt where notification_id = $1::uuid and status in ('Sending', 'Unknown', 'ProviderAccepted', 'Delivered', 'Read')",
      [notificationId],
    );
    return Number(row?.n ?? 0) === 0;
  }

  // The steps that follow a failed send.

  private async failAttempt(tx: TenantTx, attempt: AttemptRecord, ref: ProviderItemRef, failureClass: FailureClass, errorCode: string, now: Date): Promise<void> {
    await tx.query("update machvon.delivery_attempt set status = 'Failed', failure_class = $2, error_code = $3, failed_at = $4::timestamptz where id = $1::uuid", [
      attempt.id,
      failureClass,
      errorCode,
      now.toISOString(),
    ]);
    await this.callbacks.recordResponse(tx, { ref, table: itemTable, status: 'FAILED', occurredAt: now, metrics: this.metrics });
    // Only a failure that says the provider is in trouble counts against its circuit. A refusal about one recipient (no address, an address the provider
    // rejects, a template that does not render) is the same on a healthy provider; counting it would let twenty bad addresses stop every message of the account.
    if (failureClass === 'RETRYABLE') await this.store.circuitFailure(tx, attempt.channelAccountId, now);
    else await this.store.circuitProbeUndecided(tx, attempt.channelAccountId);
  }

  /** What follows a failed send: another send on the schedule, the next channel of the plan, or the end of the chain. */
  private async afterFailure(tx: TenantTx, notification: LockedNotification, attempt: AttemptRecord, failureClass: FailureClass, retryAfterSeconds: number | undefined, now: Date): Promise<ResultNext> {
    // A cancel that came while the send was in flight stops the chain; so does a send that is no longer the newest of its notification.
    if (notification.cancelRequestedAt !== null || !(await this.isNewest(tx, attempt))) {
      await this.store.syncNotification(tx, notification);
      return 'FAILED';
    }
    if (failureClass === 'RETRYABLE') {
      const decision = decideRetry({ attemptNo: attempt.attemptNo, failedAt: now, expiresAt: notification.expiresAt, retryAfterSeconds, ...(this.random === undefined ? {} : { random: this.random }) });
      if (decision.kind === 'RETRY') {
        await this.store.insertAttempt(tx, notification.id, attempt.channel, attempt.channelAccountId, attempt.templateVersionId, attempt.attemptNo + 1, decision.at);
        await this.store.syncNotification(tx, notification);
        return 'RETRY';
      }
      if (decision.kind === 'EXPIRED') {
        await this.expire(tx, notification);
        return 'EXPIRED';
      }
    }
    return await this.moveOn(tx, notification, attempt, now);
  }

  /** The channel of the attempt is done (exhausted, permanently failed or suppressed): the next channel of the plan, or the end of the chain. */
  private async moveOn(tx: TenantTx, notification: LockedNotification, attempt: AttemptRecord, now: Date): Promise<ResultNext> {
    if (notification.expiresAt.getTime() <= now.getTime()) {
      await this.expire(tx, notification);
      return 'EXPIRED';
    }
    const external = externalChannelsOf(notification.channelPlan);
    const next = external.slice(external.indexOf(attempt.channel) + 1);
    const channel = notification.cancelRequestedAt === null ? await this.queueFrom(tx, notification, next, 1) : undefined;
    if (channel !== undefined) {
      await this.store.syncNotification(tx, notification);
      return 'FALLBACK';
    }
    await this.finishChain(tx, notification);
    return 'FAILED';
  }

  /** No channel is left. A notification that was delivered in the application keeps its status; one that was only suppressed is Suppressed, otherwise Failed or Unknown. */
  private async finishChain(tx: TenantTx, notification: LockedNotification): Promise<void> {
    const status = await this.store.syncNotification(tx, notification);
    if (status !== notification.status || !['Created', 'Scheduled', 'Queued', 'Sending'].includes(status)) return;
    const attempts = await this.store.attemptsOf(tx, notification.id);
    if (attempts.every((attempt) => attempt.status === 'Suppressed' || attempt.status === 'Cancelled')) {
      await this.store.moveNotification(tx, notification.id, 'Suppressed', attempts.find((attempt) => attempt.status === 'Suppressed')?.errorCode ?? 'NO_CHANNEL_AVAILABLE');
    }
  }

  private async expire(tx: TenantTx, notification: LockedNotification): Promise<void> {
    if (['Created', 'Scheduled', 'Queued', 'Sending'].includes(notification.status)) await this.store.moveNotification(tx, notification.id, 'Expired');
    else await this.store.syncNotification(tx, notification);
  }

  private async cancelAttempt(tx: TenantTx, attempt: AttemptRecord, reason: string): Promise<void> {
    await tx.query("update machvon.delivery_attempt set status = 'Cancelled', error_code = $2 where id = $1::uuid", [attempt.id, reason]);
    this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: 'cancelled' });
  }

  /** Whether no send of the notification was made after this one. */
  private async isNewest(tx: TenantTx, attempt: AttemptRecord): Promise<boolean> {
    // Compared in the database: a JavaScript date holds milliseconds and the column holds microseconds, so the attempt would count itself.
    const [row] = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.delivery_attempt later join machvon.delivery_attempt this on this.id = $1::uuid
        where later.notification_id = this.notification_id and (later.created_at, later.id) > (this.created_at, this.id)`,
      [attempt.id],
    );
    return Number(row?.n ?? 0) === 0;
  }

  // The steps that follow a result that comes after the fact (a callback, or the answer of the provider to a question).

  /**
   * A send moved forward on the word of the provider: the columns of the attempt follow the status of the item, the reconciliation task of a lost result
   * closes, a failure reported by the provider moves the plan on, and the notification takes the status its attempts give it.
   */
  private async resolveUncertainty(
    tx: TenantTx,
    notification: LockedNotification,
    attempt: AttemptRecord,
    status: DeliveryStatus,
    providerMessageId: string | undefined,
    occurredAt: Date,
    itemAlreadyMoved = false,
  ): Promise<void> {
    const ref = await this.refOf(tx, attempt.id);
    if (!itemAlreadyMoved) await this.callbacks.recordResponse(tx, { ref, table: itemTable, status, occurredAt, metrics: this.metrics });
    await this.closeTask(tx, ref);
    const stamp = occurredAt.toISOString();
    if (status === 'FAILED') {
      await tx.query(
        // A send of unknown result carries the class UNKNOWN, which a Failed send may not (delivery_attempt_failed_chk): the provider's word makes it a refusal.
        `update machvon.delivery_attempt
            set status = 'Failed', failure_class = case when failure_class in ('RETRYABLE', 'PERMANENT') then failure_class else 'PERMANENT' end,
                error_code = case when status = 'Unknown' then 'PROVIDER_REPORTED_FAILURE' else coalesce(error_code, 'PROVIDER_REPORTED_FAILURE') end,
                failed_at = coalesce(failed_at, $2::timestamptz), provider_message_id = coalesce(provider_message_id, $3)
          where id = $1::uuid and status <> 'Failed'`,
        [attempt.id, stamp, providerMessageId ?? null],
      );
      this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: 'failed_permanent' });
      await this.afterFailure(tx, notification, attempt, 'PERMANENT', undefined, occurredAt);
      return;
    }
    const target = attemptStatusOf(status);
    await tx.query(
      `update machvon.delivery_attempt
          set status = $2, provider_message_id = coalesce(provider_message_id, $3),
              accepted_at = coalesce(accepted_at, $4::timestamptz), delivered_at = case when $2 in ('Delivered', 'Read') then coalesce(delivered_at, $4::timestamptz) else delivered_at end,
              read_at = case when $2 = 'Read' then coalesce(read_at, $4::timestamptz) else read_at end
        where id = $1::uuid`,
      [attempt.id, target, providerMessageId ?? null, stamp],
    );
    await this.store.circuitSuccess(tx, attempt.channelAccountId);
    this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: attempt.channel, outcome: target === 'ProviderAccepted' ? 'accepted' : target.toLowerCase() });
    if (target === 'Delivered' || target === 'Read') {
      // The message reached the person (it may have been reported failed first and delivered late): a retry or a next channel that the failure queued is no
      // longer wanted, and on a paid channel it would be a second message.
      const waiting = await tx.query<{ channel: string }>("update machvon.delivery_attempt set status = 'Cancelled', error_code = 'DELIVERED_LATE' where notification_id = $1::uuid and status = 'Queued' returning channel", [notification.id]);
      waiting.forEach((row) => this.metrics.increment(DELIVERY_ATTEMPTS_METRIC, { channel: row.channel, outcome: 'cancelled' }));
    }
    await this.store.syncNotification(tx, notification);
  }

  /** Closes the reconciliation task of a send whose result was lost, once the item has left UNCERTAIN: the engine itself resolves it, as no person is behind it. */
  private async closeTask(tx: TenantTx, ref: ProviderItemRef): Promise<void> {
    const [task] = await tx.query<{ id: string }>(
      `select t.id from machvon.provider_reconciliation_task t join machvon.provider_status_item i on i.tenant_id = t.tenant_id and i.id = t.item_id
        where i.subject_type = $1 and i.subject_id = $2::uuid and t.reason = 'RESULT_UNCERTAIN' and t.status = 'OPEN'`,
      [ref.subjectType, ref.subjectId],
    );
    if (task === undefined) return;
    const item = await this.callbacks.find(tx, ref);
    if (item === undefined) return;
    await this.callbacks.resolveTask(tx, { taskId: task.id, table: itemTable, status: item.status, note: RESOLVED_BY_PROVIDER, resolvedBy: WORKER_MEMBERSHIP_ID });
  }

  private async refOf(tx: TenantTx, attemptId: string): Promise<ProviderItemRef> {
    const [row] = await tx.query<{ provider: string }>('select provider from machvon.provider_status_item where subject_type = $1 and subject_id = $2::uuid', [ATTEMPT_SUBJECT_TYPE, attemptId]);
    if (row === undefined) throw new Error('attempt without its status item');
    return { provider: row.provider, subjectType: ATTEMPT_SUBJECT_TYPE, subjectId: attemptId };
  }
}
