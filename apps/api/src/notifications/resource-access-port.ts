import { activeGrants, holdsPermission, scopeContains } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import type { NotificationRef } from '@machvon/db';

export type ResourceRef = NonNullable<NotificationRef['resource']>;

/**
 * Whether a member may read the thing a notification is about. A notification never carries record data: its
 * content is shown only while this answers true, and "content unavailable" is shown instead when it does not
 * (NOT 3.2). The check is synchronous over an already loaded EffectiveAccess, so a list of notifications costs
 * one access load.
 */
export interface ResourceAccessPort {
  canRead(access: EffectiveAccess, resource: ResourceRef, now: Date): boolean;
}

// The resource of type `project` is the project itself, and the one of type `contract` is the contract itself.
function projectOf(resource: ResourceRef): string | undefined {
  return resource.projectId ?? (resource.type === 'project' ? resource.id : undefined);
}

function contractOf(resource: ResourceRef): string | undefined {
  return resource.contractId ?? (resource.type === 'contract' ? resource.id : undefined);
}

/** Whether one grant scope contains the resource. What cannot be established is not contained. */
function scopeReaches(scope: Scope, resource: ResourceRef): boolean {
  switch (scope.kind) {
    case 'TENANT':
      return true;
    case 'PROJECT': {
      const project = projectOf(resource);
      return project !== undefined && scope.refIds.includes(project);
    }
    case 'CONTRACT': {
      const contract = contractOf(resource);
      return contract !== undefined && scope.refIds.includes(contract);
    }
    case 'UNIT_SUBTREE':
    case 'UNIT_ONLY':
      // A unit scope needs the owner unit (or the investing unit, when the resource names one) and its path; an event that names no unit, or a unit that cannot be resolved, is not reached.
      return (
        (resource.ownerUnitId !== undefined && resource.ownerUnitPath !== undefined && scopeContains(scope, { ownerUnitId: resource.ownerUnitId, ownerUnitPath: resource.ownerUnitPath })) ||
        (resource.investorUnitId !== undefined && resource.investorUnitPath !== undefined && scopeContains(scope, { ownerUnitId: resource.investorUnitId, ownerUnitPath: resource.investorUnitPath }))
      );
  }
}

/** The resource types whose read permission is not `<type>.read`: a data product is read with the right to read the catalogue of data (ST-DGV-009), a trigger of evaluation with the right to manage the triggers (ST-AST-006), a milestone of the roadmap of maturity with the right to read the maturity (ST-DGV-008). */
const READ_PERMISSION_OF: Readonly<Record<string, string>> = { data_product: 'data.catalog.read', evaluation_trigger: 'evaluation.trigger.manage', maturity_milestone: 'data.maturity.read' };

/**
 * The default port: the member needs the `<resource type>.read` permission from a grant whose scope contains the
 * resource. A tenant-wide grant reaches every resource; a project or contract grant only its own project or contract;
 * a unit grant needs the owner unit and its current path. A permission held on another scope never counts, and a
 * resource whose scope cannot be established is reached by a tenant-wide grant only. Modules with a richer rule
 * register their own port.
 */
export class PermissionResourceAccess implements ResourceAccessPort {
  canRead(access: EffectiveAccess, resource: ResourceRef, now: Date): boolean {
    if (!access.membershipActive) return false;
    const permission = READ_PERMISSION_OF[resource.type] ?? `${resource.type}.read`;
    return activeGrants(access, now).some((grant) => holdsPermission(new Set(grant.permissions), permission) && scopeReaches(grant.scope, resource));
  }
}
