import { VendorScreeningStore } from '@machvon/db';
import type { ScreeningRunSummary, TenantDatabase } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';

export const VENDOR_SCREENING_METRIC = 'vnd_screening_hits_new_total';

export interface VendorScreeningDeps {
  metrics?: MetricsSink;
}

/**
 * The job `vendor-screening` (VND-3, V14, every night) for one tenant: every contractor of the register is compared with every entry of the lists of parties that may not be dealt with (the national list the file import keeps
 * and the lists imported by source), with the rule in force. A new hit above the hold line holds the contractor until a person decides; a dismissal that ran out or whose entry changed is asked again; a hit whose entry left the list
 * is resolved. The screening never bans.
 */
export async function runVendorScreening(database: TenantDatabase, tenant: TenantContext, now: Date, deps: VendorScreeningDeps = {}): Promise<ScreeningRunSummary> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const store = new VendorScreeningStore();
  const result = await database.withTenant(tenant, (tx) => store.run(tx, null, 'NIGHTLY', now, vietnamDateOf(now)));
  for (let n = 0; n < result.hitsNew; n += 1) metrics.increment(VENDOR_SCREENING_METRIC);
  return result;
}
