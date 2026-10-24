import { DomainError, checkDifference, signedDifference, versionConflict } from '@machvon/kernel';
import type { Difference } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

/** A difference is due three days after it is found unless the module says otherwise. */
export const DEFAULT_ITEM_DUE_SECONDS = 259_200;
const MIN_NOTE = 10;
const MAX_NOTE = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

export type ItemStatus = 'OPEN' | 'RESOLVED';

export interface ReconciliationItem {
  id: string;
  importId: string;
  line: number;
  connectorCode: string;
  businessKey: string;
  code: string;
  expected: string | null;
  actual: string | null;
  /** `actual - expected` when both are decimals; null otherwise. */
  difference: string | null;
  detail: string | null;
  ownerMembershipId: string;
  dueAt: string;
  /** The due time to the microsecond (UTC): the ordering key of the list and its cursor. */
  dueAtKey: string;
  openedAt: string;
  status: ItemStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  version: number;
}

interface ItemSql {
  id: string;
  import_id: string;
  line: number;
  connector_code: string;
  business_key: string;
  code: string;
  expected_value: string | null;
  actual_value: string | null;
  difference: string | null;
  detail: string | null;
  owner_membership_id: string;
  due_at: string;
  due_at_key: string;
  opened_at: string;
  status: ItemStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  version: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const SELECT = `select id, import_id, line, connector_code, business_key, code, expected_value, actual_value, difference, detail, owner_membership_id,
  to_char(due_at at time zone 'UTC', ${ISO}) as due_at, ${timestampKey('due_at')} as due_at_key, to_char(opened_at at time zone 'UTC', ${ISO}) as opened_at,
  status, resolved_by, to_char(resolved_at at time zone 'UTC', ${ISO}) as resolved_at, resolution_note, version::text as version
  from machvon.file_import_reconciliation_item`;

const toItem = (row: ItemSql): ReconciliationItem => ({
  id: row.id,
  importId: row.import_id,
  line: row.line,
  connectorCode: row.connector_code,
  businessKey: row.business_key,
  code: row.code,
  expected: row.expected_value,
  actual: row.actual_value,
  difference: row.difference,
  detail: row.detail,
  ownerMembershipId: row.owner_membership_id,
  dueAt: row.due_at,
  dueAtKey: row.due_at_key,
  openedAt: row.opened_at,
  status: row.status,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  resolutionNote: row.resolution_note,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A uuid in the one form that is stored, compared and audited. */
export function normalizeUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
}

/** True when the person is an active member of the tenant of the transaction. */
export async function isActiveMember(tx: TenantTx, membershipId: string): Promise<boolean> {
  const rows = await tx.query("select 1 from machvon.membership where id = $1::uuid and status = 'Active' and (valid_until is null or valid_until > now())", [membershipId]);
  return rows.length > 0;
}

export interface OpenItemInput {
  importId: string;
  line: number;
  connectorCode: string;
  businessKey: string;
  difference: Difference;
  rowHash: string | null;
  ownerId: string;
  /** The time the item is opened at; it is due `dueAfterSeconds` later. */
  now: Date;
  dueAfterSeconds: number;
}

/**
 * Opens an item for a difference, or returns the one already open for the same connector, business key and kind of difference: a
 * difference met again in another file is the same piece of work, not a second one. `created` tells which.
 */
export async function openItem(tx: TenantTx, input: OpenItemInput): Promise<{ id: string; created: boolean; dueAt: string }> {
  checkDifference(input.difference);
  const { difference } = input;
  const dueSeconds = difference.dueAfterSeconds ?? input.dueAfterSeconds;
  const inserted = await tx.query<{ id: string; due_at: string }>(
    `insert into machvon.file_import_reconciliation_item
       (tenant_id, id, import_id, line, connector_code, business_key, code, expected_value, actual_value, difference, detail, row_hash,
        owner_membership_id, due_at, opened_at)
     values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::timestamptz + make_interval(secs => $13), $12::timestamptz)
     on conflict (tenant_id, connector_code, business_key, code) where status = 'OPEN' do nothing
     returning id, to_char(due_at at time zone 'UTC', ${ISO}) as due_at`,
    [
      input.importId,
      input.line,
      input.connectorCode,
      input.businessKey,
      difference.code,
      difference.expected ?? null,
      difference.actual ?? null,
      signedDifference(difference.expected, difference.actual),
      difference.detail ?? null,
      input.rowHash,
      input.ownerId,
      input.now.toISOString(),
      dueSeconds,
    ],
  );
  if (inserted[0] !== undefined) return { id: inserted[0].id, created: true, dueAt: inserted[0].due_at };
  const [open] = await tx.query<{ id: string; due_at: string }>(
    `select id, to_char(due_at at time zone 'UTC', ${ISO}) as due_at from machvon.file_import_reconciliation_item
      where connector_code = $1 and business_key = $2 and code = $3 and status = 'OPEN'`,
    [input.connectorCode, input.businessKey, difference.code],
  );
  if (open === undefined) throw new Error('reconciliation item vanished after a key conflict');
  return { id: open.id, created: false, dueAt: open.due_at };
}

export interface ListItemsRequest {
  /** Defaults to the open items. */
  status?: ItemStatus;
  ownerId?: string;
  connectorCode?: string;
  /** Only the items due before this time (the overdue ones when it is now). */
  dueBefore?: Date;
  limit: number;
  after: { key: string; id: string } | undefined;
}

/**
 * The reconciliation items that file imports leave behind: every item has an owner and a due time from the moment it opens, and ends
 * once with a note. Who may read, resolve or hand over an item is for the module that exposes it (the store only records the people).
 */
export class FileImportItemStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<ReconciliationItem | undefined> {
    const rows = await tx.query<ItemSql>(`${SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [normalizeUuid(id, 'id')]);
    return rows[0] === undefined ? undefined : toItem(rows[0]);
  }

  /** The items by due time, the longest overdue first; the cursor is the due time and the id of the last item. */
  async list(tx: TenantTx, request: ListItemsRequest): Promise<ReconciliationItem[]> {
    const rows = await tx.query<ItemSql>(
      `${SELECT}
        where status = $1
          and ($2::uuid is null or owner_membership_id = $2::uuid)
          and ($3::text is null or connector_code = $3)
          and ($4::timestamptz is null or due_at < $4::timestamptz)
          and ($5::text is null or (${timestampKey('due_at')}, id) > ($5::text, $6::uuid))
        order by due_at, id limit $7`,
      [
        request.status ?? 'OPEN',
        request.ownerId === undefined ? null : normalizeUuid(request.ownerId, 'owner_membership_id'),
        request.connectorCode ?? null,
        request.dueBefore?.toISOString() ?? null,
        request.after?.key ?? null,
        request.after?.id ?? null,
        request.limit,
      ],
    );
    return rows.map(toItem);
  }

  /** Closes an item with what a person found out. An item already closed is 409 STAGE_TRANSITION_DENIED. */
  async resolve(tx: TenantTx, input: { itemId: string; resolvedBy: string; note: string }): Promise<{ before: ReconciliationItem; row: ReconciliationItem }> {
    const note = input.note.trim();
    if (note.length < MIN_NOTE || note.length > MAX_NOTE) throw invalid('resolution_note');
    const resolvedBy = normalizeUuid(input.resolvedBy, 'resolved_by');
    const before = await this.find(tx, input.itemId, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.status !== 'OPEN') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    await tx.query(
      `update machvon.file_import_reconciliation_item
          set status = 'RESOLVED', resolved_by = $2::uuid, resolved_at = now(), resolution_note = $3, version = version + 1, updated_at = now()
        where id = $1::uuid`,
      [before.id, resolvedBy, note],
    );
    return { before, row: await this.reload(tx, before.id) };
  }

  /** Hands an open item to another active member of the tenant. The due time stays: a handover does not give more time. */
  async reassign(tx: TenantTx, input: { itemId: string; ownerId: string; expectedVersion: number }): Promise<{ before: ReconciliationItem; row: ReconciliationItem }> {
    const ownerId = normalizeUuid(input.ownerId, 'owner_membership_id');
    const before = await this.find(tx, input.itemId, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== input.expectedVersion) throw versionConflict(before.version);
    if (before.status !== 'OPEN') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (!(await isActiveMember(tx, ownerId))) throw invalid('owner_membership_id');
    await tx.query('update machvon.file_import_reconciliation_item set owner_membership_id = $2::uuid, version = version + 1, updated_at = now() where id = $1::uuid', [before.id, ownerId]);
    return { before, row: await this.reload(tx, before.id) };
  }

  private async reload(tx: TenantTx, id: string): Promise<ReconciliationItem> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new Error('reconciliation item vanished after an update');
    return row;
  }
}
