import type { Client } from 'pg';
import type { TenantName } from '../suite';

/** The objects of the independence and finance controls (VND-2) that each tenant owns, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface VendorControlsAFixture {
  interestId: string;
  checkId: string;
  findingId: string;
  periodId: string;
}

const make = (variant: 'a0' | 'b0'): VendorControlsAFixture => {
  const id = (n: number): string => `00000000-0000-4000-${variant}d3-${String(n).padStart(12, '0')}`;
  return { interestId: id(1), checkId: id(2), findingId: id(3), periodId: id(4) };
};

export const VENDOR_CONTROLS_A_FIXTURES: Readonly<Record<TenantName, VendorControlsAFixture>> = { 'TNT-A': make('a0'), 'TNT-B': make('b0') };

export interface VendorControlsASeedContext {
  tenantId: string;
  packageId: string;
  contractorId: string;
  membershipId: string;
  actorId: string;
}

/** Seeds one interest, one run of the check with one finding, one financial period and the controls of the package for a tenant. */
export async function seedVendorControlsAFixtures(client: Client, tenant: TenantName, context: VendorControlsASeedContext): Promise<void> {
  const f = VENDOR_CONTROLS_A_FIXTURES[tenant];
  const { tenantId, packageId, contractorId, membershipId, actorId } = context;
  await client.query(
    `insert into machvon.vendor_person_interest (tenant_id, id, membership_id, kind, contractor_id, created_by, updated_by)
     values ($1, $2, $3, 'ADVISORY', $4, $5, $5) on conflict do nothing`,
    [tenantId, f.interestId, membershipId, contractorId, actorId],
  );
  await client.query(
    `insert into machvon.vendor_independence_check (tenant_id, id, package_id, run_by, rule_version, rule_unverified, inputs_digest, bidders_count, findings_count, strong_count)
     values ($1, $2, $3, $4, 'builtin', true, repeat('a', 64), 0, 1, 1) on conflict do nothing`,
    [tenantId, f.checkId, packageId, actorId],
  );
  await client.query(
    `insert into machvon.vendor_independence_finding (tenant_id, id, check_id, package_id, fingerprint, kind, strength, parties, raised_by)
     values ($1, $2, $3, $4, $5, 'BIDDERS_SHARE_TAX_HEAD', 'STRONG', '[]'::jsonb, $6) on conflict do nothing`,
    [tenantId, f.findingId, f.checkId, packageId, `BIDDERS_SHARE_TAX_HEAD|CONTRACTOR:${tenant}|CONTRACTOR:other`, actorId],
  );
  await client.query(
    `insert into machvon.vendor_financial_period (tenant_id, id, contractor_id, fiscal_year, revenue, total_assets, current_assets, current_liabilities, total_debt, equity, ebit, interest_expense, created_by, updated_by)
     values ($1, $2, $3, 2025, 1000, 2000, 1000, 500, 900, 1100, 300, 100, $4, $4) on conflict do nothing`,
    [tenantId, f.periodId, contractorId, actorId],
  );
  await client.query(`insert into machvon.vendor_package_control (tenant_id, package_id, security_base_amount, created_by, updated_by) values ($1, $2, 1000, $3, $3) on conflict do nothing`, [tenantId, packageId, actorId]);
}
