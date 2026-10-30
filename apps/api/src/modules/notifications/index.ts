import { AuditWriter, TenantDatabase } from '@machvon/db';
import type { DeliveryEngine, InboxHandlerRegistry } from '@machvon/db';
import type { MetricsSink } from '@machvon/kernel';
import { ChannelWebhookController } from '../../notifications/delivery/channel-webhook.controller';
import { CHANNEL_ADAPTERS } from '../../notifications/delivery/channel-adapters';
import type { ChannelAdapterRegistry } from '../../notifications/delivery/channel-adapters';
import { NotificationDeliveryController } from '../../notifications/delivery/delivery.controller';
import { DeliveryAttemptReadsController } from '../../notifications/delivery/delivery-reads.controller';
import { DELIVERY_ENGINE, NOT_METRICS } from '../../notifications/delivery/tokens';
import { WEBHOOK_PAYLOADS, WEBHOOK_SECRETS, EnvironmentWebhookSecrets, defaultWebhookPayloads } from '../../notifications/delivery/webhook-support';
import type { WebhookPayloadStore } from '../../notifications/delivery/webhook-support';
import { createDeliveryEngine, defaultChannelAdapters, registerChannelCallbacks } from '../../notifications/delivery/wiring';
import { ContactConsentReadsController, MyConsentsController } from '../../notifications/consents/consents.controller';
import { NotificationInstancesController, NotificationsController } from '../../notifications/notifications.controller';
import { MyPreferencesController } from '../../notifications/preferences/preferences.controller';
import { MyPreferencesReadController } from '../../notifications/preferences/preferences-read.controller';
import { NotificationWorkflowsController } from '../../notifications/workflows/workflows.controller';
import { ADM_INBOX_HANDLERS } from '../adm/tokens';
import { defineModule } from '../module-descriptor';

/** Injection token of the registration of the delivery-receipt adapters in the inbox (the provider names it registered). */
export const NOT_INBOX_REGISTRATION = Symbol('NOT_INBOX_REGISTRATION');

/**
 * NOT, the notification center: the in-app inbox and the notification metadata reads (ST-NOT-001), and the delivery engine (ST-NOT-002): the operator
 * reads of the attempts (NOT-11 to NOT-13), replay and cancel, and the provider webhook with its inbox adapters; and the preferences, quiet hours and consent
 * history of the person (ST-NOT-003, NOT-03, NOT-17). The code is in apps/api/src/notifications.
 */
export const notificationsModule = defineModule({
  code: 'NOT',
  controllers: [
    NotificationsController,
    NotificationInstancesController,
    NotificationDeliveryController,
    DeliveryAttemptReadsController,
    MyPreferencesController,
    MyPreferencesReadController,
    MyConsentsController,
    ContactConsentReadsController,
    NotificationWorkflowsController,
  ],
  // The provider webhook finds its tenant through the control plane (the channel account of the receipt), so it is active only where the application has one.
  controlPlane: { controllers: [ChannelWebhookController] },
  providers: [
    // MACHVON_ENVIRONMENT names the deployment; unset or unknown means production, where no MOCK adapter is registered and no channel can send.
    { provide: CHANNEL_ADAPTERS, useFactory: () => defaultChannelAdapters(process.env.MACHVON_ENVIRONMENT) },
    { provide: WEBHOOK_SECRETS, useFactory: () => new EnvironmentWebhookSecrets() },
    { provide: WEBHOOK_PAYLOADS, useFactory: () => defaultWebhookPayloads() },
    {
      provide: DELIVERY_ENGINE,
      useFactory: (database: TenantDatabase, metrics?: MetricsSink) => createDeliveryEngine(new AuditWriter(database), metrics),
      inject: [TenantDatabase, { token: NOT_METRICS, optional: true }],
    },
    {
      provide: NOT_INBOX_REGISTRATION,
      useFactory: (registry: InboxHandlerRegistry, adapters: ChannelAdapterRegistry, payloads: WebhookPayloadStore, engine: DeliveryEngine) =>
        registerChannelCallbacks(registry, adapters, payloads, engine),
      inject: [ADM_INBOX_HANDLERS, CHANNEL_ADAPTERS, WEBHOOK_PAYLOADS, DELIVERY_ENGINE],
    },
  ],
});
