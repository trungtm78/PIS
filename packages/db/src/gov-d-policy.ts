import { vietnamDateOf } from '@machvon/kernel';
import type { ResolveOptions, RuleParams } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The threshold of a control of lane D (separation of duties, payment integrity, disbursement ceilings, Treasury reconciliation) as the control reads it: the params, the version of the rule that decided
 * (0 for the built-in default, stored on the result that used it) and whether the numbers are a starting value nobody confirmed (a screen says so).
 */
export interface GovDRule<P extends RuleParams = RuleParams> {
  type: string;
  code: string;
  params: P;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
}

export interface GovDFallback<P extends RuleParams> {
  params: P;
  /** The numbers behind the default are not confirmed against the legal text or with the customer. */
  unverified: boolean;
}

/**
 * The one door through which lane D reads a threshold. It asks the governance port (`governance_rule`, an approved version in force on the day, else the kernel's built-in default) and, for a type or a
 * code the kernel has no default for (the types of lane D that the platform list does not know yet), it answers with the `fallback` that the control carries, so no threshold is a constant of a command.
 * Nothing is written here and the read stays inside the transaction of the caller (row-level security keeps tenants apart).
 */
export async function resolveGovD<P extends RuleParams>(
  tx: TenantTx,
  type: string,
  code: string,
  asOf: string | Date,
  fallback: GovDFallback<P>,
  options: ResolveOptions = {},
  port: GovernancePolicyPort = new GovernancePolicyPort(),
): Promise<GovDRule<P>> {
  const day = typeof asOf === 'string' ? asOf : vietnamDateOf(asOf);
  const found = await port.get(tx, type, code, day, options);
  if (found !== undefined) return { type, code, params: found.params as P, version: found.version, source: found.source, unverified: found.unverified };
  return { type, code, params: fallback.params, version: 0, source: 'DEFAULT', unverified: fallback.unverified };
}
