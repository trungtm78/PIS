import { randomUUID } from 'node:crypto';
import { DomainError, NOOP_METRICS, RECONCILIATION_RESOLUTIONS, RECONCILIATION_STATUSES, assertWriteOff, isWaiting, reconciliationTarget, requiredNote, versionConflict } from '@machvon/kernel';
import type { MetricsSink, ReconciliationResolution, ReconciliationStatus } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { normalizeUuid } from './file-import-item-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { enqueueOutbox } from './outbox.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The items of difference that still wait for a person, and of those the ones past their day (gauges; the alert `PAY_RECONCILIATION_OVERDUE` watches the second). */
export const PAY_RECONCILIATION_OPEN_METRIC = 'pay_reconciliation_open';
export const PAY_RECONCILIATION_OVERDUE_METRIC = 'pay_reconciliation_overdue';
/** The type of the event that asks ISS for an issue about an item that is past its day (the common contract of the issue intake, ISS-11). */
export const RECONCILIATION_OVERDUE_EVENT = 'pay.reconciliation.overdue.v1';

const RESOURCE_TYPE = 'reconciliation_item';
const CLASSIFICATION = 'CONFIDENTIAL';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const MAX_PAGE = 200;
const CHECK_VIOLATION = '23514';
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });

/** One item of difference as the screens read it: both figures, the signed difference, who owns it and by when, and what became of it. */
export interface ReconciliationItemView {
  id: string;
  kind: string;
  status: ReconciliationStatus;
  projectId: string;
  projectCode: string;
  contractId: string | null;
  contractCode: string | null;
  paymentRequestId: string | null;
  requestNo: string | null;
  transactionId: string | null;
  documentNo: string | null;
  sourceFileName: string | null;
  sourceFileSha256: string | null;
  internalAmountVnd: string | null;
  confirmedAmountVnd: string | null;
  differenceVnd: string | null;
  ownerMembershipId: string;
  ownerName: string | null;
  dueAt: string;
  overdue: boolean;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  approvalDocumentVersionId: string | null;
  issueId: string | null;
  version: number;
  /** The due day to the microsecond (UTC): the ordering key of the list and its cursor. */
  dueAtKey: string;
}

interface ItemSql {
  id: string;
  kind: string;
  status: ReconciliationStatus;
  project_id: string;
  project_code: string;
  contract_id: string | null;
  contract_code: string | null;
  payment_request_id: string | null;
  request_no: string | null;
  treasury_transaction_id: string | null;
  document_no: string | null;
  file_name: string | null;
  file_sha256: string | null;
  internal_amount_vnd: string | null;
  confirmed_amount_vnd: string | null;
  difference_vnd: string | null;
  owner_membership_id: string;
  owner_name: string | null;
  due_at: string;
  overdue: boolean;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  approval_document_version_id: string | null;
  issue_id: string | null;
  version: string;
  due_at_key: string;
}

const COLUMNS = `ri.id, ri.kind, ri.status, ri.project_id, p.code as project_code, ri.contract_id, c.code as contract_code, ri.payment_request_id, pr.request_no, ri.treasury_transaction_id, t.document_no,
  ti.file_name, ti.file_sha256, ri.internal_amount_vnd::text as internal_amount_vnd, ri.confirmed_amount_vnd::text as confirmed_amount_vnd, ri.difference_vnd::text as difference_vnd,
  ri.owner_membership_id, d.display_name as owner_name, to_char(ri.due_at at time zone 'UTC', ${ISO}) as due_at, (ri.status in ('OPEN', 'EXPLAINED') and ri.due_at < $1::timestamptz) as overdue,
  ri.resolution_note, ri.resolved_by, to_char(ri.resolved_at at time zone 'UTC', ${ISO}) as resolved_at, ri.approval_document_version_id, ri.issue_id, ri.version::text as version,
  ${timestampKey('ri.due_at')} as due_at_key`;

const FROM = `from ${SCOPE_FROM}
  join machvon.reconciliation_item ri on ri.tenant_id = p.tenant_id and ri.project_id = p.id
  left join machvon.contract c on c.tenant_id = ri.tenant_id and c.id = ri.contract_id
  left join machvon.payment_request pr on pr.tenant_id = ri.tenant_id and pr.id = ri.payment_request_id
  left join machvon.treasury_transaction t on t.tenant_id = ri.tenant_id and t.id = ri.treasury_transaction_id
  left join machvon.treasury_import ti on ti.tenant_id = t.tenant_id and ti.id = t.import_id
  left join machvon.tenant_user_directory d on d.tenant_id = ri.tenant_id and d.membership_id = ri.owner_membership_id`;

