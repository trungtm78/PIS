import { effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';

/** Whether a grant that carries the permission has a scope that contains the unit. */
export function reaches(access: EffectiveAccess, permission: string, unit: { id: string; path: string }, now: Date): boolean {
  return holdsPermission(effectivePermissions(access, now, { ownerUnitPath: unit.path, ownerUnitId: unit.id }), permission);
}
