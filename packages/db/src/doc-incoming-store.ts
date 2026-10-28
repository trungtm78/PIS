import { DomainError, assertIncomingTransition, incomingIdentity, isWorkable } from '@machvon/kernel';
import type { IncomingChannel, IncomingStatus, IncomingUrgency } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import { TIMESTAMP } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const DUPLICATE_CONSTRAINT = 'incoming_document_dup_uq';

export interface IncomingRecord {
  id: string;
  documentId: string;
  status: IncomingStatus;
  channel: IncomingChannel;
  title: string;
  docTypeCode: string;
  classification: string;
  receivedAt: string;
  receivedBy: string;
  registerId: string | null;
  registerCode: string | null;
  /** The unit of the register: where the letter is kept. */
  homeUnitId: string | null;
  homeUnitPath: string | null;
  number: number | null;
  symbol: string | null;
  originalSymbol: string | null;
  originalIssuedOn: string | null;
  senderName: string;
  urgency: IncomingUrgency;
  dueOn: string | null;
  leaderDirective: string | null;
  assignedUnitId: string | null;
  assignedUnitName: string | null;
  assignedUnitPath: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  assignedBy: string | null;
  resolutionSummary: string | null;
  resolvedAt: string | null;
  lateDays: number | null;
  responseOutgoingId: string | null;
  duplicateOfId: string | null;
  duplicateOverrideReason: string | null;
  rejectionReason: string | null;
  isOverdue: boolean;
  overdueSince: string | null;
  currentVersionId: string | null;
  fileSha256: string | null;
  version: number;
  updatedAt: string;
}

export interface IncomingAssignment {
  id: string;
  assignedUnitId: string;
  assignedUnitName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  leaderDirective: string | null;
  dueOn: string | null;
  assignedBy: string;
  assignedAt: string;
}

export interface NewIncoming {
  documentId: string;
  channel: IncomingChannel;
  receivedAt: Date;
  receivedBy: string;
  originalSymbol: string | undefined;
  originalIssuedOn: string | undefined;
  senderName: string;
  urgency: IncomingUrgency;
  duplicateOfId: string | undefined;
  duplicateOverrideReason: string | undefined;
}

export interface IncomingFilters {
  status?: IncomingStatus | undefined;
  assignedUnitId?: string | undefined;
  overdue?: boolean | undefined;
  year?: number | undefined;
}

export interface IncomingPageAnchor {
  code: string;
  id: string;
}

export interface IncomingPage {
  limit: number;
  after?: IncomingPageAnchor | undefined;
}

interface Row {
  id: string;
  document_id: string;
  status: IncomingStatus;
  channel: IncomingChannel;
  title: string;
  doc_type_code: string;
  classification: string;
  received_at: string;
  received_by: string;
  register_id: string | null;
  register_code: string | null;
  home_unit_id: string | null;
  home_unit_path: string | null;
  document_number: number | null;
  symbol: string | null;
  original_symbol: string | null;
  original_issued_on: string | null;
  sender_name: string;
  urgency: IncomingUrgency;
  due_on: string | null;
  leader_directive: string | null;
  assigned_unit_id: string | null;
  assigned_unit_name: string | null;
  assigned_unit_path: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  assigned_by: string | null;
  resolution_summary: string | null;
  resolved_at: string | null;
  late_days: number | null;
  response_outgoing_id: string | null;
  duplicate_of_id: string | null;
  duplicate_override_reason: string | null;
  rejection_reason: string | null;
  is_overdue: boolean;
  overdue_since: string | null;
  current_version_id: string | null;
  file_sha256: string | null;
  version: string;
  updated_at: string;
  sort_key: string;
}

const FROM = `machvon.incoming_document i
  join machvon.document d on d.tenant_id = i.tenant_id and d.id = i.document_id
  left join machvon.document_number_register r on r.tenant_id = i.tenant_id and r.id = i.register_id
  left join machvon.organization_unit ru on ru.tenant_id = i.tenant_id and ru.id = r.organization_unit_id
  left join machvon.organization_unit au on au.tenant_id = i.tenant_id and au.id = i.assigned_unit_id
  left join lateral (select x.display_name from machvon.tenant_user_directory x where x.tenant_id = i.tenant_id and x.user_account_id = i.assignee_user_id order by x.membership_id limit 1) ab on true
  left join machvon.document_version v on v.tenant_id = d.tenant_id and v.id = d.current_version_id`;

