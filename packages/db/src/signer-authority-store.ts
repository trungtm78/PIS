import type { TenantTx } from './tenant-database.ts';

/** A delegation of authority as the signing check needs it (BR-DOC-08). */
export interface DelegationRecord {
  id: string;
  delegatorMembershipId: string;
  delegateMembershipId: string;
  permissions: string[];
  validFrom: Date;
  validUntil: Date;
  /** `Ended` and `Revoked` delegations no longer count, whatever their window says. */
  status: string;
  /** Whether the scope of the delegation contains the organisation unit that was asked about. */
  coversUnit: boolean;
}

/** The band of a DoA rule that decided: what the screen shows as the threshold. */
export interface DoaBand {
  ruleId: string;
  amountMinVnd: string;
  amountMaxVnd: string | null;
}

interface DelegationRow {
  id: string;
  delegator_membership_id: string;
  delegate_membership_id: string;
  permissions: string[];
  valid_from: Date;
  valid_until: Date;
  status: string;
  covers_unit: boolean;
}

// The scope of a grant or a delegation contains a unit when it is the whole tenant, names the unit (UNIT_ONLY) or names a unit at or above it (UNIT_SUBTREE).
export const SCOPE_CONTAINS_UNIT = (kind: string, refIds: string, unitParam: string): string => `(
    ${kind} = 'TENANT'
    or (${kind} = 'UNIT_ONLY' and ${unitParam}::uuid = any(${refIds}))
    or (${kind} = 'UNIT_SUBTREE' and exists (
      select 1 from machvon.organization_unit scope_unit
        join machvon.organization_unit target on target.id = ${unitParam}::uuid
       where scope_unit.id = any(${refIds}) and starts_with(target.path, scope_unit.path))))`;

/**
 * What the signing check reads from the organisation: who is an active member, who holds the role that a DoA rule names for a unit,
 * and the delegations of authority (ST-DOC-007, BR-DOC-08). The DoA matrix itself is resolved by `DoaMatrixStore`.
 */
export class SignerAuthorityStore {
  /** Whether the membership belongs to the tenant, is Active and inside its validity at `at`. */
  async isActiveMember(tx: TenantTx, membershipId: string, at: Date): Promise<boolean> {
    const [row] = await tx.query<{ active: boolean }>(
      `select (status = 'Active' and valid_from <= $2::timestamptz and (valid_until is null or valid_until > $2::timestamptz)) as active
         from machvon.membership where id = $1::uuid`,
      [membershipId, at.toISOString()],
    );
    return row?.active === true;
  }

  /** Whether the member holds an Active grant of the role whose window contains `at` and whose scope contains the unit. */
  async holdsRoleOnUnit(tx: TenantTx, input: { membershipId: string; roleId: string; unitId: string; at: Date }): Promise<boolean> {
    const [row] = await tx.query<{ held: boolean }>(
      `select exists (
         select 1 from machvon.role_grant g
           join machvon.membership m on m.tenant_id = g.tenant_id and m.id = g.membership_id
          where g.membership_id = $1::uuid and g.role_id = $2::uuid and g.status = 'Active'
            and g.effective_from <= $4::timestamptz and (g.effective_until is null or $4::timestamptz < g.effective_until)
            and m.status = 'Active' and m.valid_from <= $4::timestamptz and (m.valid_until is null or m.valid_until > $4::timestamptz)
            and ${SCOPE_CONTAINS_UNIT('g.scope_kind', 'g.scope_ref_ids', '$3')}) as held`,
      [input.membershipId, input.roleId, input.unitId, input.at.toISOString()],
    );
    return row?.held === true;
  }

  /** The delegation by id, with whether its scope contains the unit; undefined when the tenant has no such delegation. */
  async delegation(tx: TenantTx, id: string, unitId: string): Promise<DelegationRecord | undefined> {
    const [row] = await tx.query<DelegationRow>(
      `select d.id, d.delegator_membership_id, d.delegate_membership_id, d.permissions, d.valid_from, d.valid_until, d.status,
              ${SCOPE_CONTAINS_UNIT("d.scope_json->>'kind'", "array(select jsonb_array_elements_text(coalesce(d.scope_json->'ref_ids', '[]'::jsonb))::uuid)", '$2')} as covers_unit
         from machvon.delegation_grant d where d.id = $1::uuid`,
      [id, unitId],
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      delegatorMembershipId: row.delegator_membership_id,
      delegateMembershipId: row.delegate_membership_id,
      permissions: row.permissions,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      status: row.status,
      coversUnit: row.covers_unit,
    };
  }

  /** The band of a DoA rule, for the detail of a refusal. */
  async band(tx: TenantTx, ruleId: string): Promise<DoaBand | undefined> {
    const [row] = await tx.query<{ id: string; amount_min_vnd: string; amount_max_vnd: string | null }>(
      'select id, amount_min_vnd::text as amount_min_vnd, amount_max_vnd::text as amount_max_vnd from machvon.doa_rule where id = $1::uuid',
      [ruleId],
    );
    return row === undefined ? undefined : { ruleId: row.id, amountMinVnd: row.amount_min_vnd, amountMaxVnd: row.amount_max_vnd };
  }
}
