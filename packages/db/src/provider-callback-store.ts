import { createHash } from 'node:crypto';
import { DomainError, NOOP_METRICS, UNCERTAIN_STATUS, inboxRetryDelaySeconds, reduceStatus, verifyProviderCallback } from '@machvon/kernel';
import type { MetricsSink, ProviderSignatureScheme, ProviderSigningKey, ReduceOutcome, StatusTable } from '@machvon/kernel';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

/** The most times an event is tried before it is parked as DEAD (the limit of integration_event_inbox.attempts). */
export const INBOX_MAX_ATTEMPTS = 10;
/** A reconciliation task is due a day after it opens. */
export const RECONCILIATION_DUE_SECONDS = 86_400;
/** Counter of callbacks that were verified but changed nothing, by provider and reason. */
export const CALLBACK_IGNORED_METRIC = 'provider_callback_ignored_total';
/** The event the outbox carries when a result is uncertain, so the module that owns the item can ask the provider. */
export const RESULT_UNCERTAIN_EVENT = 'provider.result_uncertain';

const MIN_NOTE = 10;
const MAX_NOTE = 2000;

export interface ProviderItemRef {
  provider: string;
  subjectType: string;
  subjectId: string;
}

export interface ProviderItem extends ProviderItemRef {
  id: string;
  status: string;
  version: number;
  lastEventId: string | null;
}

export interface ProviderHistoryRow {
  fromStatus: string | null;
  toStatus: string;
  cause: 'CREATED' | 'CALLBACK' | 'UNCERTAIN' | 'RECONCILED';
  inboxEventId: string | null;
  itemVersion: number;
}

export type ReconciliationReason = 'RESULT_UNCERTAIN' | 'STATUS_CONFLICT';

export interface ReconciliationTask {
  id: string;
  itemId: string;
  reason: ReconciliationReason;
  detail: string | null;
  dueAt: string;
}

export interface ReceiveCallbackInput {
  provider: string;
  /** The provider's id of the event: the dedupe key. */
  eventKey: string;
  eventType?: string;
  /** The body exactly as it arrived. */
  rawBody: Buffer;
  signature: string | undefined;
  /** Seconds since the epoch, as the provider states it. */
  timestampSeconds: number | undefined;
  keys: readonly ProviderSigningKey[];
  scheme?: ProviderSignatureScheme;
  replayWindowSeconds?: number;
  now?: () => number;
  channelAccountId?: string;
  /** Where the raw body is kept (an object storage reference); the inbox keeps the hash and this pointer, never the body. */
  payloadReference: string;
  metrics?: MetricsSink;
}

export interface ReceivedCallback {
  inboxId: string;
  /** True when the event was received before: nothing was written. */
  duplicate: boolean;
  /** True when the event was received before with a different body: the provider reused an id, which is never applied again. */
  payloadChanged: boolean;
  signatureKeyId: string;
}

export interface ApplyEventInput {
  inboxId: string;
  ref: ProviderItemRef;
  table: StatusTable;
  status: string;
  /** When the provider says it happened. It is kept as evidence and never decides the order: the status graph does. */
  occurredAt: Date;
  metrics?: MetricsSink;
}

export type ApplyOutcome = ReduceOutcome | 'ALREADY_PROCESSED';

export interface ApplyResult {
  outcome: ApplyOutcome;
  itemId: string;
  /** The status of the item after the event. */
  status: string;
  /** The task opened (or already open) because the event contradicted the item. */
  taskId: string | null;
}

export interface MarkUncertainInput {
  ref: ProviderItemRef;
  table: StatusTable;
  correlationId: string;
  detail?: string;
  now?: Date;
}

export interface MarkUncertainResult {
  outcome: ReduceOutcome;
  itemId: string;
  taskId: string | null;
}

export interface ResolveTaskInput {
  taskId: string;
  table: StatusTable;
  /** The status the provider is found to hold. */
  status: string;
  note: string;
  resolvedBy: string;
}

