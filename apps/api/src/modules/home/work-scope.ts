import { PERMISSIONS } from '@machvon/contracts';
import { projectScope, scopePredicate, scoreUnitsOf } from '@machvon/db';
import type { ScopeBuilder, WorkDecisionScopes } from '@machvon/db';
import { activeGrants, permissionMatches } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { HOME_READ_PERMISSION } from './scope-hash';

/** The units and the projects the reader may read in HOME, as the predicates the work sources are compiled over. */
export function workScopes(access: EffectiveAccess, now: Date): { unitScope: ScopeBuilder; projectScope: ScopeBuilder; holds: (permission: string, wholeTenant?: boolean) => boolean; decisionScopes: WorkDecisionScopes } {
  return {
    // PWF 20.9: the decisions of the project workflow that wait for the reader are judged by the permission of the command that decides each, exactly as the unified inbox (`listMyPendingDecisions`) judges them.
    decisionScopes: {
      taskApprove: projectScope(access, PERMISSIONS.approveProjectTaskCompletion, now),
      scheduleApprove: projectScope(access, PERMISSIONS.decideProjectReschedule, now),
      scoreUnits: (tx) => scoreUnitsOf(tx, access, [PERMISSIONS.decideStaffScoreAdjustment], now),
    },
    // The sources that are for a role judge their audience by the permission of the role: through any grant, or only through a grant on the whole tenant for the records that belong to no unit.
    holds: (permission, wholeTenant = false) => activeGrants(access, now).some((grant) => (!wholeTenant || grant.scope.kind === 'TENANT') && grant.permissions.some((held) => permissionMatches(held, permission))),
    unitScope: (first) => scopePredicate(access, HOME_READ_PERMISSION, now, { unitPath: 'u.path', unitId: 'u.id' }, first),
    projectScope: projectScope(access, HOME_READ_PERMISSION, now),
  };
}

/** The reader holds a grant that carries the right to read HOME somewhere: only then is there a scope to read the work of (the view `scope`). */
export const canReadScope = (access: EffectiveAccess, now: Date): boolean => activeGrants(access, now).some((grant) => grant.permissions.some((held) => permissionMatches(held, HOME_READ_PERMISSION)));

/** The reader holds a grant that carries `permission`, wherever it reaches (the module that owns the command still judges the scope of the record). */
export const holdsGrantOf = (access: EffectiveAccess, now: Date, permission: string): boolean => activeGrants(access, now).some((grant) => grant.permissions.some((held) => permissionMatches(held, permission)));
