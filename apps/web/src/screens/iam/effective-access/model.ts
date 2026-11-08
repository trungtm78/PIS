import { SCOPE_KINDS } from './types';
import type { AccessDelegation, AccessGrant, EffectiveAccessView, GrantState, ScopeKind } from './types';

/** Grants of each state, in the order the server sent them. */
export interface GrantGroups {
  active: AccessGrant[];
  expired: AccessGrant[];
  future: AccessGrant[];
}

export function groupGrants(grants: readonly AccessGrant[]): GrantGroups {
  const pick = (state: GrantState): AccessGrant[] => grants.filter((grant) => grant.state === state);
  return { active: pick('ACTIVE'), expired: pick('EXPIRED'), future: pick('FUTURE') };
}

export interface GrantFilter {
  /** Text the permission contains (case does not matter); empty means no filter. */
  permission: string;
  /** One scope kind, or all. */
  scope: ScopeKind | 'ALL';
}

export const NO_FILTER: GrantFilter = { permission: '', scope: 'ALL' };

export function isScopeKind(value: string): value is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(value);
}

/** Whether a stored permission (an exact name or a `prefix.*` pattern) is what the person looks for: they type part of a name. */
function matchesPermission(permissions: readonly string[], wanted: string): boolean {
  const needle = wanted.trim().toLowerCase();
  return needle === '' || permissions.some((permission) => permission.toLowerCase().includes(needle));
}

export function filterGrants(grants: readonly AccessGrant[], filter: GrantFilter): AccessGrant[] {
  return grants.filter((grant) => (filter.scope === 'ALL' || grant.scopeKind === filter.scope) && matchesPermission(grant.permissions, filter.permission));
}

/** One effective permission and the roles (and delegations) that give it. */
export interface PermissionRow {
  permission: string;
  roles: string[];
  delegated: boolean;
}

/**
 * The effective permissions: the union of the permissions of the ACTIVE grants and of the ACTIVE delegations, each with
 * where it comes from. The server decides every request; this is the explanation of what it will decide, not a second rule.
 */
export function permissionRows(grants: readonly AccessGrant[], delegations: readonly AccessDelegation[]): PermissionRow[] {
  const rows = new Map<string, { roles: Set<string>; delegated: boolean }>();
  const entry = (permission: string): { roles: Set<string>; delegated: boolean } => {
    const found = rows.get(permission) ?? { roles: new Set<string>(), delegated: false };
    rows.set(permission, found);
    return found;
  };
  for (const grant of grants) {
    if (grant.state !== 'ACTIVE') continue;
    for (const permission of grant.permissions) entry(permission).roles.add(grant.roleCode);
  }
  for (const delegation of delegations) {
    if (delegation.state !== 'ACTIVE') continue;
    for (const permission of delegation.permissions) entry(permission).delegated = true;
  }
  return [...rows]
    .map(([permission, row]) => ({ permission, roles: [...row.roles].sort(), delegated: row.delegated }))
    .sort((a, b) => (a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0));
}

/** The summary rows of the card: how many of each thing the person has. */
export interface AccessSummary {
  activeRoles: number;
  scopes: number;
  endedOrPending: number;
  delegations: number;
}

export function summaryOf(access: Pick<EffectiveAccessView, 'grants' | 'delegations'>): AccessSummary {
  const { active, expired, future } = groupGrants(access.grants);
  const scopes = new Set(active.map((grant) => `${grant.scopeKind}:${[...grant.scopeRefIds].sort().join(',')}`));
  return { activeRoles: new Set(active.map((grant) => grant.roleCode)).size, scopes: scopes.size, endedOrPending: expired.length + future.length, delegations: access.delegations.length };
}

/** Whether a newer reading shows another scope version than the one on screen: the access changed after it was loaded. */
export function isStale(shown: number | undefined, latest: number | undefined): boolean {
  return shown !== undefined && latest !== undefined && latest !== shown;
}

/** A unit as one line, root first: `Group › Board A › Department B`. */
export function breadcrumbText(unit: { breadcrumb: ReadonlyArray<{ name: string; code: string }>; name: string; code: string }): string {
  const crumbs = unit.breadcrumb.length > 0 ? unit.breadcrumb : [unit];
  return crumbs.map((crumb) => (crumb.name === '' ? crumb.code : crumb.name)).join(' › ');
}
