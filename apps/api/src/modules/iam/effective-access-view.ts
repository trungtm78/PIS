import type { MyDelegation, MyGrant, ScopeUnit } from '@machvon/db';
import { homeAudienceOf } from '@machvon/kernel';
import type { HomeAudience } from '@machvon/kernel';

export type GrantState = 'ACTIVE' | 'EXPIRED' | 'FUTURE';

export interface GrantDto {
  id: string;
  role_code: string;
  role_name: string;
  rank: number;
  scope_kind: string;
  scope_ref_ids: string[];
  scope: {
    units: ScopeUnit[];
    projects: Array<{ id: string; code: string; name: string }>;
    contracts: Array<{ id: string; code: string }>;
  };
  /** Exact permission names or `prefix.*` patterns, as stored on the role. */
  permissions: string[];
  effective_from: string;
  effective_until: string | null;
  state: GrantState;
}

export interface DelegationDto {
  id: string;
  delegator_membership_id: string;
  permissions: string[];
  scope_kind: string;
  scope_ref_ids: string[];
  valid_from: string;
  valid_until: string;
  state: 'ACTIVE' | 'FUTURE';
}

/** `EffectiveAccess` of openapi.json. */
export interface EffectiveAccessDto {
  membership_id: string;
  scope_version: number;
  grants: GrantDto[];
  delegations_in: DelegationDto[];
  /** Who the home is laid out for (R53): judged here from the authorities in force and the place in the steering committee, never by a screen. */
  home_audience: HomeAudience;
  entitlement_hash?: string;
}

export interface EffectiveAccessInput {
  membershipId: string;
  scopeVersion: number;
  grants: readonly MyGrant[];
  delegations: readonly MyDelegation[];
  entitlementHash?: string;
  /** The place the person holds in the steering committee today (HEAD, DEPUTY, MEMBER, SECRETARIAT), or null. */
  committeeRole?: string | null;
  now: Date;
}

/**
 * Where a grant stands now. The window is judged exactly as the PDP judges it (`effectiveFrom <= now < effectiveUntil`), so
 * a grant shown as ACTIVE is a grant the PDP counts, and one the expiry job has not marked yet is still shown as EXPIRED.
 */
export function stateOf(grant: Pick<MyGrant, 'view' | 'storedStatus'>, now: Date): GrantState {
  const at = now.getTime();
  if (grant.storedStatus === 'Expired') return 'EXPIRED';
  if (grant.view.effectiveUntil !== null && grant.view.effectiveUntil.getTime() <= at) return 'EXPIRED';
  return grant.view.effectiveFrom.getTime() > at ? 'FUTURE' : 'ACTIVE';
}

/**
 * The access of one member as the screen needs it: every grant of theirs with its permissions, scope and state, the
 * delegations they received, and the entitlement hash they act under. The effective permissions are the union of the
 * permissions of the ACTIVE grants (and of the ACTIVE delegations); the screen derives them, so the API has one rule less.
 */
export function effectiveAccessView(input: EffectiveAccessInput): EffectiveAccessDto {
  const { now } = input;
  const at = now.getTime();
  const home_audience = homeAudienceOf({
    authorities: [
      ...input.grants.filter((grant) => stateOf(grant, now) === 'ACTIVE').map((grant) => ({ permissions: grant.view.permissions, scopeKind: grant.scopeKind })),
      ...input.delegations.filter((delegation) => delegation.validFrom.getTime() <= at && at < delegation.validUntil.getTime()).map((delegation) => ({ permissions: delegation.permissions, scopeKind: delegation.scopeKind })),
    ],
    committeeRole: input.committeeRole ?? null,
  });
  return {
    membership_id: input.membershipId,
    scope_version: input.scopeVersion,
    grants: input.grants.map((grant) => ({
      id: grant.id,
      role_code: grant.view.roleCode,
      role_name: grant.roleName,
      rank: grant.view.rank,
      scope_kind: grant.scopeKind,
      scope_ref_ids: grant.scopeRefIds,
      scope: { units: grant.units, projects: grant.projects, contracts: grant.contracts },
      permissions: [...grant.view.permissions],
      effective_from: grant.view.effectiveFrom.toISOString(),
      effective_until: grant.view.effectiveUntil?.toISOString() ?? null,
      state: stateOf(grant, now),
    })),
    delegations_in: input.delegations.map((delegation) => ({
      id: delegation.id,
      delegator_membership_id: delegation.delegatorMembershipId,
      permissions: delegation.permissions,
      scope_kind: delegation.scopeKind,
      scope_ref_ids: delegation.scopeRefIds,
      valid_from: delegation.validFrom.toISOString(),
      valid_until: delegation.validUntil.toISOString(),
      state: delegation.validFrom.getTime() > at ? 'FUTURE' : 'ACTIVE',
    })),
    home_audience,
    ...(input.entitlementHash === undefined ? {} : { entitlement_hash: input.entitlementHash }),
  };
}
