import { DomainError, delegationAt, versionConflict } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import { bumpScopeVersion } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** The gauge of the delegations in force, summed over the tenants by the job. */
export const DELEGATION_ACTIVE_GAUGE = 'delegation_active_total';
/** The most delegations one pass of the job looks at for a tenant; the rest wait for the next minute, the soonest end first. */
export const DELEGATION_PASS_LIMIT = 500;

export type DelegationStatus = 'Scheduled' | 'Active' | 'Ended' | 'Revoked';
export type DelegationEndReason = 'EXPIRED' | 'SOURCE_ENDED';

export interface DelegationRecord {
  id: string;
  delegatorId: string;
  delegatorName: string | null;
  delegateId: string;
  delegateName: string | null;
  permissions: string[];
  scopeKind: string;
  scopeRefIds: string[];
  validFrom: string;
  validUntil: string;
  reason: string;
  legalBasisRef: string | null;
  status: DelegationStatus;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  endedAt: string | null;
  endReason: DelegationEndReason | null;
  createdAt: string;
  version: number;
  sortKey: string;
}

interface Row {
  id: string;
  delegator_id: string;
  delegator_name: string | null;
  delegate_id: string;
  delegate_name: string | null;
  permissions: string[];
  scope_kind: string;
  scope_ref_ids: string[];
  valid_from: string;
  valid_until: string;
  reason: string;
  legal_basis_ref: string | null;
  status: DelegationStatus;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  ended_at: string | null;
  end_reason: DelegationEndReason | null;
  created_at: string;
  version: string;
  sort_key: string;
}

const FROM = `machvon.delegation_grant d
  left join machvon.tenant_user_directory da on da.tenant_id = d.tenant_id and da.membership_id = d.delegator_membership_id
  left join machvon.tenant_user_directory de on de.tenant_id = d.tenant_id and de.membership_id = d.delegate_membership_id`;
const COLUMNS = `d.id, d.delegator_membership_id as delegator_id, da.display_name as delegator_name, d.delegate_membership_id as delegate_id, de.display_name as delegate_name, d.permissions,
  d.scope_json->>'kind' as scope_kind, array(select jsonb_array_elements_text(coalesce(d.scope_json->'ref_ids', '[]'::jsonb))) as scope_ref_ids, ${TIME('d.valid_from')} as valid_from, ${TIME('d.valid_until')} as valid_until,
  d.reason, d.legal_basis_ref, d.status, d.revoked_by, ${TIME('d.revoked_at')} as revoked_at, d.revoke_reason, ${TIME('d.ended_at')} as ended_at, d.end_reason, ${TIME('d.created_at')} as created_at, d.version::text as version, ${TIME('d.created_at')} as sort_key`;

