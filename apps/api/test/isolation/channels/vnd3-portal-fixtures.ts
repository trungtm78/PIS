import type { Client } from 'pg';
import type { TenantName } from '../suite';

/** The objects of the contractor portal (VND-3) that each tenant owns, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface VendorPortalFixture {
  requestId: string;
  planId: string;
  actionId: string;
}

const make = (variant: 'a0' | 'b0'): VendorPortalFixture => {
  const id = (n: number): string => `00000000-0000-4000-${variant}d5-${String(n).padStart(12, '0')}`;
  return { requestId: id(1), planId: id(2), actionId: id(3) };
};

export const VENDOR_PORTAL_FIXTURES: Readonly<Record<TenantName, VendorPortalFixture>> = { 'TNT-A': make('a0'), 'TNT-B': make('b0') };

/** Seeds one request, one plan and one action of the contractor for a tenant. */
export async function seedVendorPortalFixtures(client: Client, tenant: TenantName, context: { tenantId: string; contractorId: string; membershipId: string }): Promise<void> {
  const f = VENDOR_PORTAL_FIXTURES[tenant];
  const { tenantId, contractorId, membershipId } = context;
  await client.query(
    `insert into machvon.contractor_portal_request (tenant_id, id, contractor_id, kind, title, body, due_at, deadline_policy_version, remind_before_days, requested_by)
     values ($1, $2, $3, 'INFORMATION', $4, 'Isolation request to the contractor', now() + interval '10 days', 'builtin', 2, $5) on conflict do nothing`,
    [tenantId, f.requestId, contractorId, `Isolation request of ${tenant}`, membershipId],
  );
  await client.query(
    `insert into machvon.contractor_remediation_plan (tenant_id, id, contractor_id, trigger_kind, title, objective, proposed_by)
     values ($1, $2, $3, 'MANUAL', $4, 'Isolation plan of remediation of the contractor', $5) on conflict do nothing`,
    [tenantId, f.planId, contractorId, `Isolation plan of ${tenant}`, membershipId],
  );
  await client.query(
    `insert into machvon.contractor_remediation_action (tenant_id, id, plan_id, contractor_id, seq, description, due_on)
     values ($1, $2, $3, $4, 1, 'Isolation action of a plan of remediation', current_date + 30) on conflict do nothing`,
    [tenantId, f.actionId, f.planId, contractorId],
  );
}