const toView = (row: ItemSql): ReconciliationItemView => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  projectId: row.project_id,
  projectCode: row.project_code,
  contractId: row.contract_id,
  contractCode: row.contract_code,
  paymentRequestId: row.payment_request_id,
  requestNo: row.request_no,
  transactionId: row.treasury_transaction_id,
  documentNo: row.document_no,
  sourceFileName: row.file_name,
  sourceFileSha256: row.file_sha256,
  internalAmountVnd: row.internal_amount_vnd,
  confirmedAmountVnd: row.confirmed_amount_vnd,
  differenceVnd: row.difference_vnd,
  ownerMembershipId: row.owner_membership_id,
  ownerName: row.owner_name,
  dueAt: row.due_at,
  overdue: row.overdue,
  resolutionNote: row.resolution_note,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  approvalDocumentVersionId: row.approval_document_version_id,
  issueId: row.issue_id,
  version: Number(row.version),
  dueAtKey: row.due_at_key,
});

export interface ReconciliationFilter {
  status?: string | undefined;
  ownerMembershipId?: string | undefined;
  limit: number;
  after: { code: string; id: string } | undefined;
}

/** What the board counts: the items that wait, the ones past their day, and the signed difference they hold. */
export interface ReconciliationSummary {
  waiting: number;
  overdue: number;
  waitingDifferenceVnd: string;
}

export interface ReconciliationChange {
  view: ReconciliationItemView;
  fromStatus: ReconciliationStatus;
  fromOwnerMembershipId: string;
}

/**
 * The work on a difference (ST-PAY-007, PAY 3.3 step 5): a difference has an owner and a day it is due, from the moment it is opened; the owner can be changed while it waits; it is explained, then
 * resolved, or written off by someone other than its owner with the document that approves it, and the two figures it was opened with are never touched (the generated difference stays what it was).
 * An item past its day is reported once, by an event that ISS answers by opening an issue and writing its identifier back here.
 */
export class PayReconciliationStore {
  private readonly metrics: MetricsSink;

  constructor(metrics: MetricsSink = NOOP_METRICS) {
    this.metrics = metrics;
  }

  /** The items of the projects in the scope of the caller, the ones due first; the cursor is the due time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: ReconciliationFilter, now: Date): Promise<ReconciliationItemView[]> {
    const status = filter.status === undefined ? null : (RECONCILIATION_STATUSES.find((candidate) => candidate === filter.status) ?? this.badFilter('status'));
    const owner = filter.ownerMembershipId === undefined ? null : normalizeUuid(filter.ownerMembershipId, 'owner_membership_id');
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(6);
    const rows = await tx.query<ItemSql>(
      `select ${COLUMNS} ${FROM}
        where ($2::text is null or ri.status = $2) and ($3::uuid is null or ri.owner_membership_id = $3::uuid)
          and ($4::text is null or (${timestampKey('ri.due_at')}, ri.id) > ($4::text, $5::uuid)) and ${predicate.sql}
        order by ri.due_at asc, ri.id asc limit ${filter.limit}`,
      [now.toISOString(), status, owner, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toView);
  }

  /** One item inside the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, scope: ScopeBuilder, id: string, now: Date): Promise<ReconciliationItemView | undefined> {
    const predicate = scope(3);
    const rows = await tx.query<ItemSql>(`select ${COLUMNS} ${FROM} where ri.id = $2::uuid and ${predicate.sql}`, [now.toISOString(), normalizeUuid(id, 'id'), ...predicate.params]);
    return rows[0] === undefined ? undefined : toView(rows[0]);
  }

  /** What the board counts for the projects in the scope of the caller. */
  async summary(tx: TenantTx, scope: ScopeBuilder, now: Date): Promise<ReconciliationSummary> {
    const predicate = scope(2);
    const [row] = await tx.query<{ waiting: string; overdue: string; difference: string }>(
      `select count(*)::text as waiting, (count(*) filter (where ri.due_at < $1::timestamptz))::text as overdue, coalesce(sum(ri.difference_vnd), 0)::text as difference
         from ${SCOPE_FROM} join machvon.reconciliation_item ri on ri.tenant_id = p.tenant_id and ri.project_id = p.id
        where ri.status in ('OPEN', 'EXPLAINED') and ${predicate.sql}`,
      [now.toISOString(), ...predicate.params],
    );
    return { waiting: Number(row?.waiting ?? 0), overdue: Number(row?.overdue ?? 0), waitingDifferenceVnd: row?.difference ?? '0' };
  }