interface ItemSql {
  id: string;
  provider: string;
  subject_type: string;
  subject_id: string;
  status: string;
  version: string;
  last_event_id: string | null;
}

const ITEM_SELECT = 'select id, provider, subject_type, subject_id, status, version::text as version, last_event_id from machvon.provider_status_item';

const toItem = (row: ItemSql): ProviderItem => ({
  id: row.id,
  provider: row.provider,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  status: row.status,
  version: Number(row.version),
  lastEventId: row.last_event_id,
});

const IGNORED_CODE: Readonly<Partial<Record<ReduceOutcome, string>>> = {
  DUPLICATE: 'STATUS_DUPLICATE',
  STALE: 'STATUS_STALE',
  CONFLICT: 'STATUS_CONFLICT',
  UNKNOWN_STATUS: 'STATUS_UNKNOWN',
};

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/**
 * Provider callbacks, end to end (ST-KERNEL-071): the signature and the replay window are checked on the raw body before anything is
 * written; the event is written once to the inbox, keyed by provider and event id; its status is applied to a tracked item by a reducer
 * that never moves a status backwards; and a result the provider may have acted on but never confirmed becomes UNCERTAIN with a
 * reconciliation task and an outbox event, never a retried side effect. Every method runs in the caller's tenant transaction, and the
 * tenant is the one of that transaction: the payload is never trusted for it.
 */
