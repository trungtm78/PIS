import { randomUUID } from 'node:crypto';
import { Controller, Headers, HttpCode, Inject, Optional, Param, Post, Req } from '@nestjs/common';
import { AuditWriter, ControlDatabase, ProviderCallbackStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { IntegrationInboxProcessor } from '@machvon/db';
import { DomainError, NOOP_METRICS, parseCallbackTimestamp, verifyProviderCallback } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { ADM_INBOX_PROCESSOR } from '../../modules/adm/tokens';
import { IdentityCommand } from '../../session/identity.guard';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { CHANNEL_ADAPTERS } from './channel-adapters';
import type { ChannelAdapterRegistry } from './channel-adapters';
import { NOT_METRICS } from './tokens';
import { WEBHOOK_PAYLOADS, WEBHOOK_SECRETS } from './webhook-support';
import type { WebhookPayloadStore, WebhookSecretResolver } from './webhook-support';

const OPERATION = 'receiveChannelWebhook';
const MAX_EVENT_KEY = 200;
const MAX_EXTERNAL_ACCOUNT_ID = 200;
/** The route of an external account id (the tenant and the account it belongs to) is remembered this long, a miss included, so a flood of forged ids costs one lookup each and not one per request. */
const ROUTE_CACHE_MS = 30_000;
const ROUTE_CACHE_SIZE = 5000;

interface RawBodyRequest {
  rawBody?: Buffer;
}

interface AccountRoute {
  tenant_id: string;
  channel_account_id: string;
  channel: string;
}

const unknownAccount = (): DomainError => new DomainError('CHANNEL_ACCOUNT_UNKNOWN', 404);

/**
 * receiveChannelWebhook (ST-NOT-002, NOT 9, BR-OMNI-04): the delivery receipts of the providers, and the messages that people write to the tenant (ST-OMNI-004). There is no session here: the signature is the
 * authentication. The order matters. The signature is checked on the raw body, with the keys of the channel account that the receipt names, before anything
 * is stored; a receipt that does not verify leaves nothing but a counter. The tenant is the one of that channel account, never one the payload claims. The
 * receipt is written once to the inbox (unique per tenant, provider and event) and the answer is sent after it is persisted; applying it to the send is
 * the work of the inbox processor, which runs right after and again on its schedule if that fails.
 */
@Controller('webhooks/channels')
export class ChannelWebhookController {
  private readonly callbacks = new ProviderCallbackStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;
  private readonly routes = new Map<string, { at: number; route: AccountRoute | undefined }>();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(CHANNEL_ADAPTERS) private readonly adapters: ChannelAdapterRegistry,
    @Inject(WEBHOOK_SECRETS) private readonly secrets: WebhookSecretResolver,
    @Inject(WEBHOOK_PAYLOADS) private readonly payloads: WebhookPayloadStore,
    @Inject(ADM_INBOX_PROCESSOR) private readonly processor: IntegrationInboxProcessor,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Optional() @Inject(NOT_METRICS) metrics?: MetricsSink,
  ) {
    this.audit = new AuditWriter(database);
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @OperationId(OPERATION)
  @IdentityCommand(OPERATION)
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-timestamp') timestamp: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<{ received: boolean; duplicate: boolean }> {
    const adapter = this.adapters.forProvider(provider);
    if (adapter === undefined) throw unknownAccount();
    const rawBody = request.rawBody;
    if (rawBody === undefined) throw new DomainError('INVALID_REQUEST', 400);
    const timestampSeconds = parseCallbackTimestamp(timestamp);
    // No signature, no work: a receipt that carries none is refused before its body is read.
    if (signature === undefined || signature === '') verifyProviderCallback({ provider, rawBody, signature, timestampSeconds, keys: [], metrics: this.metrics });
    // A body is a receipt or a message that came in; both name the event and the account, which is all this controller reads.
    const parsed = adapter.parseCallback(rawBody) ?? adapter.parseInbound?.(rawBody);
    if (parsed === undefined) throw unknownAccount();
    // The event is the one the signed body names. The Idempotency-Key header is not under the signature (only the timestamp and the body are), so whoever
    // replays a signed receipt could write another key and make it a new event: it is checked for its size and never decides what a duplicate is.
    if (idempotencyKey !== undefined && idempotencyKey.length > MAX_EVENT_KEY) throw new DomainError('INVALID_REQUEST', 400, 'idempotency-key');
    const eventKey = parsed.eventKey;
    if (eventKey === '' || eventKey.length > MAX_EVENT_KEY) throw new DomainError('INVALID_REQUEST', 400, 'event-key');

    const route = await this.routeOf(adapter.channel, parsed.externalAccountId);
    const worker: TenantContext = { tenantId: route.tenant_id, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
    const [account] = await this.database.withTenant(worker, (tx) =>
      tx.query<{ status: string; webhook_secret_ref: string | null }>('select status, webhook_secret_ref from machvon.channel_account where id = $1::uuid', [route.channel_account_id]),
    );
    if (account === undefined || account.status !== 'Active') throw unknownAccount();
    const keys = account.webhook_secret_ref === null ? [] : await this.secrets.resolve(account.webhook_secret_ref);
    verifyProviderCallback({ provider, rawBody, signature, timestampSeconds, keys, scheme: adapter.signature, metrics: this.metrics });

    const payloadReference = await this.payloads.put(worker, provider, eventKey, rawBody);
    const received = await this.database.withTenant(worker, async (tx) => {
      const stored = await this.callbacks.receive(tx, {
        provider,
        eventKey,
        eventType: parsed.eventType,
        rawBody,
        signature,
        timestampSeconds,
        keys,
        scheme: adapter.signature,
        channelAccountId: route.channel_account_id,
        payloadReference,
        metrics: this.metrics,
      });
      if (!stored.duplicate) {
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'channel.webhook_received',
          resourceType: 'channel_account',
          resourceId: route.channel_account_id,
          diff: { provider, event_type: parsed.eventType },
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      }
      return stored;
    });
    if (!received.duplicate) {
      // Applying the receipt is not part of the answer: whatever goes wrong here, the inbox keeps the event and the job takes it up again.
      await this.processor.processOne(worker, received.inboxId).catch(() => undefined);
    }
    return { received: true, duplicate: received.duplicate };
  }

  /** The channel account the receipt is for: found by its external id across tenants, and the one of this channel only. Zero or several is unknown. */
  private async routeOf(channel: string, externalAccountId: string): Promise<AccountRoute> {
    // The id comes from a body that is not verified yet: a value no provider issues is neither looked up nor remembered.
    if (externalAccountId === '' || externalAccountId.length > MAX_EXTERNAL_ACCOUNT_ID) throw unknownAccount();
    const key = `${channel}
${externalAccountId}`;
    const remembered = this.routes.get(key);
    if (remembered !== undefined && Date.now() - remembered.at < ROUTE_CACHE_MS) {
      if (remembered.route === undefined) throw unknownAccount();
      return remembered.route;
    }
    const route = await this.lookUp(channel, externalAccountId);
    if (this.routes.size >= ROUTE_CACHE_SIZE) this.routes.delete(this.routes.keys().next().value as string);
    this.routes.set(key, { at: Date.now(), route });
    if (route === undefined) throw unknownAccount();
    return route;
  }

  private async lookUp(channel: string, externalAccountId: string): Promise<AccountRoute | undefined> {
    const rows = await this.control.withControl((tx) =>
      tx.query<AccountRoute>('select tenant_id, channel_account_id, channel from machvon.channel_accounts_by_external_id($1)', [externalAccountId]),
    );
    const matching = rows.filter((row) => row.channel === channel);
    // Zero accounts, or several tenants holding the same id on one channel, is an unknown account: the receipt is never given to one of them by chance.
    return matching.length === 1 ? matching[0] : undefined;
  }
}