  /** Gives the item to an owner with the day it is due; while the item waits the owner can be changed as often as needed, and the owner must be a member who is active. */
  async assign(tx: TenantTx, id: string, expectedVersion: number, input: { ownerMembershipId: string; dueAt: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<ReconciliationChange> {
    const owner = normalizeUuid(input.ownerMembershipId, 'owner_membership_id');
    if (!ISO_INSTANT.test(input.dueAt) || Number.isNaN(Date.parse(input.dueAt))) throw invalid('due_at');
    const due = new Date(input.dueAt);
    if (due.getTime() <= now.getTime()) throw invalid('due_at', 'NOT_IN_THE_FUTURE');
    const held = await this.lock(tx, id, expectedVersion, scope, now);
    if (!isWaiting(held.status)) throw new DomainError('RECONCILIATION_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    const members = await tx.query<{ id: string }>("select id from machvon.membership where id = $1::uuid and status = 'Active'", [owner]);
    if (members[0] === undefined) throw invalid('owner_membership_id', 'NOT_AN_ACTIVE_MEMBER');
    await tx.query(
      'update machvon.reconciliation_item set owner_membership_id = $2::uuid, due_at = $3::timestamptz, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid',
      [held.id, owner, due.toISOString(), actor],
    );
    await this.refreshGauges(tx, now);
    return { view: await this.viewOf(tx, held.id, now), fromStatus: held.status, fromOwnerMembershipId: held.owner_membership_id };
  }

  /**
   * Explains, resolves or writes off an item with the words of the person (422 `VALIDATION_FAILED` without them). A write-off asks for the document that approves it (422 `APPROVAL_REQUIRED`) and for
   * someone other than the owner (403 `SELF_APPROVAL_DENIED`); it changes no figure, so the difference stays what it was.
   */
  async resolve(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    input: { resolution: string; note: string | undefined; approvalDocumentVersionId: string | undefined },
    actor: string,
    scope: ScopeBuilder,
    now: Date,
  ): Promise<ReconciliationChange> {
    const resolution: ReconciliationResolution = RECONCILIATION_RESOLUTIONS.find((candidate) => candidate === input.resolution) ?? this.badFilter('resolution');
    const note = requiredNote(input.note, 'note');
    const approval = input.approvalDocumentVersionId === undefined ? undefined : normalizeUuid(input.approvalDocumentVersionId, 'approval_document_version_id');
    const held = await this.lock(tx, id, expectedVersion, scope, now);
    const target = reconciliationTarget(held.status, resolution);
    if (target === undefined) throw new DomainError('RECONCILIATION_STATE_INVALID', 409, 'id', { extensions: { status: held.status, resolution } });
    if (resolution === 'WRITTEN_OFF') {
      assertWriteOff({ ownerMembershipId: held.owner_membership_id, actor, approvalDocumentVersionId: approval });
      const [document] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [approval as string]);
      if (document === undefined) throw invalid('approval_document_version_id', 'NOT_FOUND');
      if (document.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'approval_document_version_id');
    }
    const ends = target !== 'EXPLAINED';
    try {
      await tx.query(
        `update machvon.reconciliation_item
            set status = $2, resolution_note = $3, resolved_by = case when $4 then $5::uuid else null end, resolved_at = case when $4 then now() else null end, approval_document_version_id = $6::uuid,
                updated_at = now(), updated_by = $5::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, target, note, ends, actor, approval ?? null],
      );
    } catch (error) {
      throw this.mapRefusal(error);
    }
    await this.refreshGauges(tx, now);
    return { view: await this.viewOf(tx, held.id, now), fromStatus: held.status, fromOwnerMembershipId: held.owner_membership_id };
  }

  /** Counts the items that wait and the ones past their day, for the whole tenant, on the gauges the alert reads. */
  async refreshGauges(tx: TenantTx, now: Date): Promise<ReconciliationSummary> {
    const [row] = await tx.query<{ waiting: string; overdue: string; difference: string }>(
      `select count(*)::text as waiting, (count(*) filter (where due_at < $1::timestamptz))::text as overdue, coalesce(sum(difference_vnd), 0)::text as difference
         from machvon.reconciliation_item where status in ('OPEN', 'EXPLAINED')`,
      [now.toISOString()],
    );
    const summary = { waiting: Number(row?.waiting ?? 0), overdue: Number(row?.overdue ?? 0), waitingDifferenceVnd: row?.difference ?? '0' };
    this.metrics.gauge(PAY_RECONCILIATION_OPEN_METRIC, summary.waiting);
    this.metrics.gauge(PAY_RECONCILIATION_OVERDUE_METRIC, summary.overdue);
    return summary;
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number, scope: ScopeBuilder, now: Date): Promise<ItemSql> {
    const found = await this.find(tx, scope, id, now);
    // An item outside the scope of the caller is an item that is not there.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [row] = await tx.query<ItemSql>(`select ${COLUMNS} ${FROM} where ri.id = $2::uuid for update of ri`, [now.toISOString(), found.id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private async viewOf(tx: TenantTx, id: string, now: Date): Promise<ReconciliationItemView> {
    const [row] = await tx.query<ItemSql>(`select ${COLUMNS} ${FROM} where ri.id = $2::uuid`, [now.toISOString(), id]);
    if (row === undefined) throw new Error('the item vanished after its change');
    return toView(row);
  }

  private badFilter(field: string): never {
    throw invalid(field);
  }

  /** What the database refused, in the words of the contract. */
  private mapRefusal(error: unknown): unknown {
    const failure = error as { code?: string; message?: string };
    if (failure.code !== CHECK_VIOLATION) return error;
    const message = failure.message ?? '';
    if (message.includes('RECONCILIATION_STATE_INVALID')) return new DomainError('RECONCILIATION_STATE_INVALID', 409, 'id');
    if (message.includes('reconciliation_item_write_off_chk')) return new DomainError('SELF_APPROVAL_DENIED', 403);
    return error;
  }
}

/** The issue that ISS opened for an item past its day is remembered on the item (the intake calls this in the transaction that opens it); the first one stays. */
export async function linkReconciliationIssue(tx: TenantTx, itemId: string, issueId: string): Promise<void> {
  await tx.query('update machvon.reconciliation_item set issue_id = $2::uuid where id = $1::uuid and issue_id is null', [itemId, issueId]);
}

export interface OverdueResult {
  /** Items reported in this pass: each asks ISS for one issue through its event. */
  reported: number;
  waiting: number;
  overdue: number;
}

/** The members of the issue intake's common contract for an item past its day: the item, a code that names it, the project and the contract. Nothing a person said. */
export function overdueEvent(
  item: { id: string; kind: string; projectId: string; contractId: string | null; ownerUnitId: string; dueAt: string; status: string },
  tenantId: string,
  now: Date,
): { aggregateType: string; aggregateId: string; aggregateVersion: number; type: string; schemaVersion: number; payload: Record<string, unknown>; eventKey: string } {
  return {
    aggregateType: RESOURCE_TYPE,
    aggregateId: item.id,
    aggregateVersion: 1,
    type: RECONCILIATION_OVERDUE_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      source_ref_id: item.id,
      reference_code: `RI-${item.id.slice(0, 8)}`,
      project_id: item.projectId,
      ...(item.contractId === null ? {} : { contract_id: item.contractId }),
      owner_unit_id: item.ownerUnitId,
      severity: 'MEDIUM',
      kind: item.kind,
      status: item.status,
      due_at: item.dueAt,
      occurred_at: now.toISOString(),
      source_module: 'PAY',
    },
    eventKey: `${RESOURCE_TYPE}:${item.id}:overdue`,
  };
}

/**
 * The job `reconciliation-overdue` (ST-PAY-007, PAY 3.3 step 5): an item that still waits and is past its day is reported once, with the event that the issue intake of ISS answers by opening one issue
 * (BR-ISS-07: not a second while that one is open), and the item remembers that it was reported, so a second pass, or a hundred, report nothing more. The pass takes the clock as an argument.
 */
export class PayReconciliationOverdueJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly store: PayReconciliationStore;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.store = new PayReconciliationStore(metrics);
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<OverdueResult> {
    const correlationId = randomUUID();
    const due = await tx.query<{ id: string; tenant_id: string; kind: string; project_id: string; contract_id: string | null; owner_unit_id: string; due_at: string; status: string }>(
      `select ri.id, ri.tenant_id::text as tenant_id, ri.kind, ri.project_id, ri.contract_id, p.owner_unit_id, to_char(ri.due_at at time zone 'UTC', ${ISO}) as due_at, ri.status
         from machvon.reconciliation_item ri join machvon.project p on p.tenant_id = ri.tenant_id and p.id = ri.project_id
        where ri.status in ('OPEN', 'EXPLAINED') and ri.due_at < $1::timestamptz and ri.overdue_flagged_at is null
        order by ri.due_at, ri.id
        for update of ri skip locked`,
      [now.toISOString()],
    );
    for (const item of due) {
      await tx.query('update machvon.reconciliation_item set overdue_flagged_at = $2::timestamptz where id = $1::uuid', [item.id, now.toISOString()]);
      await this.audit.recordInTx(tx, actor, {
        action: 'pay.reconciliation_overdue',
        resourceType: RESOURCE_TYPE,
        resourceId: item.id,
        classification: CLASSIFICATION,
        diff: { project_id: item.project_id, kind: item.kind, status: item.status, due_at: item.due_at },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(
        tx,
        { ...overdueEvent({ id: item.id, kind: item.kind, projectId: item.project_id, contractId: item.contract_id, ownerUnitId: item.owner_unit_id, dueAt: item.due_at, status: item.status }, item.tenant_id, now), correlationId },
      );
    }
    const summary = await this.store.refreshGauges(tx, now);
    return { reported: due.length, waiting: summary.waiting, overdue: summary.overdue };
  }
}