const toRecord = (row: Row): DelegationRecord => ({
  id: row.id,
  delegatorId: row.delegator_id,
  delegatorName: row.delegator_name,
  delegateId: row.delegate_id,
  delegateName: row.delegate_name,
  permissions: row.permissions,
  scopeKind: row.scope_kind,
  scopeRefIds: row.scope_ref_ids,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  reason: row.reason,
  legalBasisRef: row.legal_basis_ref,
  status: row.status,
  revokedBy: row.revoked_by,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
  endedAt: row.ended_at,
  endReason: row.end_reason,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

export interface NewDelegation {
  delegatorId: string;
  delegateId: string;
  permissions: readonly string[];
  scopeKind: string;
  scopeRefIds: readonly string[];
  validFrom: Date;
  validUntil: Date;
  reason: string;
  legalBasisRef: string | undefined;
  now: Date;
}

/** What one pass of the job did for a tenant. */
export interface DelegationPassResult {
  activated: number;
  expired: number;
  sourceEnded: number;
  /** All the delegations in force after the pass, those it did not take included. */
  active: number;
}

/**
 * The delegations of approval authority (ST-ADM-014, ADM 3.5, BR-ADM-06): a time-boxed handing over of business permissions over a scope, from the delegator to the delegate. The command checks what the delegator may pass on; this
 * class stores it, moves its state forward and lets the job end it. The decision of a task by a delegate is the approval engine's (`ApprovalStore.decide`), which reads the delegation live.
 */
export class DelegationStore {
  async insert(tx: TenantTx, input: NewDelegation): Promise<DelegationRecord> {
    const status = delegationAt({ validFrom: input.validFrom, validUntil: input.validUntil }, input.now) === 'Scheduled' ? 'Scheduled' : 'Active';
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, legal_basis_ref, status)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::text[], jsonb_build_object('kind', $4::text, 'ref_ids', to_jsonb($5::text[])), $6::timestamptz, $7::timestamptz, $8, $9, $10) returning id`,
      [input.delegatorId, input.delegateId, [...input.permissions], input.scopeKind, [...input.scopeRefIds].sort(), input.validFrom.toISOString(), input.validUntil.toISOString(), input.reason, input.legalBasisRef ?? null, status],
    );
    return (await this.find(tx, (row as { id: string }).id)) as DelegationRecord;
  }

  async find(tx: TenantTx, id: string): Promise<DelegationRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where d.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The delegations, newest first: those the person gave or received, or every one of the tenant when `viewer.all`. */
  async list(
    tx: TenantTx,
    viewer: { membershipId: string; all: boolean },
    filters: { id?: string | undefined; status?: string | undefined; role?: 'given' | 'received' | undefined },
    page: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<DelegationRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ($1::boolean or d.delegator_membership_id = $2::uuid or d.delegate_membership_id = $2::uuid)
          and ($3::text is null or d.status = $3) and ($4::uuid is null or d.id = $4::uuid)
          and ($5::text is null or ($5 = 'given' and d.delegator_membership_id = $2::uuid) or ($5 = 'received' and d.delegate_membership_id = $2::uuid))
          and ($6::timestamptz is null or (d.created_at, d.id) < ($6::timestamptz, $7::uuid))
        order by d.created_at desc, d.id desc limit $8::int`,
      [viewer.all, viewer.membershipId, filters.status ?? null, filters.id ?? null, filters.role ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }

  /** The permissions the member holds now through delegations they received: what is not theirs to pass on (no chain). */
  async heldThroughDelegations(tx: TenantTx, membershipId: string, now: Date): Promise<string[]> {
    const rows = await tx.query<{ permission: string }>(
      `select distinct unnest(permissions) as permission from machvon.delegation_grant
        where delegate_membership_id = $1::uuid and status = 'Active' and valid_from <= $2::timestamptz and $2::timestamptz < valid_until`,
      [membershipId, now.toISOString()],
    );
    return rows.map((row) => row.permission);
  }

  /** The delegate's membership: whether it is there and Active at `now` (a guest contractor is never a delegate). */
  async delegateState(tx: TenantTx, membershipId: string, now: Date): Promise<'ACTIVE' | 'INACTIVE' | 'GUEST' | 'UNKNOWN'> {
    const [row] = await tx.query<{ ok: boolean; membership_type: string }>(
      `select (status = 'Active' and valid_from <= $2::timestamptz and (valid_until is null or valid_until > $2::timestamptz)) as ok, membership_type from machvon.membership where id = $1::uuid for update`,
      [membershipId, now.toISOString()],
    );
    if (row === undefined) return 'UNKNOWN';
    if (row.membership_type === 'GUEST_CONTRACTOR') return 'GUEST';
    return row.ok ? 'ACTIVE' : 'INACTIVE';
  }

  /** Revokes a delegation that is not over: 409 `DELEGATION_STATE_INVALID` otherwise, 409 `VERSION_CONFLICT` when it changed since it was read. */
  async revoke(tx: TenantTx, id: string, expectedVersion: number, by: string, reason: string, now: Date): Promise<{ before: DelegationRecord; after: DelegationRecord }> {
    const [locked] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where d.id = $1::uuid for update of d`, [id]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const before = toRecord(locked);
    if (before.status === 'Ended' || before.status === 'Revoked') throw new DomainError('DELEGATION_STATE_INVALID', 409, 'status');
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    await tx.query("update machvon.delegation_grant set status = 'Revoked', revoked_by = $2::uuid, revoked_at = $3::timestamptz, revoke_reason = $4, version = version + 1 where id = $1::uuid", [id, by, now.toISOString(), reason]);
    return { before, after: (await this.find(tx, id)) as DelegationRecord };
  }

  /**
   * One pass over the delegations that are not over, the soonest end first, at most `DELEGATION_PASS_LIMIT`: one whose window has ended is Ended (EXPIRED); one whose delegator no longer holds what it passed on (`sourceHolds`
   * says so: the source grant ended or the membership lapsed) is Ended (SOURCE_ENDED), before it is in force or while it is; a waiting one whose first instant has come is Active. A delegation a command holds is left to the next
   * pass. Every change raises the scope version of the delegate and is announced; the pass is idempotent.
   */
  async sweep(tx: TenantTx, effects: ApprovalEffects, now: Date, sourceHolds: (delegation: DelegationRecord) => Promise<boolean>, limit = DELEGATION_PASS_LIMIT): Promise<DelegationPassResult> {
    const result: DelegationPassResult = { activated: 0, expired: 0, sourceEnded: 0, active: 0 };
    const candidates = await tx.query<Row>(
      // The ones whose window is over first, then the ones looked at longest ago (never looked at first): a tenant with more delegations than a pass takes is covered over a few passes.
      `select ${COLUMNS} from ${FROM} where d.status in ('Scheduled', 'Active') order by (d.valid_until <= $2::timestamptz) desc, d.checked_at nulls first, d.valid_until, d.id limit $1::int for update of d skip locked`,
      [limit, now.toISOString()],
    );
    const looked: string[] = [];
    for (const row of candidates) {
      const delegation = toRecord(row);
      looked.push(delegation.id);
      const window = { validFrom: new Date(delegation.validFrom), validUntil: new Date(delegation.validUntil) };
      const at = delegationAt(window, now);
      if (at === 'Ended') {
        await this.end(tx, effects, delegation, 'EXPIRED', now);
        result.expired += 1;
      } else if (!(await sourceHolds(delegation))) {
        await this.end(tx, effects, delegation, 'SOURCE_ENDED', now);
        result.sourceEnded += 1;
      } else if (at === 'Active' && delegation.status === 'Scheduled') {
        await tx.query("update machvon.delegation_grant set status = 'Active', version = version + 1 where id = $1::uuid", [delegation.id]);
        await this.announce(tx, effects, delegation, 'activated');
        result.activated += 1;
      }
    }
    // The delegations in force are counted after the pass, all of them: not only the ones the pass took.
    result.active = Number((await tx.query<{ n: string }>("select count(*)::text as n from machvon.delegation_grant where status = 'Active'"))[0]?.n ?? 0);
    await tx.query("update machvon.delegation_grant set checked_at = $2::timestamptz where id = any($1::uuid[]) and status in ('Scheduled', 'Active')", [looked, now.toISOString()]);
    return result;
  }

  private async end(tx: TenantTx, effects: ApprovalEffects, delegation: DelegationRecord, reason: DelegationEndReason, now: Date): Promise<void> {
    await tx.query("update machvon.delegation_grant set status = 'Ended', ended_at = $2::timestamptz, end_reason = $3, version = version + 1 where id = $1::uuid", [delegation.id, now.toISOString(), reason]);
    await effects.audit({ action: 'delegation.ended', resourceType: 'delegation_grant', resourceId: delegation.id, diff: { delegator_membership_id: delegation.delegatorId, delegate_membership_id: delegation.delegateId, end_reason: reason } });
    await this.announce(tx, effects, delegation, 'ended', reason);
  }

  /** The delegate's access changes with the delegation: their scope version is raised so the next request reads it again. */
  private async announce(tx: TenantTx, effects: ApprovalEffects, delegation: DelegationRecord, what: 'activated' | 'ended', reason?: DelegationEndReason): Promise<void> {
    await bumpScopeVersion(tx, [delegation.delegateId]);
    await effects.emit({
      aggregateType: 'delegation_grant',
      aggregateId: delegation.id,
      aggregateVersion: delegation.version + 1,
      type: what === 'ended' ? 'iam.delegation.ended.v1' : 'iam.delegation.activated.v1',
      schemaVersion: 1,
      payload: { delegation_id: delegation.id, delegator_membership_id: delegation.delegatorId, delegate_membership_id: delegation.delegateId, ...(reason === undefined ? {} : { end_reason: reason }) },
      eventKey: `delegation_grant:${delegation.id}:${what}`,
    });
  }
}
