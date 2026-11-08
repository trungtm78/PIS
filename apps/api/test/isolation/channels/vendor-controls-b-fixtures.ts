import type { Client } from 'pg';
import type { TenantName } from '../suite';
import { VENDOR_FIXTURES } from './vendor-fixtures';

/** The objects of the bid security register and of the subcontracts (VND-2) that each tenant owns, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface VendorControlsBFixture {
  securityId: string;
  subcontractId: string;
}

const make = (variant: 'a0' | 'b0'): VendorControlsBFixture => {
  const id = (n: number): string => `00000000-0000-4000-${variant}d2-${String(n).padStart(12, '0')}`;
  return { securityId: id(1), subcontractId: id(2) };
};

export const VENDOR_CONTROLS_B_FIXTURES: Readonly<Record<TenantName, VendorControlsBFixture>> = { 'TNT-A': make('a0'), 'TNT-B': make('b0') };

export interface VendorControlsBSeedContext {
  tenantId: string;
  packageId: string;
  contractId: string;
  contractorId: string;
  membershipId: string;
  actorId: string;
}

/** Seeds one bid security (received) and one subcontract (proposed) for a tenant, on the package and the contract of its contract fixture; the subcontractor is the second contractor of the vendor fixture. */
export async function seedVendorControlsBFixtures(client: Client, tenant: TenantName, context: VendorControlsBSeedContext): Promise<void> {
  const f = VENDOR_CONTROLS_B_FIXTURES[tenant];
  const { tenantId, packageId, contractId, contractorId, membershipId } = context;
  await client.query(
    `insert into machvon.vendor_bid_security (tenant_id, id, package_id, contractor_id, kind, issuer, security_no, amount, issued_on, valid_until, received_by)
     values ($1, $2, $3, $4, 'BANK_GUARANTEE', 'Isolation bank', $5, 1000, date '2026-10-01', date '2027-06-30', $6) on conflict do nothing`,
    [tenantId, f.securityId, packageId, contractorId, `ISO-BL-${tenant}`, membershipId],
  );
  await client.query(
    `insert into machvon.vendor_subcontract (tenant_id, id, contract_id, subcontractor_id, scope, value, share_pct, proposed_by)
     values ($1, $2, $3, $4, 'Isolation scope of the subcontract', 1000, 10, $5) on conflict do nothing`,
    [tenantId, f.subcontractId, contractId, VENDOR_FIXTURES[tenant].otherContractorId, membershipId],
  );
}
