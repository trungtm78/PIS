import { DocumentDistributionStore, OutgoingDocumentStore, OutgoingDraftStore } from '@machvon/db';
import type { OutgoingDocumentRecord, OutgoingStatus } from '@machvon/db';
import type { CommandScope } from '../../command-scope';

const OUTGOING_TYPE = 'outgoing_document';

/**
 * What the settlement of a document needs of the place it runs in: the transaction, who acts, and the outbox. A command passes its `CommandScope`; the job that follows the messages of the LGSP passes the same four
 * members for the worker.
 */
export type SettlementScope = Pick<CommandScope, 'tx' | 'tenant' | 'emit'>;

/**
 * Keeps the aggregate status of an outgoing document in line with its distributions (DOC.md F8, ST-DOC-010): the first row that is delivered (or acknowledged) moves the document from ISSUED to DELIVERED, and the
 * document is ACKNOWLEDGED when every recipient that had to acknowledge has. Both moves, and the events they send, happen in the transaction of whatever changed a row, once: the caller holds the lock on the document.
 */
export class DistributionSettlement {
  private readonly rows = new DocumentDistributionStore();
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();

  /** Moves the document to DELIVERED and to ACKNOWLEDGED when its rows say so, one event for each move. */
  async settle(scope: SettlementScope, document: OutgoingDocumentRecord, now: Date): Promise<OutgoingDocumentRecord> {
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

  private async announce(scope: SettlementScope, moved: OutgoingDocumentRecord, from: OutgoingStatus, type: 'doc.delivered.v1' | 'doc.acknowledged.v1', counts: Record<string, number>, now: Date): Promise<void> {
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
