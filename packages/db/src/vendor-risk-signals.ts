import type { TenantTx } from './tenant-database.ts';
import { VendorFinanceStore } from './vendor-finance-store.ts';
import { VendorPolicyReader } from './vendor-policy.ts';
import { securityForfeitCount } from './vendor-security-store.ts';
import { subcontractBreachCount } from './vendor-subcontract-store.ts';

/**
 * The readings of the risk grade that other slices of the controls own (VND-2): the finance status and the load of the contractor, the findings of independence nobody decided, the breaches of the subcontract limits
 * and the forfeited securities. A reader that is not given counts as unknown (a status of null, a count of zero), never as a pass; the glue that wires the real readers is `vendorRiskSignals` below.
 */
export interface VendorRiskSignalPort {
  finance?(tx: TenantTx, contractorId: string, today: string): Promise<'MEETS' | 'BELOW' | 'INSUFFICIENT_DATA' | null>;
  load?(tx: TenantTx, contractorId: string, today: string): Promise<'WITHIN' | 'OVER' | 'NO_DATA' | null>;
  openStrongFindings?(tx: TenantTx, contractorId: string, today: string): Promise<number>;
  subcontractBreaches?(tx: TenantTx, contractorId: string, today: string): Promise<number>;
  securityForfeits?(tx: TenantTx, contractorId: string, today: string): Promise<number>;
}

/** The readers wired for the risk grade: finance and load of the finance store, the strong findings nobody decided, the breaches of the subcontract limits and the forfeited securities. */
const policies = new VendorPolicyReader();
const finance = new VendorFinanceStore();

export const vendorRiskSignals: VendorRiskSignalPort = {
  finance: async (tx, contractorId, today) => (await finance.assessFor(tx, contractorId, undefined, await policies.finance(tx, today))).assessment.overall,
  load: async (tx, contractorId, today) => (await finance.capacity(tx, contractorId, today, await policies.finance(tx, today), await policies.capacity(tx, today))).assessment.status,
  openStrongFindings: async (tx, contractorId) => {
    const [row] = await tx.query<{ count: string }>(
      `select count(*)::text as count from machvon.vendor_independence_finding f
        where f.decision is null and f.strength = 'STRONG' and f.parties @> $1::jsonb
          and f.check_id = (select k.id from machvon.vendor_independence_check k where k.tenant_id = f.tenant_id and k.package_id = f.package_id order by k.run_at desc, k.id desc limit 1)`,
      [JSON.stringify([{ kind: 'CONTRACTOR', id: contractorId }])],
    );
    return Number(row?.count ?? 0);
  },
  subcontractBreaches: (tx, contractorId, today) => subcontractBreachCount(tx, contractorId, today),
  securityForfeits: (tx, contractorId) => securityForfeitCount(tx, contractorId),
};
