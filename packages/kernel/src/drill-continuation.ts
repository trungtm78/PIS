import { effectivePermissions, holdsPermission } from './effective-access.ts';
import type { EffectiveAccess } from './effective-access.ts';
import { DomainError } from './errors.ts';

/** A drill that was opened earlier: who opened it, under which permission, and the unit the next level of it is about. */
export interface DrillContinuation {
  id: string;
  /** The membership whose permission the drill continues under, as it is when the person asks for the next level. */
  membershipId: string;
  permission: string;
  unitId: string;
}

export interface DrillDeps<Row> {
  now(): Date;
  loadAccess(membershipId: string): Promise<EffectiveAccess>;
  /** Whether the access reaches this unit for the permission now (grants resolved to units, in the tenant of the drill). */
  reachesUnit(access: EffectiveAccess, permission: string, unitId: string, now: Date): Promise<boolean>;
  /** The rows of the next level of the drill for the unit; only called once the unit has been judged. */
  rows(unitId: string): Promise<Row[]>;
}

/**
 * Continues a drill under the permission the person holds when they ask, not when the drill was opened (NFR-TENANCY, UAT-AC481): a unit whose grant was revoked in between answers
 * 403 SCOPE_DENIED, with nothing that names a project, a count or a unit, and the rows of that level are never read. A drill whose person has lost the permission, or whose membership
 * is no longer active, is refused the same way.
 */
export async function continueDrill<Row>(drill: DrillContinuation, deps: DrillDeps<Row>): Promise<Row[]> {
  const now = deps.now();
  const access = await deps.loadAccess(drill.membershipId);
  const allowed =
    access.membershipActive && holdsPermission(effectivePermissions(access, now), drill.permission) && (await deps.reachesUnit(access, drill.permission, drill.unitId, now));
  if (!allowed) throw new DomainError('SCOPE_DENIED', 403);
  return deps.rows(drill.unitId);
}