const COLUMNS = `i.id, i.document_id, i.status, i.channel, d.title, d.doc_type_code, d.classification, ${TIMESTAMP('i.received_at')} as received_at, i.received_by, i.register_id, r.register_code, r.organization_unit_id as home_unit_id, ru.path as home_unit_path,
  d.document_number, d.symbol, i.original_symbol, i.original_issued_on::text as original_issued_on, i.sender_name, i.urgency, i.due_on::text as due_on, i.leader_directive, i.assigned_unit_id, au.name as assigned_unit_name, au.path as assigned_unit_path,
  i.assignee_user_id, ab.display_name as assignee_name, i.assigned_by, i.resolution_summary, ${TIMESTAMP('i.resolved_at')} as resolved_at, i.late_days, i.response_outgoing_id, i.duplicate_of_id, i.duplicate_override_reason,
  i.rejection_reason, i.is_overdue, i.overdue_since::text as overdue_since, d.current_version_id, trim(v.checksum) as file_sha256, i.version::text as version, ${TIMESTAMP('i.updated_at')} as updated_at,
  to_char(i.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key`;

const toRecord = (row: Row): IncomingRecord => ({
  id: row.id,
  documentId: row.document_id,
  status: row.status,
  channel: row.channel,
  title: row.title,
  docTypeCode: row.doc_type_code,
  classification: row.classification,
  receivedAt: row.received_at,
  receivedBy: row.received_by,
  registerId: row.register_id,
  registerCode: row.register_code,
  homeUnitId: row.home_unit_id,
  homeUnitPath: row.home_unit_path,
  number: row.document_number,
  symbol: row.symbol,
  originalSymbol: row.original_symbol,
  originalIssuedOn: row.original_issued_on,
  senderName: row.sender_name,
  urgency: row.urgency,
  dueOn: row.due_on,
  leaderDirective: row.leader_directive,
  assignedUnitId: row.assigned_unit_id,
  assignedUnitName: row.assigned_unit_name,
  assignedUnitPath: row.assigned_unit_path,
  assigneeUserId: row.assignee_user_id,
  assigneeName: row.assignee_name,
  assignedBy: row.assigned_by,
  resolutionSummary: row.resolution_summary,
  resolvedAt: row.resolved_at,
  lateDays: row.late_days,
  responseOutgoingId: row.response_outgoing_id,
  duplicateOfId: row.duplicate_of_id,
  duplicateOverrideReason: row.duplicate_override_reason,
  rejectionReason: row.rejection_reason,
  isOverdue: row.is_overdue,
  overdueSince: row.overdue_since,
  currentVersionId: row.current_version_id,
  fileSha256: row.file_sha256,
  version: Number(row.version),
  updatedAt: row.updated_at,
});

/**
 * The table gateway of the incoming documents (ST-DOC-011, DOC.md F10). Every write moves the letter along the chain RECEIVED, REGISTERED, ASSIGNED, PROCESSING, RESOLVED, FILED (REJECTED from RECEIVED) at the version it was read at,
 * and the database says the same (trigger `incoming_document_guard`). Who may do what, and the document, the file and the number of the letter, are the business of the controller.
 */
