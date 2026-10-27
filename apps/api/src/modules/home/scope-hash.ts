import { PERMISSIONS } from '@machvon/contracts';
import { homeScopeFingerprint, homeScopeHash } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';

/** The permission that opens HOME (the same for the center and for the drill). */
export const HOME_READ_PERMISSION = PERMISSIONS.getCommandCenter;

/** The scope the reader is reading in now, as the hash a token carries: the member, the version of their grants, what the grants that carry `home.read` let them read at this moment, and the unit they narrowed to. */
export function scopeHashOf(tenant: TenantContext, access: EffectiveAccess, unitId: string | null, now: Date): string {
  return homeScopeHash({ membershipId: tenant.membershipId, scopeVersion: tenant.scopeVersion, unitId, grants: homeScopeFingerprint(access, HOME_READ_PERMISSION, now) });
}
