import { DomainError, SUPPORT_MAX_WINDOW_MS, SUPPORT_REQUEST_LAPSE_MS, approvalPatch, assertRevocable, isSupportGrantLive, supportRequestDefects, supportStatusAt } from '@machvon/kernel';
import type { SupportAccessMode, SupportGrantFacts, SupportGrantStatus } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const SUPPORT_ACCESS_REQUESTED_EVENT = 'sas.support_access.requested.v1';
export const SUPPORT_ACCESS_APPROVED_EVENT = 'sas.support_access.approved.v1';
export const SUPPORT_ACCESS_REVOKED_EVENT = 'sas.support_access.revoked.v1';
/** The gauge of the grants in force (the tenant side of the banner of SAS-19), for the alert that watches for access that outlives its window. */
export const SUPPORT_ACCESS_ACTIVE_GAUGE = 'support_access_active';

const RESOURCE_TYPE = 'support_access_grant';

export interface SupportGrantRow extends SupportGrantFacts {
  id: string;
  tenantId: string;
  ticketReference: string;
  modules: readonly string[];
  resourceIds: readonly string[];
  requestReason: string;
  revokeReason: string | null;
  version: number;
}

interface GrantDbRow {
  id: string;
  tenant_id: string;
  ticket_reference: string;
  operator_id: string;
  owner_approved_by: string | null;
  second_approver_id: string | null;
  access_mode: SupportAccessMode;
  status: SupportGrantStatus;
  request_reason: string;
  requested_at: Date;
  starts_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  scope_json: { modules?: unknown; resource_ids?: unknown; duration_minutes?: unknown };
  version: string;
}

const COLUMNS = `id, tenant_id, ticket_reference, operator_id, owner_approved_by, second_approver_id, access_mode, status, request_reason, requested_at, starts_at, expires_at, revoked_at, revoke_reason, scope_json, version`;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function grantOf(row: GrantDbRow): SupportGrantRow {
  const minutes = Number(row.scope_json.duration_minutes);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketReference: row.ticket_reference,
    operatorId: row.operator_id,
    ownerApprovedBy: row.owner_approved_by,
    secondApproverId: row.second_approver_id,
    accessMode: row.access_mode,
    status: row.status,
    requestReason: row.request_reason,
    requestedAt: row.requested_at,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    modules: strings(row.scope_json.modules),
    resourceIds: strings(row.scope_json.resource_ids),
    durationMinutes: Number.isFinite(minutes) ? minutes : 0,
    version: Number(row.version),
  };
}

export interface SupportRequest {
  tenantId: string;
  operatorId: string;
  ticketReference: string;
  modules: readonly string[];
  resourceIds: readonly string[];
  accessMode: SupportAccessMode;
  durationMinutes: number;
  reason: string;
}

export interface SupportApproval {
  grantId: string;
  approverId: string;
  decision: 'approve' | 'reject';
  startsAt?: Date;
  reason: string;
  expectedVersion: number | undefined;
}

export interface SupportPassResult {
  /** Approved grants whose first instant came. */
  activated: string[];
  /** Grants whose window ended. */
  expired: string[];
  /** Requests nobody decided on within a week. */
  lapsed: string[];
  /** Grants in force after the pass. */
  active: number;
}

/**
 * Controlled support access (ST-SAS-015, SAS.md 3.9, BR-SAS-16) on the tenant plane. The Support Operator's request is written acting as the tenant (a control command); the people of the tenant approve, reject
 * and revoke. A grant is in force by the judgment of `isSupportGrantLive` on its facts and the clock, whatever its status column says: the status is bookkeeping that the pass of the lifecycle job keeps up to date.
 * Every change audits and emits in the transaction that makes it.
 */
export class SupportAccessStore {
  /** The ticket of the tenant by its code (the reference an operator names), or undefined. */
  async ticketOf(tx: TenantTx, reference: string): Promise<{ id: string; status: string } | undefined> {
    const [row] = await tx.query<{ id: string; status: string }>('select id, status from machvon.support_ticket where lower(ticket_code) = lower($1)', [reference.trim()]);
    return row;
  }