export class DocIncomingStore {
  /** One letter, in the scope of the caller. */
  async find(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<IncomingRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where i.id = $1::uuid and ${predicate?.sql ?? 'true'}`, [id, ...(predicate?.params ?? [])]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The letter locked for a change, in the scope of the caller. */
  async lock(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<IncomingRecord | undefined> {
    const predicate = scope?.(2);
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where i.id = $1::uuid and ${predicate?.sql ?? 'true'} for update of i`, [id, ...(predicate?.params ?? [])]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The letters in the scope of the caller, the latest received first; the cursor is the moment of reception and the id of the last one. */
  async list(tx: TenantTx, filters: IncomingFilters, page: IncomingPage, scope?: ScopeBuilder): Promise<{ records: IncomingRecord[]; next: IncomingPageAnchor | undefined }> {
    assertTimestampCursor(page.after?.code);
    const predicate = scope?.(8);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ${predicate?.sql ?? 'true'} and ($1::text is null or i.status = $1) and ($2::uuid is null or i.assigned_unit_id = $2::uuid) and ($3::boolean is null or i.is_overdue = $3::boolean)
          and ($4::int is null or extract(year from i.received_at at time zone 'Asia/Ho_Chi_Minh') = $4::int) and ($5::timestamptz is null or (i.received_at, i.id) < ($5::timestamptz, $6::uuid))
        order by i.received_at desc, i.id desc limit $7::int`,
      [filters.status ?? null, filters.assignedUnitId ?? null, filters.overdue ?? null, filters.year ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit + 1, ...(predicate?.params ?? [])],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toRecord), next: rows.length > page.limit && last !== undefined ? { code: last.sort_key, id: last.id } : undefined };
  }

  /** A letter already in the register with the same sender, symbol and day (BR-DOC-18), if any: the one that a new letter would duplicate. */
  async duplicateOf(tx: TenantTx, input: { senderName: string; originalSymbol: string | undefined; originalIssuedOn: string | undefined }): Promise<{ id: string; status: IncomingStatus } | undefined> {
    const identity = incomingIdentity(input);
    if (identity === undefined) return undefined;
    // The unique index compares the words as typed and the identity folds case, marks and spaces: two letters that differ only so are taken in one after the other (the lock lasts to the end of the transaction, that writes the letter).
    await tx.query("select pg_advisory_xact_lock(hashtextextended('doc.incoming.identity:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [identity]);
    const rows = await tx.query<{ id: string; status: IncomingStatus; sender_name: string; original_symbol: string }>("select id, status, sender_name, original_symbol from machvon.incoming_document where original_issued_on = $1::date and original_symbol is not null and status <> 'REJECTED' order by received_at, id", [
      input.originalIssuedOn,
    ]);
    const found = rows.find((row) => incomingIdentity({ senderName: row.sender_name, originalSymbol: row.original_symbol, originalIssuedOn: input.originalIssuedOn }) === identity);
    return found === undefined ? undefined : { id: found.id, status: found.status };
  }

  /** Writes the letter that arrived. The unique index of the database (`incoming_document_dup_uq`) is the last word on a letter that was entered twice without a reason. */
  async insert(tx: TenantTx, input: NewIncoming): Promise<{ id: string }> {
    try {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.incoming_document
           (tenant_id, id, document_id, status, channel, received_at, received_by, original_symbol, original_issued_on, sender_name, urgency, duplicate_of_id, duplicate_override_reason, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'RECEIVED', $2, $3::timestamptz, $4::uuid, $5, $6::date, $7, $8, $9::uuid, $10, $4::uuid, $4::uuid)
         returning id`,
        [input.documentId, input.channel, input.receivedAt.toISOString(), input.receivedBy, input.originalSymbol ?? null, input.originalIssuedOn ?? null, input.senderName, input.urgency, input.duplicateOfId ?? null, input.duplicateOverrideReason ?? null],
      );
      if (row === undefined) throw new Error('incoming insert returned no row');
      return row;
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === DUPLICATE_CONSTRAINT) throw new DomainError('INCOMING_DUPLICATE_SUSPECTED', 409, 'original_symbol');
      throw error;
    }
  }

  /** REGISTERED: the letter has its register (the number was allocated by the register in the same transaction). */
  async markRegistered(tx: TenantTx, id: string, input: { expectedVersion: number; registerId: string; actor: string }): Promise<void> {
    await this.advance(tx, id, input.expectedVersion, 'register', 'register_id = $3::uuid', [input.registerId], input.actor);
  }

  /** ASSIGNED (or reassigned): the unit, the handler, the directive and the deadline, with a row of history. A new assignment starts the clock again: the letter is not overdue until the new deadline passes. */
  async markAssigned(tx: TenantTx, id: string, input: { expectedVersion: number; unitId: string; assigneeUserId: string | undefined; directive: string | undefined; dueOn: string | undefined; actor: string }): Promise<void> {
    await this.advance(
      tx,
      id,
      input.expectedVersion,
      'assign',
      'assigned_unit_id = $3::uuid, assignee_user_id = $4::uuid, leader_directive = $5, due_on = $6::date, assigned_by = $ACTOR::uuid, is_overdue = false, overdue_since = null',
      [input.unitId, input.assigneeUserId ?? null, input.directive ?? null, input.dueOn ?? null],
      input.actor,
    );
    await tx.query(
      `insert into machvon.incoming_assignment (tenant_id, id, incoming_document_id, assigned_unit_id, assignee_user_id, leader_directive, due_on, assigned_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::uuid)`,
      [id, input.unitId, input.assigneeUserId ?? null, input.directive ?? null, input.dueOn ?? null, input.actor],
    );
  }

  async markProcessing(tx: TenantTx, id: string, input: { expectedVersion: number; actor: string }): Promise<void> {
    await this.advance(tx, id, input.expectedVersion, 'startProcessing', '', [], input.actor);
  }

  /** RESOLVED, with the summary and how many working days after the deadline it was resolved (none when it was in time). */
  async markResolved(tx: TenantTx, id: string, input: { expectedVersion: number; summary: string; responseOutgoingId: string | undefined; resolvedAt: Date; lateDays: number; actor: string }): Promise<void> {
    await this.advance(tx, id, input.expectedVersion, 'resolve', 'resolution_summary = $3, response_outgoing_id = $4::uuid, resolved_at = $5::timestamptz, late_days = $6::int, is_overdue = (is_overdue or $6::int > 0), overdue_since = case when $6::int > 0 then coalesce(overdue_since, ($5::timestamptz at time zone \'Asia/Ho_Chi_Minh\')::date) else overdue_since end', [input.summary, input.responseOutgoingId ?? null, input.resolvedAt.toISOString(), input.lateDays], input.actor);
  }

  /** FILED: the resolved letter has been put into a dossier. */
  async markFiled(tx: TenantTx, id: string, input: { expectedVersion: number; actor: string }): Promise<void> {
    await this.advance(tx, id, input.expectedVersion, 'file', '', [], input.actor);
  }

  async markRejected(tx: TenantTx, id: string, input: { expectedVersion: number; reason: string; duplicateOfId: string | undefined; actor: string }): Promise<void> {
    // A letter that is refused as a copy points at the one that stays.
    await this.advance(tx, id, input.expectedVersion, 'reject', 'rejection_reason = $3, duplicate_of_id = coalesce($4::uuid, duplicate_of_id)', [input.reason, input.duplicateOfId ?? null], input.actor);
  }

  /** The history of the assignments of a letter, oldest first. */
  async assignments(tx: TenantTx, id: string): Promise<IncomingAssignment[]> {
    const rows = await tx.query<{ id: string; assigned_unit_id: string; unit_name: string | null; assignee_user_id: string | null; assignee_name: string | null; leader_directive: string | null; due_on: string | null; assigned_by: string; assigned_at: string }>(
      `select a.id, a.assigned_unit_id, u.name as unit_name, a.assignee_user_id, d.display_name as assignee_name, a.leader_directive, a.due_on::text as due_on, a.assigned_by, ${TIMESTAMP('a.assigned_at')} as assigned_at
         from machvon.incoming_assignment a
         left join machvon.organization_unit u on u.tenant_id = a.tenant_id and u.id = a.assigned_unit_id
         left join lateral (select x.display_name from machvon.tenant_user_directory x where x.tenant_id = a.tenant_id and x.user_account_id = a.assignee_user_id order by x.membership_id limit 1) d on true
        where a.incoming_document_id = $1::uuid order by a.assigned_at, a.id`,
      [id],
    );
    return rows.map((row) => ({
      id: row.id,
      assignedUnitId: row.assigned_unit_id,
      assignedUnitName: row.unit_name,
      assigneeUserId: row.assignee_user_id,
      assigneeName: row.assignee_name,
      leaderDirective: row.leader_directive,
      dueOn: row.due_on,
      assignedBy: row.assigned_by,
      assignedAt: row.assigned_at,
    }));
  }

  /** The user account behind a membership of the tenant, or none. */
  async userOf(tx: TenantTx, membershipId: string): Promise<string | undefined> {
    const [row] = await tx.query<{ user_account_id: string }>('select user_account_id from machvon.tenant_user_directory where membership_id = $1::uuid', [membershipId]);
    return row?.user_account_id;
  }

  /** The memberships of the tenant behind a user account (the handler of a letter is a user; what they may do is read from their memberships). */
  async membershipsOf(tx: TenantTx, userId: string): Promise<string[]> {
    const rows = await tx.query<{ membership_id: string }>('select membership_id from machvon.tenant_user_directory where user_account_id = $1::uuid order by membership_id', [userId]);
    return rows.map((row) => row.membership_id);
  }

  /** The active memberships of the tenant (who a reminder to a unit may reach). */
  async activeMemberships(tx: TenantTx): Promise<string[]> {
    const rows = await tx.query<{ membership_id: string }>("select membership_id from machvon.tenant_user_directory where status = 'Active' order by membership_id");
    return rows.map((row) => row.membership_id);
  }

  /**
   * The hourly sweep (BR-DOC-18): the letters that are assigned or being processed and past their deadline on a working day are marked overdue, once. Returns the ones that became overdue now, so that the caller can announce
   * them; a letter already marked, one without a deadline and one in time are not touched.
   */
  async markOverdue(tx: TenantTx, today: string, actor: string, isLate: (dueOn: string) => boolean): Promise<IncomingRecord[]> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where i.status in ('ASSIGNED', 'PROCESSING') and i.is_overdue = false and i.due_on is not null and i.due_on < $1::date for update of i`, [today]);
    const marked: IncomingRecord[] = [];
    for (const row of rows) {
      const record = toRecord(row);
      if (!isWorkable(record.status) || record.dueOn === null || !isLate(record.dueOn)) continue;
      await tx.query('update machvon.incoming_document set is_overdue = true, overdue_since = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [record.id, today, actor]);
      marked.push({ ...record, isOverdue: true, overdueSince: today, version: record.version + 1 });
    }
    return marked;
  }

  /** The oldest deadline of a letter that is assigned or being processed and not yet marked overdue (the job loads the calendars from its year). */
  async oldestOpenDue(tx: TenantTx): Promise<string | undefined> {
    const [row] = await tx.query<{ due: string | null }>("select min(due_on)::text as due from machvon.incoming_document where status in ('ASSIGNED', 'PROCESSING') and is_overdue = false and due_on is not null");
    return row?.due ?? undefined;
  }

  private async advance(tx: TenantTx, id: string, expectedVersion: number, command: Parameters<typeof assertIncomingTransition>[0], setters: string, params: unknown[], actor: string): Promise<void> {
    const [held] = await tx.query<{ status: IncomingStatus; version: string }>('select status, version::text as version from machvon.incoming_document where id = $1::uuid for update', [id]);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.version) !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'version', { extensions: { current_version: Number(held.version) } });
    const next = assertIncomingTransition(command, held.status);
    // The parameters of the setters are numbered from $3 ($1 is the letter and $2 the new status); the actor is the last one, named $ACTOR in the setters.
    const actorIndex = params.length + 3;
    const extra = setters === '' ? '' : `${setters.replace(/\$ACTOR/g, `$${actorIndex}`)}, `;
    await tx.query(`update machvon.incoming_document set status = $2, ${extra}updated_at = now(), updated_by = $${actorIndex}::uuid, version = version + 1 where id = $1::uuid`, [id, next, ...params, actor]);
  }
}