export class ProviderCallbackStore {
  /**
   * Verifies the callback and records it in the inbox. A bad signature or a stale timestamp throws 401 before any statement runs, so it
   * leaves no row. A callback received before writes nothing and reports `duplicate`, so the caller answers 200 without applying it again.
   */
  async receive(tx: TenantTx, input: ReceiveCallbackInput): Promise<ReceivedCallback> {
    const metrics = input.metrics ?? NOOP_METRICS;
    const { keyId } = verifyProviderCallback({
      provider: input.provider,
      rawBody: input.rawBody,
      signature: input.signature,
      timestampSeconds: input.timestampSeconds,
      keys: input.keys,
      ...(input.scheme === undefined ? {} : { scheme: input.scheme }),
      ...(input.replayWindowSeconds === undefined ? {} : { replayWindowSeconds: input.replayWindowSeconds }),
      ...(input.now === undefined ? {} : { now: input.now }),
      metrics,
    });
    const payloadHash = createHash('sha256').update(input.rawBody).digest('hex');
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.integration_event_inbox
         (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id,
          provider_event_type, channel_account_id, provider_timestamp)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4, now(), 'RECEIVED', $5, $6, $7::uuid, to_timestamp($8))
       on conflict (tenant_id, provider, event_key) do nothing
       returning id`,
      [input.provider, input.eventKey, payloadHash, input.payloadReference, keyId, input.eventType ?? null, input.channelAccountId ?? null, input.timestampSeconds],
    );
    const created = inserted[0];
    if (created !== undefined) return { inboxId: created.id, duplicate: false, payloadChanged: false, signatureKeyId: keyId };
    const [existing] = await tx.query<{ id: string; payload_hash: string }>(
      'select id, payload_hash from machvon.integration_event_inbox where provider = $1 and event_key = $2',
      [input.provider, input.eventKey],
    );
    if (existing === undefined) throw new Error('inbox event vanished after a key conflict');
    const payloadChanged = existing.payload_hash !== payloadHash;
    if (payloadChanged) metrics.increment(CALLBACK_IGNORED_METRIC, { provider: input.provider, reason: 'PAYLOAD_CHANGED' });
    return { inboxId: existing.id, duplicate: true, payloadChanged, signatureKeyId: keyId };
  }

  /** Starts tracking a thing at one of the initial statuses of its table. A second call returns the item as it is. */
  async track(tx: TenantTx, ref: ProviderItemRef, table: StatusTable, initialStatus: string = table.initial[0] ?? ''): Promise<ProviderItem> {
    if (!table.initial.includes(initialStatus)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const inserted = await tx.query<ItemSql>(
      `insert into machvon.provider_status_item (tenant_id, id, provider, subject_type, subject_id, status)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3::uuid, $4)
       on conflict (tenant_id, provider, subject_type, subject_id) do nothing
       returning id, provider, subject_type, subject_id, status, version::text as version, last_event_id`,
      [ref.provider, ref.subjectType, ref.subjectId, initialStatus],
    );
    const created = inserted[0];
    if (created === undefined) return this.lockItem(tx, ref);
    await this.writeHistory(tx, { itemId: created.id, version: 1, from: null, to: initialStatus, cause: 'CREATED', inboxEventId: null, occurredAt: new Date() });
    return toItem(created);
  }

  async find(tx: TenantTx, ref: ProviderItemRef): Promise<ProviderItem | undefined> {
    const rows = await tx.query<ItemSql>(`${ITEM_SELECT} where provider = $1 and subject_type = $2 and subject_id = $3::uuid`, [
      ref.provider,
      ref.subjectType,
      ref.subjectId,
    ]);
    return rows[0] === undefined ? undefined : toItem(rows[0]);
  }

  async history(tx: TenantTx, itemId: string): Promise<ProviderHistoryRow[]> {
    const rows = await tx.query<{ from_status: string | null; to_status: string; cause: ProviderHistoryRow['cause']; inbox_event_id: string | null; item_version: string }>(
      'select from_status, to_status, cause, inbox_event_id, item_version::text as item_version from machvon.provider_status_history where item_id = $1::uuid order by item_version',
      [itemId],
    );
    return rows.map((row) => ({ fromStatus: row.from_status, toStatus: row.to_status, cause: row.cause, inboxEventId: row.inbox_event_id, itemVersion: Number(row.item_version) }));
  }

  /**
   * Applies the status of a received event to its item. Only a status later than the current one moves the item and adds a history row;
   * a repeat, a late event and an unknown status change nothing and are recorded on the inbox row (error_code) and in the ignored
   * counter; an event that contradicts the item (FAILED after DELIVERED) also opens a reconciliation task. An event already processed is
   * not applied twice. An item that is not tracked yet throws 404: in one transaction with `receive` this rolls the inbox row back, so the
   * provider's retry arrives to a tracked item.
   */
  async applyEvent(tx: TenantTx, input: ApplyEventInput): Promise<ApplyResult> {
    const metrics = input.metrics ?? NOOP_METRICS;
    const [inbox] = await tx.query<{ status: string }>('select status from machvon.integration_event_inbox where id = $1::uuid for update', [input.inboxId]);
    if (inbox === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const item = await this.lockItem(tx, input.ref);
    if (inbox.status === 'PROCESSED') return { outcome: 'ALREADY_PROCESSED', itemId: item.id, status: item.status, taskId: null };
    const outcome = reduceStatus(input.table, item.status, input.status);
    let status = item.status;
    let taskId: string | null = null;
    if (outcome === 'APPLIED') {
      status = input.status;
      await this.moveItem(tx, item, { to: status, cause: 'CALLBACK', inboxEventId: input.inboxId, occurredAt: input.occurredAt });
    } else if (outcome === 'CONFLICT') {
      taskId = await this.openTask(tx, item.id, 'STATUS_CONFLICT', `${item.status} then ${input.status}`, new Date());
    }
    if (outcome === 'STALE' || outcome === 'CONFLICT' || outcome === 'UNKNOWN_STATUS') {
      metrics.increment(CALLBACK_IGNORED_METRIC, { provider: input.ref.provider, reason: outcome });
    }
    await tx.query(
      "update machvon.integration_event_inbox set status = 'PROCESSED', processed_at = now(), error_code = $2, next_attempt_at = null where id = $1::uuid",
      [input.inboxId, IGNORED_CODE[outcome] ?? null],
    );
    return { outcome, itemId: item.id, status, taskId };
  }

  /**
   * Records that the provider may have acted on a request but its answer was lost (a timeout, a crash after the provider accepted):
   * the item moves to UNCERTAIN, a reconciliation task opens and the outbox carries `provider.result_uncertain` for the module that
   * owns the item. The request is not repeated: a second send could be a second effect. A later callback resolves the item through
   * `applyEvent`; a person resolves it through `resolveTask`.
   */
  async markUncertain(tx: TenantTx, input: MarkUncertainInput): Promise<MarkUncertainResult> {
    if (!input.table.statuses.includes(UNCERTAIN_STATUS)) throw new Error(`status table ${input.table.name} has no ${UNCERTAIN_STATUS} status`);
    const item = await this.lockItem(tx, input.ref);
    const outcome = reduceStatus(input.table, item.status, UNCERTAIN_STATUS);
    if (outcome === 'DUPLICATE') return { outcome, itemId: item.id, taskId: await this.openTask(tx, item.id, 'RESULT_UNCERTAIN', input.detail ?? null, input.now ?? new Date()) };
    if (outcome !== 'APPLIED') return { outcome, itemId: item.id, taskId: null };
    const version = await this.moveItem(tx, item, { to: UNCERTAIN_STATUS, cause: 'UNCERTAIN', inboxEventId: null, occurredAt: input.now ?? new Date() });
    const taskId = await this.openTask(tx, item.id, 'RESULT_UNCERTAIN', input.detail ?? null, input.now ?? new Date());
    await enqueueOutbox(tx, {
      aggregateType: 'provider_status_item',
      aggregateId: item.id,
      aggregateVersion: version,
      type: RESULT_UNCERTAIN_EVENT,
      schemaVersion: 1,
      payload: { provider: item.provider, subject_type: item.subjectType, subject_id: item.subjectId, task_id: taskId },
      eventKey: `provider-uncertain:${item.id}:${version}`,
      correlationId: input.correlationId,
    });
    return { outcome, itemId: item.id, taskId };
  }

  /** The open tasks, the longest overdue first. */
  async openTasks(tx: TenantTx, limit: number): Promise<ReconciliationTask[]> {
    const rows = await tx.query<{ id: string; item_id: string; reason: ReconciliationReason; detail: string | null; due_at: string }>(
      `select id, item_id, reason, detail, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due_at
         from machvon.provider_reconciliation_task where status = 'OPEN' order by due_at, id limit $1`,
      [limit],
    );
    return rows.map((row) => ({ id: row.id, itemId: row.item_id, reason: row.reason, detail: row.detail, dueAt: row.due_at }));
  }

  /**
   * Closes a task with what a person found at the provider. The item moves to that status when it is later than the one it holds and
   * stays when it is the same; a status that would take it backwards, or sideways, is refused with 409 STAGE_TRANSITION_DENIED, as is a
   * task already closed.
   */
  async resolveTask(tx: TenantTx, input: ResolveTaskInput): Promise<{ itemId: string; status: string }> {
    const note = input.note.trim();
    if (note.length < MIN_NOTE || note.length > MAX_NOTE) throw new DomainError('VALIDATION_FAILED', 422, 'resolution_note');
    const [task] = await tx.query<{ item_id: string; reason: ReconciliationReason; status: string }>(
      'select item_id, reason, status from machvon.provider_reconciliation_task where id = $1::uuid for update',
      [input.taskId],
    );
    if (task === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (task.status !== 'OPEN') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const [row] = await tx.query<ItemSql>(`${ITEM_SELECT} where id = $1::uuid for update`, [task.item_id]);
    if (row === undefined) throw new Error('reconciliation task without its item');
    const item = toItem(row);
    // A result found at the provider is a status the provider holds: "still unknown" resolves nothing.
    if (input.status === UNCERTAIN_STATUS) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const outcome = reduceStatus(input.table, item.status, input.status);
    if (outcome === 'UNKNOWN_STATUS') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (outcome === 'STALE' || outcome === 'CONFLICT') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    let status = item.status;
    if (outcome === 'APPLIED') {
      status = input.status;
      await this.moveItem(tx, item, { to: status, cause: 'RECONCILED', inboxEventId: null, occurredAt: new Date() });
    }
    await tx.query(
      `update machvon.provider_reconciliation_task
          set status = 'RESOLVED', resolved_status = $2, resolved_by = $3::uuid, resolved_at = now(), resolution_note = $4
        where id = $1::uuid`,
      [input.taskId, status, input.resolvedBy, note],
    );
    return { itemId: item.id, status };
  }

  /**
   * Puts an event that failed to apply back for another try, after a wait of 1, 5 and then 30 minutes (`inboxRetryDelaySeconds`), and parks it
   * as DEAD after the last attempt.
   * Returns the status it now has.
   */
  async failEvent(tx: TenantTx, inboxId: string, errorCode: string): Promise<'FAILED' | 'DEAD'> {
    const [row] = await tx.query<{ attempts: number; status: string }>('select attempts, status from machvon.integration_event_inbox where id = $1::uuid for update', [inboxId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status === 'PROCESSED' || row.status === 'DEAD') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const attempts = row.attempts + 1;
    const status = attempts >= INBOX_MAX_ATTEMPTS ? 'DEAD' : 'FAILED';
    await tx.query(
      "update machvon.integration_event_inbox set attempts = $2, status = $3, error_code = $4, next_attempt_at = now() + make_interval(secs => $5) where id = $1::uuid",
      [inboxId, attempts, status, errorCode, inboxRetryDelaySeconds(attempts)],
    );
    return status;
  }

  private async lockItem(tx: TenantTx, ref: ProviderItemRef): Promise<ProviderItem> {
    const rows = await tx.query<ItemSql>(`${ITEM_SELECT} where provider = $1 and subject_type = $2 and subject_id = $3::uuid for update`, [
      ref.provider,
      ref.subjectType,
      ref.subjectId,
    ]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toItem(rows[0]);
  }

  /** Moves a locked item to a later status, writes the history row and returns the new version. */
  private async moveItem(
    tx: TenantTx,
    item: ProviderItem,
    change: { to: string; cause: ProviderHistoryRow['cause']; inboxEventId: string | null; occurredAt: Date },
  ): Promise<number> {
    const version = item.version + 1;
    await tx.query(
      `update machvon.provider_status_item
          set status = $2, version = $3, last_event_id = coalesce($4::uuid, last_event_id), last_event_at = $5::timestamptz, updated_at = now()
        where id = $1::uuid`,
      [item.id, change.to, version, change.inboxEventId, change.occurredAt.toISOString()],
    );
    await this.writeHistory(tx, { itemId: item.id, version, from: item.status, ...change });
    return version;
  }

  private async writeHistory(
    tx: TenantTx,
    row: { itemId: string; version: number; from: string | null; to: string; cause: ProviderHistoryRow['cause']; inboxEventId: string | null; occurredAt: Date },
  ): Promise<void> {
    await tx.query(
      `insert into machvon.provider_status_history (tenant_id, id, item_id, item_version, from_status, to_status, cause, inbox_event_id, occurred_at)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid, $7::timestamptz)`,
      [row.itemId, row.version, row.from, row.to, row.cause, row.inboxEventId, row.occurredAt.toISOString()],
    );
  }

  /** Opens a task for the item, or returns the one already open for the same reason. */
  private async openTask(tx: TenantTx, itemId: string, reason: ReconciliationReason, detail: string | null, now: Date): Promise<string> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.provider_reconciliation_task (tenant_id, id, item_id, reason, detail, opened_at, due_at)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4::timestamptz, $4::timestamptz + make_interval(secs => $5))
       on conflict (tenant_id, item_id, reason) where status = 'OPEN' do nothing
       returning id`,
      [itemId, reason, detail, now.toISOString(), RECONCILIATION_DUE_SECONDS],
    );
    if (inserted[0] !== undefined) return inserted[0].id;
    const [open] = await tx.query<{ id: string }>(
      "select id from machvon.provider_reconciliation_task where item_id = $1::uuid and reason = $2 and status = 'OPEN'",
      [itemId, reason],
    );
    if (open === undefined) throw new Error('reconciliation task vanished after a key conflict');
    return open.id;
  }
}
