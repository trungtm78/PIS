import { activeGrants, effectivePermissions, holdsPermission, permissionMatches } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef } from '@machvon/kernel';
import type { LandProjectRef } from '@machvon/db';

/** Whether a grant that carries the permission has a scope that contains one of the places. */
export function reaches(access: EffectiveAccess, permission: string, refs: readonly ResourceRef[], now: Date): boolean {
  return refs.some((ref) => holdsPermission(effectivePermissions(access, now, ref), permission));
}

/** The places a project lies in for the permission test: the units that own and invest in it, each with the project. */
export function projectRefs(project: LandProjectRef): ResourceRef[] {
  const units = project.investorUnit === null ? [project.ownerUnit] : [project.ownerUnit, project.investorUnit];
  return units.map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId: project.id }));
}

/** The place of a parcel: the unit that answers for it, within its project. A grant on the unit tree or on the project reaches it. */
export function parcelRef(place: { projectId: string; ownerUnit: { id: string; path: string } }): ResourceRef {
  return { ownerUnitPath: place.ownerUnit.path, ownerUnitId: place.ownerUnit.id, projectId: place.projectId };
}

/**
 * Whether the permission is held over the whole project: by a grant on the whole tenant or by a grant that names the project. A grant on a unit tree
 * is not enough, because it reaches the parcels of its own units and not those of the project's other units. A file of parcels covers every unit
 * of the project and uses up its identity once, so only the holder of such a permission may import one (a narrower grant could shadow a file for a wider one).
 */
export function holdsOnProject(access: EffectiveAccess, permission: string, projectId: string, now: Date): boolean {
  return activeGrants(access, now).some((grant) => {
    if (!grant.permissions.some((held) => permissionMatches(held, permission))) return false;
    return grant.scope.kind === 'TENANT' || (grant.scope.kind === 'PROJECT' && grant.scope.refIds.some((ref) => ref.toLowerCase() === projectId.toLowerCase()));
  });
}
