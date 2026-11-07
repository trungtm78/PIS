import { projectScope, scopePredicate } from '@machvon/db';
import type { ScopeBuilder } from '@machvon/db';
import { activeGrants, permissionMatches } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { HOME_READ_PERMISSION } from './scope-hash';

/** The units and the projects the reader may read in HOME, as the predicates the work sources are compiled over. */
export function workScopes(access: EffectiveAccess, now: Date): { unitScope: ScopeBuilder; projectScope: ScopeBuilder } {
  return {
    unitScope: (first) => scopePredicate(access, HOME_READ_PERMISSION, now, { unitPath: 'u.path', unitId: 'u.id' }, first),
    projectScope: projectScope(access, HOME_READ_PERMISSION, now),
  };
}

/** The reader holds a grant that carries the right to read HOME somewhere: only then is there a scope to read the work of (the view `scope`). */
export const canReadScope = (access: EffectiveAccess, now: Date): boolean => activeGrants(access, now).some((grant) => grant.permissions.some((held) => permissionMatches(held, HOME_READ_PERMISSION)));

/** The reader holds a grant that carries `permission`, wherever it reaches (the module that owns the command still judges the scope of the record). */
export const holdsGrantOf = (access: EffectiveAccess, now: Date, permission: string): boolean => activeGrants(access, now).some((grant) => grant.permissions.some((held) => permissionMatches(held, permission)));
