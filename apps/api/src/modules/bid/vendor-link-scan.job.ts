import { VendorLeadStore } from '@machvon/db';
import type { ScanSummary, TenantDatabase } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';

export const VENDOR_LEAD_METRIC = 'vnd_investigation_leads_new_total';

export interface VendorLinkScanDeps {
  metrics?: MetricsSink;
}

/**
 * The job `vendor-link-scan` (VND-3, V6, every night) for one tenant: the related-party links are recomputed from the keys of the register of contractors and the traces of the submissions, the packages closed in the window of the
 * rule are screened for signals of bid rigging, and every finding becomes a lead or updates its lead. A scan twice in a night changes nothing but the count of evaluations. Leads are signals for the auditors, never conclusions.
 */
export async function runVendorLinkScan(database: TenantDatabase, tenant: TenantContext, now: Date, deps: VendorLinkScanDeps = {}): Promise<ScanSummary> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const store = new VendorLeadStore();
  const result = await database.withTenant(tenant, (tx) => store.scan(tx, null, 'JOB', now, vietnamDateOf(now)));
  for (let n = 0; n < result.leadsNew; n += 1) metrics.increment(VENDOR_LEAD_METRIC);
  return result;
}
