import { DomainError, actingPhase, actingWindow, versionConflict } from '@machvon/kernel';
import type { ActingPhase, ActingStatus } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ActingRecord {
  id: string;
  requesterId: string;
  requesterName: string | null;
  subjectId: string;
  subjectName: string | null;
  permissions: string[];
  periodCodes: string[] | null;
  hours: number;
  reason: string;
  status: ActingStatus;
  /** Where the grant stands by the clock (a request that waited too long, a window that ended): the status alone does not say. */
  phase: ActingPhase;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  version: number;
  sortKey: string;
}

interface Row {
  id: string;
  requester_id: string;
  requester_name: string | null;
  subject_id: string;
  subject_name: string | null;
  permissions: string[];
  period_codes: string[] | null;
  hours: number;
  reason: string;
  status: ActingStatus;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  window_start: string | null;
  window_end: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  version: string;
  sort_key: string;
}

const FROM = `machvon.acting_grant g
  left join machvon.tenant_user_directory dr on dr.tenant_id = g.tenant_id and dr.membership_id = g.requester_membership_id
  left join machvon.tenant_user_directory ds on ds.tenant_id = g.tenant_id and ds.membership_id = g.subject_membership_id
  left join machvon.tenant_user_directory dd on dd.tenant_id = g.tenant_id and dd.membership_id = g.decided_by`;
const COLUMNS = `g.id, g.requester_membership_id as requester_id, dr.display_name as requester_name, g.subject_membership_id as subject_id, ds.display_name as subject_name, g.permissions, g.period_codes, g.hours, g.reason, g.status,
  ${TIME('g.requested_at')} as requested_at, g.decided_by, dd.display_name as decided_by_name, ${TIME('g.decided_at')} as decided_at, g.decision_reason, ${TIME('g.window_start')} as window_start, ${TIME('g.window_end')} as window_end,
  g.revoked_by, ${TIME('g.revoked_at')} as revoked_at, g.revoke_reason, g.version::text as version, ${TIME('g.requested_at')} as sort_key`;

const toRecord = (row: Row, now: Date): ActingRecord => ({
  id: row.id,
  requesterId: row.requester_id,
  requesterName: row.requester_name,
  subjectId: row.subject_id,
  subjectName: row.subject_name,
  permissions: row.permissions,
  periodCodes: row.period_codes,
  hours: Number(row.hours),
  reason: row.reason,
  status: row.status,
  phase: actingPhase({ status: row.status, requestedAt: new Date(row.requested_at), validFrom: row.window_start === null ? null : new Date(row.window_start), validUntil: row.window_end === null ? null : new Date(row.window_end) }, now),
  requestedAt: row.requested_at,
  decidedBy: row.decided_by,
  decidedByName: row.decided_by_name,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  windowStart: row.window_start,
  windowEnd: row.window_end,
  revokedBy: row.revoked_by,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
  version: Number(row.version),
  sortKey: row.sort_key,
});

export interface NewActing {
  requesterId: string;
  subjectId: string;
  permissions: readonly string[];
  periodCodes: readonly string[] | undefined;
  hours: number;
  reason: string;
}

/**
 * The acting grants (IAM-2): an administrator acting on behalf of a person. This class keeps the request, its decision and its revocation, and tells the door of the API whether a grant is in force now. Whether the parties are
 * apart (by the person) and whether the permissions may be acted for are the command's, with the kernel rules; the table refuses an approver who is one of the two parties and a permission that decides or administers.
 */
