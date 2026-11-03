import { DomainError, isInForce } from '@machvon/kernel';
import { DocIssueRequestStore } from './doc-issue-request-store.ts';
import { DocInteropStore } from './doc-interop-store.ts';
import { DocumentDistributionStore } from './document-distribution-store.ts';
import type { DistributionRecord } from './document-distribution-store.ts';
import { NumberRegisterStore } from './number-register-store.ts';
import type { RegisterEntry } from './number-register-store.ts';
import { OutgoingDocumentStore } from './outgoing-document-store.ts';
import type { OutgoingDocumentRecord, OutgoingStatus } from './outgoing-document-store.ts';
import { OutgoingDraftStore } from './outgoing-draft-store.ts';
import type { CancelledSession } from './outgoing-draft-store.ts';
import type { TenantTx } from './tenant-database.ts';

/** The states of a document in force: only these can be recalled (DOC.md F9). */
export const RECALLABLE_STATUSES: readonly OutgoingStatus[] = ['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED', 'CORRECTED'];
/** The states in which a document has its number and cannot be sealed any more: the number is voided and the document ends (DOC.md F6). */
export const VOIDABLE_STATUSES: readonly OutgoingStatus[] = ['NUMBERED', 'SEALED'];

export interface RecallInput {
  reason: string;
  /** The document that recalls this one, when there is one (a document of the tenant, in force); an archived document must have one. */
  basisDocumentId: string | null;
  notifyRecipients: boolean;
  actor: string;
  now: Date;
}

export interface RecallResult {
  document: OutgoingDocumentRecord;
  from: OutgoingStatus;
  /** The recipients who got the notice, and the rows that were called off before anything was sent. */
  notified: DistributionRecord[];
  cancelled: DistributionRecord[];
  /** Whether a request of a source module was marked RECALLED with the document. */
  requestRecalled: boolean;
}

export interface VoidNumberInput {
  reason: string;
  voidedBy: string;
  approvedBy: string;
  now: Date;
}

export interface VoidNumberResult {
  document: OutgoingDocumentRecord;
  from: OutgoingStatus;
  entry: RegisterEntry;
  /** The signing sessions that were still open and must be told to stop. */
  sessions: CancelledSession[];
  requestCancelled: boolean;
}

/**
 * Recalling an issued document and voiding the number of a document that cannot be sealed (ST-DOC-012, DOC.md F6 and F9, BR-DOC-03, BR-DOC-21). Both run in
 * the transaction of the command, on a document the caller locked and whose version they checked. The number of a recalled document stays allocated and
 * the next number is the next one; the number of a document that cannot be sealed is voided with a reason and a second person, and the document ends
 * CANCELLED. The database holds the other half (V1224): a recalled or cancelled document, a recalled effect and a voided number never go back.
 */
export class OutgoingRecallStore {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly registers = new NumberRegisterStore();
  private readonly distributions = new DocumentDistributionStore();
  private readonly interop = new DocInteropStore();
  private readonly requests = new DocIssueRequestStore();

