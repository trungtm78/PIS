import { BillingStore, EINVOICE_PROVIDER, EntitlementOverrideStore, PlanStore, SubscriptionStore, TenantBootstrapStore, ThemeStore, UsageMeterStore, sharedMockEInvoiceProvider } from '@machvon/db';
import { defineModule } from '../module-descriptor';
import { BillingController } from './billing.controller';
import { EntitlementOverrideController } from './entitlement-override.controller';
import { InvoiceLinesController } from './invoice-lines.controller';
import { PlanController } from './plan.controller';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionReadsController } from './subscription-reads.controller';
import { TenantOwnerController } from './tenant-owner.controller';
import { TenantStateController } from './tenant-state.controller';
import { TenantThemeController } from './tenant-theme.controller';
import { ThemeController } from './theme.controller';
import { UsageController } from './usage.controller';
import { UsageControlController } from './usage-control.controller';

/**
 * SAS, the system administration of the control plane: the tenant lifecycle commands of ST-SAS-004, the owner assignment
 * of ST-SAS-006, the tenant themes of ST-SAS-005, the plan catalogue of ST-SAS-007, the usage metering of ST-SAS-010 and the
 * subscriptions of ST-SAS-008, the entitlement overrides of ST-SAS-009 and the billing run and e-invoice of ST-SAS-011. The tenant registry of ST-SAS-001 stays in apps/api/src/system-tenants.controller.ts.
 * The commands and the System Admin reads need the control plane; the read of the published theme by a member of the tenant
 * (getMyPublishedTheme) needs only the tenant database and is active without it.
 */
export const sasModule = defineModule({
  code: 'SAS',
  controllers: [TenantThemeController, UsageController, SubscriptionReadsController, InvoiceLinesController],
  providers: [
    { provide: ThemeStore, useFactory: () => new ThemeStore() },
    { provide: UsageMeterStore, useFactory: () => new UsageMeterStore() },
    { provide: SubscriptionStore, useFactory: () => new SubscriptionStore() },
    { provide: BillingStore, useFactory: () => new BillingStore() },
  ],
  controlPlane: {
    controllers: [TenantStateController, TenantOwnerController, ThemeController, PlanController, UsageControlController, SubscriptionController, EntitlementOverrideController, BillingController],
    providers: [
      { provide: TenantBootstrapStore, useFactory: () => new TenantBootstrapStore() },
      { provide: PlanStore, useFactory: () => new PlanStore() },
      { provide: EntitlementOverrideStore, useFactory: () => new EntitlementOverrideStore() },
      // The provider of e-invoices is the MOCK until a contract with a real one exists (D05/D06): the same instance serves the commands and the worker.
      { provide: EINVOICE_PROVIDER, useFactory: () => sharedMockEInvoiceProvider() },
    ],
  },
});
