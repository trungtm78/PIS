import { AuditWriter, BillingStore, EINVOICE_PROVIDER, PLATFORM_DOMAIN, sharedMockDomainPorts, EntitlementOverrideStore, PlanStore, SubscriptionStore, SupportAccessStore, TenantBootstrapStore, ThemeStore, UsageMeterStore, sharedMockEInvoiceProvider } from '@machvon/db';
import type { InboxHandlerRegistry } from '@machvon/db';
import { TenantDatabase } from '@machvon/db';
import { WEBHOOK_PAYLOADS } from '../../notifications/delivery/webhook-support';
import type { WebhookPayloadStore } from '../../notifications/delivery/webhook-support';
import { ADM_INBOX_HANDLERS } from '../adm/tokens';
import { defineModule } from '../module-descriptor';
import { BillingController } from './billing.controller';
import { EntitlementOverrideController } from './entitlement-override.controller';
import { InvoiceLinesController } from './invoice-lines.controller';
import { PaymentController } from './payment.controller';
import { EInvoiceWebhookController, PaymentWebhookController, registerPaymentCallbacks } from './payment-webhook.controller';
import { FeatureFlagController } from './feature-flag.controller';
import { PlanController } from './plan.controller';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionReadsController } from './subscription-reads.controller';
import { SupportAccessController, SupportAccessReadsController, SupportAccessRequestController } from './support-access.controller';
import { SupportTokenController } from './support-token.controller';
import { DOMAIN_PORTS, PLATFORM_DOMAIN_TOKEN, TenantDomainController } from './tenant-domain.controller';
import { SystemTenantExportsController, TenantExportController, TenantExportFilesController } from './tenant-export.controller';
import { TenantOwnerController } from './tenant-owner.controller';
import { TenantStateController } from './tenant-state.controller';
import { TenantThemeController } from './tenant-theme.controller';
import { ThemeController } from './theme.controller';
import { UsageController } from './usage.controller';
import { UsageControlController } from './usage-control.controller';
import { WEBHOOK_PROVIDERS, defaultWebhookProviders } from './webhook-providers';
import type { WebhookProviderRegistry } from './webhook-providers';

/** Where the inbox handlers of the payment and e-invoice providers are registered (it provides the names of the providers). */
const SAS_INBOX_REGISTRATION = Symbol('SAS_INBOX_REGISTRATION');

/**
 * SAS, the system administration of the control plane: the tenant lifecycle commands of ST-SAS-004, the owner assignment
 * of ST-SAS-006, the tenant themes of ST-SAS-005, the plan catalogue of ST-SAS-007, the usage metering of ST-SAS-010 and the
 * subscriptions of ST-SAS-008, the entitlement overrides of ST-SAS-009 and the billing run and e-invoice of ST-SAS-011, and the controlled support access of ST-SAS-015 (the request is a control command; the approval, the revocation and the reads are the tenant's). The tenant registry of ST-SAS-001 stays in apps/api/src/system-tenants.controller.ts.
 * The commands and the System Admin reads need the control plane; the read of the published theme by a member of the tenant
 * (getMyPublishedTheme) needs only the tenant database and is active without it.
 */
export const sasModule = defineModule({
  code: 'SAS',
  controllers: [TenantThemeController, UsageController, SubscriptionReadsController, InvoiceLinesController, SupportAccessController, SupportAccessReadsController, TenantExportController, TenantExportFilesController],
  providers: [
    { provide: ThemeStore, useFactory: () => new ThemeStore() },
    { provide: UsageMeterStore, useFactory: () => new UsageMeterStore() },
    { provide: SubscriptionStore, useFactory: () => new SubscriptionStore() },
    { provide: BillingStore, useFactory: () => new BillingStore() },
    { provide: SupportAccessStore, useFactory: () => new SupportAccessStore() },
  ],
  controlPlane: {
    controllers: [SupportAccessRequestController, SupportTokenController, SystemTenantExportsController, TenantDomainController, TenantStateController, TenantOwnerController, ThemeController, FeatureFlagController, PlanController, UsageControlController, SubscriptionController, EntitlementOverrideController, BillingController, PaymentController, PaymentWebhookController, EInvoiceWebhookController],
    providers: [
      // The exchange of a grant for a support token writes its audit rows outside a command.
      { provide: AuditWriter, useFactory: (database: TenantDatabase) => new AuditWriter(database), inject: [TenantDatabase] },
      // The DNS lookup and the certificate authority are the MOCK until real ones are bound (D05/D06): the same pair serves the commands and the lifecycle job.
      { provide: DOMAIN_PORTS, useFactory: () => sharedMockDomainPorts() },
      { provide: PLATFORM_DOMAIN_TOKEN, useFactory: () => process.env.MACHVON_PLATFORM_DOMAIN ?? PLATFORM_DOMAIN },
      { provide: TenantBootstrapStore, useFactory: () => new TenantBootstrapStore() },
      { provide: PlanStore, useFactory: () => new PlanStore() },
      { provide: EntitlementOverrideStore, useFactory: () => new EntitlementOverrideStore() },
      // The provider of e-invoices is the MOCK until a contract with a real one exists (D05/D06): the same instance serves the commands and the worker.
      { provide: EINVOICE_PROVIDER, useFactory: () => sharedMockEInvoiceProvider() },
      // The providers whose callbacks the control plane takes: none in production until a contract with a real one exists (D05/D06).
      { provide: WEBHOOK_PROVIDERS, useFactory: () => defaultWebhookProviders(process.env.MACHVON_ENVIRONMENT) },
      {
        provide: SAS_INBOX_REGISTRATION,
        useFactory: (registry: InboxHandlerRegistry, providers: WebhookProviderRegistry, payloads: WebhookPayloadStore) => registerPaymentCallbacks(registry, providers, payloads),
        inject: [ADM_INBOX_HANDLERS, WEBHOOK_PROVIDERS, WEBHOOK_PAYLOADS],
      },
    ],
  },
});
