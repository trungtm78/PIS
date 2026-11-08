import { permissionMatches } from './permission.ts';
import { scopeContains, scopeCovers } from './scope.ts';
import type { ResourceRef, Scope } from './scope.ts';

export interface GrantView {
  roleCode: string;
  rank: number;
  /** Exact permission names or `prefix.*` patterns, as stored on the role. */
  permissions: readonly string[];
  scope: Scope;
  status: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  /** The report periods the grant is limited to (IAM-2); absent or null when it is not limited. */
  periodCodes?: readonly string[] | null | undefined;
}

export interface EffectiveAccess {
  membershipId: string;
  /** The database value of `membership.scope_version` when this access was computed. */
  scopeVersion: number;
  membershipActive: boolean;
  grants: readonly GrantView[];
}

/** Grants that count now: the membership is Active, the grant is Active and `effectiveFrom <= now < effectiveUntil`. */
export function activeGrants(access: EffectiveAccess, now: Date): GrantView[] {
  if (!access.membershipActive) return [];
  const at = now.getTime();
  return access.grants.filter(
    (grant) =>
      grant.status === 'Active' && grant.effectiveFrom.getTime() <= at && (grant.effectiveUntil === null || at < grant.effectiveUntil.getTime()),
  );
}

/** The held permission strings of the active grants, narrowed to the grants whose scope contains `resource` when given. */
export function effectivePermissions(access: EffectiveAccess, now: Date, resource?: ResourceRef): Set<string> {
  const held = new Set<string>();
  for (const grant of activeGrants(access, now)) {
    if (resource !== undefined && !scopeContains(grant.scope, resource)) continue;
    for (const permission of grant.permissions) held.add(permission);
  }
  return held;
}

/** The highest rank among the active grants whose scope covers `scope`; 0 when there is none. */
export function maxRank(access: EffectiveAccess, now: Date, scope: Scope): number {
  return activeGrants(access, now)
    .filter((grant) => scopeCovers(grant.scope, scope))
    .reduce((highest, grant) => Math.max(highest, grant.rank), 0);
}

/** Whether any held permission grants `permission`. */
export function holdsPermission(held: ReadonlySet<string>, permission: string): boolean {
  for (const pattern of held) if (permissionMatches(pattern, permission)) return true;
  return false;
}
