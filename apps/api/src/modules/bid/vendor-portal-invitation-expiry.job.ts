import { VendorPortalInvitationStore } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import type { TenantContext } from '@machvon/kernel';

/**
 * The job `vendor-portal-invitation-expiry` (PORTAL-2, every night) for one tenant: proposals of portal access nobody approved in time and approved accesses past their end become EXPIRED, and the guest membership of an expired
 * access is ended with its grants. The same rule as the commands decides; nothing here is a new right.
 */
export async function runVendorPortalInvitationExpiry(database: TenantDatabase, tenant: TenantContext, now: Date): Promise<{ proposals: number; accesses: number }> {
  const store = new VendorPortalInvitationStore();
  return database.withTenant(tenant, (tx) => store.expireDue(tx, now));
}