  /** Asks for access: the ticket must be one of the tenant and not closed; one open request for a ticket per operator (a new one after the last ended is how an access is extended). */
  async request(tx: TenantTx, effects: ApprovalEffects, input: SupportRequest, now: Date): Promise<SupportGrantRow> {
    const defects = supportRequestDefects({ ticketReference: input.ticketReference, modules: input.modules, resourceIds: input.resourceIds, accessMode: input.accessMode, durationMinutes: input.durationMinutes, reason: input.reason });
    if (defects[0] !== undefined) throw new DomainError('VALIDATION_FAILED', 422, defects[0]);
    const reference = input.ticketReference.trim();
    const ticket = await this.ticketOf(tx, reference);
    if (ticket === undefined) throw new DomainError('TICKET_NOT_FOUND', 404, 'ticket_reference');
    if (ticket.status === 'Closed') throw new DomainError('SUPPORT_GRANT_INVALID', 409, 'ticket_reference');
    const scope = { modules: [...input.modules], resource_ids: [...input.resourceIds], duration_minutes: input.durationMinutes };
    // The window is fixed at the approval; until then the end is what the request would give from now.
    const provisionalEnd = new Date(now.getTime() + Math.min(input.durationMinutes * 60_000, SUPPORT_MAX_WINDOW_MS));
    const rows = await tx.query<GrantDbRow>(
      `insert into machvon.support_access_grant (tenant_id, id, ticket_reference, operator_id, scope_json, expires_at, request_reason, access_mode, status, requested_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2::uuid, $3::jsonb, $4::timestamptz, $5, $6, 'Requested', $7::timestamptz)
       on conflict (tenant_id, operator_id, lower(ticket_reference)) where status in ('Requested', 'Approved', 'Active') do nothing
       returning ${COLUMNS}`,
      [reference, input.operatorId, JSON.stringify(scope), provisionalEnd.toISOString(), input.reason.trim(), input.accessMode, now.toISOString()],
    );
    const [row] = rows;
    if (row === undefined) throw new DomainError('SUPPORT_GRANT_INVALID', 409, 'ticket_reference');
    const grant = grantOf(row);
    await effects.audit({
      action: 'support_access.requested',
      resourceType: RESOURCE_TYPE,
      resourceId: grant.id,
      reason: input.reason.trim(),
      classification: 'CONFIDENTIAL',
      diff: { ticket_reference: reference, access_mode: input.accessMode, modules: [...input.modules], resources: input.resourceIds.length, duration_minutes: input.durationMinutes },
    });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: grant.id,
      aggregateVersion: grant.version,
      eventKey: `support_access:${grant.id}:requested`,
      type: SUPPORT_ACCESS_REQUESTED_EVENT,
      schemaVersion: 1,
      payload: { grant_id: grant.id, ticket_reference: reference, access_mode: input.accessMode, modules: [...input.modules], duration_minutes: input.durationMinutes },
    });
    return grant;
  }

  /**
   * One person of the tenant decides on a request. A rejection ends it. An approval is the rule of `approvalPatch`: one for a read, two different people for a write; the grant is in force from the approval that
   * completes it. A decision on a request that is no longer waiting is 409 SUPPORT_GRANT_INVALID; one on a version that moved is 409 VERSION_CONFLICT.
   */
  async decide(tx: TenantTx, effects: ApprovalEffects, input: SupportApproval, now: Date): Promise<SupportGrantRow> {
    const grant = await this.lock(tx, input.grantId, input.expectedVersion);
    if (input.decision === 'reject') {
      if (grant.status !== 'Requested' || supportStatusAt(grant, now) !== 'Requested') throw new DomainError('SUPPORT_GRANT_INVALID', 409, 'status');
      if (input.approverId === grant.operatorId) throw new DomainError('SELF_APPROVAL_DENIED', 403);
      const rejected = await this.update(tx, grant, "status = 'Rejected', revoke_reason = $2", [input.reason.trim()]);
      await effects.audit({ action: 'support_access.rejected', resourceType: RESOURCE_TYPE, resourceId: grant.id, reason: input.reason.trim(), classification: 'CONFIDENTIAL', diff: { ticket_reference: grant.ticketReference } });
      return rejected;
    }
    const patch = approvalPatch(grant, input.approverId, now, input.startsAt);
    const complete = patch.startsAt !== null;
    const approved = await this.update(tx, grant, 'status = $2, owner_approved_by = $3::uuid, second_approver_id = $4::uuid, starts_at = $5::timestamptz, expires_at = coalesce($6::timestamptz, expires_at)', [
      patch.status,
      patch.ownerApprovedBy,
      patch.secondApproverId,
      patch.startsAt?.toISOString() ?? null,
      patch.expiresAt?.toISOString() ?? null,
    ]);
    await effects.audit({
      action: 'support_access.approved',
      resourceType: RESOURCE_TYPE,
      resourceId: grant.id,
      reason: input.reason.trim(),
      classification: 'CONFIDENTIAL',
      diff: { ticket_reference: grant.ticketReference, access_mode: grant.accessMode, step: grant.accessMode === 'READ_WRITE' ? (grant.ownerApprovedBy === null ? 'first' : 'second') : 'only', complete, status: approved.status },
    });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: grant.id,
      aggregateVersion: approved.version,
      eventKey: `support_access:${grant.id}:approved:${approved.version}`,
      type: SUPPORT_ACCESS_APPROVED_EVENT,
      schemaVersion: 1,
      payload: { grant_id: grant.id, ticket_reference: grant.ticketReference, access_mode: grant.accessMode, complete, ...(approved.startsAt === null ? {} : { starts_at: approved.startsAt.toISOString() }), expires_at: approved.expiresAt.toISOString() },
    });
    return approved;
  }

  /** Ends a grant that is still open, at once and whatever its window: the operator is out on their next request. */
  async revoke(tx: TenantTx, effects: ApprovalEffects, grantId: string, reason: string, expectedVersion: number | undefined, now: Date): Promise<SupportGrantRow> {
    const grant = await this.lock(tx, grantId, expectedVersion);
    assertRevocable(grant);
    const revoked = await this.update(tx, grant, "status = 'Revoked', revoked_at = $2::timestamptz, revoke_reason = $3", [now.toISOString(), reason.trim()]);
    await effects.audit({ action: 'support_access.revoked', resourceType: RESOURCE_TYPE, resourceId: grantId, reason: reason.trim(), classification: 'CONFIDENTIAL', diff: { ticket_reference: grant.ticketReference, was: grant.status } });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: grantId,
      aggregateVersion: revoked.version,
      eventKey: `support_access:${grantId}:revoked`,
      type: SUPPORT_ACCESS_REVOKED_EVENT,
      schemaVersion: 1,
      payload: { grant_id: grantId, ticket_reference: grant.ticketReference },
    });
    return revoked;
  }

  /**
   * The pass of the lifecycle job for the tenant, every minute: an approved grant whose first instant has come is Active, one whose window has ended is Expired (it was out of force the instant it ended; this only says so), and a
   * request nobody decided on within a week lapses (Expired, without ever having been in force). Idempotent: a second pass finds nothing.
   */
  async sweep(tx: TenantTx, effects: ApprovalEffects, now: Date): Promise<SupportPassResult> {
    const result: SupportPassResult = { activated: [], expired: [], lapsed: [], active: 0 };
    const due = await tx.query<GrantDbRow>(
      `select ${COLUMNS} from machvon.support_access_grant
        where (status = 'Requested' and requested_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond'))
           or (status in ('Approved', 'Active') and (expires_at <= $1::timestamptz or (status = 'Approved' and starts_at <= $1::timestamptz)))
        order by id for update`,
      [now.toISOString(), SUPPORT_REQUEST_LAPSE_MS],
    );
    for (const row of due) {
      const grant = grantOf(row);
      const shown = supportStatusAt(grant, now);
      if (shown === grant.status) continue;
      const moved = await this.update(tx, grant, 'status = $2', [shown]);
      if (shown === 'Active') {
        result.activated.push(grant.id);
        continue;
      }
      (grant.status === 'Requested' ? result.lapsed : result.expired).push(grant.id);
      await effects.audit({ action: grant.status === 'Requested' ? 'support_access.lapsed' : 'support_access.expired', resourceType: RESOURCE_TYPE, resourceId: grant.id, classification: 'CONFIDENTIAL', diff: { ticket_reference: grant.ticketReference, version: moved.version } });
    }
    const [active] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.support_access_grant where status in ('Approved', 'Active') and starts_at <= $1::timestamptz and $1::timestamptz < expires_at and revoked_at is null", [now.toISOString()]);
    result.active = Number(active?.n ?? 0);
    return result;
  }

  async find(tx: TenantTx, id: string): Promise<SupportGrantRow | undefined> {
    const [row] = await tx.query<GrantDbRow>(`select ${COLUMNS} from machvon.support_access_grant where id = $1::uuid`, [id]);
    return row === undefined ? undefined : grantOf(row);
  }

  /**
   * The grants of the tenant, the newest request first, a page at a time. `status` is the status at `now` (the one `supportStatusAt` gives, so an approved grant whose window has ended is Expired before the pass of the
   * job says so); `inForce` keeps the grants that let their operator in at `now` (`isSupportGrantLive`). Both are judged before the page is cut, so a page never lacks a grant that matches.
   */
  async list(tx: TenantTx, filter: { limit: number; now: Date; after?: { requestedAt: string; id: string }; status?: SupportGrantStatus; inForce?: boolean }): Promise<SupportGrantRow[]> {
    const rows = await tx.query<GrantDbRow>(
      `select ${COLUMNS} from (
         select *, case status
             when 'Requested' then case when requested_at <= $5::timestamptz - ($6::bigint * interval '1 millisecond') then 'Expired' else 'Requested' end
             when 'Approved' then case when starts_at is null then 'Approved' when expires_at <= $5::timestamptz then 'Expired' when starts_at <= $5::timestamptz then 'Active' else 'Approved' end
             when 'Active' then case when starts_at is null then 'Active' when expires_at <= $5::timestamptz then 'Expired' when starts_at <= $5::timestamptz then 'Active' else 'Approved' end
             else status end as effective_status,
           (status in ('Approved', 'Active') and revoked_at is null and starts_at <= $5::timestamptz and $5::timestamptz < expires_at and owner_approved_by is not null
             and (access_mode = 'READ_ONLY' or (second_approver_id is not null and second_approver_id <> owner_approved_by))) as live
           from machvon.support_access_grant) g
        where ($2::text is null or effective_status = $2) and ($7::boolean is null or live = $7) and ($3::timestamptz is null or (requested_at, id) < ($3::timestamptz, $4::uuid))
        order by requested_at desc, id desc limit $1::int`,
      [filter.limit, filter.status ?? null, filter.after?.requestedAt ?? null, filter.after?.id ?? null, filter.now.toISOString(), SUPPORT_REQUEST_LAPSE_MS, filter.inForce ?? null],
    );
    return rows.map(grantOf);
  }

  /** The grant that lets this operator in at `now`, or undefined: the guard asks it on every request that carries a support token. */
  async liveGrant(tx: TenantTx, grantId: string, operatorId: string, now: Date): Promise<SupportGrantRow | undefined> {
    const grant = await this.find(tx, grantId);
    return grant !== undefined && grant.operatorId === operatorId && isSupportGrantLive(grant, now) ? grant : undefined;
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number | undefined): Promise<SupportGrantRow> {
    const [row] = await tx.query<GrantDbRow>(`select ${COLUMNS} from machvon.support_access_grant where id = $1::uuid for update`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const grant = grantOf(row);
    if (expectedVersion !== undefined && grant.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: grant.version } });
    return grant;
  }

  private async update(tx: TenantTx, grant: SupportGrantRow, assignments: string, values: readonly unknown[]): Promise<SupportGrantRow> {
    const [row] = await tx.query<GrantDbRow>(`update machvon.support_access_grant set ${assignments}, version = version + 1 where id = $1::uuid returning ${COLUMNS}`, [grant.id, ...values]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return grantOf(row);
  }
}
