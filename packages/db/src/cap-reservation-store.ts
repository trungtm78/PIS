import { randomUUID } from 'node:crypto';
import { DomainError, asUuid, requirePositiveAmount, versionConflict } from '@machvon/kernel';
import { CapAvailabilityStore } from './cap-availability-store.ts';
import type { CommitResult } from './cap-availability-store.ts';
import { debitBalance, lockLedgerRows } from './ledger-lock.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The earmark of capital (ST-CAP-011, CAP 3.1 F4, BR-CAP-06, CAP-18). An investor reserves part of a line before a commitment is made, for a purpose, until a day: the reservation is judged by the same availability policy
 * as a commitment (a warning needs to be accepted, a share above the block threshold is refused), `reserved_vnd` rises with a RESERVE entry, and the reservation leaves ACTIVE once: released by a person with a reason, expired by
 * the job at its last instant, or consumed by a payment (the payment consumer, ST-PAY). Releasing and expiring post one RELEASE entry; the ledger dedupes by the reservation, so a second pass writes nothing.
 */
export const RESERVATION_RESOURCE = 'fund_reservation';
export const RESERVATION_PURPOSES = ['CONTRACT_PENDING', 'ADVANCE_PENDING', 'LAND_CLEARANCE', 'OTHER'] as const;
export type ReservationPurpose = (typeof RESERVATION_PURPOSES)[number];
export const RESERVATION_STATUSES = ['ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** An earmark is for the near term: it may run at most this many days. */
export const MAX_RESERVATION_DAYS = 366;
const LIST_MAX = 200;
const REASON_MIN = 5;
const REASON_MAX = 2000;
const KIND_MAX = 50;
const EXPIRED_REASON = 'EXPIRED';

export interface ReservationInput {
  allocationLineId: string;
  /** Whole VND, above zero. */
  amountVnd: string;
  purpose: string;
  referenceKind: string | undefined;
  referenceId: string | undefined;
  /** The instant it runs out, ISO 8601 with a zone. */
  expiresAt: string;
  acknowledgeWarning: boolean;
}

export interface ReservationScopes {
  /** The projects the caller may reserve capital for (`capital.reservation.manage`). */
  act: ScopeBuilder;
  /** The projects the caller may see capital of (`capital.read`). */
  read: ScopeBuilder;
}

export interface FundReservationRow {
  id: string;
  allocationLineId: string;
  project: { id: string; code: string; name: string };
  planYear: number;
  purpose: ReservationPurpose;
  referenceKind: string | null;
  referenceId: string | null;
  amountVnd: string;
  expiresAt: string;
  status: ReservationStatus;
  releaseReason: string | null;
  avcWarningAcknowledged: boolean;
  createdAt: string;
  createdBy: string;
  closedAt: string | null;
  closedBy: string | null;
  version: number;
  /** The microsecond text of the creation time: the key of the cursor of the list. */
  createdAtKey: string;
}

export interface ReservationCreated {
  id: string;
  allocationLineId: string;
  appropriationId: string;
  projectId: string;
  planYear: number;
  amountVnd: string;
  purpose: ReservationPurpose;
  expiresAt: string;
  entryId: string;
  commit: CommitResult;
  version: number;
}

export interface ReservationClosed {
  id: string;
  allocationLineId: string;
  appropriationId: string;
  projectId: string;
  planYear: number;
  amountVnd: string;
  status: 'RELEASED' | 'EXPIRED';
  reason: string;
  entryId: string;
  version: number;
}

export interface ReservationFilter {
  status?: ReservationStatus;
  allocationLineId?: string;
  projectId?: string;
}

interface Sql {
  id: string;
  allocation_line_id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  plan_year: number;
  purpose: ReservationPurpose;
  reference_kind: string | null;
  reference_id: string | null;
  amount_vnd: string;
  expires_at: string;
  status: ReservationStatus;
  release_reason: string | null;
  avc_warning_acknowledged: boolean;
  created_at: string;
  created_by: string;
  closed_at: string | null;
  closed_by: string | null;
  version: string;
  created_at_key: string;
}

interface LockedSql {
  id: string;
  allocation_line_id: string;
  project_id: string;
  appropriation_id: string;
  balance_id: string;
  plan_year: number;
  amount_vnd: string;
  status: ReservationStatus;
  version: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const TIMESTAMP = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SELECT = `select r.id, r.allocation_line_id, r.project_id, p.code as project_code, p.name as project_name, r.plan_year, r.purpose, r.reference_kind, r.reference_id, r.amount_vnd::text as amount_vnd,
    ${TIMESTAMP('r.expires_at')} as expires_at, r.status, r.release_reason, r.avc_warning_acknowledged, ${TIMESTAMP('r.created_at')} as created_at, r.created_by, ${TIMESTAMP('r.closed_at')} as closed_at,
    r.closed_by, r.version::text as version, ${timestampKey('r.created_at')} as created_at_key
  from machvon.fund_reservation r join ${SCOPE_FROM} on p.id = r.project_id`;

const rowOf = (row: Sql): FundReservationRow => ({
  id: row.id,
  allocationLineId: row.allocation_line_id,
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  planYear: row.plan_year,
  purpose: row.purpose,
  referenceKind: row.reference_kind,
  referenceId: row.reference_id,
  amountVnd: row.amount_vnd,
  expiresAt: row.expires_at,
  status: row.status,
  releaseReason: row.release_reason,
  avcWarningAcknowledged: row.avc_warning_acknowledged,
  createdAt: row.created_at,
  createdBy: row.created_by,
  closedAt: row.closed_at,
  closedBy: row.closed_by,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

export class CapReservationStore {
  private readonly availability: CapAvailabilityStore;

  constructor(availability: CapAvailabilityStore = new CapAvailabilityStore()) {
    this.availability = availability;
  }

  /**
   * Reserves capital on a line. Refusals in order: the fields (422: the amount in whole VND, the purpose, a reference that is a kind with an id, a last instant that lies ahead and within 366 days), the line (404 when it does
   * not exist in the scope of the caller, 403 when the caller sees its project and may not reserve for it), the year (409 `FISCAL_YEAR_LOCKED`), `AVC_BLOCKED` and `AVC_WARNING_ACK_REQUIRED` (422). Nothing is written by a refusal.
   */
  async create(tx: TenantTx, input: ReservationInput, actor: string, scopes: ReservationScopes, now: Date): Promise<ReservationCreated> {
    try {
      requirePositiveAmount(input.amountVnd, 0);
    } catch {
      throw invalid('amount_vnd');
    }
    if (!(RESERVATION_PURPOSES as readonly string[]).includes(input.purpose)) throw invalid('purpose');
    const purpose = input.purpose as ReservationPurpose;
    const kind = input.referenceKind?.trim();
    if ((kind === undefined || kind === '') !== (input.referenceId === undefined)) throw invalid(input.referenceId === undefined ? 'reference_id' : 'reference_kind');
    if (kind !== undefined && kind !== '' && kind.length > KIND_MAX) throw invalid('reference_kind');
    const referenceId = input.referenceId === undefined ? undefined : asUuid(input.referenceId);
    if (input.referenceId !== undefined && referenceId === undefined) throw invalid('reference_id');
    const expires = Date.parse(input.expiresAt);
    if (Number.isNaN(expires) || expires <= now.getTime() || expires > now.getTime() + MAX_RESERVATION_DAYS * 86_400_000) throw invalid('expires_at');

    const [line] = await tx.query<{ project_id: string }>('select project_id from machvon.allocation_line where id = $1::uuid', [input.allocationLineId]);
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.assertMayReserveFor(tx, line.project_id, scopes);

    const id = randomUUID();
    const commit = await this.availability.checkAndReserve(tx, { allocationLineId: input.allocationLineId, amountVnd: input.amountVnd, reservationId: id, acknowledgeWarning: input.acknowledgeWarning }, actor);
    await tx.query(
      `insert into machvon.fund_reservation
         (tenant_id, id, allocation_line_id, project_id, plan_year, purpose, reference_kind, reference_id, amount_vnd, expires_at, status, avc_warning_acknowledged, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::integer, $5, $6, $7::uuid, $8::numeric, $9::timestamptz, 'ACTIVE', $10::boolean, $11::uuid, $11::uuid)`,
      [id, input.allocationLineId, commit.projectId, commit.planYear, purpose, kind === undefined || kind === '' ? null : kind, referenceId ?? null, input.amountVnd, new Date(expires).toISOString(), commit.warningAcknowledged, actor],
    );
    return {
      id,
      allocationLineId: commit.allocationLineId,
      appropriationId: commit.appropriationId,
      projectId: commit.projectId,
      planYear: commit.planYear,
      amountVnd: input.amountVnd,
      purpose,
      expiresAt: new Date(expires).toISOString(),
      entryId: commit.entryId,
      commit,
      version: 1,
    };
  }

  /**
   * Releases an active reservation with a reason of five to 2000 characters, against the version the caller read. 404 for one out of sight, 403 for one the caller may see and not release, 409 `VERSION_CONFLICT`, then 409
   * `RESERVATION_NOT_ACTIVE` for one that is already consumed, released or expired. The capital returns to the line in the same transaction (a RELEASE entry).
   */
  async release(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ReservationScopes): Promise<ReservationClosed> {
    const text = reason.trim();
    if (text.length < REASON_MIN || text.length > REASON_MAX) throw invalid('reason');
    const [peek] = await tx.query<{ project_id: string; status: ReservationStatus; version: string }>('select project_id, status, version::text as version from machvon.fund_reservation where id = $1::uuid', [id]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.assertMayReserveFor(tx, peek.project_id, scopes);
    // A reservation that has left ACTIVE is final and rests on no balance that has to be locked (a revision of the plan moves the active ones only): the answer is the same as under the lock.
    if (peek.status !== 'ACTIVE') {
      if (Number(peek.version) !== expectedVersion) throw versionConflict(Number(peek.version));
      throw new DomainError('RESERVATION_NOT_ACTIVE', 409, undefined, { extensions: { status: peek.status } });
    }
    // The balance first and the reservation after it, as the publication of a plan does: the two never wait for each other.
    await lockLedgerRows(tx, [{ table: 'allocation_balance', id: await this.balanceOf(tx, id) }]);
    const held = await this.lock(tx, id);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'ACTIVE') throw new DomainError('RESERVATION_NOT_ACTIVE', 409, undefined, { extensions: { status: held.status } });
    return this.close(tx, held, 'RELEASED', text, actor);
  }

  /**
   * The reservations whose last instant has passed become EXPIRED, once each, with their capital returned by a RELEASE entry. Returns
   * the ones closed now, so that a second pass, or two passes at the same time, close and announce nothing twice.
   */
  async expireDue(tx: TenantTx, now: Date, actor: string): Promise<ReservationClosed[]> {
    const due = await tx.query<{ id: string; balance_id: string }>(
      `select r.id, ab.id as balance_id
         from machvon.fund_reservation r join machvon.allocation_balance ab on ab.tenant_id = r.tenant_id and ab.allocation_line_id = r.allocation_line_id
        where r.status = 'ACTIVE' and r.expires_at <= $1::timestamptz order by r.expires_at, r.id`,
      [now.toISOString()],
    );
    // The balances of everything that is due are locked first and together, whatever the number of them (a backlog is not cut into batches: the locks of a first batch would be held while the second asked for others, out of the one order), in the one lock order of the product, and the reservations after them (as the publication of a plan and a release do): nothing waits for this batch while it waits for something else.
    await lockLedgerRows(tx, [...new Set(due.map((row) => row.balance_id))].map((id) => ({ table: 'allocation_balance', id })));
    const closed: ReservationClosed[] = [];
    for (const row of due) {
      const held = await this.lock(tx, row.id);
      if (held === undefined || held.status !== 'ACTIVE') continue;
      closed.push(await this.close(tx, held, 'EXPIRED', EXPIRED_REASON, actor));
    }
    return closed;
  }

  /** The reservations of the projects the caller sees capital of, newest first. */
  async list(tx: TenantTx, filter: ReservationFilter, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<FundReservationRow[]> {
    assertTimestampCursor(request.after?.code);
    if (request.after !== undefined && asUuid(request.after.id) === undefined) throw invalid('cursor');
    const predicate = scope(7);
    const rows = await tx.query<Sql>(
      `${SELECT}
        where ($1::text is null or r.status = $1) and ($2::uuid is null or r.allocation_line_id = $2::uuid) and ($3::uuid is null or r.project_id = $3::uuid)
          and ($4::text is null or (${timestampKey('r.created_at')}, r.id) < ($4::text, $5::uuid)) and ${predicate.sql}
        order by r.created_at desc, r.id desc limit $6`,
      [filter.status ?? null, filter.allocationLineId ?? null, filter.projectId ?? null, request.after?.code ?? null, request.after?.id ?? null, Math.min(request.limit, LIST_MAX + 1), ...predicate.params],
    );
    return rows.map(rowOf);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<FundReservationRow | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<Sql>(`${SELECT} where r.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  /** 404 when the project is not in the scope the caller reads, 403 when they read it and may not reserve for it. */
  private async assertMayReserveFor(tx: TenantTx, projectId: string, scopes: ReservationScopes): Promise<void> {
    const acting = scopes.act(2);
    const found = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${acting.sql}`, [projectId, ...acting.params]);
    if (found[0] !== undefined) return;
    const reading = scopes.read(2);
    const seen = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${reading.sql}`, [projectId, ...reading.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }

  /** The balance a reservation rests on: the one of its line, which keeps its id when a revision of the plan moves it to another line. */
  private async balanceOf(tx: TenantTx, id: string): Promise<string> {
    const [row] = await tx.query<{ id: string }>(
      'select ab.id from machvon.fund_reservation r join machvon.allocation_balance ab on ab.tenant_id = r.tenant_id and ab.allocation_line_id = r.allocation_line_id where r.id = $1::uuid',
      [id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row.id;
  }

  private async lock(tx: TenantTx, id: string): Promise<LockedSql | undefined> {
    const [row] = await tx.query<LockedSql>(
      `select r.id, r.allocation_line_id, r.project_id, al.appropriation_id, ab.id as balance_id, r.plan_year, r.amount_vnd::text as amount_vnd, r.status, r.version::text as version
         from machvon.fund_reservation r
         join machvon.allocation_line al on al.tenant_id = r.tenant_id and al.id = r.allocation_line_id
         join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
        where r.id = $1::uuid for update of r`,
      [id],
    );
    return row;
  }

  private async close(tx: TenantTx, held: LockedSql, status: 'RELEASED' | 'EXPIRED', reason: string, actor: string): Promise<ReservationClosed> {
    await lockLedgerRows(tx, [{ table: 'allocation_balance', id: held.balance_id }]);
    await debitBalance(tx, { table: 'allocation_balance', id: held.balance_id, column: 'reserved_vnd' }, held.amount_vnd);
    const entryId = randomUUID();
    await tx.query(
      `insert into machvon.capital_ledger_entry
         (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reason, posted_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'RELEASE', $5::numeric, $6::integer, 'RESERVATION', $7::uuid, $8, $9::uuid)`,
      [entryId, held.appropriation_id, held.allocation_line_id, held.project_id, held.amount_vnd, held.plan_year, held.id, reason, actor],
    );
    await tx.query(
      `update machvon.fund_reservation
          set status = $2, release_reason = $3, closed_at = now(), closed_by = $4::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, status, reason, actor],
    );
    return {
      id: held.id,
      allocationLineId: held.allocation_line_id,
      appropriationId: held.appropriation_id,
      projectId: held.project_id,
      planYear: held.plan_year,
      amountVnd: held.amount_vnd,
      status,
      reason,
      entryId,
      version: Number(held.version) + 1,
    };
  }
}
