import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/** A rule as a store reads it: the policy, the version of the rule that decided (0 is the built-in default) and whether the numbers are still an unconfirmed default. */
export interface PolicyReading<T> {
  policy: T;
  version: number;
  unverified: boolean;
}

const PORT = new GovernancePolicyPort();

/**
 * Reads the policy of `type` in force on `today`: the approved rule of the tenant, else the built-in default of the kernel. A rule whose params do not parse is not trusted: the built-in default answers and says it is
 * unverified, so a damaged rule never turns a deadline into zero days. The same function serves every rule type of lane GOV-12.
 */
export async function readPolicy<T>(tx: TenantTx, type: string, today: string, parse: (params: Record<string, unknown>) => T, defaults: () => T): Promise<PolicyReading<T>> {
  const resolved = await PORT.get(tx, type, 'DEFAULT', today);
  if (resolved === undefined) return { policy: defaults(), version: 0, unverified: true };
  try {
    return { policy: parse(resolved.params), version: resolved.version, unverified: resolved.unverified };
  } catch {
    return { policy: defaults(), version: 0, unverified: true };
  }
}

/** A timestamp column as an ISO text in UTC. */
export const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** A date column as `YYYY-MM-DD`. */
export const DAY = (column: string): string => `to_char(${column}, 'YYYY-MM-DD')`;
