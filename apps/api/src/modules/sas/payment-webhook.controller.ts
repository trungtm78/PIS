import { createHash, randomUUID } from 'node:crypto';
import { Controller, Headers, HttpCode, Inject, Optional, Param, Post, Req } from '@nestjs/common';
import { AuditWriter, BillingPaymentStore, BillingStore, ControlDatabase, PLATFORM_TENANT_ID, ProviderCallbackStore, TenantDatabase, WORKER_MEMBERSHIP_ID, actingAsTenant, tenantOfInvoice } from '@machvon/db';
import type { InboxHandler, IntegrationInboxProcessor, InboxHandlerRegistry } from '@machvon/db';
import { DomainError, NOOP_METRICS, parseCallbackTimestamp, parseEInvoiceCallback, parsePaymentCallback, verifyProviderCallback } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { NOT_METRICS } from '../../notifications/delivery/tokens';
import { WEBHOOK_PAYLOADS, WEBHOOK_SECRETS } from '../../notifications/delivery/webhook-support';
import type { WebhookPayloadStore, WebhookSecretResolver } from '../../notifications/delivery/webhook-support';
import { IdentityCommand } from '../../session/identity.guard';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { ADM_INBOX_PROCESSOR } from '../adm/tokens';
import { effectsOf } from './payment-effects';
import { WEBHOOK_PROVIDERS } from './webhook-providers';
import type { WebhookProvider, WebhookProviderRegistry } from './webhook-providers';

const MAX_EVENT_KEY = 200;
const PLATFORM_WORKER: TenantContext = { tenantId: PLATFORM_TENANT_ID, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };

interface RawBodyRequest {
  rawBody?: Buffer;
}

interface Verified {
  provider: WebhookProvider;
  rawBody: Buffer;
  signature: string;
  timestampSeconds: number;
  keys: Awaited<ReturnType<WebhookSecretResolver['resolve']>>;
}

/**
 * The key a body is stored under: the event and the hash of the body. Two deliveries that reuse an event id with different bodies are two objects, and the inbox row that wins the event points at exactly the bytes it
 * accepted, whichever of them was stored first.
 */
const bodyKeyOf = (eventKey: string, rawBody: Buffer): string => `${eventKey}:${createHash('sha256').update(rawBody).digest('hex')}`;

