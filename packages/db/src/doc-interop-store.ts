import { DomainError, assertInteropEvent, assertRetryable, versionConflict } from '@machvon/kernel';
import type { FailurePlan, InteropAdapterStatus, InteropDirection, InteropStatus } from '@machvon/kernel';
import { TIMESTAMP } from './ctr-contract-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

/** One message of the interoperability of documents (`doc_interop_message`, DOC.md F13), as the monitor and the sender read it. */
export interface InteropRecord {
  id: string;
  direction: InteropDirection;
  status: InteropStatus;
  adapterCode: string;
  adapterStatus: InteropAdapterStatus;
  externalMessageId: string | null;
  senderCode: string | null;
  receiverCode: string | null;
  envelopeSha256: string;
  envelopeObjectKey: string;
  /** The document the message carries: the issued one that leaves, the one made from what arrived. */
  documentId: string | null;
  distributionId: string | null;
  /** The outgoing document of the distribution a message that leaves belongs to. */
  outgoingDocumentId: string | null;
  /** The incoming letter made from a message that arrived. */
  incomingDocumentId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface NewOutboundMessage {
  /** The id of the message, chosen by the caller because the envelope carries it. */
  id: string;
  documentId: string;
  distributionId: string;
  adapterCode: string;
  adapterStatus: InteropAdapterStatus;
  /** The code of the agency that sends, when the connector says it. */
  senderCode: string | null;
  receiverCode: string;
  envelopeSha256: string;
  envelopeObjectKey: string;
}

export interface NewInboundMessage {
  adapterCode: string;
  adapterStatus: InteropAdapterStatus;
  externalMessageId: string;
  senderCode: string;
  envelopeSha256: string;
  envelopeObjectKey: string;
}

export interface InteropFilters {
  status?: InteropStatus | undefined;
  direction?: InteropDirection | undefined;
}

export interface InteropPageAnchor {
  code: string;
  id: string;
}

interface Row {
  id: string;
  direction: InteropDirection;
  status: InteropStatus;
  adapter_code: string;
  adapter_status: InteropAdapterStatus;
  external_message_id: string | null;
  sender_code: string | null;
  receiver_code: string | null;
  envelope_sha256: string;
  envelope_object_key: string;
  document_id: string | null;
  distribution_id: string | null;
  outgoing_document_id: string | null;
  incoming_document_id: string | null;
  attempts: number;
  next_attempt_at: string | null;
  error_code: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
  version: string;
  sort_key: string;
}

const FROM = `machvon.doc_interop_message m
  left join machvon.document_distribution d on d.tenant_id = m.tenant_id and d.id = m.distribution_id
  left join machvon.incoming_document i on i.tenant_id = m.tenant_id and i.interop_message_id = m.id`;

const COLUMNS = `m.id, m.direction, m.status, m.adapter_code, m.adapter_status, m.external_message_id, m.sender_code, m.receiver_code, trim(m.envelope_sha256) as envelope_sha256, m.envelope_object_key,
  m.document_id, m.distribution_id, d.outgoing_document_id, i.id as incoming_document_id, m.attempts, ${TIMESTAMP('m.next_attempt_at')} as next_attempt_at, m.error_code,
  ${TIMESTAMP('m.processed_at')} as processed_at, ${TIMESTAMP('m.created_at')} as created_at, ${TIMESTAMP('m.updated_at')} as updated_at, m.version::text as version,
  to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key`;

const toRecord = (row: Row): InteropRecord => ({
  id: row.id,
  direction: row.direction,
  status: row.status,
  adapterCode: row.adapter_code,
  adapterStatus: row.adapter_status,
  externalMessageId: row.external_message_id,
  senderCode: row.sender_code,
  receiverCode: row.receiver_code,
  envelopeSha256: row.envelope_sha256,
  envelopeObjectKey: row.envelope_object_key,
  documentId: row.document_id,
  distributionId: row.distribution_id,
  outgoingDocumentId: row.outgoing_document_id,
  incomingDocumentId: row.incoming_document_id,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  errorCode: row.error_code,
  processedAt: row.processed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: Number(row.version),
});

/**
 * The table gateway of the interoperability messages (ST-DOC-021, DOC.md F13). Every write moves a message along the edges of the kernel (QUEUED, SENT, ACKED or REJECTED, FAILED and back to QUEUED, DEAD; RECEIVED
 * and PROCESSED for what arrives) and the database says the same (trigger `doc_interop_message_guard`). A message that leaves is written once for each distribution; one that arrives is written once for each envelope digest
 * and once for each id the sender gave it. Whether a caller may read or send again is the business of the controller; the job that sends runs for the tenant of the transaction.
 */
export class DocInteropStore {
  async find(tx: TenantTx, id: string): Promise<InteropRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where m.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The message locked for a change. */
  async lock(tx: TenantTx, id: string): Promise<InteropRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where m.id = $1::uuid for update of m`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The messages for the monitor, the latest first; the cursor is the moment the message was written and its id. */
  async list(tx: TenantTx, filters: InteropFilters, page: { limit: number; after?: InteropPageAnchor | undefined }): Promise<{ records: InteropRecord[]; next: InteropPageAnchor | undefined }> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ($1::text is null or m.status = $1) and ($2::text is null or m.direction = $2)
          and ($3::timestamptz is null or (m.created_at, m.id) < ($3::timestamptz, $4::uuid))
        order by m.created_at desc, m.id desc limit $5::int`,
      [filters.status ?? null, filters.direction ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toRecord), next: rows.length > page.limit && last !== undefined ? { code: last.sort_key, id: last.id } : undefined };
  }

  /** How many messages failed or died: the figure of the overview and the gauge of the alert. */
  async countByStatus(tx: TenantTx, statuses: readonly InteropStatus[]): Promise<number> {
    const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.doc_interop_message where status = any($1::text[])', [statuses]);
    return Number(row?.n ?? 0);
  }

  /**
   * Writes the message that leaves for a distribution, QUEUED, or returns the one that is there (`created` says which): sending a distribution again is the same message. The envelope is stored by the caller under
   * a key that holds its digest.
   */
  async insertOutbound(tx: TenantTx, input: NewOutboundMessage, actor: string): Promise<{ record: InteropRecord; created: boolean }> {
    const [inserted] = await tx.query<{ id: string }>(
      `insert into machvon.doc_interop_message
         (tenant_id, id, direction, document_id, distribution_id, adapter_code, adapter_status, sender_code, receiver_code, envelope_sha256, envelope_object_key, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $10::uuid, 'OUTBOUND', $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid, $9::uuid)
       on conflict do nothing
       returning id`,
      [input.documentId, input.distributionId, input.adapterCode, input.adapterStatus, input.senderCode, input.receiverCode, input.envelopeSha256, input.envelopeObjectKey, actor, input.id],
    );
    const id = inserted?.id ?? (await this.idOfDistribution(tx, input.distributionId));
    return { record: await this.reload(tx, id), created: inserted !== undefined };
  }

  /**
   * Writes the message that arrived, RECEIVED, or says which one is there already: an envelope digest seen before, or an id the sender gave before, is a message that came again (`created` false, the record is the
   * first). Two deliveries that race give one row: the second waits for the first on the unique index and finds it.
   */
  async insertInbound(tx: TenantTx, input: NewInboundMessage, actor: string): Promise<{ record: InteropRecord; created: boolean }> {
    const [inserted] = await tx.query<{ id: string }>(
      `insert into machvon.doc_interop_message
         (tenant_id, id, direction, status, adapter_code, adapter_status, external_message_id, sender_code, envelope_sha256, envelope_object_key, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'INBOUND', 'RECEIVED', $1, $2, $3, $4, $5, $6, $7::uuid, $7::uuid)
       on conflict do nothing
       returning id`,
      [input.adapterCode, input.adapterStatus, input.externalMessageId, input.senderCode, input.envelopeSha256, input.envelopeObjectKey, actor],
    );
    if (inserted !== undefined) return { record: await this.reload(tx, inserted.id), created: true };
    const [existing] = await tx.query<{ id: string }>(
      "select id from machvon.doc_interop_message where direction = 'INBOUND' and (envelope_sha256 = $1 or external_message_id = $2) order by created_at, id limit 1",
      [input.envelopeSha256, input.externalMessageId],
    );
    if (existing === undefined) throw new Error('an inbound message that conflicted vanished');
    return { record: await this.reload(tx, existing.id), created: false };
  }

  /** Messages that leave and are due: queued, or failed with the wait over, the oldest due first. They are locked for the transaction, and those another job holds are left alone. */
  async dueForAttempt(tx: TenantTx, now: Date, limit: number): Promise<InteropRecord[]> {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where m.direction = 'OUTBOUND' and (m.status = 'QUEUED' or (m.status = 'FAILED' and m.next_attempt_at <= $1::timestamptz))
        order by coalesce(m.next_attempt_at, m.created_at), m.id limit $2::int for update of m skip locked`,
      [now.toISOString(), limit],
    );
    return rows.map(toRecord);
  }

  /** Messages the adapter took and the receiving agency has not answered, the longest waiting first; locked like the due ones. */
  async awaitingReceipt(tx: TenantTx, limit: number): Promise<InteropRecord[]> {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM} where m.direction = 'OUTBOUND' and m.status = 'SENT' order by m.updated_at, m.id limit $1::int for update of m skip locked`,
      [limit],
    );
    return rows.map(toRecord);
  }

  /** The wait is over: the failed message is due again. */
  async requeue(tx: TenantTx, record: InteropRecord, actor: string): Promise<InteropRecord> {
    assertInteropEvent('requeue', record.direction, record.status);
    return this.move(tx, record.id, 'FAILED', "status = 'QUEUED', next_attempt_at = null", [], actor);
  }

  /** The adapter took the message on its next attempt: it is SENT with the id the LGSP gave it, and the attempt is counted. */
  async markSent(tx: TenantTx, record: InteropRecord, input: { externalMessageId: string; adapterStatus: InteropAdapterStatus }, actor: string): Promise<InteropRecord> {
    assertInteropEvent('send', record.direction, record.status);
    return this.move(tx, record.id, 'QUEUED', "status = 'SENT', attempts = attempts + 1, external_message_id = $2, adapter_status = $3, error_code = null, next_attempt_at = null", [input.externalMessageId, input.adapterStatus], actor);
  }

  /** The attempt failed: the message waits for the next one with the reason, or is DEAD when the attempts are spent (the plan says which). */
  async markFailed(tx: TenantTx, record: InteropRecord, plan: FailurePlan, input: { errorCode: string; adapterStatus: InteropAdapterStatus }, actor: string): Promise<InteropRecord> {
    assertInteropEvent('fail', record.direction, record.status);
    return this.move(tx, record.id, 'QUEUED', 'status = $2, attempts = $3::int, next_attempt_at = $4::timestamptz, error_code = $5, adapter_status = $6', [plan.status, plan.attempts, plan.nextAttemptAt?.toISOString() ?? null, input.errorCode, input.adapterStatus], actor);
  }

  /** The distributions were called off (the recall of the document): the messages of them that did not leave end as refused. Returns the messages it ended. */
  async cancelOfDistributions(tx: TenantTx, distributionIds: readonly string[], at: Date, actor: string): Promise<InteropRecord[]> {
    if (distributionIds.length === 0) return [];
    const ended = await tx.query<{ id: string }>(
      `update machvon.doc_interop_message
          set status = 'REJECTED', error_code = 'DISTRIBUTION_CANCELLED', next_attempt_at = null, processed_at = $2::timestamptz, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where distribution_id = any($1::uuid[]) and status in ('QUEUED', 'FAILED') returning id`,
      [distributionIds, at.toISOString(), actor],
    );
    const records: InteropRecord[] = [];
    for (const { id } of ended) records.push(await this.reload(tx, id));
    return records;
  }

  /** The receiving agency confirmed what the adapter handed over. */
  async markAcknowledged(tx: TenantTx, record: InteropRecord, at: Date, actor: string): Promise<InteropRecord> {
    assertInteropEvent('acknowledge', record.direction, record.status);
    return this.move(tx, record.id, 'SENT', "status = 'ACKED', processed_at = $2::timestamptz", [at.toISOString()], actor);
  }

  /** The receiving agency refused it, with the code of the reason. */
  async markRejected(tx: TenantTx, record: InteropRecord, input: { errorCode: string; at: Date }, actor: string): Promise<InteropRecord> {
    assertInteropEvent('reject', record.direction, record.status);
    return this.move(tx, record.id, 'SENT', "status = 'REJECTED', error_code = $2, processed_at = $3::timestamptz", [input.errorCode, input.at.toISOString()], actor);
  }

  /** What arrived was made into the document and the letter it carries. */
  async markProcessed(tx: TenantTx, record: InteropRecord, input: { documentId: string; at: Date }, actor: string): Promise<InteropRecord> {
    assertInteropEvent('process', record.direction, record.status);
    return this.move(tx, record.id, 'RECEIVED', "status = 'PROCESSED', document_id = $2::uuid, processed_at = $3::timestamptz", [input.documentId, input.at.toISOString()], actor);
  }

  /**
   * A person asks for a failed or dead message to be sent again, at the version they saw: it is QUEUED and the job takes it. A dead message starts over with a fresh count of attempts (the history is in the audit
   * trail); a failed one keeps its count, so the twenty attempts are still the bound. A stale version is 409 VERSION_CONFLICT, a message that is neither failed nor dead 409 INTEROP_STATE_INVALID.
   */
  async retry(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ before: InteropRecord; record: InteropRecord }> {
    const before = await this.lock(tx, id);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    assertRetryable(before.direction, before.status);
    const record = await this.move(tx, id, before.status, "status = 'QUEUED', next_attempt_at = null, attempts = case when status = 'DEAD' then 0 else attempts end", [], actor);
    return { before, record };
  }

  private async idOfDistribution(tx: TenantTx, distributionId: string): Promise<string> {
    const [row] = await tx.query<{ id: string }>('select id from machvon.doc_interop_message where distribution_id = $1::uuid', [distributionId]);
    if (row === undefined) throw new Error('a message that conflicted vanished');
    return row.id;
  }

  /** One update of a message that must still be in the status it was read in; `$1` is the id and the parameters of the assignment start at `$2`, the actor follows them. */
  private async move(tx: TenantTx, id: string, from: InteropStatus, assignment: string, params: readonly unknown[], actor: string): Promise<InteropRecord> {
    const actorIndex = params.length + 3;
    const [moved] = await tx.query<{ id: string }>(
      `update machvon.doc_interop_message set ${assignment}, updated_at = now(), updated_by = $${actorIndex}::uuid, version = version + 1 where id = $1::uuid and status = $${actorIndex - 1} returning id`,
      [id, ...params, from, actor],
    );
    if (moved === undefined) throw new DomainError('INTEROP_STATE_INVALID', 409, 'status');
    return this.reload(tx, id);
  }

  private async reload(tx: TenantTx, id: string): Promise<InteropRecord> {
    const found = await this.find(tx, id);
    if (found === undefined) throw new Error('an interoperability message vanished while it was locked');
    return found;
  }
}
