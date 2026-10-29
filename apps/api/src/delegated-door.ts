import type { TenantDatabase } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';

/**
 * The operations a person may reach with a delegation of the permission alone (ADM 3.5, 3.7): the decision of an approval task. The door lets them in; the command then judges the task itself: that the delegation is
 * from the assignee, that its scope reaches the unit of the approval, and that the band is judged on the delegator's grants. Every other operation is judged on the person's own grants only.
 */
export const DELEGABLE_OPERATIONS: ReadonlySet<string> = new Set(['decideApprovalTask']);

/** Whether a membership holds, now, a delegation of the permission (any scope: the command narrows it). */
export class DelegationDoor {
  constructor(private readonly database: TenantDatabase) {}

  async holds(tenant: TenantContext, permission: string, now: Date): Promise<boolean> {
    const rows = await this.database.withTenant(tenant, (tx) =>
      tx.query<{ found: boolean }>(
        `select exists (
           select 1 from machvon.delegation_grant d
            where d.delegate_membership_id = $1::uuid and d.status = 'Active' and d.valid_from <= $2::timestamptz and $2::timestamptz < d.valid_until
              and exists (select 1 from unnest(d.permissions) p where p = $3 or p = split_part($3, '.', 1) || '.*' or p = '*')) as found`,
        [tenant.membershipId, now.toISOString(), permission],
      ),
    );
    return rows[0]?.found === true;
  }
}

/** The access the door decides on for a delegate: their own grants and, for this one permission, a grant that holds nothing else. */
export function withDelegatedPermission(access: EffectiveAccess, permission: string): EffectiveAccess {
  return {
    ...access,
    grants: [...access.grants, { roleCode: 'DELEGATE', rank: 0, permissions: [permission], scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: new Date(0), effectiveUntil: null }],
  };
}
