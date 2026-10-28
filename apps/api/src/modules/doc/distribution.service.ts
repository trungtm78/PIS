import { DocumentDistributionStore, DocumentStore, OutgoingDocumentStore, OutgoingDraftStore } from '@machvon/db';
import type { DistributionOutcome, DistributionRecord, OutgoingDocumentRecord, OutgoingStatus } from '@machvon/db';
import { DomainError, NOOP_METRICS, versionConflict } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import type { EmailChannelPort } from './distribution-channel';
import { MAX_DISTRIBUTIONS } from './distribution-rules';
import type { DispatchItem } from './distribution-rules';

const OUTGOING_TYPE = 'outgoing_document';
const DISTRIBUTION_TYPE = 'document_distribution';
const CLOCK_SKEW_MS = 5 * 60_000;

/** The states in which new recipients can be added: the document is out and nobody has yet confirmed it was received by all. */
const DISTRIBUTABLE: readonly OutgoingStatus[] = ['ISSUED', 'DELIVERED'];
/** The states in which a recipient can still be sent to again or acknowledge. */
// A document that has been filed (ST-DOC-013) is still delivered and acknowledged: its failed deliveries are tried again and its receipts recorded; its status stays FILED.
const TRACKABLE: readonly OutgoingStatus[] = ['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED'];

export interface DistributionChange {
  record: DistributionRecord;
  /** False when the recipient was already on this channel and nothing was written. */
  created: boolean;
}

interface SealedFile {
  versionId: string;
  fileSha256: string;
}

/** What a failed channel leaves in `error_code`: the code of the refusal when the adapter named one, otherwise a general one. */
function failureCode(error: unknown): string {
  return error instanceof DomainError && /^[A-Z][A-Z_]{2,59}$/.test(error.code) ? error.code : 'CHANNEL_ERROR';
}

/**
 * The distribution of an issued document to its recipients (ST-DOC-010, DOC.md F8). It writes one row per recipient and channel, asks the channel to send,
 * and keeps the aggregate status of the document in line with its rows: the first row that is delivered (or acknowledged) moves the document from ISSUED
 * to DELIVERED, and the document is ACKNOWLEDGED when every recipient that had to acknowledge has. Both moves, and the events they send, happen in the
 * transaction of the command that caused them, once: the document row is locked by the caller.
 *
 * Channels of the first release: INTERNAL puts the document in the inbox of a unit of this system (delivered at once), PAPER_HANDOVER records that the
 * clerk handed it over (sent; the signed receipt is the acknowledgement), EMAIL goes through the adapter that is bound (none yet: the row is FAILED with the
 * reason and can be sent again). A document is never reported as reaching someone it did not reach.
 */
export class DocumentDistributionService {
  private readonly rows = new DocumentDistributionStore();
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly documents = new DocumentStore();

  constructor(
    private readonly email: EmailChannelPort,
    private readonly metrics: MetricsSink = NOOP_METRICS,
  ) {}

