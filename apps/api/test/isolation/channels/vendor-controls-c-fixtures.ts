import type { Client } from 'pg';
import type { TenantName } from '../suite';

/** The objects of the risk grade (VND-2) that each tenant owns, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface VendorControlsCFixture {
  riskAssessmentId: string;
}

const make = (variant: 'a0' | 'b0'): VendorControlsCFixture => {
  const id = (n: number): string => `00000000-0000-4000-${variant}d5-${String(n).padStart(12, '0')}`;
  return { riskAssessmentId: id(1) };
};

export const VENDOR_CONTROLS_C_FIXTURES: Readonly<Record<TenantName, VendorControlsCFixture>> = { 'TNT-A': make('a0'), 'TNT-B': make('b0') };

export interface VendorControlsCSeedContext {
  tenantId: string;
  contractorId: string;
  membershipId: string;
}

/** Seeds one risk assessment waiting for its decision for a tenant, on the contractor of its contractor fixture. */
export async function seedVendorControlsCFixtures(client: Client, tenant: TenantName, context: VendorControlsCSeedContext): Promise<void> {
  const f = VENDOR_CONTROLS_C_FIXTURES[tenant];
  await client.query(
    `insert into machvon.vendor_risk_assessment (tenant_id, id, contractor_id, score, tier, score_tier, floored, factors, reasons, inputs, rule_version, rule_unverified, review_months, next_review_on, dual_check, as_of, assessed_by, created_by, updated_by)
     values ($1, $2, $3, 10, 'LOW', 'LOW', false, '[]'::jsonb, '{}'::text[], '{}'::jsonb, 'builtin', true, 24, date '2028-11-09', false, date '2026-11-09', $4, $4, $4) on conflict do nothing`,
    [context.tenantId, f.riskAssessmentId, context.contractorId, context.membershipId],
  );
}
