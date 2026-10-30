import { ConversationOutboundStore } from '@machvon/db';
import type { DueMessage, SendResult, TenantDatabase } from '@machvon/db';
import { NOOP_ALERTS, withAbsoluteLinks } from '@machvon/kernel';
import type { AlertSink, ChannelAdapter, ChannelLookupResult, TenantContext } from '@machvon/kernel';
import type { ChannelAdapterRegistry } from '../../notifications/delivery/channel-adapters';
import { OMNI_CHANNEL_CREDENTIAL_EXPIRED_ALERT } from '../../notifications/delivery/dispatcher';

const DEFAULT_BATCH = 50;
const ADAPTER_TIMEOUT_MS = 10_000;

export interface ConversationSenderDeps {
  database: TenantDatabase;
  adapters: ChannelAdapterRegistry;
  now?: () => Date;
  batch?: number;
  adapterTimeoutMs?: number;
  /** The public origin of the web application (`WEB_BASE_URL`): the links in a message are made whole with it. */
  webBaseUrl?: string | undefined;
  alerts?: AlertSink;
}

/**
 * The messages that agents queued in conversations go out here (ST-OMNI-005, OMNI.md 3.3 step 7), never inside the command that queued them. A pass takes up the due messages of a tenant in one transaction (the checks that can change are made
 * again there), calls the adapter of the channel with no transaction open, and records the answer. A reply goes on the channel the person used and on no other: a message whose channel has no adapter that may send where the process
 * runs ends as failed with the reason, and is never moved to another channel. The adapter is given the handle of the thread at the provider as the place to answer.
 */
export class ConversationSender {
  private readonly store = new ConversationOutboundStore();
  private readonly now: () => Date;
  private readonly batch: number;
  private readonly timeoutMs: number;
  private readonly alerts: AlertSink;

  constructor(private readonly deps: ConversationSenderDeps) {
    this.now = deps.now ?? (() => new Date());
    this.batch = deps.batch ?? DEFAULT_BATCH;
    this.timeoutMs = deps.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS;
    this.alerts = deps.alerts ?? NOOP_ALERTS;
  }

  /** One pass for a tenant; returns how many messages were handed to an adapter. */
  async run(ctx: TenantContext, at?: Date): Promise<number> {
    // The clock is read for each message, so a pass that takes minutes leases each message from its own turn; a test names the moment.
    const stamp = (): Date => at ?? this.now();
    let sent = 0;
    // One message at a time, each taken up just before its call: the lease of a message starts when its turn comes.
    for (let taken = 0; taken < this.batch; taken += 1) {
      const claimed = await this.deps.database.withTenant(ctx, (tx) => this.store.claimNext(tx, stamp()));
      if (claimed === undefined) break;
      let message: DueMessage = claimed;
      const adapter = this.deps.adapters.usable(message.channel);
      if (adapter === undefined) {
        await this.deps.database.withTenant(ctx, (tx) => this.store.suppress(tx, message.id, 'ADAPTER_MISSING'));
        continue;
      }
      if (message.reconcile) {
        // An attempt of this message was taken up and its result was lost: the provider is asked about it, and only a provider that says it has no such request is sent to again.
        const answer = await this.lookUp(adapter, message.id);
        if (answer.kind === 'FOUND') {
          await this.deps.database.withTenant(ctx, (tx) => this.store.recordFound(tx, claimed, answer, stamp()));
          continue;
        }
        if (answer.kind === 'UNDETERMINED') {
          await this.deps.database.withTenant(ctx, (tx) => this.store.recordResult(tx, claimed, { kind: 'UNKNOWN', errorCode: 'SEND_UNCERTAIN' }, stamp()));
          continue;
        }
        const again = await this.deps.database.withTenant(ctx, (tx) => this.store.retake(tx, claimed, stamp()));
        if (again === undefined) continue;
        message = again;
      }
      // A channel that is closed for the moment (the sending hours of a text) takes nothing: the message waits for the hours to open, with no attempt used.
      const opens = adapter.closedUntil?.(stamp());
      if (opens !== undefined) {
        await this.deps.database.withTenant(ctx, (tx) => this.store.defer(tx, message.id, opens));
        continue;
      }
      // A link the person cannot open is not sent as if it were one: without the origin of the application the message ends as failed, with the reason.
      const text = withAbsoluteLinks(message.text, this.deps.webBaseUrl);
      if (text === undefined) {
        await this.deps.database.withTenant(ctx, (tx) => this.store.suppress(tx, message.id, 'WEB_BASE_URL_MISSING'));
        continue;
      }
      const result = await this.invoke(adapter, { ...message, text });
      const recorded = await this.deps.database.withTenant(ctx, (tx) => this.store.recordResult(tx, message, result, stamp()));
      // A supervisor has to put a new credential in the vault and verify the account again.
      if (recorded.credentialExpired) this.alerts.raise(OMNI_CHANNEL_CREDENTIAL_EXPIRED_ALERT, { tenantId: ctx.tenantId, channelAccountId: message.channelAccountId, channel: message.channel });
      sent += 1;
    }
    return sent;
  }

  /** What the provider holds for the request of a message; a provider that fails to answer, or is slow, has not said that it holds nothing. */
  private async lookUp(adapter: ChannelAdapter, key: string): Promise<ChannelLookupResult & { providerMessageId?: string }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<ChannelLookupResult>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'UNDETERMINED' }), this.timeoutMs);
      });
      return await Promise.race([adapter.lookup(key), timeout]);
    } catch {
      return { kind: 'UNDETERMINED' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async invoke(adapter: ChannelAdapter, message: DueMessage): Promise<SendResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<SendResult>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'UNKNOWN', errorCode: 'ADAPTER_TIMEOUT' }), this.timeoutMs);
      });
      // The id of the message is the idempotency key: a provider that keeps keys sends it once however often it is asked.
      return await Promise.race([adapter.send({ idempotencyKey: message.id, accountId: message.accountId, to: message.threadId, threadId: message.threadId, text: message.text, ...(message.subject === undefined ? {} : { subject: message.subject }) }), timeout]);
    } catch {
      // The adapter failed in a way it did not classify: the request may have been made, so it is not repeated on its own.
      return { kind: 'UNKNOWN', errorCode: 'ADAPTER_ERROR' };
    } finally {
      clearTimeout(timer);
    }
  }
}