  /** New recipients are taken while the document is out and nobody has confirmed that all received it (409 DOCUMENT_STATE_INVALID otherwise). */
  assertDistributable(document: OutgoingDocumentRecord): void {
    if (!DISTRIBUTABLE.includes(document.status)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
  }

  /** Writes the recipients that are not yet on their channel and sends to each of them; returns every row asked for and the document as it stands after. */
  async dispatch(scope: CommandScope, document: OutgoingDocumentRecord, items: readonly DispatchItem[], now: Date): Promise<{ changes: DistributionChange[]; document: OutgoingDocumentRecord }> {
    this.assertDistributable(document);
    const actor = scope.tenant.membershipId;
    const file = await this.sealedFile(scope, document);
    const changes: DistributionChange[] = [];
    let known = await this.rows.count(scope.tx, document.id);
    for (const item of items) {
      const placed = await this.rows.insertIfAbsent(
        scope.tx,
        document.id,
        {
          recipientKind: item.recipient.kind,
          recipientUnitId: item.recipient.unit_id ?? null,
          recipientName: item.recipient.name,
          recipientCode: item.recipient.code ?? null,
          channel: item.channel,
          acknowledgementRequired: item.acknowledgementRequired,
        },
        actor,
      );
      if (!placed.created) {
        changes.push(placed);
        continue;
      }
      known += 1;
      if (known > MAX_DISTRIBUTIONS) throw new DomainError('RECIPIENT_INVALID', 422, 'recipients', { extensions: { reason: 'TOO_MANY' } });
      changes.push({ record: await this.attempt(scope, document, placed.record, file, now), created: true });
    }
    const settled = await this.settle(scope, document, now);
    // Names of recipients can be those of persons: the audit row keeps the ids, the channel and the outcome, not who they are.
    await scope.audit({
      action: 'outgoing_document.distribute',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      diff: {
        requested: items.length,
        created: changes.filter((change) => change.created).length,
        existing: changes.filter((change) => !change.created).length,
        rows: changes.map((change) => ({ distribution_id: change.record.id, channel: change.record.channel, status: change.record.status, created: change.created })),
        document_status: settled.status,
      },
    });
    return { changes, document: settled };
  }

  /** Sends a failed row again: the same row, one more attempt. */
  async retry(scope: CommandScope, document: OutgoingDocumentRecord, distribution: DistributionRecord, expectedVersion: number, now: Date): Promise<{ record: DistributionRecord; document: OutgoingDocumentRecord }> {
    if (!TRACKABLE.includes(document.status)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    if (distribution.version !== expectedVersion) throw versionConflict(distribution.version);
    if (distribution.status !== 'FAILED') throw new DomainError('DISTRIBUTION_STATE_INVALID', 409, 'status');
    const record = await this.attempt(scope, document, distribution, await this.sealedFile(scope, document), now);
    const settled = await this.settle(scope, document, now);
    await scope.audit({
      action: 'document_distribution.retry',
      resourceType: DISTRIBUTION_TYPE,
      resourceId: record.id,
      diff: { outgoing_document_id: document.id, channel: record.channel, status: record.status, attempts: record.attempts, error_code: record.errorCode, document_status: settled.status },
    });
    return { record, document: settled };
  }

  /** Records the receipt of one recipient. */
  async acknowledge(
    scope: CommandScope,
    document: OutgoingDocumentRecord,
    distribution: DistributionRecord,
    expectedVersion: number,
    input: { acknowledgedAt: Date; externalRef: string | null },
    now: Date,
  ): Promise<{ record: DistributionRecord; document: OutgoingDocumentRecord }> {
    if (!TRACKABLE.includes(document.status)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    // A receipt typed on a clock that runs a little ahead of the server is accepted; one from the future is not.
    if (input.acknowledgedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) throw new DomainError('VALIDATION_FAILED', 422, 'acknowledged_at');
    const record = await this.rows.acknowledge(scope.tx, distribution.id, expectedVersion, input, scope.tenant.membershipId);
    this.metrics.increment('doc_distribution_total', { channel: record.channel.toLowerCase(), outcome: 'acknowledged' });
    const settled = await this.settle(scope, document, now);
    await scope.audit({
      action: 'document_distribution.acknowledge',
      resourceType: DISTRIBUTION_TYPE,
      resourceId: record.id,
      diff: { outgoing_document_id: document.id, channel: record.channel, acknowledged_at: input.acknowledgedAt.toISOString(), has_external_ref: input.externalRef !== null, document_status: settled.status },
    });
    return { record, document: settled };
  }

  private async attempt(scope: CommandScope, document: OutgoingDocumentRecord, row: DistributionRecord, file: SealedFile, now: Date): Promise<DistributionRecord> {
    const outcome = await this.send(document, row, file, now);
    const record = await this.rows.recordAttempt(scope.tx, row.id, outcome, scope.tenant.membershipId);
    this.metrics.increment('doc_distribution_total', { channel: record.channel.toLowerCase(), outcome: record.status.toLowerCase() });
    return record;
  }

  private async send(document: OutgoingDocumentRecord, row: DistributionRecord, file: SealedFile, now: Date): Promise<DistributionOutcome> {
    if (row.channel === 'INTERNAL') return { kind: 'DELIVERED', at: now };
    if (row.channel === 'PAPER_HANDOVER') return { kind: 'SENT', at: now };
    if (row.channel !== 'EMAIL') return { kind: 'FAILED', errorCode: 'CHANNEL_NOT_SUPPORTED' };
    try {
      const receipt = await this.email.send({
        outgoingDocumentId: document.id,
        distributionId: row.id,
        recipientName: row.recipientName,
        recipientCode: row.recipientCode,
        symbol: document.symbol ?? '',
        versionId: file.versionId,
        fileSha256: file.fileSha256,
      });
      return { kind: receipt.outcome, at: now, externalRef: receipt.externalRef };
    } catch (error) {
      return { kind: 'FAILED', errorCode: failureCode(error) };
    }
  }

  private async sealedFile(scope: CommandScope, document: OutgoingDocumentRecord): Promise<SealedFile> {
    const version = document.currentVersionId === null ? undefined : await this.documents.findVersion(scope.tx, document.currentVersionId);
    if (version === undefined) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'version');
    return { versionId: version.id, fileSha256: version.checksum };
  }

  /** Moves the document to DELIVERED and to ACKNOWLEDGED when its rows say so, one event for each move. */
  private async settle(scope: CommandScope, document: OutgoingDocumentRecord, now: Date): Promise<OutgoingDocumentRecord> {
    const actor = scope.tenant.membershipId;
    const tally = await this.rows.tally(scope.tx, document.id);
    let current = document;
    if (current.status === 'ISSUED' && tally.reached >= 1) {
      current = await this.outgoing.markDelivered(scope.tx, current.id, { expectedVersion: current.version, actor });
      await this.announce(scope, current, 'ISSUED', 'doc.delivered.v1', { delivered_count: tally.reached, recipient_count: tally.total }, now);
    }
    if (current.status === 'DELIVERED' && tally.required >= 1 && tally.requiredAcknowledged === tally.required) {
      current = await this.outgoing.markAcknowledged(scope.tx, current.id, { expectedVersion: current.version, actor });
      await this.announce(scope, current, 'DELIVERED', 'doc.acknowledged.v1', { acknowledged_count: tally.requiredAcknowledged, recipient_count: tally.total }, now);
    }
    return current;
  }

  private async announce(scope: CommandScope, moved: OutgoingDocumentRecord, from: OutgoingStatus, type: 'doc.delivered.v1' | 'doc.acknowledged.v1', counts: Record<string, number>, now: Date): Promise<void> {
    const actor = scope.tenant.membershipId;
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: moved.id,
      kind: moved.status,
      fromStatus: from,
      toStatus: moved.status,
      actor,
      documentVersion: moved.version,
      occurredAt: now,
      details: counts,
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: moved.id,
      aggregateVersion: moved.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        document_id: moved.documentId,
        outgoing_document_id: moved.id,
        version: moved.version,
        actor_id: actor,
        occurred_at: now.toISOString(),
        source_module: moved.sourceModule,
        source_ref: moved.sourceRef,
        payload_sha256: moved.payloadSha256,
        document_number: moved.documentNumber,
        symbol: moved.symbol,
        ...counts,
      },
      // One move, one event: a state is reached once.
      eventKey: `${OUTGOING_TYPE}:${moved.id}:${moved.status.toLowerCase()}`,
    });
  }
}