/** What both callbacks of the control plane do first, in this order: the provider is known, the signature is checked on the raw body with the platform's keys for that provider, and only then is the body read. */
async function verify(
  registry: WebhookProviderRegistry,
  secrets: WebhookSecretResolver,
  metrics: MetricsSink,
  kind: WebhookProvider['kind'],
  providerName: string,
  request: RawBodyRequest,
  signature: string | undefined,
  timestamp: string | undefined,
  idempotencyKey: string | undefined,
): Promise<Verified> {
  const provider = registry.of(kind, providerName);
  if (provider === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  const rawBody = request.rawBody;
  if (rawBody === undefined) throw new DomainError('INVALID_REQUEST', 400);
  const timestampSeconds = parseCallbackTimestamp(timestamp);
  // No signature, no work: a callback that carries none is refused before its body is read.
  if (signature === undefined || signature === '') verifyProviderCallback({ provider: provider.name, rawBody, signature, timestampSeconds, keys: [], metrics });
  // The Idempotency-Key header is not under the signature: it is checked for its size and never decides what a duplicate is.
  if (idempotencyKey !== undefined && idempotencyKey.length > MAX_EVENT_KEY) throw new DomainError('INVALID_REQUEST', 400, 'idempotency-key');
  const keys = await secrets.resolve(provider.secretRef);
  verifyProviderCallback({ provider: provider.name, rawBody, signature, timestampSeconds, keys, metrics });
  return { provider, rawBody, signature: signature as string, timestampSeconds: timestampSeconds as number, keys };
}

/**
 * receivePaymentWebhook (ST-SAS-012, SAS.md 3.7 item 3): the callbacks of the banks and gateways that tell a payment came in. There is no session: the signature is the authentication, checked on the raw body with the
 * keys of the platform for that provider before anything is stored, and a callback that does not verify leaves nothing but a counter. The tenant is not known yet (the payer wrote an invoice code in the note), so
 * the event is kept in the inbox under the platform tenant; applying it records the payment (one for each transaction) and the matching worker moves it to the tenant of the invoice. The answer is sent after
 * the event is persisted.
 */
@Controller('webhooks/payments')
export class PaymentWebhookController {
  private readonly callbacks = new ProviderCallbackStore();
  private readonly payments = new BillingPaymentStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Inject(WEBHOOK_PROVIDERS) private readonly providers: WebhookProviderRegistry,
    @Inject(WEBHOOK_SECRETS) private readonly secrets: WebhookSecretResolver,
    @Inject(WEBHOOK_PAYLOADS) private readonly payloads: WebhookPayloadStore,
    @Inject(ADM_INBOX_PROCESSOR) private readonly processor: IntegrationInboxProcessor,
    @Optional() @Inject(NOT_METRICS) metrics?: MetricsSink,
  ) {
    this.audit = new AuditWriter(database);
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @OperationId('receivePaymentWebhook')
  @IdentityCommand('receivePaymentWebhook')
  async receive(
    @Param('provider') providerName: string,
    @Req() request: RawBodyRequest,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-timestamp') timestamp: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<{ received: boolean; duplicate: boolean }> {
    const verified = await verify(this.providers, this.secrets, this.metrics, 'payment', providerName, request, signature, timestamp, idempotencyKey);
    const parsed = parsePaymentCallback(verified.rawBody);
    if (parsed === undefined) throw new DomainError('INVALID_REQUEST', 400);
    // Deliveries of one event id take turns on a lock of the event: the first keeps it (the body is stored only then, and the inbox row refers to exactly that body), every later one finds it kept and is told as a duplicate
    // without storing anything, so a delivery that is not accepted leaves no object behind that nothing refers to.
    const received = await this.database.withTenant(PLATFORM_WORKER, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`payment\n${verified.provider.name}\n${parsed.eventKey}`]);
      const [known] = await tx.query<{ id: string; payload_hash: string }>('select id, payload_hash from machvon.integration_event_inbox where provider = $1 and event_key = $2', [verified.provider.name, parsed.eventKey]);
      if (known !== undefined) {
        if (known.payload_hash !== createHash('sha256').update(verified.rawBody).digest('hex')) this.metrics.increment('provider_callback_ignored_total', { provider: verified.provider.name, reason: 'PAYLOAD_CHANGED' });
        return { duplicate: true, inboxId: known.id };
      }
      const payloadReference = await this.payloads.put(PLATFORM_WORKER, verified.provider.name, bodyKeyOf(parsed.eventKey, verified.rawBody), verified.rawBody);
      const stored = await this.callbacks.receive(tx, {
        provider: verified.provider.name,
        eventKey: parsed.eventKey,
        eventType: 'payment.received',
        rawBody: verified.rawBody,
        signature: verified.signature,
        timestampSeconds: verified.timestampSeconds,
        keys: verified.keys,
        payloadReference,
        metrics: this.metrics,
      });
      if (!stored.duplicate) {
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'payment.webhook_received',
          resourceType: 'integration_event_inbox',
          resourceId: stored.inboxId,
          diff: { provider: verified.provider.name, event_type: 'payment.received' },
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      }
      return stored;
    });
    if (!received.duplicate) {
      // Applying the event is not part of the answer: whatever goes wrong here, the inbox keeps it and the job takes it up again.
      await this.processor.processOne(PLATFORM_WORKER, received.inboxId).catch(() => undefined);
      // The answer does not wait for the reconciliation: the event is kept, and the pass runs on its own (and again every minute in the worker), one at a time in this process.
      this.reconcile();
    }
    return { received: true, duplicate: received.duplicate };
  }

  private reconciling = false;

  private reconcile(): void {
    if (this.reconciling) return;
    this.reconciling = true;
    void this.payments
      .pass((work) => this.control.withTenantOf(PLATFORM_TENANT_ID, work), (tx) => effectsOf(this.audit, tx, WORKER_MEMBERSHIP_ID), { platformTenantId: PLATFORM_TENANT_ID, workerMembershipId: WORKER_MEMBERSHIP_ID, now: new Date() })
      .catch(() => undefined)
      .finally(() => {
        this.reconciling = false;
      });
  }
}

/**
 * receiveEInvoiceWebhook (ST-SAS-012, SAS.md 3.7): the answer of the e-invoice provider that issued an invoice later than the platform asked (the number, the template and the series, the code of the tax authority and the
 * code to look it up with). Verified like a payment, kept in the inbox under the platform tenant, and applied to the invoice that the reference key names, in the tenant of that invoice: an invoice that waited for the provider
 * is Issued; the same answer again changes nothing; another number for an issued invoice is refused (409), never written over it. It is applied on every delivery, duplicates included, and the event is kept in the inbox, as
 * processed, only after it was applied: a callback whose application failed is answered with an error, leaves nothing for a worker to acknowledge, and the provider sends it again.
 */
