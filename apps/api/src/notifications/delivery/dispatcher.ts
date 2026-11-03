import { DeliveryStore, DeviceRegistrationStore, NotificationStore } from '@machvon/db';
import type { ClaimedSend, DeliveryEngine, TenantDatabase, TenantTx } from '@machvon/db';
import { CREDENTIAL_EXPIRED_CODE, DomainError, NOOP_ALERTS, NOOP_METRICS, PLATFORMS_OF_CHANNEL, asUuid, activationBlock, isPushDeliveryChannel, opaqueLinkOf } from '@machvon/kernel';
import type { AlertSink, ChannelAdapter, ChannelSendResult, EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import type { PushTokenVault } from '../devices/push-vault';
import { withCurrentOwnerPath } from '../notifications.controller';
import type { ResourceAccessPort } from '../resource-access-port';
import type { ChannelAdapterRegistry } from './channel-adapters';
import { renderTemplate, variablesOf } from './template-renderer';

/** The most devices one push send goes through when the owner's token turns out dead: the owner, then whoever is the owner after it was revoked. */
const OWNER_TURNS = 3;

/** Raised when a circuit breaker has stayed open for ten minutes (NOT 9). */
export const CHANNEL_CIRCUIT_OPEN_ALERT = 'CHANNEL_CIRCUIT_OPEN';
export const DLQ_GAUGE = 'notification_dlq_gauge';
export const UNKNOWN_OLDEST_GAUGE = 'notification_unknown_oldest_seconds';

/** An adapter that does not answer within this long is treated as a request that may have been made (Unknown). */
export const ADAPTER_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH = 50;
const DEFAULT_CONCURRENCY = 5;
const WORK_LIMIT = 100;
export const OMNI_CHANNEL_CREDENTIAL_EXPIRED_ALERT = 'OMNI_CHANNEL_CREDENTIAL_EXPIRED';

/** A tenant with nothing to send has its gauges and alerts refreshed this often. */
const QUIET_REPORT_MS = 60_000;

export interface DispatcherDeps {
  database: TenantDatabase;
  engine: DeliveryEngine;
  adapters: ChannelAdapterRegistry;
  /** Loads the access a recipient holds now (EffectiveAccessStore.load): checked again at the moment of each send (BR-NOT-13). */
  loadAccess: (ctx: TenantContext) => Promise<EffectiveAccess>;
  resourceAccess: ResourceAccessPort;
  metrics?: MetricsSink;
  alerts?: AlertSink;
  now?: () => Date;
  /** Sends taken up per channel and pass. */
  batch?: number;
  /** Sends of one channel in flight at the same time. */
  concurrency?: number;
  adapterTimeoutMs?: number;
  /** Where the push tokens of the devices are (ST-NOT-007); without it a push cannot be addressed and its sends fail for good (VAULT_MISSING). */
  pushTokens?: PushTokenVault;
  /** The messages that agents queued in conversations (ST-OMNI-005) go out in the same pass; a failure there does not hold back the notifications, and the other way round. */
  conversations?: { run(ctx: TenantContext): Promise<number> };
}

export interface DispatchResult {
  /** Sends handed to an adapter. */
  sent: number;
  /** Sends not made because the recipient or the channel did not qualify (no access, no consent, a preference that says no). */
  suppressed: number;
  /** Sends that wait for the quiet hours of their recipient to end. */
  deferred: number;
}

export interface ReconcileResult {
  lost: number;
  resolved: number;
  retried: number;
}

/** The statuses of an adapter that stop its channel from sending, as the reason an attempt is suppressed. */
function blockedReason(adapter: ChannelAdapter | undefined, environment: string | undefined): string | undefined {
  if (adapter === undefined) return 'ADAPTER_MISSING';
  const block = activationBlock(adapter.status, environment);
  return block === undefined ? undefined : block;
}

/**
 * The dispatcher of the delivery engine (NOT 3.1 step 6, NOT 9): one pass takes the due sends of each channel, checks again that the recipient may
 * still receive them, claims each one in a transaction of its own (Sending), calls the adapter with no transaction open and records the answer. A
 * channel is a bulkhead: its sends run on their own, so a slow or failing provider holds back its own channel only. The call to a provider never
 * happens inside a business command: a command writes to the outbox and returns, and the message goes out here, later (BR-NOT-16).
 */
export class DeliveryDispatcher {
  private readonly store = new DeliveryStore();
  private readonly notifications = new NotificationStore();
  private readonly devices = new DeviceRegistrationStore();
  private readonly metrics: MetricsSink;
  private readonly alerts: AlertSink;
  private readonly now: () => Date;
  private readonly batch: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly reportedAt = new Map<string, number>();

  constructor(
    private readonly deps: DispatcherDeps,
    private readonly environment: string | undefined,
  ) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.alerts = deps.alerts ?? NOOP_ALERTS;
    this.now = deps.now ?? (() => new Date());
    this.batch = deps.batch ?? DEFAULT_BATCH;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.timeoutMs = deps.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS;
  }

  /** One pass for a tenant: every channel with sends due is served at the same time, and a failure on one channel does not stop the others. */
  async dispatchDue(ctx: TenantContext): Promise<DispatchResult> {
    const now = this.now();
    const channels = await this.deps.database.withTenant(ctx, (tx) => this.store.channelsWithWork(tx, now));
    const settled = await Promise.allSettled([
      ...channels.map((channel) => this.dispatchChannel(ctx, channel, now)),
      ...(this.deps.conversations === undefined ? [] : [this.deps.conversations.run(ctx).then((): DispatchResult => ({ sent: 0, suppressed: 0, deferred: 0 }))]),
    ]);
    const total: DispatchResult = { sent: 0, suppressed: 0, deferred: 0 };
    let failure: unknown;
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        total.sent += outcome.value.sent;
        total.suppressed += outcome.value.suppressed;
        total.deferred += outcome.value.deferred;
      } else {
        failure ??= outcome.reason;
      }
    }
    // A pass with sends to make always reports; an idle tenant reports once a minute, not every five seconds.
    if (channels.length > 0 || now.getTime() - (this.reportedAt.get(ctx.tenantId) ?? 0) >= QUIET_REPORT_MS) {
      this.reportedAt.set(ctx.tenantId, now.getTime());
      await this.report(ctx, now);
    }
    // The channels that could be served were; the one that failed is reported to the job runner after the rest have run.
    if (failure !== undefined) throw failure;
    return total;
  }

  private async dispatchChannel(ctx: TenantContext, channel: string, now: Date): Promise<DispatchResult> {
    const due = await this.deps.database.withTenant(ctx, (tx) => this.store.dueAttempts(tx, channel, now, this.batch));
    const result: DispatchResult = { sent: 0, suppressed: 0, deferred: 0 };
    const adapter = this.deps.adapters.forChannel(channel);
    const blocked = blockedReason(adapter, this.environment);
    for (let from = 0; from < due.length; from += this.concurrency) {
      const chunk = due.slice(from, from + this.concurrency);
      const outcomes = await Promise.all(chunk.map((attempt) => (blocked !== undefined || adapter === undefined ? this.suppress(ctx, attempt.id, blocked ?? 'ADAPTER_MISSING', now) : this.sendOne(ctx, adapter, attempt, now))));
      for (const outcome of outcomes) result[outcome] += 1;
    }
    return result;
  }

  private async suppress(ctx: TenantContext, attemptId: string, reason: string, now: Date): Promise<'suppressed'> {
    await this.deps.database.withTenant(ctx, (tx) => this.deps.engine.suppress(tx, attemptId, reason, now));
    return 'suppressed';
  }

  /** The recipient may receive the message now: still a member, and still able to read what it is about (BR-NOT-13). */
  private async preflight(ctx: TenantContext, notificationId: string): Promise<string | undefined> {
    const row = await this.deps.database.withTenant(ctx, (tx) => this.notifications.findAny(tx, notificationId));
    if (row === undefined) return 'NOTIFICATION_MISSING';
    const recipient = asUuid(row.recipientId);
    if (recipient === undefined) return 'RECIPIENT_INVALID';
    const access = await this.deps.loadAccess({ tenantId: ctx.tenantId, membershipId: recipient, scopeVersion: 0 });
    if (!access.membershipActive) return 'RECIPIENT_INACTIVE';
    const resource = row.ref?.resource;
    if (resource === undefined) return undefined;
    const paths = await this.deps.database.withTenant(ctx, (tx) => this.notifications.currentUnitPaths(tx, [resource.ownerUnitId, resource.investorUnitId].flatMap((unit) => (unit === undefined ? [] : [unit]))));
    return this.deps.resourceAccess.canRead(access, withCurrentOwnerPath(resource, paths), this.now()) ? undefined : 'NO_ACCESS';
  }

  private async sendOne(ctx: TenantContext, adapter: ChannelAdapter, due: { id: string; notificationId: string }, now: Date): Promise<'sent' | 'suppressed' | 'deferred'> {
    const refusal = await this.preflight(ctx, due.notificationId);
    if (refusal !== undefined) return await this.suppress(ctx, due.id, refusal, now);
    // A channel that is closed for the moment (the sending hours of a text) takes nothing: the message waits for the hours to open, with no attempt used and nothing charged.
    const opens = adapter.closedUntil?.(now);
    if (opens !== undefined) {
      // A notification that is closed or past its expiry is not put back: it goes on to the claim, which closes it, instead of being due on every round until the morning.
      const deferred = await this.deps.database.withTenant(ctx, (tx) => this.deps.engine.deferAttempt(tx, due.id, opens, 'OUTSIDE_SENDING_HOURS', now));
      if (deferred) return 'deferred';
    }
    const claimed = await this.deps.database.withTenant(ctx, (tx) => this.deps.engine.claim(tx, due.id, adapter.provider, now));
    if (claimed.kind === 'SKIPPED') return claimed.reason === 'DEFERRED' ? 'deferred' : 'suppressed';
    const result = await this.call(ctx, adapter, claimed.send);
    await this.deps.database.withTenant(ctx, (tx) => this.deps.engine.recordSendResult(tx, due.id, result, this.now()));
    // The provider gave up on the credential: the account stopped being used, and a supervisor has to put a new one in the vault and verify the account again.
    if (result.kind === 'FAILED' && result.errorCode === CREDENTIAL_EXPIRED_CODE) this.alerts.raise(OMNI_CHANNEL_CREDENTIAL_EXPIRED_ALERT, { tenantId: ctx.tenantId, channelAccountId: claimed.send.attempt.channelAccountId, channel: claimed.send.attempt.channel });
    return 'sent';
  }

  /** Makes the call. Anything that goes wrong after the request may have left is Unknown; anything before it is a failure of this send alone. */
  private async call(ctx: TenantContext, adapter: ChannelAdapter, send: ClaimedSend): Promise<ChannelSendResult> {
    if (isPushDeliveryChannel(send.attempt.channel)) return this.callPush(ctx, adapter, send);
    let request: Parameters<ChannelAdapter['send']>[0];
    try {
      const to = await this.deps.database.withTenant(ctx, (tx) => this.addressOf(tx, send.notification.recipientId, send.attempt.channel));
      if (to === undefined) return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'NO_ADDRESS' };
      const message = renderTemplate(send.template.contentAst, send.template.variableSchema, variablesOf(send.eventPayload));
      request = { idempotencyKey: send.idempotencyKey, accountId: send.accountId, to, text: message.text, ...(message.subject === undefined ? {} : { subject: message.subject }) };
    } catch (error) {
      return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: error instanceof DomainError && error.code === 'TEMPLATE_INVALID' ? 'TEMPLATE_RENDER_FAILED' : 'SEND_PREPARATION_FAILED' };
    }
    return this.invoke(adapter, request);
  }

  /** Makes the call of the adapter within the time it is given. */
  private async invoke(adapter: ChannelAdapter, request: Parameters<ChannelAdapter['send']>[0]): Promise<ChannelSendResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<ChannelSendResult>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'UNKNOWN', errorCode: 'ADAPTER_TIMEOUT' }), this.timeoutMs);
      });
      return await Promise.race([adapter.send(request), timeout]);
    } catch {
      // The adapter failed in a way it did not classify: the request may have been made, so it is not repeated on its own.
      return { kind: 'UNKNOWN', errorCode: 'ADAPTER_ERROR' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A push (ST-NOT-007, ST-MOB-031): to the owner device of the recipient, with its token read from the vault for this call, a neutral sentence and an opaque link. A person with several devices is pushed on ONE of them - the device they used last that can be
   * pushed to (`DeviceRegistrationStore.pushOwner`) - so that one event does not ring everywhere; the inbox holds it for all of them. The owner is chosen across the platforms: when it is not of the platform this channel reaches, the channel finds no device
   * (the other push channel serves it). The sentence is the literal text of the template: no variable of the event is filled in, so nothing about the record the notification is about reaches a lock screen, and the link names the notification only (opening it
   * asks for the permission of the moment). A device the provider no longer knows is revoked with its token once the answer is in, and the send goes on to the device that is the owner then - the next one in line - so that a dead phone does not cost the person the
   * notification. At most `OWNER_TURNS` devices are tried in one send.
   */
  private async callPush(ctx: TenantContext, adapter: ChannelAdapter, send: ClaimedSend): Promise<ChannelSendResult> {
    const vault = this.deps.pushTokens;
    if (vault === undefined) return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'VAULT_MISSING' };
    const platforms = PLATFORMS_OF_CHANNEL[send.attempt.channel] ?? [];
    let last: ChannelSendResult | undefined;
    for (let turn = 0; turn < OWNER_TURNS; turn += 1) {
      let request: Parameters<ChannelAdapter['send']>[0];
      let ownerId: string;
      // The reference the token was read under: a refusal revokes that token's registration only if it still holds it.
      let ownerRef: string;
      try {
        const owner = await this.deps.database.withTenant(ctx, (tx) => this.devices.pushOwner(tx, send.notification.recipientId));
        if (owner === undefined || !platforms.includes(owner.platform)) return last ?? { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'NO_DEVICE' };
        let token: string | undefined;
        try {
          token = await vault.read(owner.secretRef);
        } catch {
          // The vault is not answering: nothing was sent and the vault is the reason, a pause and not the end of the notification.
          return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'VAULT_UNAVAILABLE' };
        }
        if (token === undefined) return last ?? { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'NO_DEVICE' };
        ownerId = owner.id;
        ownerRef = owner.secretRef;
        const message = renderTemplate(send.template.contentAst, send.template.variableSchema, {});
        request = { idempotencyKey: send.idempotencyKey, accountId: send.accountId, to: 'devices', text: message.text, targets: [{ deviceId: owner.id, token }], deepLink: opaqueLinkOf(send.notification.id) };
      } catch (error) {
        return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: error instanceof DomainError && error.code === 'TEMPLATE_INVALID' ? 'TEMPLATE_RENDER_FAILED' : 'SEND_PREPARATION_FAILED' };
      }
      const result = await this.invoke(adapter, request);
      const dead = (result.kind === 'ACCEPTED' || result.kind === 'FAILED') && result.deadTargets !== undefined && result.deadTargets.includes(ownerId);
      if (dead) await this.dropDeadDevices(ctx, vault, [{ id: ownerId, secretRef: ownerRef }]);
      // The owner's token is dead for good: the next device in line is the owner now.
      if (dead && result.kind === 'FAILED' && result.failureClass === 'PERMANENT') {
        last = result;
        continue;
      }
      return result;
    }
    return last ?? { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'NO_DEVICE' };
  }

  /** The devices whose token the provider refused for good are revoked and their tokens leave the vault. A failure here never undoes the answer of the send, which is already in. */
  private async dropDeadDevices(ctx: TenantContext, vault: PushTokenVault, dead: ReadonlyArray<{ id: string; secretRef: string }>): Promise<void> {
    try {
      const refs = await this.deps.database.withTenant(ctx, (tx) => this.devices.revokeDead(tx, dead, 'PROVIDER_UNREGISTERED'));
      this.metrics.increment('push_devices_revoked_total', { reason: 'PROVIDER_UNREGISTERED' });
      await Promise.allSettled(refs.map((ref) => vault.remove(ref)));
    } catch {
      // The next permanent refusal revokes them again.
    }
  }

  /** The address the channel writes to. It lives in memory for the call and is read in a transaction that is closed before the call is made. */
  private async addressOf(tx: TenantTx, membershipId: string, channel: string): Promise<string | undefined> {
    const column = channel === 'EMAIL' ? 'email' : channel === 'SMS' || channel.startsWith('ZALO') || channel === 'WHATSAPP' ? 'phone' : undefined;
    if (column === undefined) return undefined;
    // The directory masks personal data unless the transaction says the reader may see it; the dispatcher reads the recipient's own address to write to it.
    await tx.query("select set_config('app.can_read_pii', 'true', true)", []);
    const [row] = await tx.query<{ value: string | null }>(`select ${column} as value from machvon.tenant_user_directory where membership_id = $1::uuid`, [membershipId]);
    return row?.value ?? undefined;
  }

  /** The sends whose result was lost become Unknown, and the Unknown ones are asked about at their provider (BR-NOT-04). */
  async reconcile(ctx: TenantContext): Promise<ReconcileResult> {
    const now = this.now();
    const result: ReconcileResult = { lost: 0, resolved: 0, retried: 0 };
    const stale = await this.deps.database.withTenant(ctx, (tx) => this.store.staleSending(tx, now, WORK_LIMIT));
    for (const attempt of stale) {
      if (await this.deps.database.withTenant(ctx, (tx) => this.deps.engine.markLost(tx, attempt.id, now))) result.lost += 1;
    }
    const unknown = await this.deps.database.withTenant(ctx, (tx) => this.store.unknownToReconcile(tx, now, WORK_LIMIT));
    for (const attempt of unknown) {
      const adapter = this.deps.adapters.forChannel(attempt.channel);
      if (adapter === undefined || blockedReason(adapter, this.environment) !== undefined) continue;
      const lookup = await adapter.lookup(`${attempt.notificationId}:${attempt.channel}:${attempt.attemptNo}`).catch((): { kind: 'UNDETERMINED' } => ({ kind: 'UNDETERMINED' }));
      const outcome = await this.deps.database.withTenant(ctx, (tx) => this.deps.engine.reconcile(tx, attempt.id, lookup, now));
      if (outcome === 'RESOLVED') result.resolved += 1;
      if (outcome === 'RETRIED') result.retried += 1;
    }
    return result;
  }

  /** The gauges and alerts of NOT 9: the failed queue, the oldest send of unknown result, and the circuits open for ten minutes. */
  private async report(ctx: TenantContext, now: Date): Promise<void> {
    const { gauges, open } = await this.deps.database.withTenant(ctx, async (tx) => ({
      gauges: await this.store.gauges(tx),
      open: await this.store.circuitsToAlert(tx, now),
    }));
    this.metrics.gauge(DLQ_GAUGE, gauges.deadLetter, { tenant_id: ctx.tenantId });
    this.metrics.gauge(UNKNOWN_OLDEST_GAUGE, gauges.oldestUnknownSeconds, { tenant_id: ctx.tenantId });
    for (const circuit of open) this.alerts.raise(CHANNEL_CIRCUIT_OPEN_ALERT, { tenantId: ctx.tenantId, channelAccountId: circuit.channelAccountId, channel: circuit.channel });
  }
}
