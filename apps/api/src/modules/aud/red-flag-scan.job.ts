import { RedFlagStore } from '@machvon/db';
import type { ScanResult, TenantDatabase } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';

export const RED_FLAG_SCAN_METRIC = 'aud_red_flag_scan_flagged_total';
/** A scan is keyed by the day and the six-hour slot it runs in, so a job that runs twice in a slot (or two processes) scans once. */
const SLOT_HOURS = 6;

export const scanKeyOf = (now: Date): string => `slot:${now.toISOString().slice(0, 10)}T${String(Math.floor(now.getUTCHours() / SLOT_HOURS) * SLOT_HOURS).padStart(2, '0')}`;

export interface RedFlagScanDeps {
  metrics?: MetricsSink;
}

/**
 * The job `red-flag-scan` (G4-3, every six hours) for one tenant: every approved package and every contract with no package is evaluated by the twelve indicators of the OCP catalogue with the rules in force, and the findings
 * that have a score are written (and rescored, or reopened when a cleared one gets a new signal). An indicator whose input is not there says so and never counts as clear. The scan of a slot is recorded once.
 */
export async function runRedFlagScan(database: TenantDatabase, tenant: TenantContext, now: Date, deps: RedFlagScanDeps = {}): Promise<ScanResult> {
  const metrics = deps.metrics ?? NOOP_METRICS;
  const store = new RedFlagStore();
  const result = await database.withTenant(tenant, (tx) => store.scan(tx, now, scanKeyOf(now), vietnamDateOf(now)));
  for (let n = 0; n < result.flagged; n += 1) metrics.increment(RED_FLAG_SCAN_METRIC);
  return result;
}