@Controller('webhooks/einvoice')
export class EInvoiceWebhookController {
  private readonly callbacks = new ProviderCallbackStore();
  private readonly billing = new BillingStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Inject(WEBHOOK_PROVIDERS) private readonly providers: WebhookProviderRegistry,
    @Inject(WEBHOOK_SECRETS) private readonly secrets: WebhookSecretResolver,
    @Inject(WEBHOOK_PAYLOADS) private readonly payloads: WebhookPayloadStore,
    @Inject(ADM_INBOX_PROCESSOR) private readonly processor: IntegrationInboxProcessor,
    @Optional() @Inject(NOT_METRICS) metrics?: MetricsSink,
  ) {
    this.audit = new AuditWriter(database);
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @OperationId('receiveEInvoiceWebhook')
  @IdentityCommand('receiveEInvoiceWebhook')
  async receive(
    @Param('provider') providerName: string,
    @Req() request: RawBodyRequest,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-timestamp') timestamp: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<{ received: boolean; duplicate: boolean }> {
    const verified = await verify(this.providers, this.secrets, this.metrics, 'einvoice', providerName, request, signature, timestamp, idempotencyKey);
    const parsed = parseEInvoiceCallback(verified.rawBody);
    if (parsed === undefined) throw new DomainError('INVALID_REQUEST', 400);
    const adapterName = verified.provider.adapterName ?? verified.provider.name;
    // One transaction claims the event and applies it: deliveries of one event id take turns on a lock of the event, the first applies it and keeps it as processed, and every later one finds it kept and changes nothing,
    // whatever it says (a provider that reuses an id for another invoice is ignored, and counted). A failure anywhere undoes both, so the event is either applied and kept, or neither, and the provider sends it again.
    const received = await this.control.withTenantOf(PLATFORM_TENANT_ID, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`einvoice\n${verified.provider.name}\n${parsed.eventKey}`]);
      const [known] = await tx.query<{ payload_hash: string }>('select payload_hash from machvon.integration_event_inbox where provider = $1 and event_key = $2', [verified.provider.name, parsed.eventKey]);
      if (known !== undefined) {
        if (known.payload_hash !== createHash('sha256').update(verified.rawBody).digest('hex')) this.metrics.increment('provider_callback_ignored_total', { provider: verified.provider.name, reason: 'PAYLOAD_CHANGED' });
        return { duplicate: true };
      }
      // The invoice is the one the reference key names, never a tenant the body claims; one nobody knows is refused, and the provider tries again (the invoice may not have been committed yet).
      const tenantId = await tenantOfInvoice(tx, parsed.referenceKey);
      if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      await actingAsTenant(tx, tenantId, PLATFORM_TENANT_ID, () =>
        this.billing.completeIssue(
          tx,
          effectsOf(this.audit, tx, WORKER_MEMBERSHIP_ID),
          parsed.referenceKey,
          { providerRef: `${adapterName}-${parsed.referenceKey}`, templateCode: parsed.templateCode, series: parsed.series, number: parsed.number, taxAuthorityCode: parsed.taxAuthorityCode, lookupCode: parsed.lookupCode },
          adapterName,
          new Date(),
        ),
      );
      // Stored only now that the event is claimed and applied: a delivery that is refused or that fails leaves no object behind.
      const payloadReference = await this.payloads.put(PLATFORM_WORKER, verified.provider.name, bodyKeyOf(parsed.eventKey, verified.rawBody), verified.rawBody);
      const stored = await this.callbacks.receive(tx, {
        provider: verified.provider.name,
        eventKey: parsed.eventKey,
        eventType: 'einvoice.issued',
        rawBody: verified.rawBody,
        signature: verified.signature,
        timestampSeconds: verified.timestampSeconds,
        keys: verified.keys,
        payloadReference,
        metrics: this.metrics,
      });
      await tx.query("update machvon.integration_event_inbox set status = 'PROCESSED', processed_at = coalesce(processed_at, now()), error_code = null, next_attempt_at = null where id = $1::uuid", [stored.inboxId]);
      return { duplicate: stored.duplicate };
    });
    return { received: true, duplicate: received.duplicate };
  }
}

/** The inbox handler of the payment providers: it records the payment of the event (one for each transaction) under the platform tenant of the inbox row. The e-invoice events are applied by the callback itself and need none. */
export function paymentCallbackHandler(providers: WebhookProviderRegistry, payloads: WebhookPayloadStore): InboxHandler {
  const store = new BillingPaymentStore();
  return async (delivery, tx) => {
    const provider = providers.of('payment', delivery.provider);
    if (provider === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const body = await payloads.read(PLATFORM_WORKER, delivery.payloadReference);
    // A body the retention job has already removed cannot be applied: the event stays failed for an operator to see.
    if (body === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // What is recorded is what the inbox accepted: a stored body whose hash is not the one of the event (a body of the same event id that was refused as a changed duplicate and overwrote it) is never applied.
    const [accepted] = await tx.query<{ payload_hash: string }>('select payload_hash from machvon.integration_event_inbox where id = $1::uuid', [delivery.id]);
    if (accepted === undefined || accepted.payload_hash !== createHash('sha256').update(body).digest('hex')) throw new DomainError('VALIDATION_FAILED', 422);
    const parsed = parsePaymentCallback(body);
    if (parsed === undefined) throw new DomainError('VALIDATION_FAILED', 422);
    await store.record(tx, { provider: provider.name, txnRef: parsed.txnRef, amountVnd: parsed.amountVnd, method: provider.method ?? parsed.method, receivedAt: parsed.receivedAt, memo: parsed.memo, inboxEventId: delivery.id });
  };
}

/** Registers the inbox handlers of the control plane: the payment providers record their payments. The e-invoice events are applied by the callback before they are kept, and need none. */
export function registerPaymentCallbacks(registry: InboxHandlerRegistry, providers: WebhookProviderRegistry, payloads: WebhookPayloadStore): string[] {
  for (const provider of providers.all('payment')) registry.register(provider.name, paymentCallbackHandler(providers, payloads));
  return providers.all('payment').map((provider) => provider.name);
}
