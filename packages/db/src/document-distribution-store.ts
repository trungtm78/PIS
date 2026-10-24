import { DomainError, versionConflict } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type DistributionChannel = 'INTERNAL' | 'LGSP' | 'EMAIL' | 'PAPER_HANDOVER';
export type DistributionRecipientKind = 'INTERNAL_UNIT' | 'EXTERNAL_AGENCY' | 'PERSON';
export type DistributionStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'ACKNOWLEDGED' | 'FAILED' | 'CANCELLED';

/** One recipient of an issued document on one channel (`document_distribution`, DOC.md F8). */
export interface DistributionRecord {
  id: string;
  outgoingDocumentId: string;
  recipientKind: DistributionRecipientKind;
  recipientUnitId: string | null;
  recipientName: string;
  recipientCode: string | null;
  channel: DistributionChannel;
  status: DistributionStatus;
  acknowledgementRequired: boolean;
  sentAt: Date | null;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
  externalRef: string | null;
  attempts: number;
  errorCode: string | null;
  createdAt: Date;
  createdBy: string;
  version: number;
}

export interface NewDistribution {
  recipientKind: DistributionRecipientKind;
  recipientUnitId: string | null;
  recipientName: string;
  recipientCode: string | null;
  channel: DistributionChannel;
  acknowledgementRequired: boolean;
}

/** What the rows of one document add up to: the figures the aggregate status of the document is decided from. */
export interface DistributionTally {
  total: number;
  /** Rows the channel confirmed as delivered, or that were acknowledged (an acknowledgement implies the delivery). */
  reached: number;
  /** Rows that must be acknowledged, and how many of them have been. */
  required: number;
  requiredAcknowledged: number;
}

interface Row {
  id: string;
  outgoing_document_id: string;
  recipient_kind: DistributionRecipientKind;
  recipient_unit_id: string | null;
  recipient_name: string;
  recipient_code: string | null;
  channel: DistributionChannel;
  status: DistributionStatus;
  acknowledgement_required: boolean;
  sent_at: Date | null;
  delivered_at: Date | null;
  acknowledged_at: Date | null;
  external_ref: string | null;
  attempts: number;
  error_code: string | null;
  created_at: Date;
  created_by: string;
  version: string;
}

const COLUMNS = `d.id, d.outgoing_document_id, d.recipient_kind, d.recipient_unit_id, d.recipient_name, d.recipient_code, d.channel, d.status, d.acknowledgement_required,
  d.sent_at, d.delivered_at, d.acknowledged_at, d.external_ref, d.attempts, d.error_code, d.created_at, d.created_by, d.version::text as version`;

function toRecord(row: Row): DistributionRecord {
  return {
    id: row.id,
    outgoingDocumentId: row.outgoing_document_id,
    recipientKind: row.recipient_kind,
    recipientUnitId: row.recipient_unit_id,
    recipientName: row.recipient_name,
    recipientCode: row.recipient_code,
    channel: row.channel,
    status: row.status,
    acknowledgementRequired: row.acknowledgement_required,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
    externalRef: row.external_ref,
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at,
    createdBy: row.created_by,
    version: Number(row.version),
  };
}

/** What a channel did with one recipient on one attempt. */
export type DistributionOutcome =
  | { kind: 'SENT'; at: Date; externalRef?: string | undefined }
  | { kind: 'DELIVERED'; at: Date; externalRef?: string | undefined }
  | { kind: 'FAILED'; errorCode: string };

/**
 * The distribution of an issued outgoing document, one row per recipient and channel (ST-DOC-010, DOC.md F8). A row is written once: sending the same
 * recipient on the same channel again finds the row that is there and writes nothing (the unique indexes hold that, whatever the capitals of the name).
 * The state of a row moves along PENDING, SENT, DELIVERED, ACKNOWLEDGED, with FAILED and CANCELLED on the side; the trigger of V1223 holds the order.
 */
