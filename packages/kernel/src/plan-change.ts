import { canonicalJson, sha256Hex } from './canonical-json.ts';
import type { FeatureEntry } from './entitlement.ts';

export type PlanChangeEffective = 'NOW' | 'NEXT_CYCLE';

/** A quota of the new plan that what the tenant has already passes (`quota_violations` of the preview). */
export interface QuotaViolation {
  featureCode: string;
  used: string;
  newLimit: string;
}

/**
 * The quotas of the target plan that the tenant is already over: a downgrade does not take anything away, it lists what no longer fits so that
 * the person who changes the plan knows that, from the day the plan takes effect, nothing more can be added (BR-SAS-09). `used` has the measure of each
 * quota feature that is counted (the staff seats for `member.seats`); a quota nobody counts yet is not listed.
 */
export function quotaViolations(target: readonly FeatureEntry[], used: ReadonlyMap<string, number>): QuotaViolation[] {
  return target
    .flatMap((entry): QuotaViolation[] => {
      const measured = used.get(entry.featureCode);
      if (entry.limitKind !== 'QUOTA' || entry.limitValue === undefined || measured === undefined || measured <= entry.limitValue) return [];
      return [{ featureCode: entry.featureCode, used: String(measured), newLimit: String(entry.limitValue) }];
    })
    .sort((a, b) => (a.featureCode < b.featureCode ? -1 : a.featureCode > b.featureCode ? 1 : 0));
}

/** Everything a plan change was judged on: the preview is good for exactly this state of the world and no other. */
export interface PlanChangeFacts {
  subscriptionId: string;
  subscriptionVersion: number;
  fromPlanVersionId: string;
  targetPlanVersionId: string;
  effective: PlanChangeEffective;
  /** The day the preview was made on (the proration depends on it). */
  today: string;
  periodStart: string;
  periodEnd: string;
  prorationVnd: string;
  effectiveAt: string;
  violations: readonly QuotaViolation[];
  /** The entitlements of the tenant as they were: a change of them (an override, a licence) makes a preview of the plan stale. */
  entitlementsHash: string;
}

/**
 * The token that ties an application of a plan change to the preview the person saw (409 PREVIEW_STALE when it no longer matches). It is not a secret and not
 * a signature: the server works the proration out again from the state, never from the token, and the token only says whether that state is still the one that
 * was shown.
 */
export function planChangeHash(facts: PlanChangeFacts): string {
  return sha256Hex(canonicalJson(facts));
}