export class ActingStore {
  async insert(tx: TenantTx, input: NewActing, now: Date): Promise<ActingRecord> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.acting_grant (tenant_id, id, requester_membership_id, subject_membership_id, permissions, period_codes, hours, reason, requested_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::text[], $4::text[], $5::smallint, $6, $7::timestamptz) returning id`,
      [input.requesterId, input.subjectId, [...input.permissions].sort(), input.periodCodes === undefined ? null : [...input.periodCodes], input.hours, input.reason, now.toISOString()],
    );
    return (await this.find(tx, (row as { id: string }).id, now)) as ActingRecord;
  }

  async find(tx: TenantTx, id: string, now: Date, options: { forUpdate?: boolean } = {}): Promise<ActingRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where g.id = $1::uuid${options.forUpdate === true ? ' for update of g' : ''}`, [id]);
    return row === undefined ? undefined : toRecord(row, now);
  }

  /** The grants, newest first: those the person asked for, is the subject of, or decided, or every one of the tenant when `viewer.all`. */
  async list(
    tx: TenantTx,
    viewer: { membershipId: string; all: boolean },
    filters: { id?: string | undefined; status?: string | undefined; role?: 'requested' | 'subject' | undefined },
    page: { limit: number; after: { code: string; id: string } | undefined },
    now: Date,
  ): Promise<ActingRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ($1::boolean or g.requester_membership_id = $2::uuid or g.subject_membership_id = $2::uuid or g.decided_by = $2::uuid)
          and ($3::text is null or g.status = $3) and ($4::uuid is null or g.id = $4::uuid)
          and ($5::text is null or ($5 = 'requested' and g.requester_membership_id = $2::uuid) or ($5 = 'subject' and g.subject_membership_id = $2::uuid))
          and ($6::timestamptz is null or (g.requested_at, g.id) < ($6::timestamptz, $7::uuid))
        order by g.requested_at desc, g.id desc limit $8::int`,
      [viewer.all, viewer.membershipId, filters.status ?? null, filters.id ?? null, filters.role ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map((row) => toRecord(row, now));
  }

  /** Locks a request that can still be decided: 404 when it is not there, 409 `ACTING_STATE_INVALID` when it was decided or waited too long, 409 `VERSION_CONFLICT` when it changed since it was read. */
  async lockPending(tx: TenantTx, id: string, expectedVersion: number, now: Date): Promise<ActingRecord> {
    const found = await this.find(tx, id, now, { forUpdate: true });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.phase !== 'PENDING') throw new DomainError('ACTING_STATE_INVALID', 409, 'status');
    if (found.version !== expectedVersion) throw versionConflict(found.version);
    return found;
  }

  /** The approval starts the window: `hours` from now. */
  async approve(tx: TenantTx, id: string, by: string, reason: string | undefined, now: Date): Promise<ActingRecord> {
    const current = (await this.find(tx, id, now)) as ActingRecord;
    const window = actingWindow(now, current.hours);
    await tx.query(
      "update machvon.acting_grant set status = 'Approved', decided_by = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4, window_start = $5::timestamptz, window_end = $6::timestamptz, version = version + 1 where id = $1::uuid",
      [id, by, now.toISOString(), reason ?? null, window.validFrom.toISOString(), window.validUntil.toISOString()],
    );
    return (await this.find(tx, id, now)) as ActingRecord;
  }

  async reject(tx: TenantTx, id: string, by: string, reason: string, now: Date): Promise<ActingRecord> {
    await tx.query("update machvon.acting_grant set status = 'Rejected', decided_by = $2::uuid, decided_at = $3::timestamptz, decision_reason = $4, version = version + 1 where id = $1::uuid", [id, by, now.toISOString(), reason]);
    return (await this.find(tx, id, now)) as ActingRecord;
  }

  async cancel(tx: TenantTx, id: string, now: Date): Promise<ActingRecord> {
    await tx.query("update machvon.acting_grant set status = 'Cancelled', decided_at = $2::timestamptz, version = version + 1 where id = $1::uuid", [id, now.toISOString()]);
    return (await this.find(tx, id, now)) as ActingRecord;
  }

  /** Ends an approved grant before its window does: 409 `ACTING_STATE_INVALID` when it is not approved or its window is over, 409 `VERSION_CONFLICT` when it changed since it was read. */
  async revoke(tx: TenantTx, id: string, expectedVersion: number, by: string, reason: string, now: Date): Promise<{ before: ActingRecord; after: ActingRecord }> {
    const before = await this.find(tx, id, now, { forUpdate: true });
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.phase !== 'ACTIVE') throw new DomainError('ACTING_STATE_INVALID', 409, 'status');
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    await tx.query("update machvon.acting_grant set status = 'Revoked', revoked_by = $2::uuid, revoked_at = $3::timestamptz, revoke_reason = $4, version = version + 1 where id = $1::uuid", [id, by, now.toISOString(), reason]);
    return { before, after: (await this.find(tx, id, now)) as ActingRecord };
  }

  /**
   * The grant the door of the API lets a request through with: approved, asked for by this member, inside its window now (the database clock decides, with the clock of the caller as a floor: a grant is never in force
   * before it was approved), the person acted for still an active member. Undefined for anything else, so a grant that ended, was revoked, belongs to someone else or is not there all look the same to the caller.
   */
  async liveFor(tx: TenantTx, id: string, requesterId: string, now: Date): Promise<ActingRecord | undefined> {
    const record = await this.find(tx, id, now);
    if (record === undefined || record.requesterId !== requesterId || record.phase !== 'ACTIVE') return undefined;
    const [subject] = await tx.query<{ ok: boolean }>("select (status = 'Active' and valid_from <= $2::timestamptz and (valid_until is null or valid_until > $2::timestamptz)) as ok from machvon.membership where id = $1::uuid", [record.subjectId, now.toISOString()]);
    return subject?.ok === true ? record : undefined;
  }
}