export class DocumentDistributionStore {
  /** The rows of a document in the order they were written. */
  async listFor(tx: TenantTx, outgoingDocumentId: string): Promise<DistributionRecord[]> {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.document_distribution d where d.outgoing_document_id = $1::uuid order by d.created_at, d.id`,
      [outgoingDocumentId],
    );
    return rows.map(toRecord);
  }

  async find(tx: TenantTx, id: string, options: { lock?: boolean } = {}): Promise<DistributionRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from machvon.document_distribution d where d.id = $1::uuid${options.lock === true ? ' for update of d' : ''}`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  async count(tx: TenantTx, outgoingDocumentId: string): Promise<number> {
    const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.document_distribution where outgoing_document_id = $1::uuid', [outgoingDocumentId]);
    return Number(row?.n ?? 0);
  }

  /**
   * Writes the row for a recipient on a channel, or returns the one that is already there (`created` says which). The insert is `ON CONFLICT DO NOTHING` on
   * every unique index, so two dispatches that race give one row and both are answered with it.
   */
  async insertIfAbsent(tx: TenantTx, outgoingDocumentId: string, input: NewDistribution, actor: string): Promise<{ record: DistributionRecord; created: boolean }> {
    const [inserted] = await tx.query<{ id: string }>(
      `insert into machvon.document_distribution
         (tenant_id, id, outgoing_document_id, recipient_kind, recipient_unit_id, recipient_name, recipient_code, channel, acknowledgement_required, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::uuid, $8::uuid)
       on conflict do nothing
       returning id`,
      [outgoingDocumentId, input.recipientKind, input.recipientUnitId, input.recipientName, input.recipientCode, input.channel, input.acknowledgementRequired, actor],
    );
    if (inserted !== undefined) return { record: await this.reload(tx, inserted.id), created: true };
    const [existing] = await tx.query<Row>(
      `select ${COLUMNS} from machvon.document_distribution d
        where d.outgoing_document_id = $1::uuid and lower(d.recipient_name) = lower($2) and d.channel = $3`,
      [outgoingDocumentId, input.recipientName, input.channel],
    );
    if (existing === undefined) throw new Error('a distribution that conflicted vanished');
    return { record: toRecord(existing), created: false };
  }

  /** Records what a channel did on an attempt: the row moves to SENT or DELIVERED, or to FAILED with the reason, and the attempt is counted. */
  async recordAttempt(tx: TenantTx, id: string, outcome: DistributionOutcome, actor: string): Promise<DistributionRecord> {
    const current = await this.find(tx, id, { lock: true });
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.status !== 'PENDING' && current.status !== 'FAILED') throw new DomainError('DISTRIBUTION_STATE_INVALID', 409);
    if (outcome.kind === 'FAILED') {
      await tx.query(
        `update machvon.document_distribution set status = 'FAILED', error_code = $2, attempts = attempts + 1, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
        [id, outcome.errorCode, actor],
      );
    } else {
      await tx.query(
        `update machvon.document_distribution
            set status = $2, error_code = null, attempts = attempts + 1, sent_at = $3::timestamptz,
                delivered_at = case when $2 = 'DELIVERED' then $3::timestamptz else delivered_at end,
                external_ref = coalesce($4, external_ref), updated_at = now(), updated_by = $5::uuid, version = version + 1
          where id = $1::uuid`,
        [id, outcome.kind, outcome.at.toISOString(), outcome.externalRef ?? null, actor],
      );
    }
    return this.reload(tx, id);
  }

  /**
   * The recipient confirmed the receipt (SENT or DELIVERED to ACKNOWLEDGED). A receipt implies the delivery, so a row that was only SENT is delivered at the
   * instant of the receipt. A stale version is 409 VERSION_CONFLICT, a row in another state 409 DISTRIBUTION_STATE_INVALID.
   */
  async acknowledge(tx: TenantTx, id: string, expectedVersion: number, input: { acknowledgedAt: Date; externalRef: string | null }, actor: string): Promise<DistributionRecord> {
    const current = await this.find(tx, id, { lock: true });
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'SENT' && current.status !== 'DELIVERED') throw new DomainError('DISTRIBUTION_STATE_INVALID', 409, 'status');
    if (current.sentAt !== null && input.acknowledgedAt < current.sentAt) throw new DomainError('VALIDATION_FAILED', 422, 'acknowledged_at');
    await tx.query(
      `update machvon.document_distribution
          set status = 'ACKNOWLEDGED', acknowledged_at = $2::timestamptz, delivered_at = coalesce(delivered_at, $2::timestamptz), external_ref = coalesce($3, external_ref),
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, input.acknowledgedAt.toISOString(), input.externalRef, actor],
    );
    return this.reload(tx, id);
  }

  /** The figures of one document that decide its aggregate status. */
  async tally(tx: TenantTx, outgoingDocumentId: string): Promise<DistributionTally> {
    const [row] = await tx.query<{ total: string; reached: string; required: string; required_acknowledged: string }>(
      `select count(*) filter (where status <> 'CANCELLED')::text as total,
              count(*) filter (where status in ('DELIVERED', 'ACKNOWLEDGED'))::text as reached,
              count(*) filter (where status <> 'CANCELLED' and acknowledgement_required)::text as required,
              count(*) filter (where status = 'ACKNOWLEDGED' and acknowledgement_required)::text as required_acknowledged
         from machvon.document_distribution where outgoing_document_id = $1::uuid`,
      [outgoingDocumentId],
    );
    return {
      total: Number(row?.total ?? 0),
      reached: Number(row?.reached ?? 0),
      required: Number(row?.required ?? 0),
      requiredAcknowledged: Number(row?.required_acknowledged ?? 0),
    };
  }

  private async reload(tx: TenantTx, id: string): Promise<DistributionRecord> {
    const found = await this.find(tx, id);
    if (found === undefined) throw new Error('a distribution vanished while it was locked');
    return found;
  }
}
