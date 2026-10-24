import { DeliveryStore, consumeOnce, externalChannelsOf } from '@machvon/db';
import type { ConsumeSecurity, DeliveryEngine, NotificationPreferenceStore, NotificationRef, NotificationStore, OutboxDelivery, TenantDatabase, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid, eventCategoryOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { definitionOf } from './definition';
import type { NotificationDefinition } from './definition';
import { dedupeKeyOf } from './dedupe';
import type { EventTypeDefinition, PayloadValidator } from './payload-validator';
import { RecipientResolver } from './recipient-resolver';
import type { ResourceAccessPort } from './resource-access-port';

/** The name of this consumer in the inbox: one run per (consumer, event). */
export const NOTIFICATION_CONSUMER = 'notification';

export interface NotificationConsumerDeps {
  database: TenantDatabase;
  store: NotificationStore;
  validator: PayloadValidator;
  /** Loads the access a recipient holds now (EffectiveAccessStore.load). */
  loadAccess: (ctx: TenantContext) => Promise<EffectiveAccess>;
  resourceAccess: ResourceAccessPort;
  /** Key and alert sink of the signed delivery context (the relay signs with the same key). */
  security: ConsumeSecurity;
  resolver?: RecipientResolver;
  /**
   * Starts the delivery of the external channels of a workflow (ST-NOT-002). Without it a notification is delivered in the application only: the external
   * channels of the plan are ignored rather than left queued with nobody to send them.
   */
  delivery?: DeliveryEngine;
  /**
   * The preferences of the recipients (ST-NOT-003): a recipient who switched off the inbox for the category of an event that is not urgent does not get a
   * notification in it. The external channels are decided when each send is taken up, from the preferences and the consent of that moment.
   */
  preferences?: Pick<NotificationPreferenceStore, 'channelEnabled'>;
  metrics?: MetricsSink;
  now?: () => Date;
}

/** The notification member of an event payload: the resource it is about, an optional deep link and recipients. */
function refOf(payload: Record<string, unknown>): NotificationRef & { recipients?: unknown } {
  const value = payload.notification;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const ref: NotificationRef & { recipients?: unknown } = { recipients: record.recipients };
  if (typeof record.deepLink === 'string') ref.deepLink = record.deepLink;
  const resource = record.resource;
  if (typeof resource === 'object' && resource !== null && !Array.isArray(resource)) {
    const { type, id, ownerUnitId, ownerUnitPath, projectId, contractId } = resource as Record<string, unknown>;
    if (typeof type === 'string' && typeof id === 'string') {
      ref.resource = { type, id };
      if (typeof ownerUnitId === 'string') ref.resource.ownerUnitId = ownerUnitId;
      if (typeof ownerUnitPath === 'string') ref.resource.ownerUnitPath = ownerUnitPath;
      if (typeof projectId === 'string') ref.resource.projectId = projectId;
      if (typeof contractId === 'string') ref.resource.contractId = contractId;
    }
  }
  return ref;
}

/**
 * Turns an outbox event into in-app notifications (NOT 3.1): validates the payload against its registered type,
 * finds the Published workflow, resolves the recipients inside the tenant of the event, drops those without
 * access to the resource, and inserts one notification per (event, recipient, purpose) that the dedupe key makes
 * unique. Everything after the validation runs in one transaction with the inbox row of `consumeOnce`, so a
 * crash leaves nothing behind and a redelivery is a counted duplicate.
 */
export class NotificationConsumer {
  private readonly resolver: RecipientResolver;
  private readonly deliveries = new DeliveryStore();
  private readonly metrics: MetricsSink;
  private readonly now: () => Date;

  constructor(private readonly deps: NotificationConsumerDeps) {
    this.resolver = deps.resolver ?? new RecipientResolver();
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.now = deps.now ?? (() => new Date());
  }

  async handle(delivery: OutboxDelivery): Promise<'processed' | 'duplicate'> {
    // A bad payload or an unregistered type fails the delivery before any row is written: the relay retries, then marks it DEAD.
    const eventType = await this.deps.validator.validate(delivery.type, delivery.schemaVersion, delivery.payload);
    const outcome = await consumeOnce(this.deps.database, delivery, NOTIFICATION_CONSUMER, (tx) => this.create(tx, delivery, eventType), this.deps.security);
    if (outcome === 'duplicate') this.metrics.increment('notification_dedupe_hits_total');
    return outcome;
  }

  private async create(tx: TenantTx, delivery: OutboxDelivery, eventType: EventTypeDefinition): Promise<void> {
    const workflow = await this.deps.store.workflowFor(tx, delivery.type);
    if (workflow === undefined) {
      this.metrics.increment('notification_no_workflow_total', { event_type: delivery.type });
      return;
    }
    const definition = definitionOf(workflow.definition);
    if (!eventType.allowedPurposes.includes(definition.purpose)) throw new DomainError('VALIDATION_FAILED', 422, 'workflow.definition.purpose');
    const ref = refOf(delivery.payload);
    const recipients = await this.resolver.resolve(tx, ref, definition.resolver);
    const expiresAt = new Date((await this.deps.store.eventTime(tx, delivery.id) ?? this.now()).getTime() + definition.expiresAfterMinutes * 60_000);
    for (const recipientId of recipients) {
      if (!(await this.mayRead(delivery.tenantId, recipientId, ref))) {
        this.metrics.increment('notification_suppressed_total', { reason: 'no_access' });
        continue;
      }
      await this.insert(tx, delivery, workflow.id, definition, recipientId, expiresAt);
    }
  }

  private async mayRead(tenantId: string, recipientId: string, ref: NotificationRef): Promise<boolean> {
    if (ref.resource === undefined) return true;
    const access = await this.deps.loadAccess({ tenantId, membershipId: recipientId, scopeVersion: 0 });
    return this.deps.resourceAccess.canRead(access, ref.resource, this.now());
  }

  /**
   * The channels the notification will use for this recipient (NOT 3.1 step 4): the plan of the workflow without the inbox when the recipient switched it off
   * for this category of events. The inbox of an urgent message (CRITICAL, HIGH) is never dropped; without a delivery engine the inbox is the only channel.
   */
  private async planFor(tx: TenantTx, delivery: OutboxDelivery, definition: NotificationDefinition, recipient: string): Promise<string[]> {
    const plan = this.deps.delivery === undefined ? ['IN_APP'] : definition.channels.map((entry) => entry.channel);
    const urgent = definition.priority === 'CRITICAL' || definition.priority === 'HIGH';
    if (this.deps.preferences === undefined || urgent || !plan.includes('IN_APP')) return plan;
    const inboxOn = await this.deps.preferences.channelEnabled(tx, recipient, eventCategoryOf(delivery.type), 'IN_APP');
    return inboxOn ? plan : plan.filter((channel) => channel !== 'IN_APP');
  }

  private async insert(
    tx: TenantTx,
    delivery: OutboxDelivery,
    workflowVersionId: string,
    definition: NotificationDefinition,
    recipientId: string,
    expiresAt: Date,
  ): Promise<void> {
    const recipient = asUuid(recipientId);
    if (recipient === undefined) return;
    const channelPlan = await this.planFor(tx, delivery, definition, recipient);
    if (channelPlan.length === 0) {
      this.metrics.increment('notification_suppressed_total', { reason: 'preference' });
      return;
    }
    const result = await this.deps.store.insert(tx, {
      eventId: delivery.id,
      workflowVersionId,
      recipientId: recipient,
      purpose: definition.purpose,
      dedupeKey: dedupeKeyOf({ tenantId: delivery.tenantId, sourceEventId: delivery.id, recipientId: recipient, purpose: definition.purpose }),
      expiresAt,
      sourceEventType: delivery.type,
      eventVersion: delivery.schemaVersion,
      priority: definition.priority,
      ackRequired: definition.ackRequired,
      channelPlan,
    });
    // The first send of the first external channel is queued here, in the transaction that wrote the notification; it goes out later, from the dispatcher.
    if (result.created && this.deps.delivery !== undefined && externalChannelsOf(channelPlan).length > 0) {
      await this.deps.delivery.startChain(tx, await this.deliveries.requireNotification(tx, result.id));
    }
    this.metrics.increment(result.created ? 'notification_created_total' : 'notification_dedupe_hits_total', result.created ? { event_type: delivery.type } : undefined);
  }
}