  /**
   * ISSUED, DELIVERED, ACKNOWLEDGED, FILED or ARCHIVED to RECALLED: the effect of the document anchor becomes RECALLED, the relation RECALLS from the
   * recalling document is kept when there is one, the request of the source module is RECALLED, and the distributions are called off or noticed. A document
   * that is not in force is 409 DOCUMENT_STATE_INVALID (a second recall included); a basis that is missing where it is needed or that is not a document in
   * force is 422 RECALL_BASIS_REQUIRED.
   */
  async recall(tx: TenantTx, document: OutgoingDocumentRecord, input: RecallInput): Promise<RecallResult> {
    if (!RECALLABLE_STATUSES.includes(document.status)) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    await this.assertBasis(tx, document, input.basisDocumentId);
    const from = document.status;
    await tx.query(
      `update machvon.outgoing_document
          set status = 'RECALLED', recall_reason = $3, recalled_at = $4::timestamptz, recalled_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where id = $1::uuid`,
      [document.id, input.actor, input.reason, input.now.toISOString()],
    );
    const effect = await tx.query(
      "update machvon.document set effect_status = 'RECALLED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and effect_status in ('EFFECTIVE', 'CORRECTED') returning id",
      [document.documentId, input.actor],
    );
    if (effect.length === 0) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'effect_status');
    if (input.basisDocumentId !== null) {
      await tx.query(
        `insert into machvon.document_relation (tenant_id, id, from_document_id, to_document_id, relation_kind, note, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'RECALLS', $3, $4::uuid, $4::uuid)`,
        [input.basisDocumentId, document.documentId, input.reason, input.actor],
      );
    }
    const requestRecalled = (await this.requests.markRecalled(tx, document.id, input.actor)) !== undefined;
    const { cancelled, notified } = await this.distributions.applyRecall(tx, document.id, { at: input.now, notify: input.notifyRecipients }, input.actor);
    // What was queued for the LGSP and has not left is called off with its row: nothing goes out for a document that is no longer in force.
    await this.interop.cancelOfDistributions(tx, cancelled.map((row) => row.id), input.now, input.actor);
    const recalled = await this.outgoing.find(tx, document.id);
    if (recalled === undefined) throw new Error('outgoing document vanished while it was locked');
    return { document: recalled, from, notified, cancelled, requestRecalled };
  }

  /**
   * NUMBERED or SEALED to CANCELLED, with the allocation VOIDED: a document whose seal cannot be completed gives up its number for good. The voider and the
   * approver are two people and the approver is not the one who allocated the number (403 SELF_APPROVAL_DENIED); the open signing sessions end and the
   * request of the source module is called off. A document in another state is 409 DOCUMENT_STATE_INVALID.
   */
  async voidNumber(tx: TenantTx, document: OutgoingDocumentRecord, input: VoidNumberInput): Promise<VoidNumberResult> {
    if (!VOIDABLE_STATUSES.includes(document.status) || document.allocationId === null) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const from = document.status;
    const entry = await this.registers.voidAllocation(tx, document.allocationId, { reason: input.reason, voidedBy: input.voidedBy, approvedBy: input.approvedBy });
    const sessions = await this.drafts.cancelOpenSessions(tx, document.id, input.voidedBy);
    await tx.query(
      "update machvon.outgoing_document set status = 'CANCELLED', cancel_reason = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid",
      [document.id, input.voidedBy, input.reason],
    );
    await tx.query("update machvon.document set effect_status = 'EXPIRED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [document.documentId, input.voidedBy]);
    let requestCancelled = false;
    if (document.issueRequestId !== null) {
      await this.drafts.cancelIssueRequest(tx, document.issueRequestId, input.voidedBy);
      requestCancelled = true;
    }
    const cancelled = await this.outgoing.find(tx, document.id);
    if (cancelled === undefined) throw new Error('outgoing document vanished while it was locked');
    return { document: cancelled, from, entry, sessions, requestCancelled };
  }

  /** A basis is a document of the tenant that is in force and is not the document recalled; a document that was archived must have one. */
  private async assertBasis(tx: TenantTx, document: OutgoingDocumentRecord, basisDocumentId: string | null): Promise<void> {
    if (basisDocumentId === null) {
      // A document that was archived or corrected is recalled on a new basis only (DOC.md 4).
      if (document.status === 'ARCHIVED' || document.status === 'CORRECTED') throw new DomainError('RECALL_BASIS_REQUIRED', 422, 'recall_basis_document_id', { extensions: { basis: document.status === 'ARCHIVED' ? 'REQUIRED_FOR_ARCHIVED' : 'REQUIRED_FOR_CORRECTED' } });
      return;
    }
    if (basisDocumentId === document.documentId) throw new DomainError('RECALL_BASIS_REQUIRED', 422, 'recall_basis_document_id', { extensions: { basis: 'SELF' } });
    const [basis] = await tx.query<{ effect_status: string }>('select effect_status from machvon.document where id = $1::uuid', [basisDocumentId]);
    if (basis === undefined || !isInForce(basis.effect_status)) throw new DomainError('RECALL_BASIS_REQUIRED', 422, 'recall_basis_document_id', { extensions: { basis: 'NOT_IN_FORCE' } });
  }
}
