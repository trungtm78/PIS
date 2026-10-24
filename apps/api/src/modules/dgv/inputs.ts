import type { DatasetViewer } from '@machvon/db';
import { DomainError, activeGrants, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const MAX_TEXT = 200;

/** A short text of a query parameter: absent stays absent, empty or long or holding a NUL is 422 naming the parameter. */
export function textOf(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > MAX_TEXT || value.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

/** An id of a body or a query as a lower-case uuid; anything else is 422 naming the field. */
export function uuidOf(value: unknown, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/**
 * The data quality commands govern datasets that belong to no organisation unit, so a grant on a unit or a project does not reach them: the
 * caller must hold the permission through a grant on the whole tenant (403 SCOPE_DENIED otherwise).
 */
export function assertTenantAuthority(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/** The viewer of a request: the person and the roles of the grants in force, whatever their scope (a dataset belongs to no organisation unit). */
export function viewerOf(tenant: TenantContext, access: EffectiveAccess): DatasetViewer {
  return { membershipId: tenant.membershipId, roleCodes: [...new Set(activeGrants(access, new Date()).map((grant) => grant.roleCode))] };
}
