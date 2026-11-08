import { DomainError, versionConflict } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** What a request for a permanent delegation is: Pending until decided; Lapsed is a Pending one that nobody decided within its 7 days (read from the clock, never stored). */
export type StandingRequestStatus = 'Pending' | 'Approved' | 'Rejected' | 'Cancelled' | 'Lapsed';

export interface StandingRequestRecord {
  id: string;
  delegatorId: string;
  delegatorName: string | null;
  delegateId: string;
  delegateName: string | null;
  permissions: string[];
  scopeKind: string;
  scopeRefIds: string[];
  periodCodes: string[] | null;
  startsAt: string;
  reviewDueAt: string;
  endConditionKind: string;
  endConditionText: string;
  endOn: string | null;
  reason: string;
  legalBasisRef: string | null;
  status: StandingRequestStatus;
  expiresAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  delegationId: string | null;
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
  period_codes: string[] | null;
  starts_at: string;
  review_due_at: string;
  end_condition_kind: string;
  end_condition_text: string;
  end_on: string | null;
  reason: string;
  legal_basis_ref: string | null;
  status: StandingRequestStatus;
  expires_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  delegation_id: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

const FROM = `machvon.standing_delegation_request r
  left join machvon.tenant_user_directory da on da.tenant_id = r.tenant_id and da.membership_id = r.delegator_membership_id
  left join machvon.tenant_user_directory de on de.tenant_id = r.tenant_id and de.membership_id = r.delegate_membership_id
  left join machvon.tenant_user_directory dd on dd.tenant_id = r.tenant_id and dd.membership_id = r.decided_by`;
const COLUMNS = `r.id, r.delegator_membership_id as delegator_id, da.display_name as delegator_name, r.delegate_membership_id as delegate_id, de.display_name as delegate_name, r.permissions,
  r.scope_json->>'kind' as scope_kind, array(select jsonb_array_elements_text(coalesce(r.scope_json->'ref_ids', '[]'::jsonb))) as scope_ref_ids, r.period_codes,
  ${TIME('r.starts_at')} as starts_at, ${TIME('r.review_due_at')} as review_due_at, r.end_condition_kind, r.end_condition_text, ${TIME('r.end_on')} as end_on, r.reason, r.legal_basis_ref,
  case when r.status = 'Pending' and r.expires_at <= now() then 'Lapsed' else r.status end as status, ${TIME('r.expires_at')} as expires_at,
  r.decided_by, dd.display_name as decided_by_name, ${TIME('r.decided_at')} as decided_at, r.decision_reason, r.delegation_id, ${TIME('r.created_at')} as created_at, r.version::text as version, ${TIME('r.created_at')} as sort_key`;

const toRecord = (row: Row): StandingRequestRecord => ({
  id: row.id,
  delegatorId: row.delegator_id,
  delegatorName: row.delegator_name,
  delegateId: row.delegate_id,
  delegateName: row.delegate_name,
  permissions: row.permissions,
  scopeKind: row.scope_kind,
  scopeRefIds: row.scope_ref_ids,
  periodCodes: row.period_codes,
  startsAt: row.starts_at,
  reviewDueAt: row.review_due_at,
  endConditionKind: row.end_condition_kind,
  endConditionText: row.end_condition_text,
  endOn: row.end_on,
  reason: row.reason,
  legalBasisRef: row.legal_basis_ref,
  status: row.status,
  expiresAt: row.expires_at,
  decidedBy: row.decided_by,
  decidedByName: row.decided_by_name,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  delegationId: row.delegation_id,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

export interface NewStandingRequest {
  delegatorId: string;
  delegateId: string;
  permissions: readonly string[];
  scopeKind: string;
  scopeRefIds: readonly string[];
  periodCodes: readonly string[] | undefined;
  startsAt: Date;
  reviewDueAt: Date;
  endConditionKind: string;
  endConditionText: string;
  endOn: Date | undefined;
  reason: string;
  legalBasisRef: string | undefined;
}

/**
 * The requests for a permanent delegation (IAM-2). The delegator asks; a second person who is neither the delegator nor the delegate decides; an approval makes the delegation (`DelegationStore.insertStanding`) and records
 * which one. This class keeps the request and its decision; whether the decider may decide is the command's, and the table refuses a decider who is one of the two parties.
 */
export class StandingRequestStore {
  async insert(tx: TenantTx, input: NewStandingRequest): Promise<StandingRequestRecord> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.standing_delegation_request (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, period_codes, starts_at, review_due_at, end_condition_kind, end_condition_text, end_on, reason, legal_basis_ref)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::text[], jsonb_build_object('kind', $4::text, 'ref_ids', to_jsonb($5::text[])), $6::text[], $7::timestamptz, $8::timestamptz, $9, $10, $11::timestamptz, $12, $13) returning id`,
      [
        input.delegatorId,
        input.delegateId,
        [...input.permissions],
        input.scopeKind,
        [...input.scopeRefIds].sort(),
        input.periodCodes === undefined ? null : [...input.periodCodes],
        input.startsAt.toISOString(),
        input.reviewDueAt.toISOString(),
        input.endConditionKind,
        input.endConditionText.trim(),
        input.endOn?.toISOString() ?? null,
        input.reason,
        input.legalBasisRef ?? null,
      ],
    );
    return (await this.find(tx, (row as { id: string }).id)) as StandingRequestRecord;
  }

  async find(tx: TenantTx, id: string, options: { forUpdate?: boolean } = {}): Promise<StandingRequestRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where r.id = $1::uuid${options.forUpdate === true ? ' for update of r' : ''}`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The requests, newest first: those the person made or is the delegate of, or every one of the tenant when `viewer.all` (the approver reads them all). */
  async list(
    tx: TenantTx,
    viewer: { membershipId: string; all: boolean },
    filters: { id?: string | undefined; status?: string | undefined },
    page: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<StandingRequestRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Row>(
      `select * from (select ${COLUMNS} from ${FROM}
        where ($1::boolean or r.delegator_membership_id = $2::uuid or r.delegate_membership_id = $2::uuid) and ($4::uuid is null or r.id = $4::uuid)
          and ($5::timestamptz is null or (r.created_at, r.id) < ($5::timestamptz, $6::uuid))
        order by r.created_at desc, r.id desc) q where ($3::text is null or q.status = $3) limit $7::int`,
      [viewer.all, viewer.membershipId, filters.status ?? null, filters.id ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }

  /** Locks a request that can still be decided: 404 when it is not there, 409 `DELEGATION_STATE_INVALID` when it was decided or lapsed, 409 `VERSION_CONFLICT` when it changed since it was read. */
  async lockPending(tx: TenantTx, id: string, expectedVersion: number): Promise<StandingRequestRecord> {
    const found = await this.find(tx, id, { forUpdate: true });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.status !== 'Pending') throw new DomainError('DELEGATION_STATE_INVALID', 409, 'status');
    if (found.version !== expectedVersion) throw versionConflict(found.version);
    return found;
  }

  /** The approval: the request is Approved and points at the delegation it made. */
  async approve(tx: TenantTx, id: string, by: string, delegationId: string, reason: string | undefined, now: Date): Promise<StandingRequestRecord> {
    await tx.query(
      "update machvon.standing_delegation_request set status = 'Approved', decided_by = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4, delegation_id = $5::uuid, version = version + 1 where id = $1::uuid",
      [id, by, now.toISOString(), reason ?? null, delegationId],
    );
    return (await this.find(tx, id)) as StandingRequestRecord;
  }

  /** The refusal, with its reason. */
  async reject(tx: TenantTx, id: string, by: string, reason: string, now: Date): Promise<StandingRequestRecord> {
    await tx.query("update machvon.standing_delegation_request set status = 'Rejected', decided_by = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4, version = version + 1 where id = $1::uuid", [id, by, now.toISOString(), reason]);
    return (await this.find(tx, id)) as StandingRequestRecord;
  }

  /** The delegator takes the request back before it is decided. */
  async cancel(tx: TenantTx, id: string, now: Date): Promise<StandingRequestRecord> {
    await tx.query("update machvon.standing_delegation_request set status = 'Cancelled', decided_at = $2::timestamptz, version = version + 1 where id = $1::uuid", [id, now.toISOString()]);
    return (await this.find(tx, id)) as StandingRequestRecord;
  }
}
